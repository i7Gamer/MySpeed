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

    const answering = (props, onRead) => async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => { onRead?.(); return new ArrayBuffer(0); },
        ...props
    });

    /**
     * The body is read to the end rather than left, and rather than cancelled.
     *
     * Left unread it holds the message open; cancelled it aborts the fetch, and
     * a client that never received the whole message has to destroy the socket -
     * so the next notification in the same burst pays a fresh handshake, and
     * whether that happens turns on timing rather than size. Draining completes
     * the message and leaves the connection reusable.
     */
    it("reads the response body to the end", async () => {
        let read = false;
        globalThis.fetch = answering({}, () => { read = true; });

        await postJson("https://example.test/hook", {});
        assert.equal(read, true, "the body was left unread, holding the message open");
    });

    it("reads it on a refusal too", async () => {
        let read = false;
        globalThis.fetch = answering({ok: false, status: 429}, () => { read = true; });

        await postText("https://example.test/hook", "hello");
        assert.equal(read, true);
    });

    /**
     * And the helpers do not hand back the Response itself.
     *
     * Its body is spent by the time the caller sees it, so returning one offers
     * a shape whose whole point is already gone - the next person to write
     * `res.json()` would get "body is unusable" thrown from a file they were
     * not looking at. The outcome is what callers actually use.
     */
    it("answers with the outcome rather than a spent Response", async () => {
        globalThis.fetch = answering({});

        const result = await postJson("https://example.test/hook", {});

        assert.deepEqual(result, {ok: true, status: 200});
        assert.equal(result.json, undefined, "a Response with a drained body was handed back");
    });

    it("still reports a refusal by status", async () => {
        globalThis.fetch = answering({ok: false, status: 429});

        assert.deepEqual(await postText("https://example.test/hook", "hi"), {ok: false, status: 429});
    });

    // A 204 has no body at all, and neither does a response some runtimes
    // build for a HEAD - so the drain has to tolerate its absence.
    it("copes with a response that has no body", async () => {
        globalThis.fetch = async () => ({ok: true, status: 204});

        assert.deepEqual(await postJson("https://example.test/hook", {}), {ok: true, status: 204});
    });

    /**
     * `activity` writes a row - triggerEvent hands it a callback that awaits an
     * IntegrationData.update - and it was invoked bare, so a rejected write had
     * no handler and escaped to the process-level unhandledRejection hook. The
     * two sibling calls in the same controller carry a deliberate catch; this
     * path did not.
     */
    it("does not let a failing activity note escape", async () => {
        globalThis.fetch = answering({});

        const rejects = () => Promise.reject(new Error("SQLITE_BUSY"));

        await assert.doesNotReject(() => postJson("https://example.test/hook", {}, {activity: rejects}));
        await assert.doesNotReject(() => postText("https://example.test/hook", "hi", {activity: rejects}));
    });

    it("does not let a throwing activity note fail the send", async () => {
        globalThis.fetch = answering({});

        const throws = () => { throw new Error("no such integration"); };

        await assert.doesNotReject(() => postJson("https://example.test/hook", {}, {activity: throws}));
    });
});
