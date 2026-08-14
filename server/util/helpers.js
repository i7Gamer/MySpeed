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

/**
 * A name as a template spells it. `\w` covers every key the payload and the
 * clock offer, all of which are column names.
 */
const VARIABLE_TOKEN = /%(\w+)%/g;

/**
 * Fills the %names% in a message from the values it is given.
 *
 * One pass with a replacer function rather than a replaceAll per name, which
 * got two things wrong once the payload grew past the five numbers it used to
 * carry - it now holds the server's name and location, the ISP, the external
 * address and the failure reason, all of them text a remote provider chose:
 *
 * - replaceAll's *string* replacement honours `$&`, `` $` ``, `$'` and `$$`, so
 *   a server called "ACME $& Co" wrote the placeholder itself back into the
 *   message that went out. A replacer function is handed the text verbatim.
 * - Replacing the names one after another meant a value written early that
 *   happened to spell a later name was replaced again on that name's turn - a
 *   server named "%isp%" had the ISP written into it. A single pass never
 *   revisits what it has already written.
 */
export const replaceVariables = (message, variables) => {
    const allVariables = {...getDateVariables(), ...variables};

    return message.replace(VARIABLE_TOKEN, (token, name) => {
        // A name nothing was given for is left standing, as it always was: the
        // failure template may mention a measurement no failure carries.
        if (!Object.hasOwn(allVariables, name)) return token;

        // Nullish rather than falsy: zero is a measurement - a line that lost
        // no packets - and must not be swept in with what was never measured.
        return String(allVariables[name] ?? NOT_MEASURED);
    });
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
    let min = Infinity;
    let max = -Infinity;
    let total = 0;
    let counted = 0;

    for (const entry of entries) {
        const value = entry[type];

        // A measurement that is absent is not a measurement of nought. `time`
        // is nullable in the model and is the one column handed here
        // unfiltered, and a null took the range apart in both directions: it
        // latched into `min`, since `null < Infinity` holds and nothing later
        // displaces it - every comparison against null coerces it to 0, so no
        // real value is ever smaller - while adding nothing to the total and
        // still counting toward the divisor. A measured 0 is a real reading and
        // is not what this skips.
        if (value === null || value === undefined) continue;

        if (value < min) min = value;
        if (value > max) max = value;
        total += value;
        counted++;
    }

    // Nothing measured at all, whether the set was empty or held only absences.
    if (counted === 0) return {...EMPTY_RANGE};

    return {min, max, avg: averageOf(total / counted)};
};

export const mapFixed = (entries, type) =>
    mapRange(entries, type, (avg) => parseFloat(avg.toFixed(AVG_DECIMALS)));

export const mapRounded = (entries, type) => mapRange(entries, type, Math.round);