import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer, api, seedTests, setConfig } from "./helpers/boot.js";

let server;

const MS_PER_HOUR = 3600000;
const hoursAgo = (hours) => new Date(Date.now() - hours * MS_PER_HOUR).toISOString();

before(async () => {
    server = await bootServer();
});

after(async () => {
    await server?.close();
});

beforeEach(async () => {
    await seedTests(server.tests, []);
});

const status = async () => (await api(server.baseUrl, "/speedtests/status")).body;

describe("GET /api/speedtests/status", () => {
    /**
     * The two original keys are a contract: the client has always read them, an
     * older node answers with only these two, and the image smoke test greps the
     * body for "running". Everything else here is additive.
     */
    it("still answers with the two states it always has", async () => {
        const body = await status();

        assert.equal(body.paused, false);
        assert.equal(body.running, false);
    });

    /**
     * Progress is absent rather than zero. Only the Ookla CLI reports any, so
     * "nothing has been reported" has to be distinguishable from "reported as
     * nought" - otherwise a librespeed or cloudflare run is drawn as a bar
     * pinned at 0% for its whole duration, which reads as a hung test.
     */
    it("reports no phase or progress while nothing is running", async () => {
        const body = await status();

        assert.equal(body.phase, null);
        assert.equal(body.progress, null);
        assert.equal(body.startedAt, null);
    });

    describe("the last test", () => {
        it("says when it was and whether it succeeded", async () => {
            await seedTests(server.tests, [{created: hoursAgo(1)}]);

            const {lastTest} = await status();

            assert.ok(lastTest, "no last test was reported");
            assert.equal(lastTest.failed, false);
            assert.equal(lastTest.created, hoursAgoStored(await server.tests.findAll()));
        });

        it("marks a failed last test as failed", async () => {
            await seedTests(server.tests, [{created: hoursAgo(1), ping: -1, download: -1, upload: -1,
                error: "Cannot open socket"}]);

            assert.equal((await status()).lastTest.failed, true);
        });

        it("is absent on an install that has never run one", async () => {
            assert.equal((await status()).lastTest, null);
        });

        it("is the most recent one, not the first", async () => {
            await seedTests(server.tests, [{created: hoursAgo(5)}, {created: hoursAgo(1), download: 999}]);

            assert.equal((await status()).lastTest.download, 999);
        });
    });

    describe("recent failures", () => {
        it("counts the failures of the last day", async () => {
            await seedTests(server.tests, [
                {created: hoursAgo(1), error: "Cannot open socket"},
                {created: hoursAgo(3), error: "Cannot open socket"},
                {created: hoursAgo(5)}
            ]);

            assert.equal((await status()).recentFailures, 2);
        });

        it("ignores failures older than the window", async () => {
            await seedTests(server.tests, [
                {created: hoursAgo(2), error: "Cannot open socket"},
                {created: hoursAgo(30), error: "Cannot open socket"}
            ]);

            assert.equal((await status()).recentFailures, 1);
        });

        it("is zero rather than absent when nothing failed", async () => {
            await seedTests(server.tests, [{created: hoursAgo(1)}]);

            assert.equal((await status()).recentFailures, 0);
        });
    });

    describe("the next scheduled test", () => {
        it("reports when the schedule will next fire", async () => {
            await setConfig(server.config, "cron", "0,30 * * * *");

            const {nextTest} = await status();

            assert.ok(nextTest, "no next test was reported");
            assert.ok(new Date(nextTest) > new Date(), "the next test is in the past");
        });
    });
});

// seedTests stores exactly what it is given, so the row is read back rather than
// the input reformatted - sqlite and mysql do not agree on the stored shape.
const hoursAgoStored = (rows) => rows[0].created;
