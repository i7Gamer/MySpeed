import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as sass from "sass";
import { clickable } from "@/common/utils/Clickable.js";
import { nextFocus } from "@/common/hooks/useModalFocus.js";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const read = (file) => fs.readFileSync(path.join(CLIENT_SRC, file), "utf8");

const pagination = read("common/components/Header/components/Pagination/Pagination.jsx");
const paginationStyles = read("common/components/Header/components/Pagination/styles.sass");
const dropdown = read("common/components/DropdownSelect/DropdownSelect.jsx");
const datePicker = read("common/components/DateRangePicker/DateRangePicker.jsx");
const datePickerStyles = read("common/components/DateRangePicker/styles.sass");
const settingsMenu = read("common/components/Dropdown/DropdownComponent.jsx");
const exportMenu = read("common/components/ExportButton/ExportButton.jsx");
const exportStyles = read("common/components/ExportButton/styles.sass");
const integrationDialog = read("common/components/IntegrationDialog/IntegrationDialog.jsx");

/**
 * The element that carries `marker` in its className, named.
 *
 * Walking back to the nearest `<` rather than matching an opening tag, because
 * these tags carry arrow functions - `onClick={() => …}` - and any pattern
 * written as "everything up to the closing angle bracket" stops inside the
 * first arrow it meets.
 */
const elementsCarrying = (source, marker) => {
    const found = [];

    for (let at = source.indexOf(marker); at !== -1; at = source.indexOf(marker, at + 1)) {
        const opened = source.lastIndexOf("<", at);
        found.push(opened === -1 ? null : source.slice(opened + 1).match(/^[A-Za-z][\w.]*/)?.[0] ?? null);
    }

    assert.notEqual(found.length, 0, `${marker} is no longer in this component`);

    return found;
};

/**
 * The opening tag of the element carrying `marker`, attributes and all.
 *
 * Walking back to the nearest `<` for the reason elementsCarrying does, and
 * forward to the first `>` after the marker - which is the end of the tag only
 * while its attributes hold no arrow function. Both callers are containers whose
 * handlers are named rather than written inline.
 */
const tagHolding = (source, marker) => {
    const at = source.indexOf(marker);
    assert.notEqual(at, -1, `${marker} is no longer in this component`);

    return source.slice(source.lastIndexOf("<", at), source.indexOf(">", at) + 1);
};

// Every <button …> in a component says which kind it is, since a button left
// untyped defaults to submit. The same reason HelpButton gives.
const everyButtonIsTyped = (source, what) => {
    const opened = (source.match(/<button\b/g) ?? []).length;
    // Anywhere in the tag, not only first. Requiring it immediately after
    // `<button` made the rule depend on attribute order, so moving a `ref` or a
    // `key` in front of it failed a component that had lost nothing.
    const typed = (source.match(/<button\b[^>]*\btype="button"/g) ?? []).length;

    assert.notEqual(opened, 0, `${what} contains no buttons at all`);
    assert.equal(typed, opened, `a button in ${what} leaves its type to the browser`);
};

/**
 * The app's own navigation, which a keyboard could not reach.
 *
 * Both items were plain divs carrying an onClick, so Tab walked straight past
 * them and neither Enter nor Space did anything once it got there. That is the
 * whole of the in-app navigation between the overview and the statistics: the
 * only other control that goes to /statistics is the status bar's failure link,
 * which renders only while there are recent failures, so on a healthy instance
 * a keyboard-only user had the address bar and nothing else.
 *
 * A real <button> is the fix rather than a key handler on the div, for the
 * reason HelpButton already documents - focus, Enter and Space all come with
 * the element, and a screen reader announces it as a control.
 */
