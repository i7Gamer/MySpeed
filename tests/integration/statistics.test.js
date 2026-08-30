import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer, api, seedTarget, seedTests } from "./helpers/boot.js";

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

        // What the testing itself cost in traffic - stored per row since the
        // transfer columns arrived, and summed for the range here.
        it("reports the data the range's tests used", async () => {
            await seedTests(server.tests, [
                at("2026-08-05T10:00:00.000Z", {bytesDownloaded: 1000, bytesUploaded: 400}),
                at("2026-08-06T10:00:00.000Z", {bytesDownloaded: 2500, bytesUploaded: 600})
            ]);

            const {body} = await statistics("from=2026-08-01&to=2026-08-07&tzOffset=0");
            assert.deepEqual(body.dataUsed, {download: 3500, upload: 1000, total: 4500});
        });

        /**
         * Which targets the figures were actually built from, which is the one
         * thing the client cannot work out for itself: a single-target instance
         * still holds every row of every target it has deleted, and every row an
         * import brought back with no target at all, and nothing narrows its
         * query. Without this field the page grades those rows against the
         * surviving target's optima.
         */
        describe("the targets a page was built from", () => {
            let wan;
            let nas;

            /**
             * seedTarget clears the table before it writes, so these two do not
             * accumulate and no teardown is registered for them: nothing else in
             * this file asks about targets, the statistics read joins nothing to
             * them, and each test file gets its own process and its own throwaway
             * database. A hook that tore them down would only be one more thing
             * that can fail after the suite it belongs to has finished.
             */
            beforeEach(async () => {
                wan = await seedTarget({provider: "ookla", name: "WAN"});
                const targets = await import("../../server/controller/targets.js");
                nas = await targets.create({name: "NAS", provider: "cloudflare"});
            });

            it("names every target inside the window, an untargeted row included", async () => {
                await seedTests(server.tests, [
                    at("2026-08-05T10:00:00.000Z", {targetId: wan.id}),
                    at("2026-08-05T11:00:00.000Z", {targetId: wan.id}),
                    at("2026-08-05T12:00:00.000Z")
                ]);

                const {body} = await statistics("from=2026-08-01&to=2026-08-07&tzOffset=0");
                assert.equal(body.targetIds.length, 2, "one entry per target, not per row");
                assert.ok(body.targetIds.includes(wan.id));
                assert.ok(body.targetIds.includes(null),
                    "a restored export comes back carrying no target at all");
            });

            it("names one target where every row is that target's", async () => {
                await seedTests(server.tests, [
                    at("2026-08-05T10:00:00.000Z", {targetId: wan.id}),
                    at("2026-08-05T11:00:00.000Z", {targetId: wan.id})
                ]);

                const {body} = await statistics("from=2026-08-01&to=2026-08-07&tzOffset=0");
                assert.deepEqual(body.targetIds, [wan.id]);
            });

            it("names only the target a filtered request was narrowed to", async () => {
                await seedTests(server.tests, [
                    at("2026-08-05T10:00:00.000Z", {targetId: wan.id}),
                    at("2026-08-05T11:00:00.000Z", {targetId: nas.id})
                ]);

                const {body} = await statistics(
                    `from=2026-08-01&to=2026-08-07&tzOffset=0&target=${wan.id}`);
                assert.deepEqual(body.targetIds, [wan.id],
                    "the filter is the evidence - these figures really are one target's");
            });
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
            assert.deepEqual(body.download, {min: null, max: null, avg: null, median: null});
            assert.ok(!text.includes("Infinity"), "raw payload must not contain Infinity");
            assert.ok(!text.includes("NaN"), "raw payload must not contain NaN");
        });

        it("returns null jitter aggregates when the provider reports none", async () => {
            await seedTests(server.tests, [
                at("2026-08-05T10:00:00.000Z", {jitter: null}),
                at("2026-08-05T11:00:00.000Z", {jitter: null})
            ]);

            const {body} = await statistics("from=2026-08-01&to=2026-08-07&tzOffset=0");
            assert.deepEqual(body.jitter, {min: null, max: null, avg: null, median: null});
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
        // be consistent with yet. It used to answer "100%, ±0" - a flawlessly
        // steady line off one reading - which is the same overclaim an empty
        // range made above, in a shape that looks like data.
        it("scores nothing from a single test rather than scoring it perfect", async () => {
            await seedTests(server.tests, [at("2026-08-05T10:00:00.000Z", {download: 100})]);

            const {body} = await statistics("from=2026-08-01&to=2026-08-07&tzOffset=0");

            assert.equal(body.consistency.download.stdDev, null);
            assert.equal(body.consistency.download.consistency, null);
            assert.equal(body.consistency.ping.deviation, null);
        });

        // Two is the fewest that can disagree, and zero across two is a real
        // reading that still scores a hundred.
        it("scores two identical tests as perfectly consistent", async () => {
            await seedTests(server.tests, [
                at("2026-08-05T10:00:00.000Z", {download: 100}),
                at("2026-08-05T11:00:00.000Z", {download: 100})
            ]);

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

    /**
     * The summary of the window immediately before the range, which every
     * delta on the statistics page is read against. Until now the only
     * assertion about it was the negative one above - all time never compares
     * - so the payload's shape was held by nothing.
     */
    describe("the previous window", () => {
        const MS_PER_DAY = 24 * 60 * 60 * 1000;
        const MS_PER_HOUR = 60 * 60 * 1000;

        // The UTC calendar day, which is the request's day because every test
        // here pins tz=Etc/UTC - the one zone the wall-clock arithmetic is
        // exact in whatever the host's own clock says.
        const day = (date) => date.toISOString().slice(0, 10);

        it("answers the full window before a range that is fully in the past", async () => {
            await seedTests(server.tests, [
                at("2025-08-05T10:00:00.000Z"),
                at("2025-08-03T10:00:00.000Z"),
                at("2025-07-29T10:00:00.000Z", {download: 50, bytesDownloaded: 700, bytesUploaded: 300})
            ]);

            const {status, body} = await statistics(
                "from=2025-08-01&to=2025-08-07&tz=Etc/UTC&compare=previous");

            assert.equal(status, 200);
            assert.equal(body.previous.tests.total, 1);
            assert.equal(body.previous.download.avg, 50);
            assert.deepEqual(body.previous.dataUsed, {download: 700, upload: 300, total: 1000},
                "the summary of the previous window no longer carries what its tests cost in traffic");
            assert.equal(body.previous.dateRange.from, "2025-07-25T00:00:00.000Z");
            assert.equal(body.previous.dateRange.to, "2025-07-31T23:59:59.999Z");
            assert.equal(body.previous.dateRange.partial, undefined,
                "a window compared whole must not claim it was cut");
            assert.equal(body.dateRange.elapsedDays, undefined,
                "a complete range divides by its whole days, not by an elapsed figure");
        });

        /**
         * A range that ends today has only run until now, so the window before
         * it is cut at the same position: a test seeded just before "a week
         * before now" is counted, one seeded just after is not - it sits in
         * the hours of the previous window's last day that the current window
         * has not lived through yet. (When now is late enough in the day, that
         * second seed rolls into the current window's first day instead, and
         * is outside the previous window either way.)
         */
        it("cuts the window before a range that is still running", async () => {
            const now = new Date();
            const weekAgo = new Date(now.getTime() - 7 * MS_PER_DAY);
            const counted = new Date(weekAgo.getTime() - MS_PER_HOUR);
            const uncounted = new Date(weekAgo.getTime() + 1.5 * MS_PER_HOUR);

            await seedTests(server.tests, [
                at(counted.toISOString(), {download: 50}),
                at(uncounted.toISOString()),
                at(new Date(now.getTime() - 1000).toISOString())
            ]);

            const from = day(new Date(now.getTime() - 6 * MS_PER_DAY));
            const {status, body} = await statistics(
                `from=${from}&to=${day(now)}&tz=Etc/UTC&compare=previous`);

            assert.equal(status, 200);
            assert.equal(body.previous.tests.total, 1,
                "the cut let a test through from hours the range has not lived yet");
            assert.equal(body.previous.download.avg, 50);
            assert.equal(body.previous.dateRange.partial, true);

            // The cut is a week before the server's own reading of now, which
            // is moments after ours - two minutes is far beyond any of it.
            const cut = new Date(body.previous.dateRange.to);
            assert.ok(Math.abs(cut.getTime() - weekAgo.getTime()) < 2 * 60 * 1000,
                `the cut landed at ${cut.toISOString()}, not at the same time a week earlier`);

            // And the density divisor says how much of the window has actually
            // run: between six days (asked at midnight) and seven (at the end
            // of the day).
            assert.equal(typeof body.dateRange.elapsedDays, "number");
            assert.ok(body.dateRange.elapsedDays >= 6 && body.dateRange.elapsedDays <= 7,
                `elapsedDays says ${body.dateRange.elapsedDays} for a seven-day range on its last day`);
        });

        // The API accepts a window the picker cannot produce. Nothing of it
        // has happened, so there is nothing a comparison could be about - and
        // answering a zero-width window instead would colour every delta
        // against a previous of nought.
        it("answers no comparison at all for a range that has not begun", async () => {
            const now = new Date();
            const from = day(new Date(now.getTime() + 2 * MS_PER_DAY));
            const to = day(new Date(now.getTime() + 3 * MS_PER_DAY));

            const {status, body} = await statistics(
                `from=${from}&to=${to}&tz=Etc/UTC&compare=previous`);

            assert.equal(status, 200);
            assert.equal(body.previous, null);
            assert.equal(body.dateRange.elapsedDays, undefined);
        });
    });

    /**
     * The elapsed-share divisor at its edges, with the clock injected - the
     * route reads its own clock, so the API cannot hold a request still at
     * ninety minutes past midnight.
     *
     * Two edges, both about the same constant: the below-a-tenth promise used
     * to be broken by the rounding itself (0.06 rounds UP to the 0.1 the gate
     * then accepts), and one decimal made the divisor coarser than the rate it
     * divides - 0.149 elapsed days went out as 0.1, and every per-day figure
     * read half again its true rate.
     */
    describe("the elapsed share of a still-running range", () => {
        const MS_PER_DAY = 24 * 60 * 60 * 1000;
        let controller;
        let parseDateRange;

        before(async () => {
            controller = await import("../../server/controller/speedtests.js");
            ({parseDateRange} = await import("../../server/util/dateRange.js"));
        });

        const range = () => parseDateRange("2026-08-10", "2026-08-16", "Etc/UTC");
        const afterStart = (days) => new Date(range().from.getTime() + days * MS_PER_DAY);

        it("is withheld below a tenth of a day, not rounded up into one", async () => {
            const {dateRange} = await controller.listStatistics(range(), {now: afterStart(0.06)});

            assert.equal(dateRange.elapsedDays, undefined,
                "six percent of a day was rounded up into the tenth the gate then accepts");
        });

        it("is no coarser than the rate it divides", async () => {
            const {dateRange} = await controller.listStatistics(range(), {now: afterStart(0.149)});

            assert.equal(dateRange.elapsedDays, 0.15,
                "0.149 elapsed days went out as 0.1 - half again the true rate");
        });

        it("still reads naturally at the scale the description shows", async () => {
            const {dateRange} = await controller.listStatistics(range(), {now: afterStart(6.5)});

            assert.equal(dateRange.elapsedDays, 6.5);
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
