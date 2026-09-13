import assert from "node:assert/strict";
import {describe, it} from "node:test";
import * as checker from "../../scripts/qualification/check-artifact.mjs";
import {CONFIG_SENTINEL, SYNTHETIC_PASSWORD, TEST_RESULT_SENTINEL}
    from "../../scripts/qualification/fixture.mjs";

const ORIGIN = "http://127.0.0.1:17439";
const COOKIE = "qualification=synthetic";
const PNG_BYTES = 64;
const PNG_WIDTH = 1200;
const PNG_HEIGHT = 600;
const HTML_PADDING = 150;
const JAVASCRIPT_PADDING = 40;

const response = (body, type = "application/json", extraHeaders = {}) => ({status: 200,
    bytes: Buffer.isBuffer(body) ? body : Buffer.from(type === "application/json" ? JSON.stringify(body) : body),
    headers: new Map(Object.entries({"content-type": type, ...extraHeaders}))});

const fixture = (mutate = () => {}) => {
    const png = Buffer.alloc(PNG_BYTES, 1);
    Buffer.from("89504e470d0a1a0a", "hex").copy(png);
    png.writeUInt32BE(13, 8);
    png.write("IHDR", 12, "ascii");
    png.writeUInt32BE(PNG_WIDTH, 16);
    png.writeUInt32BE(PNG_HEIGHT, 20);
    const replies = [
        response({status: "ok", database: "up"}),
        response({message: "Signed in"}, "application/json", {"set-cookie": `${COOKIE}; HttpOnly`}),
        response({active: true}),
        response({ping: CONFIG_SENTINEL, passwordSet: true}),
        response([{resultId: TEST_RESULT_SENTINEL}]),
        response({testCount: 1}),
        response(`<script src="/assets/app.js"></script>${" ".repeat(HTML_PADDING)}`, "text/html"),
        response(`/*${"x".repeat(JAVASCRIPT_PADDING)}*/`, "application/javascript"),
        response(png, "image/png")
    ];
    mutate(replies);
    const calls = [];
    const request = async (origin, route, options = {}) => {
        assert.equal(origin, ORIGIN);
        const reply = replies[calls.length];
        calls.push({route, options});
        assert.ok(reply, "no unexpected request or production network call");
        return reply;
    };
    return {calls, request};
};

describe("shared populated artifact oracle", () => {
    it("exports the same full assertion body used by standalone qualification", () => {
        assert.equal(typeof checker.checkPopulatedInstance, "function");
    });

    it("checks authenticated API data, every client asset and PNG using only the supplied transport", async () => {
        const harness = fixture();
        const result = await checker.checkPopulatedInstance(ORIGIN, {request: harness.request});
        assert.equal(typeof result.elapsedMs, "number");
        assert.deepEqual(harness.calls.map(({route}) => route), ["/api/health", "/api/session", "/api/session",
            "/api/config", "/api/speedtests?limit=10", "/api/storage", "/", "/assets/app.js", "/api/opengraph/image"]);
        assert.deepEqual(JSON.parse(harness.calls[1].options.body), {password: SYNTHETIC_PASSWORD});
        assert.equal(harness.calls[1].options.method, "POST");
        for (const index of [2, 3, 4, 5, 8]) assert.equal(harness.calls[index].options.headers.cookie, COOKIE);
    });

    it("checks each distinct local client script and preserves request failures", async () => {
        const harness = fixture(values => {
            values[6] = response('<script src="/assets/app.js"></script><script src="/assets/vendor.js"></script>' +
                " ".repeat(HTML_PADDING), "text/html");
            values.splice(8, 0, response(`/*${"v".repeat(JAVASCRIPT_PADDING)}*/`, "application/javascript"));
        });
        await checker.checkPopulatedInstance(ORIGIN, {request: harness.request});
        assert.deepEqual(harness.calls.slice(-3).map(({route}) => route),
            ["/assets/app.js", "/assets/vendor.js", "/api/opengraph/image"]);
        const failure = new Error("synthetic transport failure");
        await assert.rejects(checker.checkPopulatedInstance(ORIGIN, {request: async () => { throw failure; }}),
            error => error === failure);
    });

    for (const [name, mutate, pattern] of [
        ["unhealthy database", values => { values[0] = response({status: "ok", database: "down"}); }, /database/i],
        ["missing cookie", values => { values[1].headers.delete("set-cookie"); }, /cookie/i],
        ["inactive session", values => { values[2] = response({active: false}); }, /active/i],
        ["lost configuration", values => { values[3] = response({ping: "changed", passwordSet: true}); }, /ping/i],
        ["history HTTP failure", values => { values[4].status = 503; }, /HTTP 503/],
        ["missing synthetic row", values => { values[4] = response([]); }, /synthetic row/],
        ["malformed history", values => { values[4] = response({resultId: TEST_RESULT_SENTINEL}); }, /synthetic row/],
        ["invalid storage count", values => { values[5] = response({testCount: 0}); }, /synthetic database row/],
        ["fractional storage count", values => { values[5] = response({testCount: 1.5}); }, /synthetic database row/],
        ["absent client", values => { values[6].status = 404; }, /HTML/],
        ["short client", values => { values[6].bytes = Buffer.from("short"); }, /HTML/],
        ["wrong client type", values => { values[6].headers.set("content-type", "text/plain"); }, /HTML/],
        ["missing JavaScript", values => { values[7].status = 404; }, /JavaScript/],
        ["short JavaScript", values => { values[7].bytes = Buffer.from("short"); }, /JavaScript/],
        ["wrong JavaScript type", values => { values[7].headers.set("content-type", "text/plain"); }, /JavaScript/],
        ["wrong PNG content type", values => { values[8].headers.set("content-type", "text/plain"); }, /PNG/],
        ["invalid PNG bytes", values => { values[8].bytes = Buffer.from("not a PNG"); }, /PNG/]
    ]) it(`rejects ${name} without accepting a reduced assertion set`, async () => {
        const harness = fixture(mutate);
        await assert.rejects(checker.checkPopulatedInstance(ORIGIN, {request: harness.request}), pattern);
    });
});
