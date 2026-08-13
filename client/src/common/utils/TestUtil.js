// Percentage of the configured optimum at which a measurement stops counting
// as good, then as acceptable. Latency is inverted: there, higher is worse.
const SPEED_GOOD = 75;
const SPEED_FAIR = 30;
const LATENCY_BAD = 180;
const LATENCY_FAIR = 130;

const FAILED_TEST = -1;

// Number("") and Number(null) are both 0, which would read as a genuine
// measurement of zero rather than as an absent one.
const isMissing = (value) => value === null || value === undefined || value === "";

// One decimal: enough to tell 0.4% from 4% without implying the precision of a
// figure built on a few dozen tests.
const RATE_DECIMALS = 1;
const PERCENT = 100;

/**
 * How much latency the line gains once it is saturated, and what that is worth
 * as a grade.
 *
 * This is the figure that explains a call breaking up while something uploads,
 * and it is invisible in the three numbers MySpeed has always shown - a
 * connection can be fast both ways and still unusable during a transfer.
 *
 * Graded on the worse of the two directions rather than an average: a line that
 * is clean downstream and badly buffered upstream is a badly buffered line, and
 * averaging the two hides exactly the asymmetry that is most common.
 *
 * The thresholds are the ones the established bufferbloat tests use, in
 * milliseconds of added latency.
 */
const BUFFERBLOAT_GRADES = [
    {upTo: 5, grade: "A+"},
    {upTo: 30, grade: "A"},
    {upTo: 60, grade: "B"},
    {upTo: 200, grade: "C"},
    {upTo: 400, grade: "D"}
];

const WORST_GRADE = "F";

// Two, and not the one decimal every latency is *shown* at: this figure is not
// only shown. The server works the same quantity out across a range to average
// it, and tests/server/loadedLatencyAgreement.test.js pins the two to the same
// arithmetic - so the precision cannot be changed on one side alone. Rounding
// it to one decimal here would also move the grade boundaries, which are read
// as "under 5 ms" rather than as "under whatever 5 rounds from".
const INCREASE_DECIMALS = 2;

/**
 * What changed about the connection itself between two tests, or null if
 * nothing did.
 *
 * A step in the numbers reads as the line degrading, and often it is not: a
 * reassigned lease, a failover, a swapped router. Both values are absent on
 * providers that do not report them and on rows recorded before they were
 * captured - and an absent value is not a change, it is a silence.
 */
/**
 * The nearest earlier test that says which connection it ran on.
 *
 * Not simply the row before: that one may carry no identity at all - every test
 * recorded before these columns existed, and every test from a provider that
 * does not report them - and comparing against it would report "no change"
 * across exactly the gap a change hides in.
 *
 * The list is newest first, so earlier in time is later in the array.
 */
export function previousConnection(tests, index) {
    if (!Array.isArray(tests)) return null;

    for (let i = index + 1; i < tests.length; i++)
        if (tests[i]?.isp || tests[i]?.externalIp) return tests[i];

    return null;
}

export function connectionChange(test, previous) {
    if (!test || !previous) return null;

    const differs = (key) => {
        const now = test[key];
        const before = previous[key];
        if (!now || !before) return false;

        return now !== before;
    };

    const change = {isp: differs("isp"), externalIp: differs("externalIp")};

    return change.isp || change.externalIp ? change : null;
}

/**
 * Where a loss rate and a jitter figure stop being good, then acceptable.
 *
 * Both are read against what a voice or video call needs, which is the first
 * thing either one breaks: a percent of loss is audible, and jitter past a
 * couple of dozen milliseconds is what a jitter buffer runs out of room for.
 * Throughput has the configured optimum to be measured against; these two have
 * no setting anywhere, so the thresholds live here.
 */
const PACKET_LOSS_GOOD = 1;
const PACKET_LOSS_FAIR = 2.5;

const JITTER_GOOD = 5;
const JITTER_FAIR = 20;

// Tighter than the jitter above, because it measures a different thing: jitter
// is the spread within one test, this is the spread between them. A line whose
// latency wanders by five milliseconds from one hour to the next is not the
// steady one that five milliseconds of jitter describes - it is one whose route
// or load keeps changing underneath it.
const PING_DEVIATION_GOOD = 2;
const PING_DEVIATION_FAIR = 10;

// Blue for anything that is not a measurement: a range in which nothing
// reported the figure has no colour to earn, and red would say the line is bad
// when nothing was measured at all.
const gradeBelow = (value, good, fair) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "blue";
    if (value < good) return "green";
    if (value < fair) return "orange";

    return "red";
};

export const packetLossColour = (value) => gradeBelow(value, PACKET_LOSS_GOOD, PACKET_LOSS_FAIR);

export const jitterColour = (value) => gradeBelow(value, JITTER_GOOD, JITTER_FAIR);

/**
 * How far apart two tests' pings were, as a colour.
 *
 * The stability card used to print this figure in a fixed orange - the value
 * never entered into it - so "±0 ms", the best reading there is, was shown in
 * the warning colour, among four rows whose colours really are verdicts.
 */
export const pingDeviationColour = (value) =>
    gradeBelow(value, PING_DEVIATION_GOOD, PING_DEVIATION_FAIR);

