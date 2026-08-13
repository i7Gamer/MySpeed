import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    QUIET_HOURS_OFF, quietHoursUpdates, storedTimeToInput, windowProblem
} from "@/common/components/PauseDialog/quietHoursWindow.js";

/**
 * The two ends of the daily quiet window, as the dialog handles them.
 *
 * Both have to be set for the window to mean anything - the server reads half a
 * window as no window - so the dialog has to say so rather than accept a
 * setting that silently does nothing. And clearing it has to clear both ends,
 * or the leftover one sits in the configuration looking like a setting.
 */
describe("windowProblem", () => {
    it("is happy with a complete window", () => {
        assert.equal(windowProblem("23:00", "08:00"), null);
        assert.equal(windowProblem("09:00", "17:00"), null);
    });

    it("is happy with no window at all", () => {
        assert.equal(windowProblem("", ""), null);
    });

    // Half a window does nothing on the server, so accepting it here would be
    // an interface reporting success for a setting that never applies.
    it("names the end that is missing", () => {
        assert.equal(windowProblem("23:00", ""), "end");
        assert.equal(windowProblem("", "08:00"), "start");
    });

    /**
     * Two ends on the same minute describe a window of no length. The server
     * reads that as switched off rather than as covering the whole day, and the
     * dialog must not present it as an armed setting either.
     */
    it("rejects a window of no length", () => {
        assert.equal(windowProblem("09:00", "09:00"), "same");
    });
});

describe("quietHoursUpdates", () => {
    it("sends both ends of a window", () => {
        assert.deepEqual(quietHoursUpdates("23:00", "08:00"), [
            {key: "quietHoursStart", value: "23:00"},
            {key: "quietHoursEnd", value: "08:00"}
        ]);
    });

    // Clearing has to clear both, or the leftover end stays in the
    // configuration looking like part of a setting that is no longer there.
    it("switches both ends off when the window is cleared", () => {
        assert.deepEqual(quietHoursUpdates("", ""), [
            {key: "quietHoursStart", value: QUIET_HOURS_OFF},
            {key: "quietHoursEnd", value: QUIET_HOURS_OFF}
        ]);
    });
});

describe("storedTimeToInput", () => {
    // The stored sentinel is not a time, and a time input must not be handed it
    // as one - it would either show nothing or refuse to parse, depending on
    // the browser.
    it("reads the off sentinel as an empty field", () => {
        assert.equal(storedTimeToInput(QUIET_HOURS_OFF), "");
        assert.equal(storedTimeToInput(undefined), "");
        assert.equal(storedTimeToInput(null), "");
    });

    it("passes a real time through", () => {
        assert.equal(storedTimeToInput("23:00"), "23:00");
    });

    // The server accepts a single-digit hour; a time input needs two.
    it("pads a single-digit hour for the input", () => {
        assert.equal(storedTimeToInput("9:05"), "09:05");
    });
});
