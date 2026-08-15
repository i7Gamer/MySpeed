import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const CLIENT_SRC = path.join(ROOT, "client", "src");

const read = (file) => fs.readFileSync(path.join(CLIENT_SRC, file), "utf8");
const locale = (code) => JSON.parse(
    fs.readFileSync(path.join(ROOT, "client", "public", "assets", "locales", `${code}.json`), "utf8"));

const row = read("pages/Home/components/Speedtest/SpeedtestComponent.jsx");

// The delete handler alone. A fixed window from the openConfirm call was not
// enough: the question names the test it is about, so the call spans lines.
const removeTest = (() => {
    const at = row.indexOf("const removeTest");
    assert.notEqual(at, -1, "removeTest is gone");

    const end = row.indexOf("\n    }", at);
    assert.notEqual(end, -1, "removeTest is never closed");

    return row.slice(at, end);
})();

/**
 * Deleting a test asks first.
 *
 * The button sat in the expanded detail pane and deleted on the click - no
 * confirmation, and nothing that undoes it. A test is a measurement of a moment
 * that will not come round again: unlike a config value there is no way to put
 * it back, and the row it was in is the row a misdirected click lands on, since
 * the pane opens directly under the one being read.
 *
 * Every other irreversible action in the app already asks. Removing a node and
 * removing the password both go through alert.openConfirm with `danger: true`,
 * and clearing the whole history makes the button ask twice. Deleting a single
 * test was the one that did not.
 */
describe("deleting a test", () => {
    it("asks before it deletes", () => {
        assert.match(row, /openConfirm\(/,
            "the delete button still deletes on the click, with nothing to undo it");
    });

    /**
     * The confirmation has to gate the request, not merely precede it. Awaiting
     * a confirmation and then deleting regardless is the shape that reads
     * correct and is not.
     */
    it("does not delete when the answer is no", () => {
        assert.match(removeTest, /openConfirm\(/, "the confirmation is not part of the delete path");
        assert.ok(removeTest.indexOf("openConfirm(") < removeTest.indexOf("deleteRequest("),
            "the test is deleted before the answer comes back");
        assert.match(removeTest, /if\s*\(!confirmed\)\s*return|if\s*\(confirmed\)/,
            "nothing acts on the answer, so declining still deletes");
    });

    // The same treatment the node deletion gets: a red button, because the
    // dialog's default reads as the safe choice and this one is not.
    it("marks it as the dangerous action it is", () => {
        assert.match(removeTest, /danger:\s*true/,
            "the confirmation offers deletion as an ordinary choice");
    });

    it("names the action on the button rather than saying OK", () => {
        assert.match(removeTest, /buttonText:/,
            "the confirming button says OK, which says nothing about what it does");
    });

    // The toast and the fade are the report that it happened, and they must not
    // run for a deletion the reader declined.
    it("says nothing when the answer is no", () => {
        assert.ok(removeTest.indexOf("if (!confirmed) return") < removeTest.indexOf("fadeOut("),
            "the row fades out before the answer is known");
    });
});

/**
 * And it says which test, in every language that ships one.
 *
 * German ships with the feature and the rest follow through Crowdin - the same
 * rule germanLocale holds the file to.
 */
describe("what the confirmation says", () => {
    const KEYS = ["title", "description", "yes"];

    for (const code of ["en", "de"]) {
        it(`${code}.json carries the confirmation`, () => {
            const strings = locale(code).test?.delete_confirm;

            assert.notEqual(strings, undefined, `${code}.json has no test.delete_confirm`);

            for (const key of KEYS)
                assert.equal(typeof strings[key], "string", `test.delete_confirm.${key} is missing from ${code}.json`);
        });
    }

    // The row a misdirected click lands on is the one being read, so the
    // question has to name the test rather than asking about "this item".
    it("names the test it is about to delete", () => {
        assert.match(locale("en").test.delete_confirm.description, /\{\{date}}/,
            "the question does not say which test it means");
    });

    it("says the deletion cannot be undone", () => {
        assert.match(locale("en").test.delete_confirm.description, /cannot be undone/i);
    });

    it("is wired to those keys", () => {
        for (const key of KEYS)
            assert.match(row, new RegExp(`test\\.delete_confirm\\.${key}`),
                `the component does not use test.delete_confirm.${key}`);
    });
});
