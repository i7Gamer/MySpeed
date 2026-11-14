import { mapFixed, mapRounded } from './helpers.js';
import { localHourAt, serverZone, zoneFromOffset } from './timezone.js';
import { isFailedTest, measuredPing, usableFigure } from './testOutcome.js';
import { metricValue } from './metricValue.js';
import { targetMetOver } from './targetLimits.js';
import { viewerFacingError } from './connectionIdentity.js';

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
    "targetId",
    // Whose server a failed row was measured against, read only to decide
    // whether its error text may be shown - see errorTextFor.
    "provider"];

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
const standardDeviation = (values, mean) => {
    let squaredDistances = 0;
    for (const value of values) squaredDistances += Math.pow(value - mean, 2);
    return Math.sqrt(squaredDistances / values.length);
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
    const deviation = standardDeviation(numbers, mean);
    const score = mean > 0 ? PERCENT - (deviation / mean * PERCENT) : PERCENT;

    return {
        stdDev: round(deviation),
        consistency: round(Math.min(Math.max(score, 0), PERCENT), 1)
    };
};


/*
 * The rows a summary is built from, held as columns rather than as objects.
 *
 * A wide range used to arrive as one object per row and stay that way for the
 * whole aggregation: an all-time request over a year of five-minute tests held
 * 105 000 of them at once - about 200 MB of resident memory over a node process
 * already holding the app - and minutely testing reaches five times that. Under
 * a 100 MB container limit (#135) that is the request that stalls the instance.
 *
 * Every figure below reads a row through one fixed reader per column: the ping
 * through measuredPing, every other measurement through usableFigure. Those
 * readers answer a finite number or null, so each column is a Float64Array with
 * NaN standing for null - no reader ever produces a NaN of its own - and the
 * cleaned reading is taken once, at the door, instead of on every pass. The
 * readers are idempotent on what they answer, so a figure that reads the cleaned
 * value through its reader again (loadedIncrease, mapRange, meetsLimits) gets
 * exactly what it got from the raw row.
 *
 * What is not a number is kept only where it differs from what can be rebuilt:
 * `created` is rebuilt from the instant whenever it was the canonical ISO
 * spelling every write produces, and kept verbatim otherwise; the error text
 * and its provider are kept only for rows that have one; the target id is
 * interned. Sums nothing else reads - the transfer totals and the packet loss -
 * are folded at the door in the same order the old pass folded them, so they
 * cost no column at all.
 *
 * Filled a page at a time by the controller, so the raw rows of one page are
 * the only objects alive at once.
 */

// A column that holds readings stores "no reading" as NaN, which no reader
// answers - see above.
const NO_READING = NaN;
const INITIAL_CAPACITY = 1024;
const GROWTH_FACTOR = 2;
const FAILED = 1;

const READING_COLUMNS = ["ping", "jitter", "download", "upload", "duration", "downloadLatency", "uploadLatency"];

const readingOrNull = (value) => Number.isNaN(value) ? null : value;

export class StatisticsColumns {
    #length = 0;
    #capacity;
    #placeable = 0;
    #succeeded = 0;
    #ordered = true;
    #previousTime = -Infinity;
    #first = Infinity;
    #last = -Infinity;
    #targets = [];
    #targetCodes = new Map();
    // created values the instant cannot rebuild, by row.
    #createdAsStored = new Map();
    // {error, provider} for every row whose error is not null, by row - one
    // shared record per distinct pair, since a failing line repeats itself.
    #errorRecords = new Map();
    #errorPairs = new Map();
    #packetLossTotal = 0;
    #packetLossCount = 0;
    #bytesDownloaded = null;
    #bytesUploaded = null;

