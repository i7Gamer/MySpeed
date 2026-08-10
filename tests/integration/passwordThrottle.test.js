import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer, api, setConfig } from "./helpers/boot.js";

let server;
let resetFailedAttempts;

const MAX_FAILED_ATTEMPTS = 20;

before(async () => {
    server = await bootServer();
    ({resetFailedAttempts} = await import("../../server/middlewares/password.js"));
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
});
