import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyRefresh } from "../../client/src/common/contexts/Speedtests/merge.js";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const read = (file) => fs.readFileSync(path.join(CLIENT_SRC, file), "utf8");

const PAGE_SIZE = 30;

const test = (id, created) => ({id, created});

// Newest first, which is how the list endpoint returns them.
const LIST = [
    test(10, "2026-08-07T12:00:00.000Z"),
    test(9, "2026-08-07T11:00:00.000Z"),
    test(8, "2026-08-07T10:00:00.000Z")
];

/** A full page of rows, all newer than anything in LIST. */
const fullPage = (fromId) => Array.from({length: PAGE_SIZE}, (unused, index) =>
    test(fromId + index, `2026-08-09T${String(23 - index).padStart(2, "0")}:00:00.000Z`));

/**
 * What a refresh should do with the page it just fetched.
 *
 * The refresh asks the very same query the list was built from, so the answer
 * is authoritative about what that query now returns - which is more than
 * "here are some rows to prepend".
 *
 * Two things went wrong by treating it as the latter. An empty answer was read
 * as "nothing to do" and returned before touching state, so "clear history"
 * reported success over a list that still showed all thirty rows - and
 * deleting one of those ghosts then failed with a red toast. And a full page
 * that overlapped nothing was prepended anyway, landing thirty rows directly
 * on top of a much older one: everything between became unreachable, because
 * the cursor points at the bottom of the list and only pages further back.
 */
describe("applyRefresh", () => {
    describe("an answer that says the list is empty", () => {
        it("clears a list the server no longer has rows for", () => {
            const {tests, replaced} = applyRefresh(LIST, []);

            assert.deepEqual(tests, []);
            assert.equal(replaced, true, "the caller has to reset the cursor as well");
        });

        it("leaves an already-empty list untouched", () => {
            const empty = [];
            const {tests, replaced} = applyRefresh(empty, []);

            assert.equal(tests, empty, "identity must be preserved to avoid a re-render");
            assert.equal(replaced, false);
        });
    });

    describe("an answer that overlaps what is on screen", () => {
        it("keeps the same array when nothing is new", () => {
            const {tests, replaced} = applyRefresh(LIST, [...LIST]);

            assert.equal(tests, LIST, "identity must be preserved to avoid a re-render");
            assert.equal(replaced, false);
        });

        it("prepends the rows that are genuinely new", () => {
            const {tests, replaced} = applyRefresh(LIST, [test(11, "2026-08-07T13:00:00.000Z"), ...LIST]);

            assert.deepEqual(tests.map((entry) => entry.id), [11, 10, 9, 8]);
            assert.equal(replaced, false, "prepending keeps the cursor valid");
        });
    });

    describe("an answer that overlaps nothing", () => {
        it("replaces the list rather than punching a hole in it", () => {
            const page = fullPage(100);
            const {tests, replaced} = applyRefresh(LIST, page);

            assert.equal(tests, page);
            assert.equal(replaced, true);
        });

        // A short page is the complete answer to the query, so whatever is on
        // screen and not in it no longer matches - it was deleted or pruned.
        it("replaces the list when a short page shares nothing with it", () => {
            const remaining = [test(3, "2026-08-01T09:00:00.000Z")];
            const {tests, replaced} = applyRefresh(LIST, remaining);

            assert.equal(tests, remaining);
            assert.equal(replaced, true);
        });

        it("takes the whole page when nothing is on screen yet", () => {
            const {tests, replaced} = applyRefresh([], LIST);

            assert.equal(tests, LIST);
            assert.equal(replaced, true);
        });
    });

    describe("an answer that is not a list at all", () => {
        it("changes nothing", () => {
            for (const incoming of [null, undefined, "nope", {}]) {
                const {tests, replaced} = applyRefresh(LIST, incoming);

                assert.equal(tests, LIST);
                assert.equal(replaced, false);
            }
        });
    });
});

describe("the list wiring", () => {
    const context = read("common/contexts/Speedtests/SpeedtestContext.jsx");

    it("refreshes through applyRefresh rather than merging blindly", () => {
        assert.match(context, /applyRefresh\(/);
        assert.doesNotMatch(context, /if \(newTests\.length === 0\) return;/,
            "an empty answer is still being read as nothing to do");
    });

    // A replaced list invalidates the cursor: it pointed into the result set
    // that was just thrown away, and paging from it walks the wrong history.
    it("resets the cursor when the refresh replaced the list", () => {
        assert.match(context, /replaced/);
        assert.match(context, /setCursor\(/);
    });

    it("offers a full reload for the actions that replace the history", () => {
        assert.match(context, /reloadTests/);
    });
});

/**
 * Clearing and importing do not add rows to the top of the list - they replace
 * the history wholesale - so neither can be reconciled by a merge. An import in
 * particular appends *older* rows, which a refresh of the newest page cannot
 * see at all: it reported success and showed nothing new.
 */
describe("the storage dialog", () => {
    const dialog = read("common/components/StorageDialog/tabs/Speedtests.jsx");

    it("reloads the list after clearing the history", () => {
        assert.match(dialog, /reloadTests/);
    });

    it("no longer reconciles a bulk change through the merge path", () => {
        assert.doesNotMatch(dialog, /updateTests\(\)/,
            "a merge cannot see rows an import appended below the newest page");
    });
});
