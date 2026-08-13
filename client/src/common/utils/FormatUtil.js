import i18n, {t} from "i18next";
// The constants module rather than the context barrel: that barrel re-exports a
// React component, which would drag the whole component tree into anything that
// only wanted to know what "mbps" is called.
import {SPEED_UNIT_MBPS, SPEED_UNIT_MBYTES, TIME_FORMAT_12H, TIME_FORMAT_24H} from "@/common/contexts/Preferences/constants";

// Passing undefined means "whatever locale the browser is set to", which
// ignores the language the user picked in the app - a German UI rendered
// English month names and a 12-hour clock on an en-US browser.
const locale = () => i18n.language || undefined;

const toDate = (value) => {
    if (value instanceof Date) return value;

    // new Date(null) is the epoch rather than an invalid date, and the same
    // goes for "" and 0 - so an absent timestamp rendered as 01/01/1970
    // instead of the blank the isNaN guards below were meant to produce.
    if (value === null || value === undefined || value === "") return new Date(NaN);

    return new Date(value);
};

/**
 * A calendar day, in the language the app is set to.
 *
 * For naming a range in prose - "No tests between 12 Jul and 19 Jul" - where
 * the time of day would be noise.
 */
export const formatDay = (value) => {
    const date = toDate(value);
    if (isNaN(date.getTime())) return "";

    return date.toLocaleDateString(locale(), {day: "2-digit", month: "short", year: "numeric"});
};

/**
 * A calendar day without its year, for a label that has no room for one.
 *
 * The averaged rows in the test list used to build this by hand as `DD.MM` -
 * the last numeric date left in the interface, read as MM.DD by about half the
 * people who saw it. The month is named instead, which is unambiguous in every
 * locale; the year stays off because the list is already bounded by the range
 * the reader chose.
 */
export const formatShortDay = (value) => {
    const date = toDate(value);
    if (isNaN(date.getTime())) return "";

    return date.toLocaleDateString(locale(), {day: "2-digit", month: "short"});
};

export const formatTime = (value, preferences) => {
    const date = toDate(value);
    if (isNaN(date.getTime())) return "";

    const use12h = preferences?.timeFormat === TIME_FORMAT_12H;
    return date.toLocaleTimeString(locale(), {
        hour: "2-digit",
        minute: "2-digit",
        hour12: use12h
    });
};

export const formatDateTime = (value, preferences, dateOptions = {}) => {
    const date = toDate(value);
    if (isNaN(date.getTime())) return "";

    const use12h = preferences?.timeFormat === TIME_FORMAT_12H;
    const datePart = date.toLocaleDateString(locale(), dateOptions);
    const timePart = date.toLocaleTimeString(locale(), {
        hour: "2-digit",
        minute: "2-digit",
        hour12: use12h
    });
    return `${datePart} ${timePart}`;
};

