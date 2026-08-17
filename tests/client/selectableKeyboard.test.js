import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../helpers/source.js";
import { activateOnKey } from "../../client/src/common/components/SelectableOption/keyActivation.js";

const source = readSource("client/src/common/components/SelectableOption/SelectableOption.jsx");

const keyPress = (key) => ({
    key,
    defaultPrevented: false,
    preventDefault() {
        this.defaultPrevented = true;
    }
});

/**
 * The option rows in every settings dialog were a plain div with an onClick.
 *
 * Nothing else: no tab stop, no role, no key handler. So the provider, the
 * language, the frequency, the access level, the pause preset and the
 * preferences could each be read by a keyboard-only user and none of them could
 * be chosen - the dialog opened, Tab went straight past the whole list to the
 * Save button, and the only way to change any of these settings was a mouse.
 *
 * The activation rule is exported so it can be run rather than read; the
 * attributes it hangs off are asserted on the source, which is the only way to
 * see JSX the test runner does not compile.
 */
describe("choosing an option from the keyboard", () => {
    it("activates on Enter", () => {
        let chosen = 0;

        assert.equal(activateOnKey(keyPress("Enter"), () => chosen++), true);
        assert.equal(chosen, 1);
    });

    // Space is what a radio actually answers to; Enter is the one people try.
    it("activates on Space", () => {
        let chosen = 0;

        assert.equal(activateOnKey(keyPress(" "), () => chosen++), true);
        assert.equal(chosen, 1);
    });

    it("claims the key it acts on", () => {
        const event = keyPress(" ");

        activateOnKey(event, () => undefined);

        assert.equal(event.defaultPrevented, true,
            "Space still scrolled the dialog out from under the option it selected");
    });

    it("leaves every other key alone", () => {
        for (const key of ["Tab", "Escape", "a", "ArrowDown", "Shift", "Enter "]) {
            let chosen = 0;
            const event = keyPress(key);

            assert.equal(activateOnKey(event, () => chosen++), false, `${key} selected an option`);
            assert.equal(chosen, 0);
            assert.equal(event.defaultPrevented, false, `${key} was swallowed`);
        }
    });

    // Tab has to keep moving through the list, or the rows become a trap.
    it("does not claim Tab", () => {
        const event = keyPress("Tab");

        activateOnKey(event, () => undefined);

        assert.equal(event.defaultPrevented, false);
    });

    it("survives an option with nothing wired to it", () => {
        assert.doesNotThrow(() => activateOnKey(keyPress("Enter"), undefined));
    });
});

/**
 * The attributes that make the rule above reachable at all. A handler on an
 * element nothing can focus is never called.
 */
describe("the option's own markup", () => {
    it("is a tab stop", () => {
        assert.match(source, /tabIndex=\{0\}/, "the option cannot be focused, so it cannot be reached");
    });

    it("answers the keyboard", () => {
        assert.match(source, /onKeyDown=\{/, "the option is focusable but does nothing when typed at");
    });

    it("announces itself as a radio", () => {
        assert.match(source, /role="radio"/, "a screen reader is told the option is an unlabelled div");
    });

    it("announces whether it is the chosen one", () => {
        assert.match(source, /aria-checked=\{active\}/,
            "nothing conveys which option is selected except its colour");
    });

    /**
     * role="radio" is only valid inside a radiogroup - without the container
     * role the options are announced as radios belonging to nothing, which is
     * worse than leaving them unlabelled. Every list in the dialogs is a
     * single-select group: each one binds active={value === option.id}.
     */
    it("sits in a group that makes that role valid", () => {
        assert.match(source, /role="radiogroup"/,
            "the options claim to be radios with no group to belong to");
    });
});
