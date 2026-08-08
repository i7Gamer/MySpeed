import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import i18n from "i18next";
import {
    convertSpeed, formatDateTime, formatDuration, formatShortTime, formatTime, getSpeedUnit,
    SPEED_UNIT_MBPS, SPEED_UNIT_MBYTES, TIME_FORMAT_12H, TIME_FORMAT_24H
} from "@/common/utils/FormatUtil.js";

/**
 * Regression: the statistics overview rendered its average duration as
 * `props.time.avg + "s"`. The server returns an explicit null average when no
 * test in the range succeeded - which is exactly what a day of failures looks
 * like - so the tile displayed the literal string "nulls".
 */
describe("formatDuration", () => {
    it("appends the unit to a real duration", () => {
        assert.equal(formatDuration(30), "30s");
        assert.equal(formatDuration(0), "0s");
    });

    it("says nothing was measured rather than concatenating null", () => {
        for (const absent of [null, undefined])
            assert.equal(formatDuration(absent), "N/A", `failed for ${JSON.stringify(absent)}`);
    });

    it("does not render NaN as a duration", () => {
        assert.equal(formatDuration(NaN), "N/A");
    });
});

const MBPS = {speedUnit: SPEED_UNIT_MBPS};
const MBYTES = {speedUnit: SPEED_UNIT_MBYTES};
const CLOCK_24H = {timeFormat: TIME_FORMAT_24H};
const CLOCK_12H = {timeFormat: TIME_FORMAT_12H};

// A fixed local wall-clock time, so the assertions do not depend on the zone the
// suite happens to run in.
const AFTERNOON = new Date(2026, 7, 8, 14, 5, 0);
const MIDNIGHT = new Date(2026, 7, 8, 0, 7, 0);
const NOON = new Date(2026, 7, 8, 12, 30, 0);

before(async () => {
    // getSpeedUnit goes through t(); without an initialised instance it returns
    // the key rather than the label.
    await i18n.init({
        lng: "en",
        resources: {en: {translation: {latest: {speed_unit: "Mbps", byte_speed_unit: "MB/s"}}}}
    });
});

describe("convertSpeed", () => {
    it("leaves a value alone in Mbps", () => {
        assert.equal(convertSpeed(100, MBPS), 100);
    });

    it("divides by eight for MB/s", () => {
        assert.equal(convertSpeed(100, MBYTES), 12.5);
    });

    it("rounds to two decimals rather than trailing float noise", () => {
        assert.equal(convertSpeed(0.1, MBYTES), 0.01);
        assert.equal(convertSpeed(93.7, MBYTES), 11.71);
    });

    it("defaults to Mbps when no preference is set", () => {
        assert.equal(convertSpeed(100, undefined), 100);
        assert.equal(convertSpeed(100, {}), 100);
    });

    // -1 is the placeholder a failed test stores; converting it would present
    // -0.13 as though it were a measurement.
    it("passes the failed-test placeholder through untouched", () => {
        assert.equal(convertSpeed(-1, MBYTES), -1);
    });

    it("passes null and undefined through", () => {
        assert.equal(convertSpeed(null, MBYTES), null);
        assert.equal(convertSpeed(undefined, MBYTES), undefined);
    });

    it("does not try to convert something that is not a number", () => {
        assert.equal(convertSpeed("N/A", MBYTES), "N/A");
        assert.ok(Number.isNaN(convertSpeed(NaN, MBYTES)));
    });

    it("converts zero to zero", () => {
        assert.equal(convertSpeed(0, MBYTES), 0);
    });
});

describe("getSpeedUnit", () => {
    it("names the unit the preference selected", () => {
        assert.equal(getSpeedUnit(MBPS), "Mbps");
        assert.equal(getSpeedUnit(MBYTES), "MB/s");
    });

    it("defaults to Mbps", () => {
        assert.equal(getSpeedUnit(undefined), "Mbps");
    });

    // The label and the number come from two different calls, so a disagreement
    // between them is exactly the bug that showed MB/s values labelled Mbps.
    it("agrees with what convertSpeed did to the value", () => {
        for (const preferences of [MBPS, MBYTES]) {
            const converted = convertSpeed(80, preferences);
            const unit = getSpeedUnit(preferences);

            assert.equal(unit === "MB/s", converted === 10, `${converted} labelled ${unit}`);
        }
    });
});

describe("formatTime", () => {
    it("renders a 24-hour clock", () => {
        assert.equal(formatTime(AFTERNOON, CLOCK_24H), "14:05");
    });

    it("renders a 12-hour clock with a suffix", () => {
        assert.match(formatTime(AFTERNOON, CLOCK_12H), /^02:05\s?PM$/i);
    });

    it("accepts an ISO string as well as a Date", () => {
        assert.equal(formatTime(AFTERNOON.toISOString(), CLOCK_24H), formatTime(AFTERNOON, CLOCK_24H));
    });

    it("returns an empty string for an unusable value", () => {
        for (const value of ["not a date", NaN, undefined, null])
            assert.equal(formatTime(value, CLOCK_24H), "", `failed for ${String(value)}`);
    });
});

describe("formatDateTime", () => {
    it("puts the date before the time", () => {
        const formatted = formatDateTime(AFTERNOON, CLOCK_24H);

        assert.match(formatted, /14:05$/);
        assert.ok(formatted.length > "14:05".length, "the date part is missing");
    });

    it("returns an empty string for an unusable value", () => {
        assert.equal(formatDateTime("nonsense", CLOCK_24H), "");
    });
});

describe("formatShortTime", () => {
    it("zero-pads a 24-hour time", () => {
        assert.equal(formatShortTime(MIDNIGHT, CLOCK_24H), "00:07");
    });

    it("renders a 12-hour time", () => {
        assert.equal(formatShortTime(AFTERNOON, CLOCK_12H), "2:05 PM");
    });

    // The two ends of the 12-hour clock are where the modulo goes wrong: hour 0
    // has to read 12 AM, and hour 12 has to stay 12 PM rather than becoming 0.
    it("renders midnight and noon the way a clock does", () => {
        assert.equal(formatShortTime(MIDNIGHT, CLOCK_12H), "12:07 AM");
        assert.equal(formatShortTime(NOON, CLOCK_12H), "12:30 PM");
    });

    it("defaults to the 24-hour clock", () => {
        assert.equal(formatShortTime(AFTERNOON, undefined), "14:05");
    });
});

describe("locale handling", () => {
    /**
     * Regression: these passed undefined to toLocaleTimeString, which means
     * "whatever the browser is set to" and ignores the language chosen in the
     * app - a German UI on an en-US browser rendered English month names.
     */
    it("formats in the language the app is set to, not the browser's", () => {
        const previous = i18n.language;

        // July, because August is spelled the same in both and would pass
        // whether or not the locale was honoured.
        const july = new Date(2026, 6, 8, 14, 5, 0);

        try {
            i18n.changeLanguage("de");
            const german = formatDateTime(july, CLOCK_24H, {month: "long"});

            i18n.changeLanguage("en");
            const english = formatDateTime(july, CLOCK_24H, {month: "long"});

            assert.notEqual(german, english, "the language made no difference");
            assert.match(german, /Juli/);
            assert.match(english, /July/);
        } finally {
            i18n.changeLanguage(previous);
        }
    });
});