export const formatShortTime = (date, preferences) => {
    const use12h = preferences?.timeFormat === TIME_FORMAT_12H;
    if (use12h) {
        let hours = date.getHours();
        const minutes = String(date.getMinutes()).padStart(2, "0");
        const suffix = hours >= 12 ? "PM" : "AM";
        hours = hours % 12;
        if (hours === 0) hours = 12;
        return `${hours}:${minutes} ${suffix}`;
    }
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${hours}:${minutes}`;
};

/**
 * A whole hour of the day, on the clock the reader has chosen.
 *
 * Lived inside the hourly chart until the overview card started naming the
 * fastest and slowest hours of the day: two components writing "20:00" from the
 * same preference is one of them eventually forgetting the 12-hour case.
 */
export const formatHour = (hour, preferences) => {
    if (preferences?.timeFormat !== TIME_FORMAT_12H) return `${String(hour).padStart(2, "0")}:00`;

    const suffix = hour >= 12 ? "PM" : "AM";
    const twelve = hour % 12;

    return `${twelve === 0 ? 12 : twelve}:00 ${suffix}`;
};

export const getSpeedUnit = (preferences) => {
    if (preferences?.speedUnit === SPEED_UNIT_MBYTES) {
        return t("latest.byte_speed_unit", {defaultValue: "MB/s"});
    }
    return t("latest.speed_unit");
};

export const convertSpeed = (mbps, preferences) => {
    if (mbps === null || mbps === undefined) return mbps;
    if (typeof mbps !== "number" || isNaN(mbps)) return mbps;
    if (mbps < 0) return mbps;

    if (preferences?.speedUnit === SPEED_UNIT_MBYTES) {
        return Math.round((mbps / 8) * 100) / 100;
    }
    return mbps;
};

// What a value the server could not compute is shown as. The statistics return
// an explicit null - for an average over a range in which nothing succeeded, for
// instance - and concatenating a unit onto that renders the word "null".
export const NOT_MEASURED = "N/A";

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86400;

// Below this, "now" reads better than a number of seconds that is stale by the
// time it is read.
const JUST_NOW_SECONDS = 5;

/**
 * How long ago something happened, in words.
 *
 * Moved here from the latest-test panel when the status bar replaced it - the
 * integration dialog reads it too, so it outlived the component it was written
 * for.
 */
export function generateRelativeTime(created) {
    let currentDate = new Date().getTime();
    let date = new Date(Date.parse(created)).getTime();

    const diff = (currentDate - date) / 1000;

    if (isNaN(diff)) {
        return NOT_MEASURED;
    }

    if (diff < JUST_NOW_SECONDS) {
        return t("time.now");
    } else if (diff < SECONDS_PER_MINUTE) {
        return t("time.seconds", {replace: {seconds: Math.floor(diff)}});
    } else if (diff < SECONDS_PER_HOUR) {
        return Math.floor(diff / SECONDS_PER_MINUTE) === 1
            ? t("time.minute")
            : t("time.minutes", {replace: {minutes: Math.floor(diff / SECONDS_PER_MINUTE)}});
    } else if (diff < SECONDS_PER_DAY) {
        return Math.floor(diff / SECONDS_PER_HOUR) === 1
            ? t("time.hour")
            : t("time.hours", {replace: {hours: Math.floor(diff / SECONDS_PER_HOUR)}});
    }

    const days = Math.floor(diff / SECONDS_PER_DAY);
    return days === 1 ? t("time.day") : t("time.days", {replace: {days: days}});
}

/**
 * How long ago the last test ran, as a whole sentence.
 *
 * The surrounding phrase is chosen here rather than at the call site because
 * most of what generateRelativeTime returns is a bare duration that reads
 * correctly inside "Last test … ago", while "Just now" is already a complete
 * phrase - wrapping that produced "Last test Just now ago".
 */
export function formatLastTest(created) {
    const seconds = (new Date().getTime() - new Date(Date.parse(created)).getTime()) / 1000;

    if (isNaN(seconds)) return t("status.never_run");
    if (seconds < JUST_NOW_SECONDS) return t("status.last_test_now");

    return t("status.last_test", {time: generateRelativeTime(created)});
}

export const formatDuration = (seconds) =>
    typeof seconds === "number" && Number.isFinite(seconds) ? `${seconds}s` : NOT_MEASURED;

/**
 * A measurement with its unit, or a statement that there is none.
 *
 * The statistics return an explicit null for anything they could not compute -
 * every aggregate over a range in which no test succeeded - and rendering
 * `{value} {unit}` around that leaves a bare unit standing on its own.
 */
export const formatWithUnit = (value, unit) =>
    typeof value === "number" && Number.isFinite(value) ? `${value} ${unit}` : NOT_MEASURED;

// The ladder a byte count is stepped down, and the size of a step. Decimal
// rather than binary: the providers state their payloads in decimal - a "100 MB"
// Cloudflare payload is 100 000 000 bytes - so reporting 95.4 MiB for it would
// describe the transfer in a unit nobody involved used.
const BYTE_STEP = 1000;
const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

// One decimal from a kilobyte up. "1.1 GB" is as much precision as the figure
// supports; "1.136 GB" implies a count exact to the megabyte.
const BYTE_DECIMALS = 1;

/**
 * A quantity of data in the largest unit that leaves it readable.
 *
 * Whole bytes stay whole - "512 B" rather than "512.0 B" - because under a
 * kilobyte the decimal is noise.
 */
export const formatBytes = (bytes) => {
    if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return NOT_MEASURED;

    let value = bytes;
    let step = 0;

    // The figure as it will actually be printed. The ladder is climbed against
    // this rather than against the raw value: 999 999 999 divides to 999.999999
    // MB, which one decimal rounds to 1000.0 - a number that belongs in the next
    // unit, and printed with this one it reads "1000 MB". A gigabit line's
    // download lands in that band routinely.
    const printed = () => step === 0 ? value : parseFloat(value.toFixed(BYTE_DECIMALS));

    while (printed() >= BYTE_STEP && step < BYTE_UNITS.length - 1) {
        value /= BYTE_STEP;
        step++;
    }

    return `${printed()} ${BYTE_UNITS[step]}`;
};

export {SPEED_UNIT_MBPS, SPEED_UNIT_MBYTES, TIME_FORMAT_12H, TIME_FORMAT_24H};
