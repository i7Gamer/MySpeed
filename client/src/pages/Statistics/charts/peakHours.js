/**
 * How much slower the connection's worst hour of the day is than its best.
 *
 * The hourly chart already draws this and leaves the reader to eyeball two bars
 * twelve columns apart. The number is the whole point of that chart - a line
 * that halves every evening is the complaint people open MySpeed to
 * substantiate - and nothing on the page ever stated it.
 *
 * Taken over download, which is the metric an evening slowdown shows up in
 * first and the one every plan is sold on.
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
 * Every bucket with a readable download and enough samples to count as an
 * hour, carrying the COERCED download.
 *
 * Both figures through the shared reader: the buckets are server-fed, and a
 * proxied older node's payload can spell either as text - a bare typeof here
 * refused a text day whole while every sibling reader of the same payload
 * had learned to read it. And coerced, not merely admitted, because the
 * reduces below compare and subtract these: a text spelling left as text
 * compares lexicographically - "100" < "50" - which reported a negative
 * slowdown with its hours swapped.
 */
const measuredHours = (hourlyAverages) => hourlyAverages.flatMap((bucket) => {
    const download = readableFigure(bucket?.download);
    const samples = readableFigure(bucket?.count);

    return download !== null && download > 0 && samples !== null && samples >= MIN_HOUR_SAMPLES
        ? [{hour: bucket.hour, download}] : [];
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

    const measured = measuredHours(hourlyAverages);
    if (measured.length < MIN_MEASURED_HOURS) return null;

    const fastest = measured.reduce((best, bucket) => bucket.download > best.download ? bucket : best);
    const slowest = measured.reduce((worst, bucket) => bucket.download < worst.download ? bucket : worst);

    return {
        // Against the fastest hour rather than against the day's average: "34%
        // slower than at its best" is a claim about the same line at two times,
        // which is what the reader is trying to establish.
        slowdown: parseFloat((((fastest.download - slowest.download) / fastest.download) * PERCENT)
            .toFixed(SLOWDOWN_DECIMALS)),
        slowestHour: slowest.hour,
        fastestHour: fastest.hour
    };
};
