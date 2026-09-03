import { localWallClock, utcFromLocal, zoneFromOffset } from './timezone.js';

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
/*
 * The calendar day an instant falls on, in a given zone, as a carrier whose
 * UTC fields read back as that local day - and as the YYYY-MM-DD the range
 * parser takes.
 *
 * Both windows below are built the same way: shift the local calendar, then
 * hand the result back through parseDateRange so the ends are the zone's own
 * midnights rather than an arithmetic result. Written once, because these two
 * had the same walk and the same off-by-a-zone waiting in it.
 */
const localAnchor = (instant, zone) =>
    new Date(instant.getTime() - zone.offsetAt(instant) * MS_PER_MINUTE);

const dayString = (carrier) =>
    `${carrier.getUTCFullYear()}-${String(carrier.getUTCMonth() + 1).padStart(2, "0")}`
    + `-${String(carrier.getUTCDate()).padStart(2, "0")}`;

/**
 * How many calendar days a range covers, both ends included.
 *
 * Rounded rather than floored: a range runs to 23:59:59.999 of its last day, so
 * the difference is a day short of whole, and a boundary the clock crossed
 * makes it an hour short of that again.
 *
 * Counted in time lived, not in date labels, and across a date-line
 * redefinition the two part ways: a zone that jumps the line the way Samoa did
 * in 2011 strikes a whole date from its calendar, so a range whose labels span
 * seven dates holds six days of tests. Six is the answer on purpose - the
 * count sizes shiftedRange's comparison window, and a window is comparable by
 * the time it lived, the same reading truncateToElapsed cuts by. No zone in
 * today's tzdata has such a jump ahead of it; the fake-zone test pins the
 * choice so a real one arrives with the question already answered.
 *
 * Exported for that test alone, the way isPrimaryMember is.
 */
export const calendarDays = (from, to) => Math.round((to - from) / MS_PER_DAY);

/**
 * The same window, whole calendar months earlier.
 *
 * Calendar months rather than a fixed number of days, for the reason
 * previousRange walks the calendar: a month is not a fixed number of
 * milliseconds and neither is a year, so a comparison taken by subtraction
 * drifts a day per quarter and stops naming the period it was picked for.
 *
 * The length is never touched. That is the whole point of asking a reader how
 * far back to look rather than what to look at: two windows of the same length
 * are comparable, and a free pair of dates let "August so far" be compared
 * against all of 2025 - a question nobody asked, which the elapsed cut then
 * answered by quietly comparing against the first fortnight of January.
 */
export const shiftedRange = ({from, to}, months, {offsetMinutes, zone} = {}) => {
    const resolved = zone ? {valid: true, zone} : zoneFromOffset(offsetMinutes);
    if (!resolved.valid) return invalid(resolved.message);

    const days = calendarDays(from, to);
    const wall = localAnchor(from, resolved.zone);
    const month = wall.getUTCMonth() - months;

    /*
     * The thirty-first of March, a month back, is the thirty-first of February.
     * Clamped to the last day the target month has - day 0 of the month after
     * it - which is what every calendar keeps. Rolling over into March instead
     * would start the window in the month after the one the option names.
     */
    const lastOfMonth = new Date(Date.UTC(wall.getUTCFullYear(), month + 1, 0)).getUTCDate();
    const start = new Date(Date.UTC(wall.getUTCFullYear(), month,
        Math.min(wall.getUTCDate(), lastOfMonth)));

    /*
     * Only the start is shifted; the end is counted forward from it, so the
     * window is exactly as many days as the one it answers for.
     *
     * Shifting both ends independently would not be: August has thirty-one
     * days and February twenty-eight, so "six months earlier" over a whole
     * August would have compared thirty-one days against twenty-eight and
     * every count would have read low - which is the very fault the equal
     * length exists to end, reintroduced by the clamp meant to keep the
     * window inside its month. A window that runs a day or two past the end
     * of its month is the honest answer: it is the same span, that far back.
     */
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + days - 1);

    return parseDateRange(dayString(start), dayString(end), {zone: resolved.zone});
};

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

    const days = calendarDays(from, to);

    // The calendar day the range starts on, in the timezone that anchored it -
    // the UTC fields read the shifted instant back as that local day.
    const anchor = localAnchor(from, resolved.zone);
    const day = dayString;

    const previousTo = new Date(anchor);
    previousTo.setUTCDate(previousTo.getUTCDate() - 1);
    const previousFrom = new Date(anchor);
    previousFrom.setUTCDate(previousFrom.getUTCDate() - days);

    return parseDateRange(day(previousFrom), day(previousTo), {zone: resolved.zone});
};

// The calendar day a wall-clock carrier reads as, for counting whole local
// days between two instants without the hours taking part.
const wallDay = (carrier) => Date.UTC(carrier.getUTCFullYear(), carrier.getUTCMonth(), carrier.getUTCDate());

