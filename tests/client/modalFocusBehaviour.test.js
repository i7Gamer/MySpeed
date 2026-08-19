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

/**
 * A popover the dialog opened and rendered outside itself.
 *
 * DropdownSelect portals its menu to the body, because the dialog it opens
 * inside carries a backdrop-filter - which makes that dialog a containing block
 * for anything positioned fixed within it, so a menu rendered in place would be
 * positioned against the dialog rather than the viewport.
 *
 * Everything this trap decides by containment therefore answers "outside" for a
 * control the reader has just deliberately opened. Left alone, the recovery
 * pulls focus straight back out of the menu, and the integration dialog's create
 * menu - the only way to add one at all - could be opened and then not used.
 */
describe("a portalled popover the overlay owns", () => {
    beforeEach(() => resetWorld());

    const withPortal = () => {
        const dialog = overlay();
        mount(dialog.area);

        const menu = element("div", {class: "dropdown-select-menu", "data-overlay-portal": ""});
        const option = element("button", {name: "menuOption"});
        mount(menu.append(option));

        return {dialog, option};
    };

    it("keeps focus that has moved into it", async () => {
        const {dialog, option} = withPortal();
        modal(dialog.dialog, {open: true});

        option.focus();
        await settle();

        assert.equal(activeName(), "menuOption",
            "the trap recovered focus out of a menu the dialog itself opened");
    });

    it("still recovers focus that lands on the page behind", async () => {
        const {dialog} = withPortal();
        modal(dialog.dialog, {open: true});

        dialog.get("field").blurToBody();
        await settle();

        assert.equal(activeName(), "field",
            "marking a popover as owned stopped the trap recovering from a real escape");
    });
});

/**
 * Focus taken off the page by a change nothing announces.
 *
 * Chrome fires no event when the focused element is removed from the document,
 * and none when it is disabled - measured in 148, not assumed. In both cases
 * focus becomes <body>, and enabling the control again does not bring it back.
 * So neither is reachable from a listener: focusout is the only thing the trap
 * had, and it never runs.
 *
 * That is not an edge. Every dialog in the app has a primary button that
 * disables itself while it saves - the storage retention save, the schedule, the
 * pause window, creating a node - so the commonest thing a reader does inside a
 * dialog is also the one that empties it of focus, behind a backdrop still
 * announcing aria-modal. The next Tab starts at the top of the document.
 *
 * Watched rather than listened for, because there is nothing to listen to.
 */
describe("an overlay whose control stops being one", () => {
    beforeEach(() => resetWorld());

    const saving = () => {
        const dialog = overlay({fields: ["field"], buttons: ["save"]});
        mount(dialog.area);

        return {...dialog, ...modal(dialog.dialog, {open: true})};
    };

    it("takes focus back when a control disables itself", async () => {
        const dialog = saving();
        const save = dialog.get("save");

        save.focus();
        save.setDisabled(true);
        await settle();

        assert.notEqual(activeName(), "body",
            "pressing save empties the dialog of focus and nothing puts it back");
        assert.equal(activeName(), "field", "focus did not come back to a control the reader can use");
    });

    // The seat a reader was last in is only a seat while it is still one.
    // Without this the recovery hands focus straight back to the button that
    // has just been disabled, where focus() is a silent no-op.
    it("does not hand it back to the control that was disabled", async () => {
        const dialog = saving();
        const save = dialog.get("save");

        dialog.get("field").focus();
        save.focus();
        save.setDisabled(true);
        await settle();

        assert.equal(activeName(), "field",
            "focus is offered to a disabled button, which cannot take it, and stays on the document");
    });

    it("takes focus back when a control removes itself", async () => {
        const dialog = saving();
        const save = dialog.get("save");

        save.focus();
        save.remove();
        await settle();

        assert.equal(activeName(), "field", "a control that unmounts itself leaves the reader on the document");
    });

    /*
     * Only the body. Focus that has properly moved - into a stacked alert, or
     * onto another control in this dialog - is not something to take back, and
     * that is what focusout already answers for.
     */
    it("leaves focus alone when it is somewhere real", async () => {
        const dialog = saving();

        dialog.get("save").focus();
        dialog.get("field").focus();
        dialog.get("save").setDisabled(true);
        await settle();

        assert.equal(activeName(), "field", "a change anywhere in the dialog drags focus back to its first control");
    });

    /*
     * Including somewhere outside the dialog it belongs to. The create menu is
     * portalled to the body, so a reader choosing an integration is out there
     * while the dialog behind them redraws its list - and every change to that
     * list is a mutation this watcher sees.
     */
    it("leaves focus alone when it is in a popover the overlay opened", async () => {
        const dialog = saving();

        const menu = element("div", {class: "dropdown-select-menu", "data-overlay-portal": ""});
        const option = element("button", {name: "menuOption"});
        mount(menu.append(option));

        option.focus();
        dialog.get("save").setDisabled(true);
        await settle();

        assert.equal(activeName(), "menuOption",
            "a redraw behind the menu pulls focus out of it, which is the trap's own bug from the other side");
    });

    /**
     * And a dialog under an alert does not take focus off it.
     *
     * A Dialog holds focus for as long as it is open - it has no idea an alert
     * has stacked over it - so both watchers are live at once, and a mutation
     * behind the alert arrives while focus is momentarily on the body. The
     * watcher is a microtask and the focusout recovery is a timeout, so the
     * dialog underneath does win the first move: what has to hold is that it
     * does not keep it.
     */
    it("does not leave focus under an alert stacked over it", async () => {
        const lower = overlay({fields: [], buttons: ["lowerOk", "lowerRow"]});
        mount(lower.area);
        modal(lower.dialog, {open: true});

        const upper = overlay({fields: [], buttons: ["upperOk"]});
        mount(upper.area);
        modal(upper.dialog, {open: true, initialFocus: {current: upper.get("upperOk")}});

        assert.equal(activeName(), "upperOk");

        // The alert loses focus to the backdrop, and the dialog behind it
        // redraws in the same turn.
        upper.get("upperOk").blurToBody();
        lower.get("lowerRow").remove();

        await settle();

        assert.equal(activeName(), "upperOk",
            "focus is left in the dialog underneath, behind the alert's own backdrop");
    });

    it("stops watching when the overlay closes", async () => {
        const dialog = saving();

        dialog.render({open: false});
        dialog.get("field").setDisabled(true);
        await settle();

        assert.equal(activeName(), "body",
            "a closed overlay still pulls focus back into itself whenever anything in it changes");
    });
});
