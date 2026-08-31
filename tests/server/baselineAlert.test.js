import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    BASELINE_METRICS, BASELINE_MIN_SAMPLES, BASELINE_PERCENT_MAX, BASELINE_PERCENT_MIN,
    BASELINE_WINDOW_DAYS, baselineOf, baselinePercentProblem, baselineVerdict, baselineWindowStart
} from "../../server/util/baselineAlert.js";

/**
 * Whether a test fell below what this target's own line usually delivers.
 *
 * The whole judgement is a pure function over rows, for the reason
 * alertThreshold's is: the gate that decides whether a person is woken up
 * should be exercisable directly, and everything it needs - the window, the
 * previous test and the reading just taken - is already in hand by the time
 * executeTarget asks.
 */

// A window of identical rows, which is the population every case below varies
// from. Named rather than inlined per test: what matters in each is the one
// thing it changes.
const rows = (count, {download = 500, upload = 200} = {}) =>
    Array.from({length: count}, () => ({download, upload}));

// A window whose readings ascend 1..count, so the median is a value the test
// can name rather than the constant every row carries.
const ascending = (count) =>
    Array.from({length: count}, (unused, index) => ({download: index + 1, upload: index + 1}));

const FULL = BASELINE_MIN_SAMPLES;

describe("baselineOf", () => {
    /**
     * The floor exists so a fresh instance does not alert on its own first day,
     * and so a target does not alert on the handful of rows a retention purge
     * left behind. The standard error of a median is about 1.25 sigma over the
     * root of the sample: at twenty rows a line with ten per cent spread has
     * its median pinned to roughly three per cent, which is fine against
     * percentages in the seventies; at five it is six, and the alert then fires
     * on the estimator rather than on the line.
     */
    it("answers a median once the window holds enough rows", () => {
        assert.deepEqual(baselineOf(rows(FULL)), {download: 500, upload: 200});
    });

    it("answers nothing one row short of enough", () => {
        assert.equal(baselineOf(rows(FULL - 1)), null);
    });

    it("answers nothing for an empty window, and for no window at all", () => {
        assert.equal(baselineOf([]), null);
        assert.equal(baselineOf(undefined), null);
    });

    // The middle of an even sample is the mean of the two either side of it -
    // the rule median() already applies, pinned here because the floor is even.
    it("takes the mean of the two middle readings on an even sample", () => {
        const sample = ascending(FULL);

        assert.equal(sample.length % 2, 0, "the sample size is no longer even");
        assert.deepEqual(baselineOf(sample), {download: 10.5, upload: 10.5});
    });

    it("is not fooled by the order the rows arrive in", () => {
        assert.deepEqual(baselineOf([...ascending(FULL)].reverse()), {download: 10.5, upload: 10.5});
    });

    /**
     * An imported history holds "42" where a number belongs - sqlite stores
     * what it is handed and returns it unchanged - and those are measurements
     * somebody really took. Read through usableFigure rather than cast, because
     * Number("") is 0 and a confident zero on a speed is a line that delivered
     * nothing.
     */
    it("reads a reading stored as text", () => {
        assert.deepEqual(baselineOf(rows(FULL).map(() => ({download: "500", upload: "200"}))),
            {download: 500, upload: 200});
    });

    it("counts nothing it cannot read as a reading", () => {
        for (const junk of [null, undefined, "", "fast", NaN, -1, {}])
            assert.equal(baselineOf(rows(FULL).map(() => ({download: junk, upload: junk}))), null,
                `${String(junk)} was counted as a measurement`);
    });

    // A measured zero is a fact about the line, not an absence, and is counted
    // the way every other reader of these columns counts it.
    it("counts a measured zero", () => {
        assert.deepEqual(baselineOf(rows(FULL, {download: 0, upload: 0})), {download: 0, upload: 0});
    });

    /**
     * Per column, because a provider that measured one direction and not the
     * other still says something true about the direction it measured. The
     * answer is null for that column alone rather than for the whole target.
     */
    it("answers per column when only one of them is readable", () => {
        const sample = rows(FULL).map(() => ({download: 500, upload: null}));

        assert.deepEqual(baselineOf(sample), {download: 500, upload: null});
    });

    it("still answers nothing when neither column is readable", () => {
        assert.equal(baselineOf(rows(FULL).map(() => ({download: null, upload: null}))), null);
    });
});

