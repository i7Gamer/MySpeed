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

    /**
     * And the trim step is where a row runs out, not where the card once did.
     *
     * It was 25rem, converted from a 1400px viewport figure - the width the card
     * used to reach rather than the width its rows need. With the page capped at
     * 1400 the list only ever got to 409px, nine past that threshold, so the
     * descriptions appeared in a nine-pixel window and wrapped to a second line
     * in all of it. Widened, the band above it is real, and measured across it a
     * description needs 473px of list to sit beside its figure - below which the
     * row broke and put the value under the label instead.
     */
    it("trims where the row stops holding its description beside its figure", () => {
        const trim = Math.max(...containerBlocks(compiled)
            .map(({condition}) => parseFloat(condition.match(/width\s*<\s*([\d.]+)rem/)?.[1]))
            .filter(Number.isFinite));

        // 473px of list, in the 16px rem the card is measured in.
        assert.ok(trim >= 473 / 16,
            `the card keeps its descriptions down to ${trim}rem, where the row breaks under them`);
    });

    /**
     * And the two steps give up different things.
     *
     * They used to go together: the trim step hid the icon along with the
     * description and pinned the label to a fixed 15rem. The icon costs 52px
     * and every panel on the page carries one, so a summary without it beside a
     * stability card with them reads as a different kind of card rather than a
     * tighter one - and the pin reserved 240px whether the label wanted it or
     * not, which is more than a ~300px row has once its figure is placed.
     * Measured, four of five rows put their value under the label at 380px.
     */
    it("gives up the description a step before the icon", () => {
        const steps = containerBlocks(compiled)
            .map(({condition, body}) => ({
                at: parseFloat(condition.match(/width\s*<\s*([\d.]+)rem/)?.[1]),
                body
            }))
            .filter(({at}) => Number.isFinite(at))
            .sort((a, b) => b.at - a.at);

        assert.equal(steps.length, 2, "the card no longer has two steps to order");

        const hides = (step, part) => new RegExp(`\\.panel-row-${part}\\s*\\{[^}]*display:\\s*none`)
            .test(step.body);

        assert.ok(hides(steps[0], "description"), "the wider step no longer drops the descriptions");
        assert.ok(!hides(steps[0], "icon"),
            "the icon goes with the descriptions again, which is 52px given up for nothing");
        assert.ok(hides(steps[1], "icon"), "nothing ever drops the icon, so the tightest label has no room");
    });

    // The pin the label used to wear between the two steps, and the rules that
    // existed only to undo it. The shared row already cuts a label that will
    // not fit; the pin only ever made the row wider than it had to be.
    it("leaves the label unpinned between them", () => {
        assert.doesNotMatch(compiled, /\.panel-row-title\s*\{[^}]*width:\s*15rem/,
            "the label is pinned to a fixed width again, which pushes its figure onto a second line");
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
