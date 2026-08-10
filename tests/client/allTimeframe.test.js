import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    ALL_TIME_PRESET,
    OVERVIEW_TIMEFRAMES,
    TIMEFRAMES,
    TIMEFRAME_ALL,
    formatDateParam,
    isAllTime,
    resolveAllTime,
    resolveTimeframe
} from "../../client/src/common/utils/TimeframeUtil.js";

// A fixed "now" keeps every expectation deterministic. Local noon avoids any
// chance of the date rolling over under a different machine timezone.
const NOW = new Date(2026, 7, 7, 12, 0, 0);

/**
 * The overview shows every test it has, and its new date picker must be able to
 * say so - otherwise picking "Last 7 days" once is a one-way door out of the
 * full list. "All time" is that way back, and it is the overview's default, so
 * adding the picker changes nothing until a range is actually chosen.
 *
 * It is deliberately not a member of TIMEFRAMES: that list is what the
 * statistics page and the header selector offer, and neither wants an option
 * that means "no range at all".
 */
describe("the all-time timeframe", () => {
    it("is not one of the statistics presets", () => {
        assert.equal(TIMEFRAMES.some(frame => frame.id === TIMEFRAME_ALL), false);
    });

    it("leads the overview's own presets", () => {
        assert.equal(OVERVIEW_TIMEFRAMES[0].id, TIMEFRAME_ALL);
        assert.deepEqual(OVERVIEW_TIMEFRAMES.slice(1), TIMEFRAMES);
    });

    it("reuses a translation key that already ships in the source locale", () => {
        assert.match(ALL_TIME_PRESET.labelKey, /^calendar\./);
    });

    it("recognises itself and nothing else", () => {
        assert.equal(isAllTime(TIMEFRAME_ALL), true);

        for (const frame of TIMEFRAMES) assert.equal(isAllTime(frame.id), false);
        assert.equal(isAllTime(undefined), false);
        assert.equal(isAllTime("custom"), false);
    });

    /**
     * The list simply omits the filter for all-time, but the export endpoint
     * takes a concrete range - so one has to exist. The server refuses any span
     * wider than its own MAX_RANGE_DAYS, which it sets to the largest retention
     * period the config accepts, so a window that wide provably contains every
     * test that can still exist while remaining a legal request.
     */
    describe("resolved as a range for the export", () => {
        it("ends today", () => {
            assert.equal(formatDateParam(resolveAllTime(NOW).to), "2026-08-07");
        });

        it("reaches back far enough to contain anything the server still keeps", () => {
            const {from, to} = resolveAllTime(NOW);
            const days = Math.round((to - from) / (24 * 60 * 60 * 1000));

            assert.ok(days > 365 * 20, `only spans ${days} days`);
        });

        it("stays inside the span the server will accept", () => {
            const {from, to} = resolveAllTime(NOW);
            const days = (to - from) / (24 * 60 * 60 * 1000);

            // server/util/dateRange.js refuses anything above this.
            assert.ok(days <= 10000, `spans ${days} days, which the server refuses`);
        });

        it("starts at the beginning of its first day", () => {
            const {from} = resolveAllTime(NOW);

            assert.equal(from.getHours(), 0);
            assert.equal(from.getMinutes(), 0);
        });
    });

    // resolveTimeframe answers for the statistics presets and falls back to the
    // default for anything it does not know. "All time" is not one of them, and
    // silently becoming "last 7 days" there would filter the overview to a week
    // while the picker still read "All time".
    it("is never silently resolved as a statistics preset", () => {
        const fallback = resolveTimeframe(TIMEFRAME_ALL, NOW);
        const allTime = resolveAllTime(NOW);

        assert.notEqual(formatDateParam(fallback.from), formatDateParam(allTime.from));
    });
});
