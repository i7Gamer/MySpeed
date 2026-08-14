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
