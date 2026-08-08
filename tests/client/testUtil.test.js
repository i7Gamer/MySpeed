import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { failureRate, getIconBySpeed, isFailedTest } from "../../client/src/common/utils/TestUtil.js";

/**
 * The failed count has always been on the statistics page, but a bare number
 * says nothing without the total beside it: 23 failures is a rounding error
 * across a year and an outage across an afternoon.
 */
describe("failureRate", () => {
    it("is the share of tests that failed", () => {
        assert.equal(failureRate(1000, 23), 2.3);
        assert.equal(failureRate(4, 1), 25);
    });

    it("is zero when everything succeeded", () => {
        assert.equal(failureRate(1000, 0), 0);
    });

    it("is a hundred when everything failed", () => {
        assert.equal(failureRate(48, 48), 100);
    });

    it("rounds to a single decimal", () => {
        assert.equal(failureRate(3, 1), 33.3);
    });

    // Nothing measured is not the same as nothing failed, and 0/0 is NaN.
    it("is absent when there were no tests at all", () => {
        assert.equal(failureRate(0, 0), null);
    });

    it("is absent rather than wrong for nonsense input", () => {
        for (const [total, failed] of [[undefined, 1], [10, undefined], [-1, 1], [10, null]])
            assert.equal(failureRate(total, failed), null, `failed for ${total}/${failed}`);
    });
});

const speed = (current, optimal) => getIconBySpeed(current, optimal, true);
const latency = (current, optimal) => getIconBySpeed(current, optimal, false);

describe("getIconBySpeed", () => {
    describe("throughput", () => {
        it("is green at or above three quarters of the optimum", () => {
            assert.equal(speed(100, 100), "green");
            assert.equal(speed(75, 100), "green");
        });

        it("is orange between a third and three quarters", () => {
            assert.equal(speed(74, 100), "orange");
            assert.equal(speed(30, 100), "orange");
        });

        it("is red below a third", () => {
            assert.equal(speed(29, 100), "red");
            assert.equal(speed(0, 100), "red");
        });
    });

    describe("latency, where higher is worse", () => {
        it("is green up to 130% of the target", () => {
            assert.equal(latency(25, 25), "green");
            assert.equal(latency(32, 25), "green");
        });

        it("is orange between 130% and 180%", () => {
            assert.equal(latency(33, 25), "orange");
            assert.equal(latency(44, 25), "orange");
        });

        it("is red at or above 180%", () => {
            assert.equal(latency(45, 25), "red");
        });
    });

    it("reports a failed test as an error", () => {
        assert.equal(speed(-1, 100), "error");
        assert.equal(latency(-1, 25), "error");
    });

    /**
     * Regression: with no tests yet the dashboard passes the "N/A" placeholder,
     * which made the percentage NaN. NaN fails every comparison, so download and
     * upload fell through to "red" - a fresh install reported a bad connection
     * before anything had been measured. Latency fell through to "green", so the
     * two halves of the dashboard even disagreed.
     */
    describe("before anything has been measured", () => {
        it("is neutral for the N/A placeholder", () => {
            assert.equal(speed("N/A", 100), "blue");
            assert.equal(latency("N/A", 25), "blue");
        });

        it("is neutral for a missing measurement", () => {
            for (const missing of [undefined, null, ""])
                assert.equal(speed(missing, 100), "blue", `failed for ${JSON.stringify(missing)}`);
        });

        it("is neutral when no optimum is configured", () => {
            assert.equal(speed(100, undefined), "blue");
            assert.equal(speed(100, 0), "blue");
        });

        it("never reports a real reading as neutral", () => {
            for (const value of [1, 50, 100, 1000])
                assert.notEqual(speed(value, 100), "blue");
        });
    });
});

/**
 * A failed test is stored with an error string and -1 in every numeric column.
 * The node list printed those placeholders straight out, so a node whose last
 * test failed advertised "-1 ms" and "-1 Mbps" as though they were readings.
 */
describe("isFailedTest", () => {
    it("recognises the row a failed test leaves behind", () => {
        assert.equal(isFailedTest({error: "Cannot open socket", ping: -1, download: -1, upload: -1}), true);
    });

    it("trusts the placeholders even when no message was recorded", () => {
        assert.equal(isFailedTest({error: null, ping: -1, download: -1, upload: -1}), true);
    });

    it("leaves a successful test alone", () => {
        assert.equal(isFailedTest({error: null, ping: 5, download: 2366.32, upload: 2202.56}), false);
    });

    it("does not call an empty error string a failure", () => {
        assert.equal(isFailedTest({error: "", ping: 12, download: 100, upload: 50}), false);
    });

    it("treats a genuine zero as a measurement rather than a failure", () => {
        assert.equal(isFailedTest({error: null, ping: 0, download: 0, upload: 0}), false);
    });

    it("is false when there is no test at all", () => {
        assert.equal(isFailedTest(undefined), false);
        assert.equal(isFailedTest(null), false);
    });
});
