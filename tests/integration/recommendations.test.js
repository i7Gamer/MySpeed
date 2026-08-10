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
});
