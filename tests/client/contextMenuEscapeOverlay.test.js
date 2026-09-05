import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { act, cleanup, createElement, keydown, render, settle, window } from "../helpers/renderHarness.js";
import { ContextMenu } from "@/common/components/ContextMenu/ContextMenu";
import { AlertProvider, useAlert } from "@/common/contexts/Alert";

/**
 * ContextMenu answered Escape unconditionally, with neither of the two guards
 * every other overlay in this app makes before it: Dialog and Alert both
 * decline a key `event.defaultPrevented` already claims, and Alert additionally
 * asks isTopmostOverlay before it acts, so a key belongs to exactly one of a
 * stack of overlays.
 *
 * The menu is not itself registered in their `.dialog-area` stack, so it
 * cannot ask that question - it asks the weaker one ChartModal and the
 * settings dropdown already ask in the same position: is anything else open at
 * all, since this menu is raised from the page and nothing can ever be
 * underneath it.
 *
 * Both listeners sit on `document`, and this menu's is added first - a
 * confirmation raised over it, as NodeContainer's password prompt or its
 * remove confirmation would if either ever opened while the menu was still up,
 * registers its own Escape listener second. Unguarded, the menu's listener ran
 * first on every Escape, closed itself and called preventDefault - so the
 * alert's own handler, which already declines a claimed key, never got to
 * answer at all. One press closed the wrong overlay and left the one on top
 * of it, the one the reader actually meant to dismiss, exactly as it was.
 */
afterEach(cleanup);

describe("a context menu with an alert stacked over it", () => {
    it("leaves Escape to the alert on top, rather than closing itself first", async () => {
        let openTheAlert;
        const Harness = () => {
            const alert = useAlert();
            openTheAlert = () => alert.openConfirm("Delete this node?", "This cannot be undone.");
            return null;
        };

        render(createElement(AlertProvider, null, createElement(Harness)));

        // A separate root, the way NodeContainer's real menu is: a sibling
        // tree rather than a descendant of the AlertProvider above, since both
        // simply render into the document.
        const closes = [];
        render(createElement(ContextMenu, {
            items: [{label: "Rename", onClick: () => undefined}],
            position: {x: 10, y: 10},
            onClose: () => closes.push(1),
            label: "node menu"
        }));

        assert.ok(window.document.querySelector(".context-menu"), "the menu did not render");

        act(() => { openTheAlert(); });
        await settle();

        const dialog = window.document.querySelector(".dialog-area .dialog");
        assert.ok(dialog, "the alert did not open over the still-open menu");

        keydown(window.document, "Escape");

        assert.equal(closes.length, 0,
            "the menu answered an Escape meant for the alert stacked over it");
        assert.ok(window.document.querySelector(".context-menu"),
            "the menu closed instead of leaving the key to the alert on top of it");
        assert.ok(dialog.classList.contains("dialog-hidden"),
            "the alert never started closing, so nothing answered the Escape at all");
    });

    // The base case, unchanged: with nothing stacked over it the menu still
    // owns Escape outright.
    it("still closes on Escape when nothing is stacked over it", () => {
        const closes = [];
        render(createElement(ContextMenu, {
            items: [{label: "Rename", onClick: () => undefined}],
            position: {x: 10, y: 10},
            onClose: () => closes.push(1),
            label: "node menu"
        }));

        keydown(window.document, "Escape");

        assert.equal(closes.length, 1, "the menu no longer answers Escape at all");
    });
});
