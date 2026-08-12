import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import setupHealthChecks from "../../server/integrations/healthChecks.js";
import setupNtfy from "../../server/integrations/ntfy.js";

/**
 * Two ways a correctly configured notification never arrived.
 *
 * healthChecks built its endpoint as `${c.url}/${path}`, so a url ending in a
 * slash - which is what a browser gives you when you copy one out of the
 * address bar - produced `https://hc-ping.com/uuid//start`. The ntfy module
 * beside it already strips trailing slashes with the shared helper; this one
 * simply never did.
 *
 * ntfy puts the title and the tags into HTTP headers verbatim. Header values
 * cannot contain a newline, so undici throws TypeError: Invalid character in
 * header content before the request leaves the process - and postText catches
 * it, logs it and returns null, so the ping was silently dropped with the
 * integration still showing as configured.
 */
const realFetch = globalThis.fetch;

let sent = [];

beforeEach(() => {
    sent = [];
    globalThis.fetch = async (url, init = {}) => {
        // Node builds real Headers from this before the request goes out, and
        // that is where an illegal value is rejected. Doing it here means the
        // stub fails the same way the real client would.
        new Headers(init.headers ?? {});

        sent.push({url: String(url), headers: init.headers ?? {}, body: init.body});
        return new Response("{}", {status: 200});
    };
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

const load = (setup) => {
    const events = {};
    const definition = setup((name, callback) => { events[name] = callback; });
    return {events, definition};
};

const fire = (events, name, config, payload) => events[name]({data: config}, payload, () => {});

const RESULT = {ping: 12, jitter: 2, download: 100, upload: 50};

describe("healthChecks", () => {
    const {events} = load(setupHealthChecks);

    it("builds a clean endpoint from a plain url", async () => {
        await fire(events, "testStarted", {url: "https://hc-ping.com/uuid"});

        assert.equal(sent[0].url, "https://hc-ping.com/uuid/start");
    });

    it("does not double the slash on a url that ends with one", async () => {
        await fire(events, "testStarted", {url: "https://hc-ping.com/uuid/"});

        assert.equal(sent[0].url, "https://hc-ping.com/uuid/start",
            "the ping went to a path with an empty segment in it, which is a 404");
    });

    it("strips however many slashes were pasted", async () => {
        await fire(events, "testFailed", {url: "https://hc-ping.com/uuid///"}, "boom");

        assert.equal(sent[0].url, "https://hc-ping.com/uuid/fail");
    });

    // The pathless events post to the url itself, and it has to stay usable.
    it("still posts the bare url for an event with no path", async () => {
        await fire(events, "testFinished", {url: "https://hc-ping.com/uuid/"}, RESULT);

        assert.equal(sent[0].url, "https://hc-ping.com/uuid");
    });
});

describe("ntfy headers", () => {
    const {events} = load(setupNtfy);

    const config = (extra) => ({
        url: "https://ntfy.sh", topic: "myspeed", send_finished: true, send_failed: true, ...extra
    });

    it("sends the title and tags it was given", async () => {
        await fire(events, "testFinished", config({title: "MySpeed", tags: "white_check_mark"}), RESULT);

        assert.equal(sent[0].headers["Title"], "MySpeed");
        assert.equal(sent[0].headers["Tags"], "white_check_mark");
    });

    it("does not let a newline in the title kill the request", async () => {
        await fire(events, "testFinished", config({title: "MySpeed\nreport"}), RESULT);

        assert.equal(sent.length, 1, "the request never went out");
        assert.doesNotMatch(sent[0].headers["Title"], /[\r\n]/);
    });

    it("does not let a carriage return in the tags kill the request", async () => {
        await fire(events, "testFinished", config({tags: "one\r\ntwo"}), RESULT);

        assert.equal(sent.length, 1);
        assert.doesNotMatch(sent[0].headers["Tags"], /[\r\n]/);
    });

    /**
     * A header value that is split across lines is how a request smuggles a
     * second header in. The stored value only has to be a string of at most 250
     * characters, so this is reachable from the integration form.
     */
    it("leaves nothing behind that could pass for another header", async () => {
        await fire(events, "testFinished", config({title: "x\r\nX-Injected: yes"}), RESULT);

        assert.doesNotMatch(sent[0].headers["Title"], /[\r\n]/);
    });

    /**
     * A header value is Latin-1 on the wire. undici rejects any code point
     * above U+00FF just as flatly as it rejects a newline, so stripping only
     * CR/LF left the same failure in place for the more likely input: ntfy's
     * own documentation shows emoji titles, and a German or Cyrillic instance
     * name is ordinary.
     */
    it("does not let an emoji in the title kill the request", async () => {
        await fire(events, "testFinished", config({title: "MySpeed ✅"}), RESULT);

        assert.equal(sent.length, 1, "the request never went out");
    });

    it("does not let non-latin text in the tags kill the request", async () => {
        await fire(events, "testFinished", config({tags: "Geschwindigkeit-Прогресс"}), RESULT);

        assert.equal(sent.length, 1, "the request never went out");
    });

    it("keeps a plain ascii title exactly as it was typed", async () => {
        await fire(events, "testFinished", config({title: "Speedtest report"}), RESULT);

        assert.equal(sent[0].headers["Title"], "Speedtest report");
    });

    it("keeps latin-1 accents, which the wire encoding can carry", async () => {
        await fire(events, "testFinished", config({title: "Réseau"}), RESULT);

        assert.equal(sent[0].headers["Title"], "Réseau");
    });

    it("still sends the priority it was configured with", async () => {
        await fire(events, "testFinished", config({priority: "4"}), RESULT);

        assert.equal(sent[0].headers["Priority"], "4");
    });
});
