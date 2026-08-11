import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTimezone } from "../../server/util/timezone.js";
import {
    buildStatistics, MAX_CHART_POINTS, MIN_CHART_POINTS, STATISTICS_COLUMNS, TARGET_CHART_POINTS
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
         * The loaded-latency series feed the ping chart, where idle and
         * under-load latency share an axis. Unmeasured tests stay null - a gap
         * in the line - and a downsampled bucket averages only what was
         * measured, exactly as jitter already does.
         */
        describe("loaded latency series", () => {
            it("carries both directions per point, null where unmeasured", () => {
                const stats = buildStatistics([
                    at("2026-08-07T01:00:00.000Z", {downloadLatency: 7.5, uploadLatency: 44}),
                    at("2026-08-07T02:00:00.000Z", {downloadLatency: null, uploadLatency: null})
                ], DAY);

                assert.deepEqual(stats.data.downloadLatency, [7.5, null]);
                assert.deepEqual(stats.data.uploadLatency, [44, null]);
            });

            it("nulls the series for a failed test like every other metric", () => {
                const stats = buildStatistics([
                    at("2026-08-07T01:00:00.000Z", {ping: -1, download: -1, upload: -1,
                        downloadLatency: null, uploadLatency: null, error: "Cannot open socket"})
                ], DAY);

                assert.deepEqual(stats.data.downloadLatency, [null]);
            });

            it("averages only the measured tests within a downsampled bucket", () => {
                // More entries than the minimum chart resolution, so the series
                // genuinely goes through the bucketing path. Every measured test
                // says 40; every other test measured nothing. A bucket that let
                // the nulls drag its average would report 20.
                const entries = Array.from({length: MIN_CHART_POINTS + 10}, (_, i) =>
                    at(new Date(Date.UTC(2026, 7, 7, 0, i * 20)).toISOString(),
                        {uploadLatency: i % 2 === 0 ? 40 : null}));

                const stats = buildStatistics(entries, DAY, {maxPoints: MIN_CHART_POINTS});

                assert.ok(stats.downsampled, "the series never went through the bucketing path");
                const measured = stats.data.uploadLatency.filter(value => value !== null);
                assert.ok(measured.length > 0, "no bucket carried a measured value");
                for (const value of measured) assert.equal(value, 40);
            });
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

        /**
         * The offset the client sends is a snapshot of today. Over a range that
         * reaches across a daylight saving change it credits half the tests to
         * the wrong hour, which is enough for the overview to name the wrong
         * hour as the slowest of the day.
         */
        it("buckets by the zone's own clock on each side of a daylight saving change", () => {
            const zone = resolveTimezone({tz: "Europe/Berlin"}).zone;
            const stats = buildStatistics(
                [at("2026-08-10T18:30:00.000Z"), at("2026-01-10T18:30:00.000Z")],
                range("2026-01-01T00:00:00.000Z", "2026-12-31T23:59:59.999Z"),
                {zone}
            );

            assert.equal(stats.hourlyAverages[20].count, 1, "the summer test belongs to 20:00 CEST");
            assert.equal(stats.hourlyAverages[19].count, 1, "the winter test belongs to 19:00 CET");
        });

        // #21's crash: the bound lived inside parseDateRange, which range=all
        // skips, so an absurd offset reached the bucketing and indexed the
        // array with NaN.
        it("does not throw on an offset outside any real zone", () => {
            assert.doesNotThrow(() => buildStatistics([at("2026-08-07T05:30:00.000Z")], DAY,
                {offsetMinutes: "99999999999999"}));
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

    /**
     * The echo is listStatistics', because only it knows which window was
     * covered: all time is answered over the extent of the tests rather than
     * over the range asked for.
     *
     * This used to claim a dateRange of its own, holding a day count, and the
     * controller spread its own over the top one line later - so the figure was
     * computed on every statistics request and thrown away before the response
     * was written. Anything put back here meets the same fate silently.
     */
    describe("range echo", () => {
        it("leaves the echo to the caller rather than being overwritten", () => {
            const stats = buildStatistics([], range("2026-08-01T00:00:00.000Z", "2026-08-07T23:59:59.999Z"));

            assert.equal(stats.dateRange, undefined);
        });
    });
});

/**
 * The consistency panel reports every other figure over the whole selected
 * range, and reported bufferbloat as the grade of the single newest test -
 * from a request that carried no date range at all. Beside three range-wide
 * aggregates that reads as a claim it was not making, and changing the range
 * left it untouched.
 *
 * Averaged over the tests that measured it, exactly as packet loss is. Only
 * Ookla reports loaded latency, so the rows that could not measure it must not
 * drag the mean, and a range where nothing measured any has no figure at all -
 * absence is not a flawless line.
 */
describe("loaded latency over the range", () => {
    const loaded = (iso, ping, down, up) =>
        at(iso, {ping, downloadLatency: down, uploadLatency: up});

    it("averages the added latency across the range", () => {
        const stats = buildStatistics([
            // worse direction 50, idle 10 -> 40 added
            loaded("2026-08-07T01:00:00.000Z", 10, 50, 20),
            // worse direction 30, idle 10 -> 20 added
            loaded("2026-08-07T02:00:00.000Z", 10, 12, 30)
        ], DAY);

        assert.equal(stats.consistency.loadedLatency.increase, 30);
        assert.equal(stats.consistency.loadedLatency.tests, 2);
    });

    // The grade takes the worse direction, so the average has to as well - a
    // line clean downstream and buffered upstream is a buffered line.
    it("takes the worse direction of each test, not the two averaged together", () => {
        const stats = buildStatistics([
            loaded("2026-08-07T01:00:00.000Z", 10, 110, 20),
            loaded("2026-08-07T02:00:00.000Z", 10, 20, 110)
        ], DAY);

        assert.equal(stats.consistency.loadedLatency.increase, 100);
    });

    it("ignores tests that measured no loaded latency", () => {
        const stats = buildStatistics([
            loaded("2026-08-07T01:00:00.000Z", 10, 50, 20),
            at("2026-08-07T02:00:00.000Z"),
            at("2026-08-07T03:00:00.000Z", {downloadLatency: 40, uploadLatency: null})
        ], DAY);

        assert.equal(stats.consistency.loadedLatency.increase, 40);
        assert.equal(stats.consistency.loadedLatency.tests, 1);
    });

    it("ignores failed tests and their placeholders", () => {
        const stats = buildStatistics([
            loaded("2026-08-07T01:00:00.000Z", 10, 50, 20),
            at("2026-08-07T02:00:00.000Z", {ping: -1, downloadLatency: -1, uploadLatency: -1,
                error: "Timeout"})
        ], DAY);

        assert.equal(stats.consistency.loadedLatency.increase, 40);
        assert.equal(stats.consistency.loadedLatency.tests, 1);
    });

    it("has no figure when nothing in the range measured it", () => {
        const stats = buildStatistics([at("2026-08-07T01:00:00.000Z")], DAY);

        assert.equal(stats.consistency.loadedLatency.increase, null);
        assert.equal(stats.consistency.loadedLatency.tests, 0);
    });

    it("has no figure for an empty range", () => {
        const stats = buildStatistics([], DAY);

        assert.equal(stats.consistency.loadedLatency.increase, null);
    });

    // Under the idle ping is measurement noise, not an improvement, so it
    // floors at zero rather than pulling the average down.
    it("does not let a negative reading pull the average below zero", () => {
        const stats = buildStatistics([
            loaded("2026-08-07T01:00:00.000Z", 50, 10, 10),
            loaded("2026-08-07T02:00:00.000Z", 10, 30, 10)
        ], DAY);

        assert.equal(stats.consistency.loadedLatency.increase, 10);
    });

    describe("the recent gradings beneath it", () => {
        const many = Array.from({length: 14}, (_, index) =>
            loaded(`2026-08-07T${String(index + 1).padStart(2, "0")}:00:00.000Z`, 10, 20 + index, 15));

        it("reports the newest few, oldest first", () => {
            const {trend} = buildStatistics(many, DAY).consistency.loadedLatency;

            assert.equal(trend.length, 10);
            assert.ok(trend[0].created < trend.at(-1).created, "time has to read left to right");
            // The last of the fourteen: 20 + 13 worse direction, idle 10.
            assert.equal(trend.at(-1).increase, 23);
        });

        it("carries only the tests that measured it", () => {
            const {trend} = buildStatistics([
                loaded("2026-08-07T01:00:00.000Z", 10, 50, 20),
                at("2026-08-07T02:00:00.000Z")
            ], DAY).consistency.loadedLatency;

            assert.equal(trend.length, 1);
            assert.equal(trend[0].increase, 40);
        });

        it("is empty when nothing measured it", () => {
            assert.deepEqual(buildStatistics([at("2026-08-07T01:00:00.000Z")], DAY)
                .consistency.loadedLatency.trend, []);
        });
    });
});

/**
 * A wide range holds every row it summarises in memory at once, and most of a
 * row's weight is text this module never looks at - a server name, a hostname,
 * an ISP, a result URL. The controller selects only the columns named here, so
 * the list has to stay exactly what the code below reads: a column added to the
 * aggregation but not to the list arrives as undefined, which is silent.
 *
 * Scanned from the source rather than asserted by hand for the same reason -
 * a hand-written list is only right on the day it is written.
 */
describe("STATISTICS_COLUMNS", () => {
    const source = fs.readFileSync(
        path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "server", "util", "statistics.js"),
        "utf8");

    const columnsRead = () =>
        new Set([...source.matchAll(/\bentry\.([a-zA-Z][a-zA-Z0-9_]*)/g)].map(([, column]) => column));

    it("finds the property reads to check", () => {
        assert.ok(columnsRead().size > 5, "expected the scanner to find the columns");
    });

    it("names every column the aggregation reads", () => {
        const missing = [...columnsRead()].filter((column) => !STATISTICS_COLUMNS.includes(column));

        assert.deepEqual(missing, [], "these are read but would not be selected");
    });

    it("names nothing the aggregation does not read", () => {
        const unused = STATISTICS_COLUMNS.filter((column) => !columnsRead().has(column));

        assert.deepEqual(unused, [], "these are selected but never read");
    });
});
