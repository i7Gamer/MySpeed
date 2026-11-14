import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bodyOf, readSource } from "../helpers/source.js";
import { stripTrailingSlashes } from "../../server/util/helpers.js";
import { childPath, staysWithinApi } from "../../server/util/nodePath.js";

/**
 * A node URL is joined to a path, and the operator's copy of it usually ends
 * in a slash.
 *
 * Both places that reach a node build the target by concatenation, so a stored
 * `http://192.168.1.50:5216/` - which is what a browser address bar hands you,
 * and which the field accepts because `new URL` parses it - asks the child for
 * `//api/config`. Express does not collapse that: the child's router never
 * matches its own mount, so every proxied request 404s and the node reads as
 * broken while answering perfectly on the address the operator typed.
 *
 * The project already owns the fix and applies it to three integration URLs
 * for exactly this reason - see stripTrailingSlashes, which is deliberately
 * not a regex.
 */
describe("joining a node URL to a path", () => {
    const join = (url, path) => stripTrailingSlashes(url) + path;

    it("leaves an ordinary address alone", () => {
        assert.equal(join("http://192.168.1.50:5216", "/api/config"), "http://192.168.1.50:5216/api/config");
    });

    it("does not double the separator when the address ends in one", () => {
        assert.equal(join("http://192.168.1.50:5216/", "/api/config"), "http://192.168.1.50:5216/api/config");
        assert.equal(join("http://192.168.1.50:5216///", "/api/config"), "http://192.168.1.50:5216/api/config");
    });
});

/**
 * The proxy folds `/api/nodes/<id>` back to `/api` for the child. It used to
 * replace the literal decoded id, unanchored, which a percent-encoded id in
 * the path never matched.
 */
describe("the path the child is asked for", () => {
    it("folds the node prefix back to /api", () => {
        assert.equal(childPath("/api/nodes/5/config"), "/api/config");
        assert.equal(childPath("/api/nodes/5/storage/tests/history/json"), "/api/storage/tests/history/json");
    });

    it("folds it however the id was spelled", () => {
        assert.equal(childPath("/api/nodes/%35/config"), "/api/config");
    });

    // Express routes case-insensitively, so this spelling reaches the proxy
    // handler; left unfolded, two instances configured as each other's node
    // sent it back and forth unshortened.
    it("folds it however the prefix was cased", () => {
        assert.equal(childPath("/API/nodes/5/config"), "/api/config");
        assert.equal(childPath("/api/Nodes/5/config"), "/api/config");
    });

    it("folds only the prefix that opens the path", () => {
        assert.equal(childPath("/api/nodes/5/config?next=/api/nodes/5/x"), "/api/config?next=/api/nodes/5/x");
    });

    it("leaves a path without the prefix alone", () => {
        assert.equal(childPath("/api/config"), "/api/config");
    });
});

/**
 * The proxy exists to reach a node's API, with the node's own password
 * attached. The path is joined to the node's address as text and parsed
 * afterwards, and the parser resolves dot segments: `/api/nodes/5/../../x`
 * folds to `/api/../../x`, which the request then sends as `/x` - outside the
 * API the proxy is scoped to, credentials and all.
 *
 * Judged with the parser the request itself uses, so the spellings it folds -
 * a percent-encoded dot, a backslash - are folded here the same way.
 */
describe("the scope of the path the child is asked for", () => {
    it("accepts the API root and everything under it", () => {
        assert.equal(staysWithinApi("/api"), true);
        assert.equal(staysWithinApi("/api/config"), true);
        assert.equal(staysWithinApi("/api/storage/tests/history/json?from=1"), true);
    });

    it("accepts dot segments that stay inside the API", () => {
        assert.equal(staysWithinApi("/api/speedtests/../config"), true);
    });

    it("refuses dot segments that climb out of it", () => {
        assert.equal(staysWithinApi("/api/../x"), false);
        assert.equal(staysWithinApi("/api/../../x"), false);
        assert.equal(staysWithinApi("/api/config/../../x"), false);
    });

    it("refuses the spellings the parser folds into dot segments", () => {
        assert.equal(staysWithinApi("/api/%2e%2e/x"), false);
        assert.equal(staysWithinApi("/api/%2E%2E/x"), false);
        assert.equal(staysWithinApi("/api\\..\\x"), false);
        assert.equal(staysWithinApi("/api/.%2e/x"), false);
    });

    it("refuses a sibling that merely starts with the same letters", () => {
        assert.equal(staysWithinApi("/apifoo"), false);
        assert.equal(staysWithinApi("/api/../apifoo"), false);
    });

    it("refuses what does not parse as a path at all", () => {
        assert.equal(staysWithinApi(undefined), false);
        assert.equal(staysWithinApi(""), false);
    });
});

describe("the two places a node is reached", () => {
    it("refuses a proxied path that leaves the API before any request is made", () => {
        const handler = bodyOf(readSource("server/routes/nodes.js"), 'app.all("/:nodeId/*route"');
        const refusal = handler.indexOf("staysWithinApi(");
        const request = handler.indexOf("nodes.proxyRequest(");

        assert.notEqual(refusal, -1, "the proxy sends whatever path the parser makes of the request");
        assert.ok(refusal < request, "the scope is checked after the node has already been asked");
    });

    it("normalises the proxy target", () => {
        const handler = bodyOf(readSource("server/routes/nodes.js"), 'app.all("/:nodeId/*route"');

        assert.match(handler, /stripTrailingSlashes\(node\.url\)/,
            "the proxy concatenates the stored URL, so a trailing slash asks the child for //api/...");
        assert.match(handler, /childPath\(appPath\(req\)\)/,
            "the proxy folds the prefix itself, unanchored, rather than through childPath");
    });

    it("normalises the status check", () => {
        const check = bodyOf(readSource("server/controller/node.js"), "export const checkStatus");

        assert.match(check, /stripTrailingSlashes\(url\)/,
            "the status check concatenates the stored URL, so a trailing slash reports a healthy node as broken");
    });
});
