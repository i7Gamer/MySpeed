import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as timer from "../../server/tasks/timer.js";
import * as integrationTimer from "../../server/tasks/integrations.js";
import { bodyIn } from "../helpers/source.js";

/**
 * The scheduler's teardown, which had nothing holding it to its own contract.
 *
 * Two things escaped stopTimer(). A second startTimer() overwrote the module's
 * one job reference without cancelling what it replaced, leaving the old job in
 * node-schedule's registry firing on the schedule the operator had just changed
 * away from. And with the schedule offset enabled a run spends up to five
 * minutes inside a setTimeout that stopTimer() has no reference to at all, so a
 * reschedule was followed by a speedtest from the schedule that no longer
 * existed - the pause check after the delay does not catch it, because nothing
 * was paused.
 *
 * Every cron here is far enough in the future that nothing fires during the
 * test; what is asserted is the state of the handles, not their firing.
 */

// 03:00 on the first of January - at most once a year, and never while a test
// is running.
const DISTANT_CRON = "0 3 1 1 *";
const OTHER_CRON = "0 4 1 1 *";

afterEach(() => {
    timer.stopTimer();
    integrationTimer.stopTimer();
});

describe("the speedtest schedule", () => {
    it("cancels the job it replaces", () => {
        timer.startTimer(DISTANT_CRON);
        const first = timer.currentJob();

        timer.startTimer(OTHER_CRON);

        assert.notEqual(first, undefined, "no job was scheduled to begin with");
        assert.equal(first.nextInvocation(), null,
            "the replaced job is still armed and will fire on the old schedule");
        assert.notEqual(timer.currentJob(), first, "the new schedule did not take");
    });

    it("leaves the running job alone when handed an invalid cron", () => {
        timer.startTimer(DISTANT_CRON);
        const first = timer.currentJob();

        timer.startTimer("not a cron expression");

        assert.equal(timer.currentJob(), first);
        assert.notEqual(first.nextInvocation(), null);
    });

    /**
     * With nothing running there is nothing to protect, and the refusal above
     * turns into the opposite of protection: a stored cron that validateInput
     * never saw - a hand-edited database, or one written before validation
     * existed - reached the boot's startTimer, was refused in silence, and no
     * schedule existed at all. Tests simply never ran again, with nothing in
     * the log to say why.
     */
    it("schedules the default cron when an invalid one arrives with nothing running", () => {
        timer.startTimer("not a cron expression");

        const job = timer.currentJob();
        assert.notEqual(job, undefined, "an invalid stored cron left no schedule at all");
        assert.notEqual(job.nextInvocation(), null);
    });

    it("names the default it falls back to rather than a copy of it", () => {
        const startTimer = bodyIn("server/tasks/timer.js", "export const startTimer");

        assert.match(startTimer, /configDefaults\.cron/,
            "the fallback schedule must be the configured default, not a duplicated literal");
    });

    it("drops the job on stopTimer", () => {
        timer.startTimer(DISTANT_CRON);
        const first = timer.currentJob();

        timer.stopTimer();

        assert.equal(timer.currentJob(), undefined);
        assert.equal(first.nextInvocation(), null);
    });

    /**
     * And a run that rejects stays a logged line.
     *
     * create() guards its own work, but runTask does a fair amount before it
     * gets there: the pause state, the quiet hours check and the schedule
     * offset are three config reads, and any of them can reject on a database
     * that has gone away or one a shutdown already under way has closed.
     * Nothing was catching that, so a scheduled run surfaced through index.js's
     * unhandledRejection handler as a bare server fault with no mention of the
     * schedule that produced it - and it repeats on every tick of the cron.
     *
     * index.js catches the startup run for exactly this reason; the scheduled
     * one it hands to node-schedule did not.
     *
     * Read from the source because what is asserted is the shape of the
     * callback handed to node-schedule. Firing it needs a database behind it,
     * which is the thing this is about not having.
     */
    it("guards the run it schedules", () => {
        const startTimer = bodyIn("server/tasks/timer.js", "export const startTimer");

        assert.match(startTimer, /scheduleJob\(/, "the run is no longer scheduled here");
        assert.match(startTimer, /\.catch\(/,
            "a rejecting run is an unhandled rejection on every tick of the cron");
    });
});

describe("the integration ping schedule", () => {
    it("cancels the job it replaces", () => {
        integrationTimer.startTimer();
        const first = integrationTimer.currentJob();

        integrationTimer.startTimer();

        assert.notEqual(first, undefined);
        assert.equal(first.nextInvocation(), null,
            "the replaced ping job is still armed and will double every ping");
        assert.notEqual(integrationTimer.currentJob(), first);
    });

    /**
     * And a tick that rejects stays a logged line rather than becoming an
     * unhandled rejection.
     *
     * The tick is not a bare notification any more: it reads the stored tests
     * to decide where the healthChecks keep-alive should be sent, so it can now
     * reject on a database that has gone away - or one closed by a shutdown
     * already in progress, which is a race the signal handler opened when it
     * started closing the handle. Nothing was catching it, so that surfaced
     * through index.js's unhandledRejection handler as though the server itself
     * had faulted, once every minute.
     *
     * Read from the source because what is being asserted is the shape of the
     * callback handed to node-schedule; firing it for real would need a
     * database behind it, which is the very thing this is about not having.
     */
    it("guards the tick it schedules", () => {
        const startTimer = bodyIn("server/tasks/integrations.js", "export const startTimer");

        assert.match(startTimer, /scheduleJob\(/, "the ping job is no longer scheduled here");
        assert.match(startTimer, /\.catch\(/,
            "a rejecting tick is an unhandled rejection every minute");
    });
});

describe("an offset run that is still waiting", () => {
    it("counts as in flight while it waits", async () => {
        assert.equal(timer.pendingDelayCount(), 0);

        const waiting = timer.delayRun(50);
        assert.equal(timer.pendingDelayCount(), 1);

        await waiting;
        assert.equal(timer.pendingDelayCount(), 0, "a delay that ran its course was not cleared");
    });

    it("is released immediately by stopTimer rather than left to fire", async () => {
        // Longer than the test could ever wait for: if stopTimer does not
        // release it, this test times out rather than passing slowly.
        const waiting = timer.delayRun(60_000);
        assert.equal(timer.pendingDelayCount(), 1);

        timer.stopTimer();

        await waiting;
        assert.equal(timer.pendingDelayCount(), 0);
    });

    it("is told the schedule moved on underneath it", async () => {
        const startedIn = timer.scheduleGeneration();
        assert.equal(timer.scheduleChangedSince(startedIn), false);

        const waiting = timer.delayRun(60_000);
        timer.stopTimer();
        await waiting;

        assert.equal(timer.scheduleChangedSince(startedIn), true,
            "a run that outlived its schedule was not told, and would go on to test");
    });

    it("treats a reschedule the same as a stop", async () => {
        timer.startTimer(DISTANT_CRON);
        const startedIn = timer.scheduleGeneration();

        const waiting = timer.delayRun(60_000);
        timer.startTimer(OTHER_CRON);
        await waiting;

        assert.equal(timer.scheduleChangedSince(startedIn), true,
            "the run belongs to the cron that was just replaced and must not go ahead");
    });

    it("lets an undisturbed run through", async () => {
        timer.startTimer(DISTANT_CRON);
        const startedIn = timer.scheduleGeneration();

        await timer.delayRun(10);

        assert.equal(timer.scheduleChangedSince(startedIn), false);
    });
});

/**
 * The moment the sleeping run will wake, which is what the status bar needs.
 *
 * With the offset enabled the 19:00 job fires and then sleeps for up to five
 * minutes before it tests anything. The countdown is cron arithmetic from now,
 * so any status poll during that sleep answered the slot AFTER the pending one
 * - the bar rolled from "~19:00" to "~19:30" while the 19:00 test was still on
 * its way, which read as it having been skipped.
 */
describe("the pending offset run", () => {
    it("has no wake moment while nothing sleeps", () => {
        assert.equal(timer.pendingRunAt(), null);
    });

    it("names the wake moment while a run sleeps its offset", async () => {
        const sleeping = timer.delayRun(5000);
        const at = timer.pendingRunAt();

        assert.ok(at, "a sleeping delay reports no wake moment");

        const inMs = new Date(at).getTime() - Date.now();
        assert.ok(inMs > 3500 && inMs <= 5100, `the wake moment is ${inMs}ms out rather than ~5s`);

        timer.stopTimer();
        await sleeping;
    });

    it("forgets the moment once the delay is released", async () => {
        const sleeping = timer.delayRun(5000);
        timer.stopTimer();
        await sleeping;

        assert.equal(timer.pendingRunAt(), null, "a released delay still reports a wake moment");
    });

    it("forgets the moment once the delay elapses", async () => {
        await timer.delayRun(10);

        assert.equal(timer.pendingRunAt(), null);
    });
});
