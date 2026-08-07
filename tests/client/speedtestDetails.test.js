import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { changeFrom, percentOfTarget } from "../../client/src/pages/Home/components/Speedtest/utils/details.js";

describe("percentOfTarget", () => {
    it("reports how much of the optimum was reached", () => {
        assert.equal(percentOfTarget(75, 100), 75);
        assert.equal(percentOfTarget(100, 100), 100);
    });

    it("goes above 100 when the line beats the target", () => {
        assert.equal(percentOfTarget(120, 100), 120);
    });

    it("rounds to a whole percentage", () => {
        assert.equal(percentOfTarget(82.4, 100), 82);
        assert.equal(percentOfTarget(82.6, 100), 83);
    });

    it("reads a target stored as a string, which is how the config holds it", () => {
        assert.equal(percentOfTarget(50, "100"), 50);
    });

    it("reports zero for a measurement of zero", () => {
        assert.equal(percentOfTarget(0, 100), 0);
    });

    describe("no comparison possible", () => {
        // Number("") and Number(null) are both 0, which would divide by zero.
        it("returns null for an unset target", () => {
            for (const target of [null, undefined, "", 0, "0", "abc"])
                assert.equal(percentOfTarget(50, target), null, `target ${JSON.stringify(target)}`);
        });

        // -1 is the placeholder a failed run writes, not a measurement.
        it("returns null for a failed measurement", () => {
            assert.equal(percentOfTarget(-1, 100), null);
        });

        it("returns null for a missing or non-numeric measurement", () => {
            for (const current of [null, undefined, "50", NaN, Infinity])
                assert.equal(percentOfTarget(current, 100), null, `current ${String(current)}`);
        });
    });
});

describe("changeFrom", () => {
    it("reports an improvement", () => {
        assert.deepEqual(changeFrom(110, 100), {difference: 10, direction: "up"});
    });

    it("reports a drop", () => {
        assert.deepEqual(changeFrom(90, 100), {difference: -10, direction: "down"});
    });

    it("reports no change", () => {
        assert.deepEqual(changeFrom(100, 100), {difference: 0, direction: "same"});
    });

    // Speeds are doubles, so the raw subtraction produces things like
    // 0.09999999999999432.
    it("rounds the difference to two decimals", () => {
        assert.deepEqual(changeFrom(100.1, 100), {difference: 0.1, direction: "up"});
        assert.deepEqual(changeFrom(94.37, 91.115), {difference: 3.26, direction: "up"});
    });

    describe("nothing to compare with", () => {
        it("returns null without a previous test", () => {
            assert.equal(changeFrom(100, null), null);
            assert.equal(changeFrom(100, undefined), null);
        });

        // Comparing against a failed run's -1 placeholder would report a
        // spectacular improvement on every test that follows an outage.
        it("returns null when either side failed", () => {
            assert.equal(changeFrom(100, -1), null);
            assert.equal(changeFrom(-1, 100), null);
        });

        it("returns null for non-numeric input", () => {
            assert.equal(changeFrom("100", 90), null);
            assert.equal(changeFrom(100, "90"), null);
        });
    });
});
