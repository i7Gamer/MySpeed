import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    HOUR_OPTIONS, MERIDIEM_OPTIONS, MINUTE_OPTIONS, MINUTE_STEP, chosenParts, displayTime, hourOptions,
    maskTime, normaliseTime, partAt, partsOf, stepPart, withPart
} from "@/common/components/TimeField/timeValue.js";
import { storedTimeToInput } from "@/common/components/PauseDialog/quietHoursWindow.js";

/**
 * The clock arithmetic behind the app's own time field.
 *
 * A native `<input type="time">` renders in the *browser's* locale, so an
 * en-US machine drew an AM/PM picker for a setting the rest of this app - and
 * the server, which formats with hourCycle "h23" - states in 24 hours. The
 * field draws itself now on a pointer that can aim at it, which means owning
 * the parsing as well.
 *
 * All of it is strings: the value going out is the `HH:mm` the config stores
 * and `<input type="time">` used to hand over, so nothing downstream had to
 * learn a new shape.
 */

describe("maskTime", () => {
    it("keeps a partial entry as it is typed", () => {
        assert.equal(maskTime(""), "");
        assert.equal(maskTime("0"), "0");
        assert.equal(maskTime("04"), "04");
    });

    it("puts the separator in once there is a minute to separate", () => {
        assert.equal(maskTime("043"), "04:3");
        assert.equal(maskTime("0430"), "04:30");
    });

    it("leaves an already-masked value alone", () => {
        // Every keystroke re-masks the whole field, so this runs on its own
        // output constantly; a mask that moved the colon would fight the typist.
        assert.equal(maskTime("04:30"), "04:30");
        assert.equal(maskTime(maskTime(maskTime("0430"))), "04:30");
    });

    it("respects a colon the reader typed", () => {
        // "430" split by position is 43:0, which is not what somebody typing
        // half four meant. Typing the colon says where it goes.
        assert.equal(maskTime("4:30"), "4:30");
        assert.equal(maskTime("4:3"), "4:3");
    });

    it("takes no more than four digits", () => {
        assert.equal(maskTime("04305"), "04:30");
        assert.equal(maskTime("4:305"), "4:30");
    });

    it("drops everything that is not a digit", () => {
        assert.equal(maskTime("ab"), "");
        assert.equal(maskTime("1a2"), "12");
        assert.equal(maskTime("04-30"), "04:30");
    });

    it("survives a backspace through the separator", () => {
        // "04:30" less its last character is "04:3", which re-masks to itself
        // rather than jumping back to "043".
        assert.equal(maskTime("04:3"), "04:3");
        assert.equal(maskTime("04:"), "04");
    });
});

describe("normaliseTime", () => {
    it("pads a single-digit hour", () => {
        assert.equal(normaliseTime("4:30"), "04:30");
    });

    it("passes a complete time through", () => {
        assert.equal(normaliseTime("04:30"), "04:30");
        assert.equal(normaliseTime("00:00"), "00:00");
        assert.equal(normaliseTime("23:59"), "23:59");
    });

    it("refuses a time off the 24-hour clock", () => {
        assert.equal(normaliseTime("24:00"), "");
        assert.equal(normaliseTime("04:60"), "");
        assert.equal(normaliseTime("99:99"), "");
    });

    it("refuses a partial entry", () => {
        assert.equal(normaliseTime(""), "");
        assert.equal(normaliseTime("04"), "");
        assert.equal(normaliseTime("04:3"), "");
    });

    /**
     * The same answer as the reader that feeds the scheduler.
     *
     * storedTimeToInput is the client's half of the pair quietHoursParity holds
     * against server/util/quietHours.js, and this field's output goes straight
     * into it. Two parsers that disagree would mean a field showing a window the
     * server is not keeping - so they are checked against each other rather than
     * one of them being trusted, which is the arrangement that already caught
     * this class of drift once.
     */
    it("agrees with the window's own reader on every shape", () => {
        const cases = ["", "4:30", "04:30", "00:00", "23:59", "24:00", "04:60", "99:99", "04", "04:3",
            "abc", " 04:30 ", "0:0", "9:05"];

        for (const value of cases)
            assert.equal(normaliseTime(value), storedTimeToInput(value),
                `the field and the window disagree about ${JSON.stringify(value)}`);
    });
});

