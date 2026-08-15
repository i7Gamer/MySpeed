import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    IDLE_POLL_MS, RUNNING_POLL_MS, START_BLOCKED_PAUSED, START_BLOCKED_RUNNING, START_BLOCKED_VIEW_MODE,
    pollIntervalFor, progressPercent, runJustFinished, sameStatus, startBlockedReason
} from "@/common/utils/StatusUtil.js";

// showsStatusBar is gone with the header's own start button: every page with
// test data carries the toolbar now, so no route needs the header to decide.

/**
 * Only the Ookla CLI reports progress: librespeed's --json suppresses its
 * verbose output and cfspeedtest's silences everything but the result. A bar
 * pinned at 0% for the length of one of those runs reads as a hung test, so
 * "unknown" has to be distinguishable from "nothing yet".
 */
describe("progressPercent", () => {
    it("is the reported fraction as a percentage", () => {
        assert.equal(progressPercent({running: true, progress: 0.42}), 42);
    });

    it("is zero, not unknown, when a run has just started reporting", () => {
        assert.equal(progressPercent({running: true, progress: 0}), 0);
    });

    it("is unknown for a provider that reports no progress at all", () => {
        assert.equal(progressPercent({running: true, progress: null}), null);
        assert.equal(progressPercent({running: true}), null);
    });

    it("rounds to whole percent", () => {
        assert.equal(progressPercent({running: true, progress: 0.4267}), 43);
    });

    it("never exceeds its bounds", () => {
        assert.equal(progressPercent({running: true, progress: 1.4}), 100);
        assert.equal(progressPercent({running: true, progress: -0.2}), 0);
    });
});

/**
 * The status was polled on one fixed five-second interval. That is far too
 * coarse to drive a progress bar - it would step in fifths through a run - and
 * far too eager for a page sitting idle overnight.
 */
describe("pollIntervalFor", () => {
    it("polls quickly while a test is running", () => {
        assert.equal(pollIntervalFor({running: true}), RUNNING_POLL_MS);
    });

    it("backs off once nothing is running", () => {
        assert.equal(pollIntervalFor({running: false}), IDLE_POLL_MS);
    });

    it("backs off rather than hammering when the status is not known yet", () => {
        for (const unknown of [undefined, null, {}])
            assert.equal(pollIntervalFor(unknown), IDLE_POLL_MS, `polled fast for ${JSON.stringify(unknown)}`);
    });

    it("is the faster of the two while running", () => {
        assert.ok(RUNNING_POLL_MS < IDLE_POLL_MS);
    });
});

/**
 * The tests list stopped being polled on a flat five-second interval; it now
 * refreshes when this says a run has just ended. A cron or remote run is
 * invisible to the page except through the polled `running` flag, so the
 * falling edge of that flag is the one moment a new row can have appeared.
 */
describe("runJustFinished", () => {
    it("fires on the falling edge of a run", () => {
        assert.equal(runJustFinished(true, false), true);
    });

    it("stays quiet while a run is still going", () => {
        assert.equal(runJustFinished(true, true), false);
    });

    it("stays quiet while nothing runs at all", () => {
        assert.equal(runJustFinished(false, false), false);
    });

    it("does not fire when a run starts", () => {
        assert.equal(runJustFinished(false, true), false);
    });

    // The first poll compares against no previous status at all; the page has
    // just loaded its list and owes no refresh.
    it("does not fire before any status was seen", () => {
        assert.equal(runJustFinished(undefined, false), false);
    });

    // A degraded status payload should read as "run over", not as "still on":
    // missing the refresh means showing a stale list until the next run ends.
    it("treats a run that stops being reported as finished", () => {
        assert.equal(runJustFinished(true, undefined), true);
    });
});

/**
 * Two places offer to start a test - the header gauge and the status bar - and
 * each used to decide for itself whether it could. The server enforces this
 * independently; this only decides what the interface offers and what it says.
 */
describe("startBlockedReason", () => {
    it("allows a start when nothing is in the way", () => {
        assert.equal(startBlockedReason({paused: false, running: false}, {}), null);
    });

    it("blocks while a test is already running", () => {
        assert.equal(startBlockedReason({running: true}, {}), START_BLOCKED_RUNNING);
    });

    it("blocks while the schedule is paused", () => {
        assert.equal(startBlockedReason({paused: true}, {}), START_BLOCKED_PAUSED);
    });

    /**
     * A read-only visitor can see the status - the endpoint is readable - but
     * POST /speedtests/run needs write access and would answer 401. Offering the
     * button anyway produces a dead control.
     */
    it("blocks a visitor who is only allowed to look", () => {
        assert.equal(startBlockedReason({paused: false, running: false}, {viewMode: true}), START_BLOCKED_VIEW_MODE);
    });

    // Being told the schedule is paused is useless to someone who could not
    // have started one anyway.
    it("reports being read-only ahead of any other reason", () => {
        assert.equal(startBlockedReason({paused: true, running: true}, {viewMode: true}), START_BLOCKED_VIEW_MODE);
    });

    it("reports a running test ahead of a paused schedule", () => {
        assert.equal(startBlockedReason({paused: true, running: true}, {}), START_BLOCKED_RUNNING);
    });

    it("does not throw before the status or config have loaded", () => {
        assert.equal(startBlockedReason(undefined, undefined), null);
    });
});

/**
 * Whether a polled status is worth storing.
 *
 * The provider stored every response it parsed, and response.json() is a new
 * object each time - so an idle instance re-rendered the whole tree every five
 * seconds, and every second while a test ran, to show what was already on
 * screen. SpeedtestProvider consumes this context and rebuilds its own value on
 * that render, which reaches TestArea and every un-memoised row, and each row
 * calls previousConnection, which walks the list: three hundred rows on a
 * history predating the isp column is quadratic work for an unchanged screen.
 */
describe("sameStatus", () => {
    const IDLE = {paused: false, running: false, phase: null, progress: null,
        lastTest: {created: "2026-08-15T09:00:00.000Z", failed: false}, recentFailures: 0};

    it("recognises two readings of an unchanged instance", () => {
        assert.equal(sameStatus(IDLE, {...IDLE, lastTest: {...IDLE.lastTest}}), true,
            "two polls of an idle instance were treated as a change");
    });

    it("notices a test starting", () => {
        assert.equal(sameStatus(IDLE, {...IDLE, running: true}), false);
    });

    it("notices the progress moving", () => {
        assert.equal(sameStatus({...IDLE, progress: 0.4}, {...IDLE, progress: 0.5}), false);
    });

    // The nested object is the one a shallow comparison would get wrong, and it
    // is the field that changes when a run finishes.
    it("notices a new last test inside the nested record", () => {
        assert.equal(sameStatus(IDLE, {...IDLE, lastTest: {...IDLE.lastTest, failed: true}}), false);
        assert.equal(sameStatus(IDLE, {...IDLE, lastTest: {...IDLE.lastTest, created: "2026-08-15T10:00:00.000Z"}}),
            false);
    });

    it("notices the failure count changing", () => {
        assert.equal(sameStatus(IDLE, {...IDLE, recentFailures: 1}), false);
    });

    // The first poll lands against the seed the provider starts with, and has
    // to be stored.
    it("treats the initial seed as different", () => {
        assert.equal(sameStatus({paused: false, running: false}, IDLE), false);
    });

    it("notices a last test appearing on an instance that had none", () => {
        assert.equal(sameStatus({...IDLE, lastTest: null}, IDLE), false);
    });
});
