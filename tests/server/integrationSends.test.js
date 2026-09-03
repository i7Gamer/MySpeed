import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import setupDiscord, { DISCORD_DESCRIPTION_LIMIT, DISCORD_USERNAME_LIMIT } from "../../server/integrations/discord.js";
import setupTelegram, { TELEGRAM_MESSAGE_LIMIT } from "../../server/integrations/telegram.js";
import setupGotify from "../../server/integrations/gotify.js";
import setupPushover, { PUSHOVER_MESSAGE_LIMIT } from "../../server/integrations/pushover.js";
import setupWebhook from "../../server/integrations/webhook.js";
import setupEmail from "../../server/integrations/email.js";
import { DEFAULT_LANGUAGE, plainDefaults } from "../../server/util/notificationLocale.js";
import setupHealthChecks from "../../server/integrations/healthChecks.js";
import setupInflux from "../../server/integrations/influxdb.js";
import { readSource } from "../helpers/source.js";

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
            // Not every integration sends JSON - the form-encoded ones are kept
            // as the raw string they were sent as.
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

/**
 * A failure reaches an integration as the same shape a finished test does: an
 * object carrying the reason alongside which test it was and which provider
 * could not complete. It used to be the bare message, so a failure
 * notification could name the reason and nothing else.
 */
const failure = (error) => ({error, id: 12, created: "2026-08-13T09:15:00.000Z", provider: "ookla"});
const fire = (events, name, config, payload) => events[name]({data: config}, payload, () => {});