describe("baselineVerdict", () => {
    const PERCENT = 70;

    // 70% of a 500 Mbit median is 350, so these sit either side of the line
    // without landing on it - the boundary has a case of its own below.
    const above = {download: 500, upload: 200};
    const below = {download: 300, upload: 200};

    const baseline = baselineOf(rows(FULL));

    const verdict = (row, previous) => baselineVerdict(row, previous, baseline, PERCENT);

    it("is armed once a baseline and a usable percentage are both in hand", () => {
        assert.equal(verdict(above, above).armed, true);
    });

    it("carries the yardstick it judged against", () => {
        const {baselineDownload, baselineUpload} = verdict(above, above);

        assert.equal(baselineDownload, 500);
        assert.equal(baselineUpload, 200);
    });

    /**
     * The storm rule, as a table. A breach notifies on the transition alone:
     * while the line stays under its baseline the round is quiet, so a bad
     * afternoon is one message rather than one an hour.
     *
     * Read from the stored rows rather than from a remembered flag, which is
     * the rule tasks/integrations.js:128-137 argues for in the sibling case: a
     * restart between two bad tests would forget a module variable, and a
     * restart is exactly when somebody is looking.
     */
    describe("firing on the transition and not on the run of bad tests", () => {
        it("says nothing while the line holds up", () => {
            assert.equal(verdict(above, above).breached, false);
        });

        it("fires on the test that drops below", () => {
            assert.equal(verdict(below, above).breached, true);
        });

        it("stays quiet while it is still below", () => {
            assert.equal(verdict(below, below).breached, false);
        });

        // Recovery is silent. Nothing in this codebase sends a "back to normal"
        // event, and inventing one here would need its own event name,
        // template variables and locale set.
        it("says nothing when the line comes back", () => {
            assert.equal(verdict(above, below).breached, false);
        });

        // A target measuring for the first time has no previous test, and a
        // first reading below the baseline of an imported history is a
        // transition like any other.
        it("fires on a first test with nothing before it", () => {
            assert.equal(verdict(below, undefined).breached, true);
            assert.equal(verdict(below, null).breached, true);
        });
    });

    /**
     * Either metric is enough, mirroring the any-armed-metric rule the fixed
     * thresholds already follow: a line delivering its download while its
     * upload has collapsed is worth hearing about.
     */
    it("fires on a collapse in one direction alone", () => {
        assert.equal(verdict({download: 500, upload: 100}, above).breached, true);
        assert.equal(verdict({download: 300, upload: 200}, above).breached, true);
    });

    // Strictly below, the way the fixed download threshold is judged. Exactly
    // on the line is the line being met.
    it("treats a reading exactly on the line as met", () => {
        assert.equal(verdict({download: 350, upload: 200}, above).breached, false);
        assert.equal(verdict({download: 349.9, upload: 200}, above).breached, true);
    });

    /**
     * A column with no baseline cannot be breached, and neither can a reading
     * that is not a reading. The fixed thresholds fail open on an unusable
     * measurement because a gate switched on with nothing to compare must not
     * go silent; here the switch *is* the comparison, and reading an
     * unmeasured column as "below" would let one unreadable row in the history
     * mute the transition this whole rule is built on.
     */
    it("judges only the columns that have both a yardstick and a reading", () => {
        const downloadOnly = baselineOf(rows(FULL).map(() => ({download: 500, upload: null})));

        assert.equal(baselineVerdict({download: 500, upload: 1}, above, downloadOnly, PERCENT).breached,
            false, "a column with no baseline was judged anyway");
        assert.equal(baselineVerdict({download: 300, upload: 1}, above, downloadOnly, PERCENT).breached,
            true, "the column that does have a baseline stopped being judged");
    });

    it("reads an unmeasured reading as nothing to judge rather than as a breach", () => {
        assert.equal(verdict({download: null, upload: 200}, above).breached, false);
        assert.equal(verdict({download: -1, upload: 200}, above).breached, false);
    });

    // A previous row whose reading cannot be read is not evidence that the
    // line was already down, so it does not swallow this test's transition.
    it("does not let an unreadable previous row swallow the transition", () => {
        assert.equal(verdict(below, {download: null, upload: null}).breached, true);
    });

    /**
     * Which direction went under, and how far under it landed.
     *
     * The verdict carried the two medians and nothing about the crossing
     * itself, so the messages it produced could not name one. Download
     * collapsing and upload collapsing an hour later arrived as two alerts
     * that read identically, and telling them apart meant comparing a figure
     * in the message against a median the message did not carry.
     *
     * It has to be decided here because a template is the only place it can be
     * said, and a template has neither arithmetic nor a conditional: a message
     * can say exactly what the payload already knows.
     */
    describe("what crossed, and by how much", () => {
        /*
         * The share below the median rather than the share of it. "40% below
         * what this line usually does" is the sentence somebody reads at
         * breakfast; the share they set is a setting, and it is on the screen
         * they set it from.
         */
        it("names the direction that went under and how far under", () => {
            const {baselineDirection, baselineShortfall} = verdict(below, above);

            assert.equal(baselineDirection, "download");
            assert.equal(baselineShortfall, 40, "300 against a 500 median is 40 per cent under");
        });

        // Download 300 of 500 is 40 under, upload 100 of 200 is 50.
        it("names both when one round puts both under, and the deeper shortfall", () => {
            const {baselineDirection, baselineShortfall} = verdict({download: 300, upload: 100}, above);

            assert.equal(baselineDirection, "download, upload");
            assert.equal(baselineShortfall, 50, "the shallower of the two was reported");
        });

        /**
         * Only what this round newly put under, which is the same edge
         * `breached` is read off. A metric that was already below its median
         * announced itself when it crossed, and naming it again would report
         * two directions collapsing where one did.
         */
        it("names only the direction this round crossed", () => {
            const {baselineDirection, baselineShortfall} =
                verdict({download: 300, upload: 100}, {download: 300, upload: 200});

            assert.equal(baselineDirection, "upload");
            assert.equal(baselineShortfall, 50);
        });

        // A whole percentage: the figure goes into a sentence, not into
        // arithmetic, and 30.02 per cent under is a number nobody says.
        it("rounds the shortfall to a whole percentage", () => {
            assert.equal(verdict({download: 349.9, upload: 200}, above).baselineShortfall, 30);
        });

        /**
         * Null rather than an empty string or a zero on a round that crossed
         * nothing. replaceVariables prints a null as its not-measured mark, and
         * a template naming these on every finished test should read as having
         * nothing to report - where "0% under" reads as a line exactly on its
         * median, which is a different and untrue statement.
         */
        it("names nothing on a round that crossed nothing", () => {
            for (const [row, previous] of [[above, above], [below, below], [above, below]]) {
                const {baselineDirection, baselineShortfall} = verdict(row, previous);

                assert.equal(baselineDirection, null);
                assert.equal(baselineShortfall, null);
            }
        });
    });

    describe("when there is nothing to judge against", () => {
        const quiet = {armed: false, breached: false, baselineDirection: null,
            baselineShortfall: null, baselineDownload: null, baselineUpload: null};

        /**
         * A share the operator set, with no median to judge it against yet, is
         * ARMED and not breaching - not quiet.
         *
         * This asserted the opposite, and the opposite is what put an
         * integration with the baseline on and the three fixed limits blank
         * into breachesThreshold's `return !armed` tail: every healthy test
         * notified, once per test, for the twenty successful rows it takes to
         * reach a median - indefinitely on a target run by hand. `armed`
         * answers "did the operator ask for this alert", and the answer during
         * warm-up is yes.
         */
        it("is armed but silent while it has no baseline to judge against", () => {
            assert.deepEqual(baselineVerdict(below, above, null, PERCENT),
                {armed: true, breached: false, baselineDirection: null, baselineShortfall: null,
                    baselineDownload: null, baselineUpload: null});
        });

        /**
         * The column is the switch, so a percentage the door would refuse means
         * off rather than something to act on. Above the ceiling it would alert
         * on roughly every other test - the median is exceeded by half of them
         * by construction - and the only way such a value reaches a row is a
         * hand-edited database or an import.
         */
        it("is not armed by a percentage that says nothing", () => {
            for (const percent of [null, undefined, 0, NaN, "", "fast", -70,
                BASELINE_PERCENT_MIN - 1, BASELINE_PERCENT_MAX + 1, 100])
                assert.deepEqual(baselineVerdict(below, above, baseline, percent), quiet,
                    `${String(percent)} armed the baseline`);
        });

        // Both ends of what the door does accept.
        it("is armed at either boundary the door allows", () => {
            for (const percent of [BASELINE_PERCENT_MIN, BASELINE_PERCENT_MAX])
                assert.equal(baselineVerdict(below, above, baseline, percent).armed, true,
                    `${percent} was refused`);
        });

        // The stored column is a DOUBLE, and an imported row can carry text
        // where a number belongs - the same trap baselineOf reads through.
        it("reads a percentage stored as text", () => {
            assert.equal(baselineVerdict(below, above, baseline, "70").breached, true);
        });
    });
});

