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
});