describe("influxdb", () => {
    const config = {url: "http://influx.lan:8086", org: "o", bucket: "b", token: "t", host: "server1"};

    /**
     * The row stores three quality figures beside the throughput - packet loss
     * and the loaded latency in each direction - and the testFinished payload
     * carries all of them. The line wrote only the four originals, so the
     * operator graphing bufferbloat in Grafana had the columns in sqlite and
     * nothing in Influx.
     */
    it("writes the quality figures beside the throughput", async () => {
        const {events} = load(setupInflux);
        await fire(events, "testFinished", config,
            {...RESULT, packetLoss: 0.7, downloadLatency: 231.4, uploadLatency: 88.1});

        const [written] = sent;
        assert.match(written.body, /packetLoss=0.7/);
        assert.match(written.body, /downloadLatency=231.4/);
        assert.match(written.body, /uploadLatency=88.1/);
    });

    // A figure the provider does not measure stays out of the line entirely -
    // writing 0 would chart a loss-free, latency-free connection nobody measured.
    it("leaves out the figures the provider did not measure", async () => {
        const {events} = load(setupInflux);
        await fire(events, "testFinished", config,
            {...RESULT, packetLoss: null, downloadLatency: null, uploadLatency: null});

        const [written] = sent;
        assert.match(written.body, /download=100/);
        assert.doesNotMatch(written.body, /packetLoss/);
        assert.doesNotMatch(written.body, /Latency/);
    });

    /**
     * Jitter was the one figure filled in with a zero, so the providers that
     * do not measure it - LibreSpeed backends that report none, Cloudflare
     * with too few latency samples, an iperf3 TCP run whose handshake spread
     * could not be taken - charted a flat, perfect 0 ms line in Grafana
     * instead of the gap that is the truth.
     */
    it("leaves out an unmeasured jitter rather than calling it zero", async () => {
        const {events} = load(setupInflux);
        await fire(events, "testFinished", config, {...RESULT, jitter: null});

        const [written] = sent;
        assert.match(written.body, /ping=12/);
        assert.doesNotMatch(written.body, /jitter/);
    });

    // Zero is a measurement where the provider took one, and has to survive
    // the same treatment absence gets.
    it("writes a measured jitter of zero", async () => {
        const {events} = load(setupInflux);
        await fire(events, "testFinished", config, {...RESULT, jitter: 0});

        assert.match(sent[0].body, /jitter=0/);
    });

    /**
     * Which member measured the point. Tags are what a series is grouped by,
     * so without them every target's points shared one series - a Grafana
     * panel averaging the WAN with the LAN box - and with precision=s, two
     * members finishing in the same second were one point, last writer wins.
     * Through buildLine's own escaping, so a name with a space survives.
     */
    it("tags the point with the member that measured it", async () => {
        const {events} = load(setupInflux);
        await fire(events, "testFinished", config,
            {...RESULT, targetId: 3, targetName: "WAN Box", provider: "iperf3"});

        const [written] = sent;
        assert.match(written.body, /,target=WAN\\ Box/);
        assert.match(written.body, /,targetId=3/);
        assert.match(written.body, /,provider=iperf3/);
    });

    /**
     * The token is free text: it declares no regex, and a config import writes
     * the field with no validation at all. A pasted credential carrying a stray
     * newline or a character above U+00FF made fetch throw before the request
     * left the process, so every point since was lost to a log line while the
     * card went on showing the integration as configured.
     */
    it("sends despite a token carrying a character a header cannot hold", async () => {
        const {events} = load(setupInflux);
        await fire(events, "testFinished", {...config, token: "tk—en\nx"}, RESULT);

        assert.equal(sent.length, 1, "the whole write was lost to an unsendable header");
        assert.equal(sent[0].headers["Authorization"], "Token tken x");
    });

    // A row from before targets existed carries nulls, and buildLine already
    // drops empty tag values - no tags invented, nothing renamed.
    it("writes a pre-target row without inventing empty tags", async () => {
        const {events} = load(setupInflux);
        await fire(events, "testFinished", config,
            {...RESULT, targetId: null, targetName: null, provider: null});

        assert.doesNotMatch(sent[0].body, /target/);
        assert.doesNotMatch(sent[0].body, /provider/);
    });
});

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
        await fire(events, "testFailed", config, failure("boom"));

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
        await fire(events, "testFailed", {...config, error_message: "down: %error%"}, failure("no route to host"));

        assert.equal(sent[0].body.embeds[0].description, "down: no route to host");
    });

    it("sends nothing when the event is switched off", async () => {
        const {events} = load(setupDiscord);
        await fire(events, "testFinished", {...config, send_finished: false}, RESULT);
        await fire(events, "testFailed", {...config, send_failed: false}, failure("boom"));

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

    /**
     * The base URL as it is pasted, which is out of the browser's address bar
     * and therefore with a trailing slash about as often as not.
     *
     * The field's regex is unanchored and accepts it, and validateInput stores
     * what it is given, so the slash survives to here - where `${url}/message`
     * made it `//message`. That is a distinct path, not a tidier spelling of
     * the same one, and Gotify answers it with a 404. Every other integration
     * that composes a path strips first; healthChecks documents this exact
     * hazard.
     */
    it("posts to one slash however the url was pasted", async () => {
        const {events} = load(setupGotify);
        await fire(events, "testFinished", {...config, url: "https://gotify.example.net/"}, RESULT);

        assert.equal(sent[0].url, "https://gotify.example.net/message",
            "a base url pasted with its trailing slash posts to an empty path segment");
    });

    it("sends the configured priority as a number", async () => {
        const {events} = load(setupGotify);
        await fire(events, "testFinished", config, RESULT);

        assert.equal(sent[0].body.priority, 5);
    });

    it("raises the priority for a failure", async () => {
        const {events} = load(setupGotify);
        await fire(events, "testFailed", config, failure("boom"));

        assert.equal(sent[0].body.priority, 8);
        assert.match(sent[0].body.message, /boom/);
    });

    /**
     * A stored row without a readable priority still has to deliver.
     *
     * parseInt(undefined) is NaN, and JSON.stringify writes NaN as `null`.
     * Gotify is Go: it unmarshals the body into a struct whose Priority is an
     * int, and encoding/json refuses null into an integer field - so the whole
     * request comes back 400 and the notification is lost, silently, for as
     * long as the row stays that way.
     *
     * The form cannot produce such a row: the field is required and validated
     * against a single digit. importConfig can, because it bulk-creates the
     * integration rows a backup carries without running them through
     * validateInput - and so can any row written before the field existed. A
     * notification is the one thing that must not depend on that.
     */
    describe("a stored priority that is not a number", () => {
        for (const [name, priority] of [["absent", undefined], ["empty", ""],
            ["text", "urgent"], ["null", null]])
            it(`sends a number rather than null when the priority is ${name}`, async () => {
                const {events} = load(setupGotify);
                await fire(events, "testFinished", {...config, priority}, RESULT);

                assert.equal(typeof sent[0].body.priority, "number",
                    "gotify answers 400 and the notification is dropped");
                assert.ok(Number.isFinite(sent[0].body.priority),
                    "NaN serialises as null, which is what gotify refuses");
            });

        // Still below the one a failure carries, which is the whole point of
        // that number being different.
        it("falls back to something quieter than a failure", async () => {
            const {events} = load(setupGotify);
            await fire(events, "testFinished", {...config, priority: undefined}, RESULT);

            assert.ok(sent[0].body.priority < 8,
                "a finished test arrives as loudly as a failed one");
        });

        it("still prefers a priority that is readable", async () => {
            const {events} = load(setupGotify);
            await fire(events, "testFinished", {...config, priority: "2"}, RESULT);

            assert.equal(sent[0].body.priority, 2, "the operator's own choice was replaced by the fallback");
        });
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

    /**
     * Pushover refuses a message over 1024 characters with a 400, and the error
     * a failure notification interpolates is stored at up to MAX_ERROR_LENGTH -
     * 2000. So the failures with the most to say were exactly the ones that
     * never arrived: a run whose CLI exits after logging one line per candidate
     * server it could not reach produces a message several times the limit, and
     * the whole notification was lost with it.
     */
    describe("a message longer than pushover accepts", () => {
        const LONG = "Error: [0] Cannot open socket to 2001:db8::1 port 8080. ".repeat(40);

        it("trims it to something the api will take", async () => {
            const {events} = load(setupPushover);
            await fire(events, "testFailed", config, failure(LONG));

            assert.ok(sent[0].body.message.length <= PUSHOVER_MESSAGE_LIMIT,
                `sent ${sent[0].body.message.length} characters, which pushover refuses with a 400`);
        });

        it("keeps the beginning, which is where the reason is", async () => {
            const {events} = load(setupPushover);
            await fire(events, "testFailed", config, failure(LONG));

            assert.match(sent[0].body.message, /^A speedtest has failed\./);
            assert.match(sent[0].body.message, /Reason: Error: \[0\] Cannot open socket/);
        });

        // A trimmed message that does not say it was trimmed reads as the whole
        // of what the CLI said.
        it("says that it trimmed", async () => {
            const {events} = load(setupPushover);
            await fire(events, "testFailed", config, failure(LONG));

            assert.match(sent[0].body.message, /…$/);
        });

        it("leaves a message that already fits exactly as it was written", async () => {
            const {events} = load(setupPushover);
            // targetName travels as an explicit null, the way failedPayload
            // always sends it, so the template renders N/A rather than keeping
            // the placeholder.
            await fire(events, "testFailed", config, {...failure("no route to host"), targetName: null});

            assert.equal(sent[0].body.message, "A speedtest has failed.\nTarget: N/A\nReason: no route to host");
        });

        // The limit is on the message, not on the reason, so a long custom
        // template is trimmed too rather than only the variable inside it.
        it("trims a finished message that a template made too long", async () => {
            const {events} = load(setupPushover);
            await fire(events, "testFinished", {...config, finished_message: "x".repeat(1500)}, RESULT);

            assert.ok(sent[0].body.message.length <= PUSHOVER_MESSAGE_LIMIT);
        });
    });
});

describe("webhook", () => {
    const config = {url: "https://hooks.example.net/in"};

    it("labels each event with its own type", async () => {
        const {events} = load(setupWebhook);

        await fire(events, "testFinished", {...config, send_finished: true}, RESULT);
        await fire(events, "testFailed", {...config, send_failed: true}, failure("boom"));
        await fire(events, "testStarted", {...config, send_started: true}, undefined);

        assert.deepEqual(sent.map((request) => request.body.event), ["TEST_FINISHED", "TEST_FAILED", "TEST_STARTED"]);
    });

    // A consumer reading `data.error` off a TEST_FAILED body keeps reading it;
    // what it gains is the rest of the record beside it.
    it("forwards the whole failure record, reason included", async () => {
        const {events} = load(setupWebhook);
        await fire(events, "testFailed", {...config, send_failed: true}, failure("no route to host"));

        assert.deepEqual(sent[0].body.data, failure("no route to host"));
        assert.equal(sent[0].body.data.error, "no route to host");
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

    // The round's completion, not the members' - see "the health checks
    // keep-alive" below for the lifecycle cases.
    it("pings the bare url when a round finishes clean", async () => {
        const {events} = load(setupHealthChecks);
        await fire(events, "roundFinished", config, {failed: false, failures: 0, members: 1});

        assert.equal(sent[0].url, config.url);
    });

    it("uses the /start and /fail sub-paths for the other outcomes", async () => {
        const {events} = load(setupHealthChecks);

        await fire(events, "testStarted", config, undefined);
        await fire(events, "roundFinished", config, {failed: true, failures: 1, members: 1});

        assert.deepEqual(sent.map((request) => request.url),
            [`${config.url}/start`, `${config.url}/fail`]);
    });

    // Without a url there is nothing to ping, and postJson would be handed
    // undefined - a request to the server's own origin.
    it("sends nothing when no url is configured", async () => {
        const {events} = load(setupHealthChecks);
        await fire(events, "roundFinished", {}, {failed: false, failures: 0, members: 1});

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

/**
 * The other two providers that answer an over-long message with a 400.
 *
 * Discord caps an embed description at 4096 characters and telegram caps
 * sendMessage at the same, and only pushover trimmed - the module that had
 * already been caught by it. Neither limit is reachable from the defaults:
 * validateInput caps a custom template at 2000 and cliOutput caps a stored
 * failure reason at 2000, so it takes a long template *and* a long reason
 * together. That combination is ordinary enough - a template with the server
 * and provider spelled out, and a CLI that logs one line per candidate server
 * it could not reach - and the whole notification is dropped when it happens.
 *
 * Trimmed inside each send() rather than at the call sites, the way pushover
 * does it, so a message added later cannot be the one that goes whole.
 */
/**
 * The name beside the message is bounded by the same request.
 *
 * The description was trimmed inside send() "so a message added later cannot be
 * the one that is sent whole and refused" - and `username`, one property away in
 * the same object, was not. Discord validates the override at 1-80 characters
 * and answers a longer one with a 400, delivering nothing at all: worse than an
 * over-long description, because it kills every notification unconditionally
 * rather than only the ones whose text happens to run long.
 *
 * Nothing upstream bounds it either. `display_name` declares no regex, so the
 * only gate is validateInput's generic 250-character cap on a text field - three
 * times what discord will take - and the dialog sets no maxlength.
 */
describe("a discord display name longer than the api accepts", () => {
    const LONG_NAME = "Home fibre line - Frankfurt PoP, monitored by MySpeed on the basement NUC (do not delete)";
    const config = {url: "https://discord.com/api/webhooks/1/token", send_finished: true, send_failed: true};

    it("is 80, which is what the api documents", () => {
        assert.equal(DISCORD_USERNAME_LIMIT, 80);
    });

    it("trims it to something the api will take", async () => {
        const {events} = load(setupDiscord);
        await fire(events, "testFinished", {...config, display_name: LONG_NAME}, RESULT);

        assert.ok(sent[0].body.username.length <= DISCORD_USERNAME_LIMIT,
            `sent ${sent[0].body.username.length} characters, which discord refuses with a 400`);
    });

    // The failure notification is the one that matters most, and it goes through
    // the same send().
    it("trims it on a failure too", async () => {
        const {events} = load(setupDiscord);
        await fire(events, "testFailed", {...config, display_name: LONG_NAME}, failure("boom"));

        assert.ok(sent[0].body.username.length <= DISCORD_USERNAME_LIMIT);
    });

    it("leaves an ordinary name exactly as it was", async () => {
        const {events} = load(setupDiscord);
        await fire(events, "testFinished", {...config, display_name: "Basement NUC"}, RESULT);

        assert.equal(sent[0].body.username, "Basement NUC");
    });
});

/**
 * Telegram refuses the whole message when the markdown does not parse, so the
 * formatting has to be able to give way to the delivery.
 *
 * The interpolated values are already stripped of metacharacters, which leaves
 * one way for a message to arrive unbalanced: the trim to 4096 characters
 * cutting through a pair the operator's own template opened. A custom template
 * runs to 2000 characters and a stored failure reason to another 2000, so the
 * two together reach the limit without either being unusual - and what is
 * dropped is a failure alert.
 */
describe("telegram markdown that will not parse", () => {
    const config = {token: "1:abc", chat_id: "-100", send_failed: true, send_finished: true};

    const sendFailure = async (overrides = {}) => {
        const {events} = load(setupTelegram);
        await fire(events, "testFailed", {...config, ...overrides}, failure("boom"));
        return sent[0];
    };

    it("asks for markdown on an ordinary message", async () => {
        assert.equal((await sendFailure()).body.parse_mode, "markdown",
            "the operator's template is no longer rendered as markdown at all");
    });

    it("sends plain text rather than nothing when a pair is left open", async () => {
        const request = await sendFailure({error_message: "*A speedtest has failed: %error%"});

        assert.equal(request.body.parse_mode, undefined,
            "telegram answers 400 for unbalanced markdown and delivers nothing");
        assert.match(request.body.text, /boom/, "the reason was dropped along with the formatting");
    });

    it("still delivers when the trim cuts through the template's own formatting", async () => {
        const template = `*${"Context. ".repeat(500)}%error%*`;
        const request = await sendFailure({error_message: template});

        assert.ok(request.body.text.length <= TELEGRAM_MESSAGE_LIMIT, "the message was not trimmed at all");
        assert.equal(request.body.parse_mode, undefined,
            "the trim cut the closing delimiter off and the message is sent as markdown anyway");
    });

    // One request either way. A retry would double every notification an
    // endpoint is slow to answer.
    it("sends exactly once", async () => {
        await sendFailure({error_message: "*A speedtest has failed: %error%"});

        assert.equal(sent.length, 1, "the message is sent more than once");
    });
});

describe("a message longer than the provider accepts", () => {
    const LONG_TEMPLATE = `A speedtest has failed. ${"Context. ".repeat(200)}Reason: %error%`;
    const LONG_ERROR = "Cannot open socket to 2001:db8::1 port 8080. ".repeat(60);

    const providers = [
        {
            name: "discord",
            limit: DISCORD_DESCRIPTION_LIMIT,
            config: {url: "https://discord.com/api/webhooks/1/token", send_failed: true, send_finished: true},
            setup: setupDiscord,
            messageOf: (request) => request.body.embeds[0].description
        },
        {
            name: "telegram",
            limit: TELEGRAM_MESSAGE_LIMIT,
            config: {token: "1:abc", chat_id: "-100", send_failed: true, send_finished: true},
            setup: setupTelegram,
            messageOf: (request) => request.body.text
        }
    ];

    for (const {name, limit, config, setup, messageOf} of providers) {
        describe(name, () => {
            const failed = async (overrides = {}) => {
                const {events} = load(setup);
                await fire(events, "testFailed", {...config, ...overrides}, failure(LONG_ERROR));
                return messageOf(sent[0]);
            };

            it("is 4096, which is what the api documents", () => {
                assert.equal(limit, 4096);
            });

            it("trims it to something the api will take", async () => {
                const message = await failed({error_message: LONG_TEMPLATE});

                assert.ok(message.length <= limit,
                    `sent ${message.length} characters, which ${name} refuses with a 400`);
            });

            it("keeps the beginning, which is where the reason is", async () => {
                assert.match(await failed({error_message: LONG_TEMPLATE}), /^A speedtest has failed\./);
            });

            // A trimmed message that does not say so reads as the whole of what
            // the provider said.
            it("says that it trimmed", async () => {
                assert.match(await failed({error_message: LONG_TEMPLATE}), /…$/);
            });

            // The default template plus the longest reason the database will
            // hold still fits, and must arrive exactly as it was written.
            it("leaves a message that already fits alone", async () => {
                const message = await failed();

                assert.ok(message.length < limit);
                assert.doesNotMatch(message, /…$/);
                assert.match(message, /Cannot open socket to 2001:db8::1 port 8080\. $/);
            });

            // The limit is on the message, not on the reason, so a finished
            // message a template made too long is trimmed just the same.
            it("trims a finished message too", async () => {
                const {events} = load(setup);
                await fire(events, "testFinished", {...config, finished_message: "x".repeat(5000)}, RESULT);

                assert.ok(messageOf(sent[0]).length <= limit);
            });
        });
    }
});

/**
 * The keep-alive follows the last test rather than always claiming success.
 *
 * The minute ping goes to the root URL, which is healthchecks.io's success
 * endpoint - so it reported the check up again within sixty seconds of a
 * failure and took the /fail ping back. Routed to /fail instead while a failure
 * stands: the check keeps the state the test gave it, and the ping still
 * arrives, which is the only way to tell "the line is down" from "MySpeed is
 * gone". The outcome reaches the module in the event payload; tasks reads it
 * from the stored tests, so a restart cannot forget it.
 */
describe("the health checks keep-alive", () => {
    const config = {url: "https://hc.example.net/ping/uuid"};

    const pinged = async (payload) => {
        const {events} = load(setupHealthChecks);
        await fire(events, "minutePassed", config, payload);
        return sent[0].url;
    };

    it("goes to /fail while the last test is a failure", async () => {
        assert.equal(await pinged({testFailing: true}), `${config.url}/fail`);
    });

    it("goes to the root url while it is not", async () => {
        assert.equal(await pinged({testFailing: false}), config.url);
    });

    // A payload from before this existed, and the one the module's own tests
    // fire: no claim about the last test is not a claim that it failed.
    it("goes to the root url when the payload says nothing", async () => {
        assert.equal(await pinged({}), config.url);
        assert.equal(await pinged(undefined), config.url);
    });

    /**
     * The check follows the round, not its members. healthchecks.io models
     * one check as one monitored thing: /start opens a run and the next ping
     * closes it. The per-member events fire once per target, so a
     * multi-target round answered one /start with N pings - and the last
     * member won: a watched line's /fail was taken back seconds later by the
     * next member's success, and the check ended the round "up" while the
     * line was still down.
     */
    it("answers the round's start with the round's one outcome", async () => {
        const {events} = load(setupHealthChecks);

        await fire(events, "testStarted", config, undefined);
        await fire(events, "roundFinished", config, {failed: true, failures: 1, members: 2});

        assert.deepEqual(sent.map((request) => request.url),
            [`${config.url}/start`, `${config.url}/fail`]);
    });

    it("pings success for a round nothing watched failed in", async () => {
        const {events} = load(setupHealthChecks);

        await fire(events, "roundFinished", config, {failed: false, failures: 0, members: 2});

        assert.deepEqual(sent.map((request) => request.url), [config.url]);
    });

    // The per-member events are deliberately not handled any more: each one
    // was a ping, and the last member's outcome overwrote every earlier one.
    it("no longer pings once per member", () => {
        const {events} = load(setupHealthChecks);

        assert.equal(events.testFinished, undefined,
            "a finished member still pings, so the last member overwrites the round");
        assert.equal(events.testFailed, undefined,
            "a failed member still pings ahead of the round's own answer");
    });

    /**
     * And the flag does not travel into the ping log.
     *
     * healthchecks.io stores the ping body and shows it as that ping's log
     * entry. `testFailing` is this module's instruction about which URL to use,
     * not something the operator asked to record, and leaving it in the payload
     * wrote a line of MySpeed's internal routing state into their log once a
     * minute forever.
     */
    it("keeps the routing flag out of the body it posts", async () => {
        const {events} = load(setupHealthChecks);
        await fire(events, "minutePassed", config, {testFailing: true});

        assert.deepEqual(sent[0].body, {}, "the flag was logged as though it were content");
    });

    it("still forwards everything else a payload carries", async () => {
        const {events} = load(setupHealthChecks);
        const outcome = {failed: true, failures: 1, members: 3};
        await fire(events, "roundFinished", config, {...outcome, testFailing: false});

        // `failed` stays in, unlike testFailing: it is the round's actual
        // outcome, which is exactly what a ping log is for.
        assert.deepEqual(sent[0].body, outcome, "the round's outcome stopped reaching the ping log");
    });

    // The trailing slash a url pasted from an address bar carries, which the
    // module already strips for the other paths.
    it("strips a trailing slash before /fail as well", async () => {
        const {events} = load(setupHealthChecks);
        await fire(events, "minutePassed", {url: "https://hc.example.net/ping/uuid/"}, {testFailing: true});

        assert.equal(sent[0].url, `${config.url}/fail`);
    });
});

/**
 * Every default template names the member it is talking about.
 *
 * The payload has carried %targetName% since targets arrived, and all six
 * default templates predate it - so on a multi-target instance every
 * notification read identically whether it described the WAN or the gigabit
 * LAN box, and the alert that mattered was indistinguishable from the one
 * that did not. On a pre-target instance the variable renders as N/A, the
 * shape every unmeasured figure already takes.
 */
describe("the default templates", () => {
    const TEMPLATE_MODULES = ["discord", "telegram", "gotify", "pushover", "email", "ntfy"];

    /**
     * One template at a time, rather than counting the name across the whole
     * block: two mentions in the finished message and none in the failed one
     * satisfied a count, and the failure alert - the notification that matters
     * most - went back to reading identically for the WAN and the LAN box.
     *
     * The bodies are template literals since the localisation pass - the
     * words come from the locale file, the %variables% stay in the code - and
     * the three plain-text notifiers share one pair kept beside the phrases
     * in util/notificationLocale.js, so a module that delegates is read
     * there. A literal ends at its first unescaped backtick, and the escaped
     * ones the markdown modules carry are stepped over.
     */
    const templateSource = (module) => {
        const own = readSource(`server/integrations/${module}.js`);

        return /const defaults = plainDefaults;/.test(own)
            ? readSource("server/util/notificationLocale.js")
            : own;
    };

    const templateFor = (module, key) => {
        const written = templateSource(module).match(new RegExp(`\\b${key}: \`((?:[^\`\\\\]|\\\\.)*)\``));

        assert.notEqual(written, null, `${module} declares no default ${key} message`);

        return written[1];
    };

    for (const name of TEMPLATE_MODULES)
        it(`${name}'s templates name the member they describe`, () => {
            assert.match(templateFor(name, "finished"), /%targetName%/,
                `${name}'s finished message does not say which target it describes`);
            assert.match(templateFor(name, "failed"), /%targetName%/,
                `${name}'s failure alert does not say which target went down`);
        });

    it("renders the member's name into the message that goes out", async () => {
        const {events} = load(setupDiscord);
        await fire(events, "testFinished",
            {url: "https://discord.com/api/webhooks/1/token", send_finished: true},
            {...RESULT, targetName: "WAN Box"});

        assert.match(sent[0].body.embeds[0].description, /WAN Box/);
    });

    it("names the member in a failure too", async () => {
        const {events} = load(setupDiscord);
        await fire(events, "testFailed",
            {url: "https://discord.com/api/webhooks/1/token", send_failed: true},
            {...failure("boom"), targetName: "LAN Box"});

        assert.match(sent[0].body.embeds[0].description, /LAN Box/);
    });
});

/**
 * The English the shipped templates are, written out.
 *
 * The words in them are no longer in the code: they come from the locale
 * files, which translators edit through Crowdin, and English is one of the
 * files that pipeline writes to. So the sentence an operator who edited
 * nothing receives can now be changed by a translation round, in a file whose
 * review is about fifteen other languages - and nothing anywhere said what it
 * is meant to say. These eight strings are the fixture: a reword of an English
 * phrase fails here and is read as the deliberate change it has to be, rather
 * than shipping as a surprise.
 *
 * Rendered rather than read out of the source, because rendering is what has
 * to keep working: the phrase lookup, the fallbacks under it, and the
 * %variables% the template keeps for the sender. Fired with no payload at all,
 * so every %variable% is left standing the way replaceVariables leaves one it
 * was given nothing for - what is left is exactly the template.
 *
 * The plain trio is pinned at its shared source. gotify, ntfy and pushover
 * carry no markup, so they take one pair between them from
 * util/notificationLocale.js, and the describe above already holds each of
 * them to it.
 */
describe("the English the default templates ship", () => {
    const NO_PAYLOAD = {};

    const telegramText = async (event, flag) => {
        const {events} = load(setupTelegram);
        await fire(events, event, {token: "1:t", chat_id: "42", [flag]: true}, NO_PAYLOAD);

        // The last send, not the first: the recorder is reset per test and
        // each of these fires both events.
        return sent.at(-1).body.text;
    };

    const discordText = async (event, flag) => {
        const {events} = load(setupDiscord);
        await fire(events, event,
            {url: "https://discord.com/api/webhooks/1/token", [flag]: true}, NO_PAYLOAD);

        return sent.at(-1).body.embeds[0].description;
    };

    // Email speaks SMTP rather than HTTP, so the fetch recorder above cannot
    // see it - the module takes its transport factory as a second argument and
    // this hands in one that records instead of connecting.
    const emailMail = async (event, flag) => {
        const mail = [];
        const events = {};
        setupEmail((name, callback) => { events[name] = callback; },
            () => ({sendMail: async (message) => { mail.push(message); return {accepted: []}; }}));

        await fire(events, event, {host: "smtp.example.com", port: 587,
            from: "myspeed@example.com", to: "ops@example.com", [flag]: true}, NO_PAYLOAD);

        return mail[0];
    };

    it("writes telegram's pair", async () => {
        assert.equal(await telegramText("testFinished", "send_finished"),
            "✨ *A speedtest is finished*\n🎯 `Target`: %targetName%\n🏓 `Ping`: %ping% ms (±%jitter% ms)"
            + "\n🔼 `Upload`: %upload% Mbps\n🔽 `Download`: %download% Mbps%alertSummary%");
        assert.equal(await telegramText("testFailed", "send_failed"),
            "❌ *A speedtest has failed*\n`Target`: %targetName%\n`Reason`: %error%");
    });

    it("writes discord's pair", async () => {
        assert.equal(await discordText("testFinished", "send_finished"),
            ":sparkles: **A speedtest is finished**\n > :dart: `Target`: %targetName%"
            + "\n > :ping_pong: `Ping`: %ping% ms (±%jitter% ms)\n > :arrow_up: `Upload`: %upload% Mbps"
            + "\n > :arrow_down: `Download`: %download% Mbps%alertSummary%");
        assert.equal(await discordText("testFailed", "send_failed"),
            ":x: **A speedtest has failed**\n > `Target`: %targetName%\n > `Reason`: %error%");
    });

    it("writes email's pair, and the subject over each of them", async () => {
        const finished = await emailMail("testFinished", "send_finished");
        assert.equal(finished.subject, "MySpeed: speedtest finished");
        assert.equal(finished.text,
            "A speedtest is finished:\nTarget: %targetName%\nPing: %ping% ms (±%jitter% ms)"
            + "\nDownload: %download% Mbps\nUpload: %upload% Mbps%alertSummary%");

        const failed = await emailMail("testFailed", "send_failed");
        assert.equal(failed.subject, "MySpeed: speedtest failed");
        assert.equal(failed.text, "A speedtest has failed.\nTarget: %targetName%\nReason: %error%");
    });

    it("writes the pair the three plain-text notifiers share", () => {
        assert.equal(plainDefaults(DEFAULT_LANGUAGE).finished,
            "A speedtest is finished:\nTarget: %targetName%\nPing: %ping% ms (±%jitter% ms)"
            + "\nUpload: %upload% Mbps\nDownload: %download% Mbps%alertSummary%");
        assert.equal(plainDefaults(DEFAULT_LANGUAGE).failed,
            "A speedtest has failed.\nTarget: %targetName%\nReason: %error%");
    });

    // The language nothing chose is the same one, and the same words: a row
    // saved before the setting existed carries no language at all.
    it("writes the same pair for a notifier that chose no language", () => {
        assert.deepEqual(plainDefaults(undefined), plainDefaults(DEFAULT_LANGUAGE));
    });
});
