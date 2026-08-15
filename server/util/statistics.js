import { mapFixed, mapRounded } from './helpers.js';
import { localHourAt, serverZone, zoneFromOffset } from './timezone.js';
import { isFailedTest, isSuccessfulTest } from './testOutcome.js';

export const TARGET_CHART_POINTS = 300;

/**
 * The columns this module reads, and the only ones its caller selects.
 *
 * A wide range holds every row it summarises in memory at once, and most of a
 * row's weight is text nothing here looks at: a server name, a hostname, an ISP
 * and a result URL. Selecting the ten that matter cut a year of five-minute
 * testing - 105 000 rows - from 190 MB to 128 MB, and its fetch from 693 ms to
 * 257 ms.
 *
 * A column added to the aggregation but not to this list arrives as undefined,
 * which is silent; the test beside this file scans the source to keep the two
 * in step.
 */
export const STATISTICS_COLUMNS = ["created", "error", "ping", "jitter", "download", "upload",
    "time", "packetLoss", "downloadLatency", "uploadLatency"];

/**
 * How far the client may push the resolution of a chart.
 *
 * 300 points keeps the default payload small and the line readable. A reader
 * chasing a specific dip wants every test instead, so the ceiling is high
 * enough to cover a month of five-minute testing while still bounding both the
 * response size and the bucket array allocated below.
 */
export const MIN_CHART_POINTS = 50;
export const MAX_CHART_POINTS = 1000;

const clampPoints = (value) => {
    // Number(null) and Number("") are both 0, which would read as a deliberate
    // request for the lowest resolution rather than as no request at all.
    if (value === null || value === undefined || value === "") return TARGET_CHART_POINTS;

    const points = Number(value);
    if (!Number.isFinite(points)) return TARGET_CHART_POINTS;

    return Math.min(Math.max(Math.trunc(points), MIN_CHART_POINTS), MAX_CHART_POINTS);
};

const HOURS_PER_DAY = 24;
const PERCENT = 100;
const SPEED_DECIMALS = 2;

const round = (value, decimals = SPEED_DECIMALS) => parseFloat(value.toFixed(decimals));

const average = (values) => values.reduce((total, value) => total + value, 0) / values.length;

const averageOrNull = (values, transform = round) =>
    values.length > 0 ? transform(average(values)) : null;

// round() reads .toFixed off its argument, so an absent value has to be carried
// through rather than handed to it.
const roundOrNull = (value, decimals) => value === null ? null : round(value, decimals);

// Two values or more, which consistencyScore below is what guarantees - it is
// the only caller, and it answers anything shorter with nulls before reaching
// here. This used to carry its own guards for an empty list and a single value,
// and they were right up until that gate moved: a lone reading was answered
// with 0, which the score then read as a flawlessly steady line. Left in place
// afterwards they were unreachable, and worse, they described a policy the
// caller had already overruled.
const standardDeviation = (values) => {
    const mean = average(values);
    return Math.sqrt(average(values.map(value => Math.pow(value - mean, 2))));
};

const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const half = Math.floor(sorted.length / 2);

    return sorted.length % 2 === 1 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2;
};

/**
 * How far a typical test sits from the middle one.
 *
 * The ping's spread was a standard deviation, which squares its distances: a
 * real history of 170 pings between 4 and 7 with one spike to 26 read
 * "±1.72 ms", the lone spike carrying three quarters of the squared mass -
 * the figure described the outlier, not the line. Medians on both steps let
 * no single test speak for the range: half the tests sit within this
 * distance of the middle one.
 *
 * Fewer than two values is refused *here*, where standardDeviation above leaves
 * the same refusal to its caller. Both end at the same answer for one reading -
 * nothing measured, rather than a perfect zero - and the gate sits in a
 * different place because the two figures are read differently. That one is
 * only ever an input to a percentage, so the decision belongs where the
 * percentage is shaped; this one is printed to a person as "±0 ms", the
 * strongest claim the card can make - a line that never wavered - so it has to
 * refuse on its own behalf, wherever it is called from.
 *
 * Nor is one test a rare shape: a day on which the connection dropped and every
 * test but one failed lands here, and that is precisely the day someone opens
 * the card.
 */
const medianAbsoluteDeviation = (values) => {
    if (values.length < 2) return null;

    const middle = median(values);
    return median(values.map(value => Math.abs(value - middle)));
};