describe("baselinePercentProblem", () => {
    it("accepts nothing at all, which is how a target says the baseline is off", () => {
        assert.equal(baselinePercentProblem(null), null);
        assert.equal(baselinePercentProblem(undefined), null);
    });

    it("accepts both ends of the range and a fraction inside it", () => {
        assert.equal(baselinePercentProblem(BASELINE_PERCENT_MIN), null);
        assert.equal(baselinePercentProblem(BASELINE_PERCENT_MAX), null);
        assert.equal(baselinePercentProblem(72.5), null);
    });

    /**
     * The ceiling is below a hundred on purpose: the median is exceeded by half
     * the tests by construction, so a hundred per cent means "alert on roughly
     * every other test". A value that floods or mutes the feature is a mistake
     * worth naming at the door, the way a zero optimal already is.
     */
    it("refuses a percentage outside the range", () => {
        assert.match(baselinePercentProblem(BASELINE_PERCENT_MIN - 1), /baseline/i);
        assert.match(baselinePercentProblem(BASELINE_PERCENT_MAX + 1), /baseline/i);
        assert.match(baselinePercentProblem(100), /baseline/i);
        assert.match(baselinePercentProblem(0), /baseline/i);
        assert.match(baselinePercentProblem(-70), /baseline/i);
    });

    // Refused rather than coerced, for the reason flagProblem states verbatim:
    // over the API, reading "seventy" as something is a worse surprise than a
    // 400 naming the field.
    it("refuses anything that is not a number", () => {
        for (const bad of ["70", "", {}, [], true, NaN, Infinity])
            assert.match(baselinePercentProblem(bad), /baseline/i, `accepted ${JSON.stringify(bad)}`);
    });
});

