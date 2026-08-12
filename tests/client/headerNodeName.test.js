import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isLocalNode, nodeTitle } from "../../client/src/common/components/Header/nodeTitle.js";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const withoutComments = (source) => source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const app = withoutComments(fs.readFileSync(path.join(CLIENT_SRC, "App.jsx"), "utf8"));

const NODES = [{id: 1, name: "living-room"}, {id: 2, name: "attic"}];
const findNode = (id) => NODES.find((node) => node.id === id);

const FALLBACK = "MySpeed";

/**
 * Which name the header shows.
 *
 * NodeContext stores currentNode as `parseInt(...) || 0`, i.e. always a number,
 * and the header compared it with `currentNode === "0"` - strictly, against a
 * string. That is false for every value there has ever been, so the local
 * instance took the remote branch and looked itself up as node 0, which is not
 * a node any list contains. The `|| fallback` behind it meant the right title
 * came out anyway, which is why this survived: a type error with no symptom,
 * one `findNode` call from being one.
 */
describe("isLocalNode", () => {
    it("recognises the instance's own node as a number", () => {
        assert.equal(isLocalNode(0), true);
    });

    it("recognises it as a string too, which is how localStorage holds it", () => {
        assert.equal(isLocalNode("0"), true);
    });

    it("treats an unset selection as local", () => {
        assert.equal(isLocalNode(null), true);
        assert.equal(isLocalNode(undefined), true);
    });

    it("treats a real node as remote", () => {
        assert.equal(isLocalNode(1), false);
        assert.equal(isLocalNode("2"), false);
    });
});

describe("nodeTitle", () => {
    it("shows the fallback for this instance", () => {
        assert.equal(nodeTitle(0, findNode, FALLBACK), FALLBACK);
    });

    it("does not go looking for a node when it is on this instance", () => {
        let looked = false;

        nodeTitle(0, () => { looked = true; }, FALLBACK);

        assert.equal(looked, false, "the local instance was looked up as node 0, which does not exist");
    });

    it("shows the name of the selected node", () => {
        assert.equal(nodeTitle(1, findNode, FALLBACK), "living-room");
    });

    it("falls back when the selected node is not in the list yet", () => {
        assert.equal(nodeTitle(99, findNode, FALLBACK), FALLBACK);
    });

    it("falls back for a node with no name", () => {
        assert.equal(nodeTitle(1, () => ({id: 1}), FALLBACK), FALLBACK);
    });
});

/**
 * createBrowserRouter builds a router, and RouterProvider treats a new one as a
 * different router: it remounts the whole tree under it and drops the
 * navigation state with it. Called from inside the component body, it produced
 * a fresh router on every render of App. App only re-renders twice today, when
 * the translations resolve, so nothing visible came of it - but the cost of any
 * future state added to App was a full remount of the application, payable by
 * whoever added it.
 */
describe("the router", () => {
    it("is built once, outside the component that renders it", () => {
        const created = app.indexOf("createBrowserRouter(");
        const component = app.search(/const App\s*=/);

        assert.notEqual(created, -1, "the router is no longer created here");
        assert.ok(created < component,
            "the router is rebuilt on every render, remounting the whole route tree");
    });
});
