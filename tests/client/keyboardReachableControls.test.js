import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as sass from "sass";
import { clickable } from "@/common/utils/Clickable.js";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const read = (file) => fs.readFileSync(path.join(CLIENT_SRC, file), "utf8");

const pagination = read("common/components/Header/components/Pagination/Pagination.jsx");
const paginationStyles = read("common/components/Header/components/Pagination/styles.sass");
const dropdown = read("common/components/DropdownSelect/DropdownSelect.jsx");

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

// Every <button …> in a component says which kind it is, since a button left
// untyped defaults to submit. The same reason HelpButton gives.
const everyButtonIsTyped = (source, what) => {
    const opened = (source.match(/<button\b/g) ?? []).length;
    const typed = (source.match(/<button\s+type="button"/g) ?? []).length;

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

    const body = source.slice(source.indexOf("{", source.indexOf("=>", start)));
    const names = Object.keys(closure);

    return new Function(...names, `return (e) => ${body.slice(0, blockEnd(body, 0) + 1)};`)(
        ...names.map((name) => closure[name]));
};

const keyPress = (key) => ({
    key,
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

    describe("Escape", () => {
        const open = () => {
            const state = {open: true, focused: false};
            const press = handlerIn(dropdown, "const handleMenuKey", {
                setIsOpen: (value) => state.open = value,
                containerRef: {current: {querySelector: () => ({focus: () => state.focused = true})}}
            });

            return {press, state};
        };

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

        it("leaves every other key alone", () => {
            const {press, state} = open();

            for (const key of ["Enter", " ", "Tab", "ArrowDown", "Esc"]) press(keyPress(key));

            assert.equal(state.open, true);
        });
    });
});
