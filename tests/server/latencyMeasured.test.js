import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildStatistics, TARGET_CHART_POINTS } from "../../server/util/statistics.js";
import { resolveTimezone } from "../../server/util/timezone.js";
import { isMeasuredLatency, measuredPing, UNMEASURED_LATENCY } from "../../server/util/testOutcome.js";
import { readSource } from "../helpers/source.js";

/**
 * A latency of exactly zero is a fabrication, not a reading.
 *
 * parseCloudflare answers `round(avg_latency_ms) ?? 0` on its success path, so
 * a run whose latency block carried no average stores a 0 - and no connection
 * produces one. Real sub-millisecond lines store the decimals they measured:
 * the column has held them since migration 0010, and a genuine 0.24 arrives as
 * 0.24. Only the fabricated value lands on exactly zero, which is why the
 * comparison has to stay exact - widened to "under a millisecond" it would
 * swallow every fibre and LAN reading with it.
 *
 * The alert gate has judged it this way all along; the statistics did not, so
 * one such row dragged the reported average toward zero and the two halves of
 * the same instance disagreed about the same test. The judgement now has one
 * home that both read.
 */
describe("isMeasuredLatency", () => {
    it("refuses the fabricated zero", () => {
        assert.equal(isMeasuredLatency(UNMEASURED_LATENCY), false);
        assert.equal(isMeasuredLatency(0), false);
    });

    it("keeps a real sub-millisecond reading", () => {
        assert.equal(isMeasuredLatency(0.24), true);
        assert.equal(isMeasuredLatency(0.4), true);
    });

    it("keeps an ordinary reading", () => {
        assert.equal(isMeasuredLatency(23.4), true);
    });

    it("refuses what is not a reading at all", () => {
        for (const value of [null, undefined, NaN, "23", {}])
            assert.equal(isMeasuredLatency(value), false, `${JSON.stringify(value)} was read as a latency`);
    });
});

/**
 * The whole question - "was this ping measured?" - as one exported reader.
 *
 * It was being assembled twice: the statistics coerced with usableFigure and
 * then asked isMeasuredLatency, the recommendation sample asked
 * isMeasuredLatency of an already-coerced value and refused the placeholder
 * with a comparison of its own. The two spellings agreed, and the comments on
 * each even said so - but agreement held by prose is exactly how the alert
 * gate and the statistics came to disagree about the fabricated zero in the
 * first place. One home, both readers.
 */
describe("measuredPing", () => {
    it("hands back a real reading, coerced the way every column is", () => {
        assert.equal(measuredPing(23.4), 23.4);
        assert.equal(measuredPing(0.24), 0.24, "a real sub-millisecond line");
        assert.equal(measuredPing("23.4"), 23.4, "the defensive numeric-string spelling");
    });

    it("refuses everything that is not a measured ping", () => {
        assert.equal(measuredPing(UNMEASURED_LATENCY), null, "the fabricated zero");
        assert.equal(measuredPing("0"), null, "the fabricated zero, spelt as text");
        assert.equal(measuredPing(-1), null, "the failure placeholder");
        assert.equal(measuredPing("-1"), null, "the placeholder, spelt as text");
        for (const value of [null, undefined, NaN, Infinity, "auto", "", {}])
            assert.equal(measuredPing(value), null, `${JSON.stringify(value)} was read as a ping`);
    });

    // The single home, held at the source: both consumers read through the
    // export, and neither keeps a spelling of its own to drift on.
    it("is the judgement the statistics read", () => {
        const statistics = readSource("server/util/statistics.js");

        assert.match(statistics, /import \{[^}]*\bmeasuredPing\b[^}]*\} from ["']\.\/testOutcome\.js["']/,
            "the statistics no longer read the shared judgement");
        assert.doesNotMatch(statistics, /const measuredPing\s*=/,
            "the statistics keep a spelling of their own beside the shared one");
    });

    it("is the judgement the recommendation sample reads", () => {
        const speedtest = readSource("server/tasks/speedtest.js");
        const [line] = speedtest.match(/const lowestRealPing = [^\n]+/) ?? [""];

        assert.match(line, /measuredPing\(/,
            "lowestRealPing spells the judgement out instead of asking it");
    });
});

/**
 * And the aggregation leaves it out of every ping figure, the way it already
 * leaves an unmeasured jitter out of the jitter ones.
 */
