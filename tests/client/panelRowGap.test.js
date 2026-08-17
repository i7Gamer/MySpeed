import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compile, read, rules } from "../helpers/sass.mjs";

/**
 * The space between two panel rows, wherever a card stacks them.
 *
 * It was two figures and two distributions: 1.75rem with the rows centred on the
 * latest-test and value cards, 0.5rem with them spread by space-between on the
 * summary and the stability card. Spread, the gap is only a floor - the rows
 * take whatever height the card has left over - and with four cards stretched to
 * one height and four different amounts of content that cannot come out equal:
 * the card with the least in it gets the widest gaps.
 *
 * Measured across the three-column band it was 26px against 28 at full width,
 * and 8px against 29 around 1250px, where the summary's own title wraps to a
 * second line and takes 24px off the list below it - so its rows fell back on
 * their floor while the cards beside it spread to four times it.
 */
const PANELS = [
    [".overview-items", "pages/Statistics/charts/OverviewChart/styles.sass"],
    [".info-container", "pages/Statistics/charts/LatestTestChart/styles.sass"],
    [".consistency-container", "pages/Statistics/charts/ConsistencyChart/styles.sass"],
    [".value-container", "pages/Statistics/charts/AverageChart/styles.sass"]
];

const containerOf = (selector, stylesheet) => {
    const rule = rules(compile(stylesheet)).find((one) => one.selector === selector);
    assert.ok(rule, `${selector} has no rule of its own any more`);

    return rule.body;
};

describe("the gap between panel rows", () => {
    const gaps = PANELS.map(([selector, stylesheet]) => {
        const stated = containerOf(selector, stylesheet).match(/gap:\s*([\d.]+rem)/);
        assert.ok(stated, `${selector} states no gap, so it takes whatever the browser gives it`);

        return [selector, stated[1]];
    });

    it("is the same on every panel that stacks them", () => {
        const distinct = new Set(gaps.map(([, gap]) => gap));

        assert.equal(distinct.size, 1,
            "the panels space their rows differently: " + gaps.map(([s, g]) => `${s} ${g}`).join(", "));
    });

    // One value in four stylesheets is four values that happen to agree today.
    it("is written down once and read from there", () => {
        assert.match(read("pages/Statistics/components/PanelRow/_variables.sass"),
            /\$panel-row-gap:\s*[\d.]+rem/,
            "the shared partial declares no row gap, so each card carries its own copy");

        for (const [selector, stylesheet] of PANELS)
            assert.match(containerOf(selector, stylesheet).replace(/gap:\s*[\d.]+rem/, "GAP"), /GAP/,
                `${selector} does not take the shared gap`);

        for (const [, stylesheet] of PANELS)
            assert.match(read(stylesheet), /PanelRow\/variables/,
                `${stylesheet} states a gap of its own rather than reading the shared one`);
    });

    /**
     * And no panel spreads its rows instead. This is the part that cannot be
     * settled by agreeing on a number: space-between hands the rows whatever
     * height is left, so two cards with the same gap and different content still
     * draw different ones.
     */
    it("holds the rows to that gap rather than spreading them", () => {
        for (const [selector, stylesheet] of PANELS)
            assert.doesNotMatch(containerOf(selector, stylesheet), /justify-content:\s*space-between/,
                `${selector} spreads its rows, so its gap is a floor and not a gap`);
    });

    /**
     * The summary is the one panel whose rows grow: its descriptions are
     * sentences, and between about 1150 and 1350px they wrap to a second line
     * and want more height than the card has. Allowed to shrink there, it went
     * back to drawing its rows at the floor - with overflow-y clipping the
     * evidence rather than the layout admitting it had run out.
     */
    it("lets a panel whose rows have grown keep them apart", () => {
        assert.match(containerOf(".overview-items", "pages/Statistics/charts/OverviewChart/styles.sass"),
            /flex:\s*1 0 auto/,
            "the summary shrinks below its rows again, which puts them back at the gap's old floor");
    });
});
