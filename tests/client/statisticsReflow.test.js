import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as sass from "sass";
import { fileURLToPath, pathToFileURL } from "node:url";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const read = (file) => fs.readFileSync(path.join(CLIENT_SRC, file), "utf8");

const aliasImporter = {
    findFileUrl(url) {
        if (!url.startsWith("@/")) return null;
        return pathToFileURL(path.join(CLIENT_SRC, url.slice(2)));
    }
};

const compile = (file) => sass.compile(path.join(CLIENT_SRC, file), {importers: [aliasImporter]}).css;

const page = compile("pages/Statistics/styles.sass");
const statContainer = compile("pages/Statistics/components/StatisticContainer/styles.sass");
const chartContainer = compile("pages/Statistics/charts/SpeedChart/styles.sass");
const layoutSource = read("common/styles/layout.sass");

/** Every max-width ceiling a stylesheet reflows on. */
const ceilings = (css) => [...css.matchAll(/@media([^{]*)\{/g)]
    .map(([, condition]) => Number(condition.match(/max-width:\s*(\d+)px/)?.[1]))
    .filter(Number.isFinite);

// The @media header is dropped rather than parsed: a rule body may contain a
// brace, so a naive pass reads the whole nested block as one @media rule and
// the selectors inside it are never seen at all.
const rules = (css) => [...css.replace(/@media[^{]*\{/g, "").matchAll(/([^{}]+)\{([^}]*)}/g)]
    .map(([, selector, body]) => ({selector: selector.replace(/\s+/g, " ").trim(), body}))
    .filter(({selector}) => selector.length > 0);

/**
 * The nine cards had two shapes and one figure deciding between them.
 *
 * Three to a row down to 900px and then one to a row, with that 900 written out
 * separately in the stat cards' stylesheet and in the chart cards'. Measured in
 * a headless browser in MB/s, where every figure gains a decimal and a wider
 * unit: the cards that were cut at 1300px were still being cut at 920, because
 * nothing between those widths changed - "Variation within a test" lost 97px,
 * "Download" 60, "Maximum" 33, while the summary beside them held 490px and the
 * hourly chart 526.
 */
describe("the statistics page's shape", () => {
    it("keeps its breakpoints in one place rather than one per stylesheet", () => {
        assert.match(layoutSource, /\$stats-two-column:\s*\d+px/,
            "the two-column stage has no shared constant");
        assert.match(layoutSource, /\$stats-one-column:\s*\d+px/,
            "the one-column stage has no shared constant");
    });

    // The figure they used to share by coincidence. Either card type keeping a
    // hardcoded ceiling is the page reflowing in two halves at two widths.
    it("leaves no card type reflowing on a width of its own", () => {
        for (const [name, css] of [["stat", statContainer], ["chart", chartContainer]])
            assert.ok(!ceilings(css).includes(900),
                `the ${name} cards still change width at their own hardcoded 900px`);
    });

    it("declares the two-column stage above the one-column stage", () => {
        const declared = ceilings(page);

        assert.equal(declared.length, 2, `the page declares ${declared.length} stages, expected two`);
        assert.deepEqual(declared, [...declared].sort((a, b) => b - a),
            "the narrower stage is declared first, so the wider one wins at every width they share");
    });

    /**
     * The cards are direct children of the same area the modal is a child of,
     * and the modal renders this very markup with the whole viewport to spend.
     * A descendant selector reflows the enlarged view along with the page
     * behind it - the trap OverviewChart already works around by hand.
     */
    it("reflows the page's own cards and not the modal's", () => {
        const staged = rules(page).filter(({selector}) =>
            /\.stats-container|\.chart-container/.test(selector));

        assert.ok(staged.length > 0, "the page no longer sizes the cards at all");

        for (const {selector} of staged)
            assert.match(selector, /\.statistic-area >/,
                `"${selector}" reaches into the modal, which has the whole viewport to spend`);
    });
});

/**
 * Three cards to a row share it equally.
 *
 * The bases were 35% for the summary, 15% for the panels beside it and 5% for
 * the value cards, with flex-grow: 1 on every one - so the leftover was split
 * equally and never corrected the lopsided start. Their contents want the same
 * room as each other: measured after, every card on the page is the same width
 * at every width, and the only thing still cut anywhere in the range is one
 * description sub-line by 7px, on an element whose whole job is to ellipsise.
 */
describe("what a card asks for while three share a row", () => {
    const basisOf = (selector) => {
        const rule = rules(statContainer).find((r) => r.selector.split(",")
            .some((part) => part.trim() === selector));
        assert.ok(rule, `${selector} declares nothing`);

        const flex = rule.body.match(/flex:\s*([^;]+)/)?.[1]?.trim();
        assert.ok(flex, `${selector} sets no flex`);
        return flex;
    };

    it("asks for the same share whichever card it is", () => {
        const base = basisOf(".stats-container");

        for (const size of [".container-small", ".container-normal", ".container-large"])
            assert.equal(basisOf(size), base,
                `${size} still starts from a different width than the cards beside it`);
    });

    // The old figures, named so a partial revert is caught rather than passing
    // as "some flex is set".
    it("has none of the three lopsided bases left", () => {
        for (const old of [/flex:\s*1 1 5%/, /flex:\s*1 1 15%/, /flex:\s*1 1 35%/])
            assert.doesNotMatch(statContainer, old,
                `a card still starts from ${old}, which is what cut the labels`);
    });
});

/**
 * And the step that was missing between three across and one.
 *
 * The pairs fall out of the order the cards are already written in, once the
 * summary takes a row of its own: last test beside stability, the two speed
 * charts, ping beside the hourly average, and the two value cards. Measured:
 * 1+2+2+2+2 from 1000px to 760, with nothing cut on any card.
 */
describe("the two-column stage", () => {
    const twoColumn = () => {
        const start = page.indexOf("@media");
        const end = page.indexOf("@media", start + 1);
        assert.notEqual(start, -1, "the page declares no stages at all");
        return page.slice(start, end === -1 ? undefined : end);
    };

    it("puts two cards on a row", () => {
        assert.match(twoColumn(), /flex:\s*1 1 calc\(50%/,
            "the cards do not take half a row each, so there is no two-column stage");
    });

    it("spans the summary across both of them", () => {
        const spanning = rules(twoColumn()).find(({selector}) => selector.includes(".container-large"));

        assert.ok(spanning, "the summary card takes half a row like the rest, which leaves nine cards unpaired");
        assert.match(spanning.body, /flex:\s*1 1 100%/,
            "the summary does not span the row, so the pairs below it are off by one");
    });
});

/**
 * A card's border is part of its width.
 *
 * The reset in default.sass reaches `main > *`, which is the area around these
 * rather than the cards themselves, so a full-width card measured 100% plus its
 * two 1px borders - and 100% plus 18px below 500px, where the chart card also
 * takes padding. Measured: every card overhung the area by 2px from 900px down
 * and by 18px from 500, which is the page's right-hand gutter gone.
 */
describe("a card that has the row to itself", () => {
    for (const [name, css] of [["stat", statContainer], ["chart", chartContainer]])
        it(`counts the ${name} card's border inside its width`, () => {
            const container = rules(css).find(({selector}) =>
                selector === `.${name === "stat" ? "stats" : "chart"}-container`);

            assert.ok(container, `.${name} card has no base rule`);
            assert.match(container.body, /box-sizing:\s*border-box/,
                "the card is its stated width plus its border, so it overhangs the page");
        });
});
