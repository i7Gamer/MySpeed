import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import setupDiscord from "../../server/integrations/discord.js";
import setupGotify from "../../server/integrations/gotify.js";
import setupPushover from "../../server/integrations/pushover.js";
import setupWebhook from "../../server/integrations/webhook.js";
import setupHealthChecks from "../../server/integrations/healthChecks.js";

/**
 * These modules are what actually reaches the user when a speedtest finishes or
 * fails, and none of them had a test. Several post to a fixed provider URL, so
 * fetch is stubbed rather than pointed at a local server: nothing here may make
 * a real request, and the stub records exactly what would have gone out.
 */
const realFetch = globalThis.fetch;

let sent = [];

beforeEach(() => {
    sent = [];
    globalThis.fetch = async (url, init = {}) => {
        let body = init.body;
        try {
            body = JSON.parse(init.body);
        } catch {

        }

        sent.push({url: String(url), headers: init.headers ?? {}, body});
        return new Response("{}", {status: 200, headers: {"content-type": "application/json"}});
    };
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

/** Registers a module and hands back the event callbacks it declared. */
const load = (setup) => {
    const events = {};
    const definition = setup((name, callback) => { events[name] = callback; });
    return {events, definition};
};

const RESULT = {ping: 12, jitter: 2, download: 100, upload: 50};
const fire = (events, name, config, payload) => events[name]({data: config}, payload, () => {});

describe("discord", () => {
    const config = {url: "https://discord.com/api/webhooks/1/token", send_finished: true, send_failed: true};

    it("posts an embed to the configured webhook", async () => {
        const {events} = load(setupDiscord);
        await fire(events, "testFinished", config, RESULT);

        assert.equal(sent.length, 1);
        assert.equal(sent[0].url, config.url);
        assert.match(sent[0].body.embeds[0].description, /100/);
    });

    // Discord documents a User-Agent as required and its edge rejects requests
    // that arrive without one; node's fetch supplies no default.
    it("identifies itself on every request", async () => {
        const {events} = load(setupDiscord);
        await fire(events, "testFinished", config, RESULT);
        await fire(events, "testFailed", config, "boom");

        for (const request of sent) assert.match(request.headers["user-agent"], /^MySpeed/);
    });

    it("substitutes every measurement into the default message", async () => {
        const {events} = load(setupDiscord);
        await fire(events, "testFinished", config, RESULT);

        const {description} = sent[0].body.embeds[0];
        for (const value of [12, 2, 100, 50]) assert.match(description, new RegExp(String(value)));
        assert.doesNotMatch(description, /%[a-z]+%/, "an unsubstituted placeholder was sent");
    });

    it("uses the operator's own failure message", async () => {
        const {events} = load(setupDiscord);
        await fire(events, "testFailed", {...config, error_message: "down: %error%"}, "no route to host");

        assert.equal(sent[0].body.embeds[0].description, "down: no route to host");
    });

    it("sends nothing when the event is switched off", async () => {
        const {events} = load(setupDiscord);
        await fire(events, "testFinished", {...config, send_finished: false}, RESULT);
        await fire(events, "testFailed", {...config, send_failed: false}, "boom");

        assert.deepEqual(sent, []);
    });

    it("declares the webhook url as a secret", () => {
        const {definition} = load(setupDiscord);
        assert.equal(definition.fields.find((field) => field.name === "url").secret, true);
    });
});

describe("gotify", () => {
    const config = {url: "https://gotify.example.net", key: "123456789012345", priority: "5", send_finished: true, send_failed: true};

    it("posts to the message endpoint with the token as a bearer", async () => {
        const {events} = load(setupGotify);
        await fire(events, "testFinished", config, RESULT);

        assert.equal(sent[0].url, "https://gotify.example.net/message");
        assert.equal(sent[0].headers.Authorization, "Bearer 123456789012345");
    });

    it("sends the configured priority as a number", async () => {
        const {events} = load(setupGotify);
        await fire(events, "testFinished", config, RESULT);

        assert.equal(sent[0].body.priority, 5);
    });

    it("raises the priority for a failure", async () => {
        const {events} = load(setupGotify);
        await fire(events, "testFailed", config, "boom");

        assert.equal(sent[0].body.priority, 8);
        assert.match(sent[0].body.message, /boom/);
    });
});

describe("pushover", () => {
    const config = {token: "a".repeat(30), user_key: "b".repeat(30), send_finished: true, send_failed: true};

    it("posts the credentials to the pushover api", async () => {
        const {events} = load(setupPushover);
        await fire(events, "testFinished", config, RESULT);

        assert.equal(sent[0].url, "https://api.pushover.net/1/messages.json");
        assert.equal(sent[0].body.token, config.token);
        assert.equal(sent[0].body.user, config.user_key, "the field is user_key locally but `user` on the wire");
    });

    it("declares both credentials as secrets", () => {
        const {definition} = load(setupPushover);
        const secrets = definition.fields.filter((field) => field.secret).map((field) => field.name);

        assert.deepEqual(secrets.sort(), ["token", "user_key"]);
    });
});

describe("webhook", () => {
    const config = {url: "https://hooks.example.net/in"};

    it("labels each event with its own type", async () => {
        const {events} = load(setupWebhook);

        await fire(events, "testFinished", {...config, send_finished: true}, RESULT);
        await fire(events, "testFailed", {...config, send_failed: true}, "boom");
        await fire(events, "testStarted", {...config, send_started: true}, undefined);

        assert.deepEqual(sent.map((request) => request.body.event), ["TEST_FINISHED", "TEST_FAILED", "TEST_STARTED"]);
    });

    it("wraps a failure reason in an object rather than sending a bare string", async () => {
        const {events} = load(setupWebhook);
        await fire(events, "testFailed", {...config, send_failed: true}, "no route to host");

        assert.deepEqual(sent[0].body.data, {error: "no route to host"});
    });

    it("identifies itself", async () => {
        const {events} = load(setupWebhook);
        await fire(events, "testFinished", {...config, send_finished: true}, RESULT);

        assert.match(sent[0].headers["user-agent"], /MySpeed/);
    });

    it("respects every per-event switch", async () => {
        const {events} = load(setupWebhook);

        for (const name of Object.keys(events)) await fire(events, name, config, RESULT);
        assert.deepEqual(sent, [], "an event fired with all switches off");
    });
});

describe("health checks", () => {
    const config = {url: "https://hc.example.net/ping/uuid"};

    it("pings the bare url when a test finishes", async () => {
        const {events} = load(setupHealthChecks);
        await fire(events, "testFinished", config, RESULT);

        assert.equal(sent[0].url, config.url);
    });

    it("uses the /start and /fail sub-paths for the other events", async () => {
        const {events} = load(setupHealthChecks);

        await fire(events, "testStarted", config, undefined);
        await fire(events, "testFailed", config, "boom");

        assert.deepEqual(sent.map((request) => request.url),
            [`${config.url}/start`, `${config.url}/fail`]);
    });

    // Without a url there is nothing to ping, and postJson would be handed
    // undefined - a request to the server's own origin.
    it("sends nothing when no url is configured", async () => {
        const {events} = load(setupHealthChecks);
        await fire(events, "testFinished", {}, RESULT);

        assert.deepEqual(sent, []);
    });

    it("always sends a body, even for an event that carries no payload", async () => {
        const {events} = load(setupHealthChecks);
        await fire(events, "minutePassed", config, undefined);

        assert.deepEqual(sent[0].body, {});
    });
});

describe("every integration", () => {
    const modules = {
        discord: setupDiscord, gotify: setupGotify, pushover: setupPushover,
        webhook: setupWebhook, healthChecks: setupHealthChecks
    };

    it("declares an icon and at least one field", () => {
        for (const [name, setup] of Object.entries(modules)) {
            const {definition} = load(setup);

            assert.ok(definition.icon, `${name} has no icon`);
            assert.ok(definition.fields.length > 0, `${name} declares no fields`);
        }
    });

    // withoutSecrets in the controller blanks exactly the fields flagged here,
    // so a credential that is not flagged is one that leaks into every export.
    it("flags its credential fields as secret", () => {
        for (const [name, setup] of Object.entries(modules)) {
            const {definition} = load(setup);
            const secrets = definition.fields.filter((field) => field.secret).map((field) => field.name);

            assert.ok(secrets.length > 0, `${name} flags no field as secret`);
        }
    });

    it("gives every field a name and a type", () => {
        for (const [name, setup] of Object.entries(modules)) {
            const {definition} = load(setup);

            for (const field of definition.fields) {
                assert.ok(field.name, `${name} has a field with no name`);
                assert.ok(field.type, `${name}.${field.name} has no type`);
            }
        }
    });
});