describe("the header's pagination answers the keyboard", () => {
    it("navigates with buttons rather than bare divs", () => {
        assert.deepEqual(elementsCarrying(pagination, "pagination-item"), ["button", "button"],
            "a navigation item is not a button, so no keyboard can reach it");
    });

    it("declares an explicit type on them", () => {
        everyButtonIsTyped(pagination, "the pagination");
    });

    /**
     * The label is a span, not a paragraph.
     *
     * A button takes phrasing content, and a <p> inside one is invalid enough
     * that the parser closes the button early - which would take the second
     * half of the control out of it. The stylesheet has to name the same
     * element, or the labels lose their weight and stop being hidden on a
     * narrow viewport.
     */
    it("labels them with an element a button may contain", () => {
        assert.doesNotMatch(pagination, /<p>\{t\("page\./,
            "a navigation label is a paragraph, which cannot sit inside a button");
        assert.match(pagination, /<span>\{t\("page\.overview"\)}<\/span>/);
        assert.match(pagination, /<span>\{t\("page\.statistics"\)}<\/span>/);
    });

    it("styles the label the stylesheet actually finds", () => {
        const item = paginationStyles.slice(paginationStyles.indexOf(".pagination-item"));

        assert.match(item, /\r?\n {4}span\r?\n {6}margin: 0/,
            "the label's own rules name an element the markup no longer uses");
    });

    // Below 968px the labels give way to the icons alone, which is what keeps
    // the header on one line - see headerTitleShrink.
    it("still drops the labels on a narrow viewport", () => {
        const narrow = paginationStyles.slice(paginationStyles.indexOf("@media (max-width: 968px)"));

        assert.match(narrow, /span\r?\n\s+display: none/,
            "the labels no longer disappear where the header needs the room");
    });

    /**
     * A button brings its own background, border and font, and all three are
     * wrong here: the item is painted by .pagination-active-background sliding
     * underneath it, so anything the browser draws on the button itself covers
     * that up.
     */
    it("clears the styling a button arrives with", () => {
        const item = paginationStyles.slice(paginationStyles.indexOf(".pagination-item"),
            paginationStyles.indexOf(".page-active"));

        for (const reset of [/background: none/, /border: none/, /font-family: inherit/])
            assert.match(item, reset, `the button keeps its own ${reset.source}`);
    });
});

/**
 * The cards, which a keyboard could not reach either.
 *
 * Nine tiles on /statistics open an expanded panel, and every node card
 * switches the whole app to that node - all of them a bare <div onClick> with
 * `cursor: pointer` and nothing else, so Tab walked past every one of them.
 * That is the entire expanded-chart feature and the entire node switcher
 * unreachable without a pointer, and a screen reader announced none of it.
 *
 * A real <button> is the fix where the control is a control, which is what the
 * pagination and the dropdown above became. These are not: they hold headings,
 * canvases and whole panels, which a button may not contain. So they take the
 * other standard shape - role, tab stop and a key handler - and take it from
 * one place, because the shape is only ever wrong by being written out again
 * slightly differently. SpeedtestComponent already had it, hand-written, down to
 * the guard that keeps a nested control's Enter from expanding the row instead;
 * `clickable` is that, lifted out.
 */
describe("clickable", () => {
    const activated = () => {
        const calls = [];
        return {calls, props: clickable((event) => calls.push(event))};
    };

    it("marks the element as a control and puts it in the tab order", () => {
        const {props} = activated();

        assert.equal(props.role, "button");
        assert.equal(props.tabIndex, 0);
    });

    it("still clicks", () => {
        const {calls, props} = activated();

        props.onClick("a click");
        assert.deepEqual(calls, ["a click"]);
    });

    for (const key of ["Enter", " "]) {
        it(`activates on ${key === " " ? "Space" : key}`, () => {
            const {calls, props} = activated();
            const event = {...keyPress(key), target: 1, currentTarget: 1};

            props.onKeyDown(event);

            assert.equal(calls.length, 1, `${key} did nothing`);
            // Space scrolls the page and Enter submits, unless the handler says
            // it has dealt with the key itself.
            assert.equal(event.defaultPrevented, true);
        });
    }

    it("leaves every other key to the page", () => {
        const {calls, props} = activated();

        for (const key of ["Tab", "Escape", "a", "ArrowDown", "Shift"]) {
            const event = {...keyPress(key), target: 1, currentTarget: 1};
            props.onKeyDown(event);

            assert.equal(event.defaultPrevented, false, `${key} was swallowed`);
        }

        assert.equal(calls.length, 0);
    });

    /**
     * The guard SpeedtestComponent documents: a control nested inside the card
     * gets Enter and Space of its own, and those bubble. Acting on them here
     * would expand the card instead of pressing the button, and preventDefault
     * would cancel the click the browser was about to synthesise from that key
     * - so the nested button's own handler never ran at all.
     */
    it("ignores a key aimed at a control inside the card", () => {
        const {calls, props} = activated();
        const event = {...keyPress("Enter"), target: "the help button", currentTarget: "the card"};

        props.onKeyDown(event);

        assert.equal(calls.length, 0, "a key meant for a nested control activated the card");
        assert.equal(event.defaultPrevented, false, "the nested control's own click was cancelled");
    });

    // A card with nothing to do is not a control, and offering a tab stop that
    // does nothing is worse than not offering one.
    it("leaves an element with no action alone", () => {
        assert.deepEqual(clickable(undefined), {});
        assert.deepEqual(clickable(null), {});
    });
});

/**
 * And every card that opens something takes it from there.
 *
 * Written out per component is how eight of the nine came to have nothing at
 * all while the ninth - the overview row - had the whole shape.
 */
describe("every clickable card answers the keyboard", () => {
    const CARDS = [
        {what: "the statistics cards", file: "pages/Statistics/components/StatisticContainer/StatisticContainer.jsx"},
        {what: "the download and upload charts", file: "pages/Statistics/charts/SpeedChart/SpeedChart.jsx"},
        {what: "the ping chart", file: "pages/Statistics/charts/PingChart.jsx"},
        {what: "the hourly chart", file: "pages/Statistics/charts/HourlyChart.jsx"},
        {what: "a node card", file: "pages/Nodes/components/NodeContainer/NodeContainer.jsx"},
        {what: "the add-node tile", file: "pages/Nodes/Nodes.jsx"}
    ];

    for (const {what, file} of CARDS) {
        it(`${what} can be reached and pressed`, () => {
            assert.match(read(file), /\.\.\.clickable\(/,
                `${what} is a click-only element: no tab stop, no key handler, nothing announced`);
        });
    }

    // The one that already had it, kept honest: it must not drift back to a
    // hand-written copy, and it must not lose the shape either.
    it("the overview row still has it", () => {
        const row = read("pages/Home/components/Speedtest/SpeedtestComponent.jsx");

        assert.match(row, /\.\.\.clickable\(/, "the overview row went back to a copy of its own");
    });

    /**
     * And focus is visible when it lands on one.
     *
     * A tab stop nobody can see is the other half of the same problem: the
     * cards are now reachable, and without a ring a keyboard user is moving
     * through them blind. Stated once against the role rather than per card,
     * for the same reason the role is - fourteen copies is fourteen chances to
     * leave one out.
     */
    it("shows where focus is", () => {
        const css = sass.compile(path.join(CLIENT_SRC, "common/styles/default.sass"), {
            importers: [{
                findFileUrl: (url) => url.startsWith("@/")
                    ? pathToFileURL(path.join(CLIENT_SRC, url.slice(2)))
                    : null
            }]
        }).css;

        const rule = css.match(/\[role=["']?button["']?]:focus-visible\s*\{([^}]*)}/);

        assert.notEqual(rule, null, "a card can be focused with nothing on screen to say so");
        assert.match(rule[1], /outline:/, "the focus rule draws no outline");
    });
});

/**
 * The control that decides what every figure on /statistics is about.
 *
 * Its trigger was a bare div with an onClick, so Tab walked past it and Enter
 * did nothing if focus were forced onto it. That is the only way to change the
 * range from the interface - the presets live inside the popover it opens - so
 * a keyboard-only reader was left with whatever range the page loaded with, on
 * both toolbars that draw one.
 *
 * A real <button> rather than `clickable`, for the reason the pagination gives:
 * the trigger holds an icon and a span, which a button may contain, and a real
 * button brings focus, Enter, Space and its own announcement with it.
 */
describe("the date range picker answers the keyboard", () => {
    it("opens from a button rather than a bare div", () => {
        assert.deepEqual(elementsCarrying(datePicker, "date-range-trigger"), ["button"],
            "the trigger is not a button, so no keyboard can open the picker");
    });

    it("declares an explicit type on every button it draws", () => {
        everyButtonIsTyped(datePicker, "the date range picker");
    });

    // Whether it is open now: without it a screen reader announces a button
    // that appears to do nothing.
    it("says whether it is open", () => {
        assert.match(datePicker, /aria-expanded=\{isOpen}/,
            "nothing tells a screen reader whether the picker is already open");
    });

    /**
     * And promises no more than that. aria-haspopup="dialog" says a dialog is
     * behind the trigger; what is behind this one is a popover with no role, no
     * name, and nothing that moves focus into it - so a reader would be told
     * "has pop-up dialog", press Enter, hear "expanded", and then be told
     * nothing. The markup is a disclosure, and aria-expanded states that on its
     * own. Either the attribute goes or the popover becomes a real dialog; what
     * cannot stand is the attribute alone.
     */
    it("does not announce a dialog it does not open", () => {
        assert.ok(!datePicker.includes('aria-haspopup="dialog"')
            || /className="date-range-popover"[^>]*role="dialog"/.test(datePicker),
            "the trigger promises a dialog, and the popover behind it is not one");
    });

    /**
     * The four month and year arrows were buttons already - reachable, and
     * announced as nothing. Each holds a single FontAwesome glyph, which
     * renders `aria-hidden`, so the accessible name of all four was empty.
     */
    it("names each calendar arrow", () => {
        const start = datePicker.indexOf('className="calendar-nav"');
        const end = datePicker.indexOf('className="calendar-grid"');

        /*
         * Both markers, before anything is sliced between them. A missing first
         * one makes indexOf answer -1, which slice reads as one character from
         * the end - so the window comes back empty, the parity below compares
         * nothing with nothing, and a fifth unnamed arrow is invisible to it.
         */
        assert.ok(start !== -1 && end > start,
            "the calendar's navigation row is not where this scan looks for it, so it is scanning nothing");

        const nav = datePicker.slice(start, end);
        const arrows = nav.match(/nav-btn/g) ?? [];

        assert.ok(arrows.length >= 4,
            `only ${arrows.length} arrows are inside that window, so the parity check below is empty`);
        assert.equal(arrows.length, (nav.match(/aria-label=/g) ?? []).length,
            "a calendar arrow carries no accessible name, so it announces as an empty button");

        for (const key of ["previous_year", "previous_month", "next_month", "next_year"])
            assert.match(datePicker, new RegExp(`aria-label=\\{t\\("calendar\\.${key}"\\)}`),
                `no arrow is named by calendar.${key}`);
    });

    // A button brings its own font and centres its text; the trigger already
    // states its own background and border, so those two are what is left.
    it("clears the styling a button arrives with", () => {
        const trigger = datePickerStyles.slice(datePickerStyles.indexOf(".date-range-trigger"),
            datePickerStyles.indexOf(".calendar-icon"));

        for (const reset of [/font-family: inherit/, /text-align: left/])
            assert.match(trigger, reset, `the trigger keeps the button's own ${reset.source}`);
    });
});

/**
 * The settings menu, which is the only route to nine of the app's dialogs.
 *
 * Every entry was a div with an onClick and nothing else: optimal values, the
 * provider, storage, the password, the schedule, pause, integrations, the
 * language and the preferences. Tab walked past all of them, so a keyboard-only
 * operator could not open a single one, and a screen reader announced each as an
 * image next to a heading with no hint that it does anything.
 *
 * `clickable` rather than a <button>, for the reason it documents: the entry
 * holds an <h3>, which a button may not contain.
 */
describe("the settings menu answers the keyboard", () => {
    it("makes each entry a control", () => {
        const item = settingsMenu.slice(settingsMenu.indexOf('"dropdown-item"'));

        assert.match(item.slice(0, item.indexOf("</div>")), /\.\.\.clickable\(/,
            "a settings entry is a click-only div: no tab stop, no key handler, nothing announced");
    });
});

/**
 * And the export menu, whose two formats were the same click-only divs. The
 * button that opens it was already named and already said whether it was open -
 * the options behind it could not be reached at all.
 */
describe("the export menu answers the keyboard", () => {
    it("offers its formats as buttons rather than bare divs", () => {
        assert.deepEqual(elementsCarrying(exportMenu, "export-option"), ["button", "button"],
            "an export format is not a button, so no keyboard can choose one");
    });

    it("declares an explicit type on them", () => {
        everyButtonIsTyped(exportMenu, "the export menu");
    });

    it("clears the styling a button arrives with", () => {
        const option = exportStyles.slice(exportStyles.indexOf(".export-option"));

        for (const reset of [/background: none/, /border: none/, /font-family: inherit/, /width: 100%/])
            assert.match(option, reset, `an export option keeps the button's own ${reset.source}`);
    });
});

// The index of the } that closes the block opened at `from`.
const blockEnd = (source, from) => {
    let depth = 0;

    for (let index = from; index < source.length; index++) {
        if (source[index] === "{") depth++;
        else if (source[index] === "}" && --depth === 0) return index;
    }

    assert.fail("a block is never closed");
};

/**
 * The named arrow function, lifted out of the component and made callable.
 *
 * Same approach as escapeTopmost: what is wrong with a key handler is what it
 * does with an event, and that is only observable by handing it one. The JSX
 * around it is the only part node cannot parse.
 */
const handlerIn = (source, named, closure) => {
    const start = source.indexOf(named);
    assert.notEqual(start, -1, `${named} is not in this component`);

    const arrow = source.indexOf("=>", start);
    // The handler's own parameter list, rather than assuming it is called `e`:
    // the body refers to it by name, so a key handler and one taking a chosen
    // item cannot both be wrapped in the same signature.
    //
    // The last bracket before the arrow rather than the first, so a handler
    // wrapped in useCallback - which puts a bracket of its own in front of the
    // parameter list - lifts out the same way a bare arrow does.
    const parameter = source.slice(source.lastIndexOf("(", arrow), arrow).trim();
    const body = source.slice(source.indexOf("{", arrow));
    const names = Object.keys(closure);

    return new Function(...names, `return ${parameter} => ${body.slice(0, blockEnd(body, 0) + 1)};`)(
        ...names.map((name) => closure[name]));
};

const keyPress = (key, shiftKey = false) => ({
    key,
    shiftKey,
    defaultPrevented: false,
    preventDefault() {
        this.defaultPrevented = true;
    }
});

/**
 * The menu that adds an integration, which could only be used with a mouse.
 *
 * Its options were divs carrying tabIndex={0} and an onClick, which is the worst
 * of both: focus lands on them, so a keyboard user is led to believe the option
 * is reachable, and then Enter and Space do nothing when they get there. No
 * synthetic click is dispatched for a div. Since this dropdown is the only route
 * to adding an integration, a keyboard-only operator could not add one at all.
 *
 * Escape did not dismiss the menu either, so having opened it there was no way
 * back out without reaching for the pointer.
 */
describe("the integration menu answers the keyboard", () => {
    it("offers its options as buttons rather than focusable divs", () => {
        assert.deepEqual(elementsCarrying(dropdown, "dropdown-select-item"), ["button"],
            "a menu option is not a button, so Enter and Space do nothing on it");
    });

    it("declares an explicit type on them", () => {
        everyButtonIsTyped(dropdown, "the dropdown");
    });

    // The div carried tabIndex={0} to look reachable. A button is reachable, so
    // the hint is not only unnecessary, it would override the element's own
    // place in the tab order.
    it("leaves the tab order to the element", () => {
        const item = dropdown.slice(dropdown.indexOf("dropdown-select-item"));

        assert.doesNotMatch(item.slice(0, item.indexOf("</button>")), /tabIndex=\{0}/,
            "a menu option still pins its own tab index");
    });

    /**
     * The menu's key handler, lifted out and given a menu to act on.
     *
     * `options` are what the portalled menu holds - plain objects, because
     * nextFocus is the real one and asks a container for its focusable
     * children, filters the ones a browser would skip, and hands back the
     * element it wants focused. `active` is where focus is when the key is
     * pressed, given as an index into them, or null for focus that is
     * elsewhere.
     */
    const open = ({active = null, menu = true, holding = ["first", "middle", "last"]} = {}) => {
        const options = holding.map((name) =>
            ({name, focused: 0, focus() { this.focused++; }}));
        const state = {open: true, focused: false};

        const press = handlerIn(dropdown, "const handleMenuKey", {
            nextFocus,
            isOpen: menu,
            setIsOpen: (value) => state.open = value,
            menuRef: {current: menu ? {querySelectorAll: () => options} : null},
            containerRef: {current: {querySelector: () => ({focus: () => state.focused = true})}},
            document: {activeElement: active === null ? null : options[active]}
        });

        return {press, state, options};
    };

    describe("Escape", () => {
        it("closes the menu", () => {
            const {press, state} = open();
            const event = keyPress("Escape");

            press(event);

            assert.equal(state.open, false, "the menu stays open, with no way out but the pointer");
            assert.equal(event.defaultPrevented, true);
        });

        // Or focus is left on an option that is no longer rendered, which drops
        // the operator back to the top of the document.
        it("puts focus back on the button that opened it", () => {
            const {press, state} = open();

            press(keyPress("Escape"));

            assert.equal(state.focused, true, "focus is left on a menu that has just been unmounted");
        });

        /*
         * And leaves the key alone when there is no menu to dismiss.
         *
         * The handler sits on the container, which is mounted whether or not the
         * menu is - so with focus on the trigger it claimed Escape and closed a
         * menu that was already closed. The Dialog's own Escape declines a key
         * whose default has been prevented, which is what keeps a stacked alert
         * from taking the dialog under it down as well, so this swallowed the
         * one key that dismisses the dialog: on the create button, inside the
         * only dialog that draws one, Escape did nothing at all.
         *
         * The branch is what makes that easy to reach - the trap now seats focus
         * inside the dialog and keeps it there, so the create button is part of
         * the ordinary cycle rather than a long Tab away.
         */
        it("leaves it to the dialog when the menu is closed", () => {
            const {press, state} = open({menu: false});
            const event = keyPress("Escape");

            press(event);

            assert.equal(event.defaultPrevented, false,
                "the trigger swallows the key that dismisses the dialog around it");
            assert.equal(state.focused, false, "focus is moved for a menu that was never open");
        });

        it("leaves every other key alone", () => {
            const {press, state} = open();

            for (const key of ["Enter", " ", "Tab", "ArrowDown", "Esc"]) press(keyPress(key));

            assert.equal(state.open, true);
        });

        /*
         * On the container, not on the menu. A React portal bubbles its events
         * through the tree it was declared in, so this sees keys pressed on the
         * options as well as on the trigger - and the container is the half that
         * is still mounted when the menu is not.
         */
        it("is held by the element that wraps the trigger and the menu", () => {
            assert.match(tagHolding(dropdown, "dropdown-select-container"), /onKeyDown={handleMenuKey}/,
                "the key handler is never reached, so neither Escape nor Tab is answered");
        });
    });

    /**
     * Tab cycles the options rather than walking out of the dialog behind them.
     *
     * The menu is portalled to the body, so it is a sibling of the backdrop and
     * not a descendant of the dialog. The modal trap is a keydown listener on
     * the dialog, and it never hears a key pressed in here - so a Tab off the
     * last option went wherever document order said, which is past the end of
     * the menu and back to the page underneath. The blur then closed the menu,
     * and the reader was left on a control behind a backdrop still announcing
     * aria-modal. That is the one thing the trap exists to prevent, reached
     * through the one control it cannot see.
     *
     * Held here rather than in the trap, because the trap works by containment
     * and this menu is deliberately not contained. Escape is the way out, and it
     * already gives focus back to the button that opened it - which is inside
     * the dialog, where the trap picks it up again.
     */
    describe("Tab", () => {
        it("wraps from the last option to the first", () => {
            const {press, options} = open({active: 2});
            const event = keyPress("Tab");

            press(event);

            assert.equal(event.defaultPrevented, true, "the browser is left to take Tab out of the dialog");
            assert.equal(options[0].focused, 1, "focus lands on the page behind the backdrop");
        });

        it("wraps backwards from the first option to the last", () => {
            const {press, options} = open({active: 0});
            const event = keyPress("Tab", true);

            press(event);

            assert.equal(event.defaultPrevented, true);
            assert.equal(options[2].focused, 1, "Shift+Tab leaves the menu through the top");
        });

        // A Tab in the middle is the browser's own to answer: claiming it would
        // mean re-implementing tab order rather than closing it into a loop.
        it("leaves a step between two options alone", () => {
            const {press, options} = open({active: 0});
            const event = keyPress("Tab");

            press(event);

            assert.equal(event.defaultPrevented, false, "the menu re-implements the browser's own tab order");
            assert.deepEqual(options.map((option) => option.focused), [0, 0, 0]);
        });

        /*
         * A menu with nothing in it has nowhere to send Tab, and nextFocus
         * answers for that case by handing back the container - which is what a
         * dialog wants, having a tabIndex of its own to be focused by, and not
         * what this menu wants. Claiming the key there would swallow it against
         * a div that cannot take focus: Tab would do nothing at all, with
         * nothing on screen to say why.
         */
        it("leaves the key alone when the menu holds no options", () => {
            const {press} = open({holding: []});
            const event = keyPress("Tab");

            press(event);

            assert.equal(event.defaultPrevented, false,
                "Tab is claimed by a menu with nothing to give it to, and then simply does nothing");
        });

        // Closed, the menu is unmounted and its ref is null - and the trigger
        // sits inside the dialog, where the modal trap answers for it.
        it("leaves the key alone when the menu is closed", () => {
            const {press, options} = open({menu: false});
            const event = keyPress("Tab");

            press(event);

            assert.equal(event.defaultPrevented, false, "Tab is trapped in a menu that is not on the page");
            assert.deepEqual(options.map((option) => option.focused), [0, 0, 0]);
        });
    });
});

/**
 * And the settings menu gives focus back to the gear that opened it.
 *
 * The menu is not unmounted when it closes - DropdownComponent toggles
 * `dropdown-invisible`, which is `visibility: hidden` - and every entry is a
 * `clickable` div that takes focus when it is activated. So the element focus
 * sits on after an entry is chosen is one the same click has just hidden, and
 * `focus()` on an element inside a `visibility: hidden` ancestor does nothing at
 * all while `isConnected` stays true.
 *
 * That is the state the nine dialogs behind this menu open in, so the focus
 * restore they were given records an element it can never focus and leaves the
 * reader on <body> - the exact thing it exists to prevent. The gear is the right
 * answer anyway: it is what a menu returns focus to.
 */
describe("the settings menu", () => {
    const header = read("common/components/Header/HeaderComponent.jsx");

    it("holds a reference to the control that opens it", () => {
        assert.match(header, /ref=\{triggerRef}/,
            "nothing can put focus back on the gear, because nothing holds it");
    });

    it("returns focus there when the menu closes over a focused entry", () => {
        const closing = header.slice(header.indexOf("const switchDropdown"));
        const body = closing.slice(0, closing.indexOf("\n    }"));

        assert.match(body, /triggerRef\.current\?\.focus\(\)/,
            "closing the menu leaves focus on the entry it has just hidden");
        assert.match(body, /closest\?\.\(["'`]\.dropdown["'`]\)/,
            "focus is taken back even when it was never inside the menu");
    });
});

/**
 * And the same rule over the overlays' own buttons.
 *
 * An untyped button defaults to submit. Nothing in this client renders a form,
 * so today that costs nothing - but the rule is worth holding where it is cheap
 * rather than meeting the exception on the day a form appears, and these three
 * are the dialogs whose buttons were left as they were found while every other
 * one this branch touched was typed.
 */
describe("the dialogs' own buttons", () => {
    const overlays = {
        "the optimal values dialog": "common/components/OptimalValuesDialog/OptimalValuesDialog.jsx",
        "the integration dialog": "common/components/IntegrationDialog/IntegrationDialog.jsx",
        "the welcome dialog": "common/components/WelcomeDialog/WelcomeDialog.jsx"
    };

    for (const [what, file] of Object.entries(overlays))
        it(`states the type of every button in ${what}`, () => everyButtonIsTyped(read(file), what));
});

/**
 * And the export menu gives focus back when it closes over its own control.
 *
 * Its two formats became real buttons here, which is what made them reachable -
 * and choosing one calls setIsOpen(false), which unmounts the very button that
 * holds focus. A pointer never noticed: it had nothing focused to lose. A
 * keyboard lands on <body>, so the next Tab restarts at the top of the document,
 * and this is only reachable at all because the options can now be activated
 * without a mouse.
 *
 * The trigger is already held in a ref for the click-outside, so there is
 * something to give it back to.
 */
describe("the export menu", () => {
    const exported = () => {
        const handler = exportMenu.slice(exportMenu.indexOf("const handleExport"));

        return handler.slice(0, handler.indexOf("\n    };"));
    };

    /*
     * And it cannot hand it back in the same breath, because the same call
     * disables the button it would hand it to.
     *
     * `disabled={exporting}` is set in the very commit this would focus in, and
     * a disabled control is not a focusable area: the browser's focus fixup rule
     * takes focus off it and puts it on the viewport. Focusing the trigger and
     * disabling it together is exactly as good as never focusing it - the
     * reader still ends on <body> - so what is recorded here is the debt, and it
     * is paid when the button can hold focus again.
     */
    it("does not hand focus to the button it is about to disable", () => {
        assert.doesNotMatch(exported(), /buttonRef\.current\?\.focus\(\)/,
            "focus is placed on the trigger in the commit that disables it, and the browser drops it straight to the document");
    });

    // Not on a click outside, where focus belongs to whatever was clicked.
    it("only takes the debt on when the menu is the thing that had focus", () => {
        assert.match(exported(),
            /dropdownRef\.current\?\.contains\(document\.activeElement\)\)\s*owedFocus\.current = true/,
            "focus is pulled to the trigger even when the menu never held it");
    });

    // The export is what disables it, so the export ending is what re-enables
    // it - and nothing before that can give focus back.
    it("pays it when the export is over", () => {
        const effect = exportMenu.slice(exportMenu.indexOf("useEffect("));
        const closed = effect.indexOf("}, [");

        assert.match(effect.slice(0, closed), /!exporting/,
            "nothing waits for the button to be enabled again");
        assert.match(effect.slice(0, closed), /returnFocusToTrigger\(\)/,
            "the debt is recorded and never paid, so the reader is left on the document");
        assert.match(effect.slice(closed), /^}, \[exporting\b/,
            "the effect does not run when the export ends, so the trigger never gets its focus back");
    });

    /**
     * And Escape gets out of it, which is what every other menu here does.
     *
     * The settings menu, the context menu, the date picker and the create menu
     * all dismiss on Escape and hand focus back to what opened them. This one
     * had nothing: a reader who opened it and did not want either format could
     * only Tab past both of them or reach for the pointer. Reachable at all
     * because this branch made the two formats answer a keyboard - before it,
     * opening the menu was as far as anyone got.
     */
    describe("Escape", () => {
        const open = (isOpen = true) => {
            const state = {open: isOpen, focused: false};
            const press = handlerIn(exportMenu, "const handleMenuKey", {
                isOpen,
                setIsOpen: (value) => state.open = value,
                buttonRef: {current: {focus: () => state.focused = true}}
            });

            return {press, state};
        };

        it("closes the menu and gives focus back", () => {
            const {press, state} = open();
            const event = keyPress("Escape");

            press(event);

            assert.equal(state.open, false, "the menu stays open, with no way out but the pointer");
            assert.equal(state.focused, true, "focus is left on an option that is about to be unmounted");
            assert.equal(event.defaultPrevented, true);
        });

        // The trigger is in the toolbar, not in an overlay, but claiming a key
        // nothing was pressed against is how the create menu came to swallow the
        // one that dismisses the dialog around it.
        it("leaves the key alone when the menu is closed", () => {
            const {press, state} = open(false);
            const event = keyPress("Escape");

            press(event);

            assert.equal(event.defaultPrevented, false, "the trigger claims a key with no menu to dismiss");
            assert.equal(state.focused, false);
        });

        it("leaves every other key alone", () => {
            const {press, state} = open();

            for (const key of ["Enter", " ", "Tab", "ArrowDown", "Esc"]) press(keyPress(key));

            assert.equal(state.open, true);
        });

        // A handler nothing calls is not a handler. The container is where it
        // goes rather than the menu, because the menu is only mounted while it
        // is open and the trigger is what focus is on when it is not.
        it("is held by the element that wraps the trigger and the menu", () => {
            assert.match(tagHolding(exportMenu, "export-button-container"), /onKeyDown={handleMenuKey}/,
                "the key handler is never reached, so Escape does nothing at all");
        });
    });

    /*
     * Run rather than read, which is the shape the menus above use: what is
     * wrong with a debt is what happens when it is settled.
     */
    describe("settling it", () => {
        const paying = (owed) => {
            const state = {focused: 0};
            const owedFocus = {current: owed};
            const pay = handlerIn(exportMenu, "const returnFocusToTrigger", {
                owedFocus,
                buttonRef: {current: {focus: () => state.focused++}}
            });

            return {pay, state, owedFocus};
        };

        it("puts focus back on the trigger", () => {
            const {pay, state} = paying(true);

            pay();

            assert.equal(state.focused, 1, "the trigger is never given the focus the menu took off the page");
        });

        it("leaves focus alone when the menu never had it", () => {
            const {pay, state} = paying(false);

            pay();

            assert.equal(state.focused, 0, "focus is pulled to the trigger out of whatever else was holding it");
        });

        // Every later export, and every render between them, runs this again.
        it("settles it once", () => {
            const {pay, state} = paying(true);

            pay();
            pay();

            assert.equal(state.focused, 1, "focus is dragged back to the trigger long after the export it belonged to");
        });
    });
});

/**
 * And the date picker, which closes over its own focus in three different ways.
 *
 * The popover is rendered only while it is open, so every path that closes it
 * unmounts whatever holds focus: Escape and the trigger toggle both run
 * closePicker, a preset button closes it from inside itself, and so does the
 * second click of a day range. Each leaves focus on <body>.
 *
 * All three are reachable only because this branch made the trigger and the
 * presets answer a keyboard at all - before it, the popover could not be opened
 * without a pointer, and a pointer has no focus to lose. Escape is the one that
 * matters most: returning focus to the trigger is the whole of what a
 * disclosure owes when it is dismissed.
 */
describe("the date range picker's focus on close", () => {
    const returning = () => {
        const at = datePicker.indexOf("const returnFocusToTrigger");

        assert.notEqual(at, -1,
            "nothing puts focus back on the trigger, so every way of closing the popover drops it to the document");

        return datePicker.slice(at, datePicker.indexOf("\n    }", at));
    };

    it("only takes focus back when the popover is what had it", () => {
        assert.match(returning(), /popoverRef\.current\?\.contains\(document\.activeElement\)/,
            "focus is pulled to the trigger even when the popover never held it");
    });

    for (const [what, marker] of [
        ["dismissed with Escape", "const closePicker"],
        ["a preset is chosen", "onTimeframeChange(preset.id)"],
        ["a day range is completed", "onChange(finalFrom, finalTo)"]
    ]) {
        it(`gives focus back when ${what}`, () => {
            const at = datePicker.indexOf(marker);
            assert.notEqual(at, -1, `${marker} is no longer in this component`);

            const window = datePicker.slice(at, at + 400);

            assert.match(window, /returnFocusToTrigger\(\)/,
                `closing after ${what} leaves focus on a control that has been unmounted`);
        });
    }
});

/**
 * And the calendar's forward arrows, which disable the button under the finger.
 *
 * Both of them carry `disabled={isCurrentMonthView()}`, and the way to reach
 * that view is to press one: stepping forward from the month before the current
 * one disables the very control that was just activated. Chrome fires nothing
 * when a focused element is disabled - focus becomes <body> in silence, and
 * re-enabling it later does not bring it back - so the reader is dropped out of
 * an open popover with the next Tab at the top of the document.
 *
 * Reachable because this branch made the popover openable without a pointer at
 * all. The step back is where focus goes, because at the boundary it is the only
 * direction left.
 */
describe("the calendar's step into the current month", () => {
    const stepping = ({stepped = true, atBoundary = true, focus = "body"} = {}) => {
        const body = {name: "body"};
        const state = {focused: 0};
        const steppedForward = {current: stepped};

        const recover = handlerIn(datePicker, "const recoverFromDisabledStep", {
            steppedForward,
            isCurrentMonthView: () => atBoundary,
            prevMonthRef: {current: {focus: () => state.focused++}},
            document: {body, activeElement: focus === "body" ? body : {name: focus}}
        });

        return {recover, state, steppedForward};
    };

    it("puts focus on the step back", () => {
        const {recover, state} = stepping();

        recover();

        assert.equal(state.focused, 1, "the arrow disables itself and leaves the reader on the document");
    });

    it("leaves it alone short of the boundary", () => {
        const {recover, state} = stepping({atBoundary: false});

        recover();

        assert.equal(state.focused, 0, "focus is moved off an arrow that is still there to press again");
    });

    // A render the arrows had nothing to do with - a new range, a resize - must
    // not pull focus into the calendar.
    it("leaves it alone when no arrow was pressed", () => {
        const {recover, state} = stepping({stepped: false});

        recover();

        assert.equal(state.focused, 0, "any render at the boundary drags focus into the calendar");
    });

    // Safari does not focus a button that is clicked, so the step never had
    // focus to lose and there is nothing to give back.
    it("leaves it alone when focus was never dropped", () => {
        const {recover, state} = stepping({focus: "somewhere else"});

        recover();

        assert.equal(state.focused, 0, "focus is taken from whatever else was holding it");
    });

    it("answers one step, not every render after it", () => {
        const {recover, state, steppedForward} = stepping();

        recover();
        recover();

        assert.equal(steppedForward.current, false);
        assert.equal(state.focused, 1, "focus is dragged back to the arrow on every later render");
    });

    // Named with their parameter list, because the month arithmetic inside
    // calendarDays holds locals of the same two names.
    for (const arrow of ["const nextMonth = () =>", "const nextYear = () =>"]) {
        it(`is recorded when ${arrow.split(" ")[1]} steps`, () => {
            const at = datePicker.indexOf(arrow);
            assert.notEqual(at, -1, `${arrow} is no longer in this component`);

            assert.match(datePicker.slice(at, at + 200), /steppedForward\.current = true/,
                "a step that disables the arrow it was made on says nothing about it");
        });
    }
});

/**
 * The create-integration menu, which the modal focus trap had shut out.
 *
 * DropdownSelect portals its menu to the body - it has to, because the dialog it
 * opens inside carries a backdrop-filter and that makes the dialog a containing
 * block for anything positioned fixed inside it. So the menu is a sibling of the
 * backdrop, not a descendant of the dialog.
 *
 * The trap added on this branch reads the DOM by containment, so the menu is
 * "outside": Tab wraps within the dialog and never reaches it, and focus that
 * does land there is treated as an escape and pulled back. This is the only way
 * to add an integration at all, so a keyboard could open the menu and then had
 * nothing to press - the same shape as the export menu's own bug, reintroduced
 * from the other direction.
 *
 * Focus is placed in the menu when it opens, rather than tabbed into, which is
 * how a menu behaves anyway.
 */
describe("the integration create menu inside a dialog", () => {
    it("says its menu belongs to the overlay that opened it", () => {
        assert.match(dropdown, /data-overlay-portal/,
            "the trap reads the portalled menu as the page behind the dialog and recovers focus out of it");
    });

    /**
     * The effect that seats focus, from `useLayoutEffect` to its dependencies.
     */
    const seating = () => {
        const at = dropdown.search(/menuRef\.current\?\.querySelector\([^)]*\)\?\.focus\(\)/);

        assert.notEqual(at, -1, "the menu can only be reached by a Tab the dialog's trap will not allow");

        const opened = dropdown.lastIndexOf("useLayoutEffect(", at);
        assert.notEqual(opened, -1, "focus is placed by nothing that says when it runs");

        return dropdown.slice(opened, dropdown.indexOf("]", at) + 1);
    };

    it("puts focus in the menu when it opens", () => {
        assert.match(seating(), /if \(!isOpen\) return;/,
            "focus is placed by an effect that does not first ask whether the menu is open");
    });

    /*
     * And only then.
     *
     * The effect that positions the menu depends on `items` as well, because a
     * different set of options is a different height. Seating focus from the
     * same effect borrows that dependency - and the array is built inline by the
     * dialog above, so it is a new one on every render of that dialog. Any of
     * them while the menu is open drags focus back to the first option, out of
     * whichever one the reader had moved to.
     */
    it("seats it when the menu opens and not on every change to the options", () => {
        assert.match(seating(), /}, \[isOpen]$/,
            "the effect that seats focus runs again whenever the dialog above it re-renders");
    });

    /*
     * Run rather than read, which is the shape the Escape case above uses: the
     * assertion is then about what the handler does, not how it is spelled.
     */
    it("gives focus back to its button when an item is chosen", () => {
        const state = {open: true, focused: false, selected: null};
        const choose = handlerIn(dropdown, "const handleSelect", {
            onSelect: (item) => state.selected = item,
            setIsOpen: (value) => state.open = value,
            containerRef: {current: {querySelector: () => ({focus: () => state.focused = true})}}
        });

        choose("discord");

        assert.equal(state.selected, "discord", "the chosen item is no longer passed on");
        assert.equal(state.open, false, "the menu stays open after a choice");
        assert.equal(state.focused, true,
            "choosing an item unmounts the focused option and drops focus to the document");
    });
});

/**
 * And the first integration added, which unmounts the button it was added from.
 *
 * Handing focus back to its own trigger is enough for the menu every time but
 * the first. Adding the first integration takes the dialog out of its empty
 * state, and the two branches hold two different DropdownSelects - so the button
 * the menu has just focused is removed in the same commit that draws its
 * replacement.
 *
 * Nothing catches that. Chrome fires no event at all when a focused element is
 * removed: focus becomes <body> in silence, so the modal trap's recovery, which
 * is a focusout listener, never hears it. The one person this whole menu exists
 * for - somebody adding their first integration without a mouse - is left behind
 * the backdrop with the next Tab at the top of the document.
 */
describe("the first integration added", () => {
    const adding = (holding) => {
        const owedFocus = {current: false};
        const state = {active: null};
        const add = handlerIn(integrationDialog, "const addIntegration", {
            owedFocus,
            renderable: new Array(holding).fill({}),
            active: [],
            setActive: (value) => state.active = value,
            uuid: () => "an-id"
        });

        return {add, owedFocus, state};
    };

    it("still adds the integration", () => {
        const {add, state} = adding(0);

        add({key: "discord"});

        assert.deepEqual(state.active, [{uuid: "an-id", name: "discord", data: {}, isNew: true}]);
    });

    it("records that the menu is owed its focus back", () => {
        const {add, owedFocus} = adding(0);

        add({key: "discord"});

        assert.equal(owedFocus.current, true,
            "the button focus was just handed to is unmounted, and nothing puts it anywhere else");
    });

    // Every later one keeps the same menu on the page, and DropdownSelect has
    // already given focus back to the trigger that survived.
    it("leaves focus alone when the menu will still be there", () => {
        const {add, owedFocus} = adding(2);

        add({key: "discord"});

        assert.equal(owedFocus.current, false,
            "focus is moved a second time on an add that never disturbed it");
    });

    // The same control in its new place, so the first add ends where every
    // later one does.
    it("puts focus on the create menu once it has been redrawn", () => {
        const paid = integrationDialog.indexOf("owedFocus.current = false;");
        assert.notEqual(paid, -1, "nothing pays the debt, so the reader is left on the document");

        // A layout effect, so it settles before the trap's own watcher is
        // delivered - see the comment there.
        const effect = integrationDialog.slice(integrationDialog.lastIndexOf("useLayoutEffect(", paid));

        assert.match(effect.slice(0, effect.indexOf("}, [")),
            /wrapperRef\.current\?\.querySelector\("\.dropdown-select-btn"\)\?\.focus\(\)/,
            "the debt is paid to something other than the menu the choice was made in");
        assert.match(effect.slice(effect.indexOf("}, [")), /^}, \[renderable\.length]/,
            "the effect does not run when the dialog leaves its empty state, which is the only moment this happens");
    });
});
