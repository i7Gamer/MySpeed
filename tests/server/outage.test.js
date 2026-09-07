import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
    DEFAULT_OUTAGE_AFTER, FAILURES_IN_ROW, OUTAGE_AFTER_FIELD, OUTAGE_AFTER_MIN, OUTAGE_EVENT,
    OUTAGE_MESSAGE_FIELD, RECOVERED_EVENT, RECOVERED_MESSAGE_FIELD, SEND_OUTAGE_FIELD,
    announcesOutage, announcesRecovery, describeStreak, outageAfter, outageSummary
} from "../../server/util/outage.js";
import { plainDefaults } from "../../server/util/notificationLocale.js";
import {
    FINISHED_VARIABLES, OUTAGE_SUMMARY, OUTAGE_VARIABLES, RECOVERED_VARIABLES, outagePayload, recoveredPayload
} from "../../server/util/notificationPayload.js";
import { DATE_VARIABLES } from "../../server/util/helpers.js";
import { ALERT_ONLY } from "../../server/util/alertThreshold.js";
import { zoneFromName } from "../../server/util/timezone.js";
import { getIntegration, initialize, suppressesEvent } from "../../server/controller/integrations.js";
import setupDiscord from "../../server/integrations/discord.js";
import setupTelegram from "../../server/integrations/telegram.js";
import setupGotify from "../../server/integrations/gotify.js";
import setupPushover from "../../server/integrations/pushover.js";
import setupNtfy from "../../server/integrations/ntfy.js";
import setupWebhook from "../../server/integrations/webhook.js";
import setupEmail from "../../server/integrations/email.js";

/*
 * An outage and its end.
 *
 * A single failed test already reaches every notifier that asked for
 * failures, and on a flaky provider that is a message about nothing. What
 * nobody was told is that the line has now failed N times in a row - and,
 * later, that it came back. Both are edges: the outage is announced on the
 * one failure that makes the streak reach the length the recipient chose,
 * and the recovery on the first success after a streak that long.
 */

const SINCE = "2026-08-13T09:15:00.000Z";

describe("outageAfter", () => {
    it("reads the recipient's own number", () => {
        assert.equal(outageAfter({[OUTAGE_AFTER_FIELD]: 3}), 3);
        assert.equal(outageAfter({[OUTAGE_AFTER_FIELD]: "4"}), 4);
    });

    it("falls back to the default when nothing usable was stored", () => {
        for (const value of [undefined, null, "", "three", 0, -1, 1.5, NaN, Infinity, {}])
            assert.equal(outageAfter({[OUTAGE_AFTER_FIELD]: value}), DEFAULT_OUTAGE_AFTER, JSON.stringify(value));

        assert.equal(outageAfter(undefined), DEFAULT_OUTAGE_AFTER);
    });

    it("accepts the floor, so an operator can be told on the first failure", () => {
        assert.equal(OUTAGE_AFTER_MIN, 1);
        assert.equal(outageAfter({[OUTAGE_AFTER_FIELD]: OUTAGE_AFTER_MIN}), OUTAGE_AFTER_MIN);
    });

    it("defaults above one, so one flaky run is not an outage", () => {
        assert.ok(DEFAULT_OUTAGE_AFTER > 1);
    });
});

describe("describeStreak", () => {
    const now = new Date("2026-08-13T10:00:00.000Z");

    it("says how many failed in a row, since when, and for how long", () => {
        assert.deepEqual(describeStreak({count: 3, since: SINCE}, now),
            {failuresInRow: 3, downSince: SINCE, downtimeMinutes: 45});
    });

    it("reads a Date the way it reads an ISO string", () => {
        assert.deepEqual(describeStreak({count: 1, since: new Date(SINCE)}, now),
            {failuresInRow: 1, downSince: SINCE, downtimeMinutes: 45});
    });

    it("rounds the downtime to whole minutes", () => {
        assert.equal(describeStreak({count: 1, since: "2026-08-13T09:59:20.000Z"}, now).downtimeMinutes, 1);
    });

    it("answers nothing for a target that is not down", () => {
        assert.deepEqual(describeStreak({count: 0, since: null}, now),
            {failuresInRow: 0, downSince: null, downtimeMinutes: null});
    });

    it("answers no count for a streak it cannot read", () => {
        for (const streak of [null, undefined, {}, {count: "many"}])
            assert.deepEqual(describeStreak(streak, now),
                {failuresInRow: 0, downSince: null, downtimeMinutes: null}, JSON.stringify(streak));
    });

    it("never claims a negative downtime for a clock that went backwards", () => {
        assert.equal(describeStreak({count: 1, since: "2026-08-13T11:00:00.000Z"}, now).downtimeMinutes, 0);
    });
});

