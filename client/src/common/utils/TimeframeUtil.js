export const TIMEFRAME_CUSTOM = "custom";

export const DEFAULT_TIMEFRAME = "7d";

const DAYS_PER_YEAR = 365;

/**
 * The bounded timeframes: every preset that resolves to a concrete window.
 *
 * `labelKey` deliberately points at translation keys that already ship in every
 * locale, so adding the picker needs no new Crowdin strings.
 */
export const TIMEFRAMES = [
    {id: "7d", days: 7, labelKey: "calendar.last_7_days"},
    {id: "30d", days: 30, labelKey: "calendar.last_30_days"},
    {id: "90d", days: 90, labelKey: "calendar.last_90_days"},
    {id: "1y", days: DAYS_PER_YEAR, labelKey: "calendar.last_year"}
];

export const TIMEFRAME_ALL = "all";

/**
 * The way back to the full history.
 *
 * Both pages of test data can show every test they have, so a picker that could
 * only narrow them would make choosing "Last 7 days" once a one-way door.
 * Deliberately not a member of TIMEFRAMES: that list is what the range
 * arithmetic below answers for, and "no range at all" has no span to resolve.
 */
export const ALL_TIME_PRESET = {id: TIMEFRAME_ALL, labelKey: "calendar.all_time"};

/** What the date picker offers, on every page that carries one. */
export const PICKER_TIMEFRAMES = [ALL_TIME_PRESET, ...TIMEFRAMES];

export const isAllTime = (timeframe) => timeframe === TIMEFRAME_ALL;

/**
 * The name the picker's trigger wears for a selection, or null when the
 * concrete dates are the honest label.
 *
 * A chosen preset names itself: "Last 7 days" says more than the two dates it
 * happens to resolve to today, and stays true tomorrow, when those dates no
 * longer would be. All time always worked this way - it has no dates to fall
 * back to - while the bounded presets used to show their resolved window. Only
 * a custom range has nothing truer to say than its dates.
 */
export const timeframeLabelKey = (timeframe) =>
    PICKER_TIMEFRAMES.find((preset) => preset.id === timeframe)?.labelKey ?? null;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const findTimeframe = (id) => TIMEFRAMES.find(frame => frame.id === id) ?? null;

const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

/**
 * All-time expressed as a concrete range, for the callers that need one.
 *
 * The list omits the filter entirely rather than using this, and the statistics
 * ask for all time by name - "everything" is the absence of a bound, not a very
 * wide one. Two callers still need a window: the export endpoint takes one, and
 * a node running a version that predates the named range understands only
 * from/to. The server refuses any span wider than its own MAX_RANGE_DAYS, which
 * it sets to the largest retention period the config accepts, so a window that
 * wide provably contains every test that can still exist while remaining a
 * request it will answer.
 */
const ALL_TIME_SPAN_DAYS = 10000;

export const resolveAllTime = (now = new Date()) => {
    const to = startOfDay(now);
    const from = startOfDay(now);
    from.setDate(from.getDate() - (ALL_TIME_SPAN_DAYS - 1));

    return {from, to};
};

/** Formats a date as YYYY-MM-DD using local calendar fields, never UTC. */
export const formatDateParam = (date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
};

/** Parses a YYYY-MM-DD string, rejecting anything that is not a real date. */
const parseDay = (value) => {
    if (!value || !DATE_PATTERN.test(value)) return null;

    const [year, month, day] = value.split("-").map(Number);
    const parsed = new Date(year, month - 1, day);

    if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day)
        return null;

    return parsed;
};

/**
 * Turns a preset id into a concrete range ending today.
 *
 * The span is inclusive of both ends, so "Last 7 days" really covers 7 calendar
 * days. Unknown ids fall back to the default preset.
 */
export const resolveTimeframe = (id, now = new Date()) => {
    const frame = findTimeframe(id) ?? findTimeframe(DEFAULT_TIMEFRAME);

    const to = startOfDay(now);
    const from = startOfDay(now);
    from.setDate(from.getDate() - (frame.days - 1));

    return {from, to};
};

