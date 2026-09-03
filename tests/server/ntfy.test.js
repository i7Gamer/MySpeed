import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import setupNtfy from "../../server/integrations/ntfy.js";

let receiver;
let baseUrl;
let received = [];

/** Stands in for an ntfy server, so the real outbound request can be observed. */
before(async () => {
    receiver = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
            received.push({url: req.url, method: req.method, headers: req.headers, body});
            res.writeHead(200).end("ok");
        });
    });

    await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${receiver.address().port}`;
});

after(() => new Promise((resolve) => receiver.close(resolve)));

beforeEach(() => { received = []; });

/** Registers the module and hands back the callbacks it declared. */
const load = () => {
    const events = {};
    const definition = setupNtfy((name, callback) => { events[name] = callback; });
    return {events, definition};
};

const RESULT = {ping: 10, jitter: 2, download: 100, upload: 50};

describe("ntfy integration", () => {
    /**
     * Regression: send() called stripTrailingSlashes without importing it. Every
     * notification threw a ReferenceError, which escaped the integration
     * callback, escaped triggerEvent, and surfaced as an unhandled rejection -
     * and the handler for those called process.exit. Any instance with ntfy
     * configured crash-looped on every completed test.
     */
    it("sends a finished notification without throwing", async () => {
        const {events} = load();

        await events.testFinished({data: {url: baseUrl, topic: "alerts", send_finished: true}}, RESULT, () => {});

        assert.equal(received.length, 1);
        assert.equal(received[0].method, "POST");
    });

    it("posts to the topic under the configured url", async () => {
        const {events} = load();

        await events.testFinished({data: {url: baseUrl, topic: "alerts", send_finished: true}}, RESULT, () => {});

        assert.equal(received[0].url, "/alerts");
    });

    // The reason stripTrailingSlashes is there at all: a user who types the URL
    // with a trailing slash would otherwise post to "//alerts".
    it("tolerates a trailing slash on the url", async () => {
        const {events} = load();

        await events.testFinished({data: {url: `${baseUrl}///`, topic: "alerts", send_finished: true}}, RESULT, () => {});

        assert.equal(received[0].url, "/alerts");
    });

    it("fills the placeholders of the message", async () => {
        const {events} = load();

        await events.testFinished({data: {url: baseUrl, topic: "alerts", send_finished: true}}, RESULT, () => {});

        assert.match(received[0].body, /100/);
        assert.doesNotMatch(received[0].body, /%download%/);
    });

    it("carries the token as a bearer credential when one is set", async () => {
        const {events} = load();

        await events.testFinished(
            {data: {url: baseUrl, topic: "alerts", send_finished: true, token: "tk_secret"}}, RESULT, () => {});

        assert.equal(received[0].headers.authorization, "Bearer tk_secret");
    });

    it("stays quiet when the notification is switched off", async () => {
        const {events} = load();

        await events.testFinished({data: {url: baseUrl, topic: "alerts", send_finished: false}}, RESULT, () => {});

        assert.equal(received.length, 0);
    });

    it("sends the failure notification too", async () => {
        const {events} = load();

        await events.testFailed({data: {url: baseUrl, topic: "alerts", send_failed: true}}, {error: "Network unreachable"}, () => {});

        assert.equal(received.length, 1);
        assert.match(received[0].body, /Network unreachable/);
    });

    it("declares the token as a credential so exports redact it", () => {
        const {definition} = load();
        const token = definition.fields.find((field) => field.name === "token");

        assert.equal(token.secret, true);
    });

    /**
     * Regression: the priority went into the header as String(parseInt(value)),
     * so a value the form's 1-5 regex never allows but a config import writes
     * unvalidated - "high", say - reached ntfy as the literal header
     * "Priority: NaN", which it rejects, losing the notification. A priority
     * that is not a number is dropped now, the way an absent one already is.
     */
    it("omits a non-numeric priority rather than sending the header NaN", async () => {
        const {events} = load();

        await events.testFinished(
            {data: {url: baseUrl, topic: "alerts", send_finished: true, priority: "high"}}, RESULT, () => {});

        assert.equal(received.length, 1);
        assert.notEqual(received[0].headers.priority, "NaN",
            "a non-numeric priority is sent as the literal header NaN");
    });

    it("still sends a valid priority through", async () => {
        const {events} = load();

        await events.testFinished(
            {data: {url: baseUrl, topic: "alerts", send_finished: true, priority: "4"}}, RESULT, () => {});

        assert.equal(received[0].headers.priority, "4");
    });

    /**
     * Parsing to a number was never the question ntfy asks.
     *
     * The guard above only proved the value was an integer, and an out-of-range
     * one is every bit as fatal on the wire as "NaN" was: ntfy accepts 1 to 5 -
     * which is what the field's own regex says - and answers 400 to anything
     * else, so the notification is lost outright. The values that get here are
     * the ones the form never sees: a config import writes the field
     * unvalidated, and "0", "7" and "-3" are all truthy, so they survive the
     * callers' `c.priority || 3` fallback intact and go out as a header the
     * server refuses. Dropped like a non-numeric one instead, which delivers at
     * ntfy's own default rather than not at all.
     */
    for (const priority of ["0", "7", "-3"]) {
        it(`omits the priority ${priority}, which is outside ntfy's 1-5 range`, async () => {
            const {events} = load();

            await events.testFinished(
                {data: {url: baseUrl, topic: "alerts", send_finished: true, priority}}, RESULT, () => {});

            assert.equal(received.length, 1);
            assert.equal(received[0].headers.priority, undefined,
                `ntfy answers 400 to the priority ${priority}, losing the notification`);
        });
    }

    /**
     * The token is free text like the title beside it - it declares no regex,
     * and a config import writes the field with no validation at all. A pasted
     * credential carrying a stray newline or a character above U+00FF made
     * undici throw before the request left the process, so every notification
     * was lost to a log line while the card went on showing the integration as
     * configured.
     */
    it("sends despite a token carrying a character a header cannot hold", async () => {
        const {events} = load();

        await events.testFinished(
            {data: {url: baseUrl, topic: "alerts", send_finished: true, token: "tk—en\nx"}},
            RESULT, () => {});

        assert.equal(received.length, 1, "the whole notification was lost to an unsendable header");
        assert.equal(received[0].headers.authorization, "Bearer tken x");
    });

    it("leaves an ordinary token exactly as it was typed", async () => {
        const {events} = load();

        await events.testFinished(
            {data: {url: baseUrl, topic: "alerts", send_finished: true, token: "tk_abc123"}},
            RESULT, () => {});

        assert.equal(received[0].headers.authorization, "Bearer tk_abc123");
    });

    // The ends of the range itself, so the fix cannot be an off-by-one that
    // quietly drops the two priorities an operator is most likely to choose.
    for (const priority of ["1", "5"]) {
        it(`still sends the boundary priority ${priority}`, async () => {
            const {events} = load();

            await events.testFinished(
                {data: {url: baseUrl, topic: "alerts", send_finished: true, priority}}, RESULT, () => {});

            assert.equal(received[0].headers.priority, priority);
        });
    }
});
