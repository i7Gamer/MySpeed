/**
 * Whether a finished speedtest fell below what this target's own line usually
 * delivers.
 *
 * The fixed thresholds an integration carries are a fact about what a notifier
 * cares about - alertThreshold.js:16-21 says why they are not inherited from
 * anything - and they have to be chosen. A baseline needs nothing chosen but a
 * percentage: the yardstick is the target's own rolling median, so a gigabit
 * LAN box and a rural DSL line are each judged against themselves.
 *
 * Deliberately pure over rows, mirroring alertThreshold.js: it reads no
 * configuration and touches no database, which is what lets the decision that
 * governs whether somebody is woken up be exercised directly - and it is why
 * the verdict has to arrive on the event payload already decided, since the
 * gate that reads it (controller/integrations.js:98) cannot query anything.
 *
 * Two judgements worth stating out loud, because neither is a bug when it is
 * met later:
 *
 * - The previous test is compared against the *current* median, not against
 *   the median as it stood when that test ran. Recomputing a historical
 *   baseline per test would double the query cost and make the verdict depend
 *   on which rows have since been purged; one yardstick for both readings is
 *   the simpler and more defensible rule.
 * - A rolling median walks with a sustained drop. As bad days enter the window
 *   they pull the median down until the line stops breaching, so a degradation
 *   that lasts self-cancels after roughly half a window. That is inherent to a
 *   rolling measure of "usual", and the alternative - a fixed yardstick - is
 *   the fixed thresholds, which already exist.
 */

import { usableFigure } from './metricValue.js';
// The one exported, null-safe median in the tree. There are two others -
// statistics.js and helpers.js each keep a module-private copy - and a fourth
// is how the three of them would stop agreeing without anything failing to
// compile. Consolidating all three into one home is a separate task; importing
// the only one that is already public is this one's share of it.
import { median } from './providers/iperfLatency.js';

/**
 * How far back the median is taken.
 *
 * Long enough that a bad week is still a minority of the sample and short
 * enough that a line upgraded two months ago is not still being judged against
 * what it used to do. Not configurable: a per-target window is a fourth number
 * in a dialog for a question nobody has asked.
 */
export const BASELINE_WINDOW_DAYS = 30;

/**
 * The fewest successful rows inside the window before a baseline exists at all.
 *
 * Below twenty the median moves with one bad afternoon: the standard error of a
 * median is about 1.25 sigma over the root of the sample, so at twenty a line
 * with ten per cent spread has its median pinned to roughly three per cent -
 * fine against percentages in the seventies - while at five it is six, and the
 * alert then fires on the estimator rather than on the line. It also stops a
 * fresh instance alerting on its own first day, and stops a target alerting on
 * the tail a retention purge (controller/speedtests.js removeOld) left behind.
 */
export const BASELINE_MIN_SAMPLES = 20;

/**
 * The narrowest and widest share of the median a target may be judged at.
 *
 * The ceiling is below a hundred because the median is exceeded by half the
 * tests by construction, so a hundred means "alert on roughly every other
 * test"; the floor is above zero because a target that only alerts when the
 * line has all but vanished is a gate that never fires. A value that floods or
 * mutes the feature is a mistake worth naming at the door, which is the same
 * reasoning controller/targets.js:201-206 refuses a zero optimal with.
 */
export const BASELINE_PERCENT_MIN = 10;
export const BASELINE_PERCENT_MAX = 95;

/**
 * The measurements a baseline is taken over.
 *
 * Latency is deliberately absent: its comparison is inverted - the habit
 * ALERT_METRICS (alertThreshold.js:51-67) warns about, where a "below" name
 * gets filled in for the one metric where bigger is worse - and a latency
 * median is noisy enough that statistics.js:117-138 replaced its standard
 * deviation with a median absolute deviation over exactly that.
 *
 * One list, read by the median, by the comparison and by the window query
 * (controller/speedtests.js listForBaseline), because a column named in one of
 * the three and not the others arrives as undefined and nothing says so.
 */
export const BASELINE_METRICS = ["download", "upload"];

const MS_PER_DAY = 86_400_000;

