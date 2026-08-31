import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource, withoutJsComments } from "../helpers/source.js";
import { compile, rules } from "../helpers/sass.mjs";
import { browserUses12h } from "@/common/components/TimeField/timeValue.js";

/**
 * The time field, and the two pickers behind it.
 *
 * A native `<input type="time">` hands its popup to the browser: on a desktop
 * that is a panel in the operating system's voice, laid over a dark dialog, and
 * no stylesheet can reach any of it. On touch it is the OS wheel, which is
 * better than anything a page can draw.
 *
 * So it is kept where it is the better control and can show the clock the
 * reader chose, and replaced everywhere else - which is a narrower rule than
 * "native on touch", because the format of a native time control cannot be set
 * at all. See "choosing the picker" at the foot of this file.
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

// ------------------------------------------------------- which picker, and why

/**
 * The rule that decides between the two pickers.
 *
 * A native `<input type="time">` cannot be told which clock to draw. Measured,
 * not assumed: `lang` on the element, on an ancestor and on the document all
 * render 01:45 PM on an en-US browser. So the choice is not "native on touch"
 * but "native where it already agrees" - and where it does not, the drawn
 * picker is used even under a finger, because a picker in the wrong clock is
 * worse than one that is merely not the OS's.
 */
describe("choosing the picker", () => {
    it("reads the reader's own clock, not the browser's", () => {
        assert.match(source, /TIME_FORMAT_12H/);
        assert.match(source, /PreferencesContext/,
            "the field decides its own format again, ignoring the one preference that governs every other time");
    });

    it("uses the native control only where it shows that clock", () => {
        assert.match(source, /browserUses12h\(\) === use12h/);
        assert.match(source, /coarse && nativeAgrees/,
            "touch gets the OS wheel even when it contradicts the reader's preference");
    });

    it("offers a meridiem column only on a 12-hour clock", () => {
        assert.match(source, /use12h \? \[\{part: "meridiem"/);
    });
});

describe("browserUses12h", () => {
    const engine = (resolved) => function () { return {resolvedOptions: () => resolved}; };

    it("believes hour12 where the engine states it", () => {
        assert.equal(browserUses12h(engine({hour12: true})), true);
        assert.equal(browserUses12h(engine({hour12: false})), false);
    });

    it("reads the hour cycle where that is all there is", () => {
        // h11 and h12 are the two 12-hour cycles; h23 and h24 the 24-hour ones.
        for (const hourCycle of ["h11", "h12"])
            assert.equal(browserUses12h(engine({hourCycle})), true, hourCycle);

        for (const hourCycle of ["h23", "h24"])
            assert.equal(browserUses12h(engine({hourCycle})), false, hourCycle);
    });

    it("reads an engine that answers neither as 24-hour", () => {
        // The app's default, and the clock the configuration is written in.
        assert.equal(browserUses12h(engine({})), false);
        assert.equal(browserUses12h(null), false);
    });
});

/**
 * The touch fallback, where the native time input shows the wrong clock.
 *
 * Still native controls: a <select> opens the platform's own picker - the wheel
 * on iOS, the modal list on Android - which is the part of the native input
 * worth keeping on a phone. What it does not inherit is the format, because
 * these options are ours. That is the whole trick, and it is the only way to a
 * native 24-hour picker: the browser decides the clock of an
 * `<input type="time">` and nothing on the page can overrule it - `lang` on the
 * element, on an ancestor and on the document were all measured and all ignored
 * - but nobody decides the contents of a <select> except us.
 */
describe("TimeField on touch, where the native clock disagrees", () => {
    it("falls back to native selects rather than to the drawn picker", () => {
        assert.match(source, /if \(coarse\) \{/,
            "there is no touch branch between the OS wheel and the drawn picker");
        assert.match(source, /<select/, "the fallback is not a native control");
    });

    it("dresses them as the app's other selects", () => {
        // The caret and the appearance reset that every native select here
        // wears, so the fallback is not the one control with the OS arrow.
        assert.match(source, /className="select-wrap"/);
        assert.match(source, /select-field/);
    });

    it("names each one by the part it holds", () => {
        // Three comboboxes all called "From" would be one name for three
        // different questions, and HH/MM need no translating.
        assert.match(source, /aria-label=\{`\$\{ariaLabel\} \$\{head\}`\}/);
    });

    it("offers the same columns the drawn picker does", () => {
        // One answer to "what can I pick", rather than one per device.
        assert.match(source, /columns\.map\(\(\{part, head, options\}\)/);
    });

    it("clears the whole value when a column is emptied", () => {
        assert.match(source, /next === "" \? "" :/,
            "emptying one column leaves half a time, which is not a window");
    });
});

/**
 * Three faults found by opening the picker rather than by reading it, each
 * measured on the running dialog.
 */
describe("the picker, as it actually behaved", () => {
    it("does not treat its own trigger as a click outside", () => {
        /*
         * The button could not close the picker. useClickOutside hears the
         * mousedown, closes, and React flushes that before the click arrives -
         * so the click read isOpen as false and opened it again. Measured: the
         * menu was gone after a bare mousedown and back after the click.
         */
        assert.match(source, /ignore: \(target\) => !!triggerRef\.current\?\.contains\(target\)/,
            "the trigger is outside its own menu again, so it cannot close it");
        assert.match(source, /ref=\{triggerRef\}/);
    });

    it("centres each column in a pass after the height lands", () => {
        /*
         * place() sets the menu's maxHeight as state, so a column is not yet
         * scrollable in that same pass and a scroll there does nothing at all.
         * Measured on a stored 23:30: both columns sat at scrollTop 0 with the
         * chosen rows off-screen.
         */
        assert.match(source, /\}, \[isOpen, position\]\)/,
            "the centring runs before the height that makes a column scrollable");
        assert.match(source, /centred\.current/, "it re-centres on every scroll and resize");
    });

    it("centres every column, and only its own scroller", () => {
        assert.match(source, /querySelectorAll\("\.time-field-chosen"\)/,
            "querySelector answers the hour alone, so the minutes never move");
        assert.doesNotMatch(source, /scrollIntoView/,
            "scrollIntoView walks up and scrolls the page this menu is portalled onto");
        assert.match(source, /column\.scrollTop =/);
    });
});

describe("a select given the shared caret", () => {
    const dialogCss = compile("common/contexts/Dialog/styles.sass");

    it("fills the wrapper the caret is drawn on", () => {
        /*
         * The caret is positioned against the wrapper, so the two have to end
         * at the same pixel. In the targets manager they did not: .provider-
         * input's 14rem basis stopped being a share of the row once the select
         * sat inside a wrapper, leaving the field 224px inside a 314px wrapper
         * and the caret 86px clear of the control. Measured, not deduced.
         */
        const filled = rules(dialogCss).find((rule) => rule.selector === ".select-wrap > .select-field");

        assert.ok(filled, "nothing makes the field fill its wrapper");
        assert.match(filled.body, /width:\s*100%/);
        assert.match(filled.body, /flex:\s*1 1 auto/,
            "a call site that gives the field its own flex basis strands the caret again");
    });
});