    /** @param capacity the rows expected; a guess, since the store grows past it */
    constructor(capacity = INITIAL_CAPACITY) {
        this.#capacity = Math.max(1, Math.trunc(capacity) || 1);
        this.instant = new Float64Array(this.#capacity);
        this.failed = new Uint8Array(this.#capacity);
        this.target = new Uint32Array(this.#capacity);
        for (const column of READING_COLUMNS) this[column] = new Float64Array(this.#capacity);
    }

    get length() {
        return this.#length;
    }

    get succeeded() {
        return this.#succeeded;
    }

    #grow() {
        this.#capacity *= GROWTH_FACTOR;
        for (const column of ["instant", "failed", "target", ...READING_COLUMNS]) {
            const grown = new this[column].constructor(this.#capacity);
            grown.set(this[column]);
            this[column] = grown;
        }
    }

    #codeOf(targetId) {
        let code = this.#targetCodes.get(targetId);
        if (code === undefined) {
            code = this.#targets.length;
            this.#targets.push(targetId);
            this.#targetCodes.set(targetId, code);
        }
        return code;
    }

    #errorRecordOf(error, provider) {
        let byError = this.#errorPairs.get(provider);
        if (byError === undefined) this.#errorPairs.set(provider, byError = new Map());
        let record = byError.get(error);
        if (record === undefined) byError.set(error, record = Object.freeze({error, provider}));
        return record;
    }

    /** Takes one stored row in; the row itself is not kept. */
    append(entry) {
        if (this.#length === this.#capacity) this.#grow();
        const index = this.#length++;

        const failed = isFailedTest(entry);
        this.failed[index] = failed ? FAILED : 0;
        if (!failed) this.#succeeded++;

        const created = entry.created;
        const time = new Date(created).getTime();
        this.instant[index] = time;
        if (Number.isNaN(time) || typeof created !== "string" || new Date(time).toISOString() !== created)
            this.#createdAsStored.set(index, created);
        // Undateable rows still count in aggregates, but have no position on
        // charts, hourly averages or the reliability timeline.
        if (!Number.isNaN(time)) {
            this.#placeable++;
            if (time < this.#previousTime) this.#ordered = false;
            this.#previousTime = time;
            this.#first = Math.min(this.#first, time);
            this.#last = Math.max(this.#last, time);
        }

        this.ping[index] = measuredPing(entry.ping) ?? NO_READING;
        this.jitter[index] = usableFigure(entry.jitter) ?? NO_READING;
        this.download[index] = usableFigure(entry.download) ?? NO_READING;
        this.upload[index] = usableFigure(entry.upload) ?? NO_READING;
        this.duration[index] = usableFigure(entry.time) ?? NO_READING;
        this.downloadLatency[index] = usableFigure(entry.downloadLatency) ?? NO_READING;
        this.uploadLatency[index] = usableFigure(entry.uploadLatency) ?? NO_READING;
        this.target[index] = this.#codeOf(entry.targetId ?? null);

        if (entry.error !== null) this.#errorRecords.set(index, this.#errorRecordOf(entry.error, entry.provider));

        // Averaged over the successes that measured it - see packetLoss below.
        if (!failed) {
            const loss = usableFigure(entry.packetLoss);
            if (loss !== null) {
                this.#packetLossTotal += loss;
                this.#packetLossCount++;
            }
        }

        // What the testing itself cost in traffic, over every row - see
        // transferTotals below.
        const downloaded = usableFigure(entry.bytesDownloaded);
        const uploaded = usableFigure(entry.bytesUploaded);
        if (downloaded !== null) this.#bytesDownloaded = (this.#bytesDownloaded ?? 0) + downloaded;
        if (uploaded !== null) this.#bytesUploaded = (this.#bytesUploaded ?? 0) + uploaded;
    }

    /** The row's created exactly as stored. */
    createdAt(index) {
        return this.#createdAsStored.has(index)
            ? this.#createdAsStored.get(index)
            : new Date(this.instant[index]).toISOString();
    }

    /** {error, provider} of a row whose error is not null, else undefined. */
    errorRecordAt(index) {
        return this.#errorRecords.get(index);
    }

    targetAt(index) {
        return this.#targets[this.target[index]];
    }

    /** The distinct targets in the order they first appear, absent as null. */
    targetIds() {
        return [...this.#targets];
    }

    /** The earliest and latest placeable instants, or null when none is. */
    extent() {
        return this.#placeable === 0 ? null : {first: this.#first, last: this.#last};
    }

    packetLoss() {
        return this.#packetLossCount > 0 ? round(this.#packetLossTotal / this.#packetLossCount) : null;
    }

    transferTotals() {
        const download = this.#bytesDownloaded;
        const upload = this.#bytesUploaded;
        return {
            download,
            upload,
            total: download === null && upload === null ? null : (download ?? 0) + (upload ?? 0)
        };
    }

    /**
     * The placeable rows, oldest first, as row indices.
     *
     * Database readers already order by created, so the store notes whether
     * the instants arrived in order and sorts only when they did not - legacy
     * timestamp spellings and pure callers with unsorted input. Ties keep their
     * arrival order, as the stable sort this replaces did.
     */
    timeline() {
        const sorted = new Uint32Array(this.#placeable);
        let next = 0;
        for (let index = 0; index < this.#length; index++)
            if (!Number.isNaN(this.instant[index])) sorted[next++] = index;

        if (!this.#ordered) {
            const {instant} = this;
            sorted.sort((a, b) => (instant[a] - instant[b]) || (a - b));
        }
        return sorted;
    }

    /**
     * Each success in arrival order, as one reused object carrying its cleaned
     * readings under the row's own column names - for the shared helpers that
     * read a row (mapRange, targetMetOver), which keep nothing they are handed.
     */
    *successes() {
        const view = {};
        for (let index = 0; index < this.#length; index++) {
            if (this.failed[index] === FAILED) continue;
            view.ping = readingOrNull(this.ping[index]);
            view.jitter = readingOrNull(this.jitter[index]);
            view.download = readingOrNull(this.download[index]);
            view.upload = readingOrNull(this.upload[index]);
            view.time = readingOrNull(this.duration[index]);
            view.downloadLatency = readingOrNull(this.downloadLatency[index]);
            view.uploadLatency = readingOrNull(this.uploadLatency[index]);
            view.targetId = this.targetAt(index);
            yield view;
        }
    }

    /** The readings of one column over the successes that measured it, in arrival order. */
    successReadings(column) {
        const values = [];
        const readings = this[column];
        for (let index = 0; index < this.#length; index++) {
            if (this.failed[index] === FAILED || Number.isNaN(readings[index])) continue;
            values.push(readings[index]);
        }
        return values;
    }
}

/** A store holding these rows, sized for them. */
export const columnsOf = (entries) => {
    const columns = new StatisticsColumns(entries.length);
    for (const entry of entries) columns.append(entry);
    return columns;
};

// A running mean, folded in the order the values arrive - the same sum the
// average() reducer takes over the same values in the same order.
const tally = () => ({total: 0, count: 0});
const add = (running, value) => {
    if (value === null) return;
    running.total += value;
    running.count++;
};
const meanOrNull = (running, transform = round) =>
    running.count > 0 ? transform(running.total / running.count) : null;

const buildHourlyAverages = (columns, zone) => {
    const buckets = Array.from({length: HOURS_PER_DAY},
        () => ({download: tally(), upload: tally(), ping: tally(), jitter: tally()}));

    // Every success that can be placed, in arrival order, as every aggregate.
    for (let index = 0; index < columns.length; index++) {
        if (columns.failed[index] === FAILED || Number.isNaN(columns.instant[index])) continue;

        const bucket = buckets[localHourAt(zone, new Date(columns.instant[index]))];
        // Readable at the door, so the count reported beside the hour's figure
        // counts what the figure used, rather than presenting one readable row
        // as an average backed by ten. The ping refuses the fabricated zero and
        // the jitter an imported -1 placeholder, as their readers do.
        add(bucket.download, readingOrNull(columns.download[index]));
        add(bucket.upload, readingOrNull(columns.upload[index]));
        add(bucket.ping, readingOrNull(columns.ping[index]));
        add(bucket.jitter, readingOrNull(columns.jitter[index]));
    }

    return buckets.map((bucket, hour) => ({
        hour,
        download: meanOrNull(bucket.download),
        upload: meanOrNull(bucket.upload),
        // Two decimals, like every other metric here: the column stopped being
        // an INTEGER, and rounding the bucket to a whole millisecond would
        // discard the precision at the last step.
        ping: meanOrNull(bucket.ping),
        jitter: meanOrNull(bucket.jitter),
        // The readings the download figure above was taken over.
        count: bucket.download.count
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
 * The added latency across the range, and the newest few readings behind it.
 *
 * Averaged over the tests that measured it, exactly as packet loss is. The
 * average is over every success that measured it - a row whose `created` does
 * not parse still measured a real latency, and every other aggregate here
 * counts it, so dropping it would quietly change the figure. The trend is a
 * timeline, and a row with no placeable instant has no place on one, so it is
 * walked off `sorted`, the placeable rows already in order.
 */
const loadedLatencyOver = (columns, sorted) => {
    const view = {};
    const increaseAt = (index) => {
        view.ping = readingOrNull(columns.ping[index]);
        view.downloadLatency = readingOrNull(columns.downloadLatency[index]);
        view.uploadLatency = readingOrNull(columns.uploadLatency[index]);
        return loadedIncrease(view);
    };

    const measured = tally();
    for (let index = 0; index < columns.length; index++)
        if (columns.failed[index] !== FAILED) add(measured, increaseAt(index));

    // The trend needs only the latest measured rows.
    const trend = [];
    for (let position = sorted.length - 1; position >= 0 && trend.length < TREND_POINTS; position--) {
        const index = sorted[position];
        if (columns.failed[index] === FAILED) continue;
        const increase = increaseAt(index);
        if (increase !== null) trend.push({created: columns.createdAt(index), increase});
    }

    return {
        increase: meanOrNull(measured, (value) => round(value, INCREASE_DECIMALS)),
        tests: measured.count,
        // Oldest first, so time reads left to right the way the dots are drawn.
        trend: trend.reverse()
    };
};

/**
 * What a row's error reads as in the series.
 *
 * The operator gets the text as stored. Everyone else gets what every other
 * read route gives them - see viewerFacingError - because the series is the
 * same rows by another door: the tooltip of a failed point is its error. A row
 * with no record held a null error, which both readings answer as null.
 */
const errorTextFor = (redactErrors) => redactErrors
    ? (record) => record === undefined ? null : viewerFacingError(record.provider, record.error)
    : (record) => record === undefined ? null : record.error;

const emptySeries = () => ({
    labels: [], failed: [], errors: [], failedCounts: [],
    data: {ping: [], jitter: [], download: [], upload: [], time: [],
        downloadLatency: [], uploadLatency: []}
});

const fullSeries = (columns, sorted, errorText) => {
    // Null where the row failed or the reading is absent - a gap in the line.
    // Every column was read through its reader at the door: the ping refuses
    // the fabricated zero, the rest refuse corrupt text and imported -1
    // placeholders, so the chart agrees with the summary drawn above it.
    const measured = (column) =>
        Array.from(sorted, (index) => columns.failed[index] === FAILED ? null : readingOrNull(column[index]));

    return {
        labels: Array.from(sorted, (index) => new Date(columns.instant[index]).toISOString()),
        failed: Array.from(sorted, (index) => columns.failed[index] === FAILED),
        errors: Array.from(sorted, (index) => errorText(columns.errorRecordAt(index))),
        // Null throughout: this path never buckets more than one test into a
        // point, so there is no bucket-of-failures count to carry - only
        // downsampledSeries's mixed bucket below ever produces one.
        failedCounts: Array.from(sorted, () => null),
        data: {
            ping: measured(columns.ping),
            jitter: measured(columns.jitter),
            download: measured(columns.download),
            upload: measured(columns.upload),
            time: measured(columns.duration),
            downloadLatency: measured(columns.downloadLatency),
            uploadLatency: measured(columns.uploadLatency)
        }
    };
};

// The series keys, each with the column it is drawn from.
const SERIES_COLUMNS = [["ping", "ping"], ["jitter", "jitter"], ["download", "download"], ["upload", "upload"],
    ["time", "duration"], ["downloadLatency", "downloadLatency"], ["uploadLatency", "uploadLatency"]];

const downsampledSeries = (columns, sorted, from, to, targetPoints, errorText) => {
    const timeSpan = to.getTime() - from.getTime();

    // Zero when the range has no width and NaN when a bound itself does not
    // parse. Both divide every offset into a bucket index that is not a number,
    // and NaN walks straight through the bounds check below.
    if (!Number.isFinite(timeSpan) || timeSpan <= 0) return emptySeries();

    const bucketSize = timeSpan / targetPoints;
    const buckets = Array.from({length: targetPoints}, () => ({valid: 0, errors: [], readings: null}));

    for (const index of sorted) {
        const offset = columns.instant[index] - from.getTime();
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
        const position = Math.min(Math.floor(offset / bucketSize), targetPoints - 1);

        // Which leaves only the floor to check. Written as `>= 0` rather than
        // `< 0` so a NaN position is refused too.
        if (!(position >= 0)) continue;

        const bucket = buckets[position];
        if (columns.failed[index] === FAILED) {
            bucket.errors.push(errorText(columns.errorRecordAt(index)));
            continue;
        }

        // Measured-only per metric, in the order the bucket's rows arrive:
        // jitter and the loaded latencies are absent on some providers, a
        // fabricated zero ping and an imported negative placeholder are not
        // readings either, and none of them may drag a bucket's average.
        bucket.valid++;
        bucket.readings ??= Object.fromEntries(SERIES_COLUMNS.map(([key]) => [key, tally()]));
        for (const [key, column] of SERIES_COLUMNS) add(bucket.readings[key], readingOrNull(columns[column][index]));
    }

    const series = emptySeries();

    buckets.forEach((bucket, position) => {
        const midTime = from.getTime() + position * bucketSize + bucketSize / 2;

        if (bucket.valid === 0) {
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

        series.labels.push(new Date(midTime).toISOString());
        series.failed.push(bucket.errors.length > 0);
        // English, unconditionally: a proxied node older than failedCounts
        // below never sends that array at all, and this sentence is the only
        // thing such a node's tooltip has ever had to read.
        series.errors.push(bucket.errors.length > 0 ? `${bucket.errors.length} failed in period` : null);
        // The same count as a number, which statistics.failed_in_period is
        // what a current client composes from instead. Null everywhere that is
        // not this exact mixed-bucket case.
        series.failedCounts.push(bucket.errors.length > 0 ? bucket.errors.length : null);
        // A bucket with no reading of a metric has no figure for it: a gap,
        // which is what null already draws. `time` is a whole number of
        // seconds; everything else carries two decimals.
        for (const [key] of SERIES_COLUMNS)
            series.data[key].push(meanOrNull(bucket.readings[key], key === "time" ? Math.round : round));
    });

    return series;
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
const reliabilityOver = (columns, sorted) => {
    let longest = null;
    let lastFailureAt = null;
    let largestGap = null;
    let previous = null;

    /*
     * A streak belongs to one target, and this timeline is every target
     * interleaved.
     *
     * Read as row-adjacency it was wrong in both directions on any instance
     * with more than one target: a NAS that failed every run for a week
     * reported a streak of 1, because a working WAN test sat between each of
     * its failures - and one bad round on four targets reported 4, which
     * reads as an outage and was four different lines blinking once.
     *
     * Keyed on the interned id, absent as null, so a history from before
     * targets existed and a single-target instance are each one line.
     */
    const running = new Map();

    for (const index of sorted) {
        const time = columns.instant[index];
        if (previous !== null) {
            const seconds = Math.round((time - columns.instant[previous]) / MS_PER_SECOND);

            if (largestGap === null || seconds > largestGap.seconds)
                largestGap = {seconds, from: columns.createdAt(previous), to: columns.createdAt(index)};
        }
        previous = index;

        const line = columns.target[index];

        if (columns.failed[index] !== FAILED) {
            running.delete(line);
            continue;
        }

        const created = columns.createdAt(index);
        lastFailureAt = created;

        const carried = running.get(line);
        const current = carried === undefined
            ? {count: 1, from: created, to: created}
            : {count: carried.count + 1, from: carried.from, to: created};

        running.set(line, current);

        if (longest === null || current.count > longest.count) longest = {...current};
    }

    return {longestFailureStreak: longest, lastFailureAt, largestGap};
};

/**
 * Aggregates speedtest rows into the statistics payload the client renders.
 *
 * Pure: it never touches the database, so every branch is directly testable.
 * The controller fills a StatisticsColumns page by page and calls
 * statisticsOver itself; this is the same answer for rows already in hand.
 *
 * @param entries rows already restricted to the requested range, any order
 * @param range   {from, to} Date boundaries, used for bucketing
 * @param options see statisticsOver
 */
export const buildStatistics = (entries, range, options = {}) =>
    statisticsOver(columnsOf(entries), range, options);

/**
 * The statistics payload, from rows already taken into columns.
 *
 * @param columns a StatisticsColumns holding the rows of the range
 * @param range   {from, to} Date boundaries, used for bucketing and the echo
 * @param options {zone} the clock hour-of-day bucketing is done on, or
 *                {offsetMinutes} a bare UTC offset to build one from,
 *                {maxPoints} requested chart resolution, clamped to the range
 *                the constants above allow,
 *                {limitsFor} (targetId) => the optimal values a row of that
 *                target is graded against, for the target-met count,
 *                {redactErrors} true for a reader who is not the operator
 */
export const statisticsOver = (columns, {from, to}, options = {}) => {
    const {offsetMinutes, zone, maxPoints} = options;
    const errorText = errorTextFor(options.redactErrors === true);
    // An offset outside any real zone is answered on the server's own clock
    // rather than thrown on: this is pure aggregation, and the route it came
    // through is where a nonsense parameter earns its 400.
    const bucketZone = zone ?? zoneFromOffset(offsetMinutes).zone ?? serverZone;
    const targetPoints = clampPoints(maxPoints);
    const sorted = columns.timeline();

    const series = sorted.length <= targetPoints
        ? fullSeries(columns, sorted, errorText)
        : downsampledSeries(columns, sorted, from, to, targetPoints, errorText);

    const pings = columns.successReadings("ping");
    const jitters = columns.successReadings("jitter");

    return {
        tests: {
            total: columns.length,
            failed: columns.length - columns.succeeded
        },
        // Averaged over the tests that measured it: only Ookla reports packet
        // loss, and the unmeasured rows must not drag the average. Null when no
        // test in the range measured any - absence is not a clean line.
        packetLoss: columns.packetLoss(),
        // mapFixed rather than mapRounded: the latency carries decimals now, and
        // `time` below is the only column here that is genuinely whole. Each
        // reads the success's cleaned reading, so a fabricated zero ping, an
        // imported -1 placeholder and corrupt text are all left out, as the
        // chart leaves them out.
        ping: mapFixed(columns.successes(), "ping"),
        jitter: mapFixed(columns.successes(), "jitter"),
        download: mapFixed(columns.successes(), "download", usableFigure),
        upload: mapFixed(columns.successes(), "upload", usableFigure),
        time: mapRounded(columns.successes(), "time", usableFigure),
        // Over the entries rather than the successes: the figure is about
        // traffic, not about outcomes, and a failure that moved data still
        // moved it. Null when no row measured either direction, because
        // absence is not a total of nought.
        dataUsed: columns.transferTotals(),
        reliability: reliabilityOver(columns, sorted),
        // How often the line delivered, by the verdict every row already wears.
        // Over the successes only, and null when the caller handed in no way to
        // resolve a row's limits. See targetLimits.js for the rule.
        targetMet: targetMetOver(columns.successes(), options.limitsFor),
        data: series.data,
        labels: series.labels,
        failed: series.failed,
        errors: series.errors,
        // Undefined only ever at the whole-payload level, not per-index: a
        // node built before this existed omits the key entirely, which is what
        // lets the client tell "too old to send a count" apart from "this
        // point has none".
        failedCounts: series.failedCounts,
        hourlyAverages: buildHourlyAverages(columns, bucketZone),
        consistency: {
            download: consistencyScore(columns.successReadings("download")),
            upload: consistencyScore(columns.successReadings("upload")),
            ping: {
                // `deviation`, not `stdDev` like the speeds above: this figure
                // is read directly by a person - so it is the median kind.
                deviation: roundOrNull(medianAbsoluteDeviation(pings)),
                jitter: averageOrNull(jitters)
            },
            // The aggregate over every success, the trend over the ones that
            // can be placed on a timeline - already sorted, above.
            loadedLatency: loadedLatencyOver(columns, sorted)
        },
        dataPoints: series.labels.length,
        // The rows the chart could actually draw, which is the same count the
        // branch above is chosen on - undateable rows never reach a bucket.
        rawDataPoints: sorted.length,
        downsampled: sorted.length > targetPoints,
        // Echoed so the client can tell "you are already seeing every test"
        // apart from "there is more detail available if you ask for it".
        maxDataPoints: targetPoints
        // No dateRange: listStatistics owns the echo, because only it knows
        // which window was covered.
    };
};
