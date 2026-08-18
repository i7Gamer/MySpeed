import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { focusableWithin, nextFocus } from "../../client/src/common/hooks/useModalFocus.js";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const read = (file) => fs.readFileSync(path.join(CLIENT_SRC, file), "utf8");

/**
 * Stand-ins for DOM nodes. querySelectorAll and the two attributes the filter
 * reads are the whole of the DOM this judgement touches, which is why it is
 * exported apart from the hook - the same split useClickOutside makes.
 */
const control = (attributes = {}) => ({
    ...attributes,
    getAttribute: (name) => attributes[name] ?? null
});

const container = (...children) => ({querySelectorAll: () => children});

describe("focusableWithin", () => {
    it("lists the controls a Tab would visit", () => {
        const ok = control(), cancel = control();

        assert.deepEqual(focusableWithin(container(ok, cancel)), [ok, cancel]);
    });

    // A disabled button is skipped by the browser's own Tab, so a trap that
    // counted it would wrap onto an element focus never lands on.
    it("skips a disabled control", () => {
        const ok = control();

        assert.deepEqual(focusableWithin(container(control({disabled: true}), ok)), [ok]);
    });

    it("skips one hidden from assistive technology", () => {
        const ok = control();

        assert.deepEqual(focusableWithin(container(control({"aria-hidden": "true"}), ok)), [ok]);
    });

    it("answers empty for nothing mounted", () => {
        assert.deepEqual(focusableWithin(null), []);
        assert.deepEqual(focusableWithin(undefined), []);
    });
});

/**
 * Where Tab should land, decided apart from the DOM that will act on it.
 *
 * Returning null rather than an element is the case that matters most: a Tab in
 * the middle of the dialog is the browser's own to answer, and claiming it would
 * mean re-implementing tab order rather than closing it into a loop.
 */
describe("nextFocus", () => {
    const first = control(), middle = control(), last = control();
    const dialog = container(first, middle, last);

    it("wraps forward from the last control", () => {
        assert.equal(nextFocus(dialog, {shiftKey: false}, last), first);
    });

    it("wraps backward from the first", () => {
        assert.equal(nextFocus(dialog, {shiftKey: true}, first), last);
    });

    it("leaves a Tab in the middle to the browser", () => {
        assert.equal(nextFocus(dialog, {shiftKey: false}, first), null);
        assert.equal(nextFocus(dialog, {shiftKey: true}, last), null);
        assert.equal(nextFocus(dialog, {shiftKey: false}, middle), null);
    });

    /**
     * Focus that is not on any of them is focus that has left the dialog - or
     * has never been in it, which is the state the overlay opens in when the
     * control that opened it stays focused behind the backdrop.
     */
    it("pulls focus back in when it is outside", () => {
        assert.equal(nextFocus(dialog, {shiftKey: false}, control()), first);
        assert.equal(nextFocus(dialog, {shiftKey: true}, control()), last);
    });

    // A dialog with nothing focusable in it still must not hand the page
    // behind it back to Tab, so the dialog itself takes the key.
    it("falls back to the dialog when nothing in it is focusable", () => {
        const empty = container();

        assert.equal(nextFocus(empty, {shiftKey: false}, control()), empty);
    });
});

/**
 * Both overlays, held to the same rules.
 *
 * Neither told assistive technology that a modal had opened, neither moved
 * focus into it, neither kept Tab inside it, and neither put focus back where it
 * came from on close. Opening a settings dialog from the header gear left focus
 * on the gear: nothing was announced, Tab walked the whole page underneath
 * before reaching the dialog, and closing it dropped focus to the top of the
 * document.
 *
 * A source scan for the markup, like the other rendering rules here - node
 * cannot parse JSX - and the judgement above is tested directly.
 */
describe("the overlays announce themselves and hold focus", () => {
    const OVERLAYS = [
        {what: "the dialog", file: "common/contexts/Dialog/DialogContext.jsx"},
        {what: "an alert", file: "common/contexts/Alert/AlertContext.jsx"}
    ];

    for (const {what, file} of OVERLAYS) {
        const source = read(file);

        it(`announces ${what} as a modal`, () => {
            assert.match(source, /role="dialog"/,
                `${what} is announced as a plain group of elements`);
            assert.match(source, /aria-modal="true"/,
                `${what} does not tell a screen reader the page behind it is inert`);
        });

        // Focus has to be able to land on the dialog itself: it is where focus
        // goes when nothing inside it is focusable.
        it(`lets focus rest on ${what} itself`, () => {
            assert.match(source, /tabIndex=\{-1}/,
                `${what} cannot receive focus, so there is nowhere to put it on open`);
        });

        it(`keeps focus inside ${what} and gives it back`, () => {
            assert.match(source, /useModalFocus\(/,
                `${what} manages no focus at all: none on open, none trapped, none restored`);
        });

        /**
         * The close control was a bare FontAwesome svg carrying an onClick.
         * FontAwesome renders it aria-hidden, so it announced as nothing at
         * all, and an svg is not in the tab order - a reader was never told a
         * close control existed and had to know to press Escape.
         */
        it(`offers a real close control on ${what}`, () => {
            assert.match(source, /<button\s+type="button"[\s\S]{0,200}?aria-label=\{t\("dialog\.close"\)}/,
                `${what} closes from an unfocusable, unnamed glyph`);
        });
    }

    // The alert has its title to hand, so it says what it is; the dialog's
    // title is written by whoever renders the header, so it is wired by id.
    it("names the alert with its own title", () => {
        assert.match(read("common/contexts/Alert/AlertContext.jsx"), /aria-label=\{alert\.title}/,
            "an alert is announced as an unnamed dialog");
    });

    it("names the dialog with the heading its header draws", () => {
        const source = read("common/contexts/Dialog/DialogContext.jsx");

        assert.match(source, /aria-labelledby=/, "the dialog is announced as an unnamed dialog");
        assert.match(source, /useId\(/, "the label is wired by a fixed id, which repeats when two dialogs mount");
    });
});
