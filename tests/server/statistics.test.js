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

        /**
         * The latency is aggregated to the same two decimals as everything
         * beside it.
         *
         * Three places rounded it to whole milliseconds - the min/max/avg
         * tiles, the hourly buckets and the downsampled chart series - because
         * the column it came from was an INTEGER and there was nothing below
         * the millisecond to keep. Now that there is, rounding it away in the
         * aggregate would discard the measurement at the last step: an idle
         * latency that moves between 0.4 ms and 1.4 ms is exactly the movement
         * someone watching this number is looking for.
         */
        it("averages the latency to two decimals rather than whole milliseconds", () => {
            const stats = buildStatistics([
                at("2026-08-07T01:00:00.000Z", {ping: 12.6}),
                at("2026-08-07T02:00:00.000Z", {ping: 13.1}),
                at("2026-08-07T03:00:00.000Z", {ping: 12.9})
            ], DAY);

            assert.equal(stats.ping.avg, 12.87);
            assert.equal(stats.ping.min, 12.6);
            assert.equal(stats.ping.max, 13.1);
        });

        // The average moves with one bad afternoon; the middle of the range
        // does not, and the panes now state both.
        it("reports the median beside the average", () => {
            const stats = buildStatistics([
                at("2026-08-07T01:00:00.000Z", {download: 100}),
                at("2026-08-07T02:00:00.000Z", {download: 110}),
                at("2026-08-07T03:00:00.000Z", {download: 400})
            ], DAY);

            assert.equal(stats.download.median, 110);
            assert.equal(stats.download.avg, 203.33,
                "the fixture no longer demonstrates the skew the median resists");
        });

        // Regression: a range in which every test failed used to serialise as
        // Infinity/NaN, which JSON.stringify turns into null with no warning.
        it("returns null aggregates when every test failed", () => {
            const stats = buildStatistics([
                at("2026-08-07T01:00:00.000Z", {error: "timeout"}),
                at("2026-08-07T02:00:00.000Z", {error: "timeout"})
            ], DAY);
            assert.deepEqual(stats.download, {min: null, max: null, avg: null, median: null});
            assert.deepEqual(stats.ping, {min: null, max: null, avg: null, median: null});
        });

        it("returns null jitter aggregates when no entry reports jitter", () => {
            const stats = buildStatistics([
                at("2026-08-07T01:00:00.000Z", {jitter: null}),
                at("2026-08-07T02:00:00.000Z", {jitter: null})
            ], DAY);
            assert.deepEqual(stats.jitter, {min: null, max: null, avg: null, median: null});
        });

        it("aggregates only the entries that do report jitter", () => {
            const stats = buildStatistics([
                at("2026-08-07T01:00:00.000Z", {jitter: null}),
                at("2026-08-07T02:00:00.000Z", {jitter: 4}),
                at("2026-08-07T03:00:00.000Z", {jitter: 6})
            ], DAY);
            assert.deepEqual(stats.jitter, {min: 4, max: 6, avg: 5, median: 5});
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
            assert.equal(stats.consistency.ping.deviation, 40);
            assert.equal(stats.consistency.ping.jitter, 1);
        });

        /**
         * The spread a typical test sees, not the one the worst test caused.
         *
         * This figure was a standard deviation, which squares its distances:
         * a real history of 170 pings between 4 and 7 with a single spike to
         * 26 read "±1.72 ms" - the one spike carried three quarters of the
         * squared mass and nearly doubled the figure, while the typical test
         * sat within a millisecond of the middle. Medians on both steps keep
         * the outlier from speaking for the range: here the deviation is 1,
         * where the standard deviation of the same five pings is over 8.
         */
        it("reports the typical ping deviation, not the outlier's", () => {
            const stats = buildStatistics([
                at("2026-08-07T01:00:00.000Z", {ping: 4}),
                at("2026-08-07T02:00:00.000Z", {ping: 5}),
                at("2026-08-07T03:00:00.000Z", {ping: 6}),
                at("2026-08-07T04:00:00.000Z", {ping: 7}),
                at("2026-08-07T05:00:00.000Z", {ping: 26})
            ], DAY);

            assert.equal(stats.consistency.ping.deviation, 1);
        });

        /**
         * And it keeps its decimals, which every other assertion here happened
         * not to ask for.
         *
         * All of them used whole-millisecond pings and so read back whole
         * millisecond deviations, which left the precision of this figure
         * untested: rounding it to integers on the way out passed the entire
         * suite. That is the regression the card was fixed for. A deviation of
         * 0.4 ms sent as 0 is drawn as "±0 ms" - the claim that latency did not
         * move at all between two tests - and the sub-resolution branch that
         * exists to say "under 1 ms" instead becomes unreachable. It also moves
         * the grade: anything from 1.5 upwards rounds to 2 and turns the row
         * orange at a value that should still read green.
         */
        it("keeps a deviation smaller than a millisecond", () => {
            const stats = buildStatistics([
                at("2026-08-07T01:00:00.000Z", {ping: 10}),
                at("2026-08-07T02:00:00.000Z", {ping: 10.5}),
                at("2026-08-07T03:00:00.000Z", {ping: 11}),
                at("2026-08-07T04:00:00.000Z", {ping: 12})
            ], DAY);

            // Median 10.75; distances 0.75, 0.25, 0.25, 1.25; their median 0.5.
            assert.equal(stats.consistency.ping.deviation, 0.5);
        });

        // An even count has no middle test; the two nearest split the
        // difference, as every median does.
        it("splits the median between an even count of tests", () => {
            const stats = buildStatistics([
                at("2026-08-07T01:00:00.000Z", {ping: 4}),
                at("2026-08-07T02:00:00.000Z", {ping: 6}),
                at("2026-08-07T03:00:00.000Z", {ping: 10}),
                at("2026-08-07T04:00:00.000Z", {ping: 20})
            ], DAY);

            // Median 8; distances 4, 2, 2, 12; their median (2+4)/2 = 3.
            assert.equal(stats.consistency.ping.deviation, 3);
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
            assert.equal(stats.consistency.ping.deviation, null);
        });

        it("still never reports NaN from an empty set", () => {
            const {download, upload, ping} = buildStatistics([], DAY).consistency;

            for (const value of [download.consistency, download.stdDev, upload.consistency, upload.stdDev, ping.deviation])
                assert.ok(value === null || Number.isFinite(value), `got ${value}`);
        });

        /**
         * One test is a measurement but not a spread, and the speeds used to
         * answer it with "±0, 100% consistent" - a flawlessly steady line, on
         * the strength of a single reading. The same overclaim the ping
         * deviation below made, in the figure people actually read off the
         * card, so it goes the same way: nothing measured, rather than
         * perfection measured.
         */
        it("scores a single entry as having no spread to report", () => {
            const stats = buildStatistics([at("2026-08-07T01:00:00.000Z", {download: 100})], DAY);

            assert.equal(stats.consistency.download.stdDev, null);
            assert.equal(stats.consistency.download.consistency, null);
            assert.equal(stats.consistency.upload.stdDev, null);
            assert.equal(stats.consistency.upload.consistency, null);
        });

        // Two is the fewest that can disagree. Zero spread across two tests is
        // a real reading and still scores a perfect hundred.
        it("scores two identical tests as perfectly consistent", () => {
            const stats = buildStatistics([
                at("2026-08-07T01:00:00.000Z", {download: 100}),
                at("2026-08-07T02:00:00.000Z", {download: 100})
            ], DAY);

            assert.equal(stats.consistency.download.stdDev, 0);
            assert.equal(stats.consistency.download.consistency, 100);
        });

        // The single *successful* test, as with the ping: the failures around
        // it are what makes this shape common.
        it("scores nothing when only one test in the range succeeded", () => {
            const stats = buildStatistics([
                at("2026-08-07T01:00:00.000Z", {download: 100}),
                at("2026-08-07T02:00:00.000Z", {download: -1, error: "Cannot open socket"})
            ], DAY);

            assert.equal(stats.consistency.download.consistency, null);
        });

        /**
         * The ping deviation parts company with the speeds above on this one
         * point, because it is the only one of them read as a figure in its
         * own right rather than as the input to a percentage.
         *
         * "±0 ms" is the strongest claim the card can make - a line that never
         * wavered - and one test cannot support it. It is not a rare shape
         * either: a day on which the connection dropped and every test but one
         * failed lands here, which is exactly the day the card is opened.
         */
        it("reports no ping deviation from a single test rather than a perfect one", () => {
            const stats = buildStatistics([at("2026-08-07T01:00:00.000Z", {ping: 5})], DAY);

            assert.equal(stats.consistency.ping.deviation, null);
        });

        // The single *successful* test, not the single row: the failures around
        // it are what makes this shape common.
        it("reports no ping deviation when only one test in the range succeeded", () => {
            const stats = buildStatistics([
                at("2026-08-07T01:00:00.000Z", {ping: 5}),
                at("2026-08-07T02:00:00.000Z", {ping: -1, error: "Cannot open socket"}),
                at("2026-08-07T03:00:00.000Z", {ping: -1, error: "Cannot open socket"})
            ], DAY);

            assert.equal(stats.consistency.ping.deviation, null);
        });

        // Two is the fewest that can disagree, so it is the fewest that has a
        // spread to report - and zero is then a real reading, not an absent one.
        it("reports a spread from two tests, zero when they agree", () => {
            const stats = buildStatistics([
                at("2026-08-07T01:00:00.000Z", {ping: 5}),
                at("2026-08-07T02:00:00.000Z", {ping: 5})
            ], DAY);

            assert.equal(stats.consistency.ping.deviation, 0);
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

        it("keeps the latency's decimals in a bucket's average", () => {
            const stats = buildStatistics([
                at("2026-08-07T05:10:00.000Z", {ping: 0.4}),
                at("2026-08-07T05:50:00.000Z", {ping: 1.1})
            ], DAY, {offsetMinutes: 0});

            assert.equal(stats.hourlyAverages[5].ping, 0.75);
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
        const sameLengthAsLabels = (stats) => {
            assert.equal(stats.failed.length, stats.labels.length, "failed is out of step with the labels");
            assert.equal(stats.errors.length, stats.labels.length, "errors is out of step with the labels");
            for (const [metric, values] of Object.entries(stats.data))
                assert.equal(values.length, stats.labels.length, `${metric} is out of step with the labels`);
        };

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

        // The chart is the main reader of the latency, and a downsampled range
        // is where a slow drift is easiest to see - rounding each bucket to a
        // whole millisecond flattens exactly that.
        it("keeps the latency's decimals in a downsampled bucket", () => {
            const many = Array.from({length: TARGET_CHART_POINTS * 2}, (_, index) =>
                at(new Date(Date.UTC(2026, 7, 7, 0, 0, 0) + index * 60_000).toISOString(),
                    {ping: index % 2 === 0 ? 0.4 : 1.1}));
            const stats = buildStatistics(many, DAY);

            const measured = stats.data.ping.filter((value) => value !== null);
            assert.ok(measured.length > 0, "nothing was measured to check");
            assert.ok(measured.some((value) => !Number.isInteger(value)),
                `every bucket rounded to a whole millisecond: ${measured.slice(0, 5).join(", ")}`);
        });

        /**
         * `time` is the one measurement column in the bucket that is nullable,
         * and it was the one averaged without the measured-only filter its
         * neighbours use. A null folds into the sum as nothing while still
         * counting toward the divisor, so a single absent duration deflated the
         * whole bucket - and the summary figure above it, which goes through
         * mapRounded and does skip nulls, then disagreed with the chart.
         */
        it("leaves an unmeasured duration out of a bucket's average", () => {
            const many = Array.from({length: TARGET_CHART_POINTS * 2}, (unused, index) =>
                at(new Date(Date.UTC(2026, 7, 7, 0, 0, 0) + index * 60_000).toISOString(),
                    // One row in every hundred never recorded how long it took.
                    {time: index % 100 === 0 ? null : 30}));

            const stats = buildStatistics(many, DAY);
            const measured = stats.data.time.filter((value) => value !== null);

            assert.ok(measured.length > 0, "nothing was measured to check");
            assert.deepEqual([...new Set(measured)], [30],
                "a bucket holding an unmeasured duration averaged it as nought");
        });

        // And the chart agrees with the figure printed above it, which has
        // skipped nulls since mapRange was written.
        it("averages the duration the way the summary above it does", () => {
            const many = Array.from({length: TARGET_CHART_POINTS * 2}, (unused, index) =>
                at(new Date(Date.UTC(2026, 7, 7, 0, 0, 0) + index * 60_000).toISOString(),
                    {time: index % 100 === 0 ? null : 30}));

            const stats = buildStatistics(many, DAY);

            assert.equal(stats.time.avg, 30);
            assert.deepEqual([...new Set(stats.data.time.filter((value) => value !== null))], [stats.time.avg]);
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

        /**
         * The bucket a row lands in is (created - from) / bucketSize, and a range
         * of no width, a range that runs backwards, and a timestamp that does not
         * parse all turn that into a number no bounds check catches. buckets[NaN]
         * is undefined, so the push threw a TypeError and the statistics route
         * answered 500 for the whole range. The bounds are guarded here; the
         * unplaceable row is dropped before it ever reaches a bucket.
         *
         * Every set here outnumbers the requested resolution on purpose: at or
         * below it the series is returned whole and never sees a bucket at all,
         * which is what made the test this replaced pass against the crash.
         */
        describe("degenerate bounds while downsampling", () => {
            // clampPoints() refuses to go below MIN_CHART_POINTS, so this is the
            // smallest set of entries that can outnumber the buckets.
            const BUCKETED_ENTRIES = MIN_CHART_POINTS + 10;
            const ENTRY_SPACING_MS = 60_000;

            const spreadFrom = (iso) => Array.from({length: BUCKETED_ENTRIES}, (unused, index) =>
                at(new Date(new Date(iso).getTime() + index * ENTRY_SPACING_MS).toISOString()));

            // A range of no width makes bucketSize 0, and the row sitting exactly
            // on the bound then divides 0 by 0: the index is NaN, which walked
            // straight through the index < 0 / index >= targetPoints check.
            it("answers a zero-width range with an empty series rather than throwing", () => {
                const instant = "2026-08-07T12:00:00.000Z";
                const stats = buildStatistics(spreadFrom(instant), range(instant, instant),
                    {maxPoints: MIN_CHART_POINTS});

                assert.ok(stats.downsampled, "the series never went through the bucketing path");
                assert.deepEqual(stats.labels, []);
                sameLengthAsLabels(stats);
            });

            // Backwards, a negative offset divided by a negative bucket size lands
            // every row in a plausible-looking bucket, so the chart drew a line -
            // mirrored - for a window that never existed.
            // This module answers a nonsense range rather than throwing on one -
            // the route it came through is where that earns its 400 - so a bound
            // that does not parse has to be as survivable as one that is merely
            // backwards. Unguarded it makes bucketSize NaN, and every index with
            // it.
            it("returns an empty series for a range whose bounds do not parse", () => {
                const stats = buildStatistics(spreadFrom("2026-08-07T12:00:00.000Z"),
                    {from: new Date("not a date"), to: new Date("not a date")},
                    {maxPoints: MIN_CHART_POINTS});

                assert.deepEqual(stats.labels, []);
                sameLengthAsLabels(stats);
            });

            it("returns an empty series for a range whose end precedes its start", () => {
                const stats = buildStatistics(spreadFrom("2026-08-07T12:00:00.000Z"),
                    range("2026-08-07T23:59:59.999Z", "2026-08-07T00:00:00.000Z"),
                    {maxPoints: MIN_CHART_POINTS});

                assert.deepEqual(stats.labels, []);
                sameLengthAsLabels(stats);
            });

            // One corrupt row used to take the whole range with it: an unparseable
            // created offsets to NaN, and NaN survives both Math.floor and
            // Math.min.
            it("skips an entry whose timestamp does not parse and buckets the rest", () => {
                const stats = buildStatistics([
                    ...spreadFrom("2026-08-07T00:00:00.000Z"),
                    at("not a timestamp", {error: "Cannot open socket"})
                ], DAY, {maxPoints: MIN_CHART_POINTS});

                assert.ok(stats.downsampled, "the series never went through the bucketing path");
                assert.ok(stats.labels.length > 0, "the well-formed entries went out with the bad one");
                sameLengthAsLabels(stats);
                for (const value of stats.data.download) assert.equal(value, 100);
                assert.deepEqual(stats.errors.filter(error => error !== null), [],
                    "the unparseable row reached a bucket");
                assert.equal(stats.tests.failed, 1, "it is still counted, just not drawn");
            });
        });

        /**
         * The same corrupt row, down each of the other two paths that index on
         * `created`. Bucketing was only one of the three: the full series called
         * toISOString() on an Invalid Date, which throws outright, and the
         * hour-of-day averages indexed their array with the NaN hour. A range
         * small enough to be returned whole takes the first, and a *succeeded*
         * row - the downsampling case above deliberately carries an error, which
         * keeps it out of the hourly averages - takes the second.
         */
        describe("an entry whose timestamp does not parse", () => {
            const GOOD = "2026-08-07T01:00:00.000Z";

            it("is left out of a series small enough to be returned whole", () => {
                const stats = buildStatistics([at(GOOD), at("not a timestamp")], DAY);

                assert.equal(stats.downsampled, false, "this no longer covers the full-series path");
                assert.deepEqual(stats.labels, [GOOD]);
                sameLengthAsLabels(stats);
            });

            // Asserted as a total rather than against a named hour: which hour
            // the good row lands in is the server's own clock's business, and
            // the point here is only that one row was placed and one was not.
            it("is left out of the hour-of-day averages when it succeeded", () => {
                const stats = buildStatistics([at(GOOD), at("not a timestamp")], DAY);

                const measured = stats.hourlyAverages.filter(hour => hour.count > 0);
                assert.equal(measured.length, 1, "the undateable row was given an hour of its own");
                assert.equal(measured[0].count, 1, "the undateable row was counted into an hour");
            });

            // Its measurements are real - only the instant it claims is not - so
            // it is still counted and still averaged.
            it("still counts and still averages", () => {
                const stats = buildStatistics([at(GOOD, {download: 100}),
                    at("not a timestamp", {download: 200})], DAY);

                assert.equal(stats.tests.total, 2);
                assert.equal(stats.download.avg, 150);
            });

            /**
             * And it does not make the chart claim to be averaged.
             *
             * The branch is chosen on the rows that can be placed on a timeline;
             * the flag was computed from every row there is. One undateable row
             * astride the threshold made the two disagree, so the full series
             * was returned - every point drawn, nothing averaged - under a note
             * reading "Averaged · showing 300 of 301", inviting the reader to
             * ask for a detail that was already on screen.
             */
            it("does not report a whole series as averaged", () => {
                const placeable = Array.from({length: TARGET_CHART_POINTS}, (unused, index) =>
                    at(new Date(Date.UTC(2026, 7, 7, 0, 0, 0) + index * 1000).toISOString()));

                const stats = buildStatistics([...placeable, at("not a timestamp")], DAY);

                assert.equal(stats.labels.length, TARGET_CHART_POINTS, "the series was not returned whole");
                assert.equal(stats.downsampled, false,
                    "a series with every point drawn is reported to the reader as bucket averages");
            });

            it("still reports an averaged series as averaged", () => {
                const placeable = Array.from({length: TARGET_CHART_POINTS + 1}, (unused, index) =>
                    at(new Date(Date.UTC(2026, 7, 7, 0, 0, 0) + index * 1000).toISOString()));

                assert.equal(buildStatistics([...placeable, at("not a timestamp")], DAY).downsampled, true);
            });
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

        /**
         * Whatever order the rows arrive in.
         *
         * buildStatistics says in its own signature that `entries` may be in any
         * order, and everything that reads a timestamp works from a sorted copy
         * - except this, which was taken off the unfiltered input and then had
         * `slice(-10)` applied to it as though it were chronological. It was
         * only ever right because the one caller happens to query with ORDER BY
         * created ASC: a change to that clause, or a second caller, would have
         * plotted an arbitrary ten of the range in an arbitrary order, with the
         * newest test possibly absent, while every other figure stayed correct.
         */
        it("reads the same whatever order the rows arrive in", () => {
            const inOrder = buildStatistics(many, DAY).consistency.loadedLatency.trend;
            const reversed = buildStatistics([...many].reverse(), DAY).consistency.loadedLatency.trend;
            const shuffled = buildStatistics([...many.slice(7), ...many.slice(0, 7)], DAY)
                .consistency.loadedLatency.trend;

            assert.deepEqual(reversed, inOrder, "the trend followed the input order rather than the clock");
            assert.deepEqual(shuffled, inOrder);
        });

        it("still ends on the newest test when the rows arrive newest first", () => {
            const {trend} = buildStatistics([...many].reverse(), DAY).consistency.loadedLatency;

            assert.equal(trend.at(-1).increase, 23, "the newest test is not the rightmost dot");
            assert.ok(trend[0].created < trend.at(-1).created);
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
 * What the testing itself cost in traffic. Every provider stores the bytes a
 * run moved; the summary was the one reader that never looked at them.
 */
describe("data used", () => {
    it("sums both directions over the rows that measured them", () => {
        const stats = buildStatistics([
            at("2026-08-07T01:00:00.000Z", {bytesDownloaded: 1000, bytesUploaded: 400}),
            at("2026-08-07T02:00:00.000Z", {bytesDownloaded: 2500, bytesUploaded: 600})
        ], DAY);

        assert.deepEqual(stats.dataUsed, {download: 3500, upload: 1000, total: 4500});
    });

    // Rows from before the transfer columns existed say nothing, not nought.
    it("answers null rather than zero when nothing measured it", () => {
        const stats = buildStatistics([at("2026-08-07T01:00:00.000Z")], DAY);

        assert.deepEqual(stats.dataUsed, {download: null, upload: null, total: null});
    });

    // A history straddling the columns' arrival sums what was measured: a
    // lower bound, not a claim about the rows that said nothing.
    it("keeps a lower bound when only some rows measured it", () => {
        const stats = buildStatistics([
            at("2026-08-07T01:00:00.000Z", {bytesDownloaded: 1000, bytesUploaded: 400}),
            at("2026-08-07T02:00:00.000Z")
        ], DAY);

        assert.deepEqual(stats.dataUsed, {download: 1000, upload: 400, total: 1400});
    });

    // A failure that moved data still moved it - the figure is about traffic,
    // not about success, which is why it sums entries rather than successes.
    it("counts a failed run that still moved data", () => {
        const stats = buildStatistics([
            at("2026-08-07T01:00:00.000Z", {error: "timeout", download: -1, bytesDownloaded: 800, bytesUploaded: 100}),
            at("2026-08-07T02:00:00.000Z", {bytesDownloaded: 200, bytesUploaded: 50})
        ], DAY);

        assert.deepEqual(stats.dataUsed, {download: 1000, upload: 150, total: 1150});
    });

    it("totals a direction the provider never reported as the other alone", () => {
        const stats = buildStatistics([
            at("2026-08-07T01:00:00.000Z", {bytesDownloaded: 1200})
        ], DAY);

        assert.deepEqual(stats.dataUsed, {download: 1200, upload: null, total: 1200});
    });

    /**
     * A negative byte count is not traffic. The live path cannot store one -
     * byteCount refuses it - but a history imported before the import learned
     * the same rule can hold -1 placeholders, and summed as bytes each one
     * *subtracts* from the total the panel prints as what the testing cost.
     */
    it("keeps a negative placeholder out of the total", () => {
        const stats = buildStatistics([
            at("2026-08-07T01:00:00.000Z", {bytesDownloaded: -1, bytesUploaded: -1}),
            at("2026-08-07T02:00:00.000Z", {bytesDownloaded: 200, bytesUploaded: 50})
        ], DAY);

        assert.deepEqual(stats.dataUsed, {download: 200, upload: 50, total: 250});
    });
});

/**
 * What the full-resolution series draws for a quality figure nothing measured.
 *
 * The live path stores null for those - usableFigure - but a history imported
 * before the import learned the same rule can hold the -1 placeholders, and
 * the series passed them through: a jitter dipping to minus one millisecond,
 * drawn as a reading on a chart whose summary above skipped the same row.
 */
describe("an imported negative quality figure on the chart", () => {
    it("is a gap, the way an unmeasured one is", () => {
        const stats = buildStatistics([
            at("2026-08-07T01:00:00.000Z", {jitter: -1, downloadLatency: -3, uploadLatency: -2})
        ], DAY);

        assert.deepEqual(stats.data.jitter, [null]);
        assert.deepEqual(stats.data.downloadLatency, [null]);
        assert.deepEqual(stats.data.uploadLatency, [null]);
    });

    it("leaves the measured figures beside it alone", () => {
        const stats = buildStatistics([
            at("2026-08-07T01:00:00.000Z", {jitter: 2.5, downloadLatency: 41, uploadLatency: 60})
        ], DAY);

        assert.deepEqual(stats.data.jitter, [2.5]);
        assert.deepEqual(stats.data.downloadLatency, [41]);
        assert.deepEqual(stats.data.uploadLatency, [60]);
    });

    /**
     * And the same answer once the range is wide enough to be bucketed. The
     * guard sat only on the full-resolution branch, so the identical data
     * answered two ways depending on row count: 300 rows drew gaps, 301 rows
     * bucketed the -1 placeholders into every average they touched and the
     * jitter dipped below zero again.
     */
    it("stays out of the buckets when the range is downsampled", () => {
        // One placeholder row alone in the first bucket - averaged with
        // nothing, so a filter that admits it answers exactly -1 - and enough
        // clean rows later in the day to force the downsampled branch.
        const FILLER_ROWS = 60;
        const entries = [
            at("2026-08-07T00:10:00.000Z",
                {jitter: -1, downloadLatency: -3, uploadLatency: -2, time: -5}),
            ...Array.from({length: FILLER_ROWS}, (unused, index) =>
                at(`2026-08-07T12:${String(index).padStart(2, "0")}:00.000Z`,
                    {jitter: 2, downloadLatency: 40, uploadLatency: 50, time: 30}))
        ];

        const stats = buildStatistics(entries, DAY, {maxPoints: 50});

        assert.equal(stats.downsampled, true, "the range was not bucketed, so this holds nothing");
        for (const key of ["jitter", "downloadLatency", "uploadLatency", "time"])
            for (const value of stats.data[key])
                assert.ok(value === null || value >= 0,
                    `a bucketed ${key} average was dragged below its readings by a placeholder`);
    });
});

/**
 * A non-number stored in a numeric column does not turn an average into
 * string concatenation.
 *
 * sqlite is typeless: a history imported before the columns were checked, or a
 * live run that stored a NaN as the literal string "NaN", can leave a string
 * where a double belongs. `total + "NaN"` concatenates, so one such row on an
 * otherwise-100 line reported a download average in the tens of trillions, a
 * consistency of 0% with an eight-figure spread, and a chart point at 8.6e13.
 */
describe("a corrupt stored number", () => {
    // The string upload sits deliberately off the mean of its neighbours: a
    // value that happens to equal the filtered mean contributes a squared
    // deviation of zero, and the asymmetry this suite pins cancels invisibly -
    // which is exactly how the first cut of these fixtures stayed green over
    // the bug.
    const rows = [
        at("2026-08-07T01:00:00.000Z", {download: 100, upload: 100}),
        at("2026-08-07T02:00:00.000Z", {download: "NaN", upload: "600"}),
        at("2026-08-07T03:00:00.000Z", {download: 300, upload: 300})
    ];

    /**
     * The one row that is genuinely unreadable drops out; the readings either
     * side of it keep their exact figures. The first cut of this guard asserted
     * only "finite and under a thousand", which passed whether the answer was
     * honest or fabricated - and it was fabricated: the raw row count let the
     * two-value gate pass while the arithmetic ran on fewer.
     */
    it("keeps the readable readings and drops only the corrupt one", () => {
        const stats = buildStatistics(rows, DAY, {offsetMinutes: 0});

        assert.deepEqual(stats.consistency.download, {stdDev: 100, consistency: 50},
            "the corrupt row dragged the spread or thinned the mean");
        assert.deepEqual(stats.download, {min: 100, max: 300, avg: 200, median: 200});
    });

    /**
     * "200" is an imported history's spelling of 200 - sqlite is typeless, and
     * metricValue documents that population as measurements somebody took. The
     * alert gate, Prometheus and the failure predicates all read it as a
     * number; the summary refusing it made the same row measured and absent at
     * once.
     */
    it("reads a numeric string as the measurement it records", () => {
        const stats = buildStatistics(rows, DAY, {offsetMinutes: 0});

        assert.deepEqual(stats.upload, {min: 100, max: 600, avg: 333.33, median: 300},
            "a numeric string is excluded from the range it belongs to");
        assert.equal(stats.consistency.upload.stdDev, 205.48);
        assert.equal(stats.consistency.upload.consistency, 38.4);
    });

    // The mean filtered its population while the squared deviations coerced
    // theirs, so a numeric string was absent from one and huge in the other.
    it("gives a coerced string the same weight in the mean and the spread", () => {
        const stats = buildStatistics([
            at("2026-08-07T01:00:00.000Z", {download: 100}),
            at("2026-08-07T02:00:00.000Z", {download: "200"})
        ], DAY);

        assert.deepEqual(stats.consistency.download, {stdDev: 50, consistency: 66.7},
            "the string sat in the spread but not the mean, or the other way round");
    });

    it("counts an hour by the readings its average used", () => {
        const stats = buildStatistics(rows, DAY, {offsetMinutes: 0});
        const byHour = (hour) => stats.hourlyAverages.find((bucket) => bucket.hour === hour);

        assert.deepEqual({download: byHour(1).download, count: byHour(1).count}, {download: 100, count: 1});
        // The corrupt hour: no readable download, and the count says so rather
        // than presenting the absence as backed by a test.
        assert.deepEqual({download: byHour(2).download, count: byHour(2).count}, {download: null, count: 0});
        // Its numeric-string upload is still that hour's real reading.
        assert.equal(byHour(2).upload, 600);
    });

    /**
     * Nothing measured is not a perfect line. The raw-count gate let an
     * all-corrupt pair through to a mean of nothing, and `NaN > 0` is false -
     * so the fallback scored the emptiness a flawless 100 with a stdDev JSON
     * hides as null. One readable row beside one corrupt is the same overclaim
     * with a mean: a lone reading deviates from itself by nothing, and the
     * two-value gate exists to refuse exactly that claim.
     */
    it("answers nothing measured over rows holding no readable value", () => {
        const stats = buildStatistics([
            at("2026-08-07T01:00:00.000Z", {download: "NaN"}),
            at("2026-08-07T02:00:00.000Z", {download: "NaN"})
        ], DAY);

        assert.deepEqual(stats.consistency.download, {stdDev: null, consistency: null},
            "two unreadable rows scored as a flawlessly stable line");
    });

    it("refuses the lone-reading overclaim when the other row is corrupt", () => {
        const stats = buildStatistics([
            at("2026-08-07T01:00:00.000Z", {download: 100}),
            at("2026-08-07T02:00:00.000Z", {download: "NaN"})
        ], DAY);

        assert.deepEqual(stats.consistency.download, {stdDev: null, consistency: null},
            "a single readable reading reported itself 100% consistent, ±0");
    });

    /**
     * The full-resolution series speaks the same language as the downsampled
     * one. Below targetPoints the rows used to go into the payload raw, so a
     * stored "50" reached the client as a JSON string - convertSpeed refuses a
     * non-number and drew the point 8x too high under a MB/s preference, and
     * the chart's own average line string-concatenated it into an eight-figure
     * number: the exact total-plus-value bug this file fixed server-side,
     * reproduced in the browser, on every range small enough not to bucket.
     */
    it("ships the full series as numbers, never raw strings", () => {
        const stats = buildStatistics([
            at("2026-08-07T01:00:00.000Z", {download: 100, upload: 50}),
            at("2026-08-07T02:00:00.000Z", {download: "50", upload: "25"})
        ], DAY);

        assert.equal(stats.downsampled, false, "two rows were bucketed, so the raw path went untested");
        assert.deepEqual(stats.data.download, [100, 50],
            "a numeric-string row reaches the client payload as a string");
        assert.deepEqual(stats.data.upload, [50, 25]);
    });

    it("draws a gap for a full-series value nothing can read", () => {
        const stats = buildStatistics([
            at("2026-08-07T01:00:00.000Z", {download: 100}),
            at("2026-08-07T02:00:00.000Z", {download: "NaN"})
        ], DAY);

        assert.deepEqual(stats.data.download, [100, null],
            "an unreadable value is shipped raw instead of drawn as the gap the chart knows");
    });

    /**
     * The ping came along too. isMeasuredLatency asks typeof first - rightly,
     * for the fabricated-zero question it answers - so a numeric-string ping
     * was the one column still measured-and-absent-at-once: counted by
     * Prometheus off the same row while every statistics reader dropped it.
     * Read through metricValue before that gate, the way the other columns are.
     */
    it("reads a numeric-string ping everywhere the other columns are read", () => {
        const stats = buildStatistics([
            at("2026-08-07T01:00:00.000Z", {ping: 20}),
            at("2026-08-07T02:00:00.000Z", {ping: "40"})
        ], DAY, {offsetMinutes: 0});

        assert.equal(stats.ping.max, 40, "the summary range never saw the string ping");
        assert.deepEqual(stats.data.ping, [20, 40], "the chart drew a gap over a measured ping");
        assert.equal(stats.hourlyAverages.find((bucket) => bucket.hour === 2).ping, 40);
        // Two readings now: median 30, distances [10, 10], their median 10.
        assert.equal(stats.consistency.ping.deviation, 10,
            "the spread saw one reading where the range shows two");
    });

    it("does not blow up a downsampled chart point", () => {
        const many = Array.from({length: 60}, (unused, index) =>
            at(`2026-08-07T04:${String(index).padStart(2, "0")}:00.000Z`,
                index === 0 ? {download: "NaN"} : {download: 100}));

        const stats = buildStatistics(many, DAY, {maxPoints: 50});

        assert.equal(stats.downsampled, true);
        for (const point of stats.data.download)
            assert.ok(point === null || (Number.isFinite(point) && point < 1e6),
                "a bucket average concatenated a stored 'NaN'");
    });
});

/**
 * The summary beside the chart, asked the same question. The gap fix cited a
 * summary that "skipped the same row", and it did not: the jitter and packet
 * loss filters asked only for null, so the -1 placeholders set every minimum
 * and dragged every average - the panel disagreeing with the chart under it.
 */
describe("an imported negative quality figure in the summary", () => {
    const rows = [
        at("2026-08-07T01:00:00.000Z", {jitter: -1, packetLoss: -2, downloadLatency: -3, uploadLatency: -1}),
        at("2026-08-07T02:00:00.000Z", {jitter: 2, packetLoss: 0.5, downloadLatency: 40, uploadLatency: 60})
    ];

    it("does not set the minimum or drag the average", () => {
        const stats = buildStatistics(rows, DAY);

        assert.equal(stats.jitter.min, 2, "the placeholder is the range's lowest jitter");
        assert.equal(stats.jitter.avg, 2);
        assert.equal(stats.packetLoss, 0.5, "the placeholder halved the packet loss");
        assert.equal(stats.consistency.ping.jitter, 2);
    });

    it("stays out of the hourly buckets", () => {
        const stats = buildStatistics(rows, DAY, {offsetMinutes: 0});
        const one = stats.hourlyAverages.find((bucket) => bucket.hour === 1);

        assert.equal(one.jitter, null,
            "the placeholder is an hour's whole jitter reading");
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
