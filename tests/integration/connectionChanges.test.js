import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer, api, seedTests, setConfig } from "./helpers/boot.js";
import model from "../../server/models/ConnectionChanges.js";
import * as integrations from "../../server/controller/integrations.js";
import { CONNECTION_SUMMARY } from "../../server/util/notificationPayload.js";
import { IP_CHANGED_EVENT } from "../../server/util/connectionChange.js";

let server;
let changes;
let speedtests;

const MS_PER_DAY = 86400000;
const PASSWORD = "Correct-Horse-1";
// One clock reading for the file, so a row seeded "one day ago" is found
// again by the same expression a moment later.
const NOW = Date.now();
const at = (daysAgo, minute = 0) => new Date(NOW - daysAgo * MS_PER_DAY + minute * 60000).toISOString();

before(async () => {
    server = await bootServer();
    changes = await import("../../server/controller/connectionChanges.js");
    speedtests = await import("../../server/controller/speedtests.js");
});

after(async () => {
    delete process.env.PREVIEW_MODE;
    await server?.close();
});

beforeEach(async () => {
    await model.destroy({where: {}});
    await seedTests(server.tests, []);
    await setConfig(server.config, "retentionDays", "365");
});

/** A stored test as the run loop hands it to the verdict: id, instant and the connection it saw. */
const seen = async (row) => {
    const [stored] = await server.tests.findAll({where: {created: row.created}});
    return {id: stored.id, created: stored.created, isp: stored.isp, externalIp: stored.externalIp, provider: stored.provider, targetId: stored.targetId};
};

const target = {id: 3, name: "WAN", alerts: true};

describe("what the verdict compares against", () => {
    it("the newest earlier address of the same family, whichever provider saw it", async () => {
        await seedTests(server.tests, [
            {targetId: 3, created: at(3), externalIp: "203.0.113.1", isp: "Net", provider: "ookla"},
            {targetId: 3, created: at(2), externalIp: "2001:db8::1", isp: null, provider: "cloudflare"},
            {targetId: 3, created: at(1), externalIp: "203.0.113.2", isp: null, provider: "cloudflare"},
            {targetId: 3, created: at(0), externalIp: "203.0.113.9", isp: "Net", provider: "ookla"}
        ]);

        const previous = await changes.previousIdentity(await seen({targetId: 3, created: at(0)}));

        assert.equal(previous.externalIp, "203.0.113.2");
    });

    // Its own earlier runs only. Two targets pinned to two WAN links of one
    // family would otherwise find each other's address as "the previous
    // one" and log a change on every alternation.
    it("only what the same target saw before", async () => {
        await seedTests(server.tests, [
            {targetId: 3, created: at(3), externalIp: "203.0.113.1", isp: "Net"},
            {targetId: 4, created: at(2), externalIp: "198.51.100.7", isp: "Other Net"},
            {targetId: null, created: at(1), externalIp: "192.0.2.9", isp: "Old Net"},
            {targetId: 3, created: at(0), externalIp: "203.0.113.1", isp: "Net"}
        ]);

        const previous = await changes.previousIdentity(await seen({created: at(0)}));

        assert.deepEqual(previous, {externalIp: "203.0.113.1", isp: "Net"});
    });

    it("the newest earlier provider name from the same provider", async () => {
        await seedTests(server.tests, [
            {targetId: 3, created: at(3), externalIp: "203.0.113.1", isp: "Ookla says A", provider: "ookla"},
            {targetId: 3, created: at(2), externalIp: "203.0.113.1", isp: "Libre says B", provider: "libre"},
            {targetId: 3, created: at(0), externalIp: "203.0.113.1", isp: "Ookla says A", provider: "ookla"}
        ]);

        const previous = await changes.previousIdentity(await seen({targetId: 3, created: at(0)}));

        assert.equal(previous.isp, "Ookla says A");
    });

    it("never the run itself, nor one after it", async () => {
        await seedTests(server.tests, [
            {targetId: 3, created: at(1), externalIp: "203.0.113.1", isp: "Net"},
            {targetId: 3, created: at(0, 5), externalIp: "203.0.113.5", isp: "Later"}
        ]);

        const previous = await changes.previousIdentity(await seen({targetId: 3, created: at(1)}));

        assert.deepEqual(previous, {externalIp: null, isp: null});
    });

    it("nothing from further back than the lookback", async () => {
        await seedTests(server.tests, [
            {targetId: 3, created: at(changes.LOOKBACK_DAYS + 1), externalIp: "203.0.113.1", isp: "Net"},
            {targetId: 3, created: at(0), externalIp: "203.0.113.9", isp: "Net"}
        ]);

        const previous = await changes.previousIdentity(await seen({targetId: 3, created: at(0)}));

        assert.deepEqual(previous, {externalIp: null, isp: null});
    });
});