/**
 * The previous window, cut to what the range has actually lived through.
 *
 * A range that ends today has only run until now, while the window before it is
 * complete - so every count compared a part-week against a whole one and read
 * lower on every partial day. The cut is the same position in the previous
 * window: the day the range has reached, counted in calendar days from its
 * start, at the same time *lived* since that day's own local midnight. Not
 * "now minus so many milliseconds", which drifts by an hour across a daylight
 * saving boundary - the same reason previousRange walks the calendar.
 *
 * Lived time rather than now's wall clock, and only the transition days can
 * tell them apart. A wall clock measures the day only while the offset holds
 * still: with now inside the hour autumn repeats, 02:30 reads the same at
 * three and a half elapsed hours as it did at two and a half, so copying it
 * cut the previous window an hour short - and once the *earlier* day was the
 * one carrying the extra hour, the same copy cut it an hour long, for the
 * whole rest of that day. The elapsed offset from midnight is what the two
 * days agree on when the transition is the cut day's own, and on the other
 * 363 days it is the wall clock.
 *
 * It is not what they agree on when the shift sits earlier in the range. The
 * offset is measured against the day `now` is in and laid onto the cut day, so
 * a transition between those two days is counted by neither: Berlin, a range
 * of 2026-03-23 to 2026-04-05 read at 2026-03-30T10:00Z, has lived 179 hours
 * and is compared against a window covering 180. One hour in a window of days,
 * twice a year per zone, against a correction that would have to walk the
 * calendar between the days to find it - so it is recorded in the tests as a
 * limitation rather than fixed.
 *
 * Midnight itself is resolved by utcFromLocal on both sides, so a day that
 * starts inside a skipped or doubled hour - Santiago moves at exactly
 * midnight - is anchored by one rule, not two.
 *
 * Returns the window untouched when the range is fully in the past, and null
 * when none of it has happened yet - the range's own first instant included,
 * where zero elapsed days at a wall clock of midnight used to cut the window
 * to exactly nothing: a comparison over no time at all, carried to the page
 * as zero counts under a partial heading. There is nothing a comparison could
 * be about, and the caller answers "no comparison" rather than a window of no
 * width.
 */
/** The earliest of several instants, as a Date. */
const earliest = (...instants) => new Date(Math.min(...instants.map((at) => at.getTime())));

/**
 * The window, ending no later than an instant that has actually happened.
 *
 * One home for the cap, because both branches below need it and each had its
 * own idea of what "the end" was. Only an end that really moved is partial -
 * the same rule the elapsed cut keeps, for the same reason.
 */
const endingBy = (previous, to) => to.getTime() === previous.to.getTime()
    ? previous
    : {...previous, to, partial: true};

export const truncateToElapsed = (range, previous, now = new Date()) => {
    /*
     * Nothing of the comparison window has happened.
     *
     * Not reachable while `previous` was always previousRange's answer - a
     * window immediately before the range is finished whenever the range has
     * started - but a caller may name any window, and nothing upstream takes a
     * view on the future: parseCompareWindow and parseDateRange both accept a
     * date that has not arrived, and the picker's newest selectable day is
     * today, whose parsed end is tonight.
     */
    if (now <= previous.from) return null;

    /*
     * A finished range still cannot be compared against time that has not
     * happened. This branch returned `previous` untouched, which was right
     * while the only window it could be given was a finished one: a July day
     * compared against today reported the whole of today, twelve hours of
     * which had not occurred, with no partial flag - so the page printed the
     * plain sentence and every count read about half.
     */
    if (now >= range.to) return endingBy(previous, earliest(previous.to, now));

    // `<=`, not `<`: the range's exact first instant has zero elapsed time,
    // and the arithmetic below would dutifully cut the window to zero width.
    if (now <= range.from) return null;

    const zone = previous.zone;
    const nowWall = localWallClock(zone, now);

    const daysElapsed = Math.round((wallDay(nowWall) - wallDay(localWallClock(zone, range.from))) / MS_PER_DAY);

    const startWall = localWallClock(zone, previous.from);
    const cutDay = new Date(Date.UTC(startWall.getUTCFullYear(), startWall.getUTCMonth(),
        startWall.getUTCDate() + daysElapsed));

    // The first instant of a wall day, as the zone actually lived it.
    const midnightOf = (day) => utcFromLocal(zone, {
        year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(),
        hour: 0, minute: 0, second: 0, ms: 0
    });

    // The same time lived since local midnight, not the same wall clock - the
    // docblock above says why only the transition days can tell them apart.
    const cut = new Date(midnightOf(cutDay).getTime()
        + (now.getTime() - midnightOf(new Date(wallDay(nowWall))).getTime()));

    /*
     * Bounded by the cut day's own end. Once the fall-back day has lived past
     * twenty-four hours, the elapsed offset is longer than the plain day it is
     * laid onto: unbounded, the cut spilled into the next day of the window,
     * and the day rollover at the following local midnight then snapped it
     * back an hour - so a page refreshed across midnight watched its
     * comparison shrink. The extra hour has no counterpart on the earlier day;
     * the cut holds at that day's end, which is exactly where the rollover
     * resumes, so the end of the window never moves backwards.
     */
    const dayEnd = midnightOf(new Date(Date.UTC(cutDay.getUTCFullYear(), cutDay.getUTCMonth(),
        cutDay.getUTCDate() + 1)));

    // The clamp is for a final day now has lived longer than the cut day
    // holds - the last hour of the 25-hour day autumn makes has no counterpart
    // on a plain one - and, since a caller may name a comparison window of
    // its own length, for one that simply ends before the elapsed offset. `now`
    // is in the same list because a named window can sit ahead of the range it
    // is compared against, where the elapsed offset lands in the future.
    //
    // Only a cut that actually moved the end is a partial window. A window
    // shorter than the elapsed offset is answered with the whole of itself,
    // which it is - and calling that "up to the same time of day" puts the
    // partial sentence under a comparison that covers all of its own window.
    return endingBy(previous, earliest(cut, dayEnd, previous.to, now));
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
