import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    activeName, Component, element, mount, overlay, resetWorld, settle, useModalFocus
} from "../helpers/modalDom.js";

/**
 * The hook as it runs, rather than the judgements it is built from.
 *
 * modalFocus.test.js covers those judgements - which control Tab should land on,
 * whether focus has escaped - without a DOM at all. What it cannot reach is the
 * seam the hook's regressions have all been in: two effects, one keyed on being
 * open and one on holding focus, their cleanups, the order React runs them in,
 * and a recovery scheduled from a focusout. Every one of those bugs shipped past
 * a green suite, because nothing executed the hook.
 *
 * So these run it, against the fake DOM in the helper. Each case is a sequence a
 * reader can actually produce.
 */
describe("an overlay taking and giving back focus", () => {
    beforeEach(() => resetWorld());

    it("opens on the first real control, never on its close button", () => {
        const dialog = overlay();
        mount(dialog.area);

        new Component().render(() => useModalFocus({current: dialog.dialog}, {open: true}));

        assert.equal(activeName(), "field",
            "the header comes first, so the first focusable is the X - opening there closes the dialog on Enter");
    });

    it("gives focus back to the control that opened it", () => {
        const gear = mount(element("button", {name: "gear"}));
        gear.focus();
        const dialog = overlay();
        mount(dialog.area);

        const component = new Component().render(() => useModalFocus({current: dialog.dialog}, {open: true}));
        assert.equal(activeName(), "field");

        component.unmount();
        assert.equal(activeName(), "gear");
    });

    it("does not put focus on a control the overlay has removed", () => {
        const row = mount(element("button", {name: "deletedRow"}));
        row.focus();
        const dialog = overlay();
        mount(dialog.area);

        const component = new Component().render(() => useModalFocus({current: dialog.dialog}, {open: true}));
        row.remove();
        component.unmount();

        assert.notEqual(activeName(), "deletedRow");
    });

    it("takes the close button only when it is the one control there", () => {
        const dialog = overlay({fields: [], buttons: []});
        mount(dialog.area);

        new Component().render(() => useModalFocus({current: dialog.dialog}, {open: true}));

        assert.equal(activeName(), "closeX");
    });

    it("falls back to the dialog itself when nothing inside can be focused", () => {
        const dialog = overlay({dismiss: false, fields: [], buttons: []});
        mount(dialog.area);

        new Component().render(() => useModalFocus({current: dialog.dialog}, {open: true}));

        assert.equal(activeName(), "dialog");
    });

    it("skips a disabled control and one hidden from a reader", () => {
        const area = element("div", {class: "dialog-area"});
        const dialog = element("div", {class: "dialog", tabindex: "-1", name: "dialog"});
        dialog.append(
            element("button", {name: "hidden", "aria-hidden": "true"}),
            element("button", {name: "off", disabled: true}),
            element("button", {name: "real"})
        );
        mount(area.append(dialog));

        new Component().render(() => useModalFocus({current: dialog}, {open: true}));

        assert.equal(activeName(), "real");
    });
});

describe("an alert that autofocuses its own field", () => {
    beforeEach(() => resetWorld());

    /*
     * React applies autoFocus during the commit, which is before a passive
     * effect runs - so by the time the hook looks, focus is already in the
     * field. Moving it to a button would put the caret nowhere.
     */
    it("leaves the caret where React put it", () => {
        const opener = mount(element("button", {name: "opener"}));
        opener.focus();
        const alert = overlay({fields: ["textbox"], buttons: ["cancel", "submit"]});
        mount(alert.area);
        alert.get("textbox").focus();

        new Component().render(() => useModalFocus({current: alert.dialog}, {
            open: true, initialFocus: {current: alert.get("submit")}, restoreTo: opener
        }));

        assert.equal(activeName(), "textbox");
    });

    /*
     * And restores to what the alert recorded, not to what was focused when the
     * effect ran - which is the field it is about to unmount.
     */
    it("restores to the control it was opened from, not to its own field", () => {
        const opener = mount(element("button", {name: "opener"}));
        opener.focus();
        const alert = overlay({fields: ["textbox"], buttons: ["submit"]});
        mount(alert.area);
        alert.get("textbox").focus();

        const component = new Component().render(() => useModalFocus({current: alert.dialog}, {
            open: true, initialFocus: {current: alert.get("submit")}, restoreTo: opener
        }));
        component.unmount();

        assert.equal(activeName(), "opener");
    });

    it("opens a confirmation on the button that confirms it", () => {
        const alert = overlay({fields: [], buttons: ["cancel", "confirm"]});
        mount(alert.area);

        new Component().render(() => useModalFocus({current: alert.dialog}, {
            open: true, holdsFocus: true, initialFocus: {current: alert.get("confirm")}
        }));

        assert.equal(activeName(), "confirm",
            "seated anywhere else, Enter answers the confirmation with whatever holds focus");
    });
});

