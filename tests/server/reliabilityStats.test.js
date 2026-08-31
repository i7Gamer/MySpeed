import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildStatistics } from "../../server/util/statistics.js";

const at = (iso, overrides = {}) => ({
    ping: 10, jitter: 2, download: 100, upload: 50, time: 30,
    error: null, created: iso, ...overrides
});

const failedAt = (iso) => at(iso, {error: "timeout", ping: -1, download: -1, upload: -1});

const range = (fromIso, toIso) => ({from: new Date(fromIso), to: new Date(toIso)});

const DAY = range("2026-08-07T00:00:00.000Z", "2026-08-07T23:59:59.999Z");

const reliabilityOf = (entries) => buildStatistics(entries, DAY).reliability;

/**
 * The two findings the failed-count never states: how bad an outage was when
 * it came - failures in a ROW, not spread singles - and how long the
 * scheduler itself went dark. Both walk the placeable timeline buildStatistics
 * already sorts: a streak and a gap are claims about consecutive INSTANTS, so
 * a row whose created nothing can parse counts in the totals but can sit in
 * neither. The gap deliberately counts failed rows as presence - a failed
 * test still proves the scheduler ran, and the gap exists to find the hours
 * nothing ran at all.
 */
describe("the reliability block", () => {
    it("answers all-null for an empty range, and the block always rides", () => {
        assert.deepEqual(reliabilityOf([]), {
            longestFailureStreak: null,
            lastFailureAt: null,
            largestGap: null
        });
    });

    describe("the longest failure streak", () => {
        it("is null when nothing failed", () => {
            const {longestFailureStreak, lastFailureAt} = reliabilityOf([
                at("2026-08-07T01:00:00.000Z"), at("2026-08-07T02:00:00.000Z")
            ]);

            assert.equal(longestFailureStreak, null);
            assert.equal(lastFailureAt, null);
        });

        it("counts a lone failure as a streak of one, both ends on it", () => {
            const {longestFailureStreak} = reliabilityOf([
                at("2026-08-07T01:00:00.000Z"),
                failedAt("2026-08-07T02:00:00.000Z"),
                at("2026-08-07T03:00:00.000Z")
            ]);

            assert.deepEqual(longestFailureStreak,
                {count: 1, from: "2026-08-07T02:00:00.000Z", to: "2026-08-07T02:00:00.000Z"});
        });

        it("keeps the longest run when several compete, with its own ends", () => {
            const {longestFailureStreak} = reliabilityOf([
                failedAt("2026-08-07T01:00:00.000Z"),
                failedAt("2026-08-07T02:00:00.000Z"),
                at("2026-08-07T03:00:00.000Z"),
                failedAt("2026-08-07T04:00:00.000Z"),
                failedAt("2026-08-07T05:00:00.000Z"),
                failedAt("2026-08-07T06:00:00.000Z"),
                at("2026-08-07T07:00:00.000Z")
            ]);

            assert.deepEqual(longestFailureStreak,
                {count: 3, from: "2026-08-07T04:00:00.000Z", to: "2026-08-07T06:00:00.000Z"});
        });

        it("counts a run still standing at the range's end", () => {
            const {longestFailureStreak} = reliabilityOf([
                at("2026-08-07T01:00:00.000Z"),
                failedAt("2026-08-07T02:00:00.000Z"),
                failedAt("2026-08-07T03:00:00.000Z")
            ]);

            assert.equal(longestFailureStreak.count, 2);
            assert.equal(longestFailureStreak.to, "2026-08-07T03:00:00.000Z");
        });

        // Ties keep the first run - the earlier outage is the one the range
        // met first, and flapping between equals redraws nothing.
        it("keeps the first of two equal runs", () => {
            const {longestFailureStreak} = reliabilityOf([
                failedAt("2026-08-07T01:00:00.000Z"),
                failedAt("2026-08-07T02:00:00.000Z"),
                at("2026-08-07T03:00:00.000Z"),
                failedAt("2026-08-07T04:00:00.000Z"),
                failedAt("2026-08-07T05:00:00.000Z")
            ]);

            assert.equal(longestFailureStreak.from, "2026-08-07T01:00:00.000Z");
        });

        it("orders the walk by time, not by arrival", () => {
            const {longestFailureStreak} = reliabilityOf([
                failedAt("2026-08-07T05:00:00.000Z"),
                at("2026-08-07T03:00:00.000Z"),
                failedAt("2026-08-07T04:00:00.000Z"),
                at("2026-08-07T01:00:00.000Z")
            ]);

            assert.deepEqual(longestFailureStreak,
                {count: 2, from: "2026-08-07T04:00:00.000Z", to: "2026-08-07T05:00:00.000Z"},
                "an unsorted batch split the run the timeline holds together");
        });

        it("names the newest failure whatever streak it sits in", () => {
            const {lastFailureAt} = reliabilityOf([
                failedAt("2026-08-07T01:00:00.000Z"),
                failedAt("2026-08-07T02:00:00.000Z"),
                at("2026-08-07T03:00:00.000Z"),
                failedAt("2026-08-07T04:00:00.000Z"),
                at("2026-08-07T05:00:00.000Z")
            ]);

            assert.equal(lastFailureAt, "2026-08-07T04:00:00.000Z",
                "the newest failure lost to the longest streak's end");
        });
    });

    describe("the largest gap between tests", () => {
        it("is null with fewer than two placeable rows", () => {
            assert.equal(reliabilityOf([at("2026-08-07T01:00:00.000Z")]).largestGap, null);
        });

        it("names the widest hole and its two ends", () => {
            const {largestGap} = reliabilityOf([
                at("2026-08-07T01:00:00.000Z"),
                at("2026-08-07T02:00:00.000Z"),
                at("2026-08-07T05:00:00.000Z")
            ]);

            assert.deepEqual(largestGap, {seconds: 10800,
                from: "2026-08-07T02:00:00.000Z", to: "2026-08-07T05:00:00.000Z"});
        });

        // A failed test still proves the scheduler ran: the gap exists to
        // find the hours nothing ran at all, and a failure in the middle of
        // a hole splits it.
        it("counts a failed test as presence", () => {
            const {largestGap} = reliabilityOf([
                at("2026-08-07T01:00:00.000Z"),
                failedAt("2026-08-07T04:00:00.000Z"),
                at("2026-08-07T06:00:00.000Z")
            ]);

            assert.equal(largestGap.seconds, 10800,
                "the failure inside the hole did not split it");
            assert.equal(largestGap.from, "2026-08-07T01:00:00.000Z");
        });

        it("keeps the first of two equal holes", () => {
            const {largestGap} = reliabilityOf([
                at("2026-08-07T01:00:00.000Z"),
                at("2026-08-07T03:00:00.000Z"),
                at("2026-08-07T05:00:00.000Z")
            ]);

            assert.equal(largestGap.from, "2026-08-07T01:00:00.000Z");
        });
    });

    // Counted in the totals, in neither finding: a streak and a gap are
    // claims about consecutive instants, and these rows sit on none.
    it("leaves rows without a readable instant out of both walks", () => {
        const stats = buildStatistics([
            at("2026-08-07T01:00:00.000Z"),
            failedAt("not a date"),
            at("2026-08-07T02:00:00.000Z")
        ], DAY);

        assert.equal(stats.tests.failed, 1, "the undateable failure left the totals too");
        assert.equal(stats.reliability.longestFailureStreak, null,
            "a failure on no instant formed a streak");
        assert.equal(stats.reliability.largestGap.seconds, 3600);
    });
});
