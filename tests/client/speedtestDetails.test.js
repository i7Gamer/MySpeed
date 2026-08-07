import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    changeFrom, differenceFromTarget, percentOfTarget
} from "../../client/src/pages/Home/components/Speedtest/utils/details.js";

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

    /**
     * Latency is the one metric where exceeding the target is bad news, so the
     * ratio is inverted to keep "more percent" meaning "better" everywhere. A
     * ping 20% over its budget used to read as "120% of your target" beside a
     * full green bar.
     */
    describe("latency, where lower is better", () => {
        const latency = (current, target) => percentOfTarget(current, target, {higherIsBetter: false});

        it("falls below 100 when the ping is over target", () => {
            assert.equal(latency(24, 20), 83);
        });

        it("rises above 100 when the ping beats the target", () => {
            assert.equal(latency(16, 20), 125);
        });

        it("is exactly 100 on target", () => {
            assert.equal(latency(20, 20), 100);
        });

        // Dividing by it is worse than useless, and it is not a measurement.
        it("returns null for a ping of zero", () => {
            assert.equal(latency(0, 20), null);
        });

        it("still refuses a failed measurement and an unset target", () => {
            assert.equal(latency(-1, 20), null);
            assert.equal(latency(24, null), null);
        });
    });
});

describe("differenceFromTarget", () => {
    it("reports how far over the target a measurement is", () => {
        assert.deepEqual(differenceFromTarget(24, 20), {difference: 4, direction: "over"});
    });

    // The difference is always reported unsigned; `direction` carries the sign,
    // so the sentence around it does not have to cope with a minus.
    it("reports how far under the target a measurement is", () => {
        assert.deepEqual(differenceFromTarget(16, 20), {difference: 4, direction: "under"});
    });

    it("reports landing exactly on the target", () => {
        assert.deepEqual(differenceFromTarget(20, 20), {difference: 0, direction: "same"});
    });

    it("rounds to two decimals", () => {
        assert.deepEqual(differenceFromTarget(20.125, 20), {difference: 0.13, direction: "over"});
    });

    describe("nothing to compare against", () => {
        it("returns null without a target", () => {
            for (const target of [null, undefined, "", 0, "abc"])
                assert.equal(differenceFromTarget(24, target), null, `target ${JSON.stringify(target)}`);
        });

        it("returns null for a failed or non-numeric measurement", () => {
            assert.equal(differenceFromTarget(-1, 20), null);
            assert.equal(differenceFromTarget("24", 20), null);
            assert.equal(differenceFromTarget(null, 20), null);
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
