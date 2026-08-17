import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ceilings, compile, mediaBlocks, queriesMentioning, read } from "../helpers/sass.mjs";

const header = compile("common/components/Header/styles.sass");
const exportButton = compile("common/components/ExportButton/styles.sass");
const startTest = compile("common/components/StartTestButton/styles.sass");

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
        const squeeze = mediaBlocks(header)
            .map(({condition}) => condition)
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
    // Only the blocks bounded from above alone - the helper already skips the
    // squeeze zone, which a min-width places by neither end.
    const headerCeilings = ceilings(header);

    it("has breakpoints to order at all", () => {
        assert.ok(headerCeilings.length > 2, "the header no longer has max-width breakpoints to order");
    });

    it("declares each one below the one above it", () => {
        const descending = [...headerCeilings].sort((a, b) => b - a);

        assert.deepEqual(headerCeilings, descending,
            `breakpoints are declared ${headerCeilings.join(" -> ")}; a block out of order wins`
            + " over the narrower ones below it for every rule they share");
    });

    // Two blocks with the same ceiling are the same case written twice, and
    // which of them wins is then a question about line numbers.
    it("states each width once", () => {
        assert.equal(new Set(headerCeilings).size, headerCeilings.length,
            `two blocks share a ceiling: ${headerCeilings.join(" -> ")}`);
    });
});

/**
 * The toolbar's labels are no longer given up at a width written down here.
 *
 * These figures - 600px, then 480 and 368 - were each measured against the
 * English label and a preset's 126px range trigger. A custom range prints its
 * two dates and is 300px, so the row ran out 220px before the viewport reached
 * any of them: measured, the three controls broke onto separate lines at 660px
 * and kept both labels until 480. PageToolbar measures its own row instead, and
 * toolbarFit.test.js covers the stages it picks.
 *
 * What is left here is the part that is still this file's business: that no
 * viewport figure came back, and that a control which can lose its only text
 * still has a name.
 */
describe("the toolbar controls keep their labels until they do not fit", () => {
    it("has no width in either button deciding a label", () => {
        for (const [name, css] of [["export", exportButton], ["start", startTest]])
            for (const width of ["600px", "480px", "368px"])
                assert.equal(queriesMentioning(css, width).length, 0,
                    `the ${name} button collapses at a hardcoded ${width} again`);
    });

    // Hiding the only text in a button leaves it with no accessible name at
    // all. Both controls in this row collapse, so both carry their name.
    it("keeps both collapsing controls named for a screen reader", () => {
        const start = read("common/components/StartTestButton/StartTestButton.jsx");
        const exportSource = read("common/components/ExportButton/ExportButton.jsx");

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
    it("is never pinned to the viewport", () => {
        assert.doesNotMatch(exportButton, /\.export-dropdown[^{]*\{[^}]*position:\s*fixed/,
            "the menu is fixed to the viewport rather than to its button again");
        assert.doesNotMatch(exportButton, /bottom:\s*1rem/,
            "the menu sits at the foot of the screen again");
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
    // That rule moved to the toolbar with the rest of the collapsed shape;
    // toolbarFit.test.js is where it is checked.

    /**
     * And the button it hangs off has to be somewhere the menu can hang from.
     *
     * The menu opens off the button's right edge, so a button at the *left* of
     * a row opens it leftwards off the screen - measured at 114px past the edge
     * on a 338px screen, where the picker hits its minimum and the export is
     * pushed onto a line of its own.
     *
     * Which stage the row is drawn at is decided by measuring it, so the anchor
     * is pinned with the rest of the stacked row in toolbarFit.test.js. What is
     * still this file's business is that no width here decides it: a 900px
     * figure could not see that a read-only visitor has one control fewer and
     * half a line of status, and dropped their bar 400px early.
     */
    it("has no viewport figure stacking the toolbar", () => {
        const toolbar = compile("common/components/PageToolbar/styles.sass");

        assert.equal(queriesMentioning(toolbar, "900px").length, 0,
            "the toolbar wraps at a hardcoded 900px again, whoever is looking at it");
    });
});
