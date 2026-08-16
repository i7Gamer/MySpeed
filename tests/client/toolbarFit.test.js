import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    controlsWrapped, nextStage, TOOLBAR_CONTROLS, TOOLBAR_STAGES
} from "@/common/components/PageToolbar/fit.js";
import { compile, read, rules } from "../helpers/sass.mjs";

const toolbarSource = read("common/components/PageToolbar/PageToolbar.jsx");
const toolbar = compile("common/components/PageToolbar/styles.sass");

/**
 * The toolbar gave up its labels at two fixed viewport widths, and those were
 * measured with a preset selected - a 126px "All time" trigger. A custom range
 * prints its two dates and is 300px, so the row broke onto separate lines at
 * 660px while both labels were still drawn and stayed that way until 480.
 *
 * Measured in a headless browser across the range, with a custom range
 * selected: the three controls hold one line down to 440px once both labels are
 * given up, against 660px with them on. The collapse is worth 220px of widths,
 * and no viewport figure can find it, because the width that matters is the
 * range's - which changes with the selection and with the language.
 */
describe("which controls have room for their labels", () => {
    it("counts the lines the controls are spread over", () => {
        assert.equal(controlsWrapped([120, 120, 120]), false, "one line read as several");
        assert.equal(controlsWrapped([120, 120, 176]), true, "the export dropped to its own line unnoticed");
    });

    /**
     * A read-only visitor gets no start button at all - the component renders
     * nothing rather than offering a control that would only answer 401 - and
     * the old stylesheet needed an adjacent-sibling rule to keep the export's
     * label in that case. Here it is simply one fewer control to fit.
     */
    it("ignores a control that is not on screen", () => {
        assert.equal(controlsWrapped([120, null, 120]), false,
            "the missing start button is counted as a line of its own");
        assert.equal(controlsWrapped([120, null, 176]), true,
            "two controls on two lines still fit, apparently");
    });

    it("treats a single control as fitting", () => {
        assert.equal(controlsWrapped([120, null, null]), false);
        assert.equal(controlsWrapped([null, null, null]), false, "an empty toolbar wants collapsing");
    });

    // Sub-pixel tops are the normal case for a flex row: the controls are
    // different heights and the row centres them. Rounding is the caller's job,
    // and this is the reminder that it is.
    it("compares the tops it is given, exactly", () => {
        assert.equal(controlsWrapped([120.4, 120.4]), false);
        assert.equal(controlsWrapped([120, 120.4]), true);
    });
});

/**
 * The stages, and the order they are given up in.
 *
 * The export goes first: the start button is the page's primary action and a
 * bare gauge does not say "start a test", so it keeps its word for as long as
 * there is room. That is the order the two media queries had, and the only part
 * of them worth keeping.
 */
describe("the order the labels are given up in", () => {
    it("starts with everything drawn", () => {
        assert.equal(TOOLBAR_STAGES[0], "none");
    });

    it("drops the export's label before the start button's", () => {
        assert.deepEqual(TOOLBAR_STAGES, ["none", "export", "all"]);
    });

    it("walks the stages once and then stops", () => {
        assert.equal(nextStage("none"), "export");
        assert.equal(nextStage("export"), "all");
        assert.equal(nextStage("all"), null, "the walk never terminates, so the measurement loops forever");
    });

    it("names controls the toolbar actually draws", () => {
        for (const selector of TOOLBAR_CONTROLS)
            assert.ok(toolbar.includes(selector) || toolbarSource.includes(selector.slice(1)),
                `${selector} is measured but never drawn`);
    });
});

/**
 * And the component measures rather than asking the viewport.
 *
 * The stylesheet cannot be asked whether a row fits, so the decision moved into
 * the component - which means the guard against it silently reverting is a
 * check that the observer is wired and that the old media queries are gone.
 */
