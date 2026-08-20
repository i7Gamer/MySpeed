import { Op } from 'sequelize';

/**
 * Whether a stored test is the record of a failure rather than a measurement.
 *
 * There were four answers to this question and they disagreed. The statistics
 * and the status route asked whether the error column was null; Prometheus and
 * the OpenGraph image asked whether there was an error *or* a -1 ping; the
 * client asked whether there was an error or all three measurements were -1. So
 * the same row could be a failure on the overview and a success in the failure
 * rate beneath it, which is the kind of disagreement nobody notices until the
 * numbers are challenged.
 *
 * The two halves of the answer, and why each is the shape it is:
 *
 * A recorded message counts, and an empty string is not one. With real
 * measurements beside it, the readings are what decide: inferring a failure
 * from the absence of information would throw three of them away. The statistics
 * and the status route used to read `error !== null`, which called that row a
 * failure and dropped its measurements out of every average.
 *
 * The placeholders count only when all three agree. A failure is written with
 * -1 in every measurement column at once (tasks/speedtest.js), so requiring
 * three is not stricter than reality; it is what keeps a single -1 from
 * condemning a row that measured the other two. Only a hand-edited import can
 * produce that shape, and calling it a failure would throw away two real
 * readings.
 */
export const FAILED_TEST = -1;

export const isFailedTest = (test) => {
    if (!test) return false;
    if (test.error) return true;

    return test.ping === FAILED_TEST && test.download === FAILED_TEST && test.upload === FAILED_TEST;
};

/** The other side of the same question, for the filters that read it that way. */
export const isSuccessfulTest = (test) => !isFailedTest(test);

/**
 * The latency a run records when it measured none.
 *
 * A successful test can still carry a latency nobody took: parseCloudflare
 * answers `round(avg_latency_ms) ?? 0` on its success path, so a run whose
 * latency block held no average stores exactly 0. The column is NOT NULL, so 0
 * is the only sentinel available - and it is a safe one, because no connection
 * produces it. A real sub-millisecond line stores the decimals it measured:
 * the column has held them since migration 0010, and a genuine 0.24 arrives as
 * 0.24.
 *
 * Which is why the comparison stays exact. Widened to "under a millisecond" it
 * would discard every fibre and LAN reading along with the fabrication.
 */
export const UNMEASURED_LATENCY = 0;

/**
 * Whether a stored latency is a reading.
 *
 * Lives here beside the failure predicates, and for the same reason they do:
 * the alert gate judged this one way and the statistics another, so the same
 * fabricated zero was refused by the notification and averaged into the figure
 * on the page. One home, both readers.
 */
export const isMeasuredLatency = (value) =>
    typeof value === "number" && Number.isFinite(value) && value !== UNMEASURED_LATENCY;

/**
 * The same two answers as where clauses, for the queries that ask the database
 * rather than a row.
 *
 * The predicate above cannot be handed to sequelize, so the counts in the tests
 * controller spelled the rule out in SQL themselves - and kept spelling the
 * *old* one, `error IS NOT NULL`, after every reader of the predicate had been
 * moved off it. The status route then reported a failure count by one rule
 * beside a lastTest.failed by the other, in the same response body.
 *
 * Both spellings live here, next to the predicate they have to agree with, and
 * both are built from the sentinel rather than a literal -1.
 */
const ALL_THREE_PLACEHOLDERS = {
    [Op.and]: [{ping: FAILED_TEST}, {download: FAILED_TEST}, {upload: FAILED_TEST}]
};

export const FAILED_TEST_FILTER = {
    [Op.or]: [
        // A recorded message, and an empty string is not one - the half the old
        // clause got wrong, since `error IS NOT NULL` matches "".
        {[Op.and]: [{error: {[Op.ne]: null}}, {error: {[Op.ne]: ""}}]},
        ALL_THREE_PLACEHOLDERS
    ]
};

export const SUCCESSFUL_TEST_FILTER = {
    [Op.and]: [
        {[Op.or]: [{error: null}, {error: ""}]},
        // De Morgan rather than a NOT around the conjunction: in SQL a
        // comparison against NULL is NULL, so `NOT (ping = -1 AND ...)` throws
        // the row away the moment any of the three columns is null instead of
        // keeping it. Negated column by column, one real reading is enough to
        // keep the row - which is what the predicate says too.
        {[Op.or]: [
            {ping: {[Op.ne]: FAILED_TEST}},
            {download: {[Op.ne]: FAILED_TEST}},
            {upload: {[Op.ne]: FAILED_TEST}}
        ]}
    ]
};