/** What a percentage is a share of. */
const PERCENT_WHOLE = 100;

/** The oldest row the median is taken over. */
export const baselineWindowStart = (now = new Date()) =>
    new Date(now.getTime() - BASELINE_WINDOW_DAYS * MS_PER_DAY);

/**
 * The medians of a target's own successful rows, per metric - or null when
 * neither metric has enough of them.
 *
 * Per metric, because a provider that measured one direction and not the other
 * still says something true about the direction it measured; the answer is null
 * for that column alone, and the comparison below simply has nothing to judge
 * it against.
 *
 * Read through usableFigure rather than cast. An imported history holds "42"
 * where a number belongs - sqlite stores what it is handed and returns it
 * unchanged - and that is a measurement somebody really took, while Number("")
 * is 0 and a confident zero on a speed reads as a line that delivered nothing.
 * The same trap statistics.js:52-70 documents.
 */
export const baselineOf = (rows) => {
    if (!Array.isArray(rows)) return null;

    const medians = {};
    let anyMetric = false;

    for (const metric of BASELINE_METRICS) {
        const readings = rows
            .map((row) => usableFigure(row?.[metric]))
            .filter((reading) => reading !== null);

        const enough = readings.length >= BASELINE_MIN_SAMPLES;

        medians[metric] = enough ? median(readings) : null;
        anyMetric ||= enough;
    }

    return anyMetric ? medians : null;
};

/**
 * The share of the median to judge against, or null when the stored value is
 * not one.
 *
 * The column is the whole of the switch - there is no separate toggle beside
 * it, the way optimalPing has none - so a value the door would have refused
 * means "no baseline" rather than something to act on. The only ways such a
 * value reaches a row are a hand-edited database and an import, and reading a
 * hundred-and-fifty as armed would alert on every test forever.
 *
 * Read through usableFigure for the reason baselineOf is: the column is a
 * DOUBLE, and a restored row can carry text where a number belongs.
 */
const usablePercent = (value) => {
    const percent = usableFigure(value);

    return percent !== null && percent >= BASELINE_PERCENT_MIN && percent <= BASELINE_PERCENT_MAX
        ? percent
        : null;
};

/**
 * Nothing to report: the shape of every answer that names no median and no
 * crossing.
 *
 * Spread by the warming-up branch below rather than written out a second time
 * there, since the two differ in `armed` alone. Written twice they drift the
 * first time a key is added to one of them, and what that produces is a payload
 * carrying a key on one path and not the other - a template reading as
 * unmeasured for a reason nothing on the screen explains.
 */
const quiet = () => ({armed: false, breached: false, baselineDirection: null,
    baselineShortfall: null, baselineDetail: null, baselineDownload: null, baselineUpload: null});

/**
 * Whether one metric's reading sits under its share of that metric's median.
 *
 * One metric at a time, and the caller decides what to make of the pair. Any
 * single one being enough to alert mirrors the any-armed-metric rule
 * breachesThreshold follows (alertThreshold.js:118-122): a line delivering its
 * download while its upload has collapsed is worth hearing about.
 *
 * A metric with no median, and a reading that is not a reading, are both simply
 * not judged. The fixed thresholds fail open on an unusable measurement,
 * because a gate switched on with nothing to compare must not go silent; here
 * the comparison *is* the switch, and reading an unmeasured column as "below"
 * would let one unreadable row in the history mute the transition the storm
 * rule below is built on.
 */
const metricBelow = (row, baseline, percent, metric) => {
    const yardstick = baseline?.[metric];
    if (typeof yardstick !== "number") return false;

    const reading = usableFigure(row?.[metric]);
    if (reading === null) return false;

    return reading < yardstick * percent / PERCENT_WHOLE;
};

