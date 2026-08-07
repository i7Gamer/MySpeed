import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer, api, seedTests, setConfig } from "./helpers/boot.js";

let server;

before(async () => {
    server = await bootServer();
});

after(async () => {
    await server?.close();
});

beforeEach(async () => {
    await seedTests(server.tests, []);
});

/**
 * The speedtest CLI is never downloaded into the throwaway data directory, so
 * spawning it fails with ENOENT. That is exactly the path this exercises: the
 * failure has to end up as a stored row explaining itself, because a run that
 * dies without recording anything looks identical to one that never started.
 */
const waitForTest = async (timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const {body} = await api(server.baseUrl, "/speedtests?limit=1");
        if (Array.isArray(body) && body.length > 0) return body[0];
        await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return null;
};

describe("a speedtest that cannot start", () => {
    beforeEach(async () => {
        await setConfig(server.config, "provider", "ookla");
    });

    after(async () => {
        await setConfig(server.config, "provider", "cloudflare");
    });

    /**
     * Regression: util/speedtest.js rejected the CLI's 'error' event as
     * {message: errorInstance}. The wrapper had a `message` key, so the
     * `?? String(e)` fallback never ran and the Error object itself was passed
     * to tests.create(). Sequelize validates a TEXT column with _.isObject(),
     * which an Error trips, so the write threw inside the catch block and the
     * failed test was silently lost.
     */
    it("records the failure as a stored test", async () => {
        assert.equal((await api(server.baseUrl, "/speedtests/run", {method: "POST"})).status, 200);

        const test = await waitForTest();
        assert.notEqual(test, null, "the failed speedtest was never written to the database");
    });

    it("stores the reason as a readable string", async () => {
        await api(server.baseUrl, "/speedtests/run", {method: "POST"});
        const test = await waitForTest();

        assert.equal(typeof test.error, "string");
        assert.notEqual(test.error, "");
        assert.notEqual(test.error, "[object Object]");
        assert.doesNotMatch(test.error, /^undefined$/);
    });

    it("marks the row as failed rather than as a real measurement", async () => {
        await api(server.baseUrl, "/speedtests/run", {method: "POST"});
        const test = await waitForTest();

        // A NULL error would present the -1 placeholders as a genuine result
        // and poison every average built on top of them.
        assert.ok(test.error);
        assert.equal(test.download, -1);
    });

    it("releases the run lock so the next test can start", async () => {
        await api(server.baseUrl, "/speedtests/run", {method: "POST"});
        await waitForTest();

        const {body} = await api(server.baseUrl, "/speedtests/status");
        assert.equal(body.running, false);
    });

    // The lock is cleared in a finally rather than on the paths that were
    // thought of, so a second failure is still able to start and be recorded.
    it("still accepts a run after an earlier one failed", async () => {
        await api(server.baseUrl, "/speedtests/run", {method: "POST"});
        await waitForTest();
        await seedTests(server.tests, []);

        const {status} = await api(server.baseUrl, "/speedtests/run", {method: "POST"});
        assert.equal(status, 200);

        assert.notEqual(await waitForTest(), null, "the second failure was never recorded");
    });
});