describe("the option columns", () => {
    it("offers every hour of a 24-hour clock, padded", () => {
        assert.equal(HOUR_OPTIONS.length, 24);
        assert.equal(HOUR_OPTIONS[0], "00");
        assert.equal(HOUR_OPTIONS[4], "04");
        assert.equal(HOUR_OPTIONS.at(-1), "23");
    });

    it("offers minutes a step apart, not sixty rows", () => {
        assert.equal(MINUTE_OPTIONS.length, 60 / MINUTE_STEP);
        assert.equal(MINUTE_OPTIONS[0], "00");
        assert.equal(MINUTE_OPTIONS.at(-1), String(60 - MINUTE_STEP).padStart(2, "0"));
    });
});

describe("partsOf", () => {
    it("splits a complete value", () => {
        assert.deepEqual(partsOf("04:30"), {hour: "04", minute: "30"});
    });

    it("reads what there is of a partial one", () => {
        // The columns highlight what is chosen so far; half a value still has
        // an hour worth marking.
        assert.deepEqual(partsOf("04"), {hour: "04", minute: ""});
        assert.deepEqual(partsOf(""), {hour: "", minute: ""});
    });
});

describe("withPart", () => {
    it("replaces one half and keeps the other", () => {
        assert.equal(withPart("04:30", "hour", "07"), "07:30");
        assert.equal(withPart("04:30", "minute", "45"), "04:45");
    });

    it("starts the other half at zero when there is not one yet", () => {
        // Picking an hour out of the column has to produce a usable time, or
        // the first click on a fresh field would appear to do nothing.
        assert.equal(withPart("", "hour", "07"), "07:00");
        assert.equal(withPart("", "minute", "45"), "00:45");
    });
});

describe("partAt", () => {
    it("names the half the caret is in", () => {
        assert.equal(partAt("04:30", 0), "hour");
        assert.equal(partAt("04:30", 2), "hour");
        assert.equal(partAt("04:30", 3), "minute");
        assert.equal(partAt("04:30", 5), "minute");
    });

    it("is the hour where there is no separator yet", () => {
        assert.equal(partAt("04", 2), "hour");
        assert.equal(partAt("", 0), "hour");
    });
});

describe("stepPart", () => {
    it("moves the hour one at a time and the minute one step", () => {
        assert.equal(stepPart("04:30", "hour", 1), "05:30");
        assert.equal(stepPart("04:30", "hour", -1), "03:30");
        assert.equal(stepPart("04:30", "minute", 1), `04:${30 + MINUTE_STEP}`);
        assert.equal(stepPart("04:30", "minute", -1), `04:${30 - MINUTE_STEP}`);
    });

    it("wraps rather than stopping", () => {
        // A clock has no ends. Stopping at 23 would make the last hour of the
        // day the hard one to reach.
        assert.equal(stepPart("23:30", "hour", 1), "00:30");
        assert.equal(stepPart("00:30", "hour", -1), "23:30");
        assert.equal(stepPart("04:55", "minute", 1), "04:00");
        assert.equal(stepPart("04:00", "minute", -1), "04:55");
    });

    it("snaps a typed minute onto the step it is between", () => {
        // 04:32 up is 04:35, not 04:37: the column the reader is stepping
        // through is the one the picker offers.
        assert.equal(stepPart("04:32", "minute", 1), "04:35");
        assert.equal(stepPart("04:32", "minute", -1), "04:30");
    });

    it("starts an empty field at midnight", () => {
        assert.equal(stepPart("", "hour", 1), "00:00");
        assert.equal(stepPart("", "minute", 1), "00:00");
    });
});

// ---------------------------------------------------------------- twelve hours

/**
 * The reader's own choice of clock, which this field was the one control in the
 * app not to honour.
 *
 * `preferences.timeFormat` already decides every other time on screen - the
 * status bar, the chart axes, the next-test line - through FormatUtil. The
 * quiet-hours field asked the *browser* instead, which is a different question
 * with a different answer, and on an en-US machine it drew an AM/PM picker for
 * somebody who had chosen 24 hours two dialogs away.
 *
 * The value never changes shape: `HH:mm` on a 24-hour clock is what leaves the
 * field either way, because that is what the configuration stores and what the
 * server reads. Only what the reader sees moves.
 */
