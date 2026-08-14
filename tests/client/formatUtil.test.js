import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import i18n from "i18next";
import {
    convertSpeed, formatBytes, formatDateTime, formatDuration, formatLastTest, formatLatency,
    formatLatencyWithUnit, formatShortDay, formatShortTime, formatTime, formatHour, formatWhole,
    formatWithUnit, generateRelativeTime, getSpeedUnit, NOT_MEASURED, SPEED_UNIT_MBPS, SPEED_UNIT_MBYTES,
    TIME_FORMAT_12H, TIME_FORMAT_24H
} from "@/common/utils/FormatUtil.js";

// Moved here from the latest-test panel when the status bar replaced it, and
// covered on the way: the status bar and the integration dialog both read it.
describe("generateRelativeTime", () => {
    const secondsAgo = (seconds) => new Date(Date.now() - seconds * 1000).toISOString();

    it("says a moment just passed rather than counting single seconds", () => {
        assert.equal(generateRelativeTime(secondsAgo(2)), "Just now");
    });

    it("counts in seconds, then minutes, then hours, then days", () => {
        assert.match(generateRelativeTime(secondsAgo(30)), /30/);
        assert.match(generateRelativeTime(secondsAgo(20 * 60)), /20/);
        assert.match(generateRelativeTime(secondsAgo(5 * 3600)), /5/);
        assert.match(generateRelativeTime(secondsAgo(3 * 86400)), /3/);
    });

    it("uses the singular on the boundary", () => {
        assert.equal(generateRelativeTime(secondsAgo(60)), "1 minute");
        assert.equal(generateRelativeTime(secondsAgo(3600)), "1 hour");
        assert.equal(generateRelativeTime(secondsAgo(86400)), "1 day");
    });

    it("says nothing rather than NaN when there is no date", () => {
        for (const absent of [null, undefined, ""])
            assert.equal(generateRelativeTime(absent), "N/A", `failed for ${JSON.stringify(absent)}`);
    });
});

/**
 * The status bar wraps the relative time in "Last test … ago". Most of what
 * generateRelativeTime returns is a bare duration and reads correctly that way,
 * but "Just now" is already a complete phrase - composing it produced "Last test
 * Just now ago".
 */
describe("formatLastTest", () => {
    const secondsAgo = (seconds) => new Date(Date.now() - seconds * 1000).toISOString();

    it("wraps a duration in the surrounding phrase", () => {
        assert.equal(formatLastTest(secondsAgo(20 * 60)), "Last test 20 minutes ago");
    });

    it("does not put 'ago' after a phrase that already reads as one", () => {
        assert.equal(formatLastTest(secondsAgo(2)), "Last test just now");
    });

    it("says no test has run when there is no date at all", () => {
        for (const absent of [null, undefined, ""])
            assert.equal(formatLastTest(absent), "No test has run yet", `failed for ${JSON.stringify(absent)}`);
    });

    it("keeps wrapping on the far side of the boundary", () => {
        assert.match(formatLastTest(secondsAgo(30)), /ago$/);
    });
});

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

/**
 * Regression: the statistics rendered `{value} {unit}` directly. The server
 * returns an explicit null for a figure it could not compute - every aggregate
 * over a range in which nothing succeeded - so the tiles showed a bare "Mbps"
 * with no number in front of it.
 */
describe("formatWithUnit", () => {
    it("puts the unit after the value", () => {
        assert.equal(formatWithUnit(2366.32, "Mbps"), "2366.32 Mbps");
    });

    it("keeps a genuine zero", () => {
        assert.equal(formatWithUnit(0, "Mbps"), "0 Mbps");
    });

    it("says nothing was measured rather than showing a lone unit", () => {
        for (const absent of [null, undefined, NaN])
            assert.equal(formatWithUnit(absent, "Mbps"), "N/A", `failed for ${JSON.stringify(absent)}`);
    });

    it("drops the unit entirely when there is no value", () => {
        assert.doesNotMatch(formatWithUnit(null, "Mbps"), /Mbps/);
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
        resources: {en: {translation: {
            latest: {speed_unit: "Mbps", byte_speed_unit: "MB/s"},
            // Copied from the english locale, so the assertions read as what a
            // user actually sees rather than as key names.
            time: {
                now: "Just now", seconds: "{{seconds}} seconds",
                minute: "1 minute", minutes: "{{minutes}} minutes",
                hour: "1 hour", hours: "{{hours}} hours",
                day: "1 day", days: "{{days}} days"
            },
            status: {
                last_test: "Last test {{time}} ago",
                last_test_now: "Last test just now",
                never_run: "No test has run yet"
            }
        }}}
    });
});

