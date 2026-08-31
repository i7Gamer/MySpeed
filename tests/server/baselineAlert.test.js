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

    describe("when there is nothing to judge against", () => {
        const quiet = {armed: false, breached: false, baselineDownload: null, baselineUpload: null};

        it("is not armed without a baseline", () => {
            assert.deepEqual(baselineVerdict(below, above, null, PERCENT), quiet);
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
