/**
 * Whether a finished speedtest is worth telling anyone about.
 *
 * Integrations fired on every completed test, which on the default hourly
 * schedule is a message an hour saying the line is fine. Four upstream issues
 * ask for the same thing in different words - #776, #931, #903, #1385 - and one
 * of them reports having gone back to another tool over it: notifications that
 * always arrive stop being read, so the one that matters is missed too.
 *
 * Deliberately a pure function over the event payload and the integration's own
 * stored settings. It reads no configuration and touches no database, which is
 * what lets the decision governing whether a user is notified be tested
 * directly - and what keeps controller/integrations.js from having to import
 * the config controller, which already imports it back.
 *
 * The thresholds live on the integration rather than being inherited from the
 * configured optimal values. Those are seeded at install with defaults nobody
 * chose, so "the user never set a target" is indistinguishable from "the user
 * picked 100 Mbit" - and inheriting them would silently re-arm every
 * integration whenever someone edited an unrelated screen.
 */

import { FAILED_TEST } from './testOutcome.js';

/** The switch that turns the whole gate on, off by default and for every existing row. */
export const ALERT_ONLY = "alert_only";

/**
 * The placeholder a failed test stores in every numeric column. It is not a
 * measurement, and on a metric the user is watching it is the strongest
 * possible evidence that something is wrong.
 *
 * Taken from the module that owns the judgement rather than declared again:
 * this gate's correctness is precisely that it recognises what tasks/speedtest
 * writes, and a second copy is a way for the two to stop agreeing without
 * anything failing to compile.
 */
const FAILED = FAILED_TEST;

/**
 * The latency of a run that measured nothing.
 *
 * Not because fast lines do not exist - on fibre or a LAN the whole reading
 * lives below the millisecond, which is exactly why the parsers keep two
 * decimals - but because those decimals are kept: a genuine 0.24 arrives here
 * as 0.24. Only a fabricated value stores as exactly zero, and parseCloudflare
 * produces one on its success path: its no-usable-figures fallback answers
 * `{ping: 0, download: 0, upload: 0}`, and `round(avg_latency_ms) ?? 0` yields
 * the same whenever the latency block carries no average. The comparison
 * below must stay exact for the same reason - widened to "under a
 * millisecond", it would swallow every real fibre reading with it.
 */
const UNMEASURED_LATENCY = 0;

/**
 * The metrics that can raise an alert, each named for the comparison it
 * performs.
 *
 * Latency is the one measurement where a larger number is worse, and it is the
 * one an author reaches for a "minimum" name on out of habit: upstream #1385
 * asks to be told "if ping drops below threshold" while plainly meaning the
 * opposite. A field called `min_ping` would have been filled in accordingly and
 * fired on every good result.
 *
 * That inverted comparison is also why only latency declares which readings are
 * real. A zero speed is a genuine and alarming reading - the line delivered
 * nothing, and `0 < limit` breaches every limit there is - so on the speeds a
 * `measured` hook has nothing to decide: read as a reading the zero breaches by
 * arithmetic, read as unusable it breaches through the fail-open case in
 * breachesThreshold. Only on latency do the two roads part, because a zero
 * compared with `>` is the one value that can never breach anything.
 */
export const ALERT_METRICS = [
    {
        key: "ping", field: "alert_ping_above",
        breaches: (value, limit) => value > limit,
        measured: (value) => value !== UNMEASURED_LATENCY
    },
    {key: "download", field: "alert_download_below", breaches: (value, limit) => value < limit},
    {key: "upload", field: "alert_upload_below", breaches: (value, limit) => value < limit}
];

/**
 * A limit that can be compared against, or null.
 *
 * Zero is the one that matters: it is storable, it really does exist in the
 * installed base - the welcome wizard once wrote zeroes over the shipped
 * targets - and `download < 0` is never true. Read as a limit it would mute the
 * integration for good while the interface showed the gate as armed.
 */
const limitOf = (raw) => {
    if (raw === null || raw === undefined || raw === "") return null;

    const limit = Number(raw);

    return Number.isFinite(limit) && limit > 0 ? limit : null;
};

/**
 * A measurement that can be compared, or null.
 *
 * These arrive on the success path, not only from failures: parseCloudflare
 * answers zeroes when the CLI printed nothing usable, parseLibre stores null
 * for a latency its backend did not report, and roundSpeed produces NaN from an
 * absent bandwidth. Compared bare, every one of them reads as a healthy line -
 * `NaN > 50` and `null > 50` are both false.
 *
 * Which finite numbers count as readings is the metric's own business, so the
 * cloudflare zero is judged per metric rather than here: on a speed it is the
 * line delivering nothing and must keep breaching, on latency it is a figure no
 * connection produces.
 */
const measurementOf = (raw, metric) => {
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw === FAILED) return null;

    return metric.measured && !metric.measured(raw) ? null : raw;
};

/** Whether this integration asked to hear only about results that miss a limit. */
export const wantsOnlyBreaches = (data) => data?.[ALERT_ONLY] === true;

/**
 * Whether the result misses at least one of the limits the integration set.
 *
 * Any single armed metric is enough: a line delivering its download while its
 * upload has collapsed is worth hearing about. A metric left blank is one the
 * user did not ask about and cannot fire on its own.
 *
 * Two cases deliberately answer true rather than false:
 *
 * - An armed metric whose measurement is unusable. The line could not be
 *   measured, which is not evidence that it is well.
 * - The gate switched on with no usable limit anywhere. Reading that as
 *   "nothing ever breaches" turns a half-finished setup into an integration
 *   that never fires again, which from outside is indistinguishable from the
 *   software being broken. Too many notifications is a nuisance; none at all is
 *   a fault nobody can see.
 */
export const breachesThreshold = (payload, data) => {
    let armed = false;

    for (const metric of ALERT_METRICS) {
        const limit = limitOf(data?.[metric.field]);
        if (limit === null) continue;

        armed = true;

        const value = measurementOf(payload?.[metric.key], metric);
        if (value === null) return true;

        if (metric.breaches(value, limit)) return true;
    }

    return !armed;
};
