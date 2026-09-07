import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { cleanup, createElement, render, settle, window } from "../helpers/renderHarness.js";
import { ContextMenu, VIEWPORT_MARGIN } from "@/common/components/ContextMenu/ContextMenu";

/**
 * A menu raised near an edge is pushed back inside the viewport. The push
 * was the menu's whole width plus a margin, with no floor: a menu wider than
 * the viewport - a narrow phone, a desktop zoomed far in - was pushed past
 * the opposite edge and opened with its left side off the screen.
 *
 * jsdom lays nothing out, so the menu's box and the viewport are both given
 * here; the arithmetic under test is on those numbers alone.
 */
afterEach(cleanup);

const MENU = {width: 300, height: 200};

const {HTMLElement} = window;
const realRect = HTMLElement.prototype.getBoundingClientRect;
const realWidth = window.innerWidth;
const realHeight = window.innerHeight;

beforeEach(() => {
    HTMLElement.prototype.getBoundingClientRect = function () {
        return {...MENU, x: 0, y: 0, left: 0, top: 0, right: MENU.width, bottom: MENU.height};
    };
});

afterEach(() => {
    HTMLElement.prototype.getBoundingClientRect = realRect;
    window.innerWidth = realWidth;
    window.innerHeight = realHeight;
});

const open = async (position) => {
    render(createElement(ContextMenu, {
        items: [{label: "Rename", onClick: () => undefined}],
        position,
        onClose: () => undefined,
        label: "node menu"
    }));
    await settle();

    const menu = window.document.querySelector(".context-menu");
    assert.ok(menu, "the menu did not render");
    return {left: parseInt(menu.style.left), top: parseInt(menu.style.top)};
};

describe("a context menu near the viewport's edge", () => {
    it("opens where it was asked when it fits", async () => {
        window.innerWidth = 1000;
        window.innerHeight = 800;

        assert.deepEqual(await open({x: 50, y: 40}), {left: 50, top: 40});
    });

    it("is pushed back inside when it would overflow", async () => {
        window.innerWidth = 1000;
        window.innerHeight = 800;

        assert.deepEqual(await open({x: 900, y: 700}),
            {left: 1000 - MENU.width - VIEWPORT_MARGIN, top: 800 - MENU.height - VIEWPORT_MARGIN});
    });

    it("is clamped again when the viewport shrinks under it", async () => {
        window.innerWidth = 1000;
        window.innerHeight = 800;

        assert.deepEqual(await open({x: 600, y: 500}), {left: 600, top: 500});

        window.innerWidth = 700;
        window.innerHeight = 600;
        window.dispatchEvent(new window.Event("resize"));
        await settle();

        const menu = window.document.querySelector(".context-menu");
        assert.deepEqual({left: parseInt(menu.style.left), top: parseInt(menu.style.top)},
            {left: 700 - MENU.width - VIEWPORT_MARGIN, top: 600 - MENU.height - VIEWPORT_MARGIN});
    });

    it("stops at the margin rather than leaving by the other side", async () => {
        window.innerWidth = MENU.width - 50;
        window.innerHeight = MENU.height - 50;

        const placed = await open({x: 5, y: 5});

        assert.deepEqual(placed, {left: VIEWPORT_MARGIN, top: VIEWPORT_MARGIN},
            "a menu wider than the viewport was pushed off its far edge");
    });
});