describe("the tab trap", () => {
    beforeEach(() => resetWorld());

    it("wraps at both ends and leaves the middle to the browser", () => {
        const dialog = overlay({fields: ["a", "b"], buttons: ["ok"]});
        mount(dialog.area);
        new Component().render(() => useModalFocus({current: dialog.dialog}, {open: true}));

        dialog.get("ok").focus();
        dialog.get("ok").press("Tab");
        assert.equal(activeName(), "closeX", "Tab off the last control does not wrap to the first");

        dialog.get("closeX").press("Tab", {shiftKey: true});
        assert.equal(activeName(), "ok", "Shift+Tab off the first control does not wrap to the last");

        /*
         * That focus has not moved, rather than that this control was not
         * focused again: a trap which wrongly claimed the key would move focus
         * somewhere else entirely, and leave this control's own count alone
         * while doing it.
         */
        const middle = dialog.get("a");
        middle.focus();
        middle.press("Tab");

        assert.equal(activeName(), "a",
            "a Tab in the middle was claimed, which means re-implementing tab order rather than closing it");
    });
});

describe("focus that leaves without a key being pressed", () => {
    beforeEach(() => resetWorld());

    /*
     * The trap listens on the dialog, so it hears nothing once focus is out. A
     * mousedown on the backdrop blurs to the body, and on the welcome wizard -
     * no backdrop dismissal, no Escape - that state was permanent.
     */
    it("is brought back when it lands on the page", async () => {
        const dialog = overlay();
        mount(dialog.area);
        new Component().render(() => useModalFocus({current: dialog.dialog}, {open: true}));

        dialog.get("field").blurToBody();
        assert.equal(activeName(), "body");

        await settle();
        assert.equal(activeName(), "field");
    });

    it("is left alone when it lands in an overlay opened above", async () => {
        const below = overlay();
        mount(below.area);
        new Component().render(() => useModalFocus({current: below.dialog}, {open: true}));

        const above = overlay({fields: ["upperField"]});
        mount(above.area);
        above.get("upperField").focus();

        await settle();
        assert.equal(activeName(), "upperField",
            "the overlay underneath pulled focus back out of the one above it");
    });

    /*
     * The restore runs while the trap's listeners are still attached, so it
     * schedules a recovery on its way out. The trap's own cleanup has to clear
     * it, or focus is dragged back into a dialog that has gone.
     */
    it("does not drag focus back into an overlay that has closed", async () => {
        const opener = mount(element("button", {name: "opener"}));
        opener.focus();
        const dialog = overlay();
        mount(dialog.area);

        const component = new Component().render(() => useModalFocus({current: dialog.dialog}, {open: true}));
        component.unmount();
        assert.equal(activeName(), "opener");

        await settle();
        assert.equal(activeName(), "opener");
    });
});

describe("two alerts stacked", () => {
    beforeEach(() => resetWorld());

    it("keeps focus in the stack, and hands it back where the reader left it", async () => {
        const pageButton = mount(element("button", {name: "pageButton"}));
        pageButton.focus();

        const lower = overlay({fields: [], buttons: ["lowerOk", "lowerAlt"]});
        mount(lower.area);
        const lowerComponent = new Component();
        const renderLower = (isTop) => lowerComponent.render(() => useModalFocus({current: lower.dialog}, {
            open: true, holdsFocus: isTop,
            initialFocus: {current: lower.get("lowerOk")}, restoreTo: pageButton
        }));

        renderLower(true);
        assert.equal(activeName(), "lowerOk");

        lower.get("lowerAlt").focus();
        renderLower(false);
        assert.equal(activeName(), "lowerAlt",
            "stacking a second alert handed focus back to the page, under two backdrops");

        const upper = overlay({fields: [], buttons: ["upperOk"]});
        mount(upper.area);
        const goneByNow = mount(element("button", {name: "deletedRow"}));
        const upperComponent = new Component().render(() => useModalFocus({current: upper.dialog}, {
            open: true, holdsFocus: true,
            initialFocus: {current: upper.get("upperOk")}, restoreTo: goneByNow
        }));
        assert.equal(activeName(), "upperOk");

        // The row it was confirming the deletion of is gone, so nothing restores
        // focus - which is the one state where the lower alert has to decide.
        goneByNow.remove();
        upperComponent.unmount();
        upper.area.remove();
        await settle();

        renderLower(true);
        await settle();

        assert.equal(activeName(), "lowerAlt",
            "the alert underneath came back to its first control rather than to where the reader was");
    });
});