describe("announcesOutage", () => {
    const streak = (count) => ({[FAILURES_IN_ROW]: count});

    it("fires on the failure that makes the streak as long as the recipient asked", () => {
        assert.equal(announcesOutage(streak(3), {[OUTAGE_AFTER_FIELD]: 3}), true);
    });

    it("is quiet before the streak is long enough", () => {
        assert.equal(announcesOutage(streak(2), {[OUTAGE_AFTER_FIELD]: 3}), false);
    });

    it("is quiet again on every later failure of the same outage", () => {
        assert.equal(announcesOutage(streak(4), {[OUTAGE_AFTER_FIELD]: 3}), false);
        assert.equal(announcesOutage(streak(40), {[OUTAGE_AFTER_FIELD]: 3}), false);
    });

    it("uses the default for a recipient that chose nothing", () => {
        assert.equal(announcesOutage(streak(DEFAULT_OUTAGE_AFTER), {}), true);
        assert.equal(announcesOutage(streak(DEFAULT_OUTAGE_AFTER + 1), {}), false);
    });

    it("reads a count a node wrote as text", () => {
        assert.equal(announcesOutage(streak("2"), {}), true);
    });

    it("never fires on a payload that carries no streak", () => {
        for (const payload of [{}, null, undefined, streak(null), streak("soon")])
            assert.equal(announcesOutage(payload, {}), false, JSON.stringify(payload));
    });
});

describe("announcesRecovery", () => {
    const streak = (count) => ({[FAILURES_IN_ROW]: count});

    it("fires when the streak that ended was long enough to have been announced", () => {
        assert.equal(announcesRecovery(streak(3), {[OUTAGE_AFTER_FIELD]: 3}), true);
        assert.equal(announcesRecovery(streak(9), {[OUTAGE_AFTER_FIELD]: 3}), true);
    });

    it("is quiet about a blip the recipient was never told about", () => {
        assert.equal(announcesRecovery(streak(2), {[OUTAGE_AFTER_FIELD]: 3}), false);
        assert.equal(announcesRecovery(streak(0), {}), false);
    });

    it("never fires on a payload that carries no streak", () => {
        for (const payload of [{}, null, streak(null)])
            assert.equal(announcesRecovery(payload, {}), false, JSON.stringify(payload));
    });
});

describe("outageSummary", () => {
    const berlin = zoneFromName("Europe/Berlin");
    const payload = {[FAILURES_IN_ROW]: 3, downSince: SINCE};

    it("says how many failed and since when, on the instance's own clock", () => {
        assert.equal(outageSummary(OUTAGE_EVENT, payload, "en", berlin),
            "3 tests in a row have failed since 2026-08-13 11:15");
    });

    it("says the line is back, and what it was back from", () => {
        assert.equal(outageSummary(RECOVERED_EVENT, payload, "en", berlin),
            "Back online after 3 failed tests since 2026-08-13 11:15");
    });

    it("falls back to English for a language nobody wrote", () => {
        assert.equal(outageSummary(OUTAGE_EVENT, payload, "xx", berlin),
            outageSummary(OUTAGE_EVENT, payload, "en", berlin));
    });

    it("is empty for a payload that carries no streak", () => {
        assert.equal(outageSummary(OUTAGE_EVENT, {}, "en", berlin), "");
        assert.equal(outageSummary(RECOVERED_EVENT, {[FAILURES_IN_ROW]: 2}, "en", berlin), "");
    });

    it("is empty for an event it does not describe", () => {
        assert.equal(outageSummary("testFinished", payload, "en", berlin), "");
    });
});

describe("the plain default templates", () => {
    it("name the target and end on the summary", () => {
        const {outage, recovered} = plainDefaults("en");

        for (const template of [outage, recovered]) {
            assert.match(template, /%targetName%/);
            assert.match(template, new RegExp(`%${OUTAGE_SUMMARY}%$`));
        }

        assert.match(outage, /The connection is down/);
        assert.match(recovered, /The connection is back/);
    });
});

