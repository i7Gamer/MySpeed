// A hair's difference reads as noise, not as a trend - below this the delta
// says nothing at all.
const NOISE_FLOOR = 0.05;

const PERCENT = 100;

const round = (value) => Math.round(value * 10) / 10;

/**
 * One figure's change against the previous period, or null when silence is the
 * honest answer.
 *
 * Silence is deliberate in four cases: either value missing, a percentage
 * against a previous of zero (arithmetic, not information), no change at all,
 * and a change below the noise floor. An *absolute* change from zero stays:
 * zero failures becoming three is real news.
 *
 * `higherIsBetter` carries the metric's direction - more download is good,
 * more ping is not - and null marks a figure with no direction at all, like
 * the number of tests, whose change is worth a word but not a colour.
 */
export const describeDelta = ({current, previous, higherIsBetter, mode = "percent", unit = ""}) => {
    if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
    if (mode === "percent" && previous === 0) return null;

    const change = mode === "percent"
        ? ((current - previous) / previous) * PERCENT
        : current - previous;

    if (Math.abs(change) < NOISE_FLOOR) return null;

    const tone = higherIsBetter === null || higherIsBetter === undefined
        ? "neutral"
        : (change > 0) === higherIsBetter ? "better" : "worse";

    return {
        direction: change > 0 ? "up" : "down",
        tone,
        label: `${round(Math.abs(change))}${mode === "percent" ? "%" : unit}`
    };
};

/**
 * The gate in front of every delta on a page: a previous window nobody tested
 * in has no figures to compare against, and comparing against its zeros would
 * call a working connection "infinitely worse".
 */
export const hasPreviousData = (previous) => (previous?.tests?.total ?? 0) > 0;
