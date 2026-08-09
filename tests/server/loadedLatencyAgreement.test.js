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
    {name: "fractional", ping: 11.4, downloadLatency: 47.75, uploadLatency: 30.2}
];

describe("the two ways the added latency is worked out", () => {
    for (const testCase of CASES) {
        it(`agrees on a single ${testCase.name} test`, () => {
            const entry = at("2026-08-07T01:00:00.000Z", testCase);
            const {increase} = bufferbloat(entry);
            const {loadedLatency} = buildStatistics([entry], DAY).consistency;

            assert.equal(loadedLatency.increase, increase,
                "the average of one test has to be that test's own figure");
        });
    }

    it("agrees on the average across every case at once", () => {
        const entries = CASES.map((testCase, index) =>
            at(`2026-08-07T${String(index + 1).padStart(2, "0")}:00:00.000Z`, testCase));

        const perTest = entries.map((entry) => bufferbloat(entry).increase);
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

        assert.deepEqual(trend.map((point) => point.increase),
            entries.map((entry) => bufferbloat(entry).increase));
    });
});
