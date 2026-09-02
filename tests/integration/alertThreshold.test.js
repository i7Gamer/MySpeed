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

/**
 * The payload parseCloudflare answers on its success path when the CLI printed
 * no usable figures, and the one a dead line answers with.
 *
 * They are the same shape and must be judged differently: nothing delivered is
 * a reading and breaches every speed limit, while a latency of zero is a figure
 * no connection produces.
 */
const UNMEASURED = {ping: 0, jitter: null, download: 0, upload: 0, time: 0};
const DEAD = {ping: 12, jitter: 2, download: 0, upload: 0, time: 14};

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

    // A latency of zero is what a run that measured nothing carries, and the
    // one armed metric is judged as "above", so the bare comparison read it as
    // an excellent line and said nothing.
    it("announces a run whose latency could not be measured", async () => {
        const id = await createTelegram({alert_only: true, alert_ping_above: 50});
        try {
            await triggerEvent("testFinished", UNMEASURED);
            assert.equal(sent.length, 1, "the run nobody could measure went unreported");
        } finally {
            await remove(id);
        }
    });

    // The other direction, and the regression that would be far worse: a line
    // delivering nothing is measured, and it misses every speed limit there is.
    it("announces a line that delivered nothing", async () => {
        const id = await createTelegram({alert_only: true, alert_download_below: 100});
        try {
            await triggerEvent("testFinished", DEAD);
            assert.equal(sent.length, 1, "a dead line was suppressed as if it were healthy");
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
     * Staying quiet must not clear a failure the previous send recorded.
     *
     * Both activity columns are written together, so stamping `lastActivity`
     * for a result the integration was asked to say nothing about also wrote
     * `activityFailed: false` beside it. An integration whose delivery is
     * broken therefore went green on the very next healthy test and stayed
     * there - while, by design, also sending nothing. That is the one
     * combination in which a dead webhook is invisible: the card says "last run
     * just now" with no error, and no message arrives to contradict it.
     */
    it("does not clear a recorded failure by staying quiet", async () => {
        const id = await createTelegram({alert_only: true, alert_download_below: 100});
        try {
            // A breach that cannot be delivered: everything outbound answers 500.
            globalThis.fetch = async (url, init = {}) => {
                if (String(url).startsWith(server.baseUrl)) return realFetch(url, init);
                return new Response("nope", {status: 500});
            };

            await triggerEvent("testFinished", SLOW);
            assert.ok((await rowOf(id)).activityFailed, "the undeliverable send was not recorded as a failure");

            await triggerEvent("testFinished", GOOD);

            assert.ok((await rowOf(id)).activityFailed,
                "staying quiet cleared the failure, so a broken integration reads as healthy");
        } finally {
            await remove(id);
        }
    });

    // The other direction: a send that works clears a previous failure, which
    // is what makes the flag mean anything at all.
    it("clears a recorded failure once a send succeeds", async () => {
        const id = await createTelegram({alert_only: true, alert_download_below: 100});
        try {
            globalThis.fetch = async (url, init = {}) => {
                if (String(url).startsWith(server.baseUrl)) return realFetch(url, init);
                return new Response("nope", {status: 500});
            };
            await triggerEvent("testFinished", SLOW);
            assert.ok((await rowOf(id)).activityFailed);

            globalThis.fetch = async (url, init = {}) => {
                if (String(url).startsWith(server.baseUrl)) return realFetch(url, init);
                return new Response("{}", {status: 200, headers: {"content-type": "application/json"}});
            };
            await triggerEvent("testFinished", SLOW);

            assert.ok(!(await rowOf(id)).activityFailed, "a successful send left the failure standing");
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

/**
 * And what the message that arrives is able to say about it.
 *
 * The clause is built per integration, from that integration's own limits,
 * which is the whole reason it cannot ride the payload the way the baseline's
 * pair does: two integrations watching one test can hold different limits, so
 * the answer differs by recipient. This is the only place that dispatch is
 * exercised end to end.
 */
describe("what the message can say about the crossing", () => {
    it("names the limit it was sent for", async () => {
        const id = await createTelegram({alert_only: true, alert_download_below: 100,
            finished_message: "Alert: %alertCrossed%"});
        try {
            await triggerEvent("testFinished", SLOW);

            assert.equal(sent.length, 1);
            assert.match(String(sent[0].body), /Alert: download 40 Mbps under 100/,
                "the message could not name the limit it was sent for");
        } finally {
            await remove(id);
        }
    });

    // Filled in whether or not this integration filters on its limits. The gate
    // only asks when alert_only is on, and a template naming the variable means
    // the same thing either way - so an operator who set limits and kept every
    // message is not reading "nothing crossed" on the tests that did.
    it("names it on an integration that sends every result", async () => {
        const id = await createTelegram({alert_download_below: 100,
            finished_message: "Alert: %alertCrossed%"});
        try {
            await triggerEvent("testFinished", SLOW);

            assert.equal(sent.length, 1);
            assert.match(String(sent[0].body), /download 40 Mbps under 100/);
        } finally {
            await remove(id);
        }
    });

    /**
     * The shipped template, untouched by the operator, now explains the alert
     * it carries: %alertSummary% sits at its end and substitutes to a passage
     * on a breach and to nothing at all on a healthy result. This is the pair
     * that pins both halves - the passage arriving without anyone editing a
     * template, and the healthy message reading exactly as it always did.
     */
    it("explains a breach in the default template", async () => {
        const id = await createTelegram({alert_only: true, alert_download_below: 100});
        try {
            await triggerEvent("testFinished", SLOW);

            assert.equal(sent.length, 1);
            const body = String(sent[0].body);
            assert.match(body, /Crossed limits: download 40 Mbps under 100/,
                "the shipped template still cannot say why the message arrived");
            assert.doesNotMatch(body, /%alertSummary%/,
                "the token stood unsubstituted in the message");
        } finally {
            await remove(id);
        }
    });

    /**
     * The shipped template and the passage it ends with, in the language the
     * integration was set to - the `language` field every notifier carries.
     * German is the locale the field-label tests hold to a real translation,
     * so it is the one pinned; the words are the locale file's, so what is
     * asserted is that the file is read and the row's setting is honoured.
     */
    it("writes the default template in the integration's own language", async () => {
        const id = await createTelegram({alert_only: true, alert_download_below: 100, language: "de"});
        try {
            await triggerEvent("testFinished", SLOW);

            assert.equal(sent.length, 1);
            const body = String(sent[0].body);
            assert.match(body, /Ein Speedtest ist abgeschlossen/, "the template's own words stayed English");
            assert.match(body, /Grenzwerte überschritten: Download 40 Mbps unter 100/,
                "the summary stayed English");
            assert.doesNotMatch(body, /Crossed limits|A speedtest is finished/);
        } finally {
            await remove(id);
        }
    });

    it("adds nothing to a healthy result's default message", async () => {
        const id = await createTelegram({alert_download_below: 10});
        try {
            await triggerEvent("testFinished", GOOD);

            assert.equal(sent.length, 1);
            const body = String(sent[0].body);
            // Not asserting on N/A: the payload here names no target, and the
            // default's %targetName% legitimately reads unmeasured - what must
            // not appear is the summary's prose or its raw token.
            assert.doesNotMatch(body, /Crossed limits|Below its usual|%alertSummary%/,
                "a healthy message carries alert prose or the raw token");
            assert.match(body, /Download.*: 500 Mbps/,
                "the default message lost its own last line");
        } finally {
            await remove(id);
        }
    });

    // A failure carries no readings at all, so every armed metric would be
    // described as unmeasured - true, and useless beside the %error% the
    // failure template already carries.
    it("describes no crossing on a failure", async () => {
        const id = await createTelegram({alert_ping_above: 50,
            error_message: "Failed: %alertCrossed% %error%"});
        try {
            await triggerEvent("testFailed", {error: "no route to host"});

            assert.equal(sent.length, 1);
            assert.doesNotMatch(String(sent[0].body), /not measured/,
                "a failed run was described as a crossed limit");
        } finally {
            await remove(id);
        }
    });
});
