import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getIconBySpeed } from "../../client/src/common/utils/TestUtil.js";

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
