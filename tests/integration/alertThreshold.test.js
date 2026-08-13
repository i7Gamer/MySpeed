import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer, api } from "./helpers/boot.js";

let server;
let triggerEvent;
let getActive;

const realFetch = globalThis.fetch;
let sent = [];

before(async () => {
    server = await bootServer();

    const controller = await import("../../server/controller/integrations.js");
    triggerEvent = controller.triggerEvent;
    getActive = controller.getActive;
});

after(async () => {
    globalThis.fetch = realFetch;
    await server?.close();
});

/**
 * Records what the integrations send, and only that.
 *
 * The test drives the server through its own HTTP API, so a stub over every
 * fetch would swallow the calls setting the scenario up as well - and answer
 * them with an empty body, which is how the created integration's id went
 * missing rather than the assertion failing on what it meant to check.
 */
beforeEach(() => {
    sent = [];
    globalThis.fetch = async (url, init = {}) => {
        if (String(url).startsWith(server.baseUrl)) return realFetch(url, init);

        sent.push({url: String(url), body: init.body});
        return new Response("{}", {status: 200, headers: {"content-type": "application/json"}});
    };
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

/**
 * The gate, exercised the whole way through: a stored row, the real event
 * dispatch, and the outbound request that either happens or does not.
 *
 * The unit tests pin the decision; this pins that the decision is actually
 * reached. triggerEvent reads its rows from the database on every event, so
 * nothing below the HTTP layer is stubbed except the network itself.
 */
const GOOD = {ping: 12, jitter: 2, download: 500, upload: 200, time: 14};
const SLOW = {ping: 12, jitter: 2, download: 40, upload: 200, time: 14};

const createTelegram = async (settings) => {
    const {status, body} = await api(server.baseUrl, "/integrations/telegram", {
        method: "PUT",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({
            token: "123456:abcdefghijklmnopqrstuvwxyz", chat_id: "42",
            send_finished: true, send_failed: true,
            integration_name: "alerts", ...settings
        })
    });

    assert.equal(status, 200, `could not create the integration: ${JSON.stringify(body)}`);

    return body.id;
};

const remove = async (id) =>
    await api(server.baseUrl, `/integrations/${id}`, {method: "DELETE"});

const rowOf = async (id) => (await getActive()).find((row) => row.id === id);

describe("only notifying when a limit is missed", () => {
    it("says nothing about a result that meets every limit", async () => {
        const id = await createTelegram({alert_only: true, alert_download_below: 100});
        try {
            await triggerEvent("testFinished", GOOD);
            assert.deepEqual(sent, [], "a healthy result was still announced");
        } finally {
            await remove(id);
        }
    });

    it("announces a result that misses one", async () => {
        const id = await createTelegram({alert_only: true, alert_download_below: 100});
        try {
            await triggerEvent("testFinished", SLOW);

            assert.equal(sent.length, 1);
            assert.match(sent[0].url, /api\.telegram\.org/);
        } finally {
            await remove(id);
        }
    });

    /**
     * A failure is the notification people most want, and it carries no
     * measurement the limits could be applied to in any case.
     */
    it("still announces a failed test", async () => {
        const id = await createTelegram({alert_only: true, alert_download_below: 100});
        try {
            await triggerEvent("testFailed", "no route to host");
            assert.equal(sent.length, 1, "a failure was suppressed");
        } finally {
            await remove(id);
        }
    });

    // Every integration that predates this feature, and every one whose owner
    // has not switched it on, keeps behaving exactly as it did.
    it("leaves an integration that never asked for it alone", async () => {
        const id = await createTelegram({});
        try {
            await triggerEvent("testFinished", GOOD);
            assert.equal(sent.length, 1, "an integration with no limits set went quiet");
        } finally {
            await remove(id);
        }
    });

    /**
     * The card reads these columns to decide between "last run …" and "Never
     * executed". An integration doing exactly what it was asked - staying quiet
     * through a run of healthy tests - must not present itself as one that has
     * never worked.
     */
    it("records that it considered the result it stayed quiet about", async () => {
        const id = await createTelegram({alert_only: true, alert_download_below: 100});
        try {
            assert.equal((await rowOf(id)).lastActivity, null, "a fresh row already claims activity");

            await triggerEvent("testFinished", GOOD);

            const row = await rowOf(id);
            assert.notEqual(row.lastActivity, null, "the card would read \"Never executed\"");
            // Read as the card reads it: sqlite hands a boolean column back as
            // 0 or 1, and the status dot is chosen on truthiness.
            assert.ok(!row.activityFailed, "staying quiet was recorded as a failure");
        } finally {
            await remove(id);
        }
    });

    /**
     * influxdb registers only testFinished and writes one point per test, so
     * suppressing the good results would leave a gap in the series exactly
     * where the line was healthy. It is not offered the settings at all, and
     * must not be gated even if a row carries them from somewhere else.
     */
    it("never withholds a point from the metrics sink", async () => {
        const {status, body} = await api(server.baseUrl, "/integrations/influxdb", {
            method: "PUT",
            headers: {"content-type": "application/json"},
            body: JSON.stringify({
                url: "https://influx.example.invalid", token: "secret-token",
                org: "myspeed", bucket: "speed", integration_name: "metrics"
            })
        });
        assert.equal(status, 200, `could not create influxdb: ${JSON.stringify(body)}`);

        try {
            await triggerEvent("testFinished", GOOD);
            assert.equal(sent.length, 1, "a healthy measurement was dropped from the time series");
        } finally {
            await remove(body.id);
        }
    });
});
