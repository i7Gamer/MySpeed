import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { useRef, useState } from "react";
import {
    act, cleanup, click, createElement, focus, focused, keydown, render, window
} from "../helpers/renderHarness.js";
import { useClickOutside } from "@/common/hooks/useClickOutside";
import { CompareSelect } from "@/pages/Statistics/components/CompareSelect/CompareSelect";
import { TimeField } from "@/common/components/TimeField/TimeField";
import { ContextMenu } from "@/common/components/ContextMenu/ContextMenu";
import { AlertProvider, useAlert } from "@/common/contexts/Alert";
import { Dialog } from "@/common/contexts/Dialog";
import { PreferencesContext } from "@/common/contexts/Preferences";

/**
 * The rest of the register's list, run rather than read: the click-outside
 * hook, the three menus the ghosts did not cover, and the two overlay systems'
 * round trips - an alert and a dialog each opened from a control, dismissed,
 * and expected to hand focus back to it.
 *
 * Every close in this app that animates waits for `animationend` before it
 * unmounts, and jsdom animates nothing, so the tests raise that event by hand
 * with the name the code listens for. That is the one place the harness
 * stands in for the browser rather than modelling it.
 */
afterEach(cleanup);

const press = (element) => {
    focus(element);
    click(element);
};

const mousedown = (element) => act(() => element.dispatchEvent(
    new window.MouseEvent("mousedown", {bubbles: true, cancelable: true})));

/** The end of a CSS animation the stylesheet would have run. */
const animationEnd = (element, animationName) => act(() => {
    const event = new window.Event("animationend", {bubbles: true});
    Object.defineProperty(event, "animationName", {value: animationName});
    element.dispatchEvent(event);
});

describe("useClickOutside", () => {
    const Probe = ({active, onOutside, ignore}) => {
        const ref = useRef(null);
        useClickOutside(active, [ref], onOutside, {ignore});

        return createElement("div", null,
            createElement("div", {id: "inside", ref}, createElement("span", {id: "deep"})),
            createElement("div", {id: "outside"}));
    };

    const mount = (props) => {
        const calls = [];
        const {container} = render(createElement(Probe, {active: true, onOutside: () => calls.push(1), ...props}));
        return {calls, at: (id) => container.querySelector(`#${id}`)};
    };

    it("reports a press outside the watched elements", () => {
        const {calls, at} = mount();

        mousedown(at("outside"));

        assert.equal(calls.length, 1);
    });

    it("stays quiet for a press anywhere inside them, however deep", () => {
        const {calls, at} = mount();

        mousedown(at("inside"));
        mousedown(at("deep"));

        assert.equal(calls.length, 0);
    });

    it("watches nothing while inactive", () => {
        const {calls, at} = mount({active: false});

        mousedown(at("outside"));

        assert.equal(calls.length, 0);
    });

    // The opener's own button is outside the menu and must not count: its
    // click would close and reopen in one go.
    it("lets the caller name what does not count as outside", () => {
        const {calls, at} = mount({ignore: (target) => target.id === "outside"});

        mousedown(at("outside"));

        assert.equal(calls.length, 0);
    });
});

describe("the compare menu giving focus back", () => {
    const mountOpen = () => {
        const chosen = [];
        const {container} = render(createElement(CompareSelect,
            {value: "previous", onChange: (choice) => chosen.push(choice)}));
        const trigger = container.querySelector(".compare-select-trigger");

        click(trigger);
        const options = [...container.querySelectorAll("[role=\"option\"]")];
        assert.ok(options.length >= 2, "the menu did not open with its choices");

        return {container, trigger, options, chosen};
    };

    it("returns to the trigger on Escape", () => {
        const {trigger, options} = mountOpen();

        focus(options[1]);
        keydown(options[1], "Escape");

        assert.ok(focused() === trigger, "Escape left the reader on the body");
    });

    it("returns to the trigger when a choice is made", () => {
        const {container, trigger, options, chosen} = mountOpen();

        press(options[1]);

        assert.equal(chosen.length, 1, "the choice was not applied");
        assert.ok(container.querySelector("[role=\"listbox\"]") === null, "the menu stayed open");
        assert.ok(focused() === trigger, "choosing left the reader on the body");
    });

    // Nothing on the outside-click path can move focus - the hook is handed a
    // bare setIsOpen(false) - so only the close is asserted.
    it("closes on a click outside", () => {
        const {container} = mountOpen();

        mousedown(window.document.body);

        assert.ok(container.querySelector("[role=\"listbox\"]") === null, "the menu stayed open");
    });
});

