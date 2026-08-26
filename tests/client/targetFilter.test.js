import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../helpers/source.js";

/**
 * That the chip selection actually reaches the server.
 *
 * This is the failure mode hardest to notice from the outside: drop the
 * parameter from any one of these requests and the chip row still renders, the
 * clicked chip still highlights, the page still loads - it simply shows every
 * target's data under a label that says one target. Nothing errors, nothing is
 * empty, and the numbers are plausible, so the only symptom is a reader
 * drawing conclusions about one connection from a mixture of several.
 *
 * Held as a scan because none of these calls can be executed here: they are
 * built inside components the suite cannot compile. What is asserted is the
 * one thing that broke - that the resolved selection is put into the query
 * every one of these requests sends.
 */

const REQUESTS = [
    {
        what: "the overview's list, its paging and its refresh",
        file: "client/src/common/contexts/Speedtests/SpeedtestContext.jsx",
        // One place builds the query for all three, which is why it is one
        // entry - listQuery is shared by loadInitialTests, loadMoreTests and
        // refreshTests, and a filter applied to fewer than all three would
        // page or refresh a different list than the one on screen.
        sets: /params\.set\("target", String\(targetFilter\)\)/,
        reads: /const targetFilter = selectedTarget/
    },
    {
        what: "the statistics aggregation",
        file: "client/src/pages/Statistics/Statistics.jsx",
        sets: /query\.set\("target", String\(targetFilter\)\)/,
        reads: /const targetFilter = selectedTarget/
    },
    {
        what: "the statistics latest-test fetch",
        file: "client/src/pages/Statistics/Statistics.jsx",
        // "The latest test" on a filtered page has to mean the filtered
        // target's latest, or the card and the charts under one heading
        // describe two different connections.
        sets: /targetFilter != null \? `&target=\$\{targetFilter\}` : ""/
    },
    {
        what: "the export",
        file: "client/src/common/components/ExportButton/ExportButton.jsx",
        // The third control in the same toolbar row as the chips. It already
        // honours the range beside it; a file that quietly holds every
        // target's rows is the same mismatch a range-wide export would be.
        sets: /query\.set\("target", String\(target\)\)/
    }
];

describe("the chip selection reaches every request it narrows", () => {
    for (const {what, file, sets, reads} of REQUESTS) {
        const source = readSource(file);

        it(`${what} carries the target`, () => {
            assert.match(source, sets,
                `${what} ignores the chip, so a narrowed page shows every target's data`);
        });

        if (reads) it(`${what} reads the resolved selection`, () => {
            assert.match(source, reads,
                `${what} decides for itself which target is selected, which is how two `
                + "views end up showing different slices under one chip row");
        });
    }

    /**
     * And the fetches re-run when the selection changes, which is a separate
     * thing from building the right query: a filter that reaches the URL but
     * not the dependency list applies only at the next unrelated refetch, so
     * clicking a chip appears to do nothing at all.
     */
    it("re-fetches the overview when the chip changes", () => {
        const context = readSource("client/src/common/contexts/Speedtests/SpeedtestContext.jsx");

        assert.match(context, /\}, \[range, targetFilter\]\)/,
            "listQuery does not change with the chip, so the overview keeps the old query");
    });

    it("re-fetches the statistics when the chip changes", () => {
        const statistics = readSource("client/src/pages/Statistics/Statistics.jsx");

        assert.match(statistics, /\}, \[dateRange, currentNode, targetFilter\]\);/,
            "the statistics keep the previous target's figures under the new chip");
        assert.match(statistics, /\}, \[wantsDetail, isDownsampled, dateRange, targetFilter\]\);/,
            "the high-resolution series is still the previous target's");
    });

    /**
     * The chip row is drawn only where it can be unclicked. An instance with
     * one target draws none, so a stored selection there would filter a page
     * with nothing on screen to say so - and no way to undo it.
     */
    it("draws no chips on an instance with nothing to choose between", () => {
        const chips = readSource("client/src/common/components/TargetChips/TargetChips.jsx");

        assert.match(chips, /if \(targets\.length < 2\) return null/,
            "a single-target instance draws a chip row that narrows nothing");
    });
});