// The score is presented as a percentage, but the formula is unbounded below:
// once the standard deviation exceeds the mean it goes negative, and a single
// outlier among a few slow tests is enough. "-240% consistent" is not a reading
// anyone can act on, so it is clamped to the range it claims to be in.
const consistencyScore = (values) => {
    // Nothing measured is not the same as measured and perfect. This used to
    // fall through to 100% whenever the mean was not above zero - which includes
    // having no successful tests to take a mean of - so a day on which every
    // test failed reported a flawlessly stable line at 100% and ±0.
    //
    // One test is the same overclaim in a shape that looks like data: it has a
    // mean, so the formula ran, and a lone reading deviates from itself by
    // nothing - "100% consistent, ±0" off a single measurement. Two is the
    // fewest that can disagree, and so the fewest that has a spread to report;
    // zero across two is a real reading and still scores a hundred. A day on
    // which the line dropped and every test but one failed is exactly when this
    // card is read, and exactly when it was most confident.
    if (values.length < 2) return {stdDev: null, consistency: null};

    const mean = average(values);
    const score = mean > 0 ? PERCENT - (standardDeviation(values) / mean * PERCENT) : PERCENT;

    return {
        stdDev: round(standardDeviation(values)),
        consistency: round(Math.min(Math.max(score, 0), PERCENT), 1)
    };
};

const buildHourlyAverages = (entries, zone) => {
    const buckets = Array.from({length: HOURS_PER_DAY}, () => ({download: [], upload: [], ping: [], jitter: []}));

    entries.forEach(entry => {
        const bucket = buckets[localHourAt(zone, new Date(entry.created))];
        bucket.download.push(entry.download);
        bucket.upload.push(entry.upload);
        bucket.ping.push(entry.ping);
        if (entry.jitter !== null && entry.jitter !== undefined) bucket.jitter.push(entry.jitter);
    });

    return buckets.map((bucket, hour) => ({
        hour,
        download: averageOrNull(bucket.download),
        upload: averageOrNull(bucket.upload),
        // Two decimals, like every other metric here: the column stopped being
        // an INTEGER, and rounding the bucket to a whole millisecond would
        // discard the precision at the last step.
        ping: averageOrNull(bucket.ping),
        jitter: averageOrNull(bucket.jitter),
        count: bucket.download.length
    }));
};

// How many recent gradings travel with the average, for the trend beneath it.
const TREND_POINTS = 10;

// Two decimals, matching the per-test figure the client computes.
const INCREASE_DECIMALS = 2;

/**
 * The latency one test gained once the line was saturated.
 *
 * Deliberately the same arithmetic as bufferbloat() in the client's TestUtil:
 * the worse of the two directions, as the grade takes it, minus the idle ping,
 * floored at zero because under the idle ping is measurement noise rather than
 * an improvement. Neither side can import the other, so
 * tests/server/loadedLatencyAgreement.test.js pins the two to the same
 * fixtures.
 *
 * Null when the test could not measure it - only Ookla reports loaded latency,
 * and a failed test stores -1 placeholders that are not readings.
 */
const loadedIncrease = (entry) => {
    const {ping, downloadLatency, uploadLatency} = entry;

    for (const value of [ping, downloadLatency, uploadLatency])
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;

    return Math.max(0, round(Math.max(downloadLatency, uploadLatency) - ping, INCREASE_DECIMALS));
};

/**
 * What the line does under load across the whole range.
 *
 * Averaged over the tests that measured it, exactly as packet loss is. This
 * used to be the grade of the single newest test, taken from a request that
 * carried no date range at all - which put a figure about one moment beside
 * three aggregates about the range, and left it unchanged when the range moved.
 */
/**
 * The added latency across the range, and the newest few readings behind it.
 *
 * Two inputs, because the two answers want different rows. The average is over
 * every success that measured it - a row whose `created` does not parse still
 * measured a real latency, and every other aggregate here counts it, so
 * dropping it would quietly change the figure. The trend is a timeline, and a
 * row with no placeable instant has no place on one.
 *
 * `placeable` arrives already sorted, from the copy buildStatistics builds for
 * everything that reads a timestamp. Sorting locally instead - which is what
 * this did - was wrong twice over: it repeated a sort the caller had already
 * paid for, and it sorted rows that had not been filtered by isPlaceable, so a
 * single unparseable `created` made the comparator return NaN. A NaN compares
 * as equal to everything, which makes the ordering non-transitive and lets V8
 * return an arbitrary permutation - defeating, on exactly the input it was
 * added to defend against, the guarantee it was added to make.
 */
const loadedLatencyOver = (succeeded, placeable) => {
    const measuredIn = (rows) => rows
        .map(entry => ({created: entry.created, increase: loadedIncrease(entry)}))
        .filter(point => point.increase !== null);

    const measured = measuredIn(succeeded);

    return {
        increase: averageOrNull(measured.map(point => point.increase),
            (value) => round(value, INCREASE_DECIMALS)),
        tests: measured.length,
        // Oldest first, so time reads left to right the way the dots are drawn.
        trend: measuredIn(placeable).slice(-TREND_POINTS)
    };
};