describe("the payloads", () => {
    const row = {
        id: 12, created: "2026-08-13T11:15:00.000Z", provider: "ookla", error: "no route to host",
        targetId: 3, targetName: "WAN", alerts: true, primary: true,
        failuresInRow: 3, downSince: SINCE, downtimeMinutes: 120
    };

    it("carry the streak on the outage", () => {
        const payload = outagePayload(row);

        for (const key of Object.keys(row)) assert.equal(payload[key], row[key], key);
    });

    it("carry the streak and the measurement that ended it on the recovery", () => {
        const measured = {...row, error: null, ping: 12, download: 100, upload: 50};
        const payload = recoveredPayload(measured);

        for (const key of ["ping", "download", "upload", "failuresInRow", "downSince", "downtimeMinutes", "targetName"])
            assert.equal(payload[key], measured[key], key);
        assert.equal(Object.hasOwn(payload, "error"), false, "a recovery has no error to report");
    });

    it("answer with every key even for a record that carries none of them", () => {
        for (const [build, variables] of [[outagePayload, OUTAGE_VARIABLES], [recoveredPayload, RECOVERED_VARIABLES]]) {
            const payload = build({});

            for (const key of variables.filter((name) => !DATE_VARIABLES.includes(name)))
                assert.ok(Object.hasOwn(payload, key), `${key} is not on the payload`);
        }
    });

    it("leave room for the summary the dispatcher fills in", () => {
        assert.ok(OUTAGE_VARIABLES.includes(OUTAGE_SUMMARY));
        assert.ok(RECOVERED_VARIABLES.includes(OUTAGE_SUMMARY));
        assert.ok(!FINISHED_VARIABLES.includes(OUTAGE_SUMMARY));
    });

    it("nest nothing", () => {
        for (const value of [...Object.values(outagePayload(row)), ...Object.values(recoveredPayload(row))])
            assert.ok(value === null || typeof value !== "object", "a nested value substitutes as [object Object]");
    });

    it("advertise the clock like the others", () => {
        for (const name of DATE_VARIABLES) {
            assert.ok(OUTAGE_VARIABLES.includes(name), name);
            assert.ok(RECOVERED_VARIABLES.includes(name), name);
        }
    });
});

describe("the fields an outage adds to a notifier", () => {
    before(async () => { await initialize(); });

    const names = (module) => getIntegration(module).fields.map((field) => field.name);
    const field = (module, name) => getIntegration(module).fields.find((candidate) => candidate.name === name);

    it("names the events and the fields once", () => {
        assert.equal(OUTAGE_EVENT, "outageStarted");
        assert.equal(RECOVERED_EVENT, "connectionRestored");
        assert.equal(SEND_OUTAGE_FIELD, "send_outage");
        assert.equal(OUTAGE_AFTER_FIELD, "outage_after");
        assert.equal(OUTAGE_MESSAGE_FIELD, "outage_message");
        assert.equal(RECOVERED_MESSAGE_FIELD, "recovered_message");
    });

    for (const module of ["discord", "telegram", "email", "gotify", "ntfy", "pushover", "webhook"]) {
        it(`offers ${module} the switch, as an optional boolean`, () => {
            assert.deepEqual(field(module, SEND_OUTAGE_FIELD), {name: SEND_OUTAGE_FIELD, type: "boolean", required: false});
        });

        it(`offers ${module} the streak length, as an optional whole number from ${OUTAGE_AFTER_MIN}`, () => {
            assert.deepEqual(field(module, OUTAGE_AFTER_FIELD),
                {name: OUTAGE_AFTER_FIELD, type: "number", required: false, min: OUTAGE_AFTER_MIN});
        });
    }

    for (const module of ["discord", "telegram", "email", "gotify", "ntfy", "pushover"])
        it(`offers ${module} both templates, with the streak's variables`, () => {
            const outage = field(module, OUTAGE_MESSAGE_FIELD);
            const recovered = field(module, RECOVERED_MESSAGE_FIELD);

            for (const template of [outage, recovered]) {
                assert.equal(template?.type, "textarea");
                assert.equal(template?.required, false);
            }
            assert.deepEqual(outage?.variables, OUTAGE_VARIABLES);
            assert.deepEqual(recovered?.variables, RECOVERED_VARIABLES);
        });

    it("offers the webhook no template, since what it sends is read by a program", () => {
        assert.ok(!names("webhook").includes(OUTAGE_MESSAGE_FIELD));
        assert.ok(!names("webhook").includes(RECOVERED_MESSAGE_FIELD));
    });

    for (const module of ["mqtt", "influxdb", "healthChecks"])
        it(`offers ${module} none of them`, () => {
            for (const name of [SEND_OUTAGE_FIELD, OUTAGE_AFTER_FIELD, OUTAGE_MESSAGE_FIELD, RECOVERED_MESSAGE_FIELD])
                assert.ok(!names(module).includes(name), name);
        });
});

