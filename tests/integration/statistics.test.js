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

        /**
         * Regression: the score fell through to 100% whenever the mean was not
         * above zero, which includes having no successful tests to take a mean
         * of. A day on which every test failed reported a perfectly stable
         * connection at 100% with a deviation of ±0 - the strongest possible
         * claim about a line, made from no measurements at all.
         */
        it("scores nothing when no test in the range succeeded", async () => {
            await seedTests(server.tests, [
                at("2026-08-05T10:00:00.000Z", {ping: -1, download: -1, upload: -1, error: "Cannot open socket"}),
                at("2026-08-05T11:00:00.000Z", {ping: -1, download: -1, upload: -1, error: "Cannot open socket"})
            ]);

            const {body} = await statistics("from=2026-08-01&to=2026-08-07&tzOffset=0");

            assert.equal(body.consistency.download.consistency, null);
            assert.equal(body.consistency.download.stdDev, null);
            assert.equal(body.consistency.upload.consistency, null);
            assert.equal(body.consistency.ping.deviation, null);
        });

        // A single test is a measurement, but not a spread: there is nothing to
        // be consistent with yet.
        it("scores no deviation from a single test", async () => {
            await seedTests(server.tests, [at("2026-08-05T10:00:00.000Z", {download: 100})]);

            const {body} = await statistics("from=2026-08-01&to=2026-08-07&tzOffset=0");

            assert.equal(body.consistency.download.stdDev, 0);
            assert.equal(body.consistency.download.consistency, 100);
        });

        it("derives ping consistency jitter from the jitter column", async () => {
            await seedTests(server.tests, [
                at("2026-08-05T10:00:00.000Z", {ping: 10, jitter: 1}),
                at("2026-08-05T11:00:00.000Z", {ping: 90, jitter: 1})
            ]);

            const {body} = await statistics("from=2026-08-01&to=2026-08-07&tzOffset=0");
            assert.equal(body.consistency.ping.deviation, 40);
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

    /**
     * All time is asked for by name rather than as a very wide window. The
     * window a wide request would need - one wide enough to hold anything the
     * server still keeps - is a quarter of a century, and bucketing a chart over
     * that draws a year of tests as a handful of points at its right edge. Named,
     * the rows are unfiltered and the charts bucket over the extent of the tests
     * themselves.
     */
    describe("all time", () => {
        const allTime = (query = "") => statistics(`range=all${query}`);

        it("counts every test, however old", async () => {
            await seedTests(server.tests, [
                at("2019-01-01T10:00:00.000Z"),
                at("2026-08-05T10:00:00.000Z")
            ]);

            const {status, body} = await allTime();
            assert.equal(status, 200);
            assert.equal(body.tests.total, 2);
        });

        // The client sends a stand-in window beside the name, because a parent
        // proxies this request to its nodes and a node running an older version
        // knows only from/to. The name has to win, or the stand-in would decide
        // what "everything" means.
        it("ignores the dates that travel beside it", async () => {
            await seedTests(server.tests, [at("2019-01-01T10:00:00.000Z")]);

            const {body} = await allTime("&from=2026-08-01&to=2026-08-07&tzOffset=0");
            assert.equal(body.tests.total, 1);
        });

        /**
         * sqlite keeps whatever it is handed - the same dynamic typing that lets
         * an imported "fast" sit in the download column - so `created` can hold
         * a string that is not a date at all. Every bound of an all-time range is
         * read off those values, and Math.min against NaN is NaN, so one such row
         * turned both bounds into Invalid Dates: the echo below threw on
         * toISOString() and the whole range answered 500.
         */
        describe("a test whose created does not parse", () => {
            const UNDATEABLE = "not a timestamp";

            it("still answers, and bounds the range with the tests that do parse", async () => {
                await seedTests(server.tests, [
                    at(UNDATEABLE),
                    at("2025-03-04T10:00:00.000Z"),
                    at("2026-08-05T11:00:00.000Z")
                ]);

                const {status, body} = await allTime();

                assert.equal(status, 200);
                assert.equal(body.dateRange.from, "2025-03-04T10:00:00.000Z");
                assert.equal(body.dateRange.to, "2026-08-05T11:00:00.000Z");
            });

            // Counted, because the measurement it carries is real - only the
            // instant it claims to have been taken at is not, so it cannot be
            // drawn anywhere on the line.
            it("counts it without placing it on the chart", async () => {
                await seedTests(server.tests, [at(UNDATEABLE), at("2026-08-05T11:00:00.000Z")]);

                const {body} = await allTime();

                assert.equal(body.tests.total, 2);
                assert.deepEqual(body.labels, ["2026-08-05T11:00:00.000Z"]);
            });

            // Nothing left to take a bound from, which is the empty extent again
            // rather than a window running from Infinity.
            it("answers an instance whose every test is undateable", async () => {
                await seedTests(server.tests, [at(UNDATEABLE), at(UNDATEABLE)]);

                const {status, body} = await allTime();

                assert.equal(status, 200);
                assert.equal(body.tests.total, 2);
                assert.deepEqual(body.labels, []);
            });
        });

        it("echoes the extent of the tests as the range it answered for", async () => {
            await seedTests(server.tests, [
                at("2025-03-04T10:00:00.000Z"),
                at("2026-08-05T11:00:00.000Z"),
                at("2025-09-09T09:00:00.000Z")
            ]);

            const {body} = await allTime();
            assert.equal(body.dateRange.from, "2025-03-04T10:00:00.000Z");
            assert.equal(body.dateRange.to, "2026-08-05T11:00:00.000Z");
        });

        /**
         * The length of that window, beside its bounds. The aggregation used to
         * count this too, and the echo was spread over the top of it one line
         * later - so the figure was computed on every request and thrown away
         * before the response was written, leaving the client to work it out
         * again from the dates.
         *
         * Whole days over the window actually answered for: an all-time range
         * on a young instance is the extent of its own tests, and a few hours
         * of them is one day of testing rather than a fraction of one.
         */
        it("reports how many days that extent covers", async () => {
            await seedTests(server.tests, [
                at("2026-08-01T00:00:00.000Z"),
                at("2026-08-07T23:00:00.000Z")
            ]);

            const {body} = await allTime();
            assert.equal(body.dateRange.days, 7);
        });

        it("counts an extent shorter than a day as one", async () => {
            await seedTests(server.tests, [
                at("2026-08-07T09:00:00.000Z"),
                at("2026-08-07T12:00:00.000Z")
            ]);

            const {body} = await allTime();
            assert.equal(body.dateRange.days, 1);
        });

        /**
         * The regression this exists to prevent: bucketed over a stand-in window
         * of ten thousand days, six hours of testing lands in a single bucket and
         * the chart is one point wide.
         */
        it("buckets over the tests rather than over a window wide enough to hold them", async () => {
            await seedTests(server.tests, Array.from({length: 360}, (unused, index) =>
                at(new Date(Date.UTC(2026, 7, 5, 0, index)).toISOString())));

            const {body} = await allTime();
            assert.equal(body.downsampled, true);
            assert.equal(body.rawDataPoints, 360);
            assert.ok(body.labels.length > 250,
                `only drew ${body.labels.length} of the 300 points it had room for`);
        });

        it("still answers with every point when asked for enough", async () => {
            await seedTests(server.tests, Array.from({length: 360}, (unused, index) =>
                at(new Date(Date.UTC(2026, 7, 5, 0, index)).toISOString())));

            const {body} = await allTime("&points=1000");
            assert.equal(body.downsampled, false);
            assert.equal(body.labels.length, 360);
        });

        // Nothing precedes everything, so there is no window to compare against.
        it("never compares against a previous window, even when asked", async () => {
            await seedTests(server.tests, [at("2026-08-05T10:00:00.000Z")]);

            const {body} = await allTime("&compare=previous");
            assert.equal(body.previous, undefined);
        });

        it("answers an instance that has never run a test", async () => {
            const {status, body} = await allTime();

            assert.equal(status, 200);
            assert.deepEqual(body.tests, {total: 0, failed: 0});
            assert.deepEqual(body.labels, []);
        });

        // A single test is an extent of zero width, and the bucketing divides by
        // it. The request that reaches it is `points=50` with 51 tests sharing
        // one instant, which an import can produce.
        it("survives an extent of zero width", async () => {
            await seedTests(server.tests, Array.from({length: 51}, () => at("2026-08-05T10:00:00.000Z")));

            const {status, body} = await allTime("&points=50");
            assert.equal(status, 200);
            assert.equal(body.tests.total, 51);
        });

        it("still refuses a request that names no range at all", async () => {
            const {status} = await statistics("range=7d");
            assert.equal(status, 400);
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
