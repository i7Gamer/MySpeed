import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    buildStatistics, MAX_CHART_POINTS, MIN_CHART_POINTS, TARGET_CHART_POINTS
} from "../../server/util/statistics.js";

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

        /**
         * The range average of packet loss, over the tests that measured it.
         * Only Ookla reports one, so the unmeasured rows must not drag the
         * average - and a clean line's zeroes are measurements, not gaps.
         */
        describe("packet loss", () => {
            it("averages the tests that measured it", () => {
                const stats = buildStatistics([
                    at("2026-08-07T01:00:00.000Z", {packetLoss: 0}),
                    at("2026-08-07T02:00:00.000Z", {packetLoss: 1.5}),
                    at("2026-08-07T03:00:00.000Z", {packetLoss: null})
                ], DAY);

                assert.equal(stats.packetLoss, 0.75);
            });

            it("keeps a clean line's zero as a zero", () => {
                const stats = buildStatistics([at("2026-08-07T01:00:00.000Z", {packetLoss: 0})], DAY);

                assert.equal(stats.packetLoss, 0);
            });

            it("is absent when nothing in the range measured it", () => {
                const stats = buildStatistics([at("2026-08-07T01:00:00.000Z", {packetLoss: null})], DAY);

                assert.equal(stats.packetLoss, null);
            });

            it("ignores failed tests rather than averaging their placeholders", () => {
                const stats = buildStatistics([
                    at("2026-08-07T01:00:00.000Z", {packetLoss: 2}),
                    at("2026-08-07T02:00:00.000Z", {ping: -1, download: -1, upload: -1,
                        packetLoss: null, error: "Cannot open socket"})
                ], DAY);

                assert.equal(stats.packetLoss, 2);
            });
        });

        it("reports a null ping jitter when no entry has jitter data", () => {
            const stats = buildStatistics([
                at("2026-08-07T01:00:00.000Z", {jitter: null}),
                at("2026-08-07T02:00:00.000Z", {jitter: null})
            ], DAY);
            assert.equal(stats.consistency.ping.jitter, null);
        });

        /**
         * The guard against dividing by zero stands; what it answered with did
         * not. An empty set used to score 100% with a deviation of ±0, which
         * reads as a flawlessly stable connection - the strongest claim the tile
         * can make, made from no measurements at all.
         */
        it("scores nothing on an empty set rather than scoring it perfect", () => {
            const stats = buildStatistics([], DAY);

            assert.equal(stats.consistency.download.consistency, null);
            assert.equal(stats.consistency.download.stdDev, null);
            assert.equal(stats.consistency.upload.consistency, null);
            assert.equal(stats.consistency.ping.stdDev, null);
        });

        it("still never reports NaN from an empty set", () => {
            const {download, upload, ping} = buildStatistics([], DAY).consistency;

            for (const value of [download.consistency, download.stdDev, upload.consistency, upload.stdDev, ping.stdDev])
                assert.ok(value === null || Number.isFinite(value), `got ${value}`);
        });

        // One test is a measurement but not a spread - it deviates from itself
        // by nothing, which is a real answer rather than an absent one.
        it("scores a single entry as having no deviation", () => {
            const stats = buildStatistics([at("2026-08-07T01:00:00.000Z", {download: 100})], DAY);

            assert.equal(stats.consistency.download.stdDev, 0);
            assert.equal(stats.consistency.download.consistency, 100);
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

    /**
     * The detail view lets the reader trade payload size for resolution, so the
     * threshold between "every test" and "bucket averages" has to move with the
     * request rather than sitting on a constant.
     */
    describe("requested resolution", () => {
        const spread = (count) => Array.from({length: count}, (unused, index) =>
            at(new Date(Date.UTC(2026, 7, 7, 0, 0, 0) + index * 60_000).toISOString()));

        it("defaults to the standard target", () => {
            assert.equal(buildStatistics([], DAY).maxDataPoints, TARGET_CHART_POINTS);
        });

        it("returns every entry when the request covers them all", () => {
            const stats = buildStatistics(spread(400), DAY, {maxPoints: 500});

            assert.equal(stats.downsampled, false);
            assert.equal(stats.labels.length, 400);
        });

        // The same data at the default resolution is bucketed, which is what
        // makes the control worth having.
        it("still downsamples the same data at the default", () => {
            assert.equal(buildStatistics(spread(400), DAY).downsampled, true);
        });

        it("downsamples to the requested count when the data exceeds it", () => {
            const stats = buildStatistics(spread(400), DAY, {maxPoints: 100});

            assert.equal(stats.downsampled, true);
            assert.ok(stats.labels.length <= 100, `got ${stats.labels.length} labels`);
            assert.equal(stats.data.download.length, stats.labels.length);
        });

        describe("clamping", () => {
            it("refuses to go below the floor", () => {
                assert.equal(buildStatistics([], DAY, {maxPoints: 1}).maxDataPoints, MIN_CHART_POINTS);
            });

            // Allocating one bucket per requested point is why this cannot be
            // taken on trust from a query parameter.
            it("refuses to go above the ceiling", () => {
                assert.equal(buildStatistics([], DAY, {maxPoints: 5_000_000}).maxDataPoints, MAX_CHART_POINTS);
            });

            it("ignores a value that is not a number", () => {
                for (const value of ["abc", null, undefined, NaN, Infinity, {}])
                    assert.equal(buildStatistics([], DAY, {maxPoints: value}).maxDataPoints, TARGET_CHART_POINTS,
                        `maxPoints ${String(value)} should fall back to the default`);
            });

            // The query string hands everything over as a string.
            it("reads a numeric string", () => {
                assert.equal(buildStatistics([], DAY, {maxPoints: "750"}).maxDataPoints, 750);
            });

            it("truncates a fractional request rather than allocating a fraction of a bucket", () => {
                assert.equal(buildStatistics([], DAY, {maxPoints: 500.9}).maxDataPoints, 500);
            });
        });
    });

    describe("range echo", () => {
        it("reports the day span of the range", () => {
            const stats = buildStatistics([], range("2026-08-01T00:00:00.000Z", "2026-08-07T23:59:59.999Z"));
            assert.equal(stats.dateRange.days, 7);
        });
    });
});
