import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bodyOf, readSource } from "../helpers/source.js";

/**
 * The card's "server actions" button anchors the context menu under itself,
 * from the button's own box. The box was read inside the setState updater,
 * and React runs a queued updater at the next render rather than in the
 * handler - by then the synthetic event has been handed back and
 * `currentTarget` is null. A click that landed while another update was
 * pending, the status poll answering mostly, threw on the null and the
 * router's error boundary replaced the page with "Oops!". Reproduced twice
 * in the preview rig from a real click on 2026-09-06.
 *
 * Nothing in jsdom forces the lazy path reliably, so the shape is pinned: the
 * box is read before the update is queued, and the updater reads no event.
 */
describe("the node menu's anchor", () => {
    const toggle = bodyOf(readSource("client/src/pages/Nodes/components/NodeContainer/NodeContainer.jsx"),
        "const toggleContextMenu = ");

    it("is read from the event before the state update is queued", () => {
        const read = toggle.indexOf("event.currentTarget.getBoundingClientRect()");
        const queued = toggle.indexOf("setContextMenu(");

        assert.notEqual(read, -1, "the menu is no longer anchored under the button");
        assert.notEqual(queued, -1);
        assert.ok(read < queued, "the box is read inside the updater, where the event is already recycled");
    });

    it("leaves the updater nothing of the event to read", () => {
        const updater = toggle.slice(toggle.indexOf("setContextMenu("));

        assert.doesNotMatch(updater, /event\./, "the updater reads the event React has already handed back");
    });
});
