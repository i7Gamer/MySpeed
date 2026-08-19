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

/**
 * One mounted component, holding the ref across every render.
 *
 * The ref has to be stable, because it is a dependency of the trap effect: both
 * real callers hold theirs in a useRef, and a fresh `{current: dialog}` per
 * render makes the dependency list compare unequal every time. The effect then
 * re-runs whatever else changed, so `holdsFocus` decides nothing and the whole
 * stacked-alert suite passes with it removed from the dependencies.
 */
const modal = (dialog, options) => {
    const ref = {current: dialog};
    const component = new Component();
    const render = (extra) => component.render(() => useModalFocus(ref, {...options, ...extra}));

    render();

    return {component, render, ref};
};

describe("an overlay taking and giving back focus", () => {
    beforeEach(() => resetWorld());

    it("opens on the first real control, never on its close button", () => {
        const dialog = overlay();
        mount(dialog.area);

        modal(dialog.dialog, {open: true});

        assert.equal(activeName(), "field",
            "the header comes first, so the first focusable is the X - opening there closes the dialog on Enter");
    });

    it("gives focus back to the control that opened it", () => {
        const gear = mount(element("button", {name: "gear"}));
        gear.focus();
        const dialog = overlay();
        mount(dialog.area);

        const {component} = modal(dialog.dialog, {open: true});
        assert.equal(activeName(), "field");

        component.unmount();
        assert.equal(activeName(), "gear");
    });

    it("does not put focus on a control the overlay has removed", () => {
        const row = mount(element("button", {name: "deletedRow"}));
        row.focus();
        const dialog = overlay();
        mount(dialog.area);

        const {component} = modal(dialog.dialog, {open: true});
        row.remove();
        component.unmount();

        assert.notEqual(activeName(), "deletedRow");
    });

    it("takes the close button only when it is the one control there", () => {
        const dialog = overlay({fields: [], buttons: []});
        mount(dialog.area);

        modal(dialog.dialog, {open: true});

        assert.equal(activeName(), "closeX");
    });

    it("falls back to the dialog itself when nothing inside can be focused", () => {
        const dialog = overlay({dismiss: false, fields: [], buttons: []});
        mount(dialog.area);

        modal(dialog.dialog, {open: true});

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

        modal(dialog, {open: true});

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

        modal(alert.dialog, {open: true, initialFocus: {current: alert.get("submit")}, restoreTo: opener});

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

        const {component} = modal(alert.dialog,
            {open: true, initialFocus: {current: alert.get("submit")}, restoreTo: opener});
        component.unmount();

        assert.equal(activeName(), "opener");
    });

    it("opens a confirmation on the button that confirms it", () => {
        const alert = overlay({fields: [], buttons: ["cancel", "confirm"]});
        mount(alert.area);

        modal(alert.dialog, {open: true, holdsFocus: true, initialFocus: {current: alert.get("confirm")}});

        assert.equal(activeName(), "confirm",
            "seated anywhere else, Enter answers the confirmation with whatever holds focus");
    });
});

