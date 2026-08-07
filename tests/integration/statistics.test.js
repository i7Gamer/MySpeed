import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer, api, seedTests } from "./helpers/boot.js";

let server;
const at = (iso, overrides = {}) => ({created: iso, ...overrides});

before(async () => {
    server = await bootServer();
});

after(async () => {
    await server?.close();
});

beforeEach(async () => {
    await seedTests(server.tests, []);
});

const statistics = (query) => api(server.baseUrl, `/speedtests/statistics?${query}`);

describe("GET /api/speedtests/statistics", () => {
    describe("validation", () => {
        it("rejects a missing range", async () => {
            const {status, body} = await statistics("");
            assert.equal(status, 400);
            assert.match(body.message, /required/i);
        });

        it("rejects a malformed date", async () => {
            const {status, body} = await statistics("from=01-01-2026&to=2026-02-01");
            assert.equal(status, 400);
            assert.match(body.message, /YYYY-MM-DD/);
        });

        // The old regex-only check let these through and Date() rolled them over
        // into a silently different window.
        it("rejects month 13", async () => {
            const {status, body} = await statistics("from=2026-13-01&to=2026-13-02");
            assert.equal(status, 400);
            assert.match(body.message, /real calendar date/i);
        });

        it("rejects 30 February", async () => {
            assert.equal((await statistics("from=2026-02-30&to=2026-03-01")).status, 400);
        });

        it("rejects an inverted range", async () => {
            const {status, body} = await statistics("from=2026-08-07&to=2026-08-01");
            assert.equal(status, 400);
            assert.match(body.message, /before/i);
        });

        it("rejects an out-of-range timezone offset", async () => {
            assert.equal((await statistics("from=2026-08-01&to=2026-08-07&tzOffset=5000")).status, 400);
        });

        it("accepts a valid range", async () => {
            assert.equal((await statistics("from=2026-08-01&to=2026-08-07")).status, 200);
        });

        it("rejects a non-numeric point count", async () => {
            const {status, body} = await statistics("from=2026-08-01&to=2026-08-07&points=abc");
            assert.equal(status, 400);
            assert.match(body.message, /points parameter/);
        });

        it("treats an empty point count as no request at all", async () => {
            const {status, body} = await statistics("from=2026-08-01&to=2026-08-07&points=");
            assert.equal(status, 200);
            assert.equal(body.maxDataPoints, 300);
        });
    });

    describe("chart resolution", () => {
        // One test a minute for six hours: comfortably past the default of 300,
        // comfortably inside the ceiling of 1000.
        const seedMany = () => seedTests(server.tests, Array.from({length: 360}, (unused, index) =>
            at(new Date(Date.UTC(2026, 7, 5, 0, index)).toISOString())));

        it("buckets the series by default", async () => {
            await seedMany();

            const {body} = await statistics("from=2026-08-05&to=2026-08-05&tzOffset=0");
            assert.equal(body.downsampled, true);
            assert.equal(body.rawDataPoints, 360);
            assert.ok(body.labels.length <= 300);
        });

        it("returns one point per test when asked for enough", async () => {
            await seedMany();

            const {body} = await statistics("from=2026-08-05&to=2026-08-05&tzOffset=0&points=1000");
            assert.equal(body.downsampled, false);
            assert.equal(body.labels.length, 360);
            assert.equal(body.data.download.length, 360);
        });

        it("clamps a request beyond the ceiling instead of refusing it", async () => {
            const {status, body} = await statistics("from=2026-08-01&to=2026-08-07&points=99999999");
            assert.equal(status, 200);
            assert.equal(body.maxDataPoints, 1000);
        });
    });

    describe("aggregation", () => {
        it("reports zero totals for an empty range", async () => {
            const {status, body} = await statistics("from=2026-08-01&to=2026-08-07");
            assert.equal(status, 200);
            assert.deepEqual(body.tests, {total: 0, failed: 0});
        });

        it("only counts tests inside the range", async () => {
            await seedTests(server.tests, [
                at("2026-08-05T10:00:00.000Z"),
                at("2026-08-06T10:00:00.000Z"),
                at("2026-09-01T10:00:00.000Z")
            ]);

            const {body} = await statistics("from=2026-08-01&to=2026-08-07&tzOffset=0");
            assert.equal(body.tests.total, 2);
        });

        it("includes tests on the last day of the range", async () => {
            await seedTests(server.tests, [at("2026-08-07T22:30:00.000Z")]);
            const {body} = await statistics("from=2026-08-01&to=2026-08-07&tzOffset=0");
            assert.equal(body.tests.total, 1);
        });

        it("separates failed tests from successful ones", async () => {
            await seedTests(server.tests, [
                at("2026-08-05T10:00:00.000Z", {download: 100}),
                at("2026-08-05T11:00:00.000Z", {download: -1, ping: -1, upload: -1, error: "timeout"})
            ]);

            const {body} = await statistics("from=2026-08-01&to=2026-08-07&tzOffset=0");
            assert.deepEqual(body.tests, {total: 2, failed: 1});
            assert.equal(body.download.avg, 100, "the failed -1 must not enter the average");
        });

        // Regression: an all-failed range produced Infinity/-Infinity/NaN, which
        // JSON.stringify turned into null with no indication anything was wrong.
        it("returns null aggregates, never Infinity or NaN, when every test failed", async () => {
            await seedTests(server.tests, [
                at("2026-08-05T10:00:00.000Z", {download: -1, ping: -1, upload: -1, error: "timeout"}),
                at("2026-08-05T11:00:00.000Z", {download: -1, ping: -1, upload: -1, error: "timeout"})
            ]);

            const {text, body} = await statistics("from=2026-08-01&to=2026-08-07&tzOffset=0");
            assert.equal(body.tests.failed, 2);
            assert.deepEqual(body.download, {min: null, max: null, avg: null});
            assert.ok(!text.includes("Infinity"), "raw payload must not contain Infinity");
            assert.ok(!text.includes("NaN"), "raw payload must not contain NaN");
        });

        it("returns null jitter aggregates when the provider reports none", async () => {
            await seedTests(server.tests, [
                at("2026-08-05T10:00:00.000Z", {jitter: null}),
                at("2026-08-05T11:00:00.000Z", {jitter: null})
            ]);

            const {body} = await statistics("from=2026-08-01&to=2026-08-07&tzOffset=0");
            assert.deepEqual(body.jitter, {min: null, max: null, avg: null});
        });

        it("derives ping consistency jitter from the jitter column", async () => {
            await seedTests(server.tests, [
                at("2026-08-05T10:00:00.000Z", {ping: 10, jitter: 1}),
                at("2026-08-05T11:00:00.000Z", {ping: 90, jitter: 1})
            ]);

            const {body} = await statistics("from=2026-08-01&to=2026-08-07&tzOffset=0");
            assert.equal(body.consistency.ping.stdDev, 40);
            assert.equal(body.consistency.ping.jitter, 1);
        });

        it("keeps the chart series aligned", async () => {
            await seedTests(server.tests, [
                at("2026-08-05T10:00:00.000Z"),
                at("2026-08-05T11:00:00.000Z", {error: "timeout"}),
                at("2026-08-06T10:00:00.000Z")
            ]);

            const {body} = await statistics("from=2026-08-01&to=2026-08-07&tzOffset=0");
            assert.equal(body.data.download.length, body.labels.length);
            assert.equal(body.failed.length, body.labels.length);
            assert.equal(body.errors.length, body.labels.length);
        });

        it("always returns 24 hourly buckets", async () => {
            const {body} = await statistics("from=2026-08-01&to=2026-08-07");
            assert.equal(body.hourlyAverages.length, 24);
        });
    });

    describe("timezone handling", () => {
        // 2026-08-06T23:30Z is already 2026-08-07 for a client at UTC+2, so it
        // belongs to a range that starts on the 7th only when the offset is honoured.
        it("attributes a late-evening UTC test to the client's next day", async () => {
            await seedTests(server.tests, [at("2026-08-06T23:30:00.000Z")]);

            const utc = await statistics("from=2026-08-07&to=2026-08-07&tzOffset=0");
            assert.equal(utc.body.tests.total, 0, "under UTC the test falls on the 6th");

            const ahead = await statistics("from=2026-08-07&to=2026-08-07&tzOffset=-120");
            assert.equal(ahead.body.tests.total, 1, "at UTC+2 the same test falls on the 7th");
        });

        it("buckets the hour of day using the client's offset", async () => {
            await seedTests(server.tests, [at("2026-08-06T23:30:00.000Z")]);

            const {body} = await statistics("from=2026-08-06&to=2026-08-08&tzOffset=-120");
            assert.equal(body.hourlyAverages[1].count, 1);
            assert.equal(body.hourlyAverages[23].count, 0);
        });
    });
});
