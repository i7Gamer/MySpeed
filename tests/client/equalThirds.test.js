import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compile, mediaBlocks, read } from "../helpers/sass.mjs";

/**
 * The stage where the page stops being one wide column and two narrow ones.
 *
 * The left column is 40% because of the summary: its labels and descriptions are
 * the page's only sentences, and a row of them needs 473px of list to sit beside
 * its figure. Below the width where that stops fitting the card gives the
 * sentences up - and from there it holds 100px it has nothing to put in.
 *
 * That was not only waste. Every panel steps its figure down on its own list
 * width, which is the only rule that can hold at all three stages, since the
 * cards' shares of the row change between them. So a card 100px wider than its
 * line-mates steps later than they do: measured at 1263px, the summary stated a
 * 28px figure beside two cards stating 19.2 on exactly the room the rule says
 * they should have. Equal thirds there leaves that nothing to stand on, and buys
 * the two tight cards 36px of list each - enough to hold every figure at full
 * size down to the two-column stage.
 */
describe("the stage that squares the top row", () => {
    const page = compile("pages/Statistics/styles.sass");
    const layout = read("common/styles/layout.sass");
    const overview = read("pages/Statistics/charts/OverviewChart/styles.sass");

    const constant = (source, name) =>
        Number(source.match(new RegExp(`\\$${name}:\\s*([\\d.]+)(px|rem)`))?.[1]);
    const inPx = (source, name) => {
        const match = source.match(new RegExp(`\\$${name}:\\s*([\\d.]+)(px|rem)`));
        assert.ok(match, `$${name} is not declared`);

        return match[2] === "rem" ? Number(match[1]) * 16 : Number(match[1]);
    };

    const stage = constant(layout, "stats-equal-thirds");
    const twoColumn = constant(layout, "stats-two-column");

    const blocks = mediaBlocks(page)
        .map(({condition, body}) => ({at: Number(condition.match(/max-width:\s*(\d+)px/)?.[1]), body}))
        .filter(({at}) => Number.isFinite(at));

    const equal = blocks.find(({at}) => at === stage);

    it("has a stage of its own, above the two-column one", () => {
        assert.ok(Number.isFinite(stage), "$stats-equal-thirds is not declared in the layout partial");
        assert.notEqual(equal, undefined, `nothing reflows at ${stage}px, so the top row never squares up`);
        assert.ok(stage > twoColumn,
            `the stage sits at ${stage}px, at or below the ${twoColumn}px where the summary spans its row anyway`);
    });

    /**
     * Stated before the stages below it. They restate the same selectors at
     * equal specificity, so only source order settles which share holds - and
     * this is the widest of the three, so it has to lose to both.
     */
    it("gives way to the narrower stages", () => {
        const order = blocks.map(({at}) => at);

        assert.deepEqual(order, [...order].sort((a, b) => b - a),
            `the stages are stated in the order ${order.join(", ")}, so a wider one overrides a narrower`);
    });

    /**
     * Every card, not only the three that show the fault.
     *
     * The left column runs the whole page - the summary over the latency chart
     * over the hourly one - so a stage that narrowed the top card alone would put
     * a kink in a column three rows deep, which is the same reason those two
     * charts take the 40% in the first place.
     */
    it("squares every column, not just the row that shows it", () => {
        for (const card of [".container-large", ".ping-chart", ".hourly-chart",
            ".stats-container", ".chart-container", ".skeleton-chart"])
            assert.match(equal.body, new RegExp(`\\${card}(?![-\\w])`),
                `${card} keeps the share it had, so its column changes width partway down the page`);

        // Three cards and two gaps make the row, so the gaps come off each share
        // rather than off one of them. Left on one card, the bases sum past 100%
        // and the third card drops to a line of its own.
        assert.match(equal.body, /flex:\s*1 1 calc\(33\.3+%\s*-\s*[\d.]+rem\s*\*\s*2\s*\/\s*3\)/,
            "the shares do not divide the row's gaps between them");
    });

    /**
     * And the width is where the sentences go, so the card gives up the room in
     * the same movement as the thing the room was for, rather than twice at two
     * widths. Anything else is a second reflow at a width of its own.
     *
     * A list is 40% of the content box less the row's two gaps, its own border
     * and its padding. Re-derive this if any of those move - it is the one figure
     * here that is not read from a variable.
     */
    it("squares up exactly where the summary gives up its sentences", () => {
        const PAGE_MARGINS = 32;
        const CARD_CHROME = 50;
        const gaps = inPx(layout, "card-gap") * 2;

        const list = 0.4 * (stage - PAGE_MARGINS) - gaps - CARD_CHROME;
        const trim = inPx(overview, "overview-trim");

        assert.ok(Math.abs(list - trim) <= 2,
            `at ${stage}px the summary holds ${list}px of list against the ${trim}px its descriptions need, `
            + "so the card changes width at one applied and loses its sentences at another");
    });
});
