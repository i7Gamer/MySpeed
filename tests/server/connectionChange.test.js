import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import {
    IPV4, IPV6, IP_CHANGED_EVENT, IP_CHANGED_MESSAGE_FIELD, SEND_IP_CHANGED_FIELD,
    addressFamily, describeChange, normalisedIsp, storableAddress, storableIsp
} from "../../server/util/connectionChange.js";
import { connectionSummary, plainDefaults } from "../../server/util/notificationLocale.js";
import {
    CONNECTION_SUMMARY, CONNECTION_VARIABLES, FINISHED_VARIABLES, connectionChangedPayload
} from "../../server/util/notificationPayload.js";
import { DATE_VARIABLES } from "../../server/util/helpers.js";
import { ALERT_ONLY } from "../../server/util/alertThreshold.js";
import { getIntegration, initialize, suppressesEvent } from "../../server/controller/integrations.js";

/*
 * What counts as the connection having changed, and how that is told.
 *
 * Every Ookla row stores the address the provider saw and the network it
 * named, and the detail pane has long marked a row whose pair differs from
 * the one before. This is the verdict behind that mark, judged on the server
 * once per run so it can be kept and told: which of the two changed, from
 * what, and the sentence a notifier prints about it.
 */

describe("addressFamily", () => {
    it("tells the two families apart", () => {
        assert.equal(addressFamily("203.0.113.10"), IPV4);
        assert.equal(addressFamily("2001:db8::1"), IPV6);
    });

    it("answers zero for anything that is not an address", () => {
        for (const value of [null, undefined, "", "not an ip", "203.0.113", 42, {}])
            assert.equal(addressFamily(value), 0, JSON.stringify(value));
    });

    it("forgives the whitespace a provider may print around it", () => {
        assert.equal(addressFamily(" 203.0.113.10 "), IPV4);
    });
});

/**
 * Providers spell a network their own way, and the comparison must not turn
 * "Telekom  Deutschland" against "telekom deutschland" into a change.
 */
describe("normalisedIsp", () => {
    it("folds case and runs of whitespace", () => {
        assert.equal(normalisedIsp("  Telekom   Deutschland "), "telekom deutschland");
    });

    it("answers null for nothing", () => {
        for (const value of [null, undefined, "", "   ", 42])
            assert.equal(normalisedIsp(value), null, JSON.stringify(value));
    });
});

describe("what a row may store", () => {
    it("keeps an address, trimmed, and nothing that is not one", () => {
        assert.equal(storableAddress(" 203.0.113.10 "), "203.0.113.10");
        assert.equal(storableAddress("2001:db8::1"), "2001:db8::1");
        for (const value of [null, undefined, "", "   ", "unknown", "203.0.113", 42])
            assert.equal(storableAddress(value), null, JSON.stringify(value));
    });

    it("keeps a provider's name, trimmed, and nothing blank", () => {
        assert.equal(storableIsp(" Old Net "), "Old Net");
        for (const value of [null, undefined, "", "   ", 42])
            assert.equal(storableIsp(value), null, JSON.stringify(value));
    });
});

