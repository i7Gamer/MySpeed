import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bodyIn, bodyOf, readSource } from "../helpers/source.js";

/**
 * The helper several tests read source with, which had been written twice.
 *
 * Both copies existed to stop an assertion running past the declaration it was
 * about - the one in tasks/timer.js would otherwise reach runTask, whose own
 * `.catch` would satisfy an assertion about startTimer and hide exactly the
 * thing that assertion was added for. A helper that quietly returns the wrong
 * slice turns every test built on it into one that cannot fail, so it gets
 * tests of its own.
 */
describe("bodyOf", () => {
    it("returns the balanced body of a declaration", () => {
        const source = "const a = () => { one(); };\nconst b = () => { two(); };";

        assert.equal(bodyOf(source, "const a"), "{ one(); }");
    });

    it("keeps nested braces rather than stopping at the first close", () => {
        const source = "const a = () => { if (x) { deep(); } done(); };";

        assert.equal(bodyOf(source, "const a"), "{ if (x) { deep(); } done(); }");
    });

    // The failure the two copies existed to prevent: a slice that runs on into
    // the next function passes assertions that belong to neither.
    it("stops before the declaration that follows", () => {
        const source = "const a = () => { plain(); };\nconst b = () => { caught().catch(noop); };";

        assert.doesNotMatch(bodyOf(source, "const a"), /catch/,
            "the slice ran into the next function, where anything at all can be found");
    });

    it("finds a declaration that is not the first in the file", () => {
        const source = "const a = () => { one(); };\nexport const b = () => { two(); };";

        assert.equal(bodyOf(source, "export const b"), "{ two(); }");
    });

    /**
     * Loud rather than quiet, both ways round. A helper that answered "" for a
     * declaration that has been renamed would leave every assertion built on it
     * passing against nothing.
     */
    it("throws when the declaration is gone", () => {
        assert.throws(() => bodyOf("const a = () => {};", "const gone"), /not in this source/);
    });

    it("throws when the body is never closed", () => {
        assert.throws(() => bodyOf("const a = () => { unclosed();", "const a"), /never closed/);
    });
});

describe("readSource", () => {
    it("reads a file relative to the repository root", () => {
        assert.match(readSource("package.json"), /"name": "myspeed"/);
    });
});

describe("bodyIn", () => {
    it("reads and slices in one step", () => {
        assert.match(bodyIn("server/util/serialiseQueue.js", "export const createQueue"),
            /tail\.then\(task\)/);
    });

    /**
     * An arrow with no braces has no body to match, and the walker finds the
     * next `{` anywhere below it instead. It says so rather than returning
     * whatever that turned out to be - isUntrustedReader is one line long and
     * would otherwise have handed back some later function's body.
     */
    it("refuses a declaration with no braces to balance", () => {
        assert.throws(() => bodyIn("server/util/untrustedReader.js", "export const isUntrustedReader"),
            /never closed/);
    });
});
