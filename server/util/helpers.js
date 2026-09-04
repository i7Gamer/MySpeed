import fs from 'node:fs';
// From metricValue.js, the dependency-free leaf, not from testOutcome.js:
// this file's string helpers are imported by every integration, and the
// testOutcome door would drag sequelize along with them.
import { usableFigure } from './metricValue.js';
// A leaf of its own: timezone.js imports nothing from the app, so the clock
// the message templates are rendered on costs the notifiers nothing either.
import { localWallClock, serverZone } from './timezone.js';

const pad = (n) => String(n).padStart(2, "0");

/**
 * Writes beside the target and renames into place, which is atomic on the same
 * filesystem.
 *
 * A plain write leaves a truncated file behind when the process is stopped part
 * way through it, and a reader is then holding something it cannot parse. The
 * server lists are the case: they are downloaded during boot, which is exactly
 * when a container is most likely to be restarted, and controller/servers.js
 * answered three request paths out of whatever was left. Renaming means a
 * reader sees either the previous file or the new one and never half of one.
 */
export const writeAtomically = (file, contents) => {
    const temporary = `${file}.${process.pid}.tmp`;

    try {
        fs.writeFileSync(temporary, contents);
        fs.renameSync(temporary, file);
    } catch (error) {
        // The half-written temporary is this function's to clear up: left
        // behind it is never read, but it is never removed either.
        fs.rmSync(temporary, {force: true});
        throw error;
    }
};

/**
 * The clock names every message may use, whatever the event.
 *
 * Exported so the interface can offer them beside the measurement names without
 * a second list to keep in step.
 */
export const DATE_VARIABLES = ["year", "month", "day", "hour", "minute", "second"];

/**
 * The six of them, on the clock the instance keeps rather than the one the
 * process happens to run on.
 *
 * They were built from `new Date().getHours()` and its siblings, which is the
 * host clock - while the schedule, the digests, the quiet hours and the
 * /status countdown all resolve the stored `timezone` setting. That setting
 * exists because the Docker image pins `ENV TZ=Etc/UTC`, so on a Berlin
 * instance every one of those surfaces said 11:14 and the notification said
 * 09:14, for the same test, using a chip the dialog itself offers.
 *
 * Through localWallClock and the UTC getters, exactly as digestReport's
 * localParts builds the date it names a period by: the returned Date is a
 * carrier for those fields and not a moment in time, which is why nothing here
 * stores it.
 */