describe("the tab trap", () => {
    beforeEach(() => resetWorld());

    it("wraps at both ends and leaves the middle to the browser", () => {
        const dialog = overlay({fields: ["a", "b"], buttons: ["ok"]});
        mount(dialog.area);
        modal(dialog.dialog, {open: true});

        dialog.get("ok").focus();
        dialog.get("ok").press("Tab");
        assert.equal(activeName(), "closeX", "Tab off the last control does not wrap to the first");

        dialog.get("closeX").press("Tab", {shiftKey: true});
        assert.equal(activeName(), "ok", "Shift+Tab off the first control does not wrap to the last");

        /*
         * That focus has not moved, rather than that this control was not
         * focused again: a trap which wrongly claimed the key would move focus
         * somewhere else entirely, and leave this control's own count alone.
         */
        const middle = dialog.get("a");
        middle.focus();
        middle.press("Tab");

        assert.equal(activeName(), "a",
            "a Tab in the middle was claimed, which means re-implementing tab order rather than closing it");
    });

    /**
     * And whether the key was claimed, which is not the same question.
     *
     * Where the trap wraps, the browser must not also act on the key or focus
     * moves twice. Where it declines, the key has to reach the browser at all -
     * a trap that called preventDefault and then returned would leave focus
     * where it was, exactly as a correct one does, while making Tab dead in the
     * middle of every dialog in the app.
     */
    it("claims the key only where it moves focus", () => {
        const dialog = overlay({fields: ["a", "b"], buttons: ["ok"]});
        mount(dialog.area);
        modal(dialog.dialog, {open: true});

        dialog.get("ok").focus();
        assert.equal(dialog.get("ok").press("Tab").defaultPrevented, true,
            "the browser is left to act on a Tab the trap has already answered, so focus moves twice");

        const middle = dialog.get("a");
        middle.focus();
        assert.equal(middle.press("Tab").defaultPrevented, false,
            "Tab is claimed in the middle of the dialog, so a reader can never leave the control it opened on");
    });

    /**
     * And the listeners come off again.
     *
     * An alert that is stacked over gives up the trap and takes it back when the
     * one above closes. Without the detach, it holds the old set and attaches a
     * second - and a later focusout then schedules two recoveries while the
     * effect tracks only the newer, so the cleanup clears one and the other
     * fires into a dialog that has closed.
     */
    it("detaches them when it gives up its turn", () => {
        const dialog = overlay({fields: [], buttons: ["ok", "other"]});
        mount(dialog.area);
        const {render} = modal(dialog.dialog, {open: true, holdsFocus: true});

        render({holdsFocus: false});
        render({holdsFocus: true});

        ["keydown", "focusin", "focusout"].forEach((type) =>
            assert.equal(dialog.dialog.listeners[type].length, 1,
                `${type} is attached ${dialog.dialog.listeners[type].length} times over`));
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
        modal(dialog.dialog, {open: true});

        dialog.get("field").blurToBody();
        assert.equal(activeName(), "body");

        await settle();
        assert.equal(activeName(), "field");
    });

    it("is left alone when it lands in an overlay opened above", async () => {
        const below = overlay();
        mount(below.area);
        modal(below.dialog, {open: true});

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

        const {component} = modal(dialog.dialog, {open: true});
        component.unmount();
        assert.equal(activeName(), "opener");

        await settle();
        assert.equal(activeName(), "opener");
    });

    /**
     * Both halves of the recovery's own re-check, which is made a turn after the
     * focusout because focus is still settling during one.
     */
    it("leaves a dialog that has been taken off the page alone", async () => {
        const dialog = overlay();
        mount(dialog.area);
        modal(dialog.dialog, {open: true});

        dialog.get("field").blurToBody();          // schedules the recovery
        dialog.area.remove();                      // and the overlay goes before it runs

        await settle();
        assert.equal(activeName(), "body",
            "focus was seated into a dialog that is no longer in the document");
    });

    it("leaves focus where the reader has already put it back", async () => {
        const dialog = overlay({fields: ["field"], buttons: ["ok"]});
        mount(dialog.area);
        modal(dialog.dialog, {open: true});

        dialog.get("field").blurToBody();          // schedules the recovery
        dialog.get("ok").focus();                  // and the reader clicks back in first

        await settle();
        assert.equal(activeName(), "ok",
            "the recovery moved focus off the control the reader had just chosen");
    });
});

describe("two alerts stacked", () => {
    beforeEach(() => resetWorld());

    it("keeps focus in the stack, and hands it back where the reader left it", async () => {
        const pageButton = mount(element("button", {name: "pageButton"}));
        pageButton.focus();

        const lower = overlay({fields: [], buttons: ["lowerOk", "lowerAlt"]});
        mount(lower.area);
        const {render: renderLower} = modal(lower.dialog, {
            open: true, holdsFocus: true,
            initialFocus: {current: lower.get("lowerOk")}, restoreTo: pageButton
        });

        assert.equal(activeName(), "lowerOk");

        lower.get("lowerAlt").focus();
        renderLower({holdsFocus: false});
        assert.equal(activeName(), "lowerAlt",
            "stacking a second alert handed focus back to the page, under two backdrops");

        const upper = overlay({fields: [], buttons: ["upperOk"]});
        mount(upper.area);
        const goneByNow = mount(element("button", {name: "deletedRow"}));
        const {component: upperComponent} = modal(upper.dialog, {
            open: true, holdsFocus: true,
            initialFocus: {current: upper.get("upperOk")}, restoreTo: goneByNow
        });
        assert.equal(activeName(), "upperOk");

        // The row it was confirming the deletion of is gone, so nothing restores
        // focus - which is the one state where the lower alert has to decide.
        goneByNow.remove();
        upperComponent.unmount();
        upper.area.remove();
        await settle();

        renderLower({holdsFocus: true});
        await settle();

        assert.equal(activeName(), "lowerAlt",
            "the alert underneath came back to its first control rather than to where the reader was");
    });
});
