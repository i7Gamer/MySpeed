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

// An hour averaged over one or two tests is an anecdote: a single slow run
// becomes "your line collapses at 3am". Three is the floor for an hour to count
// as measured at all.
const MIN_HOUR_SAMPLES = 3;

// And a comparison needs more than two hours to be about the day rather than
// about the two moments that happened to be sampled.
const MIN_MEASURED_HOURS = 3;

const SLOWDOWN_DECIMALS = 1;
const PERCENT = 100;

const isMeasured = (bucket) =>
    typeof bucket?.download === "number"
    && Number.isFinite(bucket.download)
    && bucket.download > 0
    && bucket.count >= MIN_HOUR_SAMPLES;

/**
 * @param hourlyAverages the 24 buckets the statistics return, any of which may
 *                       hold no measurement at all
 * @returns {{slowdown: number, slowestHour: number, fastestHour: number}|null}
 *          null whenever the range cannot support the comparison, which the
 *          caller renders as no row rather than as a slowdown of zero
 */
export const peakSlowdown = (hourlyAverages) => {
    if (!Array.isArray(hourlyAverages)) return null;

    const measured = hourlyAverages.filter(isMeasured);
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
