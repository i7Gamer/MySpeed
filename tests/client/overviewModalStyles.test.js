import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compile, containerBlocks, mediaBlocks, rules } from "../helpers/sass.mjs";

const compiled = compile("pages/Statistics/charts/OverviewChart/styles.sass");

/**
 * The narrow-card rules exist because the *card* loses room as the page grid
 * tightens: they drop the icons and descriptions and clamp the label to a
 * fixed ellipsized width. The modal renders the same markup with the whole
 * viewport to spend, and while the trims keyed on the viewport every one of
 * them needed a :not(.chart-modal-body *) guard so the enlarged view kept the
 * detail it exists to show.
 *
 * The trims key on the width of .overview-items itself now - the list is a
 * container - so the modal's copy is exempt by geometry rather than by guard:
 * a wide list simply matches no trim. The same geometry fixed the spanning
 * summary, which from 1030px down takes its whole row and was still being
 * dressed in the form tuned for a ~330px card. What this file pins is that
 * nothing viewport-keyed or modal-guarded creeps back.
 */
describe("the overview chart stylesheet", () => {
    it("hides and clamps only under a container query", () => {
        for (const {body} of mediaBlocks(compiled))
            assert.doesNotMatch(body, /display:\s*none|text-overflow:\s*ellipsis/,
                "a viewport figure trims the card again, which strips wide cards and the modal too");

        const trimming = containerBlocks(compiled)
            .filter(({body}) => /display:\s*none/.test(body));

        assert.ok(trimming.length > 0, "no container query trims the card at all any more");
    });

    it("establishes the list the trims measure", () => {
        const items = rules(compiled).find(({selector}) => selector === ".overview-items");

        assert.ok(items, "the list has no base rule");
        assert.match(items.body, /container-type:\s*inline-size/,
            "nothing establishes the container, so no trim ever matches and tight cards overflow");
    });

    it("still trims the card itself when the list is tight", () => {
        assert.match(compiled,
            /\.overview-items \.panel-row \.panel-row-icon\s*\{[^}]*display:\s*none/);
        assert.match(compiled,
            /\.overview-items \.panel-row \.panel-row-description\s*\{[^}]*display:\s*none/);
    });

    // Two steps, the wrap inside the trim: a label that wraps while its icon
    // and description still show is a step order gone backwards.
    it("keys the wrap step inside the trim step", () => {
        const steps = containerBlocks(compiled)
            .map(({condition}) => parseFloat(condition.match(/width\s*<\s*([\d.]+)rem/)?.[1]))
            .filter(Number.isFinite);

        assert.equal(steps.length, 2, "the trim and wrap steps are not both container-keyed");
        assert.ok(steps[0] > steps[1],
            "the wrap step is not inside the trim step, so a label wraps while its icon still shows");
    });

    it("needs no modal guard once geometry decides", () => {
        assert.doesNotMatch(compiled, /chart-modal-body/,
            "the guard is back, which means something other than the card's own width decides");
    });

    /**
     * The trimming is this card's alone.
     *
     * The row it draws is shared with three other panels now, and theirs name a
     * single measurement in a word where these carry a sentence - so a rule
     * written against the bare row would strip the stability card of the
     * sub-lines it is read for.
     */
    it("scopes every row rule to this card rather than to the shared row", () => {
        for (const {selector} of rules(compiled).filter(({selector}) => selector.includes(".panel-row")))
            assert.ok(selector.includes(".overview-items"),
                `"${selector}" dresses the shared row on every panel that uses it`);
    });

    /**
     * And it takes the sizes from the shared row without taking its rules: the
     * variables live in a partial that emits nothing, so a card reaching for the
     * value's size does not copy the whole layout into its own sheet.
     */
    it("copies none of the shared row's own declarations", () => {
        const own = rules(compiled).filter(({selector}) => /^\.panel-row/.test(selector));

        assert.deepEqual(own.map(({selector}) => selector), [],
            "the shared row's rules are compiled into this card's stylesheet as well");
    });
});
