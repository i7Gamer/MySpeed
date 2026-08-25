import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { containerBlocks, declarationsIn, mediaBlocks, rules, ceilings, queriesMentioning } from "../helpers/sass.mjs";

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

describe("containerBlocks", () => {
    // Same contract as mediaBlocks, for the width the element itself measures.
    it("captures @container blocks the way mediaBlocks captures @media", () => {
        const sheet = "@container (width < 25rem){.a{display:none}.b{color:red}}.c{color:blue}";
        const blocks = containerBlocks(sheet);

        assert.equal(blocks.length, 1);
        assert.match(blocks[0].condition, /width < 25rem/);
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

/**
 * The next batch of the same drift: three suites grew a private copy of this
 * walk within one review - the palette-contrast blocks, the boot script's
 * backgrounds, the chart-token comparison. The cases below are the ones a
 * copy gets subtly wrong.
 */
describe("declarationsIn", () => {
    const css = [
        ":root { --a: 1; --b: var(--a); }",
        ":root { --a: 2 ; }",
        "[data-palette=nord] { --a: 3; }",
        "[data-palette=nord][data-theme=light] { --a: 4; }"
    ].join("\n");

    it("merges a selector's blocks in source order, values trimmed", () => {
        assert.deepEqual(declarationsIn(css, ":root"), {a: "2", b: "var(--a)"});
    });

    /**
     * The loose form - indexOf on the bare selector - reads the two-attribute
     * palette block as part of the one-attribute one, so a property the light
     * block declares looked declared by the dark one.
     */
    it("does not read a selector that merely starts the same", () => {
        assert.deepEqual(declarationsIn(css, "[data-palette=nord]"), {a: "3"});
    });

    it("answers empty for a selector with no block, so absence is assertable", () => {
        assert.deepEqual(declarationsIn(css, "[data-theme=light]"), {});
    });
});
