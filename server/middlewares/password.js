import * as config from '../controller/config.js';
import bcrypt from 'bcryptjs';
import { readPasswords } from '../util/passwordHeader.js';

/**
 * Every wrong password costs a full bcrypt comparison, so an unauthenticated
 * caller must not be able to ask for an unbounded number of them. Only failed
 * attempts are counted, and only when a password was actually supplied - a
 * request with no header does no work and is never throttled, which keeps
 * read-access browsing unaffected.
 */
const ATTEMPT_WINDOW_MS = 60000;
const MAX_FAILED_ATTEMPTS = 20;
const MAX_TRACKED_CLIENTS = 10000;

const failedAttempts = new Map();

const clientKey = (req) => req.ip ?? req.socket?.remoteAddress ?? "unknown";

const isLockedOut = (key) => {
    const entry = failedAttempts.get(key);
    return entry !== undefined && Date.now() < entry.resetAt && entry.count >= MAX_FAILED_ATTEMPTS;
};

const recordFailure = (key) => {
    const now = Date.now();
    const entry = failedAttempts.get(key);

    if (entry === undefined || now >= entry.resetAt) {
        // The map only grows on failures. Dropping it wholesale once it gets
        // large costs a single window of tracking and bounds the memory.
        if (failedAttempts.size >= MAX_TRACKED_CLIENTS) failedAttempts.clear();
        failedAttempts.set(key, {count: 1, resetAt: now + ATTEMPT_WINDOW_MS});
        return;
    }

    entry.count += 1;
};

/** Clears the throttle. Exists so tests do not have to wait out the window. */
export const resetFailedAttempts = () => failedAttempts.clear();

export default (allowViewAccess) => async (req, res, next) => {
    if (process.env.PREVIEW_MODE === "true") return next();

    const passwordHash = await config.getValue("password");
    const passwordLevel = await config.getValue("passwordLevel");

    if (passwordHash === config.NO_PASSWORD) {
        req.viewMode = false;
        return next();
    }

    // The candidates are encoding variants of the one password the caller sent,
    // not separate guesses, so they count as a single attempt.
    const candidates = readPasswords(req);
    const key = clientKey(req);
    const throttled = candidates.length > 0 && isLockedOut(key);

    if (candidates.length > 0 && !throttled) {
        // Asynchronous on purpose: bcrypt.compareSync holds the only thread for
        // the entire cost of the hash, so a handful of wrong passwords stalled
        // every other request on the server, /api/health included.
        for (const candidate of candidates) {
            if (await bcrypt.compare(candidate, passwordHash)) {
                failedAttempts.delete(key);
                req.viewMode = false;
                return next();
            }
        }

        recordFailure(key);
    }

    if (passwordLevel === "read" && allowViewAccess) {
        req.viewMode = true;
        return next();
    }

    if (throttled)
        return res.status(429).json({message: "Too many failed password attempts. Please try again later"});

    return res.status(401).json({message: "Please provide the correct password in the header"});
};
