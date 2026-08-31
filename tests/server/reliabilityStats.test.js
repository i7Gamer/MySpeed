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

/**
 * A streak is a claim about one target, and the unfiltered timeline is every
 * target interleaved.
 *
 * The walk read row-adjacency, and on an instance with more than one target no
 * two rows in a row belong to the same line. Both directions were wrong and
 * both were plausible on screen: a NAS that failed every run for a week
 * reported a streak of 1, because a working WAN test sat between each of its
 * failures - and one bad round on four targets reported a streak of 4, which
 * reads as an outage and was four different lines blinking once.
 *
 * The digest is where that mattered most: it is always instance-wide, so its
 * headline outage figure was the one nothing could correct.
 */
describe("the longest failure streak across several targets", () => {
    const tagged = (targetId, entry) => ({...entry, targetId});

    it("does not let another target's success break a streak", () => {
        // The NAS fails at :00, :10 and :20; the WAN succeeds between each.
        const {longestFailureStreak} = reliabilityOf([
            tagged(1, failedAt("2026-08-07T01:00:00.000Z")),
            tagged(2, at("2026-08-07T01:01:00.000Z")),
            tagged(1, failedAt("2026-08-07T01:10:00.000Z")),
            tagged(2, at("2026-08-07T01:11:00.000Z")),
            tagged(1, failedAt("2026-08-07T01:20:00.000Z")),
            tagged(2, at("2026-08-07T01:21:00.000Z"))
        ]);

        assert.equal(longestFailureStreak.count, 3,
            "a target that failed three times running reported a shorter streak");
    });

    it("does not join one bad round across targets into an outage", () => {
        // Four targets, one round, every one of them failing once.
        const {longestFailureStreak} = reliabilityOf([1, 2, 3, 4].map((id) =>
            tagged(id, failedAt(`2026-08-07T02:0${id}:00.000Z`))));

        assert.equal(longestFailureStreak.count, 1,
            "four lines blinking once was reported as an outage of four");
    });

    // The span still names the failing target's own first and last, not the
    // interleaved timeline's.
    it("spans the streak's own instants", () => {
        const {longestFailureStreak} = reliabilityOf([
            tagged(1, failedAt("2026-08-07T01:00:00.000Z")),
            tagged(2, at("2026-08-07T01:05:00.000Z")),
            tagged(1, failedAt("2026-08-07T01:30:00.000Z"))
        ]);

        assert.equal(longestFailureStreak.from, "2026-08-07T01:00:00.000Z");
        assert.equal(longestFailureStreak.to, "2026-08-07T01:30:00.000Z");
    });

    /**
     * A history from before targets existed carries no targetId at all, and a
     * single-target instance carries one value - both are one line, and both
     * have to read exactly as they did.
     */
    it("reads an untagged history as the single line it is", () => {
        const untagged = reliabilityOf([
            failedAt("2026-08-07T01:00:00.000Z"),
            failedAt("2026-08-07T01:10:00.000Z"),
            at("2026-08-07T01:20:00.000Z")
        ]);

        assert.equal(untagged.longestFailureStreak.count, 2);
    });

    /**
     * The gap stays a question about the instance, deliberately.
     *
     * "Nothing ran for six hours" is what it exists to find, and the scheduler
     * runs every target in one round - so the interleaved timeline is the right
     * one to ask, and per-target gaps would report the ordinary spacing between
     * rounds as downtime on every target.
     */
    it("still measures the gap across every target", () => {
        const {largestGap} = reliabilityOf([
            tagged(1, at("2026-08-07T01:00:00.000Z")),
            tagged(2, at("2026-08-07T01:01:00.000Z")),
            tagged(1, at("2026-08-07T07:00:00.000Z"))
        ]);

        assert.equal(largestGap.from, "2026-08-07T01:01:00.000Z",
            "the gap was measured within one target rather than across the round");
    });
});
