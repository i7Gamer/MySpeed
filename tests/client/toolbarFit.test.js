import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { controlsWrapped, nextStage, resumeStage } from "@/common/hooks/useFitStages.js";
import { TOOLBAR_CONTROLS, TOOLBAR_STAGES } from "@/common/components/PageToolbar/fit.js";
import { compile, mediaBlocks, read, rules } from "../helpers/sass.mjs";

const toolbarSource = read("common/components/PageToolbar/PageToolbar.jsx");
const hookSource = read("common/hooks/useFitStages.js");
const toolbar = compile("common/components/PageToolbar/styles.sass");
const exportButton = compile("common/components/ExportButton/styles.sass");

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
 * The stages, and the order the row gives itself up in.
 *
 * The bar stacks first, because it is the only step that costs no information:
 * the row keeps every control and every label, and the bar reads exactly as it
 * did. Only once that is spent do the words start going, and the export's goes
 * before the start button's - the start button is the page's primary action and
 * a bare gauge does not say "start a test".
 *
 * Cumulative, not exclusive: every stage after "wrap" also stacks the bar, so
 * the ladder only ever takes things away.
 */
describe("the order the row gives itself up in", () => {
    it("starts with everything drawn", () => {
        assert.equal(TOOLBAR_STAGES[0], "none");
    });

    it("drops the export's label before the start button's", () => {
        assert.deepEqual(TOOLBAR_STAGES, ["none", "wrap", "export", "all"]);
    });

    /**
     * And stacks the bar before either. Dropping it to a row of its own hands
     * the top line its whole width back, which is what lets both labels survive
     * widths that used to lose them - so a stage that gave up a word first
     * would be paying for room it was about to be given.
     */
    it("stacks the status bar before it gives up a label", () => {
        assert.ok(TOOLBAR_STAGES.indexOf("wrap") < TOOLBAR_STAGES.indexOf("export"),
            "a label goes before the bar is offered a row of its own");
    });

    it("walks the stages once and then stops", () => {
        assert.equal(nextStage(TOOLBAR_STAGES, "none"), "wrap");
        assert.equal(nextStage(TOOLBAR_STAGES, "wrap"), "export");
        assert.equal(nextStage(TOOLBAR_STAGES, "export"), "all");
        assert.equal(nextStage(TOOLBAR_STAGES, "all"), null,
            "the walk never terminates, so the measurement loops forever");
    });

    // A stage nothing declared must end the walk, not restart it: indexOf's -1
    // plus one is the first stage, which would walk forever from a typo.
    it("ends the walk on a stage it does not know", () => {
        assert.equal(nextStage(TOOLBAR_STAGES, "bogus"), null);
    });

    /**
     * Where a re-measure may pick up. A width that only shrank cannot make an
     * earlier - wider - stage fit, so the walk resumes from the stage the row
     * already wears instead of re-proving every stage above it; anything the
     * row wears that the stages do not name falls back to the widest.
     */
    it("resumes from the stage the row is at", () => {
        assert.equal(resumeStage(TOOLBAR_STAGES, "export"), "export");
        assert.equal(resumeStage(TOOLBAR_STAGES, "all"), "all");
    });

    it("resumes from the top when the row wears a stage nothing declared", () => {
        assert.equal(resumeStage(TOOLBAR_STAGES, "bogus"), "none");
        assert.equal(resumeStage(TOOLBAR_STAGES, undefined), "none");
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
 * The stylesheet cannot be asked whether a row fits, so the decision lives in
 * useFitStages - which means the guard against it silently reverting is a
 * check that every trigger that can change the answer re-runs the measurement.
 * There were four found missing, each shipped as a stale toolbar: the start
 * button mounting once /config resolves, a language swapping the labels after
 * the old listener had already measured, the Inter webfont arriving with wider
 * glyphs than the fallback's, and a fractional resize inside one clientWidth
 * integer.
 */
describe("the toolbar measures its own row", () => {
    it("delegates the measurement to the shared hook", () => {
        assert.match(toolbarSource, /useFitStages\(/,
            "the toolbar walks stages by hand again instead of through the hook");
    });

    it("observes the row rather than the window", () => {
        assert.match(hookSource, /ResizeObserver/,
            "nothing watches the row, so the stage is decided once and never revisited");
        assert.match(hookSource, /useLayoutEffect/,
            "the measurement runs after paint, so the wrapped row is drawn once before it collapses");
    });

    /**
     * The row's contents can change without its width changing - the start
     * button mounts when the config arrives, a test run swaps its label for
     * "Running" and back, a language prints longer words - and none of that
     * moves the width a ResizeObserver watches. The DOM itself is the one
     * thing that sees every such change.
     */
    it("re-measures when the row's contents change", () => {
        assert.match(hookSource, /MutationObserver/,
            "a control mounting after the config loads leaves the toolbar at the two-control stage");

        for (const watched of ["childList", "subtree", "characterData"])
            assert.match(hookSource, new RegExp(`${watched}:\\s*true`),
                `the mutation observer does not watch ${watched}, so that class of change is missed`);
    });

    // The first walk runs before the webfont arrives on a cold cache, against
    // fallback glyphs a few px narrower per label - enough to cross a stage
    // boundary and stay wrong, because the swap changes no width.
    it("re-measures once the fonts are in", () => {
        assert.match(hookSource, /fonts\?\.ready/,
            "a cold-cache visit keeps the stage the fallback font measured");
    });

    // The old listener measured the *outgoing* language: i18next emits
    // synchronously, React commits the new labels afterwards, so the walk read
    // a DOM that was about to be replaced. The mutation observer sees the
    // commit itself, which is the only moment worth measuring.
    it("has no ear on i18next any more", () => {
        for (const source of [toolbarSource, hookSource]) {
            assert.doesNotMatch(source, /from ["']i18next["']/,
                "i18next is imported again, which smells of the stale-DOM listener");
            assert.doesNotMatch(source, /i18n\.on\(|languageChanged"/,
                "measuring during the language event reads the labels React is about to replace");
        }
    });

    // clientWidth is an integer; flex wrapping is not. A fractional resize
    // inside one integer bucket flipped the wrap with the guard asleep.
    it("guards the re-measure on a fractional width", () => {
        assert.match(hookSource, /getBoundingClientRect\(\)\.width !== lastWidth/,
            "the width guard is gone, so every height change re-walks and can loop");
        assert.doesNotMatch(hookSource, /row\.clientWidth/,
            "the guard reads a rounded value and sleeps through sub-pixel wraps");
    });

    // Reading a rect straight after writing the attribute is what makes the
    // walk work at all - each stage has to be laid out before it can be
    // measured - so the write and the read belong in the same pass.
    it("applies a stage before measuring it", () => {
        assert.match(hookSource, /dataset\.compact/,
            "the stage never reaches the DOM, so the CSS below has nothing to key on");
    });

    /**
     * A transition answers a property change with its start value at t=0, so a
     * stage measured mid-walk would wear the previous stage's box. The walk
     * brackets itself with data-measuring, the stylesheet turns transitions off
     * under it, and the attribute is gone before the frame paints.
     */
    it("suppresses transitions while it measures", () => {
        assert.match(hookSource, /dataset\.measuring/,
            "stages are measured while their properties are still easing from the last stage");
        assert.match(hookSource, /delete row\.dataset\.measuring/,
            "the suppression outlives the walk, which kills every animation in the row");
    });

    it("stops observing when it unmounts", () => {
        const disconnects = hookSource.match(/\.disconnect\(\)/g) ?? [];

        assert.ok(disconnects.length >= 2,
            "one of the two observers outlives the toolbar");
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
     *
     * The anchor is load-bearing: without `left: auto; right: 0` the base
     * rule's left/right pair pins a 160px menu to the left edge of a ~45px
     * container at the right-hand end of the row, which runs it off-screen.
     */
    it("still gives the export menu a width once its button has none", () => {
        const menu = at("export", ".export-dropdown");

        assert.ok(menu.some(({body}) => /min-width:/.test(body)),
            "the menu takes the collapsed button's width, which is one icon wide");
        assert.ok(!menu.some(({body}) => /position:\s*fixed/.test(body)),
            "the menu is pinned to the viewport again");
    });

    it("hangs the menu off the collapsed button's right edge", () => {
        const menu = at("export", ".export-dropdown");

        assert.ok(menu.some(({body}) => /left:\s*auto/.test(body)),
            "the base rule's left: 0 still applies, which stretches the menu from the button's left");
        assert.ok(menu.some(({body}) => /right:\s*0/.test(body)),
            "nothing holds the menu to the button's right edge, so it hangs off-screen");
    });

    /**
     * The walk's guard rule. Every stage is written and measured inside one
     * frame; a transition would hand the measurement the previous stage's
     * geometry, so under data-measuring there are none.
     */
    it("turns transitions off under the measuring flag", () => {
        const suppressing = rules(toolbar).filter(({selector, body}) =>
            selector.includes("[data-measuring]") && /transition:\s*none/.test(body));

        assert.ok(suppressing.length > 0,
            "nothing suppresses transitions mid-walk, so a stage is measured wearing the last one's box");
        assert.ok(suppressing.some(({body}) => /!important/.test(body)),
            "a component's own transition rule outranks the suppression and eases anyway");
    });

    // The export button eased *everything*, padding included, which is what
    // let a mid-walk measurement read the old box in the first place. Its
    // states only ever change the border colour, so that is all it eases now.
    it("no longer eases the export button's geometry", () => {
        const button = rules(exportButton).find(({selector}) => selector === ".export-button");

        assert.ok(button, "the export button's base rule is gone");
        assert.doesNotMatch(button.body, /transition:\s*all/,
            "the button still eases every property, geometry included");
    });
});

/**
 * And where the bar takes a row of its own, which used to be a viewport figure
 * of its own.
 *
 * It was `max-width: 900px`, measured against a full-access instance with a
 * preset selected. A read-only visitor gets no start button at all and no next
 * test to name - /status withholds the schedule from them - so their bar is one
 * short line beside two controls, and it was being dropped to its own row some
 * 400px before the row had actually run out. The same figure was wrong the
 * other way for a custom range, which prints two dates in a 300px trigger: at
 * 950px the bar was squeezed rather than stacked.
 *
 * Which is the question fit.js already answers by measuring, so the wrap is a
 * stage of that walk now rather than a fourth number written down.
 */
describe("where the status bar takes a row of its own", () => {
    const at = (stage, part) => rules(toolbar).filter(({selector}) =>
        selector.includes(`[data-compact=${stage}]`) && selector.includes(part));

    const base = rules(toolbar).find(({selector}) => selector === ".page-toolbar");

    /**
     * The measurement reads the controls' top edges, so the row has to be
     * allowed to break for there to be anything to read. Without this the
     * controls only ever shrink, the walk never sees a second line, and every
     * stage below "none" is unreachable.
     */
    it("lets the row wrap at all, at every width", () => {
        assert.ok(base, "the toolbar has no base rule");
        assert.match(base.body, /flex-wrap:\s*wrap/,
            "the row cannot break, so the walk has no second line to detect and never leaves stage none");
    });

    /**
     * What the bar is asking for when it asks for a row: its own line of text,
     * unwrapped. Stated as its content rather than as a width, because the
     * content is what changes - a read-only visitor's bar is half the length of
     * an operator's, a running one says something different again, and every
     * translation is its own length.
     */
    it("holds the bar to its own content while it shares the row", () => {
        const bar = rules(toolbar).find(({selector}) => selector === ".page-toolbar > .status-bar");

        assert.ok(bar, "the toolbar no longer sizes the status bar");
        assert.match(bar.body, /min-width:\s*max-content/,
            "the bar shrinks to nothing beside the other controls instead of asking for a row");
    });

    it("stacks it from the wrap stage on", () => {
        for (const stage of ["wrap", "export", "all"]) {
            const stacked = at(stage, ".status-bar");

            assert.ok(stacked.some(({body}) => /flex:\s*1 1 100%/.test(body)),
                `the bar shares the line at the ${stage} stage, so the row is a control too wide`);
            assert.ok(stacked.some(({body}) => /min-width:\s*0/.test(body)),
                `the bar still demands its content's width at the ${stage} stage, where it has a whole row`);
        }
    });

    // Below the three that bound it, not above them: the controls are what the
    // row is for, and a bar between them and the page reads as content.
    it("sends it below the controls rather than above them", () => {
        assert.ok(at("wrap", ".status-bar").some(({body}) => /order:\s*1/.test(body)),
            "the stacked bar keeps its place in the source order, which puts it above the controls");
    });

    /**
     * The export's menu hangs off its button's right edge, so a button at the
     * left of a row opens it leftwards off the screen - measured at 114px past
     * the edge on a 338px screen, where the picker hits its minimum and the
     * export is pushed onto a line of its own.
     */
    it("keeps the export at the right-hand end of whatever line it lands on", () => {
        assert.ok(at("wrap", ".export-button-container").some(({body}) => /margin-left:\s*auto/.test(body)),
            "a wrapped export sits at the left of its row, which opens its menu off-screen");
    });

    // The picker is the only control on the top line that can give any width
    // back, and at flex: 0 0 auto it gives none - a custom range's two dates
    // then push the export off the line on a phone.
    it("lets the picker shrink once the row has broken", () => {
        assert.ok(at("wrap", ".date-range-picker").some(({body}) => /min-width:\s*0/.test(body)),
            "the picker holds its full width on a stacked row, which pushes the export off it");
    });

    it("has no viewport figure deciding the wrap any more", () => {
        assert.equal(mediaBlocks(toolbar).length, 0,
            "the toolbar reflows on a width again, which cannot see who is looking at it");
    });
});
