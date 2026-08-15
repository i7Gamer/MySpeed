import * as config from '../controller/config.js';
import bcrypt from 'bcryptjs';
import { readPasswords } from '../util/passwordHeader.js';
import { announceSetupToken, matchesSetupToken } from '../util/setupToken.js';
import { isLoopbackRequest } from '../util/clientAddress.js';
import { clientKey } from '../util/clientKey.js';
import { isValidSession, SESSION_COOKIE } from '../util/session.js';
import { readCookie } from '../util/cookies.js';
import { PASSWORD_REQUIRED, SERVER_BUSY, SETUP_TOKEN_REQUIRED, TOO_MANY_ATTEMPTS } from '../util/authOutcome.js';

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

/**
 * How many comparisons one client may have in flight at once.
 *
 * This is what bounds a burst. Confirmed failures are recorded only *after* a
 * comparison comes back wrong, so a batch arriving together is still under the
 * failure limit when it is admitted - the failure count cannot stop it, because
 * none of it has failed yet. This cap is what does.
 *
 * Being precise about the bound, because the obvious reading is too generous:
 * it caps *concurrency*, not the total for the window. A caller who refills
 * each slot as it frees gets roughly twice the failure budget's worth of
 * comparisons before the lockout bites - the last full set is already reserved
 * when the count reaches the limit. So the honest guarantee is "on the order of
 * the budget", not "at most the budget", and either way it is bounded work that
 * ends in a locked window rather than the unbounded run the old shape allowed.
 */
const MAX_ATTEMPTS_IN_FLIGHT = MAX_FAILED_ATTEMPTS;

// Confirmed wrong guesses per client in the current window. Only a comparison
// that came back wrong lands here, which is the whole point of splitting it from
// the reservation below: a correct password never touches this, so a burst of
// correct logins can never lock a client out of their own instance.
const failedAttempts = new Map();

// Comparisons currently running per client. A reservation, taken before the
// comparison and released after it whatever the outcome - so it bounds the work
// in flight without being the thing that decides a lockout.
const attemptsInFlight = new Map();

const isLockedOut = (key) => {
    const entry = failedAttempts.get(key);
    return entry !== undefined && Date.now() < entry.resetAt && entry.count >= MAX_FAILED_ATTEMPTS;
};

/**
 * Records guesses that have been compared and come back wrong.
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
export const resetFailedAttempts = () => {
    failedAttempts.clear();
    attemptsInFlight.clear();
};

/**
 * Reserves the right to run comparisons for a request, or refuses it.
 *
 * The check and the reservation in one synchronous body - the atomicity is the
 * point, not a convenience. This used to be two functions, isThrottled and
 * recordFailedAttempt, and every entry point separated them with awaits:
 * bcrypt.compare yields the event loop, so a batch of requests arriving
 * together all read the count before any of them had written to it, all passed
 * the limit, and all ran their comparisons. With both halves in one function
 * and no await between them, each caller's check sees every earlier caller's
 * reservation, however many are in flight.
 *
 * Two counters, because one was being asked to bound two different things and
 * could not do both. It has to bound the comparisons a client can have running
 * at once - otherwise a burst runs unbounded bcrypt work - and it has to bound
 * the wrong guesses a client may make in a window. Conflating them meant a
 * *correct* password spent the failure budget: twenty simultaneous correct
 * logins (a parent instance proxying a child re-authenticates by header on
 * every request, holding no session) locked the client out of its own instance
 * with "Too many failed password attempts", and on the node path that 429
 * surfaced as INVALID_URL - a healthy node reported as a bad address.
 *
 * So: `settleAttempt` releases the reservation whatever the outcome, and only a
 * comparison that came back wrong is recorded as a failure. A caller who gets
 * it right is charged nothing and leaves no trace.
 *
 * The two refusals are told apart because they mean different things to the
 * caller. Out of failure budget is about *them* and lasts the window; at the
 * in-flight cap is about the server being busy comparing right now, clears as
 * soon as a slot frees, and must not be reported as a failed password - a
 * legitimate client that briefly overlapped its own correct logins would
 * otherwise be told its credentials were wrong.
 *
 * `attempts` is per readPasswords: a request can carry up to three
 * attacker-chosen candidates across the two headers, and counting one for the
 * list handed out free guesses.
 *
 * The separable halves are deliberately not exported. A route that could import
 * a bare check and a bare record is a route that can put an await between them;
 * this surface refuses the mistake instead of testing for it.
 *
 * /api/session and /api/prometheus/metrics authenticate outside this middleware
 * but spend these same counters, so an attacker cannot win a fresh budget by
 * switching between the three ways in.
 */
export const ATTEMPT_ADMITTED = "admitted";
export const ATTEMPT_LOCKED_OUT = "locked_out";
export const ATTEMPT_BUSY = "busy";

/**
 * A reservation cannot outlive this.
 *
 * Every path that reserves also settles in a `finally`, so in principle this
 * never fires. It exists because the cost of being wrong is asymmetric: the
 * failure count expires on its own, but an in-flight count has nothing to
 * decay it, so one missed release would wedge that caller at the cap for the
 * life of the process - a permanent lockout, which is a worse fault than the
 * one this whole counter was split in two to fix. A stale reservation is
 * discarded instead, which at worst lets a burst through a window late.
 */
