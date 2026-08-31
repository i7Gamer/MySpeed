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
        // digestReady in the list on purpose: the digest's opt-in is its two
        // per-integration booleans, and the alerts switch quiets per-test
        // noise, not a summary somebody asked for by name.
        for (const event of ["testFailed", "testStarted", "minutePassed",
            "recommendationsUpdated", "configUpdated", "digestReady"])
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

    /**
     * A target's own baseline reaches the same gate, on the payload.
     *
     * The decision is made in util/baselineAlert.js before the row is written -
     * this path cannot query anything - and alertThreshold.test.js matrixes it.
     * What is pinned here is that the composition actually reads it: the flag
     * gate, the threshold gate and the baseline are three separate reasons a
     * testFinished is or is not withheld, and they are combined in one place.
     */
    describe("a member with a baseline of its own", () => {
        const baseline = (overrides) => ({...good, baselineArmed: true, baselineBreached: false, ...overrides});

        // The setup this is all for: alert_only on, no fixed limits, the
        // baseline the only armed thing. Without the arm in breachesThreshold
        // this is the fail-open case and every test is announced.
        it("is quiet while its line holds up, with nothing else armed", () => {
            assert.equal(suppressesEvent("testFinished", "telegram",
                row({[ALERT_ONLY]: true}), baseline()), true);
        });

        it("announces the test that dropped below it", () => {
            assert.equal(suppressesEvent("testFinished", "telegram",
                row({[ALERT_ONLY]: true}), baseline({baselineBreached: true})), false);
        });

        // The two reasons compose: a breached baseline is announced even where
        // every fixed limit was met, and vice versa.
        it("announces a breach a fixed limit would have missed", () => {
            assert.equal(suppressesEvent("testFinished", "telegram",
                row(armed), baseline({baselineBreached: true})), false);
        });

        // And the member flag still stands above both: a target nobody watches
        // says nothing, whatever its own baseline did.
        it("stays quiet for a member that opted out of alerting", () => {
            assert.equal(suppressesEvent("testFinished", "telegram", row(armed),
                baseline({baselineBreached: true, alerts: false})), true);
        });
    });

    /**
     * The alerts switch on a target quiets the notifiers, not the sinks.
     *
     * `target.alerts` used to gate sendFinished and sendError at the source, so
     * a target with alerting off published nothing to InfluxDB, MQTT or the
     * webhooks either: the diagnostic iperf3 box the Targets model describes
     * measured every round and no time series ever heard of it, its Home
     * Assistant sensors never updated, and the switch in the dialog is
     * labelled "Alerts & recommendations". The distinction between telling a
     * person and feeding a store already lives here - isNotifier - so the flag
     * travels on the payload and is judged where the threshold gate is.
     */
    describe("a member that opted out of alerting", () => {
        const quiet = {...good, alerts: false};

        it("is quiet to the notifiers, failures included", () => {
            assert.equal(suppressesEvent("testFinished", "telegram", row({}), quiet), true);
            assert.equal(suppressesEvent("testFailed", "telegram", row({}), quiet), true,
                "a failure of an unwatched member still pages somebody");
        });

        it("still reaches every sink", () => {
            for (const name of NOT_NOTIFIERS) {
                assert.equal(suppressesEvent("testFinished", name, row({}), quiet), false,
                    `${name} lost the data of an unwatched member`);
                assert.equal(suppressesEvent("testFailed", name, row({}), quiet), false);
            }
        });

        // Absent is not opted out: an older node's payload carries no flag,
        // and the contract everywhere else reads absence as the ordinary case.
        it("is only the member that said so", () => {
            assert.equal(suppressesEvent("testFinished", "telegram", row({}), good), false);
            assert.equal(suppressesEvent("testFinished", "telegram", row({}),
                {...good, alerts: true}), false);
            assert.equal(suppressesEvent("testFinished", "telegram", row({}),
                {...good, alerts: null}), false);
        });

        // The two gates compose: a watched member's healthy result can still
        // be withheld by the thresholds.
        it("leaves the threshold gate standing for the watched members", () => {
            assert.equal(suppressesEvent("testFinished", "telegram", row(armed),
                {...good, alerts: true}), true);
        });
    });
});
