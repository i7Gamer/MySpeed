import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import setupDiscord from "../../server/integrations/discord.js";
import setupEmail from "../../server/integrations/email.js";
import setupGotify, { FINISHED_PRIORITY } from "../../server/integrations/gotify.js";
import setupHealthChecks from "../../server/integrations/healthChecks.js";
import setupInflux from "../../server/integrations/influxdb.js";
import setupMqtt from "../../server/integrations/mqtt.js";
import setupNtfy from "../../server/integrations/ntfy.js";
import setupPushover from "../../server/integrations/pushover.js";
import setupTelegram from "../../server/integrations/telegram.js";
import setupWebhook from "../../server/integrations/webhook.js";
import { wantsDigest } from "../../server/controller/integrations.js";

/**
 * The digest reaches the same seven notifiers a test result does, and reaches
 * none of the three sinks.
 *
 * tasks/digestReport.js fires one digestReady per tick carrying the composed
 * text and the window it covers, and each notifier decides for itself - from
 * the two booleans DIGEST_FIELDS puts on every notifier's form - whether that
 * cadence was asked for. Nothing here makes a real request: fetch is stubbed
 * the way tests/server/integrationSends.test.js stubs it, and email takes its
 * transport factory as a second argument the way tests/server/emailSends.test.js
 * hands one in.
 *
 * Why the opt-in is read seven times over
 *
 * controller/integrations.js exports wantsDigest and is the one home for what
 * "opted in" means; the digest task itself reads it from there. An integration
 * module cannot. The controller statically imports the generated
 * server/integrations/index.js, which statically imports all ten modules, so an
 * import back from a module closes a cycle - and not a latent one. Whenever a
 * module is the entry, which is what every suite over these files does, index.js
 * is evaluated while that module's own default export is still in its temporal
 * dead zone, and the array it builds throws "Cannot access 'i0_discord' before
 * initialization" before a single assertion runs.
 *
 * So each of the seven carries its own two-field read, and the last block below
 * is what stops those copies drifting from the home they were copied from: it
 * fires every module across the whole matrix of stored flags and cadences and
 * holds each answer to wantsDigest's own.
 */
const realFetch = globalThis.fetch;

let sent = [];
let sentMail = [];

/** The transport email is handed instead of nodemailer's, so nothing dials. */
const recordingTransport = () => ({
    sendMail: async (message) => {
        sentMail.push(message);
        return {accepted: [message.to]};
    }
});

