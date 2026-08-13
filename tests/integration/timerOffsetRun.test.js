import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer, setConfig } from "./helpers/boot.js";

/**
 * runTask() itself, which is the only place the offset guard actually lives.
 *
 * The unit tests around it exercise the primitives - delayRun, stopTimer,
 * scheduleGeneration, scheduleChangedSince - in isolation, and every one of
 * them would still pass if runTask forgot to capture `startedIn` before its
 * first await, or forgot to consult it afterwards. That is the whole fix, so it
 * needs a test that runs it.
 *
 * The observable is the speedtests table. The provider is set to cloudflare and
 * no interface has been detected in a test boot, so missingInterfaceMessage
 * refuses the run on every platform before anything is spawned - the attempt
 * fails in milliseconds and records one failed row. A run that goes ahead
 * therefore adds a row and a run that is skipped does not, with no CLI, no
 * network and no timing involved.
 *
 * stopTimer() releasing the pending delay is what keeps this fast: the offset
 * delay is at least thirty seconds, and the test never waits for it.
 */
let server;
let timer;

before(async () => {
    server = await bootServer();
    timer = await import("../../server/tasks/timer.js");
});

after(async () => {
    timer.stopTimer();
    await server?.close();
});

// Far enough out that node-schedule never fires it during the test; it is here
// only so runTask has a currentCron to compute a delay from.
const DISTANT_CRON = "0 3 1 1 *";

const countTests = () => server.tests.count();

beforeEach(async () => {
    timer.stopTimer();
    await server.tests.destroy({where: {}});
    await setConfig(server.config, "provider", "cloudflare");
});

/** Lets runTask get as far as its delay before the test interferes. */
const reachedDelay = async () => {
    for (let attempt = 0; attempt < 50; attempt++) {
        if (timer.pendingDelayCount() > 0) return true;
        await new Promise((resolve) => setImmediate(resolve));
    }
    return false;
};

describe("runTask with the schedule offset enabled", () => {
    it("does not test when the schedule was stopped during its delay", async () => {
        await setConfig(server.config, "scheduleOffset", "true");
        timer.startTimer(DISTANT_CRON);

        const run = timer.runTask();
        assert.ok(await reachedDelay(), "runTask never reached its offset delay");

        timer.stopTimer();
        await run;

        assert.equal(await countTests(), 0,
            "a run whose schedule was stopped underneath it went ahead and tested anyway");
    });

    it("does not test when the schedule was replaced during its delay", async () => {
        await setConfig(server.config, "scheduleOffset", "true");
        timer.startTimer(DISTANT_CRON);

        const run = timer.runTask();
        assert.ok(await reachedDelay(), "runTask never reached its offset delay");

        // A reschedule, which is what changing the cron in the settings does.
        // Nothing is paused here, so the pause check on the far side of the
        // delay cannot be what catches this.
        timer.startTimer("0 4 1 1 *");
        await run;

        assert.equal(await countTests(), 0,
            "changing the cron was still followed by one run from the schedule it replaced");
    });

    /**
     * The control. Without it the two tests above would pass just as happily on
     * a runTask that never tests at all.
     */
    it("does test when nothing disturbed it", async () => {
        await setConfig(server.config, "scheduleOffset", "false");
        timer.startTimer(DISTANT_CRON);

        await timer.runTask();

        assert.equal(await countTests(), 1,
            "an undisturbed run recorded nothing, so the assertions above prove nothing");
    });

    it("leaves no delay in flight once it has finished", async () => {
        await setConfig(server.config, "scheduleOffset", "true");
        timer.startTimer(DISTANT_CRON);

        const run = timer.runTask();
        await reachedDelay();
        timer.stopTimer();
        await run;

        assert.equal(timer.pendingDelayCount(), 0);
    });
});

/**
 * The daily quiet window, checked where it has to be checked: inside runTask.
 *
 * The predicate has its own unit tests, and every one of them would still pass
 * if the scheduler never consulted it. The window is computed from the clock at
 * the moment of the test rather than written out, so the assertions hold
 * whenever the suite happens to run.
 */
describe("runTask during the configured quiet hours", () => {
    const MINUTES_PER_HOUR = 60;

    const clockAt = (offsetMinutes) => {
        const moment = new Date(Date.now() + offsetMinutes * 60_000);

        return `${String(moment.getHours()).padStart(2, "0")}:${String(moment.getMinutes()).padStart(2, "0")}`;
    };

    const setWindow = async (start, end) => {
        await setConfig(server.config, "quietHoursStart", start);
        await setConfig(server.config, "quietHoursEnd", end);
    };

    beforeEach(async () => {
        await setConfig(server.config, "scheduleOffset", "false");
        await setWindow("none", "none");
    });

    after(async () => {
        await setWindow("none", "none");
    });

    it("does not test inside the window", async () => {
        await setWindow(clockAt(-MINUTES_PER_HOUR), clockAt(MINUTES_PER_HOUR));
        timer.startTimer(DISTANT_CRON);

        await timer.runTask();

        assert.equal(await countTests(), 0, "a test ran during the quiet hours");
    });

    it("tests outside the window", async () => {
        await setWindow(clockAt(MINUTES_PER_HOUR), clockAt(2 * MINUTES_PER_HOUR));
        timer.startTimer(DISTANT_CRON);

        await timer.runTask();

        assert.equal(await countTests(), 1, "a test outside the quiet hours was skipped");
    });

    // The window everyone actually wants, and the one a naive comparison gets
    // wrong: its end is a smaller number than its start.
    it("does not test inside a window that crosses midnight", async () => {
        await setWindow(clockAt(-MINUTES_PER_HOUR), clockAt(-2 * MINUTES_PER_HOUR));
        timer.startTimer(DISTANT_CRON);

        await timer.runTask();

        assert.equal(await countTests(), 0, "a window spanning midnight silenced nothing");
    });

    it("tests when no window is configured", async () => {
        timer.startTimer(DISTANT_CRON);

        await timer.runTask();

        assert.equal(await countTests(), 1, "an unconfigured window skipped the run");
    });

    // Only one end set is not a window, and must not be read as one.
    it("tests when only one end of the window is set", async () => {
        await setWindow(clockAt(-MINUTES_PER_HOUR), "none");
        timer.startTimer(DISTANT_CRON);

        await timer.runTask();

        assert.equal(await countTests(), 1, "half a window silenced the run");
    });
});
