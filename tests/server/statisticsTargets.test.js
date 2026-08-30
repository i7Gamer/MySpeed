import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SUMMARISED_ROWS_QUERY, targetsPresent } from "../../server/controller/speedtests.js";
import { STATISTICS_COLUMNS } from "../../server/util/statistics.js";

/**
 * Which targets a page of statistics was actually built from.
 *
 * The client grades a page's cards against one target's optimal values when the
 * page is showing one target, and "one target is configured" is not that. A
 * deleted target's rows stay in the table, a restored export comes back with no
 * target at all, and nothing narrows a single-target instance's query - so the
 * only thing that can say what a figure was measured against is the rows behind
 * it. This is that statement, and it rides on the read that was happening
 * anyway.
 */
describe("the targets a statistics payload was built from", () => {
    it("names each target once however many rows it measured", () => {
        assert.deepEqual(targetsPresent([{targetId: 1}, {targetId: 1}, {targetId: 2}]), [1, 2],
            "one entry per target, so a hundred thousand rows cost the payload nothing");
    });

    /**
     * A row recorded before targets existed and a row an import brought back
     * without one are the same case, and they must group together rather than
     * each be a category of one - targetOf on the client folds them the same
     * way.
     */
    it("counts a row that names no target as null", () => {
        assert.deepEqual(targetsPresent([{targetId: 1}, {targetId: null}, {}]), [1, null]);

        const [only] = targetsPresent([{}]);
        assert.strictEqual(only, null,
            "undefined would compare equal to nothing while reading - in a log, in a "
            + "test failure - exactly like the absence it stands for");
    });

    it("answers an empty set for a window with nothing in it", () => {
        assert.deepEqual(targetsPresent([]), [],
            "which the client reads as no evidence against the sole target, so the "
            + "cards do not change basis as a range empties");
    });

    /**
     * The column is the whole mechanism, and dropping it breaks nothing loudly:
     * the rows would simply arrive without it, every page would answer [null],
     * the client would read that as a mixture, and every single-target instance
     * would quietly go back to grading against the instance-wide settings.
     */
    it("is selected on the read the summary already does", () => {
        for (const column of STATISTICS_COLUMNS)
            assert.ok(SUMMARISED_ROWS_QUERY.attributes.includes(column),
                `the summary still needs ${column}`);

        assert.ok(SUMMARISED_ROWS_QUERY.attributes.includes("targetId"),
            "without this column every page answers [null] and the grading silently reverts");
        assert.equal(SUMMARISED_ROWS_QUERY.raw, true,
            "a model instance per row is what this read exists to avoid");
    });

    // STATISTICS_COLUMNS is the set statistics.js reads, and the test beside
    // that file fails a column selected and read nowhere in it.
    it("does not widen the aggregation's own column contract", () => {
        assert.ok(!STATISTICS_COLUMNS.includes("targetId"));
    });
});
