import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildStatistics } from "../../server/util/statistics.js";
import { bufferbloat, gradeForIncrease } from "../../client/src/common/utils/TestUtil.js";

/**
 * The added latency is worked out twice: once per test on the client, to grade
 * a single result, and once across a range on the server, to average it. The
 * two have to agree about what "added latency" means, or the headline grade on
 * the consistency panel and the per-test dots beneath it would be measuring
 * subtly different things - the kind of disagreement nobody notices until the
 * numbers are challenged.
 *
 * Neither side can import the other (the client bundles for a browser, the
 * server runs under node with its own module graph), so this pins them to the
 * same fixtures instead.
 */
const at = (iso, overrides = {}) => ({
    ping: 10, jitter: 2, download: 100, upload: 50, time: 30,
    error: null, created: iso, ...overrides
});

const DAY = {from: new Date("2026-08-07T00:00:00.000Z"), to: new Date("2026-08-07T23:59:59.999Z")};

const CASES = [
    {name: "worse downstream", ping: 10, downloadLatency: 90, uploadLatency: 20},
    {name: "worse upstream", ping: 10, downloadLatency: 20, uploadLatency: 90},
    {name: "barely loaded", ping: 12, downloadLatency: 13, uploadLatency: 12},
    {name: "under the idle ping", ping: 60, downloadLatency: 20, uploadLatency: 20},
    {name: "heavily buffered", ping: 14, downloadLatency: 620, uploadLatency: 480},
    {name: "fractional", ping: 11.4, downloadLatency: 47.75, uploadLatency: 30.2},
    /**
     * The spellings the all-numeric fixtures above were blind to. The server's
     * loadedIncrease widened to coerce a numeric string - the defensive
     * imported-history contract every other reader took on - and the mirror
     * here kept its typeof gate, so the consistency card counted a row the
     * per-test grade beside it refused: the exact divergence this suite exists
     * to make impossible, invisible because nothing below spelt a number as
     * text. The placeholders pin the other half - both sides must refuse them.
     */
    {name: "numeric-string ping", ping: "20", downloadLatency: 50, uploadLatency: 60},
    {name: "numeric-string loaded latency", ping: 10, downloadLatency: "90", uploadLatency: 20},
    {name: "placeholder ping", ping: -1, downloadLatency: 50, uploadLatency: 60},
    {name: "placeholder loaded latency", ping: 10, downloadLatency: -1, uploadLatency: 20},
    {name: "unmeasured ping, spelt as text", ping: "0", downloadLatency: 50, uploadLatency: 60}
];

describe("the two ways the added latency is worked out", () => {
    for (const testCase of CASES) {
        it(`agrees on a single ${testCase.name} test`, () => {
            const entry = at("2026-08-07T01:00:00.000Z", testCase);
            // Null-tolerant on purpose: for the placeholder and unmeasured
            // spellings the agreement is that BOTH sides refuse the row.
            const increase = bufferbloat(entry)?.increase ?? null;
            const {loadedLatency} = buildStatistics([entry], DAY).consistency;

            assert.equal(loadedLatency.increase, increase,
                "the average of one test has to be that test's own figure");
        });
    }

    it("agrees on the average across every case at once", () => {
        const entries = CASES.map((testCase, index) =>
            at(`2026-08-07T${String(index + 1).padStart(2, "0")}:00:00.000Z`, testCase));

        // Only what the client would grade: the server averages over the rows
        // that measured, and the refusal cases above must not drag it down.
        const perTest = entries.map((entry) => bufferbloat(entry)?.increase ?? null)
            .filter((value) => value !== null);
        const expected = perTest.reduce((total, value) => total + value, 0) / perTest.length;

        const {increase} = buildStatistics(entries, DAY).consistency.loadedLatency;

        assert.ok(Math.abs(increase - expected) < 0.01,
            `server averaged ${increase}, client figures average ${expected}`);
    });

    // The grade the panel prints comes from the client's table applied to the
    // server's average, so the table has to accept what the server produces.
    it("produces an average the client's own thresholds can grade", () => {
        const entries = CASES.map((testCase, index) =>
            at(`2026-08-07T${String(index + 1).padStart(2, "0")}:00:00.000Z`, testCase));

        const {increase} = buildStatistics(entries, DAY).consistency.loadedLatency;

        assert.notEqual(gradeForIncrease(increase), null);
    });

    it("agrees that the trend entries are the per-test figures", () => {
        const entries = CASES.map((testCase, index) =>
            at(`2026-08-07T${String(index + 1).padStart(2, "0")}:00:00.000Z`, testCase));

        const {trend} = buildStatistics(entries, DAY).consistency.loadedLatency;

        // The trend only carries points the client would grade too - a refused
        // row is skipped on both sides, not drawn as a gap.
        assert.deepEqual(trend.map((point) => point.increase),
            entries.map((entry) => bufferbloat(entry)?.increase ?? null)
                .filter((value) => value !== null));
    });

    /**
     * Liveness for the string spellings: every case above is satisfied by
     * BOTH sides refusing a row - null agrees with null - so this is the half
     * that pins the reading itself. A symmetric retreat to the old typeof
     * gate on both sides kept the whole suite green while the feature was
     * gone; the one-sided drift the suite exists for was still caught.
     */
    it("produces a figure for the numeric-string spellings on both sides", () => {
        const spelt = CASES.filter((testCase) => testCase.name.startsWith("numeric-string"));
        assert.ok(spelt.length >= 2, "the string fixtures this pins have been renamed away");

        for (const testCase of spelt) {
            const entry = at("2026-08-07T01:00:00.000Z", testCase);

            assert.notEqual(bufferbloat(entry)?.increase ?? null, null,
                `the client refuses the ${testCase.name} row`);
            assert.notEqual(buildStatistics([entry], DAY).consistency.loadedLatency.increase, null,
                `the server refuses the ${testCase.name} row`);
        }
    });

    /**
     * And they agree that a fabricated idle ping is no baseline. 0 is
     * UNMEASURED_LATENCY - the sentinel a successful run stores when nobody
     * took the latency, and the value the INTEGER column of migration 0012's
     * day rounded a sub-half-millisecond ping down to. Judged as a real 0 ms,
     * the whole loaded latency reads as *added* latency, and a line that was
     * fine grades F. The statistics skip the same zero everywhere else -
     * withPing, the series, the hourly buckets - so this was the one reader
     * left believing it.
     */
    it("agrees that a run whose idle ping was never measured has no figure", () => {
        const entry = at("2026-08-07T01:00:00.000Z",
            {ping: 0, downloadLatency: 90, uploadLatency: 20});

        assert.equal(bufferbloat(entry), null,
            "the client graded a bufferbloat figure off a ping nobody measured");

        const {loadedLatency} = buildStatistics([entry], DAY).consistency;
        assert.equal(loadedLatency.increase, null,
            "the server averaged a figure computed off a ping nobody measured");
        assert.deepEqual(loadedLatency.trend, []);
    });
});