describe("the time picker giving focus back", () => {
    const mountOpen = () => {
        const changes = [];
        // The field reads the clock preference off the preferences tuple.
        const {container} = render(createElement(PreferencesContext.Provider, {value: [{}, () => undefined]},
            createElement(TimeField,
                {id: "when", value: "08:30", onChange: (value) => changes.push(value), ariaLabel: "Time"})));
        const input = container.querySelector("#when");
        const trigger = container.querySelector(".time-field-trigger");
        assert.ok(input && trigger, "the field drew no input and trigger");

        click(trigger);
        const menu = window.document.querySelector(".time-field-menu");
        assert.ok(menu, "the picker did not open");

        return {input, trigger, menu, changes};
    };

    it("returns to the field on Escape", () => {
        const {input, menu} = mountOpen();
        const option = menu.querySelector("button");

        focus(option);
        keydown(option, "Escape");

        assert.ok(window.document.querySelector(".time-field-menu") === null, "Escape did not close it");
        assert.ok(focused() === input, "Escape left the reader on the body");
    });

    it("returns to the field when the trigger closes it", () => {
        const {input, trigger, menu} = mountOpen();

        focus(menu.querySelector("button"));
        click(trigger);

        assert.ok(window.document.querySelector(".time-field-menu") === null, "the trigger did not close it");
        assert.ok(focused() === input, "closing left the reader on the body");
    });
});

describe("the context menu taking and giving back focus", () => {
    const withOpener = () => {
        const {container} = render(createElement("button", {id: "opener"}, "open"));
        const opener = container.querySelector("#opener");
        focus(opener);
        return opener;
    };

    const mountMenu = (items) => {
        const closes = [];
        const mount = render(createElement(ContextMenu,
            {items, position: {x: 10, y: 10}, onClose: () => closes.push(1)}));
        const menu = mount.container.querySelector("[role=\"menu\"]");
        assert.ok(menu, "the menu did not draw");
        return {mount, menu, closes};
    };

    it("takes focus on opening and hands it back to what raised it", () => {
        const opener = withOpener();
        const {mount, menu} = mountMenu([{label: "One", onClick: () => undefined}]);

        assert.ok(focused() === menu, "the menu did not take focus on opening");

        mount.unmount();

        assert.ok(focused() === opener, "closing the menu left the reader on the body");
    });

    it("asks to close on Escape", () => {
        withOpener();
        const {menu, closes} = mountMenu([{label: "One", onClick: () => undefined}]);

        keydown(menu, "Escape");

        assert.equal(closes.length, 1);
    });

    it("runs an item and asks to close", () => {
        withOpener();
        const clicks = [];
        const {menu, closes} = mountMenu([{label: "One", onClick: () => clicks.push(1)}]);

        click(menu.querySelector("[role=\"menuitem\"]"));

        assert.equal(clicks.length, 1, "the item did not run");
        assert.equal(closes.length, 1, "the menu did not ask to close");
    });

    // Focus that already moved elsewhere - a dialog the item opened - is not
    // pulled back onto the raiser.
    it("leaves focus where a chosen item put it", () => {
        withOpener();
        const {container} = render(createElement("button", {id: "elsewhere"}, "elsewhere"));
        const elsewhere = container.querySelector("#elsewhere");
        const {mount} = mountMenu([{label: "One", onClick: () => undefined}]);

        focus(elsewhere);
        mount.unmount();

        assert.ok(focused() === elsewhere, "closing pulled focus off the control an item moved it to");
    });
});

