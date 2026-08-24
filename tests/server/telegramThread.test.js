import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import setupTelegram from "../../server/integrations/telegram.js";

/**
 * A monitoring supergroup divided into topics, which is upstream #1176.
 *
 * Telegram's forum groups give each topic its own id, and sendMessage puts a
 * message in one by carrying `message_thread_id`. Without it every notification
 * lands in the group's General topic - so an operator who has sorted their
 * infrastructure alerts by service has MySpeed shouting into the lobby.
 *
 * The field is optional, because an ordinary group and a channel have no topics
 * at all and Telegram answers a `message_thread_id` they cannot honour with a
 * 400 - which would drop the notification entirely rather than misfile it.
 */
const realFetch = globalThis.fetch;

let sent = [];

beforeEach(() => {
    sent = [];
    globalThis.fetch = async (url, init = {}) => {
        sent.push({url: String(url), body: JSON.parse(init.body)});
        return new Response("{}", {status: 200, headers: {"content-type": "application/json"}});
    };
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

const load = () => {
    const events = {};
    const definition = setupTelegram((name, callback) => { events[name] = callback; });

    return {events, definition};
};

const RESULT = {ping: 12, jitter: 2, download: 100, upload: 50};
const BASE = {token: "1:abc", chat_id: "-1001234567890", send_finished: true, send_failed: true};

const fire = (events, name, config, payload) => events[name]({data: config}, payload, () => {});

const finish = async (overrides = {}) => {
    const {events} = load();
    await fire(events, "testFinished", {...BASE, ...overrides}, RESULT);

    return sent[0];
};

describe("the telegram topic", () => {
    it("is carried on a finished test when one is configured", async () => {
        const request = await finish({message_thread_id: "42"});

        assert.equal(request.body.message_thread_id, "42");
    });

    it("is carried on a failure too", async () => {
        const {events} = load();
        await fire(events, "testFailed", {...BASE, message_thread_id: "42"}, {error: "boom"});

        assert.equal(sent[0].body.message_thread_id, "42",
            "the alert that matters most is the one that goes to the wrong topic");
    });

    /**
     * Absent rather than null. Telegram rejects a `message_thread_id` a chat
     * has no topics for, and a group that is not a forum is the ordinary case -
     * so sending the key at all would answer 400 and deliver nothing, which is
     * strictly worse than the General topic this replaces.
     */
    it("is left out entirely when none is configured", async () => {
        const request = await finish();

        assert.ok(!("message_thread_id" in request.body),
            "an unconfigured topic is still named in the request");
    });

    /**
     * The same, for the shapes a stored row can actually hold. A row written
     * before the field existed has no key at all; one saved with the input
     * cleared has the empty string, since that is what a text field submits.
     */
    it("is left out for a value that names no topic", async () => {
        for (const value of ["", null, undefined]) {
            sent = [];
            const request = await finish({message_thread_id: value});

            assert.ok(!("message_thread_id" in request.body),
                `${JSON.stringify(value)} was sent as a topic id`);
        }
    });
});

describe("the topic field", () => {
    const fieldNamed = (name) => load().definition.fields.find((field) => field.name === name);

    it("is declared, and optional", () => {
        const field = fieldNamed("message_thread_id");

        assert.ok(field, "the field is not offered in the dialog at all");
        assert.equal(field.required, false);
    });

    /**
     * A topic id is a positive integer. Unlike chat_id it is never negative -
     * that spelling belongs to the group itself - so accepting one would store a
     * value Telegram answers 400 to, behind a save that reported success.
     */
    it("accepts a topic id and refuses what is not one", () => {
        const {regex} = fieldNamed("message_thread_id");

        assert.ok(regex.test("42"));
        assert.ok(regex.test("1"));

        for (const bad of ["-42", "0x2a", "4 2", "abc", "42a", " 42", "1.5"])
            assert.ok(!regex.test(bad), `${JSON.stringify(bad)} was accepted as a topic id`);
    });

    // It is not a credential: a topic id says nothing that the chat id beside it
    // does not, and marking it secret would redact it out of a config export the
    // operator needs in order to restore the same routing.
    it("is not redacted like the token", () => {
        assert.notEqual(fieldNamed("message_thread_id").secret, true);
    });
});
