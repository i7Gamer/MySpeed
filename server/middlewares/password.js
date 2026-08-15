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

/**
 * Charges a caller for guesses they are about to make.
 *
 * `attempts` because a request can carry more than one: `x-password` and
 * `password` are independent headers and asUtf8 gives a second reading of the
 * latter, so readPasswords can return three candidates - all attacker-chosen,
 * all compared. Charging one for the list gave a caller who splits guesses
 * across both headers two or three tries per counted attempt. A cooperating
 * client is unaffected: writePasswordHeaders puts the same password in both, and
 * readPasswords deduplicates, so the ordinary request still costs one.
 */
const recordFailure = (key, attempts = 1) => {
    const now = Date.now();
    const entry = failedAttempts.get(key);

    if (entry === undefined || now >= entry.resetAt) {
        // Evict the single oldest entry rather than dropping the whole map.
        // Clearing it wholesale meant an attacker rotating source addresses -
        // trivial with an IPv6 /64 - reset every counter including their own.
        if (failedAttempts.size >= MAX_TRACKED_CLIENTS)
            failedAttempts.delete(failedAttempts.keys().next().value);

        failedAttempts.set(key, {count: attempts, resetAt: now + ATTEMPT_WINDOW_MS});
        return;
    }

    entry.count += attempts;
};

/** Clears the throttle. Exists so tests do not have to wait out the window. */
export const resetFailedAttempts = () => failedAttempts.clear();

/**
 * Charges the caller for guesses they are about to make, or refuses them.
 *
 * The check and the charge in one synchronous body - the atomicity is the
 * point, not a convenience. This used to be two functions, isThrottled and
 * recordFailedAttempt, and every entry point separated them with awaits:
 * bcrypt.compare deliberately yields the event loop, so a batch of requests
 * arriving together all read the count before any of them had raised it, all
 * passed the limit, and all ran their comparisons. MAX_FAILED_ATTEMPTS bounded
 * only the guesses that queued. With both halves in one function and no await
 * between them, each caller's check sees every earlier caller's charge,
 * however many are in flight.
 *
 * Charged before the verify rather than after it, and refunded through
 * clearFailedAttempts when the guess turns out to be right - the discipline
 * every caller shares. `attempts` is per readPasswords: a request can carry up
 * to three attacker-chosen candidates across the two headers, and charging one
 * for the list handed out free guesses.
 *
 * The separable halves are deliberately not exported any more. A route that
 * could import a bare check and a bare record is a route that can put an await
 * between them; this surface refuses the mistake instead of testing for it.
 *
 * /api/session and /api/prometheus/metrics authenticate outside this
 * middleware but spend this same counter, so an attacker cannot win a fresh
 * budget by switching between the three ways in.
 */
export const chargeAttempt = (req, attempts = 1) => {
    const key = clientKey(req);

    if (isLockedOut(key)) return false;

    recordFailure(key, attempts);
    return true;
};

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

    // Refused or charged in the one call, once per candidate: the list is
    // whatever the caller chose to put in the two headers. Refunded below on a
    // match, the same discipline as the password path.
    if (candidates.length > 0 && !chargeAttempt(req, candidates.length)) return tooManyAttempts(res);

    if (candidates.some(matchesSetupToken)) {
        clearFailedAttempts(req);
        req.viewMode = false;
        return next();
    }

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

    const candidates = readPasswords(req);

    // Refused or charged in the one atomic call - see chargeAttempt for why the
    // check and the write must not be separable. A throttled caller is not
    // refused here: read access may still be on offer below, and the 429 waits
    // for that to be settled.
    const throttled = candidates.length > 0 && !chargeAttempt(req, candidates.length);

    if (candidates.length > 0 && !throttled) {
        // Asynchronous on purpose: bcrypt.compareSync holds the only thread for
        // the entire cost of the hash, so a handful of wrong passwords stalled
        // every other request on the server, /api/health included.
        for (const candidate of candidates) {
            if (await bcrypt.compare(candidate, passwordHash)) {
                clearFailedAttempts(req);
                req.viewMode = false;
                return next();
            }
        }
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
