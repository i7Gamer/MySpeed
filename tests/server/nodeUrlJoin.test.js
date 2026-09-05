import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bodyOf, readSource } from "../helpers/source.js";
import { stripTrailingSlashes } from "../../server/util/helpers.js";
import { childPath } from "../../server/util/nodePath.js";

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

    it("folds only the prefix that opens the path", () => {
        assert.equal(childPath("/api/nodes/5/config?next=/api/nodes/5/x"), "/api/config?next=/api/nodes/5/x");
    });

    it("leaves a path without the prefix alone", () => {
        assert.equal(childPath("/api/config"), "/api/config");
    });
});

describe("the two places a node is reached", () => {
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