const emptySeries = () => ({
    labels: [], failed: [], errors: [],
    data: {ping: [], jitter: [], download: [], upload: [], time: [],
        downloadLatency: [], uploadLatency: []}
});

/**
 * Whether a row can be placed on a timeline at all.
 *
 * Three separate things index on `created`, and one unparseable value killed
 * each of them differently: toISOString() threw outright in the full series,
 * the bucket index came out NaN - which no bounds check catches - in the
 * downsampled one, and the hour-of-day averages indexed their array with it.
 * Any of the three answered 500 for the whole range on the strength of a single
 * bad row, so this is applied once to everything that reads a timestamp rather
 * than guarded three times over.
 *
 * Such a row still counts and still averages. Its measurements are real; only
 * the instant it claims to have been taken at is not.
 */
const isPlaceable = (entry) => !Number.isNaN(new Date(entry.created).getTime());

const fullSeries = (sorted) => ({
    labels: sorted.map(entry => new Date(entry.created).toISOString()),
    failed: sorted.map(isFailedTest),
    errors: sorted.map(entry => entry.error),
    data: {
        ping: sorted.map(entry => isSuccessfulTest(entry) ? entry.ping : null),
        jitter: sorted.map(entry => isSuccessfulTest(entry) ? entry.jitter : null),
        download: sorted.map(entry => isSuccessfulTest(entry) ? entry.download : null),
        upload: sorted.map(entry => isSuccessfulTest(entry) ? entry.upload : null),
        time: sorted.map(entry => isSuccessfulTest(entry) ? entry.time : null),
        // Null where unmeasured - a gap in the line, like jitter. The ?? guards
        // rows from before the columns existed, which have no key at all.
        downloadLatency: sorted.map(entry => isSuccessfulTest(entry) ? entry.downloadLatency ?? null : null),
        uploadLatency: sorted.map(entry => isSuccessfulTest(entry) ? entry.uploadLatency ?? null : null)
    }
});

const downsampledSeries = (sorted, from, to, targetPoints) => {
    const timeSpan = to.getTime() - from.getTime();

    // Zero when the range has no width and NaN when a bound itself does not
    // parse. Both divide every offset into a bucket index that is not a number,
    // and NaN walks straight through the bounds check below.
    if (!Number.isFinite(timeSpan) || timeSpan <= 0) return emptySeries();

    const bucketSize = timeSpan / targetPoints;
    const buckets = Array.from({length: targetPoints}, () => ({entries: [], errors: []}));

    sorted.forEach(entry => {
        const offset = new Date(entry.created).getTime() - from.getTime();
        const index = Math.min(Math.floor(offset / bucketSize), targetPoints - 1);
        if (index < 0 || index >= targetPoints) return;

        buckets[index].entries.push(entry);
        if (isFailedTest(entry)) buckets[index].errors.push(entry.error);
    });

    const series = emptySeries();

    buckets.forEach((bucket, index) => {
        const midTime = from.getTime() + index * bucketSize + bucketSize / 2;
        const valid = bucket.entries.filter(isSuccessfulTest);

        if (valid.length === 0) {
            if (bucket.errors.length === 0) return;

            series.labels.push(new Date(midTime).toISOString());
            series.failed.push(true);
            series.errors.push(bucket.errors.join('; '));
            Object.values(series.data).forEach(values => values.push(null));
            return;
        }

        // Measured-only per metric: jitter and the loaded latencies are absent
        // on some providers, and a null must not drag a bucket's average.
        const measuredOnly = (key) => valid
            .map(entry => entry[key])
            .filter(value => value !== null && value !== undefined);

        series.labels.push(new Date(midTime).toISOString());
        series.failed.push(bucket.errors.length > 0);
        series.errors.push(bucket.errors.length > 0 ? `${bucket.errors.length} failed in period` : null);
        series.data.ping.push(round(average(valid.map(entry => entry.ping))));
        series.data.jitter.push(averageOrNull(measuredOnly("jitter")));
        series.data.download.push(round(average(valid.map(entry => entry.download))));
        series.data.upload.push(round(average(valid.map(entry => entry.upload))));
        // Measured-only like jitter and the two latencies above, not raw: `time`
        // is the one measurement column in this block that is nullable, and
        // average() folds a null in as nought while still counting it in the
        // divisor - so one absent duration deflated the whole bucket, and the
        // chart then disagreed with the summary figure printed above it, which
        // has skipped nulls since mapRange was written.
        series.data.time.push(averageOrNull(measuredOnly("time"), Math.round));
        series.data.downloadLatency.push(averageOrNull(measuredOnly("downloadLatency")));
        series.data.uploadLatency.push(averageOrNull(measuredOnly("uploadLatency")));
    });

    return series;
};

