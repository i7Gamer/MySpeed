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
 *
 * A target's own baseline is the third answer to that same question, and the
 * one that needs nothing chosen but a percentage: the yardstick is the rolling
 * median of the target's own successful runs, so each line is judged against
 * itself. It is decided in util/baselineAlert.js, where the rows are, and
 * reaches this function on the payload already judged - the same trick `alerts`
 * and `primary` use, and the only one available to a gate that touches no
 * database.
 */

import { FAILED_TEST, UNMEASURED_LATENCY } from './testOutcome.js';

/** The switch that turns the whole gate on, off by default and for every existing row. */
export const ALERT_ONLY = "alert_only";

/**
 * The two payload keys a target's own baseline verdict is decided on.
 *
 * The verdict carries four more - the two medians, and which direction crossed
 * by how far - but those are for a message to print rather than for this gate
 * to read, and notificationPayload.js names them where it lists them.
 *
 * Named here rather than at the module that computes them, because this is the
 * only place they are read as a decision - and notificationPayload.js takes the
 * names from here rather than spelling them again, so a key advertised to a
 * message template cannot drift from the key this gate looks for.
 *
 * Both are null on a target that set no baseline, and absent from any payload a
 * node older than the feature produced. Either reads as "no baseline", which is
 * how every existing instance keeps behaving exactly as it did.
 */
export const BASELINE_ARMED = "baselineArmed";
export const BASELINE_BREACHED = "baselineBreached";

/**
 * The payload key crossedLimits travels on.
 *
 * Named beside the function that builds it and read by both the dispatcher that
 * fills it in and the variable list that offers it, for the reason the two
 * above are taken from here rather than spelled again: two literals are how a
 * chip the dialog offers stops being a name that substitutes, leaving a literal
 * "%alertCrossed%" in a message somebody is reading at three in the morning.
 *
 * Unlike those two it is not on the payload finishedPayload builds. The limits
 * belong to the integration, not to the test, so it is filled in per recipient
 * at dispatch - see controller/integrations.js.
 */
export const ALERT_CROSSED = "alertCrossed";

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

/*
 * The latency of a run that measured nothing is imported above rather than
 * declared here.
 *
 * This gate read the fabricated zero correctly from the start while the
 * statistics averaged it as a 0 ms reading, so one instance answered the same
 * row two ways - the notification refusing what the page had already
 * published. The rule now has one home, and UNMEASURED_LATENCY explains itself
 * there.
 */

/**
 * The unit the interface prints speeds in, so a message describing a crossing
 * says what the screen says.
 *
 * Every locale's own message placeholder writes it this way, and so do the six
 * templates that ship - "%download% Mbps". A clause reading "Mbit/s" next to
 * one of them would look like a second, different measurement.
 */
const SPEED_UNIT = "Mbps";

/** And what a latency is measured in. */
const LATENCY_UNIT = "ms";

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
 *
 * The unit and the word a crossing is described with sit here, beside the
 * comparison that decides it, rather than in the sentence-building below. They
 * are the same fact stated twice - a `breaches` of `>` and a clause reading
 * "under" is precisely the inversion this list exists to keep straight, and
 * apart they could be edited apart.
 */
