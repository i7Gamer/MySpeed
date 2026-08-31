import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource, withoutJsComments } from "../helpers/source.js";
import { compile, rules } from "../helpers/sass.mjs";

/**
 * The time field, and the two pickers behind it.
 *
 * A native `<input type="time">` hands its popup to the browser: on a desktop
 * that is a panel in the operating system's voice, laid over a dark dialog, in
 * a 12-hour clock the rest of this app does not use - and no stylesheet can
 * reach any of it. On touch it is the OS wheel, which is better than anything a
 * page can draw. So the pointer decides, and only the mouse gets the drawn one.
 *
 * What must not change is the value: `windowProblem` and the two config writes
 * behind it are mirrored against server/util/quietHours.js and pinned by
 * quietHoursParity. The field emits `""` or `HH:mm` and nothing else, which is
 * exactly what the native input emitted.
 */

const source = withoutJsComments(readSource("client/src/common/components/TimeField/TimeField.jsx"));

describe("TimeField on a coarse pointer", () => {
    it("hands the reader the operating system's own picker", () => {
        assert.match(source, /useCoarsePointer/);
        assert.match(source, /type="time"/,
            "the native input is gone, so touch lost the OS wheel this branch exists to keep");
    });
});

describe("TimeField on a fine pointer", () => {
    it("keeps a typable field rather than a button", () => {
        // Typing is faster than picking for somebody who knows the time they
        // want, and it is the only thing the native control was good at here.
        assert.match(source, /type="text"/);
        assert.match(source, /inputMode="numeric"/);
        assert.match(source, /maskTime/, "the field takes any text at all");
    });

    it("emits only an empty string or a whole time", () => {
        /*
         * The contract the window's reader is written against. A partial entry
         * is no time, so it goes out as "" - which lights the dialog's own
         * error state and disables its save, rather than teaching windowProblem
         * a third shape it would then have to agree with the server about.
         */
        assert.match(source, /onChange\(normaliseTime\(/,
            "something other than a normalised time can now reach the caller");
    });

    it("answers Escape on keydown, by the logical key", () => {
        // The rule every overlay here keeps; dropdownEscapeConsistency records
        // what it cost to learn.
        assert.match(source, /"Escape"/);
        assert.match(source, /onKeyDown/);
        assert.doesNotMatch(source, /event\.code/,
            "a keyboard with Escape remapped would not close the picker");
    });

    it("hands focus back to the field when the picker closes", () => {
        assert.match(source, /inputRef\.current\?\.focus\(\)/);
    });

    it("closes on a click outside, through the shared hook", () => {
        assert.match(source, /useClickOutside\(/,
            "a fifth private copy of the click-outside rule");
    });

    it("steps the half of the value the caret is in", () => {
        assert.match(source, /ArrowUp/);
        assert.match(source, /ArrowDown/);
        assert.match(source, /partAt\(/);
        assert.match(source, /stepPart\(/);
    });

    it("portals the picker out of the dialog's scroller", () => {
        // .dialog-main is overflow-y: auto, so a popup positioned inside it is
        // clipped by it - which is why DropdownSelect portals too.
        assert.match(source, /createPortal/);
    });

    it("offers the columns as real buttons", () => {
        assert.match(source, /<button\s+type="button"/);
    });
});

describe("TimeField's strings", () => {
    /**
     * It has none, and that is deliberate.
     *
     * A new English key fails localeParity in twenty-two languages at once, so
     * the columns are headed with the format tokens themselves - HH and MM are
     * not words in any language - and the field's accessible name is passed in
     * by the caller, which already has one.
     */
    it("adds no translation key", () => {
        assert.doesNotMatch(source, /\bt\(/,
            "the component translates something of its own, which is 23 locale files");
        assert.match(source, /HH/);
        assert.match(source, /MM/);
    });

    it("takes its accessible name from the caller", () => {
        assert.match(source, /ariaLabel/);
    });
});

describe("the quiet hours fields", () => {
    const pause = withoutJsComments(readSource("client/src/common/components/PauseDialog/PauseDialog.jsx"));

    it("are TimeFields now, not raw time inputs", () => {
        assert.doesNotMatch(pause, /type="time"/,
            "one of the two ends is still the browser's control");
        assert.equal(pause.match(/<TimeField/g)?.length, 2, "both ends of the window are not drawn the same");
    });

    it("still hand their setters a bare value", () => {
        // The native input handed over e.target.value; TimeField hands the value
        // itself, so the setters are passed straight through.
        assert.match(pause, /onChange=\{setQuietStart\}/);
        assert.match(pause, /onChange=\{setQuietEnd\}/);
    });

    it("keep the error state the window's own check decides", () => {
        assert.match(pause, /quietProblem === "start"/);
        assert.match(pause, /\["end", "same"\]\.includes\(quietProblem\)/);
    });
});

describe("the TimeField stylesheet", () => {
    const css = compile("common/components/TimeField/styles.sass");
    const ruleFor = (selector) => rules(css).find((rule) => rule.selector === selector);

    it("draws the picker as one of the app's menus", () => {
        // Through the shared mixin, so it cannot drift from the export menu and
        // the compare select it sits beside in the same interface.
        const menu = ruleFor(".time-field-menu");

        assert.ok(menu, "the picker has no menu box");
        assert.match(menu.body, /background-color:\s*var\(--dark-gray\)/);
        assert.match(menu.body, /border:[^;]*var\(--light-gray\)/);
        assert.match(menu.body, /box-shadow:/);
    });

    it("scrolls each column rather than growing the menu to 24 rows", () => {
        const column = ruleFor(".time-field-column");

        assert.ok(column, "there are no columns");
        assert.match(column.body, /overflow-y:\s*auto/);
    });

    it("marks the chosen row with the accent", () => {
        assert.match(ruleFor(".time-field-option.time-field-chosen").body,
            /var\(--accent-primary\)/, "nothing shows which hour is already set");
    });

    it("keeps the clock button inside the field", () => {
        assert.match(ruleFor(".time-field").body, /position:\s*relative/);
        assert.match(ruleFor(".time-field-trigger").body, /position:\s*absolute/);
    });
});