describe("the twelve-hour clock", () => {
    it("offers twelve hours starting at twelve, and a meridiem", () => {
        assert.equal(hourOptions(true).length, 12);
        assert.equal(hourOptions(true)[0], "12", "one o'clock is not the first hour of a half-day");
        assert.equal(hourOptions(true)[1], "01");
        assert.equal(hourOptions(true).at(-1), "11");
        assert.deepEqual(MERIDIEM_OPTIONS, ["AM", "PM"]);
    });

    it("leaves the 24-hour column exactly as it was", () => {
        assert.deepEqual(hourOptions(false), HOUR_OPTIONS);
    });

    it("shows a stored time on whichever clock was chosen", () => {
        assert.equal(displayTime("13:45", true), "01:45 PM");
        assert.equal(displayTime("13:45", false), "13:45");
        assert.equal(displayTime("", true), "");
    });

    it("puts midnight and noon on the right side of the meridiem", () => {
        // The two every 12-hour conversion gets wrong: hour 0 is 12 AM and
        // hour 12 is 12 PM, and a naive modulo makes both of them 0.
        assert.equal(displayTime("00:00", true), "12:00 AM");
        assert.equal(displayTime("00:30", true), "12:30 AM");
        assert.equal(displayTime("12:00", true), "12:00 PM");
        assert.equal(displayTime("12:30", true), "12:30 PM");
        assert.equal(displayTime("23:59", true), "11:59 PM");
    });

    it("reads a 12-hour entry back as the stored 24-hour value", () => {
        assert.equal(normaliseTime("01:45 PM", true), "13:45");
        assert.equal(normaliseTime("12:00 AM", true), "00:00");
        assert.equal(normaliseTime("12:00 PM", true), "12:00");
        assert.equal(normaliseTime("11:59 PM", true), "23:59");
    });

    it("round-trips every minute of the day", () => {
        // The conversion is the part with two off-by-twelve traps in it, so it
        // is checked against the whole clock rather than against samples.
        for (let hour = 0; hour < 24; hour++)
            for (const minute of ["00", "30", "59"]) {
                const stored = `${String(hour).padStart(2, "0")}:${minute}`;

                assert.equal(normaliseTime(displayTime(stored, true), true), stored,
                    `${stored} does not survive a trip through the 12-hour field`);
            }
    });

    it("takes a lone A or P, so the meridiem can be backspaced", () => {
        // The mask leaves the letters as they were typed. Re-adding the M would
        // make the string identical after a backspace, and the key would look
        // broken.
        assert.equal(normaliseTime("01:45 P", true), "13:45");
        assert.equal(normaliseTime("01:45 a", true), "01:45");
    });

    it("refuses a 12-hour entry with no meridiem, or an impossible hour", () => {
        assert.equal(normaliseTime("01:45", true), "", "AM and PM are different times");
        assert.equal(normaliseTime("13:45 PM", true), "");
        assert.equal(normaliseTime("00:45 AM", true), "");
    });

    it("masks a 12-hour entry as it is typed", () => {
        assert.equal(maskTime("0145", true), "01:45");
        assert.equal(maskTime("0145p", true), "01:45 P");
        assert.equal(maskTime("0145pm", true), "01:45 PM");
        assert.equal(maskTime("01:45 PM", true), "01:45 PM");
    });

    it("steps the meridiem by half a day", () => {
        assert.equal(stepPart("01:45", "meridiem", 1, true), "13:45");
        assert.equal(stepPart("13:45", "meridiem", 1, true), "01:45");
    });

    it("steps a 12-hour column without leaving the half-day it is in", () => {
        // 11 AM up is 12 PM on a 12-hour column, the same as on a 24-hour one:
        // the reader is stepping the clock, not the column.
        assert.equal(stepPart("11:00", "hour", 1, true), "12:00");
        assert.equal(stepPart("23:00", "hour", 1, true), "00:00");
    });

    it("sets an hour out of the 12-hour column into the chosen half-day", () => {
        assert.equal(withPart("13:45", "hour", "03", true), "15:45");
        assert.equal(withPart("01:45", "hour", "03", true), "03:45");
        assert.equal(withPart("13:45", "hour", "12", true), "12:45");
        assert.equal(withPart("01:45", "hour", "12", true), "00:45");
    });

    it("moves a time across the meridiem when the column is picked", () => {
        assert.equal(withPart("01:45", "meridiem", "PM", true), "13:45");
        assert.equal(withPart("13:45", "meridiem", "AM", true), "01:45");
        assert.equal(withPart("13:45", "meridiem", "PM", true), "13:45");
    });

    it("marks the chosen row on the clock the reader is looking at", () => {
        assert.deepEqual(chosenParts("13:45", true), {hour: "01", minute: "45", meridiem: "PM"});
        assert.deepEqual(chosenParts("13:45", false), {hour: "13", minute: "45", meridiem: ""});
        assert.deepEqual(chosenParts("", true), {hour: "", minute: "", meridiem: ""});
    });

    it("names the meridiem as the part the caret is past", () => {
        assert.equal(partAt("01:45 PM", 7), "meridiem");
        assert.equal(partAt("01:45 PM", 4), "minute");
        assert.equal(partAt("01:45 PM", 1), "hour");
    });
});