const getDateVariables = (zone) => {
    const wall = localWallClock(zone, new Date());

    return {
        year: wall.getUTCFullYear(),
        month: pad(wall.getUTCMonth() + 1),
        day: pad(wall.getUTCDate()),
        hour: pad(wall.getUTCHours()),
        minute: pad(wall.getUTCMinutes()),
        second: pad(wall.getUTCSeconds())
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
 *
 * The zone comes third and last, behind the two parameters every call site
 * already passes, because tests/server/templateVariableOffers.test.js reads
 * these calls to pair a substituting field with the chips the dialog offers
 * for it - and a zone in front of them is a scan that matches nothing, which
 * fails that assertion and turns the two beside it vacuously green.
 *
 * It defaults to the host's own clock, which is what the six parts were built
 * from before: localWallClock(serverZone, now) shifts by exactly the offset
 * getHours() would have applied, so a call site that has not been given a zone
 * renders precisely what it always did rather than half of the fix.
 *
 * Deliberately not async, and deliberately not reading the setting itself. The
 * zone is resolved once per event at the dispatch point - triggerEvent, which
 * is already async and is already where the per-recipient alert passages are
 * filled in - and handed down. An async reader here would hand every
 * `balancedForTelegram(replaceVariables(...))` a promise instead of a message.
 */
export const replaceVariables = (message, variables, zone = serverZone) => {
    const allVariables = {...getDateVariables(zone), ...variables};

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

/**
 * What a header value is allowed to be.
 *
 * Free text from an integration form goes into headers verbatim, so anything
 * undici refuses is a notification that never leaves the process - the poster
 * catches the throw, logs it and answers null, while the integration goes on
 * showing as configured.
 *
 * Two things are refused, not one. A line break, because a value split across
 * lines is also how a request smuggles a second header in. And any code point
 * above U+00FF, because a header is Latin-1 on the wire - which matters more in
 * practice than the newline did: ntfy's own documentation shows emoji titles,
 * and a Cyrillic or CJK instance name is entirely ordinary. Dropping those
 * characters costs a nicer-looking title; keeping them cost the whole message.
 *
 * The bounds are written as escapes rather than as the characters themselves.
 * Spelling the upper bound literally is how this class first ended up holding a
 * stray byte instead of the intended one - which git read as binary, and which
 * nothing else caught because the resulting range still behaved.
 *
 * Here rather than in ntfy, where it was written, because the credentials go
 * through it too now and two integrations need the same rule.
 *
 * DEL (0x7F) is refused as well: it sits inside Latin-1 and node refuses to
 * write it - res.setHeader throws ERR_INVALID_CHAR and the outbound client
 * refuses the value - so one such byte in a title or a token failed the
 * whole request rather than losing the byte.
 */
const HEADER_SAFE = /[^\x20-\x7E\x80-\xFF]/g;

export const headerSafe = (value) => String(value)
    .replace(/[\r\n]+/g, " ")
    .replace(HEADER_SAFE, "");

/**
 * A host as a socket can dial it: the brackets an IPv6 literal wears in a URL
 * taken off again.
 *
 * `[fd00::1]` is how an address is written in a URL, and it is the spelling an
 * operator copies out of one - so the SMTP and MQTT host fields accept it, and
 * the outbound guard strips the brackets before judging it. The dialers did
 * not: net.connect({host: "[fd00::1]"}) resolves the brackets as part of a
 * name, finds nothing, and every notification is lost to a getaddrinfo failure
 * on a value the interface said was fine. A hostname or a bare address passes
 * through untouched.
 */
export const bareHost = (value) => String(value ?? "").replace(/^\[|]$/g, "");

/**
 * The mark a cut message ends in, so that a trimmed one is visibly incomplete
 * rather than reading as the whole of what was said.
 */
const TRUNCATION_MARK = "…";

/**
 * Cuts text to a limit, and says that it did.
 *
 * Two things bound this text and neither trusts the other: what the database
 * column will hold (cliOutput caps a failure reason at MAX_ERROR_LENGTH) and
 * what a provider will accept (pushover refuses a message over 1024 characters
 * with a 400, so the failures with the most to say were the ones that never
 * arrived). They are different limits applied at different points, which is why
 * this is a parameter rather than a constant - but the cut itself is one rule
 * and was written out twice.
 */
export const truncate = (text, limit) => {
    const value = String(text);

    if (value.length <= limit) return value;

    // No room for the mark itself, so there is nothing honest to return but
    // nothing. Flooring the slice at zero was not enough: it still appended the
    // mark, so a limit of none produced one character. A bound that can be
    // exceeded by asking for less is not a bound.
    if (limit < TRUNCATION_MARK.length) return "";

    return value.slice(0, limit - TRUNCATION_MARK.length) + TRUNCATION_MARK;
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

const EMPTY_RANGE = {min: null, max: null, avg: null, median: null};

/**
 * The middle of the measured values, which the average is not: one spike moves
 * a mean and leaves a median standing.
 *
 * Sorts the array it is handed - mapRange builds it privately for exactly this.
 * Passed through the same rounding as the average, whatever the count's
 * parity: the two middles of an even count make it a derived figure, and a
 * precision that changed with the parity would read as noise.
 */
const medianOf = (values, averageOf) => {
    values.sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);

    return averageOf(values.length % 2 === 1
        ? values[middle]
        : (values[middle - 1] + values[middle]) / 2);
};

// Math.min(...[]) is Infinity and 0/0 is NaN, both of which JSON.stringify
// silently turns into null. Returning explicit nulls keeps the value honest for
// in-process consumers such as the Prometheus exporter.
//
// Folded in a loop rather than spread into Math.min/Math.max: a spread puts
// every value onto the call stack, which throws RangeError somewhere above
// ~125k values - a range holding a year of five-minute tests - and took the
// whole statistics endpoint down with it.
// `read` is the column's own judgement of what counts as a reading.
// usableFigure is the default: it reads the defensive numeric-string spelling
// and refuses junk and the negative placeholders alike, so the next column
// handed here raw is safe by default - under the old metricValue default,
// which keeps -1 for its Prometheus caller to judge, a caller that forgot to
// pass a stricter reader printed "min -1 Mbit/s" on the range card. A column
// with a different rule still passes its own reader.
const mapRange = (entries, type, averageOf, read = usableFigure) => {
    let min = Infinity;
    let max = -Infinity;
    let total = 0;
    let counted = 0;
    const values = [];

    for (const entry of entries) {
        // A measurement that is absent is not a measurement of nought. `time`
        // is nullable in the model and is the one column handed here
        // unfiltered, and a null took the range apart in both directions: it
        // latched into `min`, since `null < Infinity` holds and nothing later
        // displaces it - every comparison against null coerces it to 0, so no
        // real value is ever smaller - while adding nothing to the total and
        // still counting toward the divisor. A measured 0 is a real reading and
        // is not what this skips.
        //
        // A shared reader rather than a bare finite check. The corruption
        // storage actually delivers is non-numeric text - a junk string like
        // "NaN" quietly turned the average to NaN, and the sort comparator
        // answers NaN around it, so one that landed mid-sample was handed to
        // toFixed by the median: a TypeError that took the whole statistics
        // endpoint down over one bad row. The reader refuses exactly that,
        // and reads a *numeric* string as the number it spells - a defensive
        // half no current row exercises (both backends coerce well-formed
        // digits at write for these DOUBLE columns), kept because it is the
        // judgement every other consumer of these columns shares, and a
        // second predicate here is how one row answered two surfaces
        // differently. Read the one, refuse the other.
        const value = read(entry[type]);
        if (value === null) continue;

        if (value < min) min = value;
        if (value > max) max = value;
        total += value;
        counted++;
        values.push(value);
    }

    // Nothing measured at all, whether the set was empty or held only absences.
    if (counted === 0) return {...EMPTY_RANGE};

    return {min, max, avg: averageOf(total / counted), median: medianOf(values, averageOf)};
};

export const mapFixed = (entries, type, read) =>
    mapRange(entries, type, (avg) => parseFloat(avg.toFixed(AVG_DECIMALS)), read);

export const mapRounded = (entries, type, read) => mapRange(entries, type, Math.round, read);