export const ALERT_METRICS = [
    {
        key: "ping", field: "alert_ping_above",
        unit: LATENCY_UNIT, crossing: "over",
        breaches: (value, limit) => value > limit,
        measured: (value) => value !== UNMEASURED_LATENCY
    },
    {key: "download", field: "alert_download_below",
        unit: SPEED_UNIT, crossing: "under",
        breaches: (value, limit) => value < limit},
    {key: "upload", field: "alert_upload_below",
        unit: SPEED_UNIT, crossing: "under",
        breaches: (value, limit) => value < limit}
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

/** What separates the clauses when one result crossed more than one limit. */
const CLAUSE_SEPARATOR = ", ";

/** How a metric reads when it is armed and there was nothing to compare. */
const NOT_MEASURED = "(not measured)";

/**
 * One crossing, as the clause a message names it with: "ping 62 ms over 50".
 *
 * A whole clause rather than a name in one key and a number in another, because
 * these three metrics are neither in one unit nor crossed in one direction. A
 * bare 12 beside "ping, download" cannot say whether it means milliseconds over
 * or megabits under, and one number cannot serve two metrics that crossed in
 * the same round.
 *
 * The reading is printed as it stands, which is the figure %ping% and %download%
 * already print, so a template naming both does not show one number twice in
 * two roundings.
 */
const crossingClause = (metric, value, limit) =>
    `${metric.key} ${value} ${metric.unit} ${metric.crossing} ${limit}`;

/**
 * Every armed metric this result did not satisfy, as the clauses that name
 * them - and whether anything was armed at all.
 *
 * One walk over the list, read by the gate below and by the description beside
 * it. Two walks with the same limit and reading rules are two places for "is
 * this worth sending" and "what does it say" to stop agreeing, which is a
 * message that arrives naming nothing or names something it did not arrive for.
 *
 * It collects rather than returning at the first find, because the message wants
 * all of them: a result that missed its download and its upload said one of the
 * two when the gate stopped at the first.
 */
const findings = (payload, data) => {
    const crossed = [];
    let armed = false;

    for (const metric of ALERT_METRICS) {
        const limit = limitOf(data?.[metric.field]);
        if (limit === null) continue;

        armed = true;

        const value = measurementOf(payload?.[metric.key], metric);

        // Named, not skipped. This metric really is why the message arrives -
        // see the fail-open case breachesThreshold documents - and a latency of
        // zero judged as "above" is the exact reading that used to pass for an
        // excellent line.
        if (value === null) {
            crossed.push(`${metric.key} ${NOT_MEASURED}`);
            continue;
        }

        if (metric.breaches(value, limit)) crossed.push(crossingClause(metric, value, limit));
    }

    return {armed, crossed};
};

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
    /*
     * The target's own baseline, judged in util/baselineAlert.js before the row
     * was written and carried here already decided - the rows its median is
     * taken over are the one thing this function would need a database for.
     *
     * It arms the gate as well as breaching it, and that is the whole of why
     * this block is not an `||` at the end. An operator who wants baseline
     * alerts *only* switches the gate on and leaves the three limits blank,
     * which without this line is the "armed with no usable limit" shape the
     * `return !armed` below deliberately fires on - so the setup that asks for
     * the fewest notifications would have produced one per test, hourly,
     * forever.
     *
     * Strictly true on both, the way the alerts flag and the switch above are
     * read: the payload is JSON a node may have written, and a string "false"
     * must not silence a gate with nothing else armed.
     */
    const baselineArmed = payload?.[BASELINE_ARMED] === true;

    if (baselineArmed && payload[BASELINE_BREACHED] === true) return true;

    // Every finding is one of the two answers above - a limit missed, or an
    // armed metric with nothing to compare - so any of them is this gate's yes.
    const {armed, crossed} = findings(payload, data);

    return crossed.length > 0 || !(baselineArmed || armed);
};

/**
 * What the gate's yes was about, in the words a message can carry - or null
 * when this integration's own limits have nothing to say.
 *
 * breachesThreshold answers yes or no, so an integration watching ping and
 * download sent a message that could not say which of them it was about. That
 * is the gap %baselineDirection% closes for a target's own baseline, and this
 * closes for the three limits an integration types in.
 *
 * Null for the second of the fail-open cases: a gate armed with no usable limit
 * anywhere crossed nothing, and the message it produces is about a half
 * finished setup rather than about the line. Naming a metric there would invent
 * a crossing to explain a message that has another explanation entirely.
 *
 * Null about the baseline too, which carries its own pair. The two are not one
 * fact: a baseline belongs to the target and is judged once, before the row is
 * written, where these limits belong to this integration and are judged again
 * for every recipient - which is exactly why this cannot ride the payload the
 * way the baseline's does.
 */
export const crossedLimits = (payload, data) => {
    const {crossed} = findings(payload, data);

    return crossed.length > 0 ? crossed.join(CLAUSE_SEPARATOR) : null;
};

/**
 * The payload key the whole alert travels on as one ready-made passage, and
 * the labels its lines open with.
 */
export const ALERT_SUMMARY = "alertSummary";

const SUMMARY_BASELINE_LABEL = "Below its usual speed: ";
const SUMMARY_LIMITS_LABEL = "Crossed limits: ";

/**
 * Everything the alert has to say, as a passage a default template can carry -
 * or the empty string, which is the whole trick.
 *
 * Every other key renders a null as the not-measured mark, so naming any of
 * them in a shipped template stamped "N/A" on every healthy message - which is
 * why, until this, no default could say why an alert arrived. This one
 * substitutes to nothing at all, leading newlines included: a healthy message
 * reads byte-for-byte as it always did, and a breach explains itself without
 * anyone editing a template. Each line carries its own "\n", so the token sits
 * flush against a default's last line with no blank tail.
 *
 * The target's own line first, then this integration's limits: the baseline is
 * a fact about the test and reads the same to every recipient, where the
 * limits are the recipient's own - the same split that puts this key on the
 * dispatcher rather than on the payload.
 *
 * The baseline line hangs on the phrase, not the flag alone: a payload from an
 * older node can say breached without carrying baselineDetail, and a label
 * introducing nothing is not a line worth sending.
 *
 * English composed in the server, like the six defaults it rides in; the
 * localisation pass (the language config key) takes both together.
 */
export const alertSummary = (payload, data) => {
    const lines = [];

    if (payload?.[BASELINE_BREACHED] === true
        && typeof payload.baselineDetail === "string" && payload.baselineDetail !== "")
        lines.push(SUMMARY_BASELINE_LABEL + payload.baselineDetail);

    // A second three-entry walk over ALERT_METRICS beside the dispatcher's
    // crossedLimits call - shared, the two calls would trade this line for a
    // threaded argument at every site; the walk is three comparisons.
    const crossed = crossedLimits(payload, data);
    if (crossed !== null) lines.push(SUMMARY_LIMITS_LABEL + crossed);

    return lines.map((line) => `\n${line}`).join("");
};