describe("the toolbar measures its own row", () => {
    it("observes the row rather than the window", () => {
        assert.match(toolbarSource, /ResizeObserver/,
            "nothing watches the row, so the stage is decided once and never revisited");
        assert.match(toolbarSource, /useLayoutEffect/,
            "the measurement runs after paint, so the wrapped row is drawn once before it collapses");
    });

    /**
     * A range change and a language change both alter the trigger's width
     * without altering the row's, so a ResizeObserver never fires for either.
     * The first is a prop; the second is an i18next event.
     */
    it("re-measures when the label changes but the row does not", () => {
        assert.match(toolbarSource, /languageChanged/,
            "switching language leaves the toolbar at the previous language's stage");
        assert.match(toolbarSource, /\[from,\s*to,\s*timeframe]/,
            "selecting a custom range leaves the toolbar sized for the preset it replaced");
    });

    // Reading a rect straight after writing the attribute is what makes the
    // walk work at all - each stage has to be laid out before it can be
    // measured - so the write and the read belong in the same pass.
    it("applies a stage before measuring it", () => {
        assert.match(toolbarSource, /dataset\.compact/,
            "the stage never reaches the DOM, so the CSS below has nothing to key on");
    });

    it("stops observing when it unmounts", () => {
        assert.match(toolbarSource, /disconnect\(\)/, "the observer outlives the toolbar");
    });
});

/**
 * The stylesheet keys off the stage the measurement chose, and the viewport
 * figures it replaces are gone.
 *
 * They have to go rather than merely be overridden: two rules that both match
 * are settled by source order, and a leftover `max-width: 480px` block would
 * quietly win back the label on the widths it covers.
 */
describe("the collapse the stylesheet draws", () => {
    // Read as rules rather than matched against the raw text: sass groups the
    // two stages into one comma-separated selector, so a regex looking for
    // `.export-text {` finds `.export-text,` and reports the rule missing.
    // The shared parser also strips quotes - the attribute is written
    // `[data-compact="all"]` in the stylesheet and sass emits it as
    // `[data-compact=all]`, so matching the source spelling finds nothing.

    /** Every rule that applies at a stage and mentions a given part. */
    const at = (stage, part) => rules(toolbar).filter(({selector}) =>
        selector.includes(`[data-compact=${stage}]`) && selector.includes(part));

    const hidden = (stage, part) => at(stage, part).some(({body}) => /display:\s*none/.test(body));

    it("hides the export's label from the export stage on", () => {
        assert.ok(hidden("export", ".export-text"), "nothing hides the export label any more");
        assert.ok(hidden("all", ".export-text"), "the label comes back at the narrowest stage");
        assert.ok(hidden("export", ".chevron-icon"), "the icon-only button keeps its chevron");
    });

    it("keeps the start button's word until the last stage", () => {
        assert.ok(hidden("all", ".start-test span"), "the start button never gives up its label");
        assert.ok(!hidden("export", ".start-test span"),
            "the start button loses its word at the same time as the export, a stage too early");
    });

    it("squares off each control as its label goes", () => {
        assert.ok(at("export", ".export-button").some(({body}) => /aspect-ratio/.test(body)));
        assert.ok(at("all", ".start-test").some(({body}) => /aspect-ratio/.test(body)));
    });

    // That no viewport figure decides a label any more is asserted once, in
    // narrowHeaderAndToolbar.test.js, which checks a superset of the widths -
    // a second copy here had already drifted to a shorter list.

    /**
     * The menu still has to hang off a button that is one icon wide, which is
     * the one part of the old narrow block that was about the collapse rather
     * than about the viewport.
     */
    it("still gives the export menu a width once its button has none", () => {
        const menu = at("export", ".export-dropdown");

        assert.ok(menu.some(({body}) => /min-width:/.test(body)),
            "the menu takes the collapsed button's width, which is one icon wide");
        assert.ok(!menu.some(({body}) => /position:\s*fixed/.test(body)),
            "the menu is pinned to the viewport again");
    });
});
