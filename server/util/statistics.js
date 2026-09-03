import { mapFixed, mapRounded } from './helpers.js';
import { localHourAt, serverZone, zoneFromOffset } from './timezone.js';
import { isFailedTest, isSuccessfulTest, measuredPing, usableFigure } from './testOutcome.js';
import { metricValue } from './metricValue.js';

export const TARGET_CHART_POINTS = 300;

/**
 * The columns this module reads, and the only ones its caller selects.
 *
 * A wide range holds every row it summarises in memory at once, and most of a
 * row's weight is text nothing here looks at: a server name, a hostname, an ISP
 * and a result URL. Selecting only the columns that matter cut a year of
 * five-minute testing - 105 000 rows - from 190 MB to 128 MB, and its fetch
 * from 693 ms to 257 ms, measured when the list held ten.
 *
 * A column added to the aggregation but not to this list arrives as undefined,
 * which is silent; the test beside this file scans the source to keep the two
 * in step.
 */
export const STATISTICS_COLUMNS = ["created", "error", "ping", "jitter", "download", "upload",
    "time", "packetLoss", "downloadLatency", "uploadLatency", "bytesDownloaded", "bytesUploaded",
    // Which line each row measured. Not aggregated by - every figure here is
    // still about the whole selection - but the failure streak is a claim about
    // one target, and on the unfiltered path no two rows in a row belong to the
    // same one. See reliabilityOver.
    "targetId"];

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

/**
 * The readable measurements of a stored population, as numbers.
 *
 * Through metricValue, and once, at the boundary. The corruption a database
 * actually delivers is non-numeric text - a live run once stored the literal
 * string "NaN", which turned `total + value` into concatenation and a 200 Mbit
 * average into 8.6e13 - and metricValue refuses it. The numeric-string reading
 * beside that is the defensive half of the same contract: both backends
 * coerce well-formed digits at write for these DOUBLE columns, so no current
 * row arrives spelt "42" - but metricValue is the judgement Prometheus and the
 * recommendation sample lean on, and a second predicate here is how two
 * surfaces on one page came to disagree about one row. A filter inside each
 * formula instead of one out here also gave the mean and the spread two
 * different populations - a coercible string was missing from the mean while
 * Math.pow folded it, squared, into the deviations.
 *
 * Every gate and formula below runs on this cleaned array, so a length is
 * always the length of what the arithmetic actually saw.
 */
const readings = (values) => {
    const numbers = [];
    for (const value of values) {
        const reading = metricValue(value);
        if (reading !== null) numbers.push(reading);
    }
    return numbers;
};

// The plain mean of a readings() population. The filter this used to carry
// moved up into readings, where it runs once - inside the reducer it ran again
// for every derived figure, and standardDeviation's two passes filtered
// different populations.
const average = (values) => values.reduce((total, value) => total + value, 0) / values.length;

// Null when nothing was readable: an empty set has no mean, and a bucket
// holding only corrupt rows is the same absence wearing data's shape.
const averageOrNull = (values, transform = round) => {
    const numbers = readings(values);
    return numbers.length > 0 ? transform(average(numbers)) : null;
};

// round() reads .toFixed off its argument, so an absent value has to be carried
// through rather than handed to it.
const roundOrNull = (value, decimals) => value === null ? null : round(value, decimals);

// Two *readable* values or more, which consistencyScore below is what
// guarantees - it is the only caller, it cleans through readings() first, and
// it answers anything shorter than two of those with nulls before reaching
// here. So the mean and the deviations run on one and the same population. This used to carry its own guards for an empty list and a single value,
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
    // The cleaned population, and the gate asks it rather than the raw rows.
    // Counting rows the arithmetic then dropped let two corrupt rows through
    // to a mean of nothing - NaN > 0 is false, so the fallback scored the
    // emptiness a flawless 100 - and one readable row beside one corrupt was
    // precisely the lone-reading overclaim described above, back through a
    // side door.
    const numbers = readings(values);
    if (numbers.length < 2) return {stdDev: null, consistency: null};

    const mean = average(numbers);
    // Once, for both readers below - it walks the whole population each time.
    const deviation = standardDeviation(numbers);
    const score = mean > 0 ? PERCENT - (deviation / mean * PERCENT) : PERCENT;

    return {
        stdDev: round(deviation),
        consistency: round(Math.min(Math.max(score, 0), PERCENT), 1)
    };
};

