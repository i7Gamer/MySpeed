import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mediaBlocks, rules, ceilings, queriesMentioning } from "../helpers/sass.mjs";

/**
 * The parsers the stylesheet tests share, proven against the shapes that broke
 * their private predecessors.
 *
 * Five files each carried a variant of these, and the variants had already
 * diverged: one rules() read a whole @media block as a single rule because a
 * body may contain a brace, one ceilings() would count a min/max squeeze block
 * as a stage, and every media-block finder relied on the compiler ending a
 * block with a close-brace at the start of a line. The copies are gone; this
 * file pins the one implementation to the cases that separated them.
 */
const nested = [
    ".before { color: red }",
    "@media screen and (max-width: 900px) {",
    "  .inside { color: blue }",
    "  .also-inside { color: green }",
    "}",
    ".after { color: yellow }",
    "@media (min-width: 500px) and (max-width: 800px) {",
    "  .squeeze { color: gray }",
    "}"
].join("\n");

describe("mediaBlocks", () => {
    it("captures a whole block by counting braces, not by output style", () => {
        const blocks = mediaBlocks(nested);

        assert.equal(blocks.length, 2, "a block was missed or split");
        assert.match(blocks[0].body, /\.inside/);
        assert.match(blocks[0].body, /\.also-inside/,
            "the block ended at the first rule inside it");
        assert.doesNotMatch(blocks[0].body, /\.after/,
            "the block ran past its own closing brace");
    });

    // Minified or re-styled compiler output has no newline before the closing
    // brace; the old `\n}` heuristic read to the end of the sheet there.
    it("survives a block that does not end at a line start", () => {
        const tight = "@media (max-width: 600px){.a{color:red}.b{color:blue}}.c{color:green}";
        const blocks = mediaBlocks(tight);

        assert.equal(blocks.length, 1);
        assert.match(blocks[0].body, /\.b\{/);
        assert.doesNotMatch(blocks[0].body, /\.c\{/, "the block swallowed the rule after it");
    });
});

describe("rules", () => {
    it("sees the rules inside a media block rather than one giant rule", () => {
        const selectors = rules(nested).map(({selector}) => selector);

        assert.ok(selectors.includes(".inside"),
            "a naive pass read the whole @media block as one rule");
        assert.ok(selectors.includes(".after"));
    });

    // Sass emits `[data-compact=all]` for a source that wrote quotes, so a
    // parser that keeps either spelling makes every comparison miss the other.
    it("normalises quotes and whitespace so attribute selectors compare", () => {
        const [rule] = rules('.page-toolbar[data-compact="export"]  .export-text { display: none }');

        assert.equal(rule.selector, ".page-toolbar[data-compact=export] .export-text");
    });
});

describe("ceilings", () => {
    // The squeeze block states a min-width and a max-width together, which
    // places it by neither end - counting it as a ceiling made one caller see
    // stages that are not there.
    it("reads each max-width ceiling once, skipping squeeze blocks", () => {
        assert.deepEqual(ceilings(nested), [900]);
    });
});

describe("queriesMentioning", () => {
    it("returns the bodies of the blocks whose condition matches", () => {
        const bodies = queriesMentioning(nested, "900px");

        assert.equal(bodies.length, 1);
        assert.match(bodies[0], /\.inside/);
        assert.equal(queriesMentioning(nested, "1200px").length, 0);
    });
});
