import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeNewTests } from "../../client/src/common/contexts/Speedtests/merge.js";

const test = (id, created) => ({id, created});

// Newest first, which is how the list endpoint returns them.
const LIST = [
    test(10, "2026-08-07T12:00:00.000Z"),
    test(9, "2026-08-07T11:00:00.000Z"),
    test(8, "2026-08-07T10:00:00.000Z")
];

describe("mergeNewTests", () => {
    describe("nothing to add", () => {
        it("keeps the same array when the poll returns what is already shown", () => {
            assert.equal(mergeNewTests(LIST, [...LIST]), LIST, "identity must be preserved to avoid a re-render");
        });

        it("keeps the same array for an empty or malformed poll", () => {
            for (const incoming of [[], null, undefined, "nope"])
                assert.equal(mergeNewTests(LIST, incoming), LIST);
        });
    });

    describe("adding", () => {
        it("prepends a genuinely newer test", () => {
            const merged = mergeNewTests(LIST, [test(11, "2026-08-07T13:00:00.000Z"), ...LIST]);
            assert.deepEqual(merged.map((entry) => entry.id), [11, 10, 9, 8]);
        });

        it("prepends several at once, newest first", () => {
            const merged = mergeNewTests(LIST, [
                test(12, "2026-08-07T14:00:00.000Z"),
                test(11, "2026-08-07T13:00:00.000Z")
            ]);
            assert.deepEqual(merged.map((entry) => entry.id), [12, 11, 10, 9, 8]);
        });

        it("takes the whole poll when nothing is on screen yet", () => {
            assert.deepEqual(mergeNewTests([], LIST), LIST);
        });
    });

    /**
     * The regression this exists for. A history export is ordered by `created`
     * descending and the import inserts in that order, so after a restore the
     * newest test carries the *lowest* id. Comparing ids then marks almost every
     * polled row as new.
     */
    describe("a restored instance, where ids run backwards", () => {
        const restored = [
            test(1, "2026-08-07T12:00:00.000Z"),
            test(2, "2026-08-07T11:00:00.000Z"),
            test(3, "2026-08-07T10:00:00.000Z")
        ];

        it("adds nothing when the poll repeats the same rows", () => {
            assert.equal(mergeNewTests(restored, [...restored]), restored);
        });

        it("does not grow when polled repeatedly", () => {
            let list = restored;
            for (let poll = 0; poll < 20; poll++) list = mergeNewTests(list, [...restored]);

            assert.equal(list.length, 3, "the list must not accumulate duplicates");
        });

        it("still notices a real new test", () => {
            const merged = mergeNewTests(restored, [test(99, "2026-08-07T13:00:00.000Z"), ...restored]);
            assert.deepEqual(merged.map((entry) => entry.id), [99, 1, 2, 3]);
        });
    });

    describe("identity and ordering", () => {
        // A row already on screen must never be duplicated, whatever its id.
        it("ignores a test already in the list even if it looks newer", () => {
            const merged = mergeNewTests(LIST, [test(10, "2026-08-07T12:00:00.000Z")]);
            assert.equal(merged, LIST);
        });

        it("ignores an older test that is not on screen", () => {
            const merged = mergeNewTests(LIST, [test(7, "2026-08-07T09:00:00.000Z")]);
            assert.equal(merged, LIST, "an older row belongs at the bottom, which pagination handles");
        });

        it("ignores a test created at exactly the same moment as the newest", () => {
            const merged = mergeNewTests(LIST, [test(11, "2026-08-07T12:00:00.000Z")]);
            assert.equal(merged, LIST);
        });
    });
});
