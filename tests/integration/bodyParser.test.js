import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { bootServer, api } from "./helpers/boot.js";

let server;

before(async () => {
    server = await bootServer();
});

after(async () => {
    await server?.close();
});

describe("body parser errors", () => {
    const post = (body, headers) => api(server.baseUrl, "/speedtests/pause", {
        method: "POST",
        headers: {"content-type": "application/json", ...headers},
        body
    });

    it("answers malformed JSON with 400", async () => {
        const {status, body} = await post("{not json");
        assert.equal(status, 400);
        assert.match(body.message, /valid JSON body/);
    });

    /**
     * Regression: the error middleware used to call bare next() for anything
     * that was not a SyntaxError. Inside an Express error handler that resumes
     * the *normal* chain rather than ending the request, so an undecodable body
     * reached the route with req.body undefined and came back as a 500 with a
     * stack trace instead of body-parser's own 400.
     */
    it("answers an undecodable body without running the route", async () => {
        const {status, body} = await post('{"resumeIn":1}', {"content-encoding": "br"});

        assert.equal(status, 400);
        assert.doesNotMatch(body?.message ?? "", /paused/i);
        assert.equal((await api(server.baseUrl, "/speedtests/status")).body.paused, false);
    });

    it("never leaks a stack trace in the response body", async () => {
        const {text} = await post('{"resumeIn":1}', {"content-encoding": "br"});
        assert.doesNotMatch(text, /at .*\.js:\d+/);
    });
});

/**
 * Under body-parser 2.x an unparsed request leaves `req.body` undefined; 1.x
 * defaulted it to {}. The three node write endpoints still read it straight -
 * `if (!req.body.name || !req.body.url)` - so the guard itself threw a
 * TypeError and Express answered its generic 500 with no `type` field, where
 * the caller had asked for exactly the 400 that guard exists to give.
 *
 * Not reachable from the UI, which always sends a JSON content type. It is the
 * script and curl callers - the ones reading the `type` field - that met it.
 */
describe("a request that carries no body at all", () => {
    const bodyless = (pathname, method = "PUT") => api(server.baseUrl, pathname, {method});

    it("answers the node create endpoint with 400", async () => {
        const {status, body} = await bodyless("/nodes");

        assert.equal(status, 400);
        assert.equal(body.type, "MISSING_PARAMETERS");
    });

    it("answers the rename endpoint with 400", async () => {
        const {status, body} = await bodyless("/nodes/1/name", "PATCH");

        assert.equal(status, 400);
        assert.equal(body.type, "MISSING_PARAMETERS");
    });

    it("answers the node password endpoint with 400", async () => {
        const {status, body} = await bodyless("/nodes/1/password", "PATCH");

        assert.equal(status, 400);
        assert.equal(body.type, "MISSING_PARAMETERS");
    });

    it("never answers one of them with a 500", async () => {
        for (const [pathname, method] of [["/nodes", "PUT"], ["/nodes/1/name", "PATCH"],
            ["/nodes/1/password", "PATCH"]])
            assert.notEqual((await bodyless(pathname, method)).status, 500, `${method} ${pathname}`);
    });
});
