import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    QUIET_HOURS_OFF, isQuietHour, isValidTimeOfDay, minutesIntoDay, parseTimeOfDay
} from "../../server/util/quietHours.js";

/**
 * The daily window in which no scheduled test runs.
 *
 * Upstream #736 and #837 ask for the same thing: a speedtest saturates the line
 * for half a minute, and people would rather it did not do that while they are
 * gaming or asleep. Pausing already exists but is a one-shot - it has to be set
 * again every evening, which nobody does.
 *
 * Judged on the server's own clock, which is the clock the schedule itself
 * already runs on: a window read in one timezone and fired in another would
 * silence the wrong hours.
 */
const at = (hours, minutes = 0) => new Date(2026, 7, 13, hours, minutes, 0);

describe("parseTimeOfDay", () => {
    it("reads a time as minutes into the day", () => {
        assert.equal(parseTimeOfDay("00:00"), 0);
        assert.equal(parseTimeOfDay("08:30"), 510);
        assert.equal(parseTimeOfDay("23:59"), 1439);
    });

    it("accepts a single-digit hour", () => {
        assert.equal(parseTimeOfDay("9:05"), 545);
    });

    // The sentinel every other optional setting in the configuration uses.
    it("reads the disabled sentinel as no time at all", () => {
        assert.equal(parseTimeOfDay(QUIET_HOURS_OFF), null);
    });

    it("refuses anything that is not a time", () => {
        for (const bad of ["", null, undefined, "24:00", "12:60", "-1:00", "noon", "12", "12:00:00", {}, 830])
            assert.equal(parseTimeOfDay(bad), null, `accepted ${JSON.stringify(bad)}`);
    });
});

describe("isValidTimeOfDay", () => {
    it("accepts a time and the disabled sentinel", () => {
        assert.equal(isValidTimeOfDay("23:00"), true);
        assert.equal(isValidTimeOfDay(QUIET_HOURS_OFF), true);
    });

    it("refuses anything else", () => {
        for (const bad of ["25:00", "abc", ""]) assert.equal(isValidTimeOfDay(bad), false);
    });
});

describe("minutesIntoDay", () => {
    it("reads the clock off a date", () => {
        assert.equal(minutesIntoDay(at(0, 0)), 0);
        assert.equal(minutesIntoDay(at(8, 30)), 510);
        assert.equal(minutesIntoDay(at(23, 59)), 1439);
    });
});

describe("isQuietHour", () => {
    describe("a window inside one day", () => {
        const window = ["09:00", "17:00"];

        it("is quiet between its ends", () => {
            assert.equal(isQuietHour(at(9, 0), ...window), true);
            assert.equal(isQuietHour(at(13, 0), ...window), true);
            assert.equal(isQuietHour(at(16, 59), ...window), true);
        });

        it("is not quiet outside them", () => {
            assert.equal(isQuietHour(at(8, 59), ...window), false);
            assert.equal(isQuietHour(at(22, 0), ...window), false);
        });

        /**
         * The window includes the minute it starts on and excludes the one it
         * ends on. Half-open so that two windows meeting at the same time do
         * not both claim it, and so "until 08:00" means tests resume at 08:00
         * rather than at 08:01.
         */
        it("starts on its opening minute and ends before its closing one", () => {
            assert.equal(isQuietHour(at(9, 0), ...window), true);
            assert.equal(isQuietHour(at(17, 0), ...window), false);
        });
    });

    /**
     * The window people actually want. "No tests between 23:00 and 08:00"
     * crosses midnight, so the end is a smaller number than the start and a
     * naive start <= now < end matches nothing at all - the feature would
     * silently do nothing for exactly the case it exists for.
     */
    describe("a window that crosses midnight", () => {
        const window = ["23:00", "08:00"];

        it("is quiet on both sides of midnight", () => {
            assert.equal(isQuietHour(at(23, 0), ...window), true);
            assert.equal(isQuietHour(at(23, 59), ...window), true);
            assert.equal(isQuietHour(at(0, 0), ...window), true);
            assert.equal(isQuietHour(at(3, 30), ...window), true);
            assert.equal(isQuietHour(at(7, 59), ...window), true);
        });

        it("is not quiet through the day between them", () => {
            assert.equal(isQuietHour(at(8, 0), ...window), false);
            assert.equal(isQuietHour(at(12, 0), ...window), false);
            assert.equal(isQuietHour(at(22, 59), ...window), false);
        });
    });

    describe("a window that is not set", () => {
        it("is never quiet when either end is missing", () => {
            assert.equal(isQuietHour(at(3, 0), QUIET_HOURS_OFF, QUIET_HOURS_OFF), false);
            assert.equal(isQuietHour(at(3, 0), "23:00", QUIET_HOURS_OFF), false);
            assert.equal(isQuietHour(at(3, 0), QUIET_HOURS_OFF, "08:00"), false);
            assert.equal(isQuietHour(at(3, 0), undefined, undefined), false);
        });

        it("is never quiet when either end is nonsense", () => {
            assert.equal(isQuietHour(at(3, 0), "25:00", "08:00"), false);
            assert.equal(isQuietHour(at(3, 0), "23:00", "hello"), false);
        });

        /**
         * Two ends on the same minute describe a window of no length. Read the
         * other way - as a window covering the whole day - a mistyped pair
         * would silence every scheduled test for good, with the interface
         * showing a perfectly ordinary setting. The harmless reading is the
         * right one.
         */
        it("is never quiet when both ends are the same minute", () => {
            for (const hour of [0, 9, 23])
                assert.equal(isQuietHour(at(hour, 0), "09:00", "09:00"), false,
                    `${hour}:00 was silenced by a zero-length window`);
        });
    });
});
