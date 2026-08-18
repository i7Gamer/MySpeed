import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import setupDiscord, { DISCORD_DESCRIPTION_LIMIT, DISCORD_USERNAME_LIMIT } from "../../server/integrations/discord.js";
import setupTelegram, { TELEGRAM_MESSAGE_LIMIT } from "../../server/integrations/telegram.js";
import setupGotify from "../../server/integrations/gotify.js";
import setupPushover, { PUSHOVER_MESSAGE_LIMIT } from "../../server/integrations/pushover.js";
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

            assert.match(sent[0].body.message, /^A speedtest has failed\. Reason: Error: \[0\] Cannot open socket/);
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
            await fire(events, "testFailed", config, failure("no route to host"));

            assert.equal(sent[0].body.message, "A speedtest has failed. Reason: no route to host");
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

    it("pings the bare url when a test finishes", async () => {
        const {events} = load(setupHealthChecks);
        await fire(events, "testFinished", config, RESULT);

        assert.equal(sent[0].url, config.url);
    });

    it("uses the /start and /fail sub-paths for the other events", async () => {
        const {events} = load(setupHealthChecks);

        await fire(events, "testStarted", config, undefined);
        await fire(events, "testFailed", config, failure("boom"));

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

    // Only the keep-alive is routed. The other three carry the outcome in the
    // event itself, and a finished test that landed on /fail would leave the
    // check down after the line recovered.
    it("leaves the other three events on their own paths", async () => {
        const {events} = load(setupHealthChecks);
        const failing = {testFailing: true};

        await fire(events, "testFinished", config, failing);
        await fire(events, "testStarted", config, failing);
        await fire(events, "testFailed", config, failing);

        assert.deepEqual(sent.map((request) => request.url),
            [config.url, `${config.url}/start`, `${config.url}/fail`]);
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
        await fire(events, "testFinished", config, {...RESULT, testFailing: false});

        assert.deepEqual(sent[0].body, RESULT, "the measurements stopped reaching the ping log");
    });

    // The trailing slash a url pasted from an address bar carries, which the
    // module already strips for the other paths.
    it("strips a trailing slash before /fail as well", async () => {
        const {events} = load(setupHealthChecks);
        await fire(events, "minutePassed", {url: "https://hc.example.net/ping/uuid/"}, {testFailing: true});

        assert.equal(sent[0].url, `${config.url}/fail`);
    });
});