describe("describeChange", () => {
    const before = {externalIp: "203.0.113.10", isp: "Old Net"};

    it("says nothing when nothing changed", () => {
        assert.equal(describeChange({externalIp: "203.0.113.10", isp: "Old Net"}, before), null);
    });

    it("names an address that changed, and only that", () => {
        assert.deepEqual(describeChange({externalIp: "203.0.113.20", isp: "Old Net"}, before),
            {previousIp: "203.0.113.10", ip: "203.0.113.20", previousIsp: null, isp: null});
    });

    it("names a provider that changed, and only that", () => {
        assert.deepEqual(describeChange({externalIp: "203.0.113.10", isp: "New Net"}, before),
            {previousIp: null, ip: null, previousIsp: "Old Net", isp: "New Net"});
    });

    it("names both when both changed", () => {
        assert.deepEqual(describeChange({externalIp: "203.0.113.20", isp: "New Net"}, before),
            {previousIp: "203.0.113.10", ip: "203.0.113.20", previousIsp: "Old Net", isp: "New Net"});
    });

    // A dual-stack line answers one run over IPv6 and the next over IPv4,
    // and that is not the address rotating: an address is compared only
    // against the last one of its own family.
    it("never compares across address families", () => {
        assert.equal(describeChange({externalIp: "2001:db8::1", isp: "Old Net"}, before), null);
    });

    // A run that reported nothing - cloudflare names no network, iperf3
    // names neither - is not a change to nothing, and the first run after an
    // upgrade has nothing before it.
    it("does not count a value that is missing on either side", () => {
        for (const missing of [null, undefined, ""]) {
            assert.equal(describeChange({externalIp: missing, isp: missing}, before), null, JSON.stringify(missing));
            assert.equal(describeChange({externalIp: "203.0.113.20", isp: "New Net"},
                {externalIp: missing, isp: missing}), null, JSON.stringify(missing));
        }
    });

    it("reads a provider's spelling loosely and an address exactly", () => {
        assert.equal(describeChange({externalIp: " 203.0.113.10", isp: "OLD  NET"}, before), null);
        assert.notEqual(describeChange({externalIp: "203.0.113.11", isp: "Old Net"}, before), null);
    });

    it("keeps the provider's own spelling in the verdict", () => {
        const change = describeChange({externalIp: "203.0.113.10", isp: "  New Net "}, before);

        assert.equal(change.isp, "  New Net ");
    });
});

/**
 * The sentence a notifier prints, in the recipient's language, filled in at
 * the dispatch point the way the alert summary is - a template has no
 * conditional, and "IP a → a" for a run that changed only its provider is
 * what a template without one would print.
 */
describe("connectionSummary", () => {
    const both = {previousIp: "203.0.113.10", ip: "203.0.113.20", previousIsp: "Old Net", isp: "New Net"};

    it("names the address change", () => {
        assert.equal(connectionSummary({...both, previousIsp: null, isp: null}, "en"), "IP address 203.0.113.10 → 203.0.113.20");
    });

    it("names the provider change", () => {
        assert.equal(connectionSummary({...both, previousIp: null, ip: null}, "en"), "Provider Old Net → New Net");
    });

    it("puts each on its own line when both changed", () => {
        assert.equal(connectionSummary(both, "en"), "IP address 203.0.113.10 → 203.0.113.20\nProvider Old Net → New Net");
    });

    it("is empty for a payload that changed nothing", () => {
        assert.equal(connectionSummary({}, "en"), "");
        assert.equal(connectionSummary(null, "en"), "");
    });

    it("falls back to English for a language nobody wrote", () => {
        assert.equal(connectionSummary(both, "xx"), connectionSummary(both, "en"));
    });
});

describe("the plain default template for a change", () => {
    it("names the target and ends on the summary", () => {
        const template = plainDefaults("en").ipChanged;

        assert.match(template, /%targetName%/);
        assert.match(template, new RegExp(`%${CONNECTION_SUMMARY}%$`));
        assert.match(template, /The connection has changed/);
    });
});

describe("the payload a change travels as", () => {
    const row = {
        created: "2026-09-07T10:00:00.000Z", testId: 99, targetId: 3, targetName: "WAN", provider: "ookla",
        previousIp: "203.0.113.10", ip: "203.0.113.20", previousIsp: null, isp: null, alerts: true
    };

    it("carries the change, which test saw it and which member ran that test", () => {
        const payload = connectionChangedPayload({id: 7, ...row});

        for (const key of Object.keys(row)) assert.equal(payload[key], row[key], key);
    });

    // %id% is the test on every other template; the log row's own id would
    // be the one number a template author reaches for and gets wrong.
    it("does not offer the log row's id as %id%", () => {
        assert.equal(Object.hasOwn(connectionChangedPayload({id: 7, ...row}), "id"), false);
        assert.ok(!CONNECTION_VARIABLES.includes("id"));
    });

    it("answers with every key even for a record that carries none of them", () => {
        const payload = connectionChangedPayload({});

        for (const key of CONNECTION_VARIABLES.filter((name) => !DATE_VARIABLES.includes(name)))
            assert.ok(Object.hasOwn(payload, key), `${key} is not on the payload`);
    });

    it("leaves room for the summary the dispatcher fills in", () => {
        assert.ok(CONNECTION_VARIABLES.includes(CONNECTION_SUMMARY));
    });

    it("nests nothing", () => {
        for (const value of Object.values(connectionChangedPayload(row)))
            assert.ok(value === null || typeof value !== "object", "a nested value substitutes as [object Object]");
    });

    it("advertises the clock like the other two", () => {
        for (const name of DATE_VARIABLES) assert.ok(CONNECTION_VARIABLES.includes(name), name);
    });

    it("is not confused with a finished test", () => {
        assert.ok(!FINISHED_VARIABLES.includes(CONNECTION_SUMMARY));
    });
});

