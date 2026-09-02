import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    act, cleanup, click, createElement, focus, focused, keydown, render, settle, window
} from "../helpers/renderHarness.js";
import { AlertProvider } from "@/common/contexts/Alert";
import { ExportButton } from "@/common/components/ExportButton/ExportButton";
import { DateRangePicker } from "@/common/components/DateRangePicker/DateRangePicker";

/**
 * The ghosts of REVIEW_1.3.5.md, run rather than read.
 *
 * Both menus render their contents only while open, so closing unmounts the
 * control holding focus and the reader lands on <body>, with the next Tab
 * restarting at the top of the document. The fixes (8792e49a, and the export's
 * later refinement for its disabled trigger) were verified by a text scan that
 * the right line exists - and that scan would pass just as green with the line
 * doing nothing. These tests hold the behaviour itself: where focus actually
 * is after each way of closing, on a document whose focus model refuses a
 * disabled button and drops focus with a removed element, exactly as a browser
 * does.
 *
 * Every case is a sequence a reader can produce with a keyboard, which is the
 * only reader who had anything to lose: a pointer never held focus in the menu.
 */
afterEach(cleanup);

/** Pointer or keyboard, a reader on a control is focused on it before pressing. */
const press = (element) => {
    focus(element);
    click(element);
};

const outside = () => act(() => window.document.body.dispatchEvent(
    new window.MouseEvent("mousedown", {bubbles: true, cancelable: true})));

describe("the export menu giving focus back", () => {
    const realFetch = globalThis.fetch;

    // The export the menu starts: answered at once with a small file, so the
    // sequence runs to its end - the trigger is disabled for the length of it,
    // and only re-enabled can it take focus back.
    beforeEach(() => {
        globalThis.fetch = async () => new Response("a,b\n1,2\n",
            {status: 200, headers: {"content-type": "text/csv"}});
    });

    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    const mountExport = () => {
        const {container} = render(createElement(AlertProvider, null,
            createElement(ExportButton, {dateRange: {from: new Date(2026, 6, 1), to: new Date(2026, 6, 7)}})));
        const trigger = container.querySelector(".export-button");

        click(trigger);
        const formats = [...container.querySelectorAll(".export-option")];
        assert.equal(formats.length, 2, "opening the menu did not show the two formats");

        return {container, trigger, formats};
    };

    it("returns to the trigger once the export it started has ended", async () => {
        const {trigger, formats} = mountExport();

        press(formats[0]);

        // The menu is gone and the trigger disabled: nowhere for focus to be.
        assert.ok(focused() === null, "focus survived the format button being unmounted");
        assert.equal(trigger.disabled, true, "the trigger was not disabled for the export");

        await settle(10);

        assert.equal(trigger.disabled, false, "the export never ended");
        assert.ok(focused() === trigger, "the reader was left on the body after choosing a format");
    });

    it("returns to the trigger on Escape", () => {
        const {trigger, formats} = mountExport();

        focus(formats[1]);
        keydown(formats[1], "Escape");

        assert.ok(focused() === trigger, "the reader was left on the body");
    });

    // A click outside closes the menu too, and there focus belongs to whatever
    // was clicked - the guard the fix is built around.
    it("leaves focus alone when a click outside closes it", async () => {
        const {container, trigger} = mountExport();

        await settle(0);
        outside();
        await settle(0);

        assert.ok(container.querySelector(".export-dropdown") === null, "the menu stayed open");
        assert.ok(focused() !== trigger, "a click elsewhere handed focus to the trigger");
    });
});

describe("the date picker giving focus back", () => {
    const mountPicker = () => {
        const calls = {timeframes: [], ranges: []};
        const {container} = render(createElement(DateRangePicker, {
            from: new Date(2026, 6, 10), to: new Date(2026, 6, 20),
            onChange: (from, to) => calls.ranges.push([from, to]),
            timeframe: null,
            onTimeframeChange: (id) => calls.timeframes.push(id)
        }));
        const trigger = container.querySelector(".date-range-trigger");

        click(trigger);
        assert.ok(container.querySelector(".date-range-popover"), "the picker did not open");

        return {container, trigger, calls};
    };

    it("returns to the trigger on Escape", () => {
        const {container, trigger} = mountPicker();
        const preset = container.querySelector(".timeframe-preset");

        focus(preset);
        keydown(preset, "Escape");

        assert.ok(container.querySelector(".date-range-popover") === null, "Escape did not close it");
        assert.ok(focused() === trigger, "Escape left the reader on the body");
    });

    it("returns to the trigger when a preset is chosen", () => {
        const {container, trigger, calls} = mountPicker();
        const presets = container.querySelectorAll(".timeframe-preset");

        press(presets[presets.length - 1]);

        assert.equal(calls.timeframes.length, 1, "the preset was not applied");
        assert.ok(focused() === trigger, "choosing a preset left the reader on the body");
    });

    it("returns to the trigger on the second click of a day range", () => {
        const {container, trigger, calls} = mountPicker();
        const days = [...container.querySelectorAll(".day-btn:not(.other-month):not(.disabled)")];
        assert.ok(days.length >= 6, "the calendar drew too few days to pick a range in");

        press(days[2]);
        assert.ok(container.querySelector(".date-range-popover"), "one click closed the picker");

        press(days[5]);

        assert.equal(calls.ranges.length, 1, "the range was not applied");
        assert.ok(container.querySelector(".date-range-popover") === null, "the second click did not close it");
        assert.ok(focused() === trigger, "completing a range left the reader on the body");
    });

    it("leaves focus alone when a click outside closes it", async () => {
        const {container, trigger} = mountPicker();

        await settle(0);
        outside();
        await settle(0);

        assert.ok(container.querySelector(".date-range-popover") === null, "the picker stayed open");
        assert.ok(focused() !== trigger, "a click elsewhere handed focus to the trigger");
    });
});