const IN_FLIGHT_MAX_AGE_MS = ATTEMPT_WINDOW_MS;

const runningFor = (key, now) => {
    const entry = attemptsInFlight.get(key);

    if (entry === undefined) return 0;
    if (now >= entry.staleAt) {
        attemptsInFlight.delete(key);
        return 0;
    }

    return entry.count;
};

export const reserveAttempt = (req, attempts = 1) => {
    const key = clientKey(req);
    const now = Date.now();

    if (isLockedOut(key)) return ATTEMPT_LOCKED_OUT;

    const running = runningFor(key, now);
    if (running + attempts > MAX_ATTEMPTS_IN_FLIGHT) return ATTEMPT_BUSY;

    attemptsInFlight.set(key, {count: running + attempts, staleAt: now + IN_FLIGHT_MAX_AGE_MS});
    return ATTEMPT_ADMITTED;
};

/**
 * Releases a reservation and records the failures it turned out to be.
 *
 * Called on every path out of a comparison - match, mismatch or throw - so a
 * reservation cannot leak and wedge a client at the in-flight cap. `failed` is
 * how many of the reserved comparisons came back wrong: 0 for a caller who got
 * it right, which is what keeps a correct password off the failure budget.
 */
export const settleAttempt = (req, {reserved = 1, failed = 0} = {}) => {
    const key = clientKey(req);
    const now = Date.now();
    const running = runningFor(key, now) - reserved;

    // Floored at zero rather than trusted: a reservation the sweep above has
    // already discarded would otherwise take the count negative and hand the
    // next caller free slots.
    if (running > 0) attemptsInFlight.set(key, {count: running, staleAt: now + IN_FLIGHT_MAX_AGE_MS});
    else attemptsInFlight.delete(key);

    if (failed > 0) recordFailure(key, failed);
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
 * The server is already comparing as many passwords for this caller as it will
 * run at once. Transient and nothing to do with the credentials, so it says so
 * and invites an immediate retry rather than spending the caller's budget.
 */
const RETRY_AFTER_SECONDS = 1;

const busyComparing = (res) =>
    res.status(503)
        .set("Retry-After", String(RETRY_AFTER_SECONDS))
        .json({message: "The server is busy checking passwords. Please try again", type: SERVER_BUSY});

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

    // Reserved once per candidate: the list is whatever the caller chose to put
    // in the two headers. matchesSetupToken is synchronous, so nothing can
    // interleave here - but the reservation is still taken and settled, because
    // this path shares the counters with the two that do await.
    const admission = candidates.length > 0
        ? reserveAttempt(req, candidates.length)
        : ATTEMPT_ADMITTED;

    if (admission === ATTEMPT_LOCKED_OUT) return tooManyAttempts(res);
    if (admission === ATTEMPT_BUSY) return busyComparing(res);

    let matched = false;

    try {
        matched = candidates.some(matchesSetupToken);
    } finally {
        // In a finally like the other two paths, so a throw from the comparison
        // cannot leave the reservation held. Nothing here awaits, so this is
        // symmetry rather than a race - but an unreleased reservation has no
        // expiry short of the sweep above, and the three paths sharing one
        // counter should not each release it differently.
        if (candidates.length > 0)
            settleAttempt(req, {reserved: candidates.length, failed: matched ? 0 : candidates.length});
    }

    if (matched) {
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

    // Refused or reserved in the one atomic call - see reserveAttempt for why
    // the check and the write must not be separable. Neither refusal answers
    // here: read access may still be on offer below, and both wait for that to
    // be settled.
    const admission = candidates.length > 0
        ? reserveAttempt(req, candidates.length)
        : ATTEMPT_ADMITTED;

    if (admission === ATTEMPT_ADMITTED && candidates.length > 0) {
        // The reservation is released however this ends, including on a throw
        // from bcrypt - a malformed hash would otherwise leak it and wedge the
        // caller at the in-flight cap for the rest of the window.
        let matched = false;

        try {
            // Asynchronous on purpose: bcrypt.compareSync holds the only thread
            // for the entire cost of the hash, so a handful of wrong passwords
            // stalled every other request on the server, /api/health included.
            for (const candidate of candidates) {
                if (await bcrypt.compare(candidate, passwordHash)) {
                    matched = true;
                    break;
                }
            }
        } finally {
            // Only what was actually compared and found wrong is a failure. A
            // correct password leaves the failure budget untouched, so a burst
            // of legitimate logins can never lock a client out.
            settleAttempt(req, {reserved: candidates.length, failed: matched ? 0 : candidates.length});
        }

        if (matched) {
            clearFailedAttempts(req);
            req.viewMode = false;
            return next();
        }
    }

    if (passwordLevel === "read" && allowViewAccess) {
        req.viewMode = true;
        return next();
    }

    if (admission === ATTEMPT_LOCKED_OUT) return tooManyAttempts(res);
    if (admission === ATTEMPT_BUSY) return busyComparing(res);

    return res.status(401).json({
        message: "Please provide the correct password in the header",
        type: PASSWORD_REQUIRED
    });
};
