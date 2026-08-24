import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import {
    initialize, getIntegrations, getIntegration, validateInput, suppressesEvent
} from "../../server/controller/integrations.js";
import { ALERT_METRICS, ALERT_ONLY } from "../../server/util/alertThreshold.js";
import integrationModules from "../../server/integrations/index.js";

/**
 * The threshold settings are declared once and handed to the integrations that
 * are notifiers, rather than copied into each module.
 *
 * initialize() only runs each module's setup function, so none of this needs a
 * database - which is also why the gate itself is a function that can be asked
 * directly instead of only through triggerEvent's fan-out over stored rows.
 */
before(async () => {
    await initialize();
});

const ALERT_FIELD_NAMES = [ALERT_ONLY, ...ALERT_METRICS.map((metric) => metric.field)];

const fieldNames = (name) => getIntegration(name).fields.map((field) => field.name);

/**
 * The two integrations that must never be gated.
 *
 * influxdb is a time series, not a notifier: it registers testFinished alone
 * and writes one point per test, so suppressing the good results leaves a gap
 * in the series exactly where the line was healthy - every "no data" alert
 * fires and every average is taken over the bad tail only.
 *
 * healthChecks is a dead man's switch. Its testStarted ping opens a run and its
 * testFinished ping closes one; that pair is the healthchecks.io protocol.
 * Withhold the closing ping and the run stays open until the service gives up
 * and reports the check as down - so "tell me only when the line is bad" would
 * mean "raise an outage on every good result".
 */
const NOT_NOTIFIERS = ["influxdb", "healthChecks", "mqtt"];

const NOTIFIERS = ["discord", "email", "gotify", "ntfy", "pushover", "telegram", "webhook"];

describe("the shared threshold fields", () => {
    it("covers every integration that exists", () => {
        const known = integrationModules.map((module) => module.name).sort();

        assert.deepEqual(known, [...NOTIFIERS, ...NOT_NOTIFIERS].sort(),
            "an integration was added or removed - decide whether it is a notifier");
    });

    it("reaches every notifier", () => {
        for (const name of NOTIFIERS)
            for (const field of ALERT_FIELD_NAMES)
                assert.ok(fieldNames(name).includes(field), `${name} is missing ${field}`);
    });

    it("is kept away from the integrations that are not notifiers", () => {
        for (const name of NOT_NOTIFIERS)
            for (const field of ALERT_FIELD_NAMES)
                assert.ok(!fieldNames(name).includes(field),
                    `${name} was given ${field}, which would let it be silenced`);
    });

    /**
     * validateInput reads the raw definition initialize() stored, and whitelists
     * the stored payload against exactly that field list. A field injected
     * anywhere else - into the serialisation getIntegrations builds, say - would
     * render in the dialog, accept a value, and have it dropped on save with
     * nothing said.
     */
    it("is accepted by the validator, not just rendered", () => {
        const accepted = validateInput("telegram", {
            token: "123456:abcdefghijklmnop", chat_id: "42",
            [ALERT_ONLY]: true, alert_ping_above: 50, alert_download_below: 100, alert_upload_below: 20
        });

        assert.notEqual(accepted, false);
        assert.equal(accepted[ALERT_ONLY], true);
        assert.equal(accepted.alert_ping_above, 50);
        assert.equal(accepted.alert_download_below, 100);
        assert.equal(accepted.alert_upload_below, 20);
    });

    // The thresholds are compared against measurements stored as doubles, and
    // an upload target of 12.5 Mbit is an ordinary thing to want.
    it("accepts a fractional threshold", () => {
        const accepted = validateInput("telegram", {
            token: "123456:abcdefghijklmnop", chat_id: "42", alert_download_below: 12.5
        });

        assert.notEqual(accepted, false);
        assert.equal(accepted.alert_download_below, 12.5);
    });

    it("still refuses a threshold that is not a number at all", () => {
        for (const bad of ["fast", {}, []])
            assert.equal(validateInput("telegram", {
                token: "123456:abcdefghijklmnop", chat_id: "42", alert_download_below: bad
            }), false, `accepted ${JSON.stringify(bad)}`);
    });

    /**
     * getIntegrations builds its own object per call and the spread of a
     * definition shares the fields array by reference, so appending there would
     * grow the stored definition by another copy on every GET.
     */
    it("does not grow each time the definitions are serialised", () => {
        const before = getIntegrations().telegram.fields.length;
        getIntegrations();
        getIntegrations();

        assert.equal(getIntegrations().telegram.fields.length, before);
        assert.equal(getIntegration("telegram").fields.length, before);
    });

    // initialize() runs from the server's boot and again from the integration
    // test harness, and the fields must not stack up on the second pass.
    it("does not grow when the integrations are loaded twice", async () => {
        const before = fieldNames("telegram").length;
        await initialize();

        assert.equal(fieldNames("telegram").length, before);
    });
});

describe("suppressesEvent", () => {
    const armed = {[ALERT_ONLY]: true, alert_download_below: 100};
    const row = (data) => ({id: 1, name: "telegram", data});
    const good = {ping: 12, download: 500, upload: 200};
    const bad = {ping: 12, download: 40, upload: 200};

    it("suppresses a result that meets every limit", () => {
        assert.equal(suppressesEvent("testFinished", "telegram", row(armed), good), true);
    });

    it("lets a result that misses a limit through", () => {
        assert.equal(suppressesEvent("testFinished", "telegram", row(armed), bad), false);
    });

    /**
     * The gate must not read a fabricated zero as a healthy line.
     *
     * parseCloudflare answers `{ping: 0, download: 0, upload: 0}` on its success
     * path when the CLI printed no usable figures. On an armed latency, judged
     * as `value > limit`, that zero compared bare is the best result imaginable
     * - so the event was withheld on exactly the run nobody could measure.
     */
    it("lets a run whose latency could not be measured through", () => {
        assert.equal(suppressesEvent("testFinished", "telegram",
            row({[ALERT_ONLY]: true, alert_ping_above: 50}),
            {ping: 0, download: 0, upload: 0}), false);
    });

    // Every integration configured before this existed, and every one whose
    // owner has not asked for it, keeps notifying exactly as it did.
    it("suppresses nothing when the gate was never switched on", () => {
        assert.equal(suppressesEvent("testFinished", "telegram", row({}), good), false);
        assert.equal(suppressesEvent("testFinished", "telegram", row(undefined), good), false);
        assert.equal(suppressesEvent("testFinished", "telegram",
            row({alert_download_below: 100}), good), false);
    });

    /**
     * Only the finished-test event. A failure is the notification people most
     * want, the keep-alive ping is how an integration says it is still there,
     * and the rest carry no measurement to judge.
     */
    it("never suppresses any other event", () => {
        for (const event of ["testFailed", "testStarted", "minutePassed",
            "recommendationsUpdated", "configUpdated"])
            assert.equal(suppressesEvent(event, "telegram", row(armed), good), false,
                `${event} was suppressed`);
    });

    it("never suppresses an integration that is not a notifier", () => {
        for (const name of NOT_NOTIFIERS)
            assert.equal(suppressesEvent("testFinished", name, row(armed), good), false,
                `${name} was suppressed`);
    });

    it("never suppresses an integration it has no definition for", () => {
        assert.equal(suppressesEvent("testFinished", "myspace", row(armed), good), false);
    });
});
