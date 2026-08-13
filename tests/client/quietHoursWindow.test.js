import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CronExpressionParser } from "cron-parser";
import {
    carriesWindow, firstRunOutsideWindow, isQuietHour, QUIET_HOURS_OFF, quietHoursUpdates,
    storedTimeToInput, windowProblem, writeQuietHours
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

/**
 * The client's copy of the scheduler's window test, which exists so a dialog can
 * say what the scheduler will do without asking it. tests/client/quietHoursParity
 * keeps this copy and the server's from drifting apart.
 */
describe("isQuietHour", () => {
    const at = (hours, minutes) => new Date(2026, 0, 5, hours, minutes);

    it("covers the wrap-around window the feature exists for", () => {
        assert.equal(isQuietHour(at(23, 30), "23:00", "08:00"), true);
        assert.equal(isQuietHour(at(3, 0), "23:00", "08:00"), true);
        assert.equal(isQuietHour(at(12, 0), "23:00", "08:00"), false);
    });

    it("covers a window inside one day", () => {
        assert.equal(isQuietHour(at(10, 0), "09:00", "17:00"), true);
        assert.equal(isQuietHour(at(18, 0), "09:00", "17:00"), false);
    });

    // Half-open, so "until 08:00" resumes testing at 08:00 rather than a minute
    // later - the same reading the scheduler takes.
    it("includes the minute it starts on and excludes the one it ends on", () => {
        assert.equal(isQuietHour(at(23, 0), "23:00", "08:00"), true);
        assert.equal(isQuietHour(at(8, 0), "23:00", "08:00"), false);
    });

    it("reads a half-written or switched-off window as no window", () => {
        assert.equal(isQuietHour(at(3, 0), "23:00", QUIET_HOURS_OFF), false);
        assert.equal(isQuietHour(at(3, 0), undefined, "08:00"), false);
        assert.equal(isQuietHour(at(3, 0), "09:00", "09:00"), false);
    });
});

describe("firstRunOutsideWindow", () => {
    const occurrencesOf = (cron, from) => {
        const schedule = CronExpressionParser.parse(cron, {currentDate: from});
        return () => schedule.next().toDate();
    };

    /**
     * The case the frequency dialog got wrong: at 23:30 under quiet hours of
     * 23:00-08:00 an hourly cron next fires at 00:00, which the scheduler
     * refuses. The status bar already counted down to 08:00, so the dialog was
     * announcing a test the same screen said was not coming.
     */
    it("steps over the occurrences the scheduler would refuse", () => {
        const found = firstRunOutsideWindow(
            occurrencesOf("0 * * * *", new Date(2026, 0, 5, 23, 30)), "23:00", "08:00");

        assert.equal(found.getDate(), 6);
        assert.equal(found.getHours(), 8);
    });

    it("answers the plain next occurrence when there is no window", () => {
        const found = firstRunOutsideWindow(
            occurrencesOf("0 * * * *", new Date(2026, 0, 5, 23, 30)), QUIET_HOURS_OFF, QUIET_HOURS_OFF);

        assert.equal(found.getDate(), 6);
        assert.equal(found.getHours(), 0);
    });

    /**
     * A window that swallows every occurrence has to end the search rather than
     * walk the schedule forever. Answering null is honest - no scheduled test is
     * going to run - and the dialog shows no preview rather than a wrong one.
     */
    it("gives up on a window that swallows the whole schedule", () => {
        assert.equal(firstRunOutsideWindow(
            occurrencesOf("0 0 * * *", new Date(2026, 0, 5, 12, 0)), "00:00", "01:00"), null);
    });
});

/**
 * Whether a payload is worth reading a window out of at all.
 *
 * The dialog re-reads the configuration after a refused save, through a helper
 * that hands back the parsed body without checking the status. A refusal
 * therefore arrives looking like a config with no keys in it, and reading a
 * window out of that would blank both fields - telling the operator the window
 * is off at the very moment the server may be holding a mixed pair.
 */
describe("carriesWindow", () => {
    it("recognises a configuration that carries both ends", () => {
        assert.equal(carriesWindow({quietHoursStart: "23:00", quietHoursEnd: "08:00"}), true);
        assert.equal(carriesWindow({quietHoursStart: QUIET_HOURS_OFF, quietHoursEnd: QUIET_HOURS_OFF}), true);
    });

    it("refuses a refusal", () => {
        assert.equal(carriesWindow({message: "Unauthorized"}), false);
        assert.equal(carriesWindow(null), false);
        assert.equal(carriesWindow(undefined), false);
    });

    // A read-only visitor is told neither end. There is nothing to show, and
    // showing "off" instead would be an answer nobody gave.
    it("refuses a payload the window was withheld from", () => {
        assert.equal(carriesWindow({viewMode: true, provider: "ookla"}), false);
        assert.equal(carriesWindow({quietHoursStart: "23:00"}), false);
    });
});

/**
 * The window is two configuration keys and there is no endpoint that takes both,
 * so it is written one key at a time. A refusal on the second - a session that
 * expired between the two - used to leave the server holding a new start against
 * the old end, e.g. 22:00-08:00 after editing 23:00-08:00 to 22:00-07:00. The
 * scheduler honours any unequal pair, so it then silenced a band nobody set.
 */
describe("writeQuietHours", () => {
    const STORED = {quietHoursStart: "23:00", quietHoursEnd: "08:00"};

    const recorder = (refuse = () => false) => {
        const writes = [];

        return {
            writes,
            write: async (key, value) => {
                writes.push({key, value});
                if (refuse(key, writes.length)) throw new Error(`${key} refused`);
            }
        };
    };

    it("writes both ends, start first", async () => {
        const {writes, write} = recorder();

        await writeQuietHours(write, "22:00", "07:00", STORED);

        assert.deepEqual(writes, [
            {key: "quietHoursStart", value: "22:00"},
            {key: "quietHoursEnd", value: "07:00"}
        ]);
    });

    it("puts the first end back when the second is refused", async () => {
        const {writes, write} = recorder((key) => key === "quietHoursEnd");

        await assert.rejects(() => writeQuietHours(write, "22:00", "07:00", STORED),
            /quietHoursEnd refused/);

        assert.deepEqual(writes, [
            {key: "quietHoursStart", value: "22:00"},
            {key: "quietHoursEnd", value: "07:00"},
            {key: "quietHoursStart", value: "23:00"}
        ]);
    });

    // Whatever refused the write will very likely refuse the undo as well, and
    // the operator needs to hear about the refusal they caused rather than about
    // this module's attempt to clean up after it.
    it("still reports the write that failed when the undo fails too", async () => {
        const {write} = recorder((key, count) => key === "quietHoursEnd" || count === 3);

        await assert.rejects(() => writeQuietHours(write, "22:00", "07:00", STORED),
            /quietHoursEnd refused/);
    });

    it("has nothing to put back when the first write is refused", async () => {
        const {writes, write} = recorder((key) => key === "quietHoursStart");

        await assert.rejects(() => writeQuietHours(write, "22:00", "07:00", STORED),
            /quietHoursStart refused/);

        assert.deepEqual(writes, [{key: "quietHoursStart", value: "22:00"}]);
    });

    // A redundant write is not free: the server announces every config change to
    // the integrations, so putting back a value that never moved would report a
    // change that never happened.
    it("does not put back an end it never changed", async () => {
        const {writes, write} = recorder((key) => key === "quietHoursEnd");

        await assert.rejects(() => writeQuietHours(write, "23:00", "07:00", STORED),
            /quietHoursEnd refused/);

        assert.deepEqual(writes, [
            {key: "quietHoursStart", value: "23:00"},
            {key: "quietHoursEnd", value: "07:00"}
        ]);
    });

    // The dialog can be looking at a configuration that never carried these keys.
    // Restoring from it would write a guess, which is worse than leaving the
    // mixed pair for the re-read to reveal.
    it("does not guess at a value it was never told", async () => {
        const {writes, write} = recorder((key) => key === "quietHoursEnd");

        await assert.rejects(() => writeQuietHours(write, "22:00", "07:00", {}),
            /quietHoursEnd refused/);

        assert.equal(writes.length, 2);
    });
});
