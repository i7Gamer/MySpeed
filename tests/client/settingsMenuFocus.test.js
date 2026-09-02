import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoryRouter } from "react-router-dom";
import {
    act, cleanup, click, createElement, focus, focused, keydown, render, window
} from "../helpers/renderHarness.js";
import { AlertProvider } from "@/common/contexts/Alert";
import { ConfigContext } from "@/common/contexts/Config";
import { NodeContext } from "@/common/contexts/Node";
import { StatusContext } from "@/common/contexts/Status";
import { ToastNotificationContext } from "@/common/contexts/ToastNotification";
import { PreferencesContext } from "@/common/contexts/Preferences";
import { TargetsContext } from "@/common/contexts/Targets";
import { SpeedtestContext } from "@/common/contexts/Speedtests";
import { ThemeContext } from "@/common/contexts/Theme";
import HeaderComponent from "@/common/components/Header/HeaderComponent";

/**
 * The first ghost of REVIEW_1.3.5.md: the settings menu handing focus back to
 * the gear when it closes over its own focus (5ad986a3).
 *
 * The menu is never unmounted - it hides with `visibility: hidden` - so the
 * entry a reader activates keeps `isConnected` and passes every guard while
 * `focus()` on it does nothing. Nine dialogs recorded that hidden entry as the
 * control to return to and handed focus to <body> on closing. The fix moves
 * focus to the gear as the menu closes, so what a dialog records is a control
 * that can be returned to.
 *
 * What this pins is the fix's own mechanism, on the keyboard routes that
 * reach it: closing over an entry lands on the gear, and closing from a click
 * elsewhere leaves focus where the click put it. What it cannot pin is the
 * dialog round-trip the ghost was seen in, and the reason is worth stating:
 * jsdom lays nothing out, so it does not know a hidden element from a visible
 * one and would happily focus the hidden entry. The stylesheet that hides it
 * is not even loaded here. That end-to-end is the preview's to check.
 */
afterEach(cleanup);

const noop = () => undefined;

// A loaded, unlocked, non-preview instance with no password and one local
// node - the ordinary case, and the one with every menu entry on offer.
const config = {viewMode: false, previewMode: false, passwordSet: true, password: "none"};

/**
 * Every context the header's tree reads, with the value shape each provider
 * really hands out. The menu mounts its nine dialogs closed, and a closed
 * dialog still runs its hooks - so a tuple context left at its `{}` default
 * throws on destructuring before anything is drawn.
 */
const nest = (child, ...layers) =>
    layers.reduceRight((inner, [Provider, value]) => createElement(Provider, {value}, inner), child);

const providers = (child) =>
    createElement(MemoryRouter, null, nest(createElement(AlertProvider, null, child),
        [ConfigContext.Provider, [config, noop, noop]],
        [NodeContext.Provider, [[], noop, 0, noop, () => undefined]],
        [StatusContext.Provider, [{paused: false, running: false}, noop, noop]],
        [ToastNotificationContext.Provider, noop],
        [PreferencesContext.Provider, [{}, noop]],
        [TargetsContext.Provider, {targets: [], reloadTargets: noop}],
        [SpeedtestContext.Provider, {updateTests: noop}],
        [ThemeContext.Provider, {theme: "dark", palette: "default", setTheme: noop, setPalette: noop}]));

describe("the settings menu giving focus back to the gear", () => {
    const realFetch = globalThis.fetch;

    // The header asks the server for its version on mount; the answer is not
    // this test's business, and a refusal is one it already handles.
    beforeEach(() => {
        globalThis.fetch = async () => new Response("{}", {status: 404});
    });

    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    const mountOpen = () => {
        const {container} = render(providers(createElement(HeaderComponent)));
        const gear = container.querySelector("#open-header button");
        assert.ok(gear, "the header drew no settings button");

        click(gear);

        const menu = container.querySelector(".dropdown");
        assert.ok(menu && !menu.classList.contains("dropdown-invisible"), "the menu did not open");
        const entries = [...container.querySelectorAll(".dropdown-item")];
        assert.ok(entries.length >= 2, "the menu drew fewer than two entries");

        return {container, gear, menu, entries};
    };

    it("lands on the gear when Escape closes the menu over an entry", () => {
        const {gear, menu, entries} = mountOpen();

        focus(entries[1]);
        keydown(entries[1], "Escape");

        assert.ok(menu.classList.contains("dropdown-invisible"), "Escape did not close the menu");
        assert.ok(focused() === gear, "closing over an entry left focus on the hidden entry");
    });

    it("lands on the gear when the gear itself closes the menu over an entry", () => {
        const {gear, menu, entries} = mountOpen();

        focus(entries[0]);
        click(gear);

        assert.ok(menu.classList.contains("dropdown-invisible"), "the gear did not close the menu");
        assert.ok(focused() === gear, "closing over an entry left focus on the hidden entry");
    });

    // The same function runs for a click outside, where focus belongs to
    // whatever was clicked - the guard the fix carries.
    it("leaves focus alone when a click outside closes it", () => {
        const {gear, menu} = mountOpen();

        act(() => window.document.body.dispatchEvent(
            new window.MouseEvent("mousedown", {bubbles: true, cancelable: true})));

        assert.ok(menu.classList.contains("dropdown-invisible"), "the outside click did not close the menu");
        assert.ok(focused() !== gear, "a click elsewhere handed focus to the gear");
    });
});
