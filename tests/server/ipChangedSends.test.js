import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import setupDiscord from "../../server/integrations/discord.js";
import setupTelegram from "../../server/integrations/telegram.js";
import setupGotify from "../../server/integrations/gotify.js";
import setupPushover from "../../server/integrations/pushover.js";
import setupNtfy from "../../server/integrations/ntfy.js";
import setupWebhook from "../../server/integrations/webhook.js";
import setupEmail from "../../server/integrations/email.js";
import setupMqtt from "../../server/integrations/mqtt.js";
import setupInflux from "../../server/integrations/influxdb.js";
import setupHealthChecks from "../../server/integrations/healthChecks.js";
import { IP_CHANGED_EVENT } from "../../server/util/connectionChange.js";
import { CONNECTION_SUMMARY } from "../../server/util/notificationPayload.js";
import { connectionSummary } from "../../server/util/notificationLocale.js";

/*
 * What reaches a person when the address rotates. Every notifier sends the
 * change only when its switch is on, through the operator's own template
 * when one was written, and otherwise through a default that says what
 * changed in the recipient's language.
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
            // The text senders are kept as the raw string they were sent as.
        }

        sent.push({url: String(url), headers: init.headers ?? {}, body});
        return new Response("{}", {status: 200, headers: {"content-type": "application/json"}});
    };
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

const load = (setup, ...extra) => {
    const events = {};
    const definition = setup((name, callback) => { events[name] = callback; }, ...extra);
    return {events, definition};
};

const fire = (events, config, payload) => events[IP_CHANGED_EVENT]({data: config}, payload, () => {});

// As the dispatcher hands it over: the summary already composed in the
// integration's language, the way the alert summary is.
const change = (language = "en") => {
    const row = {
        id: 1, created: "2026-09-07T10:00:00.000Z", testId: 9, targetId: 1, targetName: "WAN", provider: "ookla",
        previousIp: "203.0.113.10", ip: "203.0.113.20", previousIsp: null, isp: null, alerts: true
    };
    return {...row, [CONNECTION_SUMMARY]: connectionSummary(row, language)};
};

const SUMMARY = "IP address 203.0.113.10 → 203.0.113.20";

const textOf = (module, message) => {
    switch (module) {
        case "discord": return message.body.embeds[0].description;
        case "telegram": return message.body.text;
        case "gotify": return message.body.message;
        case "pushover": return message.body.message;
        case "ntfy": return message.body;
        default: throw new Error(module);
    }
};

const configs = {
    discord: {url: "https://discord.com/api/webhooks/1/x"},
    telegram: {token: "123456:abcdefghijklmnopqrstuvwxyz", chat_id: "42"},
    gotify: {url: "https://gotify.lan", key: "k"},
    pushover: {token: "a".repeat(30), user_key: "b".repeat(30)},
    ntfy: {url: "https://ntfy.sh", topic: "speed"}
};

const modules = {discord: setupDiscord, telegram: setupTelegram, gotify: setupGotify, pushover: setupPushover, ntfy: setupNtfy};

for (const [name, setup] of Object.entries(modules))
    describe(name, () => {
        it("sends nothing until the switch is on", async () => {
            const {events} = load(setup);

            await fire(events, configs[name], change());
            await fire(events, {...configs[name], send_ip_changed: false}, change());

            assert.equal(sent.length, 0);
        });

        it("says what changed, and for which member, by default", async () => {
            const {events} = load(setup);

            await fire(events, {...configs[name], send_ip_changed: true}, change());

            assert.equal(sent.length, 1);
            const text = textOf(name, sent[0]);
            assert.match(text, /The connection has changed/);
            assert.match(text, /WAN/);
            assert.ok(text.includes(SUMMARY), text);
        });

        it("sends the operator's own template instead when one was written", async () => {
            const {events} = load(setup);

            await fire(events, {...configs[name], send_ip_changed: true, ip_changed_message: "now %ip%, was %previousIp%"}, change());

            assert.equal(textOf(name, sent[0]), "now 203.0.113.20, was 203.0.113.10");
        });
    });

describe("email", () => {
    const config = {host: "mail.lan", port: 587, from: "a@b.c", to: "d@e.f", username: "u", password: "p"};

    const load = (overrides = {}) => {
        const mails = [];
        const events = {};
        setupEmail((name, callback) => { events[name] = callback; },
            () => ({sendMail: async (mail) => { mails.push(mail); }}));
        return {events, mails, fire: (payload) => events[IP_CHANGED_EVENT]({data: {...config, ...overrides}}, payload, () => {})};
    };

    it("sends nothing until the switch is on", async () => {
        const {fire, mails} = load();

        await fire(change());

        assert.equal(mails.length, 0);
    });

    it("subjects the mail with the change and writes what changed", async () => {
        const {fire, mails} = load({send_ip_changed: true});

        await fire(change());

        assert.equal(mails.length, 1);
        assert.equal(mails[0].subject, "MySpeed: connection changed");
        assert.ok(mails[0].text.includes(SUMMARY), mails[0].text);
        assert.match(mails[0].text, /WAN/);
    });

    it("writes the operator's own template instead when one was written", async () => {
        const {fire, mails} = load({send_ip_changed: true, ip_changed_message: "now %ip%"});

        await fire(change());

        assert.equal(mails[0].text, "now 203.0.113.20");
    });
});

describe("webhook", () => {
    const config = {url: "https://hooks.lan/x"};

    it("sends nothing until the switch is on", async () => {
        const {events} = load(setupWebhook);

        await fire(events, config, change());

        assert.equal(sent.length, 0);
    });

    it("posts the change as its own event type, whole", async () => {
        const {events} = load(setupWebhook);

        await fire(events, {...config, send_ip_changed: true}, change());

        assert.equal(sent.length, 1);
        assert.equal(sent[0].body.event, "IP_CHANGED");
        assert.equal(sent[0].body.data.ip, "203.0.113.20");
        assert.equal(sent[0].body.data.previousIp, "203.0.113.10");
        assert.equal(sent[0].body.data[CONNECTION_SUMMARY], SUMMARY);
    });
});

describe("the sinks", () => {
    it("do not register the event", () => {
        for (const [name, setup] of Object.entries({mqtt: setupMqtt, influxdb: setupInflux, healthChecks: setupHealthChecks}))
            assert.equal(load(setup).events[IP_CHANGED_EVENT], undefined, `${name} registered ${IP_CHANGED_EVENT}`);
    });
});
