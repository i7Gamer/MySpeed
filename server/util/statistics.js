import { mapFixed, mapRounded } from './helpers.js';

export const TARGET_CHART_POINTS = 300;

const HOURS_PER_DAY = 24;
const MS_PER_MINUTE = 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const PERCENT = 100;
const SPEED_DECIMALS = 2;

const round = (value, decimals = SPEED_DECIMALS) => parseFloat(value.toFixed(decimals));

const average = (values) => values.reduce((total, value) => total + value, 0) / values.length;

const averageOrNull = (values, transform = round) =>
    values.length > 0 ? transform(average(values)) : null;

const standardDeviation = (values) => {
    if (values.length < 2) return 0;
    const mean = average(values);
    return Math.sqrt(average(values.map(value => Math.pow(value - mean, 2))));
};

const consistencyScore = (values) => {
    const mean = values.length > 0 ? average(values) : 0;
    return {
        stdDev: round(standardDeviation(values)),
        consistency: mean > 0 ? round(PERCENT - (standardDeviation(values) / mean * PERCENT), 1) : PERCENT
    };
};

// `offsetMinutes` follows Date.prototype.getTimezoneOffset (minutes behind UTC),
// so subtracting it shifts a UTC instant onto the client's wall clock. Without
// it we fall back to the server's own timezone, which is UTC in the Docker image.
const localHourOf = (created, offsetMinutes) => {
    const date = new Date(created);
    if (!Number.isFinite(offsetMinutes)) return date.getHours();
    return new Date(date.getTime() - offsetMinutes * MS_PER_MINUTE).getUTCHours();
};

const buildHourlyAverages = (entries, offsetMinutes) => {
    const buckets = Array.from({length: HOURS_PER_DAY}, () => ({download: [], upload: [], ping: [], jitter: []}));

    entries.forEach(entry => {
        const bucket = buckets[localHourOf(entry.created, offsetMinutes)];
        bucket.download.push(entry.download);
        bucket.upload.push(entry.upload);
        bucket.ping.push(entry.ping);
        if (entry.jitter !== null && entry.jitter !== undefined) bucket.jitter.push(entry.jitter);
    });

    return buckets.map((bucket, hour) => ({
        hour,
        download: averageOrNull(bucket.download),
        upload: averageOrNull(bucket.upload),
        ping: averageOrNull(bucket.ping, Math.round),
        jitter: averageOrNull(bucket.jitter),
        count: bucket.download.length
    }));
};

const emptySeries = () => ({
    labels: [], failed: [], errors: [],
    data: {ping: [], jitter: [], download: [], upload: [], time: []}
});

const fullSeries = (sorted) => ({
    labels: sorted.map(entry => new Date(entry.created).toISOString()),
    failed: sorted.map(entry => entry.error !== null),
    errors: sorted.map(entry => entry.error),
    data: {
        ping: sorted.map(entry => entry.error === null ? entry.ping : null),
        jitter: sorted.map(entry => entry.error === null ? entry.jitter : null),
        download: sorted.map(entry => entry.error === null ? entry.download : null),
        upload: sorted.map(entry => entry.error === null ? entry.upload : null),
        time: sorted.map(entry => entry.error === null ? entry.time : null)
    }
});

const downsampledSeries = (sorted, from, to) => {
    const bucketSize = (to.getTime() - from.getTime()) / TARGET_CHART_POINTS;
    const buckets = Array.from({length: TARGET_CHART_POINTS}, () => ({entries: [], errors: []}));

    sorted.forEach(entry => {
        const offset = new Date(entry.created).getTime() - from.getTime();
        const index = Math.min(Math.floor(offset / bucketSize), TARGET_CHART_POINTS - 1);
        if (index < 0 || index >= TARGET_CHART_POINTS) return;

        buckets[index].entries.push(entry);
        if (entry.error !== null) buckets[index].errors.push(entry.error);
    });

    const series = emptySeries();

    buckets.forEach((bucket, index) => {
        const midTime = from.getTime() + index * bucketSize + bucketSize / 2;
        const valid = bucket.entries.filter(entry => entry.error === null);

        if (valid.length === 0) {
            if (bucket.errors.length === 0) return;

            series.labels.push(new Date(midTime).toISOString());
            series.failed.push(true);
            series.errors.push(bucket.errors.join('; '));
            Object.values(series.data).forEach(values => values.push(null));
            return;
        }

        const jitters = valid.filter(entry => entry.jitter !== null && entry.jitter !== undefined)
            .map(entry => entry.jitter);

        series.labels.push(new Date(midTime).toISOString());
        series.failed.push(bucket.errors.length > 0);
        series.errors.push(bucket.errors.length > 0 ? `${bucket.errors.length} failed in period` : null);
        series.data.ping.push(Math.round(average(valid.map(entry => entry.ping))));
        series.data.jitter.push(averageOrNull(jitters));
        series.data.download.push(round(average(valid.map(entry => entry.download))));
        series.data.upload.push(round(average(valid.map(entry => entry.upload))));
        series.data.time.push(Math.round(average(valid.map(entry => entry.time))));
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
 * @param options {offsetMinutes} client UTC offset for hour-of-day bucketing
 */
export const buildStatistics = (entries, {from, to}, {offsetMinutes} = {}) => {
    const offset = Number(offsetMinutes);
    const succeeded = entries.filter(entry => entry.error === null);
    const sorted = [...entries].sort((a, b) => new Date(a.created) - new Date(b.created));

    const series = sorted.length <= TARGET_CHART_POINTS
        ? fullSeries(sorted)
        : downsampledSeries(sorted, from, to);

    const withJitter = succeeded.filter(entry => entry.jitter !== null && entry.jitter !== undefined);

    return {
        tests: {
            total: entries.length,
            failed: entries.length - succeeded.length
        },
        ping: mapRounded(succeeded, "ping"),
        jitter: mapFixed(withJitter, "jitter"),
        download: mapFixed(succeeded, "download"),
        upload: mapFixed(succeeded, "upload"),
        time: mapRounded(succeeded, "time"),
        data: series.data,
        labels: series.labels,
        failed: series.failed,
        errors: series.errors,
        hourlyAverages: buildHourlyAverages(succeeded, offset),
        consistency: {
            download: consistencyScore(succeeded.map(entry => entry.download)),
            upload: consistencyScore(succeeded.map(entry => entry.upload)),
            ping: {
                stdDev: round(standardDeviation(succeeded.map(entry => entry.ping))),
                jitter: averageOrNull(withJitter.map(entry => entry.jitter))
            }
        },
        dataPoints: series.labels.length,
        rawDataPoints: entries.length,
        downsampled: entries.length > TARGET_CHART_POINTS,
        dateRange: {
            days: Math.ceil((to - from) / MS_PER_DAY)
        }
    };
};