describe("recording a change", () => {
    it("writes a row naming the change, the test and the member, and answers it", async () => {
        await seedTests(server.tests, [
            {targetId: 3, created: at(1), externalIp: "203.0.113.1", isp: "Old Net"},
            {targetId: 3, created: at(0), externalIp: "203.0.113.2", isp: "Old Net"}
        ]);
        const test = await seen({targetId: 3, created: at(0)});

        const change = await changes.recordChange(test, target);

        assert.equal(change.testId, test.id);
        assert.equal(change.targetId, 3);
        assert.equal(change.created, test.created);
        assert.equal(change.provider, "ookla");
        assert.equal(change.previousIp, "203.0.113.1");
        assert.equal(change.ip, "203.0.113.2");
        assert.equal(change.previousIsp, null);
        assert.equal(change.isp, null);
        assert.equal(typeof change.id, "number");

        assert.equal(await model.count(), 1);
    });

    it("writes nothing, and answers null, when nothing changed", async () => {
        await seedTests(server.tests, [
            {targetId: 3, created: at(1), externalIp: "203.0.113.1", isp: "Net"},
            {targetId: 3, created: at(0), externalIp: "203.0.113.1", isp: "Net"}
        ]);

        assert.equal(await changes.recordChange(await seen({targetId: 3, created: at(0)}), target), null);
        assert.equal(await model.count(), 0);
    });

    it("writes nothing for a run that saw no connection at all", async () => {
        await seedTests(server.tests, [
            {targetId: 3, created: at(1), externalIp: "203.0.113.1", isp: "Net"},
            {targetId: 3, created: at(0), externalIp: null, isp: null, provider: "iperf3"}
        ]);

        assert.equal(await changes.recordChange(await seen({targetId: 3, created: at(0)}), target), null);
        assert.equal(await model.count(), 0);
    });

    it("keeps the log to its limit, dropping the oldest", async () => {
        const rows = Array.from({length: changes.CHANGE_LOG_LIMIT}, (_, i) => ({
            created: new Date(Date.UTC(2020, 0, 1) + i * 60000).toISOString(),
            testId: null, targetId: null, provider: "ookla", previousIp: "203.0.113.1", ip: "203.0.113.2"
        }));
        await model.bulkCreate(rows);
        await seedTests(server.tests, [
            {targetId: 3, created: at(1), externalIp: "203.0.113.1", isp: "Net"},
            {targetId: 3, created: at(0), externalIp: "203.0.113.2", isp: "Net"}
        ]);

        await changes.recordChange(await seen({targetId: 3, created: at(0)}), target);

        assert.equal(await model.count(), changes.CHANGE_LOG_LIMIT);
        assert.equal(await model.count({where: {created: rows[0].created}}), 0, "the oldest row survived");
        assert.equal(await model.count({where: {targetId: 3, created: at(0)}}), 1, "the newest row was the one dropped");
    });

    it("answers null rather than throwing when the database refuses", async () => {
        await seedTests(server.tests, [
            {targetId: 3, created: at(1), externalIp: "203.0.113.1", isp: "Net"},
            {targetId: 3, created: at(0), externalIp: "203.0.113.2", isp: "Net"}
        ]);
        const test = await seen({targetId: 3, created: at(0)});

        const change = await changes.recordChange({...test, provider: null}, target);

        assert.equal(change, null);
    });
});

describe("listing the log", () => {
    it("answers newest first, at most the listed maximum", async () => {
        const rows = Array.from({length: changes.MAX_LISTED + 1}, (_, i) => ({
            created: new Date(Date.UTC(2020, 0, 1) + i * 60000).toISOString(),
            provider: "ookla", previousIp: "203.0.113.1", ip: "203.0.113.2"
        }));
        await model.bulkCreate(rows);

        const listed = await changes.listChanges();

        assert.equal(listed.length, changes.MAX_LISTED);
        assert.equal(listed[0].created, rows.at(-1).created);
        assert.ok(listed[0].created > listed[1].created);
    });

    it("answers plain rows", async () => {
        await model.create({targetId: 3, created: at(0), provider: "ookla", previousIsp: "A", isp: "B"});

        const [row] = await changes.listChanges();

        assert.deepEqual(Object.keys(row).sort(),
            ["created", "id", "ip", "isp", "previousIp", "previousIsp", "provider", "targetId", "testId"]);
    });
});

describe("forgetting", () => {
    it("goes with the retention sweep", async () => {
        await model.bulkCreate([
            {targetId: 3, created: at(400), provider: "ookla", previousIp: "a", ip: "b"},
            {targetId: 3, created: at(1), provider: "ookla", previousIp: "b", ip: "c"}
        ]);

        await speedtests.removeOld();

        assert.deepEqual((await model.findAll()).map((row) => row.ip), ["c"]);
    });

    it("goes with the history", async () => {
        await model.create({targetId: 3, created: at(1), provider: "ookla", previousIp: "b", ip: "c"});

        await speedtests.deleteTests();

        assert.equal(await model.count(), 0);
    });

    it("goes with the one test that saw it, and no other", async () => {
        await seedTests(server.tests, [{created: at(2), externalIp: "b"}, {created: at(1), externalIp: "c"}]);
        const [older, newer] = await Promise.all([seen({created: at(2)}), seen({created: at(1)})]);
        await model.bulkCreate([
            {targetId: 3, testId: older.id, created: at(2), provider: "ookla", previousIp: "a", ip: "b"},
            {targetId: 3, testId: newer.id, created: at(1), provider: "ookla", previousIp: "b", ip: "c"}
        ]);

        assert.equal(await speedtests.deleteOne(newer.id), true);

        assert.deepEqual((await model.findAll()).map((row) => row.ip), ["b"]);
    });
});