describe("baselineWindowStart", () => {
    const MS_PER_DAY = 86_400_000;

    it("reaches back exactly the window the median is taken over", () => {
        const now = new Date("2026-08-31T12:00:00.000Z");

        assert.equal(baselineWindowStart(now).toISOString(),
            new Date(now.getTime() - BASELINE_WINDOW_DAYS * MS_PER_DAY).toISOString());
    });

    it("reaches back from now when it is given no clock", () => {
        const reach = Date.now() - baselineWindowStart().getTime();
        const window = BASELINE_WINDOW_DAYS * MS_PER_DAY;

        assert.ok(Math.abs(reach - window) < MS_PER_DAY, `reached back ${reach}ms`);
    });
});

describe("BASELINE_METRICS", () => {
    // The one list the median, the comparison and the window query all read.
    // A column in one and not the others arrives as undefined, silently.
    it("names the two speeds and nothing else", () => {
        assert.deepEqual(BASELINE_METRICS, ["download", "upload"]);
    });

    /**
     * Ping is deliberately absent. Its comparison is inverted - the trap
     * ALERT_METRICS warns about, where a "below" name gets filled in for a
     * metric where bigger is worse - and a latency median is noisy enough that
     * the statistics replaced its standard deviation with a median absolute
     * deviation over exactly this problem.
     */
    it("leaves latency out of it", () => {
        assert.equal(BASELINE_METRICS.includes("ping"), false);
    });
});

/**
 * A target still gathering its first twenty rows is ARMED, not silent.
 *
 * `armed` answers "did the operator ask for this alert", and it is what stops
 * breachesThreshold falling through to its `return !armed` tail - the branch
 * that fires on a gate switched on with no usable limit anywhere, so that a
 * half-finished setup is a nuisance rather than an integration that has
 * quietly stopped working.
 *
 * Reporting a warming-up target as unarmed put the one setup that block names
 * in its own comment - baseline on, the three fixed limits blank - into
 * exactly the storm it says it prevents: every healthy test notified, once per
 * test, until the twentieth successful row landed. On the hourly default that
 * is twenty spurious messages; on a target run by hand it is indefinite,
 * because twenty successes inside a thirty-day window may never arrive.
 *
 * So warming up is armed-and-not-breaching. It is a target that cannot yet
 * judge itself, which is a different statement from a target nobody asked to.
 */
