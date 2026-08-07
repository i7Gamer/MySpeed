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

        await events.testFailed({data: {url: baseUrl, topic: "alerts", send_failed: true}}, "Network unreachable", () => {});

        assert.equal(received.length, 1);
        assert.match(received[0].body, /Network unreachable/);
    });

    it("declares the token as a credential so exports redact it", () => {
        const {definition} = load();
        const token = definition.fields.find((field) => field.name === "token");

        assert.equal(token.secret, true);
    });
});
