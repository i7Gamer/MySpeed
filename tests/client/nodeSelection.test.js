import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LOCAL_NODE, selectedNode } from "@/common/contexts/Node/nodeSelection.js";

/**
 * Deleting the node you are looking at used to leave the whole app pointed at
 * it.
 *
 * `currentNode` is held in the provider and in localStorage, and RequestUtil
 * routes every request in the app by it, but nothing ever checked it against
 * the list of nodes that actually exist - handleDelete called updateNodes() and
 * nothing else. Immediately after the delete nothing looks wrong, because the
 * node page and its cards use the fixed baseRequest and the header is not
 * rendered there; it breaks on the next navigation, when the status poll, the
 * test list and every dialog save start going to /api/nodes/<gone>, and the
 * header cannot even say where it is because findNode no longer resolves.
 */
const nodes = (...ids) => ids.map((id) => ({id, name: `node ${id}`}));

describe("selectedNode", () => {
    it("keeps a node that is still there", () => {
        assert.equal(selectedNode(3, nodes(1, 3, 7), true), 3);
    });

    it("falls back to this instance when the node has been deleted", () => {
        assert.equal(selectedNode(3, nodes(1, 7), true), LOCAL_NODE);
    });

    it("falls back when every node has been deleted", () => {
        assert.equal(selectedNode(3, [], true), LOCAL_NODE);
    });

    it("leaves this instance selected", () => {
        assert.equal(selectedNode(LOCAL_NODE, [], true), LOCAL_NODE);
        assert.equal(selectedNode(LOCAL_NODE, nodes(1), true), LOCAL_NODE);
    });

    /**
     * The list starts empty and is filled by a request. Reconciling against it
     * before the answer arrives would move every session to the local instance
     * on page load - which is worse than the fault being fixed, because it
     * happens to everyone every time rather than to one person once.
     */
    describe("before the list has been fetched", () => {
        it("changes nothing, even though the list is empty", () => {
            assert.equal(selectedNode(3, [], false), 3);
        });

        it("changes nothing for the local instance either", () => {
            assert.equal(selectedNode(LOCAL_NODE, [], false), LOCAL_NODE);
        });
    });

    // The id read back out of localStorage is parsed, and the ids in the list
    // come from JSON - a strict comparison between the two is only correct if
    // both are numbers, and "3" !== 3 would silently reset a valid selection.
    it("compares ids as numbers, the way both sides store them", () => {
        assert.equal(selectedNode(3, [{id: 3}], true), 3);
        assert.equal(typeof LOCAL_NODE, "number");
    });
});

/**
 * And the provider actually reconciles. The decision being right is no use if
 * nothing asks it - which is exactly the state this started in.
 */
describe("the node provider", () => {
    const source = fs.readFileSync(path.resolve(fileURLToPath(import.meta.url),
        "..", "..", "..", "client", "src", "common", "contexts", "Node", "NodeContext.jsx"), "utf8");

    it("asks whether the selected node still exists", () => {
        assert.match(source, /selectedNode\(/,
            "nothing checks the selection against the list, so a deleted node stays selected");
    });

    // Both, or a reload puts the app straight back on the node that is gone.
    it("writes the correction through to storage", () => {
        assert.match(source, /updateCurrentNode\(/,
            "the correction is not written to localStorage, so it lasts until the next reload");
    });

    it("reloads the config for the node it moved to", () => {
        assert.match(source, /reloadConfig\(/,
            "the app keeps the deleted node's config after falling back to this instance");
    });
});
