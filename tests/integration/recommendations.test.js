import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer, seedTests } from "./helpers/boot.js";

let server;
let recommendations;
let createRecommendations;

const MS_PER_MINUTE = 60000;
const minutesAgo = (minutes) => new Date(Date.now() - minutes * MS_PER_MINUTE).toISOString();

// Ten successes with a known best in each column, oldest values worst.
const successes = () => Array.from({length: 10}, (_, i) => ({
    created: minutesAgo(20 - i),
    ping: 30 - i,            // best (lowest) is 21
    download: 100 + i * 10,  // best (highest) is 190
    upload: 50 + i * 5       // best (highest) is 95
}));

const failure = (overrides = {}) => ({
    created: minutesAgo(1), ping: -1, download: -1, upload: -1, time: null,
    jitter: null, packetLoss: null, downloadLatency: null, uploadLatency: null,
    error: "Too many requests", ...overrides
});

// A full sample of rows the error column calls successful and every numeric
// column calls failed, spread over the same window the successes above use.
const RECOMMENDATION_SAMPLE = 10;
const unmeasured = () => Array.from({length: RECOMMENDATION_SAMPLE},
    (unused, i) => failure({created: minutesAgo(20 - i), error: null}));

before(async () => {
    server = await bootServer();
    recommendations = await import("../../server/controller/recommendations.js");
    ({createRecommendations} = await import("../../server/tasks/speedtest.js"));
});

after(async () => {
    await server?.close();
});

beforeEach(async () => {
    await seedTests(server.tests, []);
    const current = await recommendations.getCurrent();
    if (current) await server.db.models.recommendations.destroy({where: {}});
});

describe("createRecommendations", () => {
    it("reads the best of the newest ten successful tests", async () => {
        await seedTests(server.tests, successes());

        await createRecommendations();

        const current = await recommendations.getCurrent();
        assert.deepEqual({ping: current.ping, download: current.download, upload: current.upload},
            {ping: 21, download: 190, upload: 95});
    });

    /**
     * Regression: the sample was filtered out of listTests(), whose default
     * limit is 10 rows *including* failures. One failed test among the newest
     * ten therefore shrank the sample to nine and the update was skipped -
     * every later failure kept it skipped, so the recommendations froze.
     */
    it("still updates when a failure sits among the newest tests", async () => {
        await seedTests(server.tests, [...successes(), failure()]);

        await createRecommendations();

        const current = await recommendations.getCurrent();
        assert.ok(current, "one failed test froze the recommendations");
        assert.equal(current.ping, 21);
    });

    it("says nothing until ten tests have succeeded", async () => {
        await seedTests(server.tests, [...successes().slice(0, 9), failure()]);

        await createRecommendations();

        assert.equal(await recommendations.getCurrent(), null);
    });

    it("never reads a failure's -1 placeholders as a best value", async () => {
        // Eleven successes, so the sample is full even with the failure newest:
        // a -1 ping would win "lowest" if the failure leaked into the sample.
        await seedTests(server.tests, [...successes(), {created: minutesAgo(30), ping: 25}, failure()]);

        await createRecommendations();

        const current = await recommendations.getCurrent();
        assert.equal(current.ping, 21);
    });

    /**
     * A row carrying the placeholders while its error column says it succeeded
     * has no business existing, but a botched import writes one and listTests()
     * hands it over as a success. Only the ping guard keeps -1 out of the
     * result: it is lower than any latency a line can actually manage.
     */
    it("ignores a -1 ping on a test that reports no error", async () => {
        await seedTests(server.tests, [...successes(), failure({error: null})]);

        await createRecommendations();

        const current = await recommendations.getCurrent();
        assert.equal(current.ping, 21);
    });

    /**
     * The fabricated zero, which is not a placeholder and not a reading either.
     *
     * parseCloudflare stores `round(avg_latency_ms) ?? 0` on its success path,
     * so a run whose latency block held no average writes a 0 into a row that
     * is a success in every other column. The statistics refuse it and the
     * alert gate refuses it, both through isMeasuredLatency - and this loop,
     * the third reader of the same rule, was still gating on "at least
     * FAILED + 1", which is zero. So the recommendation card published a
     * latency target of 0 ms drawn from a row the page beside it would not
     * average, which is the disagreement that rule exists to end.
     */
    it("never recommends the fabricated zero as the best latency", async () => {
        const sample = successes();
        sample[0].ping = 0;

        await seedTests(server.tests, sample);

        await createRecommendations();

        const current = await recommendations.getCurrent();
        assert.equal(current.ping, 21,
            "a latency nobody measured was published as the best of the sample");
    });

    it("recommends nothing when no test in the sample measured a ping", async () => {
        await seedTests(server.tests, unmeasured());

        await createRecommendations();

        assert.equal(await recommendations.getCurrent(), null,
            "a sample of placeholders was written as a recommendation");
    });

    /**
     * The half of the same story that costs something. A sample nothing can be
     * read from used to overwrite the targets already on record: first with the
     * -1 placeholder, and once that was guarded, with the untouched Infinity -
     * which the ping column stores as null, beside a download and upload reset
     * to the zero the loop starts from. Yesterday's recommendation was fine and
     * should simply stay.
     */
    it("leaves the standing recommendation alone when the sample measured no ping", async () => {
        await seedTests(server.tests, successes());
        await createRecommendations();

        await seedTests(server.tests, unmeasured());
        await createRecommendations();

        const current = await recommendations.getCurrent();
        assert.deepEqual({ping: current.ping, download: current.download, upload: current.upload},
            {ping: 21, download: 190, upload: 95});
    });

    it("still recommends from the other nine when one ping is not a number", async () => {
        // sqlite stores what it is handed, so an empty string survives in a
        // numeric column - and it is the newest row, so the loop meets it first
        // and every real ping behind it then compares as higher.
        const sample = successes();
        sample[sample.length - 1].ping = "";

        await seedTests(server.tests, sample);

        await createRecommendations();

        const current = await recommendations.getCurrent();
        assert.deepEqual({ping: current.ping, download: current.download, upload: current.upload},
            {ping: 22, download: 190, upload: 95});
    });
});
