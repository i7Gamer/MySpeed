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