const buildHourlyAverages = (entries, zone) => {
    const buckets = Array.from({length: HOURS_PER_DAY}, () => ({download: [], upload: [], ping: [], jitter: []}));

    entries.forEach(entry => {
        const bucket = buckets[localHourAt(zone, new Date(entry.created))];
        // Readable at the door, like the two guarded pushes below - and so the
        // count reported beside the hour's figure counts what the figure used,
        // rather than presenting one readable row as an average backed by ten.
        const download = usableFigure(entry.download);
        if (download !== null) bucket.download.push(download);
        const upload = usableFigure(entry.upload);
        if (upload !== null) bucket.upload.push(upload);
        // Guarded like the jitter below it, and for the same reason: a
        // fabricated zero is not a reading, and one in an hour's bucket halved
        // that hour's latency. Through measuredPing, so the coercion the other
        // columns get reaches this one too.
        const ping = measuredPing(entry.ping);
        if (ping !== null) bucket.ping.push(ping);
        // usableFigure rather than a null check: an imported -1 placeholder
        // was an hour's whole jitter reading. Bound and pushed, like its three
        // siblings - computing the cleaned value and pushing the raw one left
        // this the one array still holding whatever the column held.
        const jitter = usableFigure(entry.jitter);
        if (jitter !== null) bucket.jitter.push(jitter);
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
        // The readings the download figure above was taken over - the guarded
        // push is what keeps this honest.
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
    // usableFigure for the two loaded columns and measuredPing for the idle
    // one - the same readers every sibling figure goes through. They coerce
    // the defensive numeric-string spelling and refuse null, junk and the
    // negative placeholders alike, and measuredPing also refuses the
    // fabricated zero: subtracted as a real 0 ms baseline, the whole loaded
    // latency would read as *added* latency - an F grade for a line that was
    // fine.
    const ping = measuredPing(entry.ping);
    const downloadLatency = usableFigure(entry.downloadLatency);
    const uploadLatency = usableFigure(entry.uploadLatency);

    if (ping === null || downloadLatency === null || uploadLatency === null) return null;

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
    labels: [], failed: [], errors: [], failedCounts: [],
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
    // Null throughout: this path never buckets more than one test into a
    // point, so there is no bucket-of-failures count to carry - only
    // downsampledSeries's mixed bucket below ever produces one.
    failedCounts: sorted.map(() => null),
    data: {
        // A gap where the latency was fabricated rather than measured, exactly
        // as jitter and the loaded latencies below already draw an absent
        // reading. The summary above this chart has skipped the fabricated zero
        // since UNMEASURED_LATENCY was written; the line did not, so a range
        // could report a minimum of 20 ms over a chart that visibly touched
        // nought - the same instance answering one question two ways.
        ping: sorted.map(entry => isSuccessfulTest(entry) ? measuredPing(entry.ping) : null),
        // Through usableFigure, the same reading the live write gives these
        // columns: a history imported before the import refused negatives can
        // hold -1 placeholders, and passed through they drew a jitter dipping
        // below zero on a chart whose summary skipped the same row.
        jitter: sorted.map(entry => isSuccessfulTest(entry) ? usableFigure(entry.jitter) : null),
        // usableFigure like the downsampled branch beside this one, not raw:
        // a corrupt stored string shipped here reached the client as JSON
        // text, where the chart's own average reducer concatenated it - the
        // exact total-plus-value bug average() was fixed for, reproduced in
        // the browser on every range small enough not to bucket - and an
        // imported -1 placeholder drew a chart point below zero. Unreadable
        // is a null, which the line already draws as a gap.
        download: sorted.map(entry => isSuccessfulTest(entry) ? usableFigure(entry.download) : null),
        upload: sorted.map(entry => isSuccessfulTest(entry) ? usableFigure(entry.upload) : null),
        // usableFigure, matching the measuredOnly("time") read the downsampled
        // branch gives the same column.
        time: sorted.map(entry => isSuccessfulTest(entry) ? usableFigure(entry.time) : null),
        // Null where unmeasured - a gap in the line, like jitter. usableFigure
        // answers null for the absent key of a row from before the columns
        // existed, and for an imported negative alike.
        downloadLatency: sorted.map(entry => isSuccessfulTest(entry) ? usableFigure(entry.downloadLatency) : null),
        uploadLatency: sorted.map(entry => isSuccessfulTest(entry) ? usableFigure(entry.uploadLatency) : null)
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
        /*
         * Clamped at the top rather than dropped, and that is load-bearing.
         *
         * The rows are fetched with an inclusive BETWEEN, so an entry created
         * on `to` itself does arrive here - and its offset is the whole span,
         * which divides to exactly targetPoints: one past the last bucket. It
         * belongs in that bucket rather than nowhere, so removing this to
         * "wake up" the bounds check below would silently drop the final
         * reading of every range.
         */
        const index = Math.min(Math.floor(offset / bucketSize), targetPoints - 1);

        // Which leaves only the floor to check: the clamp already guarantees
        // the ceiling, so asking for it again was dead. Written as `>= 0`
        // rather than `< 0` so a NaN index - an entry whose `created` does not
        // parse - is refused too, where both halves of the old test let it
        // through to a buckets[NaN] that has no entries to push onto.
        if (!(index >= 0)) return;

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
            // Not a count: this bucket has no success to be the OTHER half of
            // a mix, so it is the joined-message shape rather than the "N
            // failed in period" one, and must not be read as a number of it.
            series.failedCounts.push(null);
            Object.values(series.data).forEach(values => values.push(null));
            return;
        }

        // Measured-only per metric: jitter and the loaded latencies are absent
        // on some providers, and a null must not drag a bucket's average.
        // Through usableFigure, like the full-resolution branch: an imported
        // negative placeholder is not a reading either, and guarded on one
        // branch only, the same range answered two ways depending on row
        // count - 300 rows drew gaps, 301 bucketed the -1s back in.
        const measuredOnly = (key) => valid
            .map(entry => usableFigure(entry[key]))
            .filter(value => value !== null);

        series.labels.push(new Date(midTime).toISOString());
        series.failed.push(bucket.errors.length > 0);
        // English, unconditionally: a proxied node older than failedCounts
        // below never sends that array at all, and this sentence is the only
        // thing such a node's tooltip has ever had to read. lineChartConfig's
        // tooltip prefers the translated one when failedCounts names a count,
        // so a current server keeps writing this for no reader still on this
        // build - never for one that just upgraded past it.
        series.errors.push(bucket.errors.length > 0 ? `${bucket.errors.length} failed in period` : null);
        // The same count the sentence above already names, sent again as a
        // number rather than English prose: statistics.failed_in_period is
        // what a current client composes it from instead. Parallel to errors
        // and null everywhere that is not this exact mixed-bucket case - an
        // absent failedCounts array (an older node's whole payload) is the
        // signal to fall back to the sentence above; a null AT one index,
        // once the array exists, is this index's own producer saying it has
        // no count to give, not the array being missing.
        series.failedCounts.push(bucket.errors.length > 0 ? bucket.errors.length : null);
        // Measured-only like the three below it: a fabricated zero folded into
        // a bucket average is a dip of the wrong depth rather than a visible
        // nought, which is the harder of the two to catch. Null when a bucket
        // held nothing else, since a bucket with no reading has no latency.
        series.data.ping.push(averageOrNull(valid.map(entry => measuredPing(entry.ping))));
        series.data.jitter.push(averageOrNull(measuredOnly("jitter")));
        // averageOrNull like every sibling, not the bare mean: these two
        // columns are NOT NULL, which is why a raw average looked safe - but a
        // corrupt stored string is not null, and a bucket holding one either
        // concatenated its way to an eight-figure point or, cleaned, can come
        // up with no reading at all. No reading is a gap, which is what null
        // already draws on this chart.
        series.data.download.push(averageOrNull(valid.map(entry => usableFigure(entry.download))));
        series.data.upload.push(averageOrNull(valid.map(entry => usableFigure(entry.upload))));
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
 * What the testing itself cost in traffic, summed over the rows that measured
 * it.
 *
 * Over the entries rather than the successes: the figure is about traffic, not
 * about outcomes, and a failure that moved data still moved it. Rows from
 * before the transfer columns existed - and runs whose provider reported
 * nothing - hold nulls, which stay out of the sums the way an unmeasured
 * packet loss stays out of its average: a total over part of the range is a
 * lower bound, not a claim about rows that said nothing. Null when no row
 * measured either direction, because absence is not a total of nought.
 */
const transferTotals = (entries) => {
    let download = null;
    let upload = null;

    // Non-negative as well as numeric: a negative byte count is not traffic,
    // and summed as bytes each one *subtracts* from the total. The live path
    // cannot store one - byteCount refuses it - but a history imported before
    // the import learned the same rule can hold -1 placeholders.
    const moved = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;

    for (const entry of entries) {
        if (moved(entry.bytesDownloaded)) download = (download ?? 0) + entry.bytesDownloaded;
        if (moved(entry.bytesUploaded)) upload = (upload ?? 0) + entry.bytesUploaded;
    }

    return {
        download,
        upload,
        total: download === null && upload === null ? null : (download ?? 0) + (upload ?? 0)
    };
};

const MS_PER_SECOND = 1000;

/**
 * The two findings the failed-count never states, walked off the placeable
 * timeline in one pass: how bad an outage was when it came - failures in a
 * ROW, not spread singles - and how long the testing itself went dark.
 *
 * The gap deliberately counts failed rows as presence: a failed test still
 * proves the scheduler ran, and the gap exists to find the hours nothing ran
 * at all. Both walks need consecutive INSTANTS, so a row whose created
 * nothing can parse counts in the totals but sits in neither - `sorted` is
 * already that timeline. Ties keep the first: the earlier outage is the one
 * the range met first, and flapping between equals redraws nothing.
 */
const reliabilityOver = (sorted) => {
    let longest = null;
    let lastFailureAt = null;
    let largestGap = null;
    let previous = null;

    /*
     * A streak belongs to one target, and this timeline is every target
     * interleaved.
     *
     * Read as row-adjacency it was wrong in both directions on any instance
     * with more than one target, and plausible on screen both times: a NAS
     * that failed every run for a week reported a streak of 1, because a
     * working WAN test sat between each of its failures - and one bad round on
     * four targets reported 4, which reads as an outage and was four different
     * lines blinking once. The digest is instance-wide by construction, so its
     * headline outage figure was the one nothing on screen could correct.
     *
     * Keyed on the id with null for absent, so a history from before targets
     * existed and a single-target instance are each one line and read exactly
     * as they did.
     */
    const running = new Map();

    for (const entry of sorted) {
        if (previous !== null) {
            const seconds = Math.round(
                (new Date(entry.created) - new Date(previous.created)) / MS_PER_SECOND);

            if (largestGap === null || seconds > largestGap.seconds)
                largestGap = {seconds, from: previous.created, to: entry.created};
        }
        previous = entry;

        const line = entry.targetId ?? null;

        if (!isFailedTest(entry)) {
            running.delete(line);
            continue;
        }

        lastFailureAt = entry.created;

        const carried = running.get(line);
        const current = carried === undefined
            ? {count: 1, from: entry.created, to: entry.created}
            : {count: carried.count + 1, from: carried.from, to: entry.created};

        running.set(line, current);

        if (longest === null || current.count > longest.count) longest = {...current};
    }

    return {longestFailureStreak: longest, lastFailureAt, largestGap};
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

    // Measured, not merely present: an imported history can hold -1
    // placeholders in the nullable columns, and admitted here one of them set
    // the range's minimum jitter and dragged its average - the summary
    // disagreeing with the chart drawn under it, which shows the same row as
    // a gap.
    const withJitter = succeeded.filter(entry => usableFigure(entry.jitter) !== null);
    // The same shape, for the same reason: a successful test can carry a
    // latency nobody measured - see UNMEASURED_LATENCY - and averaging that
    // fabricated zero as a 0 ms reading dragged every ping figure down while
    // the alert gate, reading the same row, refused it.
    const withPing = succeeded.filter(entry => measuredPing(entry.ping) !== null);

    return {
        tests: {
            total: entries.length,
            failed: entries.length - succeeded.length
        },
        // Averaged over the tests that measured it: only Ookla reports packet
        // loss, and the unmeasured rows must not drag the average. Null when no
        // test in the range measured any - absence is not a clean line. Through
        // usableFigure for the reason withJitter reads through it.
        packetLoss: averageOrNull(succeeded
            .map(entry => usableFigure(entry.packetLoss))
            .filter(value => value !== null)),
        // mapFixed rather than mapRounded: the latency carries decimals now, and
        // `time` below is the only column here that is genuinely whole.
        ping: mapFixed(withPing, "ping"),
        jitter: mapFixed(withJitter, "jitter"),
        download: mapFixed(succeeded, "download", usableFigure),
        upload: mapFixed(succeeded, "upload", usableFigure),
        // usableFigure, like both chart branches: a -1 here is an imported
        // placeholder, and read raw the span card printed "-1s" beside a chart
        // drawing the same row as a gap.
        time: mapRounded(succeeded, "time", usableFigure),
        dataUsed: transferTotals(entries),
        reliability: reliabilityOver(sorted),
        data: series.data,
        labels: series.labels,
        failed: series.failed,
        errors: series.errors,
        // Undefined only ever at the whole-payload level, not per-index: a
        // node built before this existed omits the key entirely (JSON drops
        // it), which is what lets the client tell "too old to send a count"
        // apart from "this point has none" - Statistics.jsx's own
        // askedCompare === undefined check is the same cross-version idiom.
        failedCounts: series.failedCounts,
        hourlyAverages: buildHourlyAverages(succeeded.filter(isPlaceable), bucketZone),
        consistency: {
            download: consistencyScore(succeeded.map(entry => usableFigure(entry.download))),
            upload: consistencyScore(succeeded.map(entry => usableFigure(entry.upload))),
            ping: {
                // `deviation`, not `stdDev` like the speeds above: the speeds
                // feed a consistency percentage whose formula wants the
                // standard deviation, while this figure is read directly by a
                // person - so it is the median kind, and named for what it is.
                deviation: roundOrNull(medianAbsoluteDeviation(withPing.map(entry => measuredPing(entry.ping)))),
                jitter: averageOrNull(withJitter.map(entry => usableFigure(entry.jitter)))
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