describe("an alert giving focus back to what opened it", () => {
    const Opener = ({variant}) => {
        const alert = useAlert();
        const open = () => variant === "input" ? alert.openInput("Title") : alert.openAlert("Title", "Body");
        return createElement("button", {id: "opener", onClick: open}, "open");
    };

    it("returns to the opener once the alert has closed", () => {
        const {container} = render(createElement(AlertProvider, null, createElement(Opener)));
        const opener = container.querySelector("#opener");

        press(opener);

        const dialog = window.document.querySelector(".dialog");
        assert.ok(dialog, "the alert did not open");
        assert.ok(dialog.contains(focused()), "the alert did not take focus");

        keydown(dialog, "Escape");
        animationEnd(dialog, "fadeOut");

        assert.ok(window.document.querySelector(".dialog") === null, "the alert did not close");
        assert.ok(focused() === opener, "closing the alert left the reader on the body");
    });

    /**
     * The variant the recording exists for. An input alert autofocuses its
     * field during commit, before any effect can look - so a restore that
     * reads activeElement when the overlay mounts finds the alert's own field
     * and, on closing, hands focus to an element it has just unmounted. The
     * provider records the opener at the moment the alert is asked for, which
     * is the only moment the answer is still right.
     */
    it("returns to the opener from an input alert, whose field took focus on commit", () => {
        const {container} = render(createElement(AlertProvider, null, createElement(Opener, {variant: "input"})));
        const opener = container.querySelector("#opener");

        press(opener);

        const dialog = window.document.querySelector(".dialog");
        assert.ok(dialog, "the alert did not open");
        assert.ok(focused()?.tagName === "INPUT" && dialog.contains(focused()), "the field did not take focus");

        keydown(dialog, "Escape");
        animationEnd(dialog, "fadeOut");

        assert.ok(window.document.querySelector(".dialog") === null, "the alert did not close");
        assert.ok(focused() === opener, "closing the input alert left the reader on the body");
    });
});

describe("a dialog giving focus back, and only the topmost answering Escape", () => {
    const opener = () => {
        const {container} = render(createElement("button", {id: "opener"}, "open"));
        const button = container.querySelector("#opener");
        focus(button);
        return button;
    };

    /**
     * A dialog is driven by its `open` prop, and it reopens itself whenever
     * that is true while it is not visible - so it has to be hosted the way
     * every real caller hosts it, by a parent whose onClose turns `open` off.
     */
    const Host = ({label, onClosed}) => {
        const [open, setOpen] = useState(true);

        return createElement(Dialog, {open, label, onClose: () => { setOpen(false); onClosed(); }},
            createElement("button", {className: "inner"}, "inner"));
    };

    const openDialog = (label) => {
        const closes = [];
        const mount = render(createElement(Host, {label, onClosed: () => closes.push(1)}));
        return {mount, closes};
    };

    const dialogs = () => [...window.document.querySelectorAll(".dialog")];

    it("takes focus inside and returns it to the opener on Escape", () => {
        const button = opener();
        const {closes} = openDialog("One");

        const [dialog] = dialogs();
        assert.ok(dialog?.contains(focused()), "the dialog did not take focus");

        keydown(dialog, "Escape");
        animationEnd(dialog, "fadeOut");

        assert.equal(closes.length, 1, "the dialog did not report closing");
        assert.ok(dialogs().length === 0, "the dialog is still drawn");
        assert.ok(focused() === button, "closing the dialog left the reader on the body");
    });

    it("closes only the dialog on top", () => {
        opener();
        const below = openDialog("Below");
        const above = openDialog("Above");

        const [lower, upper] = dialogs();
        keydown(upper, "Escape");
        animationEnd(upper, "fadeOut");

        assert.equal(above.closes.length, 1, "the top dialog did not close");
        assert.equal(below.closes.length, 0, "Escape reached the dialog underneath");
        assert.ok(dialogs().length === 1 && dialogs()[0] === lower, "the wrong dialog is left");
        assert.ok(lower.contains(focused()), "focus did not return to the dialog underneath");
    });
});
