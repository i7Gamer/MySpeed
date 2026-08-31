import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { atBound, stepValue } from "@/common/components/NumberField/stepValue.js";
import { readSource, withoutJsComments } from "../helpers/source.js";
import { compile, rules } from "../helpers/sass.mjs";

/**
 * The stepper that replaces the browser's spin buttons.
 *
 * The maths is its own module because it is the whole of the behaviour and none
 * of it needs a DOM: what a press does at a bound, what it does to a field that
 * is empty, and what it does to a fractional step - which is the one that bites,
 * because 0.1 + 0.2 is 0.30000000000000004 and a field showing that is worse
 * than the widget this replaces.
 *
 * Strings in and strings out, deliberately. The native input hands its callers
 * `e.target.value`, every call site here is written against that, and a stepper
 * that answered numbers would have made "" and 0 the same value.
 */

describe("stepValue", () => {
    const hours = {min: 0.1, max: undefined, step: 0.5};

    it("steps up and down by the step", () => {
        assert.equal(stepValue("2", 1, {step: 1}), "3");
        assert.equal(stepValue("2", -1, {step: 1}), "1");
    });

    it("keeps a fractional step exact", () => {
        // 0.1 + 0.2 is 0.30000000000000004, and 1.1 - 0.2 is 0.9000000000000001.
        // Both would be shown to the reader verbatim.
        assert.equal(stepValue("0.1", 1, {step: 0.2}), "0.3");
        assert.equal(stepValue("1.1", -1, {step: 0.2}), "0.9");
        assert.equal(stepValue("0.1", 1, hours), "0.6");
    });

    it("rounds to whichever of the value and the step is finer", () => {
        // A typed 2.25 with a step of 0.5: the step's one decimal must not be
        // used to round the value's two away.
        assert.equal(stepValue("2.25", 1, {step: 0.5}), "2.75");
        assert.equal(stepValue("2.25", -1, {step: 0.5}), "1.75");
    });

    it("clamps at both bounds rather than passing them", () => {
        assert.equal(stepValue("9.8", 1, {min: 0, max: 10, step: 0.5}), "10");
        assert.equal(stepValue("0.3", -1, {min: 0, max: 10, step: 0.5}), "0");
    });

    it("starts an empty field at its floor", () => {
        // Either direction: there is no value to move, so the press means "give
        // me the first legal one" rather than "add a step to nothing" - which
        // is NaN, and which the native input renders as an empty field again.
        assert.equal(stepValue("", 1, hours), "0.1");
        assert.equal(stepValue("", -1, hours), "0.1");
        assert.equal(stepValue("", 1, {step: 1}), "0");
    });

    it("treats an unparseable field as empty", () => {
        // A number input hands back "" for anything it could not parse, but the
        // stepper is also used on fields whose state was seeded from config.
        assert.equal(stepValue("abc", 1, hours), "0.1");
    });

    it("does not move a field that is already at the bound", () => {
        assert.equal(stepValue("10", 1, {min: 0, max: 10, step: 1}), "10");
        assert.equal(stepValue("0", -1, {min: 0, max: 10, step: 1}), "0");
    });
});

describe("atBound", () => {
    it("is true only where a press would change nothing", () => {
        assert.equal(atBound("10", 1, {max: 10}), true);
        assert.equal(atBound("9", 1, {max: 10}), false);
        assert.equal(atBound("0", -1, {min: 0}), true);
        assert.equal(atBound("1", -1, {min: 0}), false);
    });

    it("is false with no bound in that direction", () => {
        assert.equal(atBound("9999", 1, {}), false);
        assert.equal(atBound("-9999", -1, {}), false);
    });

    it("is false for an empty field, which a press does move", () => {
        // It moves it to the floor. Disabling the button there would leave a
        // reader with no way to start the field from the stepper at all.
        assert.equal(atBound("", -1, {min: 0.1}), false);
        assert.equal(atBound("", 1, {max: 10}), false);
    });
});

// ------------------------------------------------------------- the component

const source = withoutJsComments(readSource("client/src/common/components/NumberField/NumberField.jsx"));

describe("NumberField", () => {
    it("stays a number input, so the numeric keypad and the arrow keys survive", () => {
        assert.match(source, /type="number"/);
        assert.match(source, /inputMode="decimal"/,
            "a phone would offer the full keyboard for a field that only takes digits");
    });

    it("draws no stepper unless it is asked for one", () => {
        assert.match(source, /stepper\s*=\s*false/,
            "the stepper is not opt-in, so adopting NumberField changes how a field looks");
    });

    it("keeps the stepper out of the tab order and off the accessibility tree", () => {
        /*
         * The buttons are a pointer affordance and nothing else: a number input
         * is already exposed as a spinbutton, already answers the arrow keys,
         * and already announces its own min and max. Two more tab stops per
         * field would be three ways to reach one value.
         *
         * It is also what keeps the component free of new strings - a reachable
         * button needs a name, a name needs a key, and a key is 23 locale files
         * (see localeParity).
         */
        assert.match(source, /aria-hidden="true"/);
        assert.match(source, /tabIndex=\{-1\}/);
    });

    it("does not take focus off the field when a button is pressed", () => {
        // A mousedown on a button blurs the input, and a caller that validates
        // on blur would fire it on every press of its own stepper.
        assert.match(source, /onMouseDown=\{\(event\) => event\.preventDefault\(\)\}/);
    });
});

describe("the FormField number branch", () => {
    const formField = withoutJsComments(readSource("client/src/common/components/FormField/FormField.jsx"));

    it("delegates to NumberField rather than keeping a second number input", () => {
        assert.match(formField, /<NumberField/);
        assert.doesNotMatch(formField, /type="number"/,
            "there are two number inputs again, and only one of them gets the next fix");
    });

    it("still hands its own callers numbers", () => {
        // Its contract, unchanged: the integration forms store typed values.
        assert.match(formField, /Number\(/);
    });
});

describe("the NumberField stylesheet", () => {
    const css = compile("common/components/NumberField/styles.sass");
    const ruleFor = (selector) => rules(css).find((rule) => rule.selector === selector);

    it("lays the buttons inside the field rather than beside it", () => {
        // Beside it would add to the row's width, and the row this first lands
        // in has none to give - see the equal-thirds comment in the optimal
        // values stylesheet.
        assert.match(ruleFor(".number-field").body, /position:\s*relative/);
        assert.match(ruleFor(".number-field-step").body, /position:\s*absolute/);
    });

    it("paints the buttons from the palette", () => {
        const button = ruleFor(".number-field-step");

        assert.match(button.body, /color:\s*var\(--subtext\)/, "the stepper left the palette");
        assert.match(ruleFor(".number-field-step:hover:not(:disabled)").body,
            /color:\s*var\(--accent-primary\)/);
    });

    it("dims a button that would do nothing", () => {
        assert.ok(ruleFor(".number-field-step:disabled"), "a button at its bound looks pressable");
    });
});