beforeEach(() => {
    sent = [];
    sentMail = [];
    globalThis.fetch = async (url, init = {}) => {
        let body = init.body;
        try {
            body = JSON.parse(init.body);
        } catch {
            // ntfy posts the text itself rather than JSON, and it is kept as
            // the raw string it was sent as.
        }

        sent.push({url: String(url), headers: init.headers ?? {}, body});
        return new Response("{}", {status: 200, headers: {"content-type": "application/json"}});
    };
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

/**
 * A composed digest, worded as util/digestReport.js words one.
 *
 * The first line names the cadence and the window, which is the line email
 * takes its subject from. The en dash in it is the one non-ASCII character the
 * body is allowed - tests/server/digestReport.test.js pins that and the length
 * both, against pushover's 1024 as the tightest cap of the seven.
 */
const FIRST_LINE = "MySpeed weekly digest (2026-08-24 – 2026-08-30)";

const TEXT = [
    FIRST_LINE,
    "168 tests, 2 failed (1.2%)",
    "Average: 941.2 down / 41.7 up Mbit/s, ping 8.4 ms",
    "Data used: 214.6 GB",
    "vs previous week: tests +1.2%, download -3.4%, ping +0.8%"
].join("\n");

// The same text for either cadence: what a module reads to decide is `kind`,
// and a text that named the cadence too would let a copy that reads the wrong
// key pass by looking at the wording instead.
const digest = (kind = "weekly") => ({
    kind,
    text: TEXT,
    from: "2026-08-24T00:00:00.000Z",
    to: "2026-08-30T23:59:59.999Z",
    tests: {total: 168, failed: 2}
});

/** Registers a module and hands back the event callbacks it declared. */
const load = (setup, ...rest) => {
    const events = {};
    const definition = setup((name, callback) => { events[name] = callback; }, ...rest);

    return {events, definition};
};

const fire = (events, config, payload) => events.digestReady({data: config}, payload, () => {});

const DISCORD_URL = "https://discord.com/api/webhooks/1/token";
const GOTIFY_CONFIG = {url: "https://gotify.example.net", key: "123456789012345", priority: "5"};
const NTFY_CONFIG = {url: "https://ntfy.example.net", topic: "myspeed"};
const TELEGRAM_CONFIG = {token: "1:abc", chat_id: "-100"};
const WEBHOOK_URL = "https://hooks.example.net/in";

/**
 * One row per notifier: a stored row with the digest boxes left off, and where
 * the text ends up in what actually went out. Email reads the recorded mail
 * rather than the stubbed fetch, because it dials a relay instead of posting.
 */
const notifiers = [
    {
        name: "discord",
        load: () => load(setupDiscord),
        config: {url: DISCORD_URL},
        outbound: () => sent,
        textOf: (request) => request.body.embeds[0].description
    },
    {
        name: "email",
        load: () => load(setupEmail, recordingTransport),
        config: {host: "smtp.example.com", port: 587, from: "myspeed@example.com", to: "ops@example.com"},
        outbound: () => sentMail,
        textOf: (mail) => mail.text
    },
    {
        name: "gotify",
        load: () => load(setupGotify),
        config: GOTIFY_CONFIG,
        outbound: () => sent,
        textOf: (request) => request.body.message
    },
    {
        name: "ntfy",
        load: () => load(setupNtfy),
        config: NTFY_CONFIG,
        outbound: () => sent,
        textOf: (request) => request.body
    },
    {
        name: "pushover",
        load: () => load(setupPushover),
        config: {token: "a".repeat(30), user_key: "b".repeat(30)},
        outbound: () => sent,
        textOf: (request) => request.body.message
    },
    {
        name: "telegram",
        load: () => load(setupTelegram),
        config: TELEGRAM_CONFIG,
        outbound: () => sent,
        textOf: (request) => request.body.text
    },
    {
        name: "webhook",
        load: () => load(setupWebhook),
        config: {url: WEBHOOK_URL},
        outbound: () => sent,
        // The one machine-facing row: the wording rides inside the payload
        // rather than being the whole of the body.
        textOf: (request) => request.body.data.text
    }
];

for (const {name, load: loadModule, config, outbound, textOf} of notifiers)
    describe(`the ${name} digest`, () => {
        const fired = async (stored, kind = "weekly") => {
            const {events} = loadModule();
            await fire(events, {...config, ...stored}, digest(kind));

            return outbound();
        };

        it("goes out whole when the weekly box is ticked", async () => {
            const out = await fired({digest_weekly: true});

            assert.equal(out.length, 1);
            assert.equal(textOf(out[0]), TEXT, "the digest arrived as something other than what was composed");
        });

        it("goes out for the monthly box on a monthly tick", async () => {
            const out = await fired({digest_monthly: true}, "monthly");

            assert.equal(out.length, 1);
            assert.equal(textOf(out[0]), TEXT);
        });

        // Nobody is opted in by an upgrade: a row written before the fields
        // existed carries neither key, which reads falsy.
        it("stays quiet when neither box is ticked", async () => {
            assert.deepEqual(await fired({}), []);
        });

        /**
         * The two boxes are two subscriptions rather than one switch. A read
         * that answers either key for either cadence delivers a weekly summary
         * every week to somebody who asked for one a month - which is the
         * shape a truthiness read over the wrong key has, and the only thing
         * separating the seven local copies from it.
         */
        it("stays quiet for the cadence it was not asked for", async () => {
            assert.deepEqual(await fired({digest_monthly: true}, "weekly"), []);
            assert.deepEqual(await fired({digest_weekly: true}, "monthly"), []);
        });
    });

describe("the shape each notifier sends it in", () => {
    it("discord posts it as the embed description rather than as content", async () => {
        const {events} = load(setupDiscord);
        await fire(events, {url: DISCORD_URL, digest_weekly: true}, digest());

        // The description is trimmed at DISCORD_DESCRIPTION_LIMIT inside
        // send(); a bare `content` field is capped at 2000 instead, and
        // nothing in the module enforces that one.
        assert.equal(sent[0].body.content, null);
        assert.equal(sent[0].body.embeds[0].description, TEXT);
    });

    /**
     * Into the topic the alerts already go to.
     *
     * A stored message_thread_id the digest did not carry would put the weekly
     * summary in General while every other message from the same integration
     * arrived in the topic the operator made for it.
     */
    it("telegram posts it into the stored topic", async () => {
        const {events} = load(setupTelegram);
        await fire(events, {...TELEGRAM_CONFIG, message_thread_id: "42", digest_weekly: true}, digest());

        assert.equal(sent[0].body.message_thread_id, "42");
        assert.equal(sent[0].body.chat_id, "-100");
    });

    // The composed digest carries none of the three characters
    // balancedForTelegram counts and no brackets either, so it cannot arrive
    // unbalanced and needs no plain-text flag of its own.
    it("telegram still asks for markdown, which the digest cannot unbalance", async () => {
        const {events} = load(setupTelegram);
        await fire(events, {...TELEGRAM_CONFIG, digest_weekly: true}, digest());

        assert.equal(sent[0].body.parse_mode, "markdown");
        assert.equal(sent[0].body.text, TEXT);
    });

    // A digest is information rather than an alarm, so it arrives at the band
    // a finished test does rather than the one a failure pops up from - and
    // rather than the priority the operator chose for measurements.
    it("gotify sends it at the finished band whatever the stored priority is", async () => {
        const {events} = load(setupGotify);
        await fire(events, {...GOTIFY_CONFIG, priority: "9", digest_weekly: true}, digest());

        assert.equal(sent[0].body.priority, FINISHED_PRIORITY);
    });

    /**
     * ntfy's headers are Latin-1 and headerSafe drops every code point above
     * U+00FF, so a title composed out of the digest would lose the en dash its
     * first line carries. The body takes the whole of it, and that first line
     * names the period already.
     */
    it("ntfy sends it as the body with no title of its own", async () => {
        // ntfy's own default band, which is what an absent Priority would get
        // anyway - sent explicitly so the header says what was decided.
        const NTFY_DEFAULT_PRIORITY = "3";

        const {events} = load(setupNtfy);
        await fire(events, {...NTFY_CONFIG, digest_weekly: true}, digest());

        assert.equal(sent[0].body, TEXT);
        assert.equal(sent[0].headers.Title, undefined);
        assert.equal(sent[0].headers.Priority, NTFY_DEFAULT_PRIORITY);
    });

    // Nothing to trim: digestText renders a fixed set of lines with no
    // operator template among them, pinned under 900 characters in
    // tests/server/digestReport.test.js against a cap of 1024.
    it("pushover sends it whole", async () => {
        const {events} = load(setupPushover);
        await fire(events, {token: "a".repeat(30), user_key: "b".repeat(30), digest_weekly: true}, digest());

        assert.equal(sent[0].body.message, TEXT);
        assert.doesNotMatch(sent[0].body.message, /…$/, "a digest that fits was trimmed anyway");
    });

    /**
     * The subject is the digest's own first line rather than a second wording
     * of it: that line already names the cadence and the window, which is what
     * a mailbox holding one of these a week needs to tell them apart, and two
     * wordings of one thing are two things to keep in step.
     */
    it("email takes its subject from the first line and sends the rest as the body", async () => {
        const {events} = load(setupEmail, recordingTransport);
        await fire(events, {
            host: "smtp.example.com", port: 587, from: "myspeed@example.com",
            to: "ops@example.com", digest_weekly: true
        }, digest());

        assert.equal(sentMail[0].subject, FIRST_LINE);
        assert.equal(sentMail[0].text, TEXT, "the body arrived as the subject did, one line of it");
    });

    /**
     * The one machine-facing row. A webhook consumer wants the window and the
     * counts as fields it can read, so the wording is one field among them
     * rather than the whole of what arrives - and the type says which event
     * this is without parsing the body for it.
     */
    it("webhook posts the whole payload under its own type", async () => {
        const {events} = load(setupWebhook);
        const payload = digest();
        await fire(events, {url: WEBHOOK_URL, digest_weekly: true}, payload);

        assert.equal(sent[0].body.event, "DIGEST");
        assert.deepEqual(sent[0].body.data, payload);
    });

    /**
     * Registered outside webhook's event table, which cannot express it - so
     * neither switch may read the other's. A row subscribed to everything the
     * table offers has still not asked for a digest, and a row that asked for
     * a digest has not subscribed to the table.
     */
    it("webhook keeps the digest's switches apart from its table's", async () => {
        const {events} = load(setupWebhook);
        const everything = {
            url: WEBHOOK_URL, send_started: true, send_finished: true, send_alive: true,
            send_failed: true, send_recommendations: true, send_config_updates: true
        };

        await fire(events, everything, digest());
        assert.deepEqual(sent, [], "a switch from the table turned the digest on");

        for (const callback of Object.values(events))
            await callback({data: {url: WEBHOOK_URL, digest_weekly: true}}, digest(), () => {});

        assert.equal(sent.length, 1, "the digest box answered an event from the table as well");
    });
});

/**
 * The three integrations that are not notifiers never hear about a digest.
 *
 * An absence rather than a filter: none of them registers the event, so
 * triggerEvent has nothing to call for them and no stored flag is consulted.
 * Two are stores of measurements and the third is a dead man's switch whose
 * pings mean "the round ran" - a paragraph of English is not a point, a state
 * or a ping in any of the three.
 */
describe("the integrations that are not notifiers", () => {
    const sinks = {influxdb: setupInflux, mqtt: setupMqtt, healthChecks: setupHealthChecks};

    for (const [name, setup] of Object.entries(sinks))
        it(`${name} does not register digestReady at all`, () => {
            const {events} = load(setup);

            assert.equal(events.digestReady, undefined,
                `${name} would be handed a digest it has nowhere to put`);
        });
});

/**
 * The seven local reads, held to the one they were copied from.
 *
 * The note at the head of this file says why they are copies. What is left is
 * the risk that comes with any copy: the matrix below is every shape a stored
 * row takes - the fields absent, either box alone, both, and the untyped values
 * a config import can write past validateInput - against both cadences. A
 * module either answers as wantsDigest does, or it has drifted from it.
 */
describe("every notifier agrees with the controller's own wantsDigest", () => {
    const STORED = [
        {},
        {digest_weekly: true},
        {digest_monthly: true},
        {digest_weekly: true, digest_monthly: true},
        // Truthiness, the way every module reads its own send_* flags:
        // importConfig writes integration rows without running them through
        // validateInput, so neither the type nor the presence is guaranteed.
        {digest_weekly: 1},
        {digest_weekly: false, digest_monthly: null},
        {digest_monthly: "yes"}
    ];

    for (const {name, load: loadModule, config, outbound} of notifiers)
        it(`${name} sends exactly where the controller says it should`, async () => {
            for (const stored of STORED)
                for (const kind of ["weekly", "monthly"]) {
                    sent = [];
                    sentMail = [];

                    const {events} = loadModule();
                    await fire(events, {...config, ...stored}, digest(kind));

                    assert.equal(outbound().length > 0, wantsDigest(stored, kind),
                        `${name} disagreed on ${JSON.stringify(stored)} for the ${kind} digest`);
                }
        });
});
