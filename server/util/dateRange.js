const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const MINUTES_PER_HOUR = 60;
const MS_PER_MINUTE = 60 * 1000;

// Widest real-world UTC offsets are UTC-12 (+720) and UTC+14 (-840).
const MAX_OFFSET_MINUTES = 14 * MINUTES_PER_HOUR;

// Matches the largest retention period the config accepts, so no range that
// could contain data is ever refused. Without a ceiling, from=0001-01-01 to
// 9999-12-31 was a valid request that walked the whole table.
const MAX_RANGE_DAYS = 10000;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const LAST_HOUR = 23;
const LAST_MINUTE = 59;
const LAST_SECOND = 59;
const LAST_MILLISECOND = 999;

const invalid = (message) => ({valid: false, message});

// Rejects values that look like a date but are not one (2026-13-01, 2026-02-29,
// 2026-04-31). A bare regex lets these through and `new Date` silently rolls
// them over into a different month, quietly returning the wrong window.
const toCalendarParts = (value) => {
    const [year, month, day] = value.split("-").map(Number);
    const probe = new Date(year, month - 1, day);

    if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day)
        return null;

    return {year, month, day};
};

/**
 * Parses and validates a `from`/`to` day range.
 *
 * The range covers the whole of both days. When `offsetMinutes` is supplied it
 * is interpreted like `Date.prototype.getTimezoneOffset` (minutes *behind* UTC,
 * so UTC+2 is -120) and the window is anchored to the client's day rather than
 * the server's, which otherwise disagree whenever the two run in different
 * timezones - the default for the Docker image, which pins TZ=Etc/UTC.
 *
 * @returns {{valid: true, from: Date, to: Date}|{valid: false, message: string}}
 */
export const parseDateRange = (from, to, {offsetMinutes} = {}) => {
    if (!from || !to) return invalid("Both 'from' and 'to' date parameters are required");

    if (!DATE_PATTERN.test(from)) return invalid("Invalid 'from' date format. Use YYYY-MM-DD");
    if (!DATE_PATTERN.test(to)) return invalid("Invalid 'to' date format. Use YYYY-MM-DD");

    const fromParts = toCalendarParts(from);
    if (fromParts === null) return invalid("The 'from' value is not a real calendar date");

    const toParts = toCalendarParts(to);
    if (toParts === null) return invalid("The 'to' value is not a real calendar date");

    const offset = Number(offsetMinutes);
    const useOffset = offsetMinutes !== undefined && offsetMinutes !== null
        && offsetMinutes !== "" && Number.isFinite(offset);

    if (useOffset && Math.abs(offset) > MAX_OFFSET_MINUTES)
        return invalid("The 'tzOffset' parameter is outside the valid range");

    const start = useOffset
        ? new Date(Date.UTC(fromParts.year, fromParts.month - 1, fromParts.day) + offset * MS_PER_MINUTE)
        : new Date(fromParts.year, fromParts.month - 1, fromParts.day, 0, 0, 0, 0);

    const end = useOffset
        ? new Date(Date.UTC(toParts.year, toParts.month - 1, toParts.day,
            LAST_HOUR, LAST_MINUTE, LAST_SECOND, LAST_MILLISECOND) + offset * MS_PER_MINUTE)
        : new Date(toParts.year, toParts.month - 1, toParts.day,
            LAST_HOUR, LAST_MINUTE, LAST_SECOND, LAST_MILLISECOND);

    if (start > end) return invalid("The 'from' date must be before the 'to' date");

    if ((end - start) / MS_PER_DAY > MAX_RANGE_DAYS)
        return invalid(`The range must not span more than ${MAX_RANGE_DAYS} days`);

    return {valid: true, from: start, to: end};
};
