import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { describeDelta, hasPreviousData } from "../../client/src/common/components/Delta/deltas.js";

/**
 * The comparison against the previous period, reduced to one honest sentence
 * per figure. The rules live in a pure function because the failure modes are
 * all judgement calls, not arithmetic: a fresh instance must not read "+100%"
 * against everything, a window nobody measured must not be treated as zero,
 * and "no change" is better said by silence than by "±0%".
 */
describe("describeDelta", () => {
    it("describes an improvement in a bigger-is-better figure", () => {
        const delta = describeDelta({current: 960, previous: 900, higherIsBetter: true});

        assert.equal(delta.direction, "up");
        assert.equal(delta.tone, "better");
        assert.equal(delta.label, "6.7%");
    });

    it("describes a worsening in a smaller-is-better figure", () => {
        const delta = describeDelta({current: 24, previous: 20, higherIsBetter: false});

        assert.equal(delta.direction, "up");
        assert.equal(delta.tone, "worse");
        assert.equal(delta.label, "20%");
    });

    it("describes an improvement in a smaller-is-better figure", () => {
        const delta = describeDelta({current: 18, previous: 20, higherIsBetter: false});

        assert.equal(delta.direction, "down");
        assert.equal(delta.tone, "better");
        assert.equal(delta.label, "10%");
    });

    // The number of tests carries no judgement either way; the change is still
    // worth a word, but not a colour.
    it("stays neutral for a figure that is neither better nor worse", () => {
        const delta = describeDelta({current: 42, previous: 40, higherIsBetter: null, mode: "absolute"});

        assert.equal(delta.tone, "neutral");
        assert.equal(delta.label, "2");
    });

    it("counts in absolute terms when asked to", () => {
        const delta = describeDelta({current: 5, previous: 2, higherIsBetter: false, mode: "absolute"});

        assert.equal(delta.direction, "up");
        assert.equal(delta.tone, "worse");
        assert.equal(delta.label, "3");
    });

    it("carries a unit through an absolute delta", () => {
        const delta = describeDelta({current: 1.2, previous: 0.8, higherIsBetter: false, mode: "absolute", unit: "%"});

        assert.equal(delta.label, "0.4%");
    });

    describe("saying nothing", () => {
        it("when there is no previous value", () => {
            for (const previous of [null, undefined])
                assert.equal(describeDelta({current: 960, previous, higherIsBetter: true}), null);
        });

        it("when there is no current value", () => {
            assert.equal(describeDelta({current: null, previous: 900, higherIsBetter: true}), null);
        });

        // "+100%" against a previous of zero is arithmetic, not information.
        it("when a percentage would divide by zero", () => {
            assert.equal(describeDelta({current: 5, previous: 0, higherIsBetter: true}), null);
        });

        // ...but an absolute count from zero is real: 0 failures to 3 is +3.
        it("never for an absolute change from zero", () => {
            const delta = describeDelta({current: 3, previous: 0, higherIsBetter: false, mode: "absolute"});

            assert.equal(delta.label, "3");
            assert.equal(delta.tone, "worse");
        });

        it("when nothing changed", () => {
            assert.equal(describeDelta({current: 900, previous: 900, higherIsBetter: true}), null);
            assert.equal(describeDelta({current: 2, previous: 2, higherIsBetter: false, mode: "absolute"}), null);
        });

        // A hair's difference reads as noise, not as a trend.
        it("when the change rounds to nothing", () => {
            assert.equal(describeDelta({current: 900.2, previous: 900, higherIsBetter: true}), null);
        });
    });

    it("rounds to one decimal and drops a trailing zero", () => {
        assert.equal(describeDelta({current: 110, previous: 100, higherIsBetter: true}).label, "10%");
        assert.equal(describeDelta({current: 106.7, previous: 100, higherIsBetter: true}).label, "6.7%");
    });
});

/**
 * The gate in front of every delta on the page: a previous window nobody
 * tested in has no figures to compare against, and comparing against its
 * zeros would call a working connection "infinitely worse".
 */
describe("hasPreviousData", () => {
    it("accepts a window with tests in it", () => {
        assert.equal(hasPreviousData({tests: {total: 12, failed: 2}}), true);
    });

    it("rejects a window nobody tested in", () => {
        assert.equal(hasPreviousData({tests: {total: 0, failed: 0}}), false);
    });

    it("rejects an answer with no previous window at all", () => {
        for (const previous of [null, undefined, {}])
            assert.equal(hasPreviousData(previous), false);
    });
});