/**
 * The metrics that have just gone under, counting each on its own.
 *
 * The transition used to be read off a single `.some()` over both metrics, so
 * it fired on "is this target in breach at all". While download sat under its
 * median, upload could collapse to a fraction of its own and nobody was told:
 * the round was already in breach, so there was no edge left to see.
 *
 * That silenced exactly the case the any-metric rule exists for, and
 * metricBelow's own comment names it - a line delivering its download while its
 * upload has collapsed is worth hearing about. A second metric going down is a
 * new thing happening to the line, not a continuation of the first.
 *
 * The list rather than a bare yes, because what the message says is read off
 * the same edge the decision is. A metric already under its median announced
 * itself on the round it crossed, and naming it again would report two
 * directions collapsing where one did.
 *
 * The storm rule is untouched where it matters: a metric that stays under its
 * median is not newly under it, so it announces itself once however many rounds
 * it lasts. Recovery stays silent on both, which is consistent - nothing in
 * this codebase sends a "back to normal".
 */
const newlyBelow = (row, previous, baseline, percent) => BASELINE_METRICS.filter((metric) =>
    metricBelow(row, baseline, percent, metric)
        && !metricBelow(previous, baseline, percent, metric));

/**
 * What separates the metric names when one round puts both under.
 *
 * Joined here rather than carried as an array, because every key of the verdict
 * becomes a %variable% a message template may name, and an array substitutes
 * into a message as "download,upload" - the same reason notificationPayload.js
 * says its keys are flat on purpose.
 */
const METRIC_SEPARATOR = ", ";

/**
 * How far under its own median a reading landed, as a whole percentage of that
 * median.
 *
 * The share below rather than the share of: "40 per cent below what this line
 * usually does" is the sentence somebody reads at breakfast, where "60 per cent
 * of the usual" is the same fact left as the arithmetic. The share the operator
 * set is not in it at all - that is a setting, and it is on the screen they set
 * it from.
 *
 * Whole, because the figure goes into a sentence rather than into further
 * arithmetic, and thirty-point-oh-two per cent under is a number nobody says.
 *
 * Asked only of a metric newlyBelow has already returned, which is what makes
 * the division safe without a guard of its own: that metric's reading came in
 * under `yardstick * share`, and usableFigure lets no negative reading through,
 * so the yardstick it was compared against is above zero.
 */
const shortfallOf = (row, baseline, metric) => {
    const yardstick = baseline[metric];

    return Math.round((yardstick - usableFigure(row?.[metric])) / yardstick * PERCENT_WHOLE);
};

/**
 * What to tell the integrations about this test's own line.
 *
 * Edge-triggered: a breach is announced when the *previous* test of the same
 * target did not breach, and while the line stays under its baseline the round
 * is quiet. Without that, a bad afternoon on the default hourly schedule is a
 * message an hour - the notification fatigue alertThreshold.js:4-8 says four
 * upstream issues are about, arrived at from the other direction.
 *
 * The transition is read from the stored rows rather than remembered in a
 * module variable, which is the rule tasks/integrations.js:128-137 argues for
 * in the sibling case: a restart between two bad tests would forget a
 * remembered flag, and a restart is exactly when somebody is looking. The
 * previous row is already inside the window the median was taken over, so it
 * costs no extra query.
 *
 * The cost is that recovery is silent - there is no "back to normal" event.
 * That is consistent: nothing in this codebase sends one.
 *
 * @param row       the test just measured, as {download, upload}
 * @param previous  the newest stored row of this target, or undefined for a
 *                  target measuring for the first time
 * @param baseline  baselineOf(window), or null
 * @param percent   the target's baselinePercent
 */
