import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource, walkSources, withoutJsComments } from "../helpers/source.js";
import { compile } from "../helpers/sass.mjs";

/**
 * The one control in MySpeed that the browser drew rather than the stylesheet.
 *
 * The Ookla licence was a bare `<input type="checkbox">` with `accent-color`
 * on it, which is the operating system's checkbox with a tint: a different
 * shape on Windows, macOS and Linux, no hover state, and nothing of the palette
 * beyond the one colour. It sat four rows under the provider cards, whose
 * selection control is drawn here in full.
 *
 * So the box is drawn too, and drawn as that control with corners - the same
 * size, border weight, accent fill and transition as .selectable-option-radio,
 * read off that stylesheet below so the two cannot drift. Square where the
 * radio is round is the distinction a reader already expects: one of these
 * against yes or no.
 */

const checkbox = readSource("client/src/common/components/Checkbox/Checkbox.jsx");
const css = compile("common/components/Checkbox/styles.sass");
const cards = compile("common/components/SelectableOption/styles.sass");

const ruleFor = (sheet, selector) => {
    const at = sheet.indexOf(`${selector} {`);

    assert.notEqual(at, -1, `${selector} has no rule`);
    return sheet.slice(at, sheet.indexOf("}", at));
};

const value = (rule, property) =>
    (new RegExp(`(?:^|[;{])\\s*${property}:\\s*([^;]+)`).exec(rule) ?? [])[1]?.trim();

describe("the checkbox", () => {
    /**
     * The real input is still there, only made transparent and laid over the
     * box it draws. A div pretending to be a checkbox takes the keyboard, the
     * label's `for`, the form and the screen reader with it.
     */
    it("is a real input underneath", () => {
        assert.match(checkbox, /type="checkbox"/, "there is no input left to check");
        assert.match(checkbox, /aria-label=\{label\}/,
            "a box with its text in a sibling span is announced as an unnamed checkbox");

        const rule = ruleFor(css, ".checkbox input");
        assert.equal(value(rule, "opacity"), "0",
            "the input has to stay in the layer that receives the click, not be display:none");
    });

    /**
     * The browser drew a focus ring on the native box and draws none on this
     * one. Every other control in the client has one; a licence checkbox that
     * cannot be seen from the keyboard is the worst place to lose it.
     */
    it("shows where the keyboard is", () => {
        assert.match(css, /:focus-visible/,
            "no focus style, so tabbing to it is invisible");
    });

    /**
     * Read off the provider card's radio rather than written here, so a change
     * to that control is a change to this one.
     */
    for (const property of ["width", "height"]) {
        it(`is the radio's ${property}`, () => {
            assert.equal(value(ruleFor(css, ".checkbox-box"), property),
                value(ruleFor(cards, ".selectable-option-radio"), property),
                `the checkbox and the radio above it disagree about ${property}`);
        });
    }

    it("is square where the radio is round", () => {
        const box = value(ruleFor(css, ".checkbox-box"), "border-radius");
        const radio = value(ruleFor(cards, ".selectable-option-radio"), "border-radius");

        assert.notEqual(box, radio, "a round checkbox reads as one of several options");
        assert.notEqual(box, undefined, "the box states no corner at all");
    });

    /**
     * A glyph would land on whatever the font has, and several of the locales
     * this ships in are rendered in fonts with no tick at all. A stroked path
     * is drawn by the browser and can be animated on.
     */
    it("draws its tick rather than typing it", () => {
        assert.match(checkbox, /<svg/, "the tick is not drawn");
        // Without the comments, which are where this file explains why it does
        // not use a ✓ - and would otherwise fail its own assertion.
        assert.doesNotMatch(withoutJsComments(checkbox), /[✓✔✅]/, "the tick is a character");
    });
});

describe("nothing paints its own checkbox any more", () => {
    it("leaves the operating system's box to the component", () => {
        const own = walkSources("client/src")
            .filter(({path}) => !path.includes("/Checkbox/") && !path.includes("/ToggleSwitch/"))
            .filter(({source}) => /type="checkbox"/.test(source))
            .map(({path}) => path);

        assert.deepEqual(own, [],
            "these draw a raw checkbox, which is the browser's rather than the palette's");
    });

    it("needs no accent-color anywhere", () => {
        const tinted = walkSources("client/src", /\.sass$/)
            .filter(({source}) => /accent-color/.test(source))
            .map(({path}) => path);

        assert.deepEqual(tinted, [],
            "accent-color only tints a box the browser is still drawing");
    });
});
