import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { postJson, postText } from "../../server/util/http.js";

const realError = console.error;
let logged = [];

beforeEach(() => {
    logged = [];
    console.error = (...args) => logged.push(args.join(" "));
});

afterEach(() => {
    console.error = realError;
});

/**
 * The failure report must not be able to fail.
 *
 * `report` built its message with `new URL(url).host` and was called from the
 * catch of both helpers - so when the reason the request failed *was* an
 * unparseable URL, the report threw again from inside the handler. postJson
 * rejected instead of answering null, and triggerEvent awaits each integration
 * in a bare loop, so every integration registered after the broken one silently
 * missed the event.
 *
 * The stored URL only has to match /https?:\/\/.+/, which the client applies
 * too, so the reachable cases are malformed authorities rather than paths: an
 * unbracketed IPv6 literal is a plausible thing for a self-hoster to type.
 */
const UNPARSEABLE = [
    "http://fd00::1:8086/write",
    "https://hc.exam ple.net/ping/uuid",
    "http://host:PORT/"
];

describe("an outbound call to an unparseable URL", () => {
    for (const url of UNPARSEABLE) {
        it(`answers null rather than throwing for ${url}`, async () => {
            assert.equal(await postJson(url, {hello: "world"}), null);
        });

        it(`answers null from postText for ${url}`, async () => {
            assert.equal(await postText(url, "hello"), null);
        });
    }

    it("still says which URL failed", async () => {
        await postJson("http://fd00::1:8086/write", {});

        assert.equal(logged.length, 1);
        assert.match(logged[0], /fd00::1:8086/);
    });

    it("marks the integration as failed", async () => {
        let failed = null;
        await postJson("http://fd00::1:8086/write", {}, {activity: (error) => { failed = error; }});

        assert.equal(failed, true);
    });
});
