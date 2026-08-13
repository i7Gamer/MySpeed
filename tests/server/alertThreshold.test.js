import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    ALERT_ONLY, ALERT_METRICS, breachesThreshold, wantsOnlyBreaches
} from "../../server/util/alertThreshold.js";

/**
 * Whether a finished speedtest is worth telling anyone about.
 *
 * Four upstream issues ask for the same thing in different words - #776, #931,
 * #903 and #1385: a notification on every test, on a schedule that runs hourly
 * by default, stops being read. What people want is to hear from MySpeed when
 * the line is bad.
 *
 * Kept as a pure function with no database and no configuration behind it, so
 * the decision that governs whether a user is notified can be exercised
 * directly rather than through the event dispatcher's fan-out over stored rows.
 */
const result = (overrides = {}) => ({ping: 12, jitter: 2, download: 500, upload: 200, time: 14, ...overrides});

describe("wantsOnlyBreaches", () => {
    // Every row stored before this feature existed lacks the key, and those
    // users have not asked for anything to change.
    it("is off when the integration has never been configured for it", () => {
        assert.equal(wantsOnlyBreaches(undefined), false);
        assert.equal(wantsOnlyBreaches({}), false);
        assert.equal(wantsOnlyBreaches({[ALERT_ONLY]: false}), false);
    });

    // Strictly true, not merely truthy: the stored column is JSON, and a value
    // that arrived as the string "false" must not read as consent.
    it("is on only for an explicit true", () => {
        assert.equal(wantsOnlyBreaches({[ALERT_ONLY]: true}), true);
        assert.equal(wantsOnlyBreaches({[ALERT_ONLY]: "true"}), false);
        assert.equal(wantsOnlyBreaches({[ALERT_ONLY]: 1}), false);
    });
});

