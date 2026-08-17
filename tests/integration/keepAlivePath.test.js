import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer, api, seedTests } from "./helpers/boot.js";

let server;
let sendCurrent;

const PING_URL = "https://hc.example.net/ping/2f1c8a90";

const FAILED = {ping: -1, download: -1, upload: -1, error: "no route to host"};
const SUCCEEDED = {ping: 12, download: 100, upload: 50, error: null};

/**
 * Runs the minute job with fetch stubbed, and reports where it pinged.
 *
 * Stubbed only around the call and restored immediately: the harness talks to
 * its own server over fetch as well, so leaving it replaced would capture the
 * test's own requests instead of the integration's.
 */
const keepAlivePing = async () => {
    const realFetch = globalThis.fetch;
    const sent = [];

    globalThis.fetch = async (url) => {
        sent.push(String(url));
        return new Response("{}", {status: 200, headers: {"content-type": "application/json"}});
    };

    try {
        await sendCurrent();
    } finally {
        globalThis.fetch = realFetch;
    }

    return sent;
};

before(async () => {
    server = await bootServer();
    ({sendCurrent} = await import("../../server/tasks/integrations.js"));

    await api(server.baseUrl, "/integrations/healthChecks", {
        method: "PUT",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({url: PING_URL})
    });
});

after(async () => {
    await server?.close();
});

beforeEach(async () => {
    await seedTests(server.tests, [{created: new Date().toISOString(), ...SUCCEEDED}]);
});

/**
 * Where the keep-alive goes while a failure stands.
 *
 * healthChecks pings the root URL every minute, and the root URL is
 * healthchecks.io's *success* endpoint - so within sixty seconds of a test
 * failing, the keep-alive reported the check up again and took back the /fail
 * ping. Withholding the keep-alive instead would have fixed the overwrite and
 * cost the other thing the ping is for: it is the only signal that MySpeed
 * itself is still running, so an instance that had failed a test and then died
 * would have looked exactly like one whose line was down.
 *
 * So it is routed rather than withheld. While the last test is a failure the
 * minute ping goes to /fail: the check stays down, and its last-ping time keeps
 * moving, which is what tells the two apart.
 *
 * The outcome is read from the stored tests on every ping rather than
 * remembered in the process. A restart between a failed test and the next one
 * would otherwise forget it and mark the check up - the same overwrite, just
 * waiting for a `docker restart`, which is exactly when an operator is looking.
 */
describe("the healthChecks keep-alive", () => {
    it("pings the root url while the last test succeeded", async () => {
        assert.deepEqual(await keepAlivePing(), [PING_URL]);
    });

    it("pings /fail while the last test is a failure", async () => {
        await seedTests(server.tests, [{created: new Date().toISOString(), ...FAILED}]);

        assert.deepEqual(await keepAlivePing(), [`${PING_URL}/fail`],
            "the keep-alive reported the check up again a minute after it failed");
    });

    it("goes back to the root url once a test succeeds again", async () => {
        await seedTests(server.tests, [{created: new Date().toISOString(), ...FAILED}]);
        await keepAlivePing();

        await seedTests(server.tests, [{created: new Date().toISOString(), ...SUCCEEDED}]);

        assert.deepEqual(await keepAlivePing(), [PING_URL],
            "a recovered line never clears the check");
    });

    /**
     * The restart case, which is the whole reason this is read rather than
     * remembered. Nothing here restarts the process - the point is that no
     * process state is consulted at all, so a fresh one answers the same.
     */
    it("still knows the last test failed with no in-process state to help", async () => {
        await seedTests(server.tests, [{created: new Date().toISOString(), ...FAILED}]);

        // Two in a row: the second would be the one a remembered flag got wrong
        // after it had been cleared or never set.
        assert.deepEqual(await keepAlivePing(), [`${PING_URL}/fail`]);
        assert.deepEqual(await keepAlivePing(), [`${PING_URL}/fail`]);
    });

    // An install that has never run a test has no failure to report, and the
    // keep-alive is the only thing it can honestly say.
    it("pings the root url on an instance that has never tested", async () => {
        await seedTests(server.tests, []);

        assert.deepEqual(await keepAlivePing(), [PING_URL]);
    });
});
