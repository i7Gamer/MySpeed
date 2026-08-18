import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withoutComments } from "../helpers/source.js";

/**
 * The helper that lets a scan assert about code rather than about prose.
 *
 * Worth its own tests because it is a state machine, and the way it fails is
 * quiet: strip too much and an assertion stops seeing the code it is about;
 * strip too little and a comment goes on answering for it. Neither shows up as
 * an error, only as a test that has stopped meaning what it says.
 */
describe("withoutComments", () => {
    it("removes a line comment and keeps the code before it", () => {
        assert.equal(withoutComments("const a = 1; // set a").trimEnd(), "const a = 1;");
    });

    it("keeps the newline a line comment ends on", () => {
        assert.equal(withoutComments("// gone\nconst a = 1;").split("\n")[1], "const a = 1;");
    });

    it("removes a block comment", () => {
        assert.match(withoutComments("const a = /* why */ 1;"), /const a = {11}1;/);
    });

    it("removes a multi-line block comment but keeps the lines", () => {
        const stripped = withoutComments("a\n/*\n * middle\n */\nb");

        assert.equal(stripped.split("\n").length, 5);
        assert.equal(stripped.split("\n")[0], "a");
        assert.equal(stripped.split("\n")[4], "b");
        assert.doesNotMatch(stripped, /middle/);
    });

    /* The case that makes a naive strip wrong: a URL is not a comment. */
    it("leaves a protocol's slashes alone", () => {
        const source = 'const url = "https://example.com/a";';

        assert.equal(withoutComments(source), source);
    });

    it("leaves a comment marker inside a string alone", () => {
        [`const a = "// not a comment";`, `const a = '/* nor this */';`, "const a = `//`;"]
            .forEach((source) => assert.equal(withoutComments(source), source));
    });

    it("does not end a string at an escaped quote", () => {
        const source = 'const a = "he said \\" // still a string";';

        assert.equal(withoutComments(source), source);
    });

    /*
     * The reason this exists at all: the house style explains what a change
     * replaced, so the old form is named in the comment beside the new one.
     */
    it("takes the old form out of a comment while leaving the new one in the code", () => {
        const source = [
            "// This asked /[^0-9.]/, which is not what a number is.",
            "const ok = THRESHOLD.test(value);"
        ].join("\n");

        const stripped = withoutComments(source);

        assert.doesNotMatch(stripped, /\[\^0-9\.]/);
        assert.match(stripped, /THRESHOLD\.test\(value\)/);
    });

    it("keeps the length of the file, so a failure reads against the original", () => {
        const source = "const a = 1; // why\nconst b = 2;\n/* and */\n";

        assert.equal(withoutComments(source).length, source.length);
    });

    it("survives a file that ends inside a comment", () => {
        assert.doesNotMatch(withoutComments("const a = 1;\n// unterminated"), /unterminated/);
        assert.doesNotMatch(withoutComments("const a = 1;\n/* unterminated"), /unterminated/);
    });

    it("leaves a division alone", () => {
        const source = "const half = total / 2;";

        assert.equal(withoutComments(source), source);
    });
});
