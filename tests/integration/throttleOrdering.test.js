import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { bootServer, setConfig } from "./helpers/boot.js";

let server;
let resetFailedAttempts;
let sessionRoutes;
let prometheusRoutes;

const MAX_FAILED_ATTEMPTS = 20;
const PASSWORD = "Hunter2!";

before(async () => {
    server = await bootServer();

    ({resetFailedAttempts} = await import("../../server/middlewares/password.js"));
    sessionRoutes = (await import("../../server/routes/session.js")).default;
    prometheusRoutes = (await import("../../server/routes/prometheus.js")).default;

    await setConfig(server.config, "password", PASSWORD);
});

after(async () => {
    mock.restoreAll();
    await server?.close();
});

beforeEach(() => {
    resetFailedAttempts();
    mock.restoreAll();
});

/**
 * The bound is on the comparisons, so that is what this counts.
 *
 * The throttle exists to stop an anonymous caller asking for an unbounded
 * number of bcrypt comparisons - that is the whole security property, and
 * every previous attempt to pin it measured something else. A source-order
 * test asserted that the charge appeared above the compare in the file, which
 * is a proxy that says nothing about an await inserted between them and breaks
 * on a rename. The route tests drive sequential requests, which behave
 * identically whether the counter is spent before or after the work.
 *
 * Counting calls to bcrypt.compare is the property itself: it survives
 * reformatting, renaming, and moving the check into a helper, and it fails the
 * moment a batch of simultaneous guesses is allowed to run more comparisons
 * than the budget allows. All three entry points call the same imported
 * `bcrypt` default export, so one mock observes every one of them.
 *
 * In-process rather than over HTTP, for two reasons the earlier attempts hit:
 * undici's connection pool serialises a parallel fetch batch, which hides the
 * race being tested, and both routes sit behind app-level rate limiters that
 * answer 429 of their own and would be indistinguishable from the throttle's.
 */
const countingComparisons = () => {
    const real = bcrypt.compare.bind(bcrypt);
    const calls = {count: 0};

    mock.method(bcrypt, "compare", async (...args) => {
        calls.count++;
        return real(...args);
    });

    return calls;
};

/** Runs an express Router as the plain (req, res, next) function it is. */
const call = (routes, req) => new Promise((resolve) => {
    const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        set() { return this; },
        setHeader() { return this; },
        json() { resolve(this.statusCode); return this; },
        end() { resolve(this.statusCode); return this; }
    };

    // Reached only if the router matched nothing, which would mean the request
    // shapes below have drifted from the routes - so it resolves to a status no
    // assertion expects rather than to something that looks like an answer.
    routes(req, res, () => resolve(404));
});

const ATTACKER = {socket: {remoteAddress: "203.0.113.42"}};

const signIn = (password) => call(sessionRoutes, {
    ...ATTACKER, method: "POST", url: "/", originalUrl: "/api/session",
    headers: {"content-type": "application/json"}, body: {password}
});

const scrape = (password) => call(prometheusRoutes, {
    ...ATTACKER, method: "GET", url: "/metrics", originalUrl: "/api/prometheus/metrics",
    headers: {authorization: `Basic ${Buffer.from(`prometheus:${password}`).toString("base64")}`}
});

const simultaneously = (times, run) => Promise.all(Array.from({length: times}, () => run()));

describe("the work a burst of guesses can buy", () => {
    it("bounds the comparisons the session exchange will run", async () => {
        const compares = countingComparisons();

        await simultaneously(MAX_FAILED_ATTEMPTS * 3, () => signIn("not-the-password"));

        assert.ok(compares.count <= MAX_FAILED_ATTEMPTS,
            `${compares.count} comparisons ran for ${MAX_FAILED_ATTEMPTS * 3} simultaneous guesses`);
        assert.ok(compares.count > 0, "nothing was compared at all");
    });

    it("bounds the comparisons a scrape will run", async () => {
        const compares = countingComparisons();

        await simultaneously(MAX_FAILED_ATTEMPTS * 3, () => scrape("not-the-password"));

        assert.ok(compares.count <= MAX_FAILED_ATTEMPTS,
            `${compares.count} comparisons ran for ${MAX_FAILED_ATTEMPTS * 3} simultaneous scrapes`);
        assert.ok(compares.count > 0, "nothing was compared at all");
    });

    // One counter across the three ways in, so a burst cannot be doubled by
    // splitting it between two of them.
    it("bounds them across both entry points together", async () => {
        const compares = countingComparisons();

        await Promise.all([
            simultaneously(MAX_FAILED_ATTEMPTS * 2, () => signIn("not-the-password")),
            simultaneously(MAX_FAILED_ATTEMPTS * 2, () => scrape("not-the-password"))
        ]);

        assert.ok(compares.count <= MAX_FAILED_ATTEMPTS,
            `${compares.count} comparisons ran across the two routes`);
        // Its two siblings carry this and this one did not: without it, a mock
        // that stopped intercepting - or route shapes that drifted so nothing
        // is handled - reads as a perfect score.
        assert.ok(compares.count > 0, "nothing was compared at all");
    });

    /**
     * And a caller who is right is not bounded by the failure budget. This is
     * the other half of the same design: the reservation caps concurrent work,
     * the failure count caps wrong guesses, and only the second outlives the
     * request.
     */
    it("leaves a correct password free to keep signing in", async () => {
        for (let i = 0; i < MAX_FAILED_ATTEMPTS * 2; i++)
            assert.equal(await signIn(PASSWORD), 200, `sign-in ${i} was refused`);
    });
});