/**
 * The gate. The streak is one fact about the target; how long a streak is
 * worth a message is each recipient's own setting, so it is judged here, per
 * recipient, the way the fixed limits are - and a member that opted out of
 * alerting is quiet about this too.
 */
describe("suppressesEvent on an outage", () => {
    before(async () => { await initialize(); });

    const row = (data) => ({id: 1, name: "telegram", data});
    const down = (count) => ({[FAILURES_IN_ROW]: count, downSince: SINCE, alerts: true});

    it("lets the failure that reaches the recipient's length through", () => {
        assert.equal(suppressesEvent(OUTAGE_EVENT, "telegram", row({[OUTAGE_AFTER_FIELD]: 3}), down(3)), false);
    });

    it("withholds every failure before and after that one", () => {
        assert.equal(suppressesEvent(OUTAGE_EVENT, "telegram", row({[OUTAGE_AFTER_FIELD]: 3}), down(2)), true);
        assert.equal(suppressesEvent(OUTAGE_EVENT, "telegram", row({[OUTAGE_AFTER_FIELD]: 3}), down(4)), true);
    });

    it("judges each recipient by its own number", () => {
        assert.equal(suppressesEvent(OUTAGE_EVENT, "telegram", row({}), down(DEFAULT_OUTAGE_AFTER)), false);
        assert.equal(suppressesEvent(OUTAGE_EVENT, "telegram", row({[OUTAGE_AFTER_FIELD]: 5}), down(DEFAULT_OUTAGE_AFTER)), true);
    });

    it("lets the recovery through once the streak was long enough", () => {
        assert.equal(suppressesEvent(RECOVERED_EVENT, "telegram", row({[OUTAGE_AFTER_FIELD]: 3}), down(3)), false);
        assert.equal(suppressesEvent(RECOVERED_EVENT, "telegram", row({[OUTAGE_AFTER_FIELD]: 3}), down(7)), false);
    });

    it("withholds a recovery from a blip that was never announced", () => {
        assert.equal(suppressesEvent(RECOVERED_EVENT, "telegram", row({[OUTAGE_AFTER_FIELD]: 3}), down(2)), true);
    });

    it("keeps quiet for a member that opted out of alerting", () => {
        assert.equal(suppressesEvent(OUTAGE_EVENT, "telegram", row({}), {...down(2), alerts: false}), true);
        assert.equal(suppressesEvent(RECOVERED_EVENT, "telegram", row({}), {...down(2), alerts: false}), true);
    });

    it("is not withheld by a threshold, which judges a measurement", () => {
        assert.equal(suppressesEvent(OUTAGE_EVENT, "telegram",
            row({[ALERT_ONLY]: true, alert_download_below: 100}), down(2)), false);
    });

    it("never withholds it from a sink", () => {
        assert.equal(suppressesEvent(OUTAGE_EVENT, "mqtt", row({}), down(1)), false);
    });
});

/**
 * What each notifier does with the two events: sends when its switch is on,
 * stays silent when it is off, and prints the operator's own template when
 * one was written.
 */
