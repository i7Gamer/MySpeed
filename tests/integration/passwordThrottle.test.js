import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer, api, setConfig } from "./helpers/boot.js";

let server;
let resetFailedAttempts;
let reserveAttempt;
let ATTEMPT_ADMITTED;
let ATTEMPT_LOCKED_OUT;
let ATTEMPT_BUSY;
let MAX_TRACKED_CLIENTS;
let clearFailedAttempts;
let passwordMiddleware;

const MAX_FAILED_ATTEMPTS = 20;

before(async () => {
    server = await bootServer();

    const module = await import("../../server/middlewares/password.js");

    ({resetFailedAttempts, reserveAttempt, clearFailedAttempts,
        ATTEMPT_ADMITTED, ATTEMPT_LOCKED_OUT, ATTEMPT_BUSY, MAX_TRACKED_CLIENTS} = module);
    // The same middleware the routes mount, for the assertions that need calls
    // to genuinely overlap - see "attempts made at the same time".
    passwordMiddleware = module.default(false);
});

after(async () => {
    await server?.close();
});

beforeEach(async () => {
    resetFailedAttempts();
    await setConfig(server.config, "password", "Hunter2!");
    await setConfig(server.config, "passwordLevel", "none");
});

const guarded = (headers = {}) => api(server.baseUrl, "/speedtests?limit=1", {headers});
const wrongPassword = () => guarded({"x-password": "not-the-password"});

const failRepeatedly = async (times) => {
    const statuses = [];
    for (let i = 0; i < times; i++) statuses.push((await wrongPassword()).status);
    return statuses;
};

/**
 * The password check used to run bcrypt.compareSync - roughly 60ms of blocked
 * event loop per candidate, up to three candidates per request, with no limit
 * on how often an anonymous caller could ask for it. That is enough to stall
 * the whole server from a handful of connections.
 */
