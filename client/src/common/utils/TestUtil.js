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

const INCREASE_DECIMALS = 2;

/**
 * The colour a grade is shown in. Kept beside the thresholds so the two cannot
 * drift into disagreeing about what counts as a good line.
 */
export function bufferbloatColour(grade) {
    if (grade === "A+" || grade === "A") return "green";
    if (grade === "B" || grade === "C") return "orange";

    return "red";
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
    const grade = BUFFERBLOAT_GRADES.find((entry) => increase < entry.upTo)?.grade ?? WORST_GRADE;

    return {increase, grade};
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
