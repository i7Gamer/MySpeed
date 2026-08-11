const MINUTES_PER_HOUR = 60;
const MS_PER_MINUTE = 60 * 1000;

// Widest real-world UTC offsets are UTC-12 (+720) and UTC+14 (-840).
export const MAX_OFFSET_MINUTES = 14 * MINUTES_PER_HOUR;

/**
 * The clock a request is answered on.
 *
 * A client used to send only `tzOffset`, its `getTimezoneOffset()` at the
 * moment of the request. That is a snapshot of *today*, and a range routinely
 * reaches back across a daylight saving change: applied to the whole window it
 * anchors the far end an hour off its real local midnight - silently dropping
 * or adding an hour of tests from every aggregate - and it credits every test
 * on the other side of the transition to the wrong hour of the day, which is
 * enough for the overview to name the wrong hour as the slowest.
 *
 * A named IANA zone is resolved per instant instead, so both follow the
 * transition. The offset is still accepted: a parent proxies these requests to
 * its nodes, and a node running an older version understands only that.
 *
 * A zone is an object with `offsetAt(instant)`, in getTimezoneOffset's sign -
 * minutes *behind* UTC, so UTC+2 is -120.
 */
const partFormat = {
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
};

// Building an Intl.DateTimeFormat is expensive and the statistics path resolves
// an offset once per stored test.
const formatters = new Map();

const formatterFor = (timeZone) => {
    let formatter = formatters.get(timeZone);

    if (formatter === undefined) {
        formatter = new Intl.DateTimeFormat("en-US", {timeZone, ...partFormat});
        formatters.set(timeZone, formatter);
    }

    return formatter;
};

export const isKnownTimeZone = (name) => {
    if (typeof name !== "string" || name.trim() === "") return false;

    try {
        formatterFor(name);
        return true;
    } catch {
        return false;
    }
};

const namedOffsetAt = (timeZone, instant) => {
    const parts = {};
    for (const {type, value} of formatterFor(timeZone).formatToParts(instant)) parts[type] = value;

    // What the zone's wall clock reads, treated as if it were UTC. The gap
    // between that and the instant itself is the offset.
    const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
        Number(parts.hour), Number(parts.minute), Number(parts.second));

    return -Math.round((asUtc - instant.getTime()) / MS_PER_MINUTE);
};

/** The server's own clock, which is UTC in the Docker image. */
export const serverZone = {name: null, offsetAt: (instant) => instant.getTimezoneOffset()};

const fixedZone = (offsetMinutes) => ({name: null, offsetAt: () => offsetMinutes});

const namedZone = (timeZone) => ({name: timeZone, offsetAt: (instant) => namedOffsetAt(timeZone, instant)});

const empty = (value) => value === undefined || value === null || value === "";

/**
 * A zone from a bare offset.
 *
 * A value that is not a number is not a claim about a timezone, so the server
 * answers on its own clock rather than refusing - long-standing behaviour, and
 * what keeps a caller that sends nothing meaningful working. One that *is* a
 * number but names no place on earth is a different matter and is refused.
 */
export const zoneFromOffset = (offsetMinutes) => {
    if (empty(offsetMinutes)) return {valid: true, zone: serverZone};

    const offset = Number(offsetMinutes);
    if (!Number.isFinite(offset)) return {valid: true, zone: serverZone};

    if (Math.abs(offset) > MAX_OFFSET_MINUTES)
        return {valid: false, message: "The 'tzOffset' parameter is outside the valid range"};

    return {valid: true, zone: fixedZone(offset)};
};

export const resolveTimezone = ({tz, tzOffset} = {}) => {
    if (!empty(tz)) {
        if (!isKnownTimeZone(tz))
            return {valid: false, message: "The 'tz' parameter is not a known IANA time zone"};

        return {valid: true, zone: namedZone(tz)};
    }

    return zoneFromOffset(tzOffset);
};

/**
 * The UTC instant at which a zone's wall clock reads the given local time.
 *
 * An offset can only be read *at* an instant, and the only instant to start
 * from is the wall-clock reading treated as UTC - which is out by the offset
 * itself. So each candidate is checked against its own offset rather than
 * against the guess that produced it: reading the offset at the guess and
 * trusting it put the midnight of a zone that moves its clocks at midnight an
 * hour into the *previous* day, which swept an hour of its tests into the range.
 *
 * When neither candidate agrees with itself, the wall clock never read this at
 * all - the hour was skipped. The later instant is the first one that did
 * happen, which is what every date library answers for a time that never was.
 */
export const utcFromLocal = (zone, {year, month, day, hour = 0, minute = 0, second = 0, ms = 0}) => {
    const local = Date.UTC(year, month - 1, day, hour, minute, second, ms);

    const firstOffset = zone.offsetAt(new Date(local));
    const first = local + firstOffset * MS_PER_MINUTE;
    if (zone.offsetAt(new Date(first)) === firstOffset) return new Date(first);

    // Ambiguous times - the hour a zone repeats when its clocks go back - settle
    // here, on the first reading, which is the earlier of the two.
    const alternateOffset = zone.offsetAt(new Date(first));
    const alternate = local + alternateOffset * MS_PER_MINUTE;
    if (zone.offsetAt(new Date(alternate)) === alternateOffset) return new Date(alternate);

    return new Date(Math.max(first, alternate));
};

/** The hour of the day an instant falls in, on the zone's wall clock. */
export const localHourAt = (zone, instant) =>
    new Date(instant.getTime() - zone.offsetAt(instant) * MS_PER_MINUTE).getUTCHours();