describe("password attempt throttling", () => {
    it("still accepts the correct password", async () => {
        assert.equal((await guarded({"x-password": "Hunter2!"})).status, 200);
    });

    it("rejects a wrong password with 401 while under the limit", async () => {
        const statuses = await failRepeatedly(3);
        assert.deepEqual(statuses, [401, 401, 401]);
    });

    it("starts refusing outright once the attempt limit is reached", async () => {
        await failRepeatedly(MAX_FAILED_ATTEMPTS);

        const {status, body} = await wrongPassword();
        assert.equal(status, 429);
        assert.match(body.message, /too many/i);
    });

    // The throttle must bound the work, not the truth: a caller who is locked
    // out and then supplies the right password is still refused for the window.
    it("refuses even a correct password while locked out", async () => {
        await failRepeatedly(MAX_FAILED_ATTEMPTS);
        assert.equal((await guarded({"x-password": "Hunter2!"})).status, 429);
    });

    it("clears the counter after a successful authentication", async () => {
        await failRepeatedly(MAX_FAILED_ATTEMPTS - 1);
        assert.equal((await guarded({"x-password": "Hunter2!"})).status, 200);

        // The counter reset, so the next wrong password is an ordinary 401.
        assert.equal((await wrongPassword()).status, 401);
    });

    /**
     * A request with no password header costs no bcrypt work, so it must never
     * be throttled - otherwise a locked-out client could not even reach the
     * read-only view, and /api/health would start failing under attack.
     */
    it("never throttles a request that carries no password", async () => {
        await failRepeatedly(MAX_FAILED_ATTEMPTS + 5);

        assert.equal((await guarded()).status, 401);
        assert.equal((await api(server.baseUrl, "/health")).status, 200);
    });

    it("still grants read access while locked out when the level allows it", async () => {
        await setConfig(server.config, "passwordLevel", "read");
        await failRepeatedly(MAX_FAILED_ATTEMPTS + 1);

        assert.equal((await guarded()).status, 200);
    });

    /**
     * This asserted a wall-clock bound as well, to show the async bcrypt no
     * longer blocks the event loop. It could not do that reliably: the throttle
     * caps the run at twenty comparisons, which even synchronously is about a
     * second - inside any bound loose enough to survive the parallel test
     * runner, and outside any bound tight enough to discriminate. It failed on
     * a loaded machine and passed alone, which is worse than not testing it.
     *
     * What is left is real: the probe answers while failed logins are in
     * flight, so it is neither throttled nor rate-limited alongside them.
     */
    it("keeps the health probe answering while password checks are in flight", async () => {
        const inFlight = Array.from({length: MAX_FAILED_ATTEMPTS}, () => wrongPassword());

        const {status, body} = await api(server.baseUrl, "/health");
        await Promise.all(inFlight);

        assert.equal(status, 200);
        assert.equal(body.status, "ok");
    });

    /**
     * And the limit counts attempts, not turns.
     *
     * The check was read at the top of the request and the failure recorded
     * after the awaited bcrypt.compare - and that compare deliberately yields
     * the event loop, in chunks, precisely so it does not block. So every
     * request in a batch read the counter before any of them had written to it,
     * every one of them was found to be under the limit, and twenty guesses a
     * minute became as many as the outer rate limiter would carry. The one test
     * that fired requests in parallel asserted only on /api/health beside them
     * and never looked at their statuses, so it passed either way.
     */
    describe("attempts made at the same time", () => {
        /**
         * Driven straight at the middleware rather than over HTTP.
         *
         * Through fetch the requests do not actually overlap: undici holds a
         * small per-origin connection pool, so the batch is largely serialised
         * and enough failures are recorded to hide the race whichever way the
         * middleware is written. A test that passes on the broken code is worse
         * than no test. Calling the middleware directly puts every call at its
         * first await simultaneously, which is exactly the state a real
         * attacker's parallel sockets produce.
         */
        const attempt = (password) => new Promise((resolve) => {
            const req = {headers: {"x-password": password}, socket: {remoteAddress: "203.0.113.9"}};
            const res = {
                status(code) { this.statusCode = code; return this; },
                // The busy refusal sets Retry-After, so the stand-in has to
                // offer the same chainable shape Express does.
                set() { return this; },
                json() { resolve(this.statusCode); return this; }
            };

            passwordMiddleware(req, res, () => resolve(200));
        });

        const guessInParallel = (times) =>
            Promise.all(Array.from({length: times}, () => attempt("not-the-password")));

        it("counts guesses that overlap, not just guesses that queue", async () => {
            const statuses = await guessInParallel(MAX_FAILED_ATTEMPTS * 3);
            const compared = statuses.filter((status) => status === 401).length;

            // 401 is the answer a guess that was actually compared gets. The
            // rest were shed before any bcrypt work - which is the whole point.
            assert.ok(compared <= MAX_FAILED_ATTEMPTS,
                `${compared} of ${statuses.length} simultaneous guesses were compared;`
                + " the limit only bounds sequential ones");
            assert.ok(compared > 0, "nothing was compared at all");
        });

        it("refuses everything past the limit once they have all landed", async () => {
            await guessInParallel(MAX_FAILED_ATTEMPTS * 3);

            assert.equal(await attempt("not-the-password"), 429);
        });

        // The refund on success is what keeps an operator who mistypes twice
        // and then gets it right from being charged for the mistypes.
        it("still clears the counter when one of them is right", async () => {
            await guessInParallel(MAX_FAILED_ATTEMPTS - 5);

            assert.equal(await attempt("Hunter2!"), 200);
            assert.equal(await attempt("not-the-password"), 401);
        });
    });

    /**
     * A correct password costs nothing, however many arrive at once.
     *
     * The regression this exists for: the counter was charged *before* the
     * comparison and refunded only once a match came back, so a batch of
     * requests all carrying the RIGHT password each raised it before any of
     * them resolved. Twenty simultaneous correct logins locked the client out
     * of its own instance with "Too many failed password attempts" - and this
     * is not a contrived burst. A parent instance proxying a child
     * re-authenticates by header on every single request (it holds no session
     * with the child, and never can - the proxy strips cookies both ways), so
     * every dashboard poll is another concurrent correct password on one key.
     * On that path the 429 mapped to INVALID_URL, so a perfectly healthy node
     * reported as a bad address.
     */
    describe("correct passwords arriving together", () => {
        const rightPassword = () => guarded({"x-password": "Hunter2!"});

        /*
         * One burst, shared by every assertion below.
         *
         * Each of these requests is real HTTP, and the whole file runs against
         * one server behind the /api rate limiter's 300-a-minute budget - which
         * also answers 429. Firing a fresh burst per assertion spent that
         * budget and produced 429s that had nothing to do with the password
         * throttle, which is exactly the confusion these tests exist to
         * prevent. So the burst runs once and the assertions read it.
         */
        let statuses;
        let afterwards;

        before(async () => {
            resetFailedAttempts();
            statuses = await Promise.all(
                Array.from({length: MAX_FAILED_ATTEMPTS * 2}, () => rightPassword().then((r) => r.status)));

            // The batch has drained by now, so this is the state it left behind.
            afterwards = (await rightPassword()).status;
        });

        it("never locks a client out of its own instance", () => {
            assert.equal(statuses.filter((status) => status === 429).length, 0,
                "correct passwords were answered with 'too many failed password attempts'");
        });

        it("serves the ones it had room for", () => {
            assert.ok(statuses.filter((status) => status === 200).length >= MAX_FAILED_ATTEMPTS,
                `only ${statuses.filter((s) => s === 200).length} of the burst were served`);
        });

        /**
         * Past the in-flight cap the server is busy rather than suspicious, and
         * it says so: 503 with Retry-After, which is transient and clears as
         * soon as a slot frees. That is the honest answer, and crucially it is
         * not the one that spends the caller's budget.
         */
        /**
         * Asserted as "nothing outside this set" rather than "both of these
         * appeared". Whether a real HTTP batch overlaps enough to reach the cap
         * depends on undici's connection pool - the reason the concurrency
         * proper is driven in-process elsewhere - so requiring a 503 here would
         * be a test that fails on a fast machine for no reason. What must hold
         * either way is that nothing in the burst was refused as a bad
         * password.
         */
        it("says it is busy rather than blaming the credentials", () => {
            const unexpected = [...new Set(statuses)].filter((status) => status !== 200 && status !== 503);

            assert.deepEqual(unexpected, [], `the burst was answered with ${unexpected.join(", ")}`);
        });

        // The refusal is momentary: once the batch drains, the next correct
        // password is served as normal.
        it("recovers the moment the comparisons finish", () => {
            assert.equal(afterwards, 200);
        });

        it("leaves the failure budget untouched", async () => {
            // The whole budget is still there: a further MAX-1 wrong guesses
            // are needed before the next one is refused.
            await failRepeatedly(MAX_FAILED_ATTEMPTS - 1);

            assert.equal((await wrongPassword()).status, 401,
                "correct logins had spent part of the failed-attempt budget");
        });
    });

    /**
     * Two counters, because one was being asked to bound two different things.
     *
     * `reserveAttempt` bounds the comparisons a client may have running at once
     * - the check and the write in one synchronous body, so simultaneous
     * callers each see every earlier reservation. The `settle` it hands back
     * releases exactly the reservations it took and records only what actually
     * came back wrong. Conflating the two counters is what made a correct
     * password spend the failure budget.
     *
     * This is the one place the race is pinned. The three entry points - the
     * middleware, the session exchange, the Prometheus scrape - all spend these
     * counters through this pair; their own tests only have to show the wiring.
     */
    describe("reserveAttempt", () => {
        const CALLER = {headers: {}, socket: {remoteAddress: "203.0.113.77"}};

        it("admits exactly the budget, however simultaneous the calls are", async () => {
            const outcomes = await Promise.all(
                Array.from({length: MAX_FAILED_ATTEMPTS * 3}, async () => {
                    const admission = reserveAttempt(CALLER);
                    if (admission.outcome !== ATTEMPT_ADMITTED) return "refused";

                    try {
                        // A stand-in for the bcrypt compare: the yield to the
                        // event loop is the window the old shape raced in.
                        await new Promise((resolve) => setTimeout(resolve, 5));
                        return "compared";
                    } finally {
                        admission.settle({failed: 1});
                    }
                }));

            assert.equal(outcomes.filter((outcome) => outcome === "compared").length, MAX_FAILED_ATTEMPTS,
                "more comparisons ran than the budget allows");
            assert.equal(outcomes.filter((outcome) => outcome === "refused").length, MAX_FAILED_ATTEMPTS * 2);
        });

        it("counts what it is told the request carried", async () => {
            const HALF = MAX_FAILED_ATTEMPTS / 2;

            for (let i = 0; i < HALF; i++) {
                const admission = reserveAttempt(CALLER, 2);
                assert.equal(admission.outcome, ATTEMPT_ADMITTED);
                admission.settle({failed: 2});
            }

            assert.equal(reserveAttempt(CALLER).outcome, ATTEMPT_LOCKED_OUT,
                "two guesses a request were counted as one");
        });

        // Released whatever the outcome, or a client that made a burst of
        // correct guesses would sit at the in-flight cap for the whole window.
        it("frees the reservation on a guess that was right", async () => {
            for (let i = 0; i < MAX_FAILED_ATTEMPTS * 3; i++) {
                const admission = reserveAttempt(CALLER);
                assert.equal(admission.outcome, ATTEMPT_ADMITTED, `reservation ${i} was refused`);
                admission.settle({failed: 0});
            }
        });

        /**
         * The two refusals are different answers. Out of budget is about the
         * caller and lasts the window; at the cap is about the server and
         * clears as soon as a comparison finishes - reporting the second as the
         * first is what told a legitimate client its password was wrong.
         */
        it("tells a busy server apart from a locked-out caller", async () => {
            const held = [];
            for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
                const admission = reserveAttempt(CALLER);
                assert.equal(admission.outcome, ATTEMPT_ADMITTED);
                held.push(admission);
            }

            // Reservations still held, no failures recorded yet.
            assert.equal(reserveAttempt(CALLER).outcome, ATTEMPT_BUSY);

            for (const admission of held) admission.settle({failed: 1});

            assert.equal(reserveAttempt(CALLER).outcome, ATTEMPT_LOCKED_OUT);
        });

        /**
         * A full table must not spend an unrelated client's lockout.
         *
         * The failure map evicts its oldest entry when it is full and a new
         * client arrives - deliberately, so an attacker rotating addresses
         * cannot reset every counter at once. But "new" was read as "the entry
         * is missing or expired", and a key the map already holds does not grow
         * it: refreshing one while the table is full evicted the entry at the
         * head for nothing.
         *
         * The head is not necessarily expired junk. An entry refreshed after
         * its window lapses keeps its original position - Map.set does not
         * move a key - while its reset time jumps forward, so the entry at the
         * head can be a lockout that is still running while a later-positioned
         * entry has already expired. That is precisely the state this builds:
         * the victim locks out at the head of a full table, an unrelated
         * client's expired entry is refreshed - and the victim's lockout must
         * survive it, because spending it hands an attacker at the failure
         * budget a fresh window for the price of one wrong guess from anywhere.
         */
        it("keeps an active lockout when a full table refreshes an expired entry", () => {
            const caller = (address) => ({headers: {}, socket: {remoteAddress: address}});

            const fail = (who, count = 1) => {
                const admission = reserveAttempt(who, count);
                assert.equal(admission.outcome, ATTEMPT_ADMITTED);
                admission.settle({failed: count});
            };

            const VICTIM = caller("203.0.113.201");
            const REFRESHED = caller("203.0.113.202");

            const realNow = Date.now;
            const start = realNow();
            const at = (seconds) => { Date.now = () => start + seconds * 1000; };

            try {
                // The victim's key enters the map first, taking the head
                // position it will keep through every refresh.
                at(0);
                fail(VICTIM);

                // A second client fails once; its window ends at 65s.
                at(5);
                fail(REFRESHED);

                // Past both windows, the victim spends its whole budget: the
                // entry is refreshed in place - still at the head - and the
                // lockout now runs to 130s, well past the other entry's 65s.
                at(70);
                fail(VICTIM, MAX_FAILED_ATTEMPTS);
                assert.equal(reserveAttempt(VICTIM).outcome, ATTEMPT_LOCKED_OUT,
                    "the victim's lockout never took hold");

                // Fill the table to its cap with fresh clients. IPv4, because
                // clientKey buckets IPv6 by prefix - synthetic v6 neighbours
                // would all land on one key and lock it, not fill the table.
                for (let filler = 2; filler < MAX_TRACKED_CLIENTS; filler++)
                    fail(caller(`10.${(filler >> 16) & 255}.${(filler >> 8) & 255}.${filler & 255}`));

                // 100s: the other entry's window has lapsed, the victim's has
                // not. One wrong guess from that client refreshes its own entry
                // - which must not cost the victim's running lockout.
                at(100);
                fail(REFRESHED);

                assert.equal(reserveAttempt(VICTIM).outcome, ATTEMPT_LOCKED_OUT,
                    "refreshing an unrelated expired entry spent an active lockout");
            } finally {
                Date.now = realNow;
            }
        });

        /**
         * A reservation that is never released cannot wedge a caller forever.
         *
         * Every path settles in a `finally`, so this is a backstop rather than
         * a live case - but the two counters decay differently and only one of
         * them decays at all. The failure count expires with its window; an
         * in-flight count has nothing to clear it, so a single missed release
         * would hold that client at the cap for the life of the process. That
         * is a permanent lockout, which is a worse fault than the one the
         * counter was split in two to fix.
         */
        it("discards a reservation that was never released", async () => {
            const LEAKY = {headers: {}, socket: {remoteAddress: "203.0.113.90"}};

            // Fill the cap and settle none of it.
            for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++)
                assert.equal(reserveAttempt(LEAKY).outcome, ATTEMPT_ADMITTED);

            assert.equal(reserveAttempt(LEAKY).outcome, ATTEMPT_BUSY, "the cap did not hold");

            // Past the window the stale reservations are swept rather than
            // held against the caller for good.
            const realNow = Date.now;
            try {
                Date.now = () => realNow() + 61_000;
                assert.equal(reserveAttempt(LEAKY).outcome, ATTEMPT_ADMITTED,
                    "a leaked reservation wedged the caller permanently");
            } finally {
                Date.now = realNow;
            }
        });

        /**
         * And traffic does not keep the leak alive.
         *
         * The entry's deadline dates from when it was created. Refreshing it on
         * every reservation and release - which is what the first version of
         * this did - meant any steady stream of requests pushed the deadline
         * out again, so the sweep never fired and the leak was carried for the
         * life of the process. That is exactly the permanent wedge it exists to
         * prevent, so the backstop has to survive a busy client.
         */
        it("sweeps a leaked reservation even under continuous traffic", async () => {
            const BUSY_CALLER = {headers: {}, socket: {remoteAddress: "203.0.113.91"}};
            const realNow = Date.now;

            try {
                let offset = 0;
                Date.now = () => realNow() + offset;

                // One reservation that is never released...
                assert.equal(reserveAttempt(BUSY_CALLER).outcome, ATTEMPT_ADMITTED);

                // ...then a request a second, well past the window.
                for (let i = 0; i < 120; i++) {
                    offset += 1000;
                    const admission = reserveAttempt(BUSY_CALLER);
                    if (admission.outcome === ATTEMPT_ADMITTED) admission.settle({failed: 0});
                }

                // The leak is gone rather than carried forward, so the whole cap
                // is available again.
                for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++)
                    assert.equal(reserveAttempt(BUSY_CALLER).outcome, ATTEMPT_ADMITTED,
                        `slot ${i} was still held by a leak the traffic kept alive`);
            } finally {
                Date.now = realNow;
            }
        });

        it("is refunded by the same module", async () => {
            for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i++)
                reserveAttempt(CALLER).settle({failed: 1});
            clearFailedAttempts(CALLER);

            assert.equal(reserveAttempt(CALLER).outcome, ATTEMPT_ADMITTED,
                "the refund did not reach the counter");
        });

        /**
         * Releasing twice is releasing once.
         *
         * Removing the reservations is idempotent by construction - they are
         * gone the second time - but recording the failures was not, so a
         * second call charged the budget twice and halved it. No path does that
         * today; the guard is what keeps that true of a path added later.
         */
        it("cannot be released twice", async () => {
            const TWICE = {headers: {}, socket: {remoteAddress: "203.0.113.92"}};
            const HALF = MAX_FAILED_ATTEMPTS / 2;

            for (let i = 0; i < HALF; i++) {
                const admission = reserveAttempt(TWICE);
                admission.settle({failed: 1});
                admission.settle({failed: 1});
            }

            // Ten requests, charged ten - not twenty, which would have spent
            // the whole budget.
            assert.equal(reserveAttempt(TWICE).outcome, ATTEMPT_ADMITTED,
                "a doubled release spent the budget twice over");
        });

        /**
         * And the map of who is holding what is bounded, like its sibling.
         *
         * Expiry is lazy - a deadline is only noticed when that client comes
         * back - so a reservation whose release never arrived, from a client
         * who never returns, would otherwise sit there for good. Nothing can
         * produce one today, which is the reason to bound it rather than to
         * argue it cannot happen.
         */
        it("does not grow a key per client for ever", async () => {
            const MAX_TRACKED_CLIENTS = 10000;

            // Well past the bound, each from a different address, each holding
            // a reservation that is never released.
            for (let i = 0; i < MAX_TRACKED_CLIENTS + 500; i++)
                reserveAttempt({headers: {}, socket: {remoteAddress: `10.${i >> 16 & 255}.${i >> 8 & 255}.${i & 255}`}});

            // Still serving: the eviction frees a slot rather than refusing.
            assert.equal(reserveAttempt(CALLER).outcome, ATTEMPT_ADMITTED);
        });

        /**
         * The separable halves are gone, not merely unused. As long as a route
         * could import a bare check and a bare record, the next entry point
         * could reintroduce the race; now the module surface refuses it.
         */
        it("cannot be taken apart again", async () => {
            const module = await import("../../server/middlewares/password.js");

            assert.equal(module.isThrottled, undefined, "the bare check is importable again");
            assert.equal(module.recordFailedAttempt, undefined, "the bare charge is importable again");
        });
    });

    /**
     * One request, one guess.
     *
     * `x-password` and `password` are independent headers, and asUtf8 gives a
     * second reading of the latter, so readPasswords returns up to three
     * candidates - all of them attacker-chosen and all of them compared. The
     * comment above the loop said they were "encoding variants of the one
     * password the caller sent, not separate guesses", which is true only of a
     * caller that cooperates: one that does not got three tries per counted
     * attempt, and the real client sends one distinct candidate anyway because
     * writePasswordHeaders puts the same password in both.
     */
    describe("a request carrying more than one guess", () => {
        const twoGuesses = () => guarded({"x-password": "guess-one", "password": "guess-two"});

        it("charges for each of them", async () => {
            // Ten requests, two distinct guesses each, spends the whole budget.
            for (let i = 0; i < MAX_FAILED_ATTEMPTS / 2; i++) await twoGuesses();

            assert.equal((await wrongPassword()).status, 429,
                "a caller who splits guesses across both headers gets twice as many of them");
        });

        // The same ten requests carrying one password in both headers - which is
        // what writePasswordHeaders produces - must leave the budget half spent.
        it("still costs one attempt when both headers carry the same password", async () => {
            for (let i = 0; i < MAX_FAILED_ATTEMPTS / 2; i++)
                await guarded({"x-password": "not-the-password", "password": "not-the-password"});

            assert.equal((await wrongPassword()).status, 401,
                "a client sending its password the way the app does was charged twice for it");
        });
    });
});