/**
 * What a latency looks like on screen, now that the column behind it keeps
 * decimals rather than whole milliseconds.
 *
 * One decimal, which is what upstream #1387 asks for: the stored value and the
 * API keep two, but the test row is dense - the latency shares it with the
 * jitter, the download and the upload - and the second decimal is noise at a
 * glance.
 */
describe("formatLatency", () => {
    it("shows one decimal", () => {
        assert.equal(formatLatency(12.64), 12.6);
        assert.equal(formatLatency(0.42), 0.4);
    });

    // A whole millisecond reads as a whole millisecond, not as "13.0".
    it("leaves a whole value whole", () => {
        assert.equal(formatLatency(13), 13);
        assert.equal(formatLatency(13.01), 13);
    });

    // -1 is the placeholder a failed test stores in every numeric column, and
    // the interface recognises a failure by it.
    it("passes the failure placeholder through untouched", () => {
        assert.equal(formatLatency(-1), -1);
    });

    it("passes through anything that is not a number", () => {
        for (const absent of [null, undefined, "N/A", NaN])
            assert.deepEqual(formatLatency(absent), absent);
    });
});

/**
 * A latency and its unit in one call, because the two had drifted apart: the
 * detail pane printed the ping through formatLatency and the jitter beside it
 * through formatWithUnit, so one card carried "25.4 ms" and "1.72 ms" as though
 * the two had been measured to different precisions.
 */
describe("formatLatencyWithUnit", () => {
    it("trims the figure and appends the unit", () => {
        assert.equal(formatLatencyWithUnit(25.44, "ms"), "25.4 ms");
        assert.equal(formatLatencyWithUnit(1.72, "ms"), "1.7 ms");
    });

    it("agrees with the latency the interface prints on its own", () => {
        assert.equal(formatLatencyWithUnit(25.44, "ms"), `${formatLatency(25.44)} ms`);
    });

    it("leaves a whole millisecond whole", () => {
        assert.equal(formatLatencyWithUnit(13, "ms"), "13 ms");
    });

    it("keeps a genuine zero", () => {
        assert.equal(formatLatencyWithUnit(0, "ms"), "0 ms");
    });

    // Same as formatWithUnit: a figure the provider never measured must not
    // leave a bare unit standing on its own.
    it("says nothing was measured rather than showing a lone unit", () => {
        for (const absent of [null, undefined, NaN])
            assert.equal(formatLatencyWithUnit(absent, "ms"), NOT_MEASURED, `failed for ${String(absent)}`);
    });
});

/**
 * What the overview rows print, now that a latency carries decimals.
 *
 * The list is read down its columns, and a column reads as one when its figures
 * are the same width - so the three measurements a row shows are whole numbers.
 * The panel a row opens onto still prints every figure at full precision, which
 * is where the tenths are worth reading.
 */
