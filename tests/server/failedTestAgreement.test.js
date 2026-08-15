import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Op } from "sequelize";
import { FAILED_TEST, FAILED_TEST_FILTER, SUCCESSFUL_TEST_FILTER, isFailedTest, isSuccessfulTest } from "../../server/util/testOutcome.js";
import { isFailedTest as clientIsFailedTest } from "../../client/src/common/utils/TestUtil.js";

/**
 * "Did this test fail" was answered in four places and the four disagreed.
 *
 * The statistics and the status route asked whether the error column was null.
 * Prometheus and the OpenGraph image asked whether there was an error or a -1
 * ping. The client asked whether there was an error or all three measurements
 * were -1. So a row could be drawn as a failure on the overview and counted as
 * a success in the failure rate underneath it, and a scrape could refuse a test
 * the dashboard was happily rendering.
 *
 * Neither side can import the other - the client bundles for a browser, the
 * server runs under node with its own module graph - so this pins them to the
 * same fixtures, the way loadedLatencyAgreement already does for the added
 * latency.
 */
const test = (overrides = {}) => ({
    ping: 10, download: 100, upload: 50, jitter: 2, time: 30, error: null, ...overrides
});

const CASES = [
    {name: "an ordinary measurement", row: test(), failed: false},
    {name: "a failure with a reason", row: test({ping: -1, download: -1, upload: -1, error: "Cannot open socket"}), failed: true},
    {name: "a failure whose reason went missing", row: test({ping: -1, download: -1, upload: -1}), failed: true},
    // An empty string carries no message, and the readings beside it are real.
    // The statistics and the status route read `error !== null` and called this
    // a failure, which dropped three good measurements out of every average.
    {name: "an empty error beside real readings", row: test({error: ""}), failed: false},
    {name: "a row with no error key at all", row: {ping: 10, download: 100, upload: 50}, failed: false},
    // Only a hand-edited import makes this shape - a real failure writes -1 in
    // every column at once - and two real readings must not be thrown away for
    // the sake of the third.
    {name: "one placeholder among two readings", row: test({ping: -1}), failed: false},
    {name: "two placeholders among one reading", row: test({ping: -1, download: -1}), failed: false},
    {name: "a genuine zero", row: test({ping: 0, download: 0, upload: 0}), failed: false}
];

describe("the two ways a failed test is recognised", () => {
    for (const {name, row, failed} of CASES) {
        it(`agrees on ${name}`, () => {
            assert.equal(isFailedTest(row), failed, `the server disagrees about ${name}`);
            assert.equal(clientIsFailedTest(row), failed, `the client disagrees about ${name}`);
        });
    }

    it("says nothing about a test that is not there", () => {
        for (const missing of [null, undefined]) {
            assert.equal(isFailedTest(missing), false);
            assert.equal(clientIsFailedTest(missing), false);
        }
    });

    it("reads the same question the other way round", () => {
        for (const {row, failed} of CASES) assert.equal(isSuccessfulTest(row), !failed);
    });
});

/**
 * And every reader of the answer takes it from the one place.
 *
 * A local copy is how the four grew apart in the first place, so the source is
 * scanned for the shapes they each used to carry.
 */
describe("nothing judges a failure for itself", () => {
    const READERS = [
        "server/util/statistics.js",
        "server/routes/prometheus.js",
        "server/routes/speedtests.js",
        "server/controller/opengraph.js",
        // The two queries that ask the database rather than a row. They kept the
        // pre-da12aeae `error IS NOT NULL` while every reader above moved, so
        // the status route reported a failure count by one rule beside a
        // lastTest.failed by the other - and this list, which exists to catch
        // exactly that, did not scan the file it happened in.
        "server/controller/speedtests.js"
    ];

    for (const file of READERS) {
        it(`${file} asks the shared rule`, async () => {
            const fs = await import("node:fs");
            const path = await import("node:path");
            const { fileURLToPath } = await import("node:url");

            const root = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
            const source = fs.readFileSync(path.join(root, file), "utf8");

            assert.match(source, /isFailedTest|isSuccessfulTest|FAILED_TEST_FILTER|SUCCESSFUL_TEST_FILTER/,
                `${file} no longer consults the shared rule`);
            assert.doesNotMatch(source, /error\s*[!=]==\s*null\s*\?|\.error\s*\|\|\s*\w+\.ping\s*===\s*-1/,
                `${file} carries its own copy of the judgement again`);
            // The SQL spelling of the same judgement, which is how the two
            // queries in the controller kept the old rule while every reader
            // beside them moved off it.
            assert.doesNotMatch(source, /error:\s*\{\s*\[Op\.ne]:\s*null\s*}|where:\s*\{error:\s*null}/,
                `${file} asks the database whether the error column is null again`);
        });
    }
});

/**
 * The same question as a where clause, for the counts that ask the database
 * instead of a row.
 *
 * Shape rather than behaviour: what matters is that both spellings are built
 * from the one sentinel and that neither reduces to "the error column is not
 * null". Whether they select the right rows is settled against a real database
 * in tests/integration/status.test.js.
 */
describe("the same rule as a where clause", () => {
    const placeholders = (clause) => clause[Op.and][1];

    it("calls a row failed for a message or three placeholders, not for a null error", () => {
        const [message, allThree] = FAILED_TEST_FILTER[Op.or];

        assert.deepEqual(message, {[Op.and]: [{error: {[Op.ne]: null}}, {error: {[Op.ne]: ""}}]});
        assert.deepEqual(allThree, {
            [Op.and]: [{ping: FAILED_TEST}, {download: FAILED_TEST}, {upload: FAILED_TEST}]
        });
    });

    it("reads the same question the other way round", () => {
        assert.deepEqual(SUCCESSFUL_TEST_FILTER[Op.and][0], {[Op.or]: [{error: null}, {error: ""}]});
    });

    /**
     * De Morgan rather than a NOT around the conjunction: `NOT (ping = -1 AND
     * ...)` is NULL - and so excludes the row - the moment any column in it is
     * NULL, which would drop a successful row from the recommendations sample
     * on a restored history.
     */
    it("negates the placeholders column by column so a null cannot swallow a row", () => {
        assert.deepEqual(placeholders(SUCCESSFUL_TEST_FILTER), {
            [Op.or]: [
                {ping: {[Op.ne]: FAILED_TEST}},
                {download: {[Op.ne]: FAILED_TEST}},
                {upload: {[Op.ne]: FAILED_TEST}}
            ]
        });
    });

    it("spells the placeholder with the exported sentinel", () => {
        assert.equal(FAILED_TEST, -1);
    });
});