/**
 * Whether a figure was measured at all.
 *
 * A packet loss of zero is a measurement, and the best one there is - hiding it
 * behind a truthiness check hides exactly the result worth showing. Only null
 * and undefined mean the provider never looked, which is the common case: Ookla
 * is the only one that reports a loss, and rows recorded before the column
 * existed carry none either.
 *
 * Shared because the row and the panel it opens have to agree about it. They
 * each had their own copy, one line long, and a blank figure in one view beside
 * a "0%" in the other is a bug nobody would think to look for.
 */
export const isMeasured = (value) => value !== null && value !== undefined;

// Where a consistency score stops being good, then acceptable. Unlike the two
// above this one reads upwards: it is a percentage of steadiness, so more is
// better.
const CONSISTENCY_GOOD = 90;
const CONSISTENCY_FAIR = 70;

/**
 * How steady a metric was, as a colour.
 *
 * Neutral when there is no score rather than red: a range in which every test
 * failed has no consistency to report, and the worst possible colour is as
 * wrong an answer as the best one - it says the line is unstable when nothing
 * was measured.
 */
export const consistencyColour = (value) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "blue";
    if (value >= CONSISTENCY_GOOD) return "green";
    if (value >= CONSISTENCY_FAIR) return "orange";

    return "red";
};

/**
 * The colour a grade is shown in. Kept beside the thresholds so the two cannot
 * drift into disagreeing about what counts as a good line.
 */
export function bufferbloatColour(grade) {
    if (grade === "A+" || grade === "A") return "green";
    if (grade === "B" || grade === "C") return "orange";

    return "red";
}

// How many grades the trend shows. Ten is enough to see a change without the
// row becoming a chart.
export const TREND_LENGTH = 10;

/**
 * The bufferbloat grades of the most recent measured tests, oldest first.
 *
 * A single grade says what the line did on the last test; the trend is where a
 * regression shows. Takes the list the API returns - newest first - keeps the
 * newest TREND_LENGTH tests that measured anything, and reverses them so time
 * reads left to right.
 */
export function bufferbloatTrend(tests) {
    if (!Array.isArray(tests)) return [];

    return tests
        .map((test) => {
            const graded = bufferbloat(test);
            return graded ? {...graded, created: test.created} : null;
        })
        .filter(Boolean)
        .slice(0, TREND_LENGTH)
        .reverse();
}

/**
 * The grade a quantity of added latency earns, from the one table.
 *
 * Separate from bufferbloat() because the figure does not always come from a
 * single test: the consistency panel grades the average across a whole range,
 * and it has to mean the same thing there as it does on one result.
 *
 * Null for anything that is not a measurement. A range in which nothing
 * measured loaded latency has no grade to give, and "A+" would be the most
 * flattering possible lie about it.
 */
export function gradeForIncrease(increase) {
    if (typeof increase !== "number" || !Number.isFinite(increase) || increase < 0) return null;

    return BUFFERBLOAT_GRADES.find((entry) => increase < entry.upTo)?.grade ?? WORST_GRADE;
}

export function bufferbloat(test) {
    if (!test || isFailedTest(test)) return null;

    const {ping, downloadLatency, uploadLatency} = test;

    // Negative rejected as well as absent: a failed test stores -1 in its
    // columns, and a latency of minus one millisecond is not a reading to grade.
    for (const value of [ping, downloadLatency, uploadLatency])
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;

    // Under the idle ping is measurement noise, not an improvement.
    const increase = Math.max(0, parseFloat((Math.max(downloadLatency, uploadLatency) - ping).toFixed(INCREASE_DECIMALS)));

    return {increase, grade: gradeForIncrease(increase)};
}

/**
 * The share of tests in a range that failed, as a percentage.
 *
 * Null when nothing was measured - 0/0 is NaN, and "no tests" must not be
 * presented as "nothing failed".
 */
export function failureRate(total, failed) {
    if (!Number.isFinite(total) || !Number.isFinite(failed)) return null;
    if (total <= 0 || failed < 0) return null;

    return parseFloat(((failed / total) * PERCENT).toFixed(RATE_DECIMALS));
}

/**
 * Whether a stored test is the record of a failure rather than a measurement.
 *
 * The error message is the primary signal, but the -1 placeholders are checked
 * too: a failure that could not be described still must not be presented as a
 * reading of minus one.
 */
export function isFailedTest(test) {
    if (!test) return false;
    if (test.error) return true;

    return test.ping === FAILED_TEST && test.download === FAILED_TEST && test.upload === FAILED_TEST;
}

export function getIconBySpeed(current, optional, higherIsBetter) {
    if (current === FAILED_TEST) return "error";
    if (isMissing(current) || isMissing(optional)) return "blue";

    const speed = Math.floor((Number(current) / Number(optional)) * 100);

    // Nothing has been measured yet. On a fresh install `current` is the "N/A"
    // placeholder, which makes this NaN - and NaN fails every comparison below,
    // so download and upload fell through to "red". The dashboard reported a bad
    // connection before a single test had run.
    if (!Number.isFinite(speed)) return "blue";

    if (higherIsBetter) {
        if (speed >= SPEED_GOOD) return "green";
        if (speed >= SPEED_FAIR) return "orange";
        return "red";
    }

    if (speed >= LATENCY_BAD) return "red";
    if (speed >= LATENCY_FAIR) return "orange";
    return "green";
}
