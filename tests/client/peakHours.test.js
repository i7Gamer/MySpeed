import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { peakSlowdown } from "../../client/src/pages/Statistics/charts/peakHours.js";

// The shape the statistics return: 24 buckets, each an average and the number
// of tests behind it.
const hour = (hour, download, count = 10) => ({hour, download, upload: download, ping: 10, jitter: 1, count});

const day = (...buckets) => {
    const empty = Array.from({length: 24}, (_, index) => hour(index, null, 0));
    for (const bucket of buckets) empty[bucket.hour] = bucket;

    return empty;
};

describe("peakSlowdown", () => {
    it("reports how far the worst hour falls below the best", () => {
        const result = peakSlowdown(day(hour(3, 100), hour(12, 80), hour(20, 50)));

        assert.deepEqual(result, {slowdown: 50, slowestHour: 20, fastestHour: 3});
    });

    it("names the hours rather than only the gap", () => {
        const result = peakSlowdown(day(hour(1, 40), hour(9, 90), hour(18, 60)));

        assert.equal(result.fastestHour, 9);
        assert.equal(result.slowestHour, 1);
    });

    it("rounds the percentage to one decimal", () => {
        const result = peakSlowdown(day(hour(0, 90), hour(6, 100), hour(21, 63)));

        assert.equal(result.slowdown, 37);
    });

    // A line that holds up all day is the answer people hope for, and it is a
    // reading rather than an absence.
    it("reports zero for a day with no variation at all", () => {
        const result = peakSlowdown(day(hour(2, 100), hour(10, 100), hour(22, 100)));

        assert.equal(result.slowdown, 0);
    });

    describe("ranges that cannot support the comparison", () => {
        it("returns null for no hourly data", () => {
            for (const input of [null, undefined, {}, "", []])
                assert.equal(peakSlowdown(input), null, `input ${JSON.stringify(input)}`);
        });

        // One slow run in an otherwise empty hour would otherwise read as "your
        // line collapses at 3am".
        it("ignores an hour measured by fewer than three tests", () => {
            const thin = day(hour(3, 10, 2), hour(9, 100), hour(14, 90), hour(20, 80));

            assert.equal(peakSlowdown(thin).slowestHour, 20, "the two-test hour set the floor");
        });

        it("returns null when fewer than three hours were measured at all", () => {
            assert.equal(peakSlowdown(day(hour(9, 100), hour(20, 50))), null);
        });

        // Every bucket in a range where nothing succeeded is an explicit null,
        // and null > null is false in every direction.
        it("returns null when no hour holds a measurement", () => {
            assert.equal(peakSlowdown(day()), null);
        });

        // A bucket of zero is not a speed, and it is the denominator.
        it("ignores an hour averaging zero rather than dividing by it", () => {
            const result = peakSlowdown(day(hour(0, 0), hour(8, 100), hour(15, 90), hour(23, 60)));

            assert.equal(result.slowdown, 40);
        });
    });

    /**
     * The buckets are server-fed, and a proxied older node's payload can
     * spell either figure as text - the same doctrine every other reader of
     * this payload moved to. The downloads must be COERCED before the
     * comparisons below the gate, not merely admitted: "100" < "50"
     * lexicographically, and a gate-only widening reported a negative
     * slowdown with its hours swapped.
     */
    describe("figures a proxied node spells as text", () => {
        it("reads text downloads and compares them as numbers", () => {
            const result = peakSlowdown(day(hour(3, "100"), hour(12, "80"), hour(20, "50")));

            assert.deepEqual(result, {slowdown: 50, slowestHour: 20, fastestHour: 3});
        });

        // "50" < "75" < "100" is false in string order - "75" sorts above
        // both - so this day is the one a lexicographic comparison gets
        // wrong in every field at once.
        it("orders a text day by magnitude, not by first character", () => {
            const result = peakSlowdown(day(hour(1, "100"), hour(9, "50"), hour(18, "75")));

            assert.deepEqual(result, {slowdown: 50, slowestHour: 9, fastestHour: 1});
        });

        it("mixes text and numeric hours in one day", () => {
            const result = peakSlowdown(day(hour(2, "110"), hour(11, 55), hour(19, 88)));

            assert.deepEqual(result, {slowdown: 50, slowestHour: 11, fastestHour: 2});
        });

        it("counts an hour whose sample count is spelled as text", () => {
            const result = peakSlowdown(day(hour(3, 100, "5"), hour(12, 80), hour(20, 50)));

            assert.equal(result.slowdown, 50);
        });

        it("still refuses what no reader can read", () => {
            const junk = day(hour(2, "auto"), hour(5, -1), hour(7, "-1"),
                hour(9, 100), hour(15, 90), hour(23, 60));

            assert.equal(peakSlowdown(junk).slowdown, 40,
                "a placeholder or junk bucket set the floor");
        });

        // ToNumber let these through the sample floor - an array wrapping a
        // number, and an Infinity - and neither is a count of tests.
        it("refuses a sample count only coercion could read", () => {
            assert.equal(peakSlowdown(day(hour(3, 100, Infinity), hour(9, 90), hour(20, 45))), null,
                "an Infinity count still passes the sample floor");
            assert.equal(peakSlowdown(day(hour(3, 100, [5]), hour(9, 90), hour(20, 45))), null,
                "an array count still passes the sample floor");
        });
    });
});
