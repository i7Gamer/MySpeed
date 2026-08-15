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

        /**
         * The count and the flag beside it in the same response body are one
         * question asked twice, so they have to be asked the same way.
         *
         * The count used to go to the database with `error IS NOT NULL` - the
         * rule every other reader was moved off in da12aeae - while `lastTest`
         * was already built from isFailedTest. Both shapes below are the ones
         * the two rules disagree about, and both arrive through a history
         * import, which validates neither.
         */
        describe("counted by the same rule the last test is judged by", () => {
            it("does not count an empty error beside real readings", async () => {
                await seedTests(server.tests, [{created: hoursAgo(1), error: ""}]);

                const body = await status();

                assert.equal(body.lastTest.failed, false, "the flag calls the row a success");
                assert.equal(body.recentFailures, 0, "the count calls the same row a failure");
            });

            it("counts a failure whose reason went missing", async () => {
                await seedTests(server.tests, [
                    {created: hoursAgo(1), ping: -1, download: -1, upload: -1, error: null}
                ]);

                const body = await status();

                assert.equal(body.lastTest.failed, true, "the flag calls the row a failure");
                assert.equal(body.recentFailures, 1, "the count calls the same row a success");
            });

            // A real failure writes -1 in every column at once, so two real
            // readings must not be condemned by the third.
            it("does not count one placeholder among two readings", async () => {
                await seedTests(server.tests, [{created: hoursAgo(1), ping: -1}]);

                const body = await status();

                assert.equal(body.lastTest.failed, false);
                assert.equal(body.recentFailures, 0);
            });
        });
    });

    describe("the next scheduled test", () => {
        it("reports when the schedule will next fire", async () => {
            await setConfig(server.config, "cron", "0,30 * * * *");

            const {nextTest} = await status();

            assert.ok(nextTest, "no next test was reported");
            assert.ok(new Date(nextTest) > new Date(), "the next test is in the past");
        });

        /**
         * The schedule offset deliberately delays each run by up to a few
         * minutes so that every instance does not test on the same tick. The
         * cron time is then the earliest it could start rather than when it
         * will, and presenting it as exact is simply wrong.
         */
        it("says the time is approximate when the schedule is offset", async () => {
            await setConfig(server.config, "scheduleOffset", "false");
            assert.equal((await status()).nextTestApproximate, false);

            await setConfig(server.config, "scheduleOffset", "true");
            assert.equal((await status()).nextTestApproximate, true);
        });

        // Written past validateInput deliberately: an unusable schedule cannot
        // be set through the API, but one can survive in a database restored
        // from an older export, and the status still has to answer.
        it("is not approximate when there is nothing scheduled", async () => {
            await setConfig(server.config, "scheduleOffset", "true");
            await server.config.updateValue("cron", "not a cron expression");

            const body = await status();

            assert.equal(body.nextTest, null);
            assert.equal(body.nextTestApproximate, false);

            await setConfig(server.config, "cron", "0,30 * * * *");
        });
    });
});

/**
 * What a read-only visitor is told about the schedule, which is nothing.
 *
 * /api/config already withholds `cron`, `scheduleOffset` and both quiet-hours
 * edges from this same caller, and says why: a schedule describes when the
 * operator's connection is busy and when their evening starts, which on a
 * publicly shared dashboard says rather more about the household than about the
 * line. This route was handing back the conclusion drawn from all four. One poll
 * gives the cron's minute field outright, and polling across an evening walks
 * out both edges of the quiet window, since the countdown deliberately skips
 * over it.
 *
 * Withheld as null rather than omitted, which is the same shape the route
 * already answers with when nothing is scheduled - so the status bar's existing
 * "no next test" branch covers it and a visitor's dashboard simply drops the
 * countdown line.
 */
describe("the schedule in view mode", () => {
    const AS_OPERATOR = {headers: {"x-password": "Hunter2!"}};

    const shareReadOnly = async () => {
        await setConfig(server.config, "cron", "13 * * * *");
        await setConfig(server.config, "scheduleOffset", "true");
        await setConfig(server.config, "password", "Hunter2!");
        await setConfig(server.config, "passwordLevel", "read");
    };

    after(async () => {
        await setConfig(server.config, "passwordLevel", "none");
        await setConfig(server.config, "password", "none");
    });

    it("withholds the next test from a visitor who did not authenticate", async () => {
        await shareReadOnly();

        const {status, body} = await api(server.baseUrl, "/speedtests/status");

        assert.equal(status, 200, "the visitor was refused the status entirely");
        assert.equal(body.nextTest, null, "a read-only visitor is told when the next test runs");
        assert.equal(body.nextTestApproximate, false,
            "the offset is disclosed even though the time it applies to is not");
    });

    it("keeps it for the operator who authenticated", async () => {
        await shareReadOnly();

        const {body} = await api(server.baseUrl, "/speedtests/status", AS_OPERATOR);

        assert.ok(body.nextTest, "the operator is no longer told when the next test runs");
        assert.equal(body.nextTestApproximate, true, "the operator is no longer told the time is approximate");
    });

    // The two keys the client has always read are a contract, and a shared
    // dashboard is exactly where they are still needed.
    it("still answers a visitor with what the dashboard runs on", async () => {
        await shareReadOnly();

        const {body} = await api(server.baseUrl, "/speedtests/status");

        assert.equal(body.paused, false);
        assert.equal(body.running, false);
    });
});

// seedTests stores exactly what it is given, so the row is read back rather than
// the input reformatted - sqlite and mysql do not agree on the stored shape.
const hoursAgoStored = (rows) => rows[0].created;