describe("formatWhole", () => {
    it("rounds to the nearest whole number", () => {
        assert.equal(formatWhole(12.64), 13);
        assert.equal(formatWhole(93.72), 94);
        assert.equal(formatWhole(0.4), 0);
    });

    it("rounds a half up", () => {
        assert.equal(formatWhole(12.5), 13);
    });

    it("leaves a whole value whole", () => {
        assert.equal(formatWhole(13), 13);
    });

    /**
     * The guard is the point of the helper. Math.round(null) is 0 and
     * Math.round(undefined) is NaN, so a figure the provider never measured
     * would print as a reading of zero or as the word "NaN" - and -1 is the
     * placeholder a failed test stores in every numeric column, which the
     * interface recognises a failure by.
     */
    it("passes the failure placeholder through untouched", () => {
        assert.equal(formatWhole(-1), -1);
    });

    it("passes through anything that is not a number", () => {
        for (const absent of [null, undefined, "N/A", NaN])
            assert.deepEqual(formatWhole(absent), absent, `failed for ${String(absent)}`);
    });

    it("keeps a genuine zero", () => {
        assert.equal(formatWhole(0), 0);
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

/**
 * The label an averaged row wears in the test list, where the row stands for a
 * whole day rather than a moment.
 *
 * It used to be assembled by hand as `DD.MM`, the one place left in the
 * interface still spelling a date numerically. That ordering is read as MM.DD
 * by roughly half the people who see it and is unreadable either way once the
 * month is ambiguous - upstream #785. The year is deliberately left off: the
 * row is narrow, and the list is already bounded by the chosen range.
 */
describe("formatShortDay", () => {
    const AUGUST_17 = new Date(2026, 7, 17, 14, 5, 0);

    it("names the month rather than numbering it", () => {
        const formatted = formatShortDay(AUGUST_17);

        assert.match(formatted, /17/);
        assert.match(formatted, /[A-Za-z]/, "the month is still a number");
        assert.doesNotMatch(formatted, /^\d+\.\d+$/);
    });

    it("leaves the year off", () => {
        assert.doesNotMatch(formatShortDay(AUGUST_17), /2026/);
    });

    it("follows the language the app is set to", () => {
        const previous = i18n.language;
        const july = new Date(2026, 6, 8);

        try {
            i18n.changeLanguage("de");
            const german = formatShortDay(july);

            i18n.changeLanguage("en");
            const english = formatShortDay(july);

            assert.notEqual(german, english, "the language made no difference");
        } finally {
            i18n.changeLanguage(previous);
        }
    });

    it("says nothing rather than NaN when there is no date", () => {
        for (const absent of [null, undefined, ""])
            assert.equal(formatShortDay(absent), "", `failed for ${JSON.stringify(absent)}`);
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

/**
 * Lived inside the hourly chart until the overview card started naming the
 * fastest and slowest hours of the day.
 */
describe("formatHour", () => {
    it("pads the hour on a 24-hour clock", () => {
        assert.equal(formatHour(0, CLOCK_24H), "00:00");
        assert.equal(formatHour(9, CLOCK_24H), "09:00");
        assert.equal(formatHour(20, CLOCK_24H), "20:00");
    });

    it("is the 24-hour clock by default", () => {
        assert.equal(formatHour(20, undefined), "20:00");
        assert.equal(formatHour(20, {}), "20:00");
    });

    // Midnight and noon are the two the modulo gets wrong: 0 % 12 and 12 % 12
    // are both zero, and "0:00 AM" is not a time anyone writes.
    it("writes noon and midnight as twelve on a 12-hour clock", () => {
        assert.equal(formatHour(0, CLOCK_12H), "12:00 AM");
        assert.equal(formatHour(12, CLOCK_12H), "12:00 PM");
    });

    it("halves the afternoon hours on a 12-hour clock", () => {
        assert.equal(formatHour(9, CLOCK_12H), "9:00 AM");
        assert.equal(formatHour(13, CLOCK_12H), "1:00 PM");
        assert.equal(formatHour(23, CLOCK_12H), "11:00 PM");
    });
});

/**
 * How much a test transferred. Ookla and LibreSpeed report the count, and
 * Cloudflare's payload sizes give it - a single Ookla run moves a couple of
 * gigabytes, which is what decides whether testing every fifteen minutes is
 * affordable on a metered line.
 */
describe("formatBytes", () => {
    it("steps up to the largest unit that keeps the number small", () => {
        assert.equal(formatBytes(512), "512 B");
        assert.equal(formatBytes(1000), "1 KB");
        assert.equal(formatBytes(1500000), "1.5 MB");
        assert.equal(formatBytes(1135809960), "1.1 GB");
        assert.equal(formatBytes(2500000000000), "2.5 TB");
    });

    // Under a kilobyte the decimal is noise, and "512.0 B" is a byte count
    // pretending to a precision bytes do not have.
    it("leaves whole bytes whole", () => {
        assert.equal(formatBytes(0), "0 B");
        assert.equal(formatBytes(999), "999 B");
    });

    // Decimal, not binary: the providers state their payloads in decimal, so a
    // 100 MB Cloudflare payload has to read back as 100 MB and not 95.4.
    it("counts a thousand to the step, the way the providers do", () => {
        assert.equal(formatBytes(100000000), "100 MB");
    });

    it("drops a trailing zero rather than writing 1.0 GB", () => {
        assert.equal(formatBytes(1000000000), "1 GB");
    });

    /**
     * The rounding decides the unit, not just the digits. A count just under a
     * boundary divides to 999.99…, which one decimal turns into 1000.0 - and
     * printed with the unit below it that reads "1000 MB" for what is a
     * gigabyte. A gigabit line's download lands in that band routinely.
     */
    it("promotes a count that only reaches the next unit once rounded", () => {
        assert.equal(formatBytes(999999999), "1 GB");
        assert.equal(formatBytes(999999), "1 MB");
        assert.equal(formatBytes(999950), "1 MB");
        assert.equal(formatBytes(999999999999), "1 TB");
    });

    // The other side of that boundary still belongs to the smaller unit.
    it("keeps a count that stays below the boundary once rounded", () => {
        assert.equal(formatBytes(999949), "999.9 KB");
    });

    // Past the top of the ladder the number keeps growing rather than inventing
    // a unit - a petabyte of speedtests is not a case worth a rung.
    it("stays in terabytes past the end of the ladder", () => {
        assert.equal(formatBytes(3000000000000000), "3000 TB");
    });

    // A column that was never measured, and the -1 a failed run writes into its
    // numeric columns. Neither is a quantity of data.
    it("reports anything that is not a count as unmeasured", () => {
        for (const value of [null, undefined, NaN, Infinity, -1, "1000", {}])
            assert.equal(formatBytes(value), NOT_MEASURED, `value ${String(value)}`);
    });
});