describe("the route", () => {
    const admin = (pathname, options = {}) =>
        api(server.baseUrl, pathname, {...options, headers: {"x-password": PASSWORD, ...options.headers}});

    beforeEach(async () => {
        await setConfig(server.config, "password", PASSWORD);
    });

    afterEach(async () => {
        delete process.env.PREVIEW_MODE;
        await setConfig(server.config, "password", "none");
    });

    it("hands the operator the log, newest first", async () => {
        await model.bulkCreate([
            {targetId: 3, created: at(2), provider: "ookla", previousIp: "a", ip: "b"},
            {targetId: 3, created: at(1), provider: "ookla", previousIsp: "A", isp: "B"}
        ]);

        const {status, body} = await admin("/speedtests/connections");

        assert.equal(status, 200);
        assert.deepEqual(body.map((row) => [row.ip, row.isp]), [[null, "B"], ["b", null]]);
    });

    it("is not a test called connections", async () => {
        const {status} = await admin("/speedtests/connections");

        assert.equal(status, 200);
    });

    it("refuses a reader without the password", async () => {
        assert.equal((await api(server.baseUrl, "/speedtests/connections")).status, 401);
    });

    // A read-level password opens every password(true) route to a reader
    // without one; this route is not among them.
    it("refuses a viewer", async () => {
        await setConfig(server.config, "passwordLevel", "read");

        try {
            assert.equal((await api(server.baseUrl, "/speedtests")).status, 200, "the viewer gate is not open");
            assert.equal((await api(server.baseUrl, "/speedtests/connections")).status, 401);
        } finally {
            await setConfig(server.config, "passwordLevel", "none");
        }
    });

    it("refuses everyone on a demo", async () => {
        process.env.PREVIEW_MODE = "true";

        assert.equal((await admin("/speedtests/connections")).status, 403);
    });
});

/**
 * The dispatch: a change reaches a notifier with its summary composed in
 * that integration's language, the way a finished test reaches it with its
 * alert summary.
 */
describe("telling the integrations", () => {
    const realFetch = globalThis.fetch;
    let sent;

    beforeEach(async () => {
        sent = [];
        // The server's own API is reached through the same fetch: only the
        // outbound send is recorded.
        globalThis.fetch = async (url, init = {}) => {
            if (String(url).startsWith(server.baseUrl)) return realFetch(url, init);
            sent.push({url: String(url), body: JSON.parse(init.body)});
            return new Response("{}", {status: 200, headers: {"content-type": "application/json"}});
        };
        for (const row of await integrations.getActive()) await integrations.deleteIntegration(row.id);
    });

    afterEach(async () => {
        globalThis.fetch = realFetch;
        for (const row of await integrations.getActive()) await integrations.deleteIntegration(row.id);
    });

    const createWebhook = async (fields) => {
        const {status, body} = await api(server.baseUrl, "/integrations/webhook", {
            method: "PUT", headers: {"content-type": "application/json"},
            body: JSON.stringify({url: "https://hooks.lan/x", integration_name: "hook", ...fields})
        });
        assert.equal(status, 200, JSON.stringify(body));
    };

    it("reaches a webhook that asked, with the summary composed", async () => {
        await createWebhook({send_ip_changed: true});

        await integrations.triggerEvent(IP_CHANGED_EVENT, {
            ip: "203.0.113.2", previousIp: "203.0.113.1", previousIsp: null, isp: null, targetName: "WAN", alerts: true
        });

        assert.equal(sent.length, 1);
        assert.equal(sent[0].body.event, "IP_CHANGED");
        assert.equal(sent[0].body.data[CONNECTION_SUMMARY], "IP address 203.0.113.1 → 203.0.113.2");
    });

    it("does not reach one that did not ask", async () => {
        await createWebhook({send_ip_changed: false});

        await integrations.triggerEvent(IP_CHANGED_EVENT, {ip: "203.0.113.2", previousIp: "203.0.113.1", alerts: true});

        assert.equal(sent.length, 0);
    });

    it("stays quiet for a member that opted out of alerting", async () => {
        await createWebhook({send_ip_changed: true});

        await integrations.triggerEvent(IP_CHANGED_EVENT, {ip: "203.0.113.2", previousIp: "203.0.113.1", alerts: false});

        assert.equal(sent.length, 0);
    });
});
