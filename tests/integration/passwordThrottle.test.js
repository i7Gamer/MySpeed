import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer, api, setConfig } from "./helpers/boot.js";

let server;
let resetFailedAttempts;
let passwordMiddleware;

const MAX_FAILED_ATTEMPTS = 20;

before(async () => {
    server = await bootServer();

    const module = await import("../../server/middlewares/password.js");

    ({resetFailedAttempts} = module);
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
                json() { resolve(this.statusCode); return this; }
            };

            passwordMiddleware(req, res, () => resolve(200));
        });

        const guessInParallel = (times) =>
            Promise.all(Array.from({length: times}, () => attempt("not-the-password")));

        it("counts guesses that overlap, not just guesses that queue", async () => {
            const statuses = await guessInParallel(MAX_FAILED_ATTEMPTS * 3);
            const refused = statuses.filter((status) => status === 429).length;

            assert.ok(refused > 0,
                `all ${statuses.length} simultaneous guesses were compared; the limit only bounds sequential ones`);
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