/**
 * The switches. One boolean on every notifier, off until the operator turns
 * it on - nobody is opted into a new message by an upgrade - and one template
 * on every notifier that writes prose, offered the change's own variables.
 */
describe("the fields the change adds to a notifier", () => {
    before(async () => { await initialize(); });

    const names = (module) => getIntegration(module).fields.map((field) => field.name);
    const field = (module, name) => getIntegration(module).fields.find((candidate) => candidate.name === name);

    it("names the event and the two fields once", () => {
        assert.equal(IP_CHANGED_EVENT, "ipChanged");
        assert.equal(SEND_IP_CHANGED_FIELD, "send_ip_changed");
        assert.equal(IP_CHANGED_MESSAGE_FIELD, "ip_changed_message");
    });

    for (const module of ["discord", "telegram", "email", "gotify", "ntfy", "pushover", "webhook"])
        it(`offers ${module} the switch, as an optional boolean`, () => {
            assert.deepEqual(field(module, SEND_IP_CHANGED_FIELD), {name: SEND_IP_CHANGED_FIELD, type: "boolean", required: false});
        });

    for (const module of ["discord", "telegram", "email", "gotify", "ntfy", "pushover"])
        it(`offers ${module} the template, with the change's variables`, () => {
            const template = field(module, IP_CHANGED_MESSAGE_FIELD);

            assert.equal(template?.type, "textarea");
            assert.equal(template?.required, false);
            assert.deepEqual(template?.variables, CONNECTION_VARIABLES);
        });

    it("offers the webhook no template, since what it sends is read by a program", () => {
        assert.ok(!names("webhook").includes(IP_CHANGED_MESSAGE_FIELD));
    });

    for (const module of ["mqtt", "influxdb", "healthChecks"])
        it(`offers ${module} neither`, () => {
            assert.ok(!names(module).includes(SEND_IP_CHANGED_FIELD));
            assert.ok(!names(module).includes(IP_CHANGED_MESSAGE_FIELD));
        });
});

/**
 * The gate. A member that opted out of alerting is quiet to every notifier
 * about this too - its address is not the line anyone watches - while the
 * thresholds, which judge a measurement, have nothing to say about it.
 */
describe("suppressesEvent on a change", () => {
    before(async () => { await initialize(); });

    const row = (data) => ({id: 1, name: "telegram", data});
    const change = {ip: "203.0.113.20", previousIp: "203.0.113.10", alerts: true};

    it("lets a change through", () => {
        assert.equal(suppressesEvent(IP_CHANGED_EVENT, "telegram", row({}), change), false);
    });

    it("keeps quiet for a member that opted out of alerting", () => {
        assert.equal(suppressesEvent(IP_CHANGED_EVENT, "telegram", row({}), {...change, alerts: false}), true);
    });

    it("reads an absent flag as alerting", () => {
        assert.equal(suppressesEvent(IP_CHANGED_EVENT, "telegram", row({}), {...change, alerts: null}), false);
    });

    it("is not withheld by a threshold, which judges a measurement", () => {
        assert.equal(suppressesEvent(IP_CHANGED_EVENT, "telegram",
            row({[ALERT_ONLY]: true, alert_download_below: 100}), change), false);
    });

    it("never withholds it from a sink", () => {
        assert.equal(suppressesEvent(IP_CHANGED_EVENT, "webhook", row({}), {...change, alerts: false}), true,
            "the webhook is a notifier and follows the member's switch");
        assert.equal(suppressesEvent(IP_CHANGED_EVENT, "mqtt", row({}), {...change, alerts: false}), false);
    });
});
