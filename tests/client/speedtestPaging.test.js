import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyPage, cursorOf, removeTest } from "../../client/src/common/contexts/Speedtests/paging.js";

const CONTEXT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..",
    "client", "src", "common", "contexts", "Speedtests", "SpeedtestContext.jsx");

const source = fs.readFileSync(CONTEXT, "utf8");

const test = (id, created) => ({id, created});

const PAGE_SIZE = 3;

describe("cursorOf", () => {
    it("is the last row's created and id - the pair the list is ordered by", () => {
        assert.deepEqual(cursorOf([test(9, "2026-08-10T10:00:00.000Z"), test(7, "2026-08-10T09:00:00.000Z")]),
            {created: "2026-08-10T09:00:00.000Z", id: 7});
    });

    it("is null for an empty page", () => {
        assert.equal(cursorOf([]), null);
    });
});

describe("applyPage", () => {
    const current = [test(9, "T3"), test(8, "T2")];

    it("appends only the rows not already on screen", () => {
        const page = applyPage(current, [test(8, "T2"), test(7, "T1")], PAGE_SIZE);

        assert.deepEqual(page.tests.map(t => t.id), [9, 8, 7]);
    });

    /**
     * Regression: the cursor only advanced when a page carried something new.
     * A page of rows the screen already had - the overlap a refresh can leave -
     * kept the old cursor while hasMore stayed true, so "load more" fetched
     * the same page forever and the rest of the history was unreachable.
     */
    it("advances the cursor even when every row was already known", () => {
        const page = applyPage(current, [test(9, "T3"), test(8, "T2"), test(7, "T1")], PAGE_SIZE);

        assert.deepEqual(page.cursor, {created: "T1", id: 7});
        assert.equal(page.hasMore, true);
    });

    it("keeps the list's identity when nothing was added", () => {
        const page = applyPage(current, [test(9, "T3"), test(8, "T2")], PAGE_SIZE);

        assert.equal(page.tests, current, "an unchanged list must not re-render every row");
    });

    it("reads a short page as the end of the list", () => {
        assert.equal(applyPage(current, [test(7, "T1")], PAGE_SIZE).hasMore, false);
        assert.equal(applyPage(current, [test(7, "T1"), test(6, "T0"), test(5, "S9")], PAGE_SIZE).hasMore, true);
    });
});

describe("removeTest", () => {
    const current = [test(9, "T3"), test(8, "T2"), test(7, "T1")];

    it("drops the row and moves the cursor to the new last", () => {
        const removal = removeTest(current, 7);

        assert.deepEqual(removal.tests.map(t => t.id), [9, 8]);
        assert.deepEqual(removal.cursor, {created: "T2", id: 8});
        assert.equal(removal.exhausted, false);
    });

    it("reports an emptied list so paging can stop", () => {
        const removal = removeTest([test(9, "T3")], 9);

        assert.deepEqual(removal.tests, []);
        assert.equal(removal.cursor, null);
        assert.equal(removal.exhausted, true);
    });

    it("leaves the list's identity alone when the id is not in it", () => {
        assert.equal(removeTest(current, 999).tests, current);
    });
});

/**
 * The context used to call setCursor and setHasMore from inside its
 * setSpeedtests updater - an updater React may run twice under StrictMode, so
 * the side effects fired twice too. The judgements live in the pure module
 * now, and the updaters stay updaters.
 */
describe("the context stays pure", () => {
    it("derives its paging through the module", () => {
        assert.match(source, /applyPage\(/, "loadMoreTests does not use the pure paging");
        assert.match(source, /removeTest\(/, "deleteTest does not use the pure paging");
    });

    it("sets no other state from inside a setSpeedtests updater", () => {
        // Only a block-bodied updater can hide a side effect: an expression
        // body - the refresh's mergeNewTests call - has nowhere to put one.
        // Scans each updater's own body, up to its closing `})`.
        assert.doesNotMatch(source,
            /setSpeedtests\(\s*(?:prev|previous)\w*\s*=>\s*\{(?:(?!\}\))[^])*?set(?:Cursor|HasMore)\(/,
            "a setSpeedtests updater still carries side effects");
    });
});
