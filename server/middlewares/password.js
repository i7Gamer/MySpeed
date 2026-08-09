import * as config from '../controller/config.js';
import bcrypt from 'bcryptjs';
import { readPasswords } from '../util/passwordHeader.js';
import { announceSetupToken, matchesSetupToken } from '../util/setupToken.js';
import { isLoopbackRequest } from '../util/clientAddress.js';
import { clientKey } from '../util/clientKey.js';
import { isValidSession, SESSION_COOKIE } from '../util/session.js';
import { readCookie } from '../util/cookies.js';
import { PASSWORD_REQUIRED, SETUP_TOKEN_REQUIRED, TOO_MANY_ATTEMPTS } from '../util/authOutcome.js';

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

const isLockedOut = (key) => {
    const entry = failedAttempts.get(key);
    return entry !== undefined && Date.now() < entry.resetAt && entry.count >= MAX_FAILED_ATTEMPTS;
};

const recordFailure = (key) => {
    const now = Date.now();
    const entry = failedAttempts.get(key);

    if (entry === undefined || now >= entry.resetAt) {
        // Evict the single oldest entry rather than dropping the whole map.
        // Clearing it wholesale meant an attacker rotating source addresses -
        // trivial with an IPv6 /64 - reset every counter including their own.
        if (failedAttempts.size >= MAX_TRACKED_CLIENTS)
            failedAttempts.delete(failedAttempts.keys().next().value);

        failedAttempts.set(key, {count: 1, resetAt: now + ATTEMPT_WINDOW_MS});
        return;
    }

    entry.count += 1;
};

/** Clears the throttle. Exists so tests do not have to wait out the window. */
export const resetFailedAttempts = () => failedAttempts.clear();

/**
 * The throttle, for routes that authenticate outside this middleware.
 *
 * /api/prometheus/metrics runs its own bcrypt comparison against the same hash;
 * without these it was an unlimited online password oracle and, at one bcrypt
 * per request, a way to saturate the event loop.
 */
export const isThrottled = (req) => isLockedOut(clientKey(req));
export const recordFailedAttempt = (req) => recordFailure(clientKey(req));
export const clearFailedAttempts = (req) => failedAttempts.delete(clientKey(req));

/**
 * Whether an instance with no password may serve this caller unchallenged.
 *
 * Local callers keep working so development, the console and the container
 * healthcheck are unaffected; everyone else needs the setup token.
 */
export const allowsPasswordlessAccess = (req) =>
    process.env.ALLOW_NO_PASSWORD === "true" || isLoopbackRequest(req);

const tooManyAttempts = (res) =>
    res.status(429).json({
        message: "Too many failed password attempts. Please try again later",
        type: TOO_MANY_ATTEMPTS
    });

/**
 * Handles a request against an instance that has no password configured.
 *
 * Waving these through unconditionally is what made a fresh install on a public
 * address an unauthenticated admin API. Callers that are demonstrably local, or
 * an operator who has set ALLOW_NO_PASSWORD, still get in unchallenged; everyone
 * else has to present the setup token printed to the server log at boot.
 */
const handleUnconfigured = (req, res, next) => {
    if (allowsPasswordlessAccess(req)) {
        req.viewMode = false;
        return next();
    }

    const candidates = readPasswords(req);
    const key = clientKey(req);

    if (candidates.length > 0 && isLockedOut(key)) return tooManyAttempts(res);

    if (candidates.some(matchesSetupToken)) {
        failedAttempts.delete(key);
        req.viewMode = false;
        return next();
    }

    if (candidates.length > 0) recordFailure(key);

    // Printed here, not only at boot: an instance whose password is removed
    // while it runs never saw the startup banner, so the token this message
    // points at had never been issued and only a restart would produce one.
    announceSetupToken();

    return res.status(401).json({
        message: "This instance has no password set. Use the setup token from the server log, then set a password",
        type: SETUP_TOKEN_REQUIRED
    });
};

export default (allowViewAccess) => async (req, res, next) => {
    if (process.env.PREVIEW_MODE === "true") return next();

    // A session costs no bcrypt comparison and cannot be read by script on the
    // page, which is the whole reason the client no longer keeps the password.
    // Checked before anything else so the common request does no work at all.
    if (isValidSession(readCookie(req, SESSION_COOKIE))) {
        req.viewMode = false;
        return next();
    }

    const passwordHash = await config.getValue("password");
    const passwordLevel = await config.getValue("passwordLevel");

    if (passwordHash === config.NO_PASSWORD) return handleUnconfigured(req, res, next);

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

    if (throttled) return tooManyAttempts(res);

    return res.status(401).json({
        message: "Please provide the correct password in the header",
        type: PASSWORD_REQUIRED
    });
};
