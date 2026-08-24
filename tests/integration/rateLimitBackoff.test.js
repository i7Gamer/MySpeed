import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer, setConfig } from "./helpers/boot.js";
import { FIRST_BACKOFF_MS, forgetAllBackoff, recordRateLimit } from "../../server/util/rateLimitBackoff.js";

/**
 * The hold, checked where it has to be checked: inside runTask.
 *
 * The unit tests around the backoff exercise the state machine in isolation, and
 * every one of them would still pass if the scheduler never consulted it - which
 * is the whole fix. A provider that has said "too many requests" being asked
 * again a minute later is upstream #846 and #1092, and no amount of correct
 * arithmetic about deadlines prevents it unless something reads the answer.
 *
 * The observable is the speedtests table, the way timerOffsetRun.test.js uses
 * it: the provider is set to one whose CLI is never reached, because no
 * interface has been detected in a test boot, so an attempt fails in
 * milliseconds and records one failed row. A run that goes ahead adds a row and
 * a run that is held does not, with no CLI, no network and no waiting involved.
 */
let server;
let timer;
let speedtest;

const PROVIDER = "cloudflare";

before(async () => {
    server = await bootServer();
    timer = await import("../../server/tasks/timer.js");
    speedtest = await import("../../server/tasks/speedtest.js");
});

after(async () => {
    timer.stopTimer();
    forgetAllBackoff();
    await server?.close();
});

// Far enough out that node-schedule never fires it during the test; it is here
// only so runTask has a currentCron to work from.
const DISTANT_CRON = "0 3 1 1 *";

const countTests = () => server.tests.count();

beforeEach(async () => {
    timer.stopTimer();
    forgetAllBackoff();
    await server.tests.destroy({where: {}});
    await setConfig(server.config, "provider", PROVIDER);
    // The offset would put a thirty-second sleep in front of every run here, and
    // none of these assertions are about it.
    await setConfig(server.config, "scheduleOffset", "false");
});

describe("a scheduled run while the provider is refusing", () => {
    it("is not made at all", async () => {
        recordRateLimit(PROVIDER);
        timer.startTimer(DISTANT_CRON);

        await timer.runTask();

        assert.equal(await countTests(), 0,
            "the schedule asked a provider that had just refused, and recorded another failure for it");
    });

    /**
     * The control. Without it the assertion above would pass just as happily on
     * a runTask that never tests at all.
     */
    it("is made when nothing is being held", async () => {
        timer.startTimer(DISTANT_CRON);

        await timer.runTask();

        assert.equal(await countTests(), 1,
            "an unheld run recorded nothing, so the assertion above proves nothing");
    });

    /**
     * Backdated rather than waited out: the first wait is a quarter of an hour,
     * and what is being asserted is that the deadline is consulted rather than
     * the flag merely being set once and never cleared.
     */
    it("is made again once the wait has elapsed", async () => {
        recordRateLimit(PROVIDER, Date.now() - FIRST_BACKOFF_MS);
        timer.startTimer(DISTANT_CRON);

        await timer.runTask();

        assert.equal(await countTests(), 1, "an elapsed hold went on holding the schedule");
    });

    /**
     * Switching provider is what somebody does about being refused - it is what
     * two of the upstream reports did - so the hold must not follow them to the
     * provider that is answering.
     */
    it("is made against a provider that was not the one refusing", async () => {
        recordRateLimit("ookla");
        timer.startTimer(DISTANT_CRON);

        await timer.runTask();

        assert.equal(await countTests(), 1,
            "one provider's limiter silenced the schedule on a different provider");
    });
});

/**
 * The same rule the quiet hours follow, and for the same reason its own module
 * states: a test started by hand is somebody asking for one now, and refusing it
 * would be a fault rather than a courtesy. The backoff exists to stop the
 * *schedule* from hammering a limiter, not to take the button away.
 */
describe("a run started by hand while the provider is refusing", () => {
    it("is made", async () => {
        recordRateLimit(PROVIDER);

        await speedtest.create("manual");

        assert.equal(await countTests(), 1, "the run button stopped working after a rate limit");
    });
});
