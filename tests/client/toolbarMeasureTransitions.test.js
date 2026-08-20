import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compile, read, rules } from "../helpers/sass.mjs";

const toolbar = compile("common/components/PageToolbar/styles.sass");
const bar = compile("common/components/StatusBar/styles.sass");
const barSource = read("common/components/StatusBar/StatusBarComponent.jsx");

// The opt-out the walk honours. Named for the reason rather than for the one
// element that needs it: anything the row does not lay out is a candidate.
const EXEMPT = "data-fit-exempt";
const ATTRIBUTE = String.raw`\[${EXEMPT}]`;

const suspension = rules(toolbar)
    .filter(({selector}) => selector.includes("[data-measuring]"))
    .find(({body}) => /transition:\s*none/.test(body));

const blockOf = (selector, css) => rules(css).find((rule) => rule.selector === selector)?.body ?? null;

/**
 * The status bar's progress fill against the toolbar's measuring walk.
 *
 * useFitStages measures each stage by writing data-compact and reading a rect
 * straight back, and the stylesheet suspends transitions under the row while it
 * does - a stage measured mid-ease would wear the previous stage's box.
 *
 * The bar moved into that row (7dac083d), and the two together cancelled the
 * progress fill's glide. The walk's trigger is a MutationObserver over the
 * whole subtree, and every status poll commits new text into it: the live
 * speed, the phase, the relative age of the last test. So once a second, in the
 * microtask right after React committed the new width, the row wore
 * data-measuring and forced a style recalc - and a recalc that reads
 * `transition: none` never creates the transition at all. Measured in a real
 * engine against this exact structure: with the observer attached the fill
 * carries no CSSTransition and stands at its full target one frame later; with
 * it detached it carries a width transition and has moved a fortieth of the
 * way. The bar hard-stepped once a second for the length of every run.
 *
 * The fix is not to stop suspending transitions, which the walk needs, nor to
 * stop observing, which is how the row notices a phase label changing width.
 * It is that the walk has no business suspending a transition it cannot
 * measure: the track is position: absolute inside the bar, so the fill's width
 * is outside the row's layout entirely and no stage's fit depends on it.
 */
describe("what the measuring walk is allowed to cancel", () => {

    it("still suspends transitions while it measures", () => {
        assert.notEqual(suspension, null, "the walk no longer suspends transitions at all");
        assert.match(suspension.body, /transition:\s*none\s*!important/,
            "the suspension must outrank every control's own transition rule");
    });

    // The reach is the point of the rule and the cause of the bug in equal
    // measure: a control's transition may live on any descendant.
    it("still reaches every control in the row", () => {
        assert.match(suspension.selector, /\[data-measuring]\s*\*/,
            "the suspension no longer reaches the controls' descendants");
    });

    it("lets an element outside the row's layout keep its transition", () => {
        assert.match(suspension.selector, new RegExp(String.raw`\*:not\([^)]*` + ATTRIBUTE),
            `the universal half of the suspension does not exempt [${EXEMPT}]`);
    });

    it("does not cancel a transition on the exempt element's own descendants", () => {
        assert.match(suspension.selector, new RegExp(ATTRIBUTE + String.raw`\s+\*`),
            "a child of an exempt element is still swept by the universal half");
    });

    // Marked on the track rather than on the fill inside it: the track is the
    // element that is out of the flow, and both fills - determinate and
    // indeterminate - are covered by the descendant half above.
    it("marks the progress track as the toolbar's to leave alone", () => {
        const track = barSource.match(/<div className="status-progress"[^>]*>/);

        assert.notEqual(track, null, "the progress track is no longer rendered as its own element");
        assert.match(track[0], new RegExp(EXEMPT),
            `the track does not carry ${EXEMPT}, so the walk cancels the fill's glide once a second`);
    });

    // What makes the exemption safe rather than merely convenient. If the track
    // is ever put back into the flow this fails, and it should: the fill would
    // then be something a stage's fit could depend on.
    it("is exempt only because the track is out of the row's flow", () => {
        assert.match(blockOf(".status-progress", bar), /position:\s*absolute/);
        assert.match(blockOf(".status-progress-fill", bar), /transition:\s*width/,
            "the fill has no transition left to protect");
    });
});
