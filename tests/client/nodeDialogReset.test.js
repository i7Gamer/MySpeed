import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bodyIn, readSource } from "../helpers/source.js";

/**
 * The create-node dialog keeps what was typed into it after it is closed.
 *
 * Nodes.jsx renders it unconditionally - `<CreateNodeDialog open={...}/>` with
 * no `{open && ...}` guard - so the component is mounted for the life of the
 * page. DialogContext's `if (!visible) return null` unmounts only the dialog's
 * *children*, and the four useState hooks live in CreateNodeDialog itself,
 * above that boundary. They survive every close.
 *
 * So an operator who starts adding a node, gets the URL wrong, and cancels is
 * shown the same half-typed attempt and the same red error the next time they
 * open it - including `checking`, which leaves the confirm button spinning on a
 * request that finished long ago.
 *
 * The sibling dialog in this same tree already knows the component stays
 * mounted and codes for it, which is the pattern this follows.
 */
describe("the create-node dialog when it is opened again", () => {
    const source = readSource("client/src/pages/Nodes/components/CreateNodeDialog/CreateNodeDialog.jsx");

    it("is mounted for the life of the page, which is why this matters", () => {
        const nodes = readSource("client/src/pages/Nodes/Nodes.jsx");

        assert.match(nodes, /<CreateNodeDialog\s+open=/,
            "the dialog is no longer rendered unconditionally");
        assert.doesNotMatch(nodes, /\{\s*createDialogOpen\s*&&\s*<CreateNodeDialog/,
            "the dialog now unmounts on close, so the reset below is dead code");
    });

    it("clears what the last attempt left behind", () => {
        const effect = bodyIn(
            "client/src/pages/Nodes/components/CreateNodeDialog/CreateNodeDialog.jsx",
            "useEffect(");

        for (const setter of ["setServerName", "setServerUrl", "setUrlError", "setChecking"])
            assert.match(effect, new RegExp(`${setter}\\(`),
                `${setter} still carries the previous attempt into the reopened dialog`);
    });

    // Keyed on `open`, not run once on mount: mounting happens before the
    // operator has opened anything, so a reset there fires exactly once and
    // never again.
    it("does it every time the dialog opens", () => {
        assert.match(source, /\}\s*,\s*\[open\]\s*\)/,
            "the reset is not keyed on the dialog opening");
    });
});

/**
 * A node list that could not be fetched.
 *
 * updateNodes is fire-and-forget at eight call sites - the provider's own
 * effect, the Nodes page, this dialog, the node container twice and the
 * password dialog twice - and none of them awaits or catches. A server that is
 * down, a dropped connection, or a proxied node that goes quiet past the abort
 * left an unhandled rejection on the console every time.
 *
 * Handled inside updateNodes rather than at the call sites, which is the only
 * place that covers all eight. Nothing is lost by swallowing it: the ok:false
 * path already returns silently, so there was never any feedback here to keep.
 */
describe("a node list request that fails", () => {
    it("is handled where every caller shares it", () => {
        const update = bodyIn("client/src/common/contexts/Node/NodeContext.jsx", "const updateNodes");

        assert.match(update, /\.catch\(/,
            "a failed fetch rejects into nothing at eight fire-and-forget call sites");
    });

    // nodesLoaded stays false on a failure, which is what stops the
    // reconciliation below treating an empty list as an answer.
    it("does not claim the empty list is an answer", () => {
        const update = bodyIn("client/src/common/contexts/Node/NodeContext.jsx", "const updateNodes");
        const loaded = update.indexOf("setNodesLoaded(true)");
        const caught = update.indexOf(".catch(");

        assert.ok(loaded !== -1 && caught !== -1);
        assert.ok(loaded < caught, "the catch runs before the list is marked loaded");
    });
});
