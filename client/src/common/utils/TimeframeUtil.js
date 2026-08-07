export const TIMEFRAME_CUSTOM = "custom";

export const DEFAULT_TIMEFRAME = "7d";

const DAYS_PER_YEAR = 365;

/**
 * The selectable statistics timeframes.
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

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const findTimeframe = (id) => TIMEFRAMES.find(frame => frame.id === id) ?? null;

const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

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
 * Reads a timeframe out of the URL.
 *
 * Accepts either `?range=<preset>` or `?from=&to=`. Returns null when nothing
 * usable is present, letting the caller fall back to the stored preference.
 */
export const parseRangeParams = (searchParams, now = new Date()) => {
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
    if (findTimeframe(timeframe)) return {range: timeframe};
    return {from: formatDateParam(from), to: formatDateParam(to)};
};
