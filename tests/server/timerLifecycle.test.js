import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as timer from "../../server/tasks/timer.js";
import * as integrationTimer from "../../server/tasks/integrations.js";

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

    it("drops the job on stopTimer", () => {
        timer.startTimer(DISTANT_CRON);
        const first = timer.currentJob();

        timer.stopTimer();

        assert.equal(timer.currentJob(), undefined);
        assert.equal(first.nextInvocation(), null);
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