describe("the notifiers on an outage", () => {
    const realFetch = globalThis.fetch;
    let sent = [];

    beforeEach(() => {
        sent = [];
        globalThis.fetch = async (url, init = {}) => {
            let body = init.body;
            try {
                body = JSON.parse(init.body);
            } catch {
                // ntfy posts plain text, kept as the string it was sent as.
            }
            sent.push({url: String(url), body});
            return new Response("{}", {status: 200, headers: {"content-type": "application/json"}});
        };
    });

    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    const load = (setup, ...rest) => {
        const events = {};
        setup((name, callback) => { events[name] = callback; }, ...rest);
        return events;
    };

    const fire = (events, name, config, payload) => events[name]({data: config}, payload, () => {});

    const payload = {
        targetName: "WAN", [FAILURES_IN_ROW]: 3, downSince: SINCE, downtimeMinutes: 120,
        [OUTAGE_SUMMARY]: "3 tests in a row have failed since 2026-08-13 11:15"
    };

    const MODULES = [
        ["discord", setupDiscord, {url: "https://discord.com/api/webhooks/1/token"},
            (request) => request.body.embeds[0].description],
        ["telegram", setupTelegram, {token: "123456:abcdefghijklmnopqrstuvwxyz", chat_id: "42"},
            (request) => request.body.text],
        ["gotify", setupGotify, {url: "https://gotify.example.org", token: "AbCdEfGhIjKlMnO"},
            (request) => request.body.message],
        ["pushover", setupPushover, {token: "a".repeat(30), user: "b".repeat(30)},
            (request) => request.body.message],
        ["ntfy", setupNtfy, {url: "https://ntfy.example.org", topic: "myspeed"},
            (request) => String(request.body)]
    ];

    for (const [name, setup, config, textOf] of MODULES) {
        describe(name, () => {
            for (const [event, defaultWords] of [[OUTAGE_EVENT, /down/], [RECOVERED_EVENT, /back/]]) {
                it(`sends ${event} when the switch is on`, async () => {
                    await fire(load(setup), event, {...config, [SEND_OUTAGE_FIELD]: true}, payload);

                    assert.equal(sent.length, 1);
                    const text = textOf(sent[0]);
                    assert.match(text, defaultWords);
                    assert.match(text, /WAN/);
                    assert.match(text, /3 tests in a row/);
                    assert.doesNotMatch(text, /%[a-zA-Z]+%/, "an unsubstituted placeholder was sent");
                });

                it(`stays quiet about ${event} when the switch is off`, async () => {
                    await fire(load(setup), event, {...config, [SEND_OUTAGE_FIELD]: false}, payload);
                    await fire(load(setup), event, config, payload);

                    assert.deepEqual(sent, []);
                });
            }

            it("prints the operator's own templates", async () => {
                const own = {...config, [SEND_OUTAGE_FIELD]: true,
                    [OUTAGE_MESSAGE_FIELD]: "down: %failuresInRow%", [RECOVERED_MESSAGE_FIELD]: "up after %downtimeMinutes%"};

                await fire(load(setup), OUTAGE_EVENT, own, payload);
                await fire(load(setup), RECOVERED_EVENT, own, payload);

                assert.equal(textOf(sent[0]), "down: 3");
                assert.equal(textOf(sent[1]), "up after 120");
            });
        });
    }

    describe("email", () => {
        const mailed = async (event, config) => {
            const mail = [];
            const events = load(setupEmail, () => ({sendMail: async (message) => { mail.push(message); return {accepted: []}; }}));

            await fire(events, event, {host: "smtp.example.com", port: 587,
                from: "myspeed@example.com", to: "ops@example.com", ...config}, payload);

            return mail;
        };

        it("sends both with their own subjects when the switch is on", async () => {
            const [outage] = await mailed(OUTAGE_EVENT, {[SEND_OUTAGE_FIELD]: true});
            const [recovered] = await mailed(RECOVERED_EVENT, {[SEND_OUTAGE_FIELD]: true});

            assert.equal(outage.subject, "MySpeed: connection down");
            assert.match(outage.text, /3 tests in a row/);
            assert.equal(recovered.subject, "MySpeed: connection restored");
            assert.match(recovered.text, /Back online|3 tests in a row/);
        });

        it("stays quiet when the switch is off", async () => {
            assert.deepEqual(await mailed(OUTAGE_EVENT, {}), []);
            assert.deepEqual(await mailed(RECOVERED_EVENT, {}), []);
        });
    });

    describe("the webhook", () => {
        const config = {url: "https://hooks.example.org/myspeed"};

        it("posts each as its own event type", async () => {
            await fire(load(setupWebhook), OUTAGE_EVENT, {...config, [SEND_OUTAGE_FIELD]: true}, payload);
            await fire(load(setupWebhook), RECOVERED_EVENT, {...config, [SEND_OUTAGE_FIELD]: true}, payload);

            assert.deepEqual(sent.map((request) => request.body.event), ["OUTAGE_STARTED", "CONNECTION_RESTORED"]);
            assert.equal(sent[0].body.data[FAILURES_IN_ROW], 3);
        });

        it("stays quiet when the switch is off", async () => {
            await fire(load(setupWebhook), OUTAGE_EVENT, config, payload);
            await fire(load(setupWebhook), RECOVERED_EVENT, config, payload);

            assert.deepEqual(sent, []);
        });
    });
});