describe("a range holding a fabricated latency", () => {
    const at = (created, ping) => ({
        created, ping, download: 100, upload: 50, time: 10, jitter: null,
        packetLoss: null, downloadLatency: null, uploadLatency: null, error: null
    });

    const RANGE = {from: new Date("2026-08-01T00:00:00.000Z"), to: new Date("2026-08-01T23:59:59.999Z")};

    const zone = resolveTimezone({tz: "UTC"}).zone;
    const statistics = (entries) => buildStatistics(entries, RANGE, {zone});

    it("averages only the pings that were measured", () => {
        const {ping} = statistics([
            at("2026-08-01T10:00:00.000Z", 20),
            at("2026-08-01T11:00:00.000Z", 30),
            at("2026-08-01T12:00:00.000Z", 0)
        ]);

        assert.equal(ping.avg, 25, "the fabricated zero was averaged as a 0 ms reading");
        assert.equal(ping.min, 20, "the fabricated zero was reported as the best latency of the range");
    });

    it("leaves it out of the hourly buckets too", () => {
        const {hourlyAverages} = statistics([
            at("2026-08-01T10:00:00.000Z", 20),
            at("2026-08-01T10:30:00.000Z", 0)
        ]);

        assert.equal(hourlyAverages[10].ping, 20, "the hour's latency was halved by a value nobody measured");
    });

    it("leaves it out of the spread", () => {
        const spread = (entries) => statistics(entries).consistency.ping.deviation;
        const measured = [
            at("2026-08-01T10:00:00.000Z", 20),
            at("2026-08-01T11:00:00.000Z", 22),
            at("2026-08-01T12:00:00.000Z", 21)
        ];

        assert.equal(spread([...measured, at("2026-08-01T13:00:00.000Z", 0)]), spread(measured),
            "a value nobody measured widened the reported stability");
    });

    // The other side of it: a range in which nothing measured a latency has no
    // ping to report, and must not answer zero.
    it("reports no ping at all when none was measured", () => {
        const {ping} = statistics([at("2026-08-01T10:00:00.000Z", 0)]);

        assert.equal(ping.avg, null);
    });

    // And the row is still a successful test - it measured both speeds.
    it("still counts the test itself", () => {
        const {tests} = statistics([at("2026-08-01T10:00:00.000Z", 0)]);

        assert.equal(tests.total, 1);
        assert.equal(tests.failed, 0);
    });

    /**
     * The chart under the summary, which reads the same rows and has to answer
     * the same way.
     *
     * The summary, the hourly buckets and the spread all learned to skip the
     * fabrication; the series the page draws did not, so a range could report a
     * minimum of 20 ms above a line that visibly touched zero. Two answers to
     * one question on one screen is the fault this rule exists to end, and a
     * gap in the line is how every other unmeasured metric here already says
     * "not reported" - jitter and both loaded latencies do exactly this.
     */
    it("draws a gap rather than a zero", () => {
        const {data, failed} = statistics([
            at("2026-08-01T10:00:00.000Z", 20),
            at("2026-08-01T11:00:00.000Z", 30),
            at("2026-08-01T12:00:00.000Z", 0)
        ]);

        assert.deepEqual(data.ping, [20, 30, null],
            "the ping chart plots a latency nobody measured");
        // The row is still on the chart, and still not a failure - only its
        // latency is missing.
        assert.deepEqual(data.download, [100, 100, 100]);
        assert.deepEqual(failed, [false, false, false]);
    });

    // The other branch of the same chart. Above TARGET_CHART_POINTS the series
    // is averaged into buckets instead of drawn row by row, and a fabricated
    // zero folded into a bucket average is harder to see than one plotted on
    // its own - it lands as a dip of the wrong depth rather than a dip to nought.
    it("keeps it out of an averaged bucket too", () => {
        const TOTAL = TARGET_CHART_POINTS + 100;
        const MEASURED_PING = 20;
        // Sparse enough that most buckets hold only real readings, frequent
        // enough that several hold one of these.
        const UNMEASURED_EVERY = 50;
        const MINUTES_PER_HOUR = 60;

        const entries = [];
        for (let i = 0; i < TOTAL; i++) {
            const hour = String(Math.floor(i / MINUTES_PER_HOUR)).padStart(2, "0");
            const minute = String(i % MINUTES_PER_HOUR).padStart(2, "0");

            entries.push(at(`2026-08-01T${hour}:${minute}:00.000Z`,
                i % UNMEASURED_EVERY === 0 ? UNMEASURED_LATENCY : MEASURED_PING));
        }

        const {data, downsampled} = statistics(entries);

        assert.equal(downsampled, true, "the range was small enough to draw row by row");
        for (const point of data.ping)
            assert.ok(point === null || point === MEASURED_PING,
                `a bucket averaged in a latency nobody measured: ${point}`);
    });
});
