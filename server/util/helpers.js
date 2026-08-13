const pad = (n) => String(n).padStart(2, "0");

/**
 * The clock names every message may use, whatever the event.
 *
 * Exported so the interface can offer them beside the measurement names without
 * a second list to keep in step.
 */
export const DATE_VARIABLES = ["year", "month", "day", "hour", "minute", "second"];

const getDateVariables = () => {
    const now = new Date();
    return {
        year: now.getFullYear(),
        month: pad(now.getMonth() + 1),
        day: pad(now.getDate()),
        hour: pad(now.getHours()),
        minute: pad(now.getMinutes()),
        second: pad(now.getSeconds())
    };
};

/**
 * What an unmeasured value reads as inside a sentence.
 *
 * The payload carries an honest null - right for the webhook's JSON, where the
 * consumer wants to know the provider reported nothing - but substituted into a
 * message it renders as the word "null". "Ping: 12 ms (±null ms)" was already
 * going out for the providers that do not measure jitter, and a payload
 * carrying every column turns one such case into a dozen.
 */
const NOT_MEASURED = "N/A";

export const replaceVariables = (message, variables) => {
    const allVariables = {...getDateVariables(), ...variables};

    for (const variable in allVariables) {
        const value = allVariables[variable];

        // Nullish rather than falsy: zero is a measurement - a line that lost
        // no packets - and must not be swept in with what was never measured.
        message = message.replaceAll(`%${variable}%`, value ?? NOT_MEASURED);
    }

    return message;
};

/**
 * Removes trailing slashes from a URL.
 *
 * Deliberately not a regex: /\/+$/ backtracks polynomially, retrying the whole
 * run of slashes from every position, so a long enough value turns a single
 * request into a denial of service.
 */
export const stripTrailingSlashes = (value) => {
    const text = String(value ?? "");
    let end = text.length;

    while (end > 0 && text[end - 1] === "/") end--;

    return text.slice(0, end);
};

const UNKNOWN_ERROR = "Unknown error";

/**
 * Reduces anything that can be thrown to a string.
 *
 * A rejection reaches us as an Error, a plain {message} object or a bare
 * string, and the failed-test row stores the message in a TEXT column.
 * Sequelize validates that column with _.isObject(), so handing it an Error
 * throws a validation error on the very path meant to record the failure -
 * losing the test and the reason for it.
 */
export const toErrorMessage = (error) => {
    const message = error?.message ?? error;

    if (typeof message === "string") return message || UNKNOWN_ERROR;
    if (message === null || message === undefined) return UNKNOWN_ERROR;

    return String(message);
};

const AVG_DECIMALS = 2;

const EMPTY_RANGE = {min: null, max: null, avg: null};

// Math.min(...[]) is Infinity and 0/0 is NaN, both of which JSON.stringify
// silently turns into null. Returning explicit nulls keeps the value honest for
// in-process consumers such as the Prometheus exporter.
//
// Folded in a loop rather than spread into Math.min/Math.max: a spread puts
// every value onto the call stack, which throws RangeError somewhere above
// ~125k values - a range holding a year of five-minute tests - and took the
// whole statistics endpoint down with it.
const mapRange = (entries, type, averageOf) => {
    if (entries.length === 0) return {...EMPTY_RANGE};

    let min = Infinity;
    let max = -Infinity;
    let total = 0;

    for (const entry of entries) {
        const value = entry[type];
        if (value < min) min = value;
        if (value > max) max = value;
        total += value;
    }

    return {min, max, avg: averageOf(total / entries.length)};
};

export const mapFixed = (entries, type) =>
    mapRange(entries, type, (avg) => parseFloat(avg.toFixed(AVG_DECIMALS)));

export const mapRounded = (entries, type) => mapRange(entries, type, Math.round);