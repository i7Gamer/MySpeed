import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    IDLE_POLL_MS, RUNNING_POLL_MS, START_BLOCKED_PAUSED, START_BLOCKED_RUNNING, START_BLOCKED_VIEW_MODE,
    pollIntervalFor, startBlockedReason
} from "@/common/utils/StatusUtil.js";

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