describe("a baseline that has not gathered enough rows yet", () => {
    const rows = (count) => Array.from({length: count}, () => ({download: 900, upload: 500}));

    it("arms the gate while the median is still out of reach", () => {
        const window = rows(BASELINE_MIN_SAMPLES - 1);
        const verdict = baselineVerdict({download: 900, upload: 500}, window[0],
            baselineOf(window), 70);

        assert.equal(baselineOf(window), null, "the window already yields a median; re-anchor this");
        assert.equal(verdict.armed, true,
            "a warming-up target reports unarmed, so an integration with no fixed limits "
            + "notifies on every healthy test");
        assert.equal(verdict.breached, false, "a target with no median to compare against breached");
    });

    // And it says nothing about medians it does not have, rather than a zero a
    // template would print as this target's usual speed.
    it("names no median it has not got", () => {
        const window = rows(BASELINE_MIN_SAMPLES - 1);
        const verdict = baselineVerdict({download: 900, upload: 500}, window[0],
            baselineOf(window), 70);

        assert.equal(verdict.baselineDownload, null);
        assert.equal(verdict.baselineUpload, null);
    });

    /**
     * A target nobody configured is still unarmed - that is the ordinary case
     * on every instance, and arming it would fire on every test everywhere.
     */
    it("leaves an unconfigured target alone", () => {
        for (const percent of [null, undefined])
            assert.equal(baselineVerdict({download: 900}, null, null, percent).armed, false,
                `a target with percent ${percent} armed itself`);
    });

    // A stored share nothing can read is not a request either - it is a value
    // the door would have refused, and baselineOrNull treats it as no baseline.
    it("leaves an unreadable share unarmed", () => {
        for (const junk of ["seventy", Number.NaN, 0, 1000])
            assert.equal(baselineVerdict({download: 900}, null, null, junk).armed, false,
                `${junk} armed the gate`);
    });
});

/**
 * The edge is per metric, not per target.
 *
 * The judgement used to be a single `.some()` over download and upload, and
 * the transition was read off that one answer - so it fired on "is this target in
 * breach at all". While download sat under its median, upload could collapse
 * to a fraction of its own and nobody was told: the round was already in
 * breach, so there was no edge to see.
 *
 * That silences precisely the case the any-metric rule exists for, and
 * metricBelow's own comment says so in as many words - "a line delivering
 * its download while its upload has collapsed is worth hearing about". A
 * second metric going down is a new thing happening to the line, not a
 * continuation of the first.
 *
 * The storm rule is unchanged where it matters: a metric that stays under its
 * median announces itself once and then goes quiet, however many rounds it
 * lasts.
 */
describe("a second metric collapsing while the first is already down", () => {
    const baseline = {download: 1000, upload: 500};
    const PERCENT = 70;

    // Well under seventy per cent on the named metric, comfortably over on the
    // other, so each row breaches exactly what it says it does.
    const rows = {
        healthy: {download: 900, upload: 450},
        downOnly: {download: 100, upload: 450},
        both: {download: 100, upload: 10},
        upOnly: {download: 900, upload: 10}
    };

    const verdict = (row, previous) => baselineVerdict(row, previous, baseline, PERCENT);

    it("announces the second collapse", () => {
        assert.equal(verdict(rows.both, rows.downOnly).breached, true,
            "upload fell to a fiftieth of its median while download was already under, "
            + "and the round said nothing");
    });

    // The first one still announces itself once, and only once.
    it("still announces the first, and stays quiet while it lasts", () => {
        assert.equal(verdict(rows.downOnly, rows.healthy).breached, true);
        assert.equal(verdict(rows.downOnly, rows.downOnly).breached, false,
            "a sustained breach announced itself twice");
        assert.equal(verdict(rows.both, rows.both).breached, false,
            "two sustained breaches announced themselves again");
    });

    /**
     * And a metric recovering while the other stays down is not an
     * announcement either - nothing in this codebase sends a "back to normal",
     * and half a recovery is not a new breach.
     */
    it("says nothing when one metric recovers and the other does not", () => {
        assert.equal(verdict(rows.downOnly, rows.both).breached, false,
            "upload coming back announced itself as a breach");
    });

    // A breach that moves from one metric to the other is a new metric going
    // down, so it is announced - the download recovering is incidental.
    it("announces a breach that moves to the other metric", () => {
        assert.equal(verdict(rows.upOnly, rows.downOnly).breached, true);
    });

    it("says nothing at all while the line is well", () => {
        assert.equal(verdict(rows.healthy, rows.healthy).breached, false);
        assert.equal(verdict(rows.healthy, rows.both).breached, false);
    });
});
