import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
});

/**
 * The overview is the page that can show everything, so it is the one that can
 * offer the way back. The statistics cannot draw an unbounded range, so they
 * name the range and leave the picker - which sits right above the message - to
 * do the rest.
 */
describe("the way back from an empty range", () => {
    it("offers all time on the overview", () => {
        assert.equal(typeof english.test.show_all_time, "string");
        assert.match(testArea, /test\.show_all_time/);
        assert.match(testArea, /TIMEFRAME_ALL/, "the button selects something other than all time");
    });

    it("only offers it when a range is what emptied the list", () => {
        // The button hangs off the same branch as the range sentence, so an
        // instance with no tests at all is not told to widen a range it never
        // narrowed.
        const rangeBranch = testArea.slice(testArea.indexOf("not_available_in_range"));
        const plainBranch = testArea.slice(0, testArea.indexOf("not_available_in_range"));

        assert.match(rangeBranch, /show_all_time/);
        assert.doesNotMatch(plainBranch, /show_all_time/);
    });
});