/**
 * Aggregates speedtest rows into the statistics payload the client renders.
 *
 * Pure: it never touches the database, so every branch is directly testable.
 *
 * @param entries rows already restricted to the requested range, any order
 * @param range   {from, to} Date boundaries, used for bucketing and the echo
 * @param options {zone} the clock hour-of-day bucketing is done on, or
 *                {offsetMinutes} a bare UTC offset to build one from,
 *                {maxPoints} requested chart resolution, clamped to the range
 *                the constants above allow
 */
export const buildStatistics = (entries, {from, to}, {offsetMinutes, zone, maxPoints} = {}) => {
    // An offset outside any real zone is answered on the server's own clock
    // rather than thrown on: this is pure aggregation, and the route it came
    // through is where a nonsense parameter earns its 400.
    const bucketZone = zone ?? zoneFromOffset(offsetMinutes).zone ?? serverZone;
    const targetPoints = clampPoints(maxPoints);
    const succeeded = entries.filter(isSuccessfulTest);
    const sorted = entries.filter(isPlaceable).sort((a, b) => new Date(a.created) - new Date(b.created));

    const series = sorted.length <= targetPoints
        ? fullSeries(sorted)
        : downsampledSeries(sorted, from, to, targetPoints);

    const withJitter = succeeded.filter(entry => entry.jitter !== null && entry.jitter !== undefined);

    return {
        tests: {
            total: entries.length,
            failed: entries.length - succeeded.length
        },
        // Averaged over the tests that measured it: only Ookla reports packet
        // loss, and the unmeasured rows must not drag the average. Null when no
        // test in the range measured any - absence is not a clean line.
        packetLoss: averageOrNull(succeeded
            .map(entry => entry.packetLoss)
            .filter(value => value !== null && value !== undefined)),
        // mapFixed rather than mapRounded: the latency carries decimals now, and
        // `time` below is the only column here that is genuinely whole.
        ping: mapFixed(succeeded, "ping"),
        jitter: mapFixed(withJitter, "jitter"),
        download: mapFixed(succeeded, "download"),
        upload: mapFixed(succeeded, "upload"),
        time: mapRounded(succeeded, "time"),
        data: series.data,
        labels: series.labels,
        failed: series.failed,
        errors: series.errors,
        hourlyAverages: buildHourlyAverages(succeeded.filter(isPlaceable), bucketZone),
        consistency: {
            download: consistencyScore(succeeded.map(entry => entry.download)),
            upload: consistencyScore(succeeded.map(entry => entry.upload)),
            ping: {
                // `deviation`, not `stdDev` like the speeds above: the speeds
                // feed a consistency percentage whose formula wants the
                // standard deviation, while this figure is read directly by a
                // person - so it is the median kind, and named for what it is.
                deviation: roundOrNull(medianAbsoluteDeviation(succeeded.map(entry => entry.ping))),
                jitter: averageOrNull(withJitter.map(entry => entry.jitter))
            },
            // The aggregate over every success, the trend over the ones that
            // can be placed on a timeline - already sorted, above.
            loadedLatency: loadedLatencyOver(succeeded, sorted.filter(isSuccessfulTest))
        },
        dataPoints: series.labels.length,
        // The rows the chart could actually draw, which is the same count the
        // branch above is chosen on. `entries.length` counted rows that never
        // reached a bucket, so the note read "showing 287 of 1,000" for a range
        // whose undateable rows were never on the chart to begin with.
        rawDataPoints: sorted.length,
        // From the same count the branch above is chosen on. Computed from
        // `entries` it disagreed with the branch whenever a row in range could
        // not be placed on a timeline: with 301 rows of which one has an
        // unparseable timestamp, the full series is returned - every point
        // drawn, nothing averaged - beneath a note reading "Averaged · showing
        // 300 of 301", which invites the reader to ask for a detail they are
        // already looking at.
        downsampled: sorted.length > targetPoints,
        // Echoed so the client can tell "you are already seeing every test"
        // apart from "there is more detail available if you ask for it".
        maxDataPoints: targetPoints
        // No dateRange: listStatistics owns the echo, because only it knows
        // which window was covered - all time is answered over the extent of
        // the tests rather than over the range asked for. This used to return a
        // day count here as well, and the controller spread its own dateRange
        // over the top one line later, so the figure was computed on every
        // request and thrown away before the response was written.
    };
};
