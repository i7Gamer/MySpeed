import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer, api, seedTarget, seedTests } from "./helpers/boot.js";
import { FAILED_TEST } from "../../server/util/testOutcome.js";
import {
    DEFAULT_OUTAGE_AFTER, FAILURES_IN_ROW, OUTAGE_AFTER_FIELD, OUTAGE_EVENT, RECOVERED_EVENT, SEND_OUTAGE_FIELD
} from "../../server/util/outage.js";
import { outagePayload, recoveredPayload } from "../../server/util/notificationPayload.js";

/**
 * The outage, the whole way through: the streak query over stored rows, the
 * three keys the task reads off it, the gate that judges them per recipient
 * and the outbound request that either happens or does not.
 *
 * The unit suite (tests/server/outage.test.js) pins each link without a
 * database. This is where a streak that is counted but never carried, or a
 * row the filter does not recognise as a failure, actually shows up. The run
 * itself is the one thing not driven here, for the reason the baseline
 * suite gives: executeTarget spawns a CLI.
 */

let server;
let failureStreak;
let streakKeys;
let triggerEvent;

const realFetch = globalThis.fetch;
let sent = [];

before(async () => {
    server = await bootServer();

    ({failureStreak} = await import("../../server/controller/speedtests.js"));
    ({streakKeys} = await import("../../server/tasks/speedtest.js"));
    ({triggerEvent} = await import("../../server/controller/integrations.js"));
});

after(async () => {
    globalThis.fetch = realFetch;
    await server?.close();
});