/** Identifies which preset a range corresponds to, or custom if none matches. */
export const timeframeFromRange = (from, to, now = new Date()) => {
    if (!from || !to) return TIMEFRAME_CUSTOM;

    const match = TIMEFRAMES.find(frame => {
        const preset = resolveTimeframe(frame.id, now);
        return formatDateParam(preset.from) === formatDateParam(from)
            && formatDateParam(preset.to) === formatDateParam(to);
    });

    return match?.id ?? TIMEFRAME_CUSTOM;
};

/**
 * A preset id as a selection.
 *
 * All time carries no dates at all: resolving it like a bounded preset would
 * quietly show a week under an "All time" label.
 */
export const selectionOf = (timeframe, now = new Date()) =>
    isAllTime(timeframe)
        ? {timeframe, from: null, to: null}
        : {timeframe, ...resolveTimeframe(timeframe, now)};

/**
 * Reads a timeframe out of the URL.
 *
 * Accepts either `?range=<preset>` or `?from=&to=`. Returns null when nothing
 * usable is present, letting the caller fall back to the stored preference.
 */
export const parseRangeParams = (searchParams, now = new Date()) => {
    // Ahead of the dates, which may travel beside it: the statistics send a
    // stand-in window for an older node, and reading that back would turn "all
    // time" into a very specific quarter of a century.
    if (isAllTime(searchParams.get("range"))) return selectionOf(TIMEFRAME_ALL, now);

    const frame = findTimeframe(searchParams.get("range"));
    if (frame) return {timeframe: frame.id, ...resolveTimeframe(frame.id, now)};

    const from = parseDay(searchParams.get("from"));
    const to = parseDay(searchParams.get("to"));
    if (!from || !to) return null;

    const [start, end] = from > to ? [to, from] : [from, to];
    return {timeframe: timeframeFromRange(start, end, now), from: start, to: end};
};

/** Builds the query parameters describing the current selection. */
export const serializeRange = (timeframe, from, to) => {
    // Named rather than written as dates it does not have. The statistics need
    // it in the URL because a bare URL there means the stored preference.
    if (isAllTime(timeframe)) return {range: TIMEFRAME_ALL};
    if (findTimeframe(timeframe)) return {range: timeframe};
    return {from: formatDateParam(from), to: formatDateParam(to)};
};

/**
 * The window a page of statistics is actually showing.
 *
 * A bounded selection is its own window. All time has none of its own, so the
 * server echoes the extent of the tests themselves - the first to the last -
 * and that is what the headings are named after. The stand-in window is the
 * fallback for a node too old to echo anything, whose payload would otherwise
 * render as "Invalid Date".
 */
export const shownRange = (dateRange, statistics, now = new Date()) => {
    if (dateRange) return dateRange;

    const echoed = statistics?.dateRange;
    if (!echoed?.from || !echoed?.to) return resolveAllTime(now);

    return {from: new Date(echoed.from), to: new Date(echoed.to)};
};

/**
 * Reads the overview's selection out of the URL, defaulting to all time.
 *
 * The overview keeps its range in the URL for the same reason the statistics
 * do - a view stays bookmarkable and shareable - but a bare URL has to mean
 * all time here rather than the statistics' seven days, or merely opening the
 * page would hide most of the history.
 */
export const selectionFromParams = (searchParams, now = new Date()) =>
    parseRangeParams(searchParams, now) ?? selectionOf(TIMEFRAME_ALL, now);

/**
 * The other end of that round trip.
 *
 * All time is the overview's default, so clearing the parameters says it while
 * leaving a clean URL - and reads back as all time. The statistics have to name
 * it instead, because a bare URL there means the stored preference.
 */
export const rangeToParams = (timeframe, from, to) =>
    isAllTime(timeframe) ? {} : serializeRange(timeframe, from, to);
