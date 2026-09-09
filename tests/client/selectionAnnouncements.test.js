import { afterEach, it } from "node:test";
import assert from "node:assert/strict";
import { act, cleanup, createElement, render, window } from "../helpers/renderHarness.js";
import { ContextMenu } from "@/common/components/ContextMenu/ContextMenu";
import { DateRangePicker } from "@/common/components/DateRangePicker/DateRangePicker";

afterEach(cleanup);

it("announces the context-menu item selected by keys or pointer, skipping dividers", () => {
    const selected = [];
    const {container} = render(createElement(ContextMenu, {
        label: "Node actions", position: {x: 0, y: 0}, onClose: () => undefined,
        items: [{label: "Rename", onClick: () => selected.push("rename")}, {divider: true},
            {label: "Delete", onClick: () => selected.push("delete")}]
    }));
    const menu = container.querySelector('[role="menu"]');
    const active = () => window.document.getElementById(menu.getAttribute("aria-activedescendant"));
    const key = (value) => act(() => menu.dispatchEvent(new window.KeyboardEvent("keydown", {key: value, bubbles: true})));
    assert.equal(active()?.textContent, "Rename");
    assert.ok(window.document.activeElement === menu, "the menu keeps keyboard focus");
    key("ArrowDown");
    assert.equal(active()?.textContent, "Delete");
    key("Enter");
    assert.deepEqual(selected, ["delete"]);
    key("ArrowDown");
    assert.equal(active()?.textContent, "Rename");
    key("ArrowUp");
    assert.equal(active()?.textContent, "Delete");
    act(() => container.querySelector('[role="menuitem"]').dispatchEvent(new window.MouseEvent("mouseover", {bubbles: true})));
    assert.equal(active()?.textContent, "Rename");
});

it("an empty menu never references a nonexistent active item", () => {
    const {container} = render(createElement(ContextMenu, {
        label: "Empty", position: {x: 0, y: 0}, onClose: () => undefined, items: [{divider: true}]
    }));
    assert.equal(container.querySelector('[role="menu"]').hasAttribute("aria-activedescendant"), false);
});

it("announces the next date-selection step and exposes today's and selected days", () => {
    const dates = [];
    const {container} = render(createElement(DateRangePicker, {
        from: null, to: new Date(), onChange: (...range) => dates.push(range)
    }));
    const click = (element) => act(() => element.click());
    click(container.querySelector(".date-range-trigger"));
    const instruction = container.querySelector(".calendar-selecting");
    assert.equal(instruction.getAttribute("aria-live"), "polite");
    assert.equal(container.querySelector(".day-btn.today").getAttribute("aria-current"), "date");
    const day = container.querySelector(".day-btn:not(.other-month):not(:disabled)");
    assert.equal(day.getAttribute("aria-pressed"), "false");
    const initialInstruction = instruction.textContent;
    click(day);
    assert.notEqual(instruction.textContent, initialInstruction);
    assert.equal(day.getAttribute("aria-pressed"), "true");
    click(day);
    assert.equal(dates.length, 1);
    assert.equal(dates[0][0].getTime(), dates[0][1].getTime());
    assert.ok(container.querySelector(".date-range-popover") === null, "completing the range closes the picker");
});