beforeEach(() => {
    sent = [];
    globalThis.fetch = async (url, init = {}) => {
        if (String(url).startsWith(server.baseUrl)) return realFetch(url, init);

        sent.push({url: String(url), body: JSON.parse(init.body)});
        return new Response("{}", {status: 200, headers: {"content-type": "application/json"}});
    };
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

const MS_PER_HOUR = 3_600_000;

const hoursAgo = (hours) => new Date(Date.now() - hours * MS_PER_HOUR).toISOString();

/** A row that failed, as tasks/speedtest.js writes one. */
const failed = (targetId, hours) => ({
    targetId, created: hoursAgo(hours),
    ping: FAILED_TEST, download: FAILED_TEST, upload: FAILED_TEST, time: null, error: "no route to host"
});

const succeeded = (targetId, hours) => ({targetId, created: hoursAgo(hours)});

const iso = (value) => new Date(value).toISOString();

describe("failureStreak", () => {
    it("is nothing for a target with no rows", async () => {
        const target = await seedTarget({name: "WAN"});
        await seedTests(server.tests, []);

        assert.deepEqual(await failureStreak(target.id), {count: 0, since: null});
    });

    it("is nothing while the newest row succeeded", async () => {
        const target = await seedTarget({name: "WAN"});
        await seedTests(server.tests, [failed(target.id, 3), failed(target.id, 2), succeeded(target.id, 1)]);

        assert.deepEqual(await failureStreak(target.id), {count: 0, since: null});
    });

    it("counts the failures since the newest success, and names the first of them", async () => {
        const target = await seedTarget({name: "WAN"});
        await seedTests(server.tests, [
            failed(target.id, 9), succeeded(target.id, 4),
            failed(target.id, 3), failed(target.id, 2), failed(target.id, 1)
        ]);

        const streak = await failureStreak(target.id);

        assert.equal(streak.count, 3);
        // The oldest failure after the success, not the one before it.
        assert.ok(new Date(streak.since) > new Date(hoursAgo(4)), iso(streak.since));
        assert.ok(new Date(streak.since) < new Date(hoursAgo(2)), iso(streak.since));
    });

    /**
     * A restored history can carry two rows with one stamp - getLatest says
     * the retried restore does exactly that - and LIST_ORDER breaks the tie on
     * id. A streak that compared `created` alone dropped the failure that
     * shares the newest success's stamp: one short, and "since" an hour late.
     */
    it("counts a failure that shares the newest success's stamp and follows it", async () => {
        const target = await seedTarget({name: "WAN"});
        const stamp = hoursAgo(2);
        // Reuse the exact stamp: separate hoursAgo calls can cross a millisecond,
        // making the failure older than the success instead of tied with it.
        await seedTests(server.tests, [
            {...succeeded(target.id, 2), created: stamp},
            {...failed(target.id, 2), created: stamp}, failed(target.id, 1)
        ]);

        const streak = await failureStreak(target.id);

        assert.equal(streak.count, 2);
        assert.equal(iso(streak.since), iso(stamp));
    });

    it("counts from the first failure for a target that has never succeeded", async () => {
        const target = await seedTarget({name: "WAN"});
        await seedTests(server.tests, [failed(target.id, 2), failed(target.id, 1)]);

        const streak = await failureStreak(target.id);

        assert.equal(streak.count, 2);
        assert.ok(new Date(streak.since) < new Date(hoursAgo(1)));
    });

    it("reads one target's rows only", async () => {
        const wan = await seedTarget({name: "WAN"});
        const targets = await import("../../server/controller/targets.js");
        const lan = await targets.create({name: "LAN", provider: "iperf3", endpoint: "10.0.0.5:5201"});

        await seedTests(server.tests, [
            succeeded(wan.id, 3), failed(lan.id, 2), failed(lan.id, 1)
        ]);

        assert.equal((await failureStreak(wan.id)).count, 0);
        assert.equal((await failureStreak(lan.id)).count, 2);
    });
});

describe("the keys the task reads off the streak", () => {
    it("carry the count, the start and the downtime so far", async () => {
        const target = await seedTarget({name: "WAN"});
        await seedTests(server.tests, [succeeded(target.id, 5), failed(target.id, 2), failed(target.id, 1)]);

        const keys = await streakKeys(target);

        assert.equal(keys[FAILURES_IN_ROW], 2);
        assert.match(keys.downSince, /^\d{4}-\d{2}-\d{2}T/);
        // Two hours give or take the seconds the seeding took.
        assert.ok(keys.downtimeMinutes >= 119 && keys.downtimeMinutes <= 121, String(keys.downtimeMinutes));
    });

    it("say the line is up when it is", async () => {
        const target = await seedTarget({name: "WAN"});
        await seedTests(server.tests, [succeeded(target.id, 1)]);

        assert.deepEqual(await streakKeys(target), {[FAILURES_IN_ROW]: 0, downSince: null, downtimeMinutes: null});
    });
});

const createTelegram = async (settings) => {
    const {status, body} = await api(server.baseUrl, "/integrations/telegram", {
        method: "PUT",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({
            token: "123456:abcdefghijklmnopqrstuvwxyz", chat_id: "42",
            integration_name: "outage", ...settings
        })
    });

    assert.equal(status, 200, `could not create the integration: ${JSON.stringify(body)}`);

    return body.id;
};

const remove = async (id) => await api(server.baseUrl, `/integrations/${id}`, {method: "DELETE"});

const streakOf = (count) => ({
    [FAILURES_IN_ROW]: count, downSince: hoursAgo(count), downtimeMinutes: count * 60,
    targetId: 1, targetName: "WAN", provider: "ookla", alerts: true, primary: true
});

describe("what leaves the instance", () => {
    it("tells a recipient once, on the failure that reaches its own number", async () => {
        const id = await createTelegram({[SEND_OUTAGE_FIELD]: true, [OUTAGE_AFTER_FIELD]: 3});

        try {
            await triggerEvent(OUTAGE_EVENT, outagePayload(streakOf(2)));
            assert.equal(sent.length, 0, "told before the streak was long enough");

            await triggerEvent(OUTAGE_EVENT, outagePayload(streakOf(3)));
            assert.equal(sent.length, 1);
            assert.match(sent[0].url, /api\.telegram\.org/);
            assert.match(sent[0].body.text, /3 tests in a row have failed since \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
            assert.match(sent[0].body.text, /WAN/);

            await triggerEvent(OUTAGE_EVENT, outagePayload(streakOf(4)));
            assert.equal(sent.length, 1, "told again on a later failure of the same outage");
        } finally {
            await remove(id);
        }
    });

    it("tells it the line is back, only from an outage it heard of", async () => {
        const id = await createTelegram({[SEND_OUTAGE_FIELD]: true});

        try {
            await triggerEvent(RECOVERED_EVENT, recoveredPayload(streakOf(DEFAULT_OUTAGE_AFTER - 1)));
            assert.equal(sent.length, 0, "told about a blip it was never told had happened");

            await triggerEvent(RECOVERED_EVENT, recoveredPayload({...streakOf(DEFAULT_OUTAGE_AFTER), ping: 12, download: 100, upload: 50}));
            assert.equal(sent.length, 1);
            assert.match(sent[0].body.text, /Back online after 2 failed tests/);
        } finally {
            await remove(id);
        }
    });

    it("tells a recipient nothing while its switch is off", async () => {
        const id = await createTelegram({send_failed: true});

        try {
            await triggerEvent(OUTAGE_EVENT, outagePayload(streakOf(DEFAULT_OUTAGE_AFTER)));
            await triggerEvent(RECOVERED_EVENT, recoveredPayload(streakOf(DEFAULT_OUTAGE_AFTER)));

            assert.deepEqual(sent, []);
        } finally {
            await remove(id);
        }
    });

    it("stores the number the operator typed, and refuses one that is not a whole test", async () => {
        const id = await createTelegram({[SEND_OUTAGE_FIELD]: true, [OUTAGE_AFTER_FIELD]: 5});

        try {
            const {body} = await api(server.baseUrl, "/integrations/active");
            const stored = body.find((row) => row.id === id);

            assert.equal(stored.data[OUTAGE_AFTER_FIELD], 5);

            const {status} = await api(server.baseUrl, `/integrations/${id}`, {
                method: "PATCH",
                headers: {"content-type": "application/json"},
                body: JSON.stringify({[OUTAGE_AFTER_FIELD]: 0})
            });
            assert.equal(status, 400, "a zero would announce an outage on no failure at all");
        } finally {
            await remove(id);
        }
    });
});
