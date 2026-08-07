import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildStatistics, TARGET_CHART_POINTS } from "../../server/util/statistics.js";

const at = (iso, overrides = {}) => ({
    ping: 10, jitter: 2, download: 100, upload: 50, time: 30,
    error: null, created: iso, ...overrides
});

const range = (fromIso, toIso) => ({from: new Date(fromIso), to: new Date(toIso)});

const DAY = range("2026-08-07T00:00:00.000Z", "2026-08-07T23:59:59.999Z");

describe("buildStatistics", () => {
    describe("counts", () => {
        it("reports zero totals for an empty set", () => {
            const stats = buildStatistics([], DAY);
            assert.deepEqual(stats.tests, {total: 0, failed: 0});
        });

        it("counts failed entries separately", () => {
            const stats = buildStatistics([
                at("2026-08-07T01:00:00.000Z"),
                at("2026-08-07T02:00:00.000Z", {error: "timeout"}),
                at("2026-08-07T03:00:00.000Z")
            ], DAY);
            assert.deepEqual(stats.tests, {total: 3, failed: 1});
        });
    });

    describe("aggregates", () => {
        it("excludes failed entries from the averages", () => {
            const stats = buildStatistics([
                at("2026-08-07T01:00:00.000Z", {download: 100}),
                at("2026-08-07T02:00:00.000Z", {download: -1, error: "timeout"}),
                at("2026-08-07T03:00:00.000Z", {download: 200})
            ], DAY);
            assert.equal(stats.download.min, 100);
            assert.equal(stats.download.avg, 150);
        });

        // Regression: a range in which every test failed used to serialise as
        // Infinity/NaN, which JSON.stringify turns into null with no warning.
        it("returns null aggregates when every test failed", () => {
            const stats = buildStatistics([
                at("2026-08-07T01:00:00.000Z", {error: "timeout"}),
                at("2026-08-07T02:00:00.000Z", {error: "timeout"})
            ], DAY);
            assert.deepEqual(stats.download, {min: null, max: null, avg: null});
            assert.deepEqual(stats.ping, {min: null, max: null, avg: null});
        });

        it("returns null jitter aggregates when no entry reports jitter", () => {
            const stats = buildStatistics([
                at("2026-08-07T01:00:00.000Z", {jitter: null}),
                at("2026-08-07T02:00:00.000Z", {jitter: null})
            ], DAY);
            assert.deepEqual(stats.jitter, {min: null, max: null, avg: null});
        });

        it("aggregates only the entries that do report jitter", () => {
            const stats = buildStatistics([
                at("2026-08-07T01:00:00.000Z", {jitter: null}),
                at("2026-08-07T02:00:00.000Z", {jitter: 4}),
                at("2026-08-07T03:00:00.000Z", {jitter: 6})
            ], DAY);
            assert.deepEqual(stats.jitter, {min: 4, max: 6, avg: 5});
        });
    });

    describe("consistency", () => {
        it("scores a perfectly stable connection at 100%", () => {
            const stats = buildStatistics([
                at("2026-08-07T01:00:00.000Z", {download: 100}),
                at("2026-08-07T02:00:00.000Z", {download: 100})
            ], DAY);
            assert.equal(stats.consistency.download.stdDev, 0);
            assert.equal(stats.consistency.download.consistency, 100);
        });

        it("scores a variable connection below 100%", () => {
            const stats = buildStatistics([
                at("2026-08-07T01:00:00.000Z", {download: 50}),
                at("2026-08-07T02:00:00.000Z", {download: 150})
            ], DAY);
            assert.ok(stats.consistency.download.consistency < 100);
            assert.equal(stats.consistency.download.stdDev, 50);
        });

        // Regression: ping.jitter was a second copy of the ping standard
        // deviation, so the real jitter column was never surfaced.
        it("derives ping.jitter from the jitter column, not from ping spread", () => {
            const stats = buildStatistics([
                at("2026-08-07T01:00:00.000Z", {ping: 10, jitter: 1}),
                at("2026-08-07T02:00:00.000Z", {ping: 90, jitter: 1})
            ], DAY);
            assert.equal(stats.consistency.ping.stdDev, 40);
            assert.equal(stats.consistency.ping.jitter, 1);
        });

        it("reports a null ping jitter when no entry has jitter data", () => {
            const stats = buildStatistics([
                at("2026-08-07T01:00:00.000Z", {jitter: null}),
                at("2026-08-07T02:00:00.000Z", {jitter: null})
            ], DAY);
            assert.equal(stats.consistency.ping.jitter, null);
        });

        it("does not divide by zero on an empty set", () => {
            const stats = buildStatistics([], DAY);
            assert.equal(stats.consistency.download.consistency, 100);
            assert.equal(stats.consistency.download.stdDev, 0);
        });
    });

    describe("hourly averages", () => {
        it("always returns 24 buckets", () => {
            assert.equal(buildStatistics([], DAY).hourlyAverages.length, 24);
        });

        it("leaves untouched hours null with a zero count", () => {
            const stats = buildStatistics([at("2026-08-07T05:30:00.000Z")], DAY);
            const empty = stats.hourlyAverages.find(entry => entry.count === 0);
            assert.equal(empty.download, null);
            assert.equal(empty.ping, null);
        });

        it("buckets entries by the hour and averages them", () => {
            const stats = buildStatistics([
                at("2026-08-07T05:10:00.000Z", {download: 100}),
                at("2026-08-07T05:50:00.000Z", {download: 200})
            ], DAY, {offsetMinutes: 0});
            const bucket = stats.hourlyAverages[5];
            assert.equal(bucket.count, 2);
            assert.equal(bucket.download, 150);
        });

        it("buckets by the client's local hour when an offset is supplied", () => {
            // 23:30Z is 01:30 the next day at UTC+2 (offset -120).
            const stats = buildStatistics(
                [at("2026-08-07T23:30:00.000Z")],
                range("2026-08-07T00:00:00.000Z", "2026-08-08T23:59:59.999Z"),
                {offsetMinutes: -120}
            );
            assert.equal(stats.hourlyAverages[1].count, 1);
            assert.equal(stats.hourlyAverages[23].count, 0);
        });
    });

    describe("chart series", () => {
        it("returns every entry in ascending time order when under the target", () => {
            const stats = buildStatistics([
                at("2026-08-07T03:00:00.000Z", {download: 300}),
                at("2026-08-07T01:00:00.000Z", {download: 100}),
                at("2026-08-07T02:00:00.000Z", {download: 200})
            ], DAY);
            assert.deepEqual(stats.data.download, [100, 200, 300]);
            assert.equal(stats.downsampled, false);
        });

        it("keeps labels, data, failed and errors the same length", () => {
            const stats = buildStatistics([
                at("2026-08-07T01:00:00.000Z"),
                at("2026-08-07T02:00:00.000Z", {error: "timeout"}),
                at("2026-08-07T03:00:00.000Z")
            ], DAY);
            const length = stats.labels.length;
            assert.equal(stats.data.download.length, length);
            assert.equal(stats.data.ping.length, length);
            assert.equal(stats.failed.length, length);
            assert.equal(stats.errors.length, length);
        });

        it("nulls the measurements of a failed entry but keeps its slot", () => {
            const stats = buildStatistics([
                at("2026-08-07T01:00:00.000Z", {download: 100}),
                at("2026-08-07T02:00:00.000Z", {download: -1, error: "timeout"})
            ], DAY);
            assert.deepEqual(stats.data.download, [100, null]);
            assert.deepEqual(stats.failed, [false, true]);
            assert.equal(stats.errors[1], "timeout");
        });

        it("downsamples above the target point count", () => {
            const many = Array.from({length: TARGET_CHART_POINTS * 2}, (_, index) =>
                at(new Date(Date.UTC(2026, 7, 7, 0, 0, 0) + index * 60_000).toISOString()));
            const stats = buildStatistics(many, DAY);
            assert.equal(stats.downsampled, true);
            assert.ok(stats.labels.length <= TARGET_CHART_POINTS);
            assert.equal(stats.data.download.length, stats.labels.length);
            assert.equal(stats.rawDataPoints, TARGET_CHART_POINTS * 2);
        });
    });

    describe("range echo", () => {
        it("reports the day span of the range", () => {
            const stats = buildStatistics([], range("2026-08-01T00:00:00.000Z", "2026-08-07T23:59:59.999Z"));
            assert.equal(stats.dateRange.days, 7);
        });
    });
});