export const baselineVerdict = (row, previous, baseline, percent) => {
    const share = usablePercent(percent);

    // Nobody asked for this alert - no share stored, or one nothing can read,
    // which baselineOrNull already treats as no baseline at all. The ordinary
    // case on every instance and every target.
    if (share === null) return quiet();

    /*
     * Asked for, but the window does not hold enough successful rows to take a
     * median over yet - see BASELINE_MIN_SAMPLES.
     *
     * ARMED all the same, and that distinction is the whole of this branch.
     * `armed` answers "did the operator ask for this alert", and it is what
     * keeps breachesThreshold off its `return !armed` tail - the branch that
     * fires when a gate is switched on with no usable limit anywhere, so that
     * a half-finished setup is a nuisance rather than an integration which has
     * silently stopped working.
     *
     * Reported as unarmed, a warming-up target put the exact setup that block
     * names in its own comment - baseline on, the three fixed limits blank -
     * into the storm it says it prevents: every healthy test notified, once
     * per test, until the twentieth successful row landed. Twenty spurious
     * messages on the hourly default, and on a target run by hand it does not
     * end, because twenty successes inside thirty days may never arrive.
     *
     * It cannot breach, having nothing to compare against, and names no median
     * rather than a zero a message template would print as this line's usual
     * speed.
     */
    if (baseline === null || baseline === undefined) return {...quiet(), armed: true};

    const below = newlyBelow(row, previous, baseline, share);

    return {
        armed: true,
        // Per metric, so a second one collapsing while the first is still down
        // is announced rather than swallowed by the breach already in progress
        // - see newlyBelow.
        breached: below.length > 0,
        /*
         * And what the message is allowed to say about it, since a template has
         * neither arithmetic nor a conditional and can only say what this
         * decided. Without the pair, download collapsing and upload collapsing
         * an hour later arrived as two alerts that read identically.
         *
         * Null rather than an empty string or a zero on a round that crossed
         * nothing: replaceVariables prints a null as its not-measured mark, so
         * a template naming these on every finished test reads as having
         * nothing to report - where "0% under" reads as a line sitting exactly
         * on its median, which is a different statement and an untrue one.
         *
         * Named for the direction rather than for "below", which is the word
         * this module uses everywhere else. The key is operator-facing: on the
         * dialog's chip row it stands next to %baselineDownload% and
         * %baselineUpload%, which are both speeds, and a %baselineBelow% read
         * there is the speed the alert fires under rather than the name of a
         * metric - a template would say "dropped below download Mbit/s" and
         * nothing would refuse it. Not "crossed" either, which is what
         * %baselineBreached% beside it already means, and that one is a
         * boolean.
         *
         * One shortfall, the deepest, and the pair is meant to be read together
         * as "down by at least this much" - the figure worth being woken for.
         * Two numbers positionally matched to two names is a shape a sentence
         * cannot hold.
         */
        baselineDirection: below.length > 0 ? below.join(METRIC_SEPARATOR) : null,
        baselineShortfall: below.length > 0
            ? Math.max(...below.map((metric) => shortfallOf(row, baseline, metric)))
            : null,
        /*
         * And the crossing as one ready-made phrase, each direction carrying
         * its own number - the sentence the deepest-only pair above cannot
         * say when both cross in one round. The message summary is composed
         * from this (alertThreshold.js alertSummary), and a template may name
         * it directly.
         */
        baselineDetail: below.length > 0
            ? `${below.map((metric) => `${metric} ${shortfallOf(row, baseline, metric)}%`)
                .join(" and ")} under`
            : null,
        // The medians themselves rather than the lines they imply, so a message
        // template can say what this target usually delivers beside what it
        // just did. The percentage is the operator's own setting and is on the
        // screen they set it from.
        baselineDownload: baseline.download ?? null,
        baselineUpload: baseline.upload ?? null
    };
};

/**
 * What is wrong with a target's baseline percentage, or null when nothing is.
 *
 * Null and absent both mean the baseline is off, the spelling the three optimal
 * columns already use - so a target that names none is the ordinary case and
 * has nothing to answer for. That is every target on every instance that
 * upgrades into this column.
 *
 * Refused rather than coerced, for the reason flagProblem states verbatim: for
 * a value arriving over the API, reading "seventy" as something is a worse
 * surprise than a 400 naming the field. A fraction is allowed - the column is a
 * DOUBLE and 72.5 per cent is an ordinary thing to want.
 *
 * Exported and pure over one value, because the API route and the import path
 * both have to make the same call and a test should be able to ask it without a
 * database.
 */
export const baselinePercentProblem = (value) => {
    if (value === undefined || value === null) return null;

    if (typeof value !== "number" || !Number.isFinite(value)
        || value < BASELINE_PERCENT_MIN || value > BASELINE_PERCENT_MAX)
        return `The baseline percentage must be a number between ${BASELINE_PERCENT_MIN} `
            + `and ${BASELINE_PERCENT_MAX}, or unset`;

    return null;
};
