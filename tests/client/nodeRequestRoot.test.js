import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// RequestUtil targets the browser; stub the globals it reaches for before the
// module graph is loaded, the same way requestUtil.test.js does.
const store = new Map();

globalThis.localStorage = {
    getItem: (key) => store.has(key) ? store.get(key) : null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key)
};

let lastUrl = null;

globalThis.fetch = async (url) => {
    lastUrl = url;
    return {ok: true, status: 200, json: async () => ({})};
};

const { baseRequest, patchRequest } = await import("../../client/src/common/utils/RequestUtil.js");

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const nodeContainerSource = fs.readFileSync(
    path.join(CLIENT_SRC, "pages/Nodes/components/NodeContainer/NodeContainer.jsx"), "utf8");

beforeEach(() => {
    store.clear();
    lastUrl = null;
});

/**
 * The two request roots, and why a path naming a node has to use the second.
 *
 * The plain helpers prepend whatever node the user is currently *looking at* -
 * that is what they are for, so a page written once can address the local
 * instance or a remote one without knowing which. A path that already names a
 * node is the case they cannot serve: prefixing it produces the id twice.
 */
describe("the two request roots", () => {
    it("sends the plain helpers through the node being viewed", async () => {
        localStorage.setItem("currentNode", "3");

        await patchRequest("/config", {});

        assert.equal(lastUrl, "/api/nodes/3/config");
    });

    it("keeps baseRequest on /api whatever is being viewed", async () => {
        localStorage.setItem("currentNode", "3");

        await baseRequest("/nodes/5/name", "PATCH", {name: "kitchen"});

        assert.equal(lastUrl, "/api/nodes/5/name");
    });

    /**
     * The bug, kept as a test so the shape of it is on record: this is what the
     * rename produced while any remote node was selected.
     */
    it("doubles the prefix when a node-scoped path goes through a plain helper", async () => {
        localStorage.setItem("currentNode", "3");

        await patchRequest("/nodes/5/name", {name: "kitchen"});

        assert.equal(lastUrl, "/api/nodes/3/nodes/5/name",
            "the trap this guards against no longer exists - check the rule below is still worth keeping");
    });

    // Why it went unnoticed: from the local instance the two roots agree, and
    // that is the state the nodes page is usually reached in.
    it("agrees with baseRequest while the local instance is selected", async () => {
        await patchRequest("/nodes/5/name", {name: "kitchen"});

        assert.equal(lastUrl, "/api/nodes/5/name");
    });
});

/**
 * Renaming a node 404'd whenever another node was selected.
 *
 * Every other action on the node card - the password patch, the delete - was
 * written with baseRequest; the rename alone used patchRequest, so it was sent
 * to /api/nodes/<viewed>/nodes/<renamed>/name and answered by nothing. Select a
 * node, come back to the nodes page, rename any card: the toast reported a
 * failure and the name never changed.
 *
 * Asserted as a rule over the whole file rather than on the one line, because
 * the mistake is not specific to renaming - any later action on a node card can
 * reach for the wrong helper in exactly the same way.
 */
describe("the node card's own requests", () => {
    // A call to any of the node-scoped helpers, with the path it was given.
    const SCOPED_CALL = /\b(getRequest|postRequest|putRequest|patchRequest|deleteRequest)\(\s*(`[^`]*`|"[^"]*"|'[^']*')/g;

    it("addresses a node through baseRequest, never through the viewed-node root", () => {
        const offenders = [...nodeContainerSource.matchAll(SCOPED_CALL)]
            .filter(([, , target]) => target.includes("/nodes/"))
            .map(([, helper, target]) => `${helper}(${target})`);

        assert.deepEqual(offenders, [],
            "a path that already names a node was sent through the helper that prepends the viewed one");
    });

    it("still renames through a request that names the node", () => {
        assert.match(nodeContainerSource, /baseRequest\(\s*`\/nodes\/\$\{node\.id\}\/name`/,
            "the rename no longer addresses the node it was opened for");
    });
});
