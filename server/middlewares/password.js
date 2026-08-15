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
 *
 * Only wrong guesses end in that lockout, so a caller whose comparisons succeed
 * is bounded by this cap alone - which is why the count it keeps has to track
 * reality exactly rather than approximately. Two earlier shapes did not; see
 * liveReservations.
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
 * So: the `settle` handed back with the admission releases the reservation
 * whatever the outcome, and only a comparison that came back wrong is recorded
 * as a failure. A caller who gets it right is charged nothing and leaves no
 * trace.
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
 * Every path that reserves also releases in a `finally`, so in principle this
 * never fires. It exists because the cost of being wrong is asymmetric: the
 * failure count expires on its own, but a held reservation has nothing else to
 * clear it, so one missed release would wedge that caller at the cap for the
 * life of the process - a permanent lockout, which is a worse fault than the
 * one this counter was split in two to fix. A stale reservation is discarded
 * instead, which at worst lets a burst through a window late.
 */
const IN_FLIGHT_MAX_AGE_MS = ATTEMPT_WINDOW_MS;

/**
 * The reservations a client currently holds, each owned by the request that
 * took it.
 *
 * Identity is the point. Two simpler shapes were tried and both drifted,
 * because a release that cannot say which reservation is its own has to guess:
 *
 * - Release the oldest, and a leaked reservation is quietly consumed by the
 *   next caller's release while its orphan takes the leak's place. The deficit
 *   never clears and the backstop never gets to expire anything.
 * - Release the newest, and under sustained load the oldest is never released
 *   at all: it ages past the window and is swept while its comparison is still
 *   running, so true concurrency climbs by a capful every window while the
 *   counter reads twenty.
 *
 * Neither is a rounding error - both compound - and no ordering rule fixes it,
 * because the information needed is which reservation belongs to the caller.
 * So `reserveAttempt` hands back the release for exactly the reservations it
 * took. A leak expires on its own deadline whatever the traffic, a busy
 * client's live reservations are never touched by someone else's release, and
 * a release arriving after its own reservation was swept finds nothing of its
 * own and does nothing.
 *
 * The list is bounded by the cap, so it holds at most twenty entries.
 */
const liveReservations = (key, now) => {
    const held = attemptsInFlight.get(key);
    if (held === undefined) return null;

    // Anything past its deadline is a reservation whose release never arrived;
    // every path releases in a `finally`, so this is a backstop.
    const live = held.filter((reservation) => now < reservation.staleAt);

    if (live.length === 0) {
        attemptsInFlight.delete(key);
        return null;
    }

    if (live.length !== held.length) attemptsInFlight.set(key, live);

    return live;
};

/**
 * Releases the reservations one request took, and records the failures they
 * turned out to be.
 *
 * `failed` is how many of them came back wrong: 0 for a caller who got it
 * right, which is what keeps a correct password off the failure budget, and 0
 * again when the comparison never ran, so an internal error cannot spend it.
 */
const releaseWith = (key, ticket) => ({failed = 0} = {}) => {
    const live = liveReservations(key, Date.now());

    if (live !== null) {
        const remaining = live.filter((reservation) => reservation.ticket !== ticket);

        if (remaining.length > 0) attemptsInFlight.set(key, remaining);
        else attemptsInFlight.delete(key);
    }

    if (failed > 0) recordFailure(key, failed);
};

/** Releases nothing, for the refusals and for a request that carried no guess. */
const releaseNothing = () => undefined;

export const reserveAttempt = (req, attempts = 1) => {
    const key = clientKey(req);
    const now = Date.now();

    if (isLockedOut(key)) return {outcome: ATTEMPT_LOCKED_OUT, settle: releaseNothing};

    const live = liveReservations(key, now) ?? [];
    if (live.length + attempts > MAX_ATTEMPTS_IN_FLIGHT)
        return {outcome: ATTEMPT_BUSY, settle: releaseNothing};

    /*
     * Bounded like failedAttempts, for the same reason and by the same rule.
     *
     * Expiry here is lazy: a deadline is only noticed when that same client
     * comes back, so a reservation whose release never arrived from a client
     * who never returns would sit in the map for good. No path can produce one
     * today - every one releases in a `finally` - which is exactly why the
     * bound belongs here rather than in a comment promising it cannot happen.
     * Evicting a live entry only under-counts, which is the safe direction, and
     * reaching this at all means ten thousand clients with comparisons running
     * at once.
     */
    if (!attemptsInFlight.has(key) && attemptsInFlight.size >= MAX_TRACKED_CLIENTS)
        attemptsInFlight.delete(attemptsInFlight.keys().next().value);

    // One token per request, shared by the reservations it took, so the release
    // finds exactly its own however the list has changed since.
    const ticket = Symbol("attempt");
    const staleAt = now + IN_FLIGHT_MAX_AGE_MS;

    attemptsInFlight.set(key,
        live.concat(Array.from({length: attempts}, () => ({ticket, staleAt}))));

    return {outcome: ATTEMPT_ADMITTED, settle: releaseWith(key, ticket)};
};

/** A request that carried no guess: nothing reserved, nothing to release. */
export const NOTHING_RESERVED = {outcome: ATTEMPT_ADMITTED, settle: releaseNothing};

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
        : NOTHING_RESERVED;

    if (admission.outcome === ATTEMPT_LOCKED_OUT) return tooManyAttempts(res);
    if (admission.outcome === ATTEMPT_BUSY) return busyComparing(res);

    let matched = false;
    let compared = false;

    try {
        matched = candidates.some(matchesSetupToken);
        compared = true;
    } finally {
        // In a finally like the other two paths, so a throw cannot leave the
        // reservation held - an unreleased one has no expiry short of the sweep
        // above, and the three paths sharing these counters should not each
        // release them differently.
        //
        // The release is unconditional; the charge is not. A throw here is the
        // server's fault, and charging the caller's failure budget for it would
        // let an internal error lock them out for the window.
        admission.settle({failed: compared && !matched ? candidates.length : 0});
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
        : NOTHING_RESERVED;

    if (admission.outcome === ATTEMPT_ADMITTED && candidates.length > 0) {
        // The reservation is released however this ends, including on a throw
        // from bcrypt - a malformed hash would otherwise leak it and wedge the
        // caller at the in-flight cap for the rest of the window.
        let matched = false;
        let compared = false;

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

            compared = true;
        } finally {
            // Only what was actually compared and found wrong is a failure. A
            // correct password leaves the failure budget untouched, so a burst
            // of legitimate logins can never lock a client out - and a throw
            // from bcrypt is the server's fault, so it releases the reservation
            // without spending the caller's budget either.
            admission.settle({failed: compared && !matched ? candidates.length : 0});
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

    if (admission.outcome === ATTEMPT_LOCKED_OUT) return tooManyAttempts(res);
    if (admission.outcome === ATTEMPT_BUSY) return busyComparing(res);

    return res.status(401).json({
        message: "Please provide the correct password in the header",
        type: PASSWORD_REQUIRED
    });
};
