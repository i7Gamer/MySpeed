import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as sass from "sass";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const aliasImporter = {
    findFileUrl(url) {
        if (!url.startsWith("@/")) return null;
        return pathToFileURL(path.join(CLIENT_SRC, url.slice(2)));
    }
};

const compile = (file) => sass.compile(path.join(CLIENT_SRC, file), {importers: [aliasImporter]}).css;

const readSource = (file) => fs.readFileSync(path.join(CLIENT_SRC, file), "utf8");

const header = compile("common/components/Header/styles.sass");
const exportButton = compile("common/components/ExportButton/styles.sass");
const startTest = compile("common/components/StartTestButton/styles.sass");

/** The body of every media query whose condition mentions the given text. */
const queriesMentioning = (css, condition) => [...css.matchAll(/@media([^{]*)\{([\s\S]*?)\n}/g)]
    .filter(([, header]) => header.includes(condition))
    .map(([, , body]) => body);

/**
 * The header's title box on a narrow screen.
 *
 * Reported as "the logo more or less disappears", and measured in a headless
 * browser across the range: the logo was clipped from 480px down, one pixel at
 * first and its whole 30px by 338px, while the name lost its last letter off
 * the other end at the same time.
 *
 * Both edges at once is the tell. Below 650px .header-left becomes a column,
 * where align-items is the *horizontal* alignment - and a flex item wider than
 * its container, centred, overflows it equally on both sides. .header-left
 * hides its overflow, so the title box was trimmed left and right together and
 * the logo, sitting at its left edge, went first.
 */
describe("the header keeps its logo on a narrow screen", () => {
    const column = queriesMentioning(header, "650px");

    it("stacks the header-left into a column at all", () => {
        assert.ok(column.length > 0, "the column media query is gone");
        assert.ok(column.some((body) => /flex-direction:\s*column/.test(body)),
            "header-left no longer becomes a column, so this rule guards nothing");
    });

    // The fix. Centred, the overflow is split between the two edges and the
    // logo is on one of them; started, the box begins where the column does
    // and can only ever give at the right, where the title's own ellipsis is.
    it("aligns the stacked column to its start, not its centre", () => {
        const left = column.filter((body) => /\.header-left/.test(body));

        assert.ok(left.some((body) => /align-items:\s*flex-start/.test(body)),
            "the column still centres its children, which clips the logo off the left edge");
        assert.ok(!left.some((body) => /align-items:\s*center/.test(body)),
            "something in the column query still centres .header-left");
    });

    /**
     * Alignment alone is half of it: left at its content width the heading
     * would overflow the column rather than be centred in it - the same clip,
     * one edge fewer. Capped, the button inside shrinks and the name ellipses,
     * which is the one thing on that line that can lose a character and still
     * be read.
     */
    it("lets the heading shrink into the column", () => {
        assert.ok(column.some((body) => /\.header-about-heading[^{]*\{[^}]*max-width:\s*100%/.test(body)),
            "the heading can still be wider than the column it sits in");
    });

    // The logo is the one thing on the line that must not shrink - a title can
    // ellipse, a 30px mark cannot lose 10px and still be itself.
    it("never lets the logo itself be shrunk by a flex parent", () => {
        assert.match(header, /\.header-logo\s*\{[^}]*flex-shrink:\s*0/,
            "the logo can now be squeezed by its flex parent instead of holding its size");
    });
});

/**
 * And the title box on a *wide* screen, where the other half of the report was.
 *
 * The squeeze zone that trades the 10% inset for 3% used to stop at 969px, on
 * the reasoning that the pagination drops its labels below 968 and the usual
 * inset fits again. It does not: at 800px the title box wants 227px and the
 * column was 215, so the name ellipsed some 45px before the pagination moved
 * down at 768 and handed the room back - "cuts off before the navigation moves
 * down", exactly as reported.
 */
describe("the header title survives the width above the reflow", () => {
    it("keeps the reduced inset down to where the layout actually reflows", () => {
        const squeeze = [...header.matchAll(/@media([^{]*)\{/g)]
            .map(([, condition]) => condition)
            .find((condition) => condition.includes("1250px"));

        assert.ok(squeeze, "the squeeze zone is gone");
        assert.match(squeeze, /769px/,
            "the reduced inset still stops at 969px, leaving 200px of widths where the name is cut");
        assert.doesNotMatch(squeeze, /969px/, "the old 969px floor is still there");
    });
});

/**
 * The order the header's breakpoints are written in, which decides them.
 *
 * Media queries carry no specificity of their own, so two max-width blocks that
 * both match a width are settled by which comes last in the file. Written from
 * wide to narrow that is the useful way round - the narrower block is the more
 * specific case and wins - and every rule here was authored on that assumption.
 *
 * One out-of-place block breaks it silently and only for the rules it shares
 * with another: a 570px block sitting after the 480px one keeps its own rules
 * at every width it matches, so it reads as working right up until someone adds
 * a property the 480px block also sets, which then loses on the narrowest
 * screens - the widths it was written for. Nothing in the compiled output says
 * so, and no rendering test would catch it until that second rule exists.
 */
describe("the header's breakpoints run wide to narrow", () => {
    /**
     * Only the blocks bounded from above alone. The squeeze zone states a
     * min-width and a max-width together, which places it by neither end, and
     * ordering it against the rest would be a rule about nothing.
     */
    const ceilings = [...header.matchAll(/@media([^{]*)\{/g)]
        .map(([, condition]) => condition)
        .filter((condition) => !condition.includes("min-width"))
        .map((condition) => Number(condition.match(/max-width:\s*(\d+)px/)?.[1]))
        .filter((width) => Number.isFinite(width));

    it("has breakpoints to order at all", () => {
        assert.ok(ceilings.length > 2, "the header no longer has max-width breakpoints to order");
    });

    it("declares each one below the one above it", () => {
        const descending = [...ceilings].sort((a, b) => b - a);

        assert.deepEqual(ceilings, descending,
            `breakpoints are declared ${ceilings.join(" -> ")}; a block out of order wins`
            + " over the narrower ones below it for every rule they share");
    });

    // Two blocks with the same ceiling are the same case written twice, and
    // which of them wins is then a question about line numbers.
    it("states each width once", () => {
        assert.equal(new Set(ceilings).size, ceilings.length,
            `two blocks share a ceiling: ${ceilings.join(" -> ")}`);
    });
});

/**
 * The toolbar's labels, and the width they are given up at.
 *
 * Measured with the labels forced on across the range: the date picker beside
 * them absorbs the slack, and all three controls hold a single line with every
 * label down to 480px - the row first wraps at 460. The export dropped the word
 * "Export" at 600, with 120px of room still under it.
 */
describe("the toolbar controls keep their labels until they do not fit", () => {
    it("collapses the export at the measured width, not at 600px", () => {
        const collapse = queriesMentioning(exportButton, "480px");

        assert.ok(collapse.some((body) => /\.export-text[^{]*\{[^}]*display:\s*none/.test(body)),
            "the export label is not dropped at 480px");
        assert.equal(queriesMentioning(exportButton, "600px").length, 0,
            "the export still collapses at 600px as well");
    });

    /**
     * And only where there is a start button to make room for.
     *
     * A read-only visitor cannot start a test, so that control renders nothing
     * at all and the row is two controls wide. Measured in read-only mode: the
     * picker and the *labelled* export hold one line together at every width
     * down to 320px, status bar on its own row as before - so there is nothing
     * to buy there and nothing is spent.
     *
     * An adjacent sibling rather than :has(): the export follows the start
     * button directly in the toolbar's markup, so this is a plain sibling match
     * with no support caveat behind it.
     */
    it("keeps the export's label when no start button shares its row", () => {
        const collapse = queriesMentioning(exportButton, "480px");
        const hiding = collapse.filter((body) => /\.export-text[^{]*\{[^}]*display:\s*none/.test(body));

        assert.ok(hiding.length > 0, "nothing hides the label at all");

        for (const body of hiding)
            assert.match(body, /\.start-test\s*\+\s*\.export-button-container[^{]*\.export-text/,
                "the label is dropped whether or not a start button stands beside it");
    });

    // The square, the missing chevron and the menu's own anchor all answer to
    // the collapse, so they have to be scoped with it - a labelled button in
    // read-only mode lends the menu its 141px and needs none of them.
    it("scopes the whole collapsed shape, not only the label", () => {
        const collapse = queriesMentioning(exportButton, "480px");

        for (const property of [/aspect-ratio/, /\.chevron-icon/, /\.export-dropdown/]) {
            const owner = collapse.find((body) => property.test(body));
            assert.ok(owner, `nothing in the narrow query mentions ${property}`);
            assert.match(owner, /\.start-test\s*\+\s*\.export-button-container/,
                `${property} applies even with no start button beside the export`);
        }
    });

    it("tightens the start button at the same width, so the two agree", () => {
        assert.ok(queriesMentioning(startTest, "480px").length > 0,
            "the start button still tightens at a different width from the export beside it");
        assert.equal(queriesMentioning(startTest, "600px").length, 0,
            "the start button still has its old 600px rule");
    });

    /**
     * The start button keeps its word for as long as there is room for it - it
     * is the page's primary action and a bare gauge does not say "start a
     * test" - and gives it up only where keeping it costs the toolbar a row.
     *
     * By 366px the date picker is at its own minimum and the row cannot hold
     * three labelled controls: the export was pushed onto a line of its own,
     * which is both a third row and that control sitting at the left-hand end,
     * the one place in the app it never is. The word is ~90px, which is the
     * whole difference between those two layouts.
     */
    it("keeps the start button's label down to where the row runs out", () => {
        // 368, not a round number: measured, 369px still holds all three
        // labelled and 368 is the first width that wraps.
        const collapse = queriesMentioning(startTest, "368px");
        const earlier = queriesMentioning(startTest, "480px");

        assert.ok(collapse.some((body) => /span\s*\{[^}]*display:\s*none/.test(body)),
            "the start button never drops its label, so the export keeps its own row");
        assert.ok(!earlier.some((body) => /span\s*\{[^}]*display:\s*none/.test(body)),
            "the label goes at 480px, a hundred pixels before it has to");
    });

    // Hiding the only text in a button leaves it with no accessible name at
    // all. Both controls in this row collapse, so both carry their name.
    it("keeps both collapsing controls named for a screen reader", () => {
        const start = readSource("common/components/StartTestButton/StartTestButton.jsx");
        const exportSource = readSource("common/components/ExportButton/ExportButton.jsx");

        assert.match(start, /aria-label=\{label}/,
            "the start button is a bare gauge glyph with no name once collapsed");
        assert.match(exportSource, /aria-label=\{t\("statistics\.export\.button"\)}/,
            "the export button is a bare download glyph with no name once collapsed");
    });
});

/**
 * Where the export menu opens once the button is an icon.
 *
 * Reported as "appears on the bottom of the page". It did: the narrow rule
 * turned it into a fixed bottom sheet pinned to the viewport, a long way from
 * the icon that opened it and with nothing to say which control it belonged
 * to. The shared open animation tweens `transform`, which is what that sheet
 * used to centre itself, so it also slid in from half a screen off.
 */
describe("the export menu opens under its own button", () => {
    const narrow = queriesMentioning(exportButton, "480px")
        .filter((body) => /\.export-dropdown/.test(body));

    it("does not pin the menu to the viewport", () => {
        assert.ok(narrow.length > 0, "the narrow rule for the dropdown is gone");

        for (const body of narrow) {
            assert.doesNotMatch(body, /position:\s*fixed/,
                "the menu is still fixed to the viewport rather than to its button");
            assert.doesNotMatch(body, /bottom:\s*1rem/, "the menu still sits at the foot of the screen");
        }
    });

    // The container is the positioning context at every width, so the menu
    // hangs off the button in both layouts rather than off the page.
    it("keeps the button's container as what it is positioned against", () => {
        assert.match(exportButton, /\.export-button-container\s*\{[^}]*position:\s*relative/,
            "the menu has nothing to anchor to");
        assert.match(exportButton, /\.export-dropdown\s*\{[^}]*position:\s*absolute/,
            "the menu is no longer positioned against its container");
    });

    // A ~45px square button cannot lend the menu its width, so the menu states
    // one of its own - otherwise the two options wrap inside a 45px panel.
    it("gives the menu a width the button no longer has", () => {
        assert.ok(narrow.some((body) => /min-width:/.test(body)),
            "the menu takes the collapsed button's width, which is one icon wide");
    });

    /**
     * And the button it hangs off has to be somewhere the menu can hang from.
     *
     * The menu opens off the button's right edge, so a button at the *left* of
     * a row opens it leftwards off the screen - measured at 114px past the edge
     * on a 338px screen, where the picker hits its minimum and the export is
     * pushed onto a line of its own. Held at the right-hand end the anchor is
     * the same at every width, which is why this belongs with the menu's
     * position rather than with the toolbar's layout.
     */
    it("holds the export at the right-hand end of whatever row it lands on", () => {
        const toolbar = compile("common/components/PageToolbar/styles.sass");
        const wrapped = queriesMentioning(toolbar, "900px");

        assert.ok(wrapped.some((body) =>
            /\.export-button-container\s*\{[^}]*margin-left:\s*auto/.test(body)),
            "a wrapped export sits at the left of its row, which opens its menu off-screen");
    });
});