describe("breachesThreshold", () => {
    describe("the direction each metric is judged in", () => {
        // Latency is the one measurement where a bigger number is worse, and it
        // is the one an author reaches for a "minimum" name on out of habit -
        // upstream #1385 literally asks to be told "if ping drops below
        // threshold" while plainly meaning the opposite. The field is named for
        // the comparison it performs.
        it("breaches when the latency rises above its limit", () => {
            assert.equal(breachesThreshold(result({ping: 80}), {alert_ping_above: 50}), true);
            assert.equal(breachesThreshold(result({ping: 20}), {alert_ping_above: 50}), false);
        });

        it("breaches when a speed falls below its limit", () => {
            assert.equal(breachesThreshold(result({download: 40}), {alert_download_below: 100}), true);
            assert.equal(breachesThreshold(result({download: 400}), {alert_download_below: 100}), false);

            assert.equal(breachesThreshold(result({upload: 5}), {alert_upload_below: 20}), true);
            assert.equal(breachesThreshold(result({upload: 50}), {alert_upload_below: 20}), false);
        });

        // Exactly at the limit is the limit being met, not missed.
        it("treats a value exactly on its limit as met", () => {
            assert.equal(breachesThreshold(result({ping: 50}), {alert_ping_above: 50}), false);
            assert.equal(breachesThreshold(result({download: 100}), {alert_download_below: 100}), false);
        });
    });

    describe("combining several metrics", () => {
        const limits = {alert_ping_above: 50, alert_download_below: 100, alert_upload_below: 20};

        // Any one of them is enough. A line that delivers its download but has
        // collapsed upstream is a line worth hearing about.
        it("breaches when any single armed metric misses", () => {
            assert.equal(breachesThreshold(result({upload: 3}), limits), true);
            assert.equal(breachesThreshold(result({ping: 900}), limits), true);
            assert.equal(breachesThreshold(result(), limits), false);
        });

        // A metric left blank is a metric the user did not ask to be told
        // about, and it cannot fire on its own.
        it("ignores a metric with no limit set", () => {
            // A collapsed download says nothing when only the latency is armed.
            assert.equal(breachesThreshold(result({download: 1}), {alert_ping_above: 50}), false);
            assert.equal(breachesThreshold(result({ping: 900}), {alert_download_below: 100}), false);

            // ...and the armed metric still decides on its own.
            assert.equal(breachesThreshold(result({ping: 900, download: 40}), {alert_download_below: 100}), true);
        });
    });

    /**
     * A limit that cannot be compared against arms nothing.
     *
     * Zero matters most: it is storable today and really does exist in the
     * installed base - the welcome wizard once wrote zeroes over the shipped
     * targets - and `download < 0` is never true, so a zero read as a limit
     * would mute the integration permanently with the toggle showing as armed.
     */
    describe("a limit that says nothing", () => {
        for (const [name, value] of Object.entries({
            zero: 0, negative: -5, blank: "", null: null, undefined: undefined,
            text: "fast", NaN: NaN, Infinity: Infinity
        })) {
            it(`arms nothing for a limit of ${name}`, () => {
                assert.equal(breachesThreshold(result({download: 1, upload: 1, ping: 999}),
                    {alert_download_below: value}), true,
                    "an unusable limit should leave the integration notifying as before");
            });
        }

        // The number arrives from a JSON column, so it can be the string form.
        it("reads a numeric string as the number it spells", () => {
            assert.equal(breachesThreshold(result({download: 40}), {alert_download_below: "100"}), true);
            assert.equal(breachesThreshold(result({download: 400}), {alert_download_below: "100"}), false);
        });

        it("compares a fractional limit rather than rounding it away", () => {
            assert.equal(breachesThreshold(result({download: 12.4}), {alert_download_below: 12.5}), true);
            assert.equal(breachesThreshold(result({download: 12.6}), {alert_download_below: 12.5}), false);
        });
    });

    /**
     * Nothing configured means nothing is suppressed.
     *
     * The alternative - reading "no limits" as "nothing ever breaches" - turns
     * a half-finished setup into an integration that silently never fires
     * again, which is indistinguishable from the software being broken. It
     * fails open on purpose: too many notifications is a nuisance, none at all
     * is a fault nobody can see.
     */
    it("fails open when the gate is on but no limit is set", () => {
        assert.equal(breachesThreshold(result(), {}), true);
        assert.equal(breachesThreshold(result(), {alert_ping_above: 0, alert_download_below: ""}), true);
        assert.equal(breachesThreshold(result(), undefined), true);
    });

    /**
     * A measurement that is not a measurement.
     *
     * These reach the success path, not just the failure one: parseCloudflare
     * answers `{ping: 0, download: 0, upload: 0}` when the CLI printed no
     * usable figures, parseLibre stores null for a latency it could not read,
     * and -1 is the placeholder a failed row carries in every numeric column.
     * A bare comparison reports every one of them as a healthy line - `NaN >
     * 50` and `null > 50` are both false - which silences the notification
     * exactly when the connection is at its worst.
     */
    describe("a measurement that cannot be compared", () => {
        for (const [name, value] of Object.entries({
            null: null, undefined: undefined, NaN: NaN, "the failure placeholder": -1, text: "N/A"
        })) {
            it(`counts ${name} against an armed metric as a breach`, () => {
                assert.equal(breachesThreshold(result({download: value}), {alert_download_below: 100}), true);
            });
        }

        // On a speed, zero is a real reading - the line delivered nothing -
        // and it is below every positive limit, so it breaches on the
        // comparison itself. Reading it as unusable would breach too, through
        // the fail-open case above, so a dead line is announced either way;
        // what this pins is that the speeds never needed a `measured` hook for
        // the zero, which is why only latency carries one.
        it("counts a measured zero as the breach it is", () => {
            assert.equal(breachesThreshold(result({download: 0}), {alert_download_below: 100}), true);
            assert.equal(breachesThreshold(result({upload: 0}), {alert_upload_below: 20}), true);
        });

        /**
         * Latency is the one metric where zero is not a reading.
         *
         * It is judged the other way round - `0 > 50` is false - so the zero
         * parseCloudflare fabricates when the CLI printed no usable figures
         * reads as the best line anyone ever had, and the integration stays
         * silent on precisely the run that could not be measured. The same
         * unusable result expressed as null, NaN or -1 fires by design.
         */
        it("counts a latency of zero as the non-measurement it is", () => {
            assert.equal(breachesThreshold(result({ping: 0}), {alert_ping_above: 50}), true);
        });

        // The boundary is exact zero, nothing wider. A fibre or LAN ping
        // really does live below the millisecond - the parsers keep two
        // decimals precisely so it can - and a gate that read "under a
        // millisecond" as "not a reading" would fail open into a breach on
        // every healthy test such a line runs.
        it("keeps a sub-millisecond ping as the reading it is", () => {
            assert.equal(breachesThreshold(result({ping: 0.24}), {alert_ping_above: 50}), false);
        });

        // The whole payload parseCloudflare answers on its success path when
        // the CLI printed nothing usable.
        it("counts a run that measured nothing as a breach of an armed latency", () => {
            assert.equal(breachesThreshold({ping: 0, jitter: null, download: 0, upload: 0, time: 0},
                {alert_ping_above: 50}), true);
        });

        // Still only where the user asked to be told: an unmeasured latency is
        // not evidence about the speeds.
        it("ignores a latency of zero on a metric with no limit", () => {
            assert.equal(breachesThreshold(result({ping: 0, download: 400}), {alert_download_below: 100}), false);
        });

        // Only where the user asked to be told. An unmeasured metric with no
        // limit is not evidence about the metrics that do have one.
        it("ignores an unusable measurement on a metric with no limit", () => {
            assert.equal(breachesThreshold(result({upload: null}), {alert_download_below: 100}), false);
        });
    });
});

describe("ALERT_METRICS", () => {
    it("names a payload key and a field for each metric it judges", () => {
        assert.deepEqual(ALERT_METRICS.map((metric) => metric.key), ["ping", "download", "upload"]);

        for (const metric of ALERT_METRICS) {
            assert.match(metric.field, /^alert_/);
            assert.equal(typeof metric.breaches, "function");
        }
    });

    // The field names are what the interface labels and what validateInput
    // whitelists, so a rename that missed one would silently drop the value.
    it("names the fields for the comparison each performs", () => {
        const fields = Object.fromEntries(ALERT_METRICS.map((metric) => [metric.key, metric.field]));

        assert.equal(fields.ping, "alert_ping_above");
        assert.equal(fields.download, "alert_download_below");
        assert.equal(fields.upload, "alert_upload_below");
    });
});
