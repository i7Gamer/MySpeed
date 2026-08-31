import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    HOUR_OPTIONS, MINUTE_OPTIONS, MINUTE_STEP, maskTime, normaliseTime, partAt, partsOf, stepPart, withPart
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
