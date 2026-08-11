import { utcFromLocal, zoneFromOffset } from './timezone.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const MS_PER_MINUTE = 60 * 1000;

// Matches the largest retention period the config accepts, so no range that
// could contain data is ever refused. Without a ceiling, from=0001-01-01 to
// 9999-12-31 was a valid request that walked the whole table.
const MAX_RANGE_DAYS = 10000;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The value of `?range=` that asks for every test there is.
 *
 * Named rather than expressed as a window wide enough to hold anything the
 * server keeps: the charts bucket over the range they are asked for, and a
 * quarter of a century of buckets draws a year of tests as a handful of points.
 */
export const ALL_TIME_RANGE = "all";

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
/**
 * The window a range is compared against: the same span, immediately before it.
 *
 * Computed in calendar days rather than by subtracting milliseconds. A range is
 * inclusive of both its days, so "last 7 days" covers 7 calendar days and its
 * predecessor must be the 7 calendar days before that - a millisecond
 * subtraction drifts by an hour across a daylight saving boundary and quietly
 * compares six days and 23 hours against seven. Walking back through the
 * calendar and re-parsing anchors both windows to the same midnight, the
 * viewer's own when an offset was sent.
 */
export const previousRange = ({from, to}, {offsetMinutes, zone} = {}) => {
    const resolved = zone ? {valid: true, zone} : zoneFromOffset(offsetMinutes);
    if (!resolved.valid) return invalid(resolved.message);

    const days = Math.round((to - from) / MS_PER_DAY);

    // The calendar day the range starts on, in the timezone that anchored it -
    // the UTC fields read the shifted instant back as that local day.
    const anchor = new Date(from.getTime() - resolved.zone.offsetAt(from) * MS_PER_MINUTE);

    const day = (date) => {
        const shifted = new Date(date);
        return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
    };

    const previousTo = new Date(anchor);
    previousTo.setUTCDate(previousTo.getUTCDate() - 1);
    const previousFrom = new Date(anchor);
    previousFrom.setUTCDate(previousFrom.getUTCDate() - days);

    return parseDateRange(day(previousFrom), day(previousTo), {zone: resolved.zone});
};

export const parseDateRange = (from, to, {offsetMinutes, zone} = {}) => {
    if (!from || !to) return invalid("Both 'from' and 'to' date parameters are required");

    if (!DATE_PATTERN.test(from)) return invalid("Invalid 'from' date format. Use YYYY-MM-DD");
    if (!DATE_PATTERN.test(to)) return invalid("Invalid 'to' date format. Use YYYY-MM-DD");

    const fromParts = toCalendarParts(from);
    if (fromParts === null) return invalid("The 'from' value is not a real calendar date");

    const toParts = toCalendarParts(to);
    if (toParts === null) return invalid("The 'to' value is not a real calendar date");

    // Each bound is anchored at its own offset. A single offset for the whole
    // window is a snapshot of one day, and any range reaching across a daylight
    // saving change has one end an hour off its real local midnight.
    const resolved = zone ? {valid: true, zone} : zoneFromOffset(offsetMinutes);
    if (!resolved.valid) return invalid(resolved.message);

    // Each end takes its own reading of an hour the clocks repeated: the first
    // for the start, the last for the end, so the whole of the doubled hour
    // falls inside the range rather than half of it.
    const start = utcFromLocal(resolved.zone, fromParts);

    const end = utcFromLocal(resolved.zone, {
        ...toParts,
        hour: LAST_HOUR, minute: LAST_MINUTE, second: LAST_SECOND, ms: LAST_MILLISECOND
    }, {prefer: "latest"});

    if (start > end) return invalid("The 'from' date must be before the 'to' date");

    /**
     * Counted in calendar days, not in milliseconds.
     *
     * Anchoring each bound at its own offset means the span between them is no
     * longer a whole number of days - a window whose ends sit at different
     * offsets measures an hour more or less. Measured in milliseconds that hour
     * pushed the client's all-time stand-in window, which is deliberately
     * exactly MAX_RANGE_DAYS wide, over the limit: every all-time export was
     * refused for roughly a third of the year in any zone that has ever
     * shifted. The same hour ceiled the echoed day count to one too many for a
     * range crossing a fall-back, so the overview divided its total by eight
     * days under a heading naming seven.
     *
     * Both are questions about the calendar rather than about elapsed time, and
     * no offset can move the answer.
     */
    const days = Math.round((Date.UTC(toParts.year, toParts.month - 1, toParts.day)
        - Date.UTC(fromParts.year, fromParts.month - 1, fromParts.day)) / MS_PER_DAY) + 1;

    if (days > MAX_RANGE_DAYS)
        return invalid(`The range must not span more than ${MAX_RANGE_DAYS} days`);

    // The zone travels with the range: previousRange has to anchor its window
    // the same way, and the statistics bucket by the same clock. So does the
    // day count, which the statistics echo for the client to divide by.
    return {valid: true, from: start, to: end, zone: resolved.zone, days};
};
