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

/**
 * The response body is finished with, and the activity note cannot take the
 * process down.
 */
describe("what an outbound call leaves behind", () => {
    const realFetch = globalThis.fetch;

    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    /**
     * Neither helper consumed or cancelled the body it got back, and no caller
     * in any of the eight integrations reads the return value - so on undici the
     * transport stayed checked out of the pool with the bytes buffered until the
     * Response was garbage collected. Discord, Telegram and Gotify all answer
     * with the created message, and healthChecks fires every minute.
     */
    it("releases the response body", async () => {
        let cancelled = false;

        globalThis.fetch = async () => ({
            ok: true,
            status: 200,
            body: {cancel: async () => { cancelled = true; }}
        });

        await postJson("https://example.test/hook", {});
        assert.equal(cancelled, true, "the body was left unread, holding the connection until GC");
    });

    it("releases it on a refusal too", async () => {
        let cancelled = false;

        globalThis.fetch = async () => ({
            ok: false,
            status: 429,
            body: {cancel: async () => { cancelled = true; }}
        });

        await postText("https://example.test/hook", "hello");
        assert.equal(cancelled, true);
    });

    // A 204 has no body at all, and neither does a response some runtimes
    // build for a HEAD - so the release has to tolerate its absence.
    it("copes with a response that has no body", async () => {
        globalThis.fetch = async () => ({ok: true, status: 204, body: null});

        assert.notEqual(await postJson("https://example.test/hook", {}), null);
    });

    /**
     * `activity` writes a row - triggerEvent hands it a callback that awaits an
     * IntegrationData.update - and it was invoked bare, so a rejected write had
     * no handler and escaped to the process-level unhandledRejection hook. The
     * two sibling calls in the same controller carry a deliberate catch; this
     * path did not.
     */
    it("does not let a failing activity note escape", async () => {
        globalThis.fetch = async () => ({ok: true, status: 200, body: null});

        const rejects = () => Promise.reject(new Error("SQLITE_BUSY"));

        await assert.doesNotReject(() => postJson("https://example.test/hook", {}, {activity: rejects}));
        await assert.doesNotReject(() => postText("https://example.test/hook", "hi", {activity: rejects}));
    });

    it("does not let a throwing activity note fail the send", async () => {
        globalThis.fetch = async () => ({ok: true, status: 200, body: null});

        const throws = () => { throw new Error("no such integration"); };

        await assert.doesNotReject(() => postJson("https://example.test/hook", {}, {activity: throws}));
    });
});
