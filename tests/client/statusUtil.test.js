import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    IDLE_POLL_MS, RUNNING_POLL_MS, START_BLOCKED_PAUSED, START_BLOCKED_RUNNING, START_BLOCKED_VIEW_MODE,
    pollIntervalFor, progressPercent, showsStatusBar, startBlockedReason
} from "@/common/utils/StatusUtil.js";

// The header hides its own start button where the bar already carries one, so
// the two must agree on exactly which route that is.
describe("showsStatusBar", () => {
    it("is the overview", () => {
        assert.equal(showsStatusBar("/"), true);
    });

    it("is not any other page", () => {
        for (const path of ["/statistics", "/nodes", "/statistics?from=2026-08-01"])
            assert.equal(showsStatusBar(path), false, `claimed the bar shows on ${path}`);
    });
});

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
