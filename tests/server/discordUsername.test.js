import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import setupDiscord from "../../server/integrations/discord.js";

/**
 * The name a discord webhook posts under.
 *
 * `c.display_name || "MySpeed"` falls back only for the empty string, so a name
 * of spaces passed through and discord answered 400 for a username that is
 * blank once trimmed - dropping the notification.
 *
 * The obvious `c.display_name?.trim()` would trade that for a worse one:
 * optional chaining guards null and undefined, not a number, and importConfig
 * bulk-writes integration rows without running them through validateInput. A
 * numeric display name is delivered today, because truncate coerces with
 * String(); with a bare .trim() it would throw, be swallowed by triggerEvent's
 * per-integration catch, and the notification would vanish while the
 * integration was marked failed.
 */
const realFetch = globalThis.fetch;

let sent = [];

beforeEach(() => {
    sent = [];
    globalThis.fetch = async (url, init = {}) => {
        sent.push(JSON.parse(init.body));
        return new Response("{}", {status: 204});
    };
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

const load = () => {
    const events = {};
    setupDiscord((name, callback) => { events[name] = callback; });
    return events;
};

const URL_FIELD = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz";
const RESULT = {ping: 12, jitter: 2, download: 100, upload: 50};

const usernameFor = async (display_name) => {
    const events = load();
    await events.testFinished(
        {data: {url: URL_FIELD, display_name, send_finished: true}}, RESULT, () => {});

    return sent[0].username;
};

describe("the discord webhook username", () => {
    it("is the configured name", async () => {
        assert.equal(await usernameFor("Uplink"), "Uplink");
    });

    it("falls back when the name is only whitespace", async () => {
        assert.equal(await usernameFor("   "), "MySpeed");
        assert.equal(await usernameFor("\t\n"), "MySpeed");
    });

    it("falls back when there is no name at all", async () => {
        assert.equal(await usernameFor(""), "MySpeed");
        assert.equal(await usernameFor(null), "MySpeed");
        assert.equal(await usernameFor(undefined), "MySpeed");
    });

    // The shape importConfig can write. It was delivered before and must still
    // be delivered - the fallback is for a name that is blank, not for one that
    // is not a string.
    it("still delivers a name that is not a string", async () => {
        assert.equal(await usernameFor(42), "42");
    });

    it("trims the name it does send", async () => {
        assert.equal(await usernameFor("  Uplink  "), "Uplink");
    });
});

/**
 * The embed's description, the same way as its username.
 *
 * An empty template already fell to the shipped default through `||`, but a
 * template of whitespace survived it, substituted to whitespace, and Discord
 * answered 400 for an embed that is blank once trimmed - dropping the
 * notification for the same reason a blank username did.
 */
describe("the discord embed description", () => {
    const descriptionFor = async (finished_message) => {
        const events = load();
        await events.testFinished(
            {data: {url: URL_FIELD, send_finished: true, finished_message}}, RESULT, () => {});

        return sent[0].embeds[0].description;
    };

    it("is the substituted template", async () => {
        assert.equal(await descriptionFor("ping %ping%"), "ping 12");
    });

    it("falls back when the template substitutes to only whitespace", async () => {
        assert.equal(await descriptionFor("   "), "MySpeed");
        assert.equal(await descriptionFor("\t\n"), "MySpeed");
    });

    it("is otherwise sent as it is", async () => {
        assert.equal(await descriptionFor("  ping %ping%  "), "  ping 12  ");
    });
});
