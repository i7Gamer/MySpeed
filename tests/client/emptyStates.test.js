import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compile, rules } from "../helpers/sass.mjs";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const CLIENT_SRC = path.join(ROOT, "client", "src");

const read = (file) => fs.readFileSync(path.join(CLIENT_SRC, file), "utf8");
const english = JSON.parse(
    fs.readFileSync(path.join(ROOT, "client/public/assets/locales/en.json"), "utf8"));

const testArea = read("pages/Home/components/TestArea/TestAreaComponent.jsx");
const statistics = read("pages/Statistics/Statistics.jsx");

/**
 * Both pages render the same sentence - "there are currently no tests
 * available" - whether the instance has never run one or the reader simply
 * picked a quiet week. Now that both carry a range picker, the second case is
 * by far the more common, and the message neither said so nor offered a way
 * back: a dead end reached by a single click.
 */
describe("the empty state names the range that emptied it", () => {
    it("has a sentence that carries the range", () => {
        assert.equal(typeof english.test.not_available_in_range, "string");
        assert.match(english.test.not_available_in_range, /\{\{from}}/);
        assert.match(english.test.not_available_in_range, /\{\{to}}/);
    });

    it("keeps the range-less sentence for an instance with no tests at all", () => {
        assert.equal(typeof english.test.not_available, "string");
        assert.doesNotMatch(english.test.not_available, /\{\{/);
    });

    it("uses the range sentence on the overview", () => {
        assert.match(testArea, /test\.not_available_in_range/);
        assert.match(testArea, /test\.not_available"/, "the no-tests-at-all case lost its own sentence");
    });

    it("uses the range sentence on the statistics", () => {
        assert.match(statistics, /test\.not_available_in_range/);
    });

    // All time has no dates to name, and the window it reaches the server with
    // is a stand-in - "No tests between 26 Mar 1999 and today" reads as a
    // strangely specific request rather than as an empty instance.
    it("keeps the range-less sentence for all time on the statistics", () => {
        assert.match(statistics, /test\.not_available"/);
    });
});

/**
 * Both pages can show every test they have, so both can offer the way back from
 * a range that emptied them - a dead end otherwise reached by a single click.
 */
describe("the way back from an empty range", () => {
    it("offers all time on the overview", () => {
        assert.equal(typeof english.test.show_all_time, "string");
        assert.match(testArea, /test\.show_all_time/);
        assert.match(testArea, /TIMEFRAME_ALL/, "the button selects something other than all time");
    });

    it("offers it on the statistics too", () => {
        assert.match(statistics, /test\.show_all_time/);
        assert.match(statistics, /TIMEFRAME_ALL/, "the button selects something other than all time");
    });

    for (const [page, source] of [["overview", testArea], ["statistics", statistics]]) {
        it(`only offers it on the ${page} when a range is what emptied the page`, () => {
            // The button hangs off the same branch as the range sentence, so an
            // instance with no tests at all is not told to widen a range it
            // never narrowed.
            const rangeBranch = source.slice(source.indexOf("not_available_in_range"));
            const plainBranch = source.slice(0, source.indexOf("not_available_in_range"));

            assert.match(rangeBranch, /show_all_time/);
            assert.doesNotMatch(plainBranch, /show_all_time/);
        });
    }
});

/**
 * The empty statistics page, whose sentence and button were touching.
 *
 * `.statistics-empty` is a centred flex row holding a `<p>` and a `.dialog-btn`
 * as siblings, and it declared no gap - so "No tests between Aug 25 and Aug 31"
 * ran straight into "Show all time" with nothing between them. Measured in the
 * browser rather than guessed: the paragraph's right edge and the button's left
 * edge were both at 658.06px.
 *
 * The row is what the block was drawn as - centred, with 6rem of vertical
 * padding - so this gives it the gap it was missing rather than restacking it.
 * The wrap is the other half of the same fault: the sentence carries two
 * formatted dates and is the longest string on the page, and a row that cannot
 * wrap puts it and the button through the same squeeze on a narrow screen.
 */
describe("the empty statistics page", () => {
    const css = compile("pages/Statistics/styles.sass");
    const empty = rules(css).find((rule) => rule.selector === ".statistics-empty");

    it("keeps its sentence off its button", () => {
        assert.ok(empty, ".statistics-empty has no rule");
        assert.match(empty.body, /gap:\s*[^;0]/,
            "the sentence and the button are touching, which is how they shipped");
    });

    it("lets the two wrap rather than squeezing them", () => {
        assert.match(empty.body, /flex-wrap:\s*wrap/,
            "a long translated sentence and the button share one unwrappable row");
    });
});
