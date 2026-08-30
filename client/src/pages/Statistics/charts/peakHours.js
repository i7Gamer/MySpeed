/**
 * How much slower the connection's worst hour of the day is than its best.
 *
 * The hourly chart already draws this and leaves the reader to eyeball two bars
 * twelve columns apart. The number is the whole point of that chart - a line
 * that halves every evening is the complaint people open MySpeed to
 * substantiate - and nothing on the page ever stated it.
 *
 * Taken over download, which is the metric an evening slowdown shows up in
 * first and the one every plan is sold on - and, in the twin below, over the
 * per-hour latency the same buckets carry and nothing else displays.
 */
import {readableFigure} from "@/common/utils/TestUtil";

// An hour averaged over one or two tests is an anecdote: a single slow run
// becomes "your line collapses at 3am". Three is the floor for an hour to count
// as measured at all.
const MIN_HOUR_SAMPLES = 3;

// And a comparison needs more than two hours to be about the day rather than
// about the two moments that happened to be sampled.
const MIN_MEASURED_HOURS = 3;

const SLOWDOWN_DECIMALS = 1;
const PERCENT = 100;

/**
 * Every bucket with a readable figure in the given column and enough samples
 * to count as an hour, carrying the COERCED figure.
 *
 * All of it through the shared reader: the buckets are server-fed, and a
 * proxied older node's payload can spell any field as text - a bare typeof
 * here refused a text day whole while every sibling reader of the same
 * payload had learned to read it. And coerced, not merely admitted, because
 * the reduces below compare and subtract these: a text spelling left as text
 * compares lexicographically - "100" < "50" - which reported a negative
 * slowdown with its hours swapped.
 *
 * A zero is refused for either column: the slowdown divides by its best
 * download, and a zero-millisecond latency is a fabrication that would stand
 * as the best hour of every day it appears in. The sample floor reads the
 * bucket's `count`, which the server counts over the download readings - the
 * one stated bound of sharing it: an hour of pings beside no readable
 * downloads is refused with them, which errs toward saying less.
 */
const measuredHours = (hourlyAverages, column) => hourlyAverages.flatMap((bucket) => {
    // The hour too, because it is the one field that reaches the screen:
    // the old typeof gate only ever admitted current-server buckets, which
    // always carry one - reading the other figures is what makes a bucket
    // without a readable hour reachable, and "Slowest at undefined:00" is
    // not a reading.
    const hour = readableFigure(bucket?.hour);
    const figure = readableFigure(bucket?.[column]);
    const samples = readableFigure(bucket?.count);

    return hour !== null && figure !== null && figure > 0 && samples !== null && samples >= MIN_HOUR_SAMPLES
        ? [{hour, figure}] : [];
});

/**
 * @param hourlyAverages the 24 buckets the statistics return, any of which may
 *                       hold no measurement at all
 * @returns {{slowdown: number, slowestHour: number, fastestHour: number}|null}
 *          null whenever the range cannot support the comparison, which the
 *          caller renders as no row rather than as a slowdown of zero
 */
export const peakSlowdown = (hourlyAverages) => {
    if (!Array.isArray(hourlyAverages)) return null;

    const measured = measuredHours(hourlyAverages, "download");
    if (measured.length < MIN_MEASURED_HOURS) return null;

    const fastest = measured.reduce((best, bucket) => bucket.figure > best.figure ? bucket : best);
    const slowest = measured.reduce((worst, bucket) => bucket.figure < worst.figure ? bucket : worst);

    return {
        // Against the fastest hour rather than against the day's average: "34%
        // slower than at its best" is a claim about the same line at two times,
        // which is what the reader is trying to establish.
        slowdown: parseFloat((((fastest.figure - slowest.figure) / fastest.figure) * PERCENT)
            .toFixed(SLOWDOWN_DECIMALS)),
        slowestHour: slowest.hour,
        fastestHour: fastest.hour
    };
};

// Two decimals, the precision the server sends the bucket averages at; the
// row's formatter trims for display.
const RISE_DECIMALS = 2;

/**
 * How much higher the connection's latency sits at its worst hour of the day
 * than at its best.
 *
 * The same buckets as the slowdown above, and the figure nothing draws: the
 * hourly chart plots the speeds alone, so the per-hour latency the payload
 * has always carried was stated nowhere - and the latency climb is the half
 * of an evening slowdown a call or a game actually feels.
 *
 * @returns {{rise: number, bestHour: number, bestPing: number,
 *            worstHour: number, worstPing: number}|null}
 *          null whenever the range cannot support the comparison, rendered as
 *          no row rather than a rise of zero. Ties keep the earliest hour,
 *          like the slowdown's reduces.
 */
export const peakLatencyRise = (hourlyAverages) => {
    if (!Array.isArray(hourlyAverages)) return null;

    const measured = measuredHours(hourlyAverages, "ping");
    if (measured.length < MIN_MEASURED_HOURS) return null;

    const best = measured.reduce((calmest, bucket) => bucket.figure < calmest.figure ? bucket : calmest);
    const worst = measured.reduce((busiest, bucket) => bucket.figure > busiest.figure ? bucket : busiest);

    return {
        // A difference rather than the slowdown's ratio: "13 ms more" is the
        // term latency is felt and quoted in, where a percentage of eight
        // milliseconds is not.
        rise: parseFloat((worst.figure - best.figure).toFixed(RISE_DECIMALS)),
        bestHour: best.hour,
        bestPing: best.figure,
        worstHour: worst.hour,
        worstPing: worst.figure
    };
};
