import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bodyOf, readSource } from "../helpers/source.js";
import { stripTrailingSlashes } from "../../server/util/helpers.js";

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

describe("the two places a node is reached", () => {
    it("normalises the proxy target", () => {
        const handler = bodyOf(readSource("server/routes/nodes.js"), 'app.all("/:nodeId/*route"');

        assert.match(handler, /stripTrailingSlashes\(node\.url\)/,
            "the proxy concatenates the stored URL, so a trailing slash asks the child for //api/...");
    });

    it("normalises the status check", () => {
        const check = bodyOf(readSource("server/controller/node.js"), "export const checkStatus");

        assert.match(check, /stripTrailingSlashes\(url\)/,
            "the status check concatenates the stored URL, so a trailing slash reports a healthy node as broken");
    });
});
