import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    ALL_TIME_PRESET,
    PICKER_TIMEFRAMES,
    TIMEFRAMES,
    TIMEFRAME_ALL,
    formatDateParam,
    isAllTime,
    parseRangeParams,
    resolveAllTime,
    resolveTimeframe,
    selectionOf,
    serializeRange,
    shownRange
} from "../../client/src/common/utils/TimeframeUtil.js";

// A fixed "now" keeps every expectation deterministic. Local noon avoids any
// chance of the date rolling over under a different machine timezone.
const NOW = new Date(2026, 7, 7, 12, 0, 0);

/**
 * Both pages of test data can show every test they have, and their picker must
 * be able to say so - otherwise picking "Last 7 days" once is a one-way door out
 * of the full history.
 *
 * It is deliberately not a member of TIMEFRAMES: that list is what the range
 * arithmetic answers for, and "no range at all" has no span to resolve.
 */
describe("the all-time timeframe", () => {
    it("is not one of the bounded presets", () => {
        assert.equal(TIMEFRAMES.some(frame => frame.id === TIMEFRAME_ALL), false);
    });

    it("leads the presets the picker offers", () => {
        assert.equal(PICKER_TIMEFRAMES[0].id, TIMEFRAME_ALL);
        assert.deepEqual(PICKER_TIMEFRAMES.slice(1), TIMEFRAMES);
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

    // resolveTimeframe answers for the bounded presets and falls back to the
    // default for anything it does not know. "All time" is not one of them, and
    // silently becoming "last 7 days" there would filter a page to a week while
    // the picker still read "All time".
    it("is never silently resolved as a bounded preset", () => {
        const fallback = resolveTimeframe(TIMEFRAME_ALL, NOW);
        const allTime = resolveAllTime(NOW);

        assert.notEqual(formatDateParam(fallback.from), formatDateParam(allTime.from));
    });
});

/**
 * The statistics keep their selection in the URL so a view stays bookmarkable
 * and shareable, and a bare URL there means the stored preference rather than
 * all time - so all time has to be written down, unlike on the overview where
 * clearing the parameters says it.
 */
describe("all time in the statistics URL", () => {
    it("is written as a named range rather than as two dates", () => {
        assert.deepEqual(serializeRange(TIMEFRAME_ALL), {range: TIMEFRAME_ALL});
    });

    it("is read back as a selection with no dates at all", () => {
        const selection = parseRangeParams(new URLSearchParams("range=all"), NOW);

        assert.equal(selection.timeframe, TIMEFRAME_ALL);
        assert.equal(selection.from, null);
        assert.equal(selection.to, null);
    });

    it("wins over dates that travel beside it", () => {
        // The request carries a stand-in window for a node too old to know the
        // parameter, and that window must never be read back as the selection.
        const selection = parseRangeParams(
            new URLSearchParams("range=all&from=2026-01-01&to=2026-02-01"), NOW);

        assert.equal(selection.timeframe, TIMEFRAME_ALL);
        assert.equal(selection.from, null);
    });

    it("round-trips", () => {
        const written = new URLSearchParams(serializeRange(TIMEFRAME_ALL));

        assert.equal(parseRangeParams(written, NOW).timeframe, TIMEFRAME_ALL);
    });
});

/**
 * What a stored default means as a selection. The preference is only a preset
 * id, and all time carries no dates - resolving it like a bounded preset would
 * quietly show a week under an "All time" label.
 */
describe("selectionOf", () => {
    it("gives all time no dates", () => {
        assert.deepEqual(selectionOf(TIMEFRAME_ALL, NOW), {timeframe: TIMEFRAME_ALL, from: null, to: null});
    });

    it("resolves a bounded preset to its window", () => {
        const selection = selectionOf("30d", NOW);

        assert.equal(selection.timeframe, "30d");
        assert.equal(formatDateParam(selection.from), "2026-07-09");
        assert.equal(formatDateParam(selection.to), "2026-08-07");
    });
});

/**
 * The window a page of statistics is actually showing, which is what its
 * headings are named after. All time has no window of its own, so the server
 * echoes the extent of the tests themselves - the first to the last.
 */
describe("shownRange", () => {
    const payload = (from, to, days) => ({dateRange: {from, to, days}});

    it("is the selection itself when one is bounded", () => {
        const selected = {from: new Date(2026, 0, 1), to: new Date(2026, 0, 31)};
        const range = shownRange(selected, payload("2020-01-01T00:00:00.000Z", "2026-08-07T00:00:00.000Z"), NOW);

        assert.equal(range.from, selected.from);
        assert.equal(range.to, selected.to);
    });

    it("is the extent the server echoed when the selection is all time", () => {
        const range = shownRange(null, payload("2025-03-04T10:00:00.000Z", "2026-08-07T09:00:00.000Z"), NOW);

        assert.equal(range.from.toISOString(), "2025-03-04T10:00:00.000Z");
        assert.equal(range.to.toISOString(), "2026-08-07T09:00:00.000Z");
    });

    /**
     * The window's length rides with its bounds, so a page dividing by it
     * cannot disagree with the dates in the heading above. The server counts it
     * over the window it actually answered for, which for all time is the
     * extent of the tests and not the stand-in window that was sent.
     */
    describe("the day count", () => {
        it("carries the count the server sent, for a bounded selection", () => {
            const selected = {from: new Date(2026, 0, 1), to: new Date(2026, 0, 31)};

            assert.equal(shownRange(selected, payload("2026-01-01", "2026-01-31", 31), NOW).days, 31);
        });

        it("carries it for all time too", () => {
            assert.equal(shownRange(null, payload("2025-03-04T10:00:00.000Z", "2026-08-07T09:00:00.000Z", 522),
                NOW).days, 522);
        });

        /**
         * A bounded selection knows its own length, so it does not need the
         * echo. Its two bounds are local midnights and the range covers the
         * whole of both days, which is one more day than the span between them
         * - OverviewChart's fallback took `Math.ceil(span)` and reported a
         * seven-day selection as six, overstating tests-per-day by 16.7% under
         * a heading naming seven days. It is DST-sensitive the same way: six
         * across spring-forward, seven across fall-back.
         */
        it("derives an inclusive count from a bounded selection when the server sent none", () => {
            const selected = {from: new Date(2026, 7, 1), to: new Date(2026, 7, 7)};

            assert.equal(shownRange(selected, payload("2026-08-01", "2026-08-07"), NOW).days, 7);
        });

        it("counts a single day as one", () => {
            const selected = {from: new Date(2026, 7, 7), to: new Date(2026, 7, 7)};

            assert.equal(shownRange(selected, undefined, NOW).days, 1);
        });

        it("counts the same either side of a daylight saving change", () => {
            // 29 March 2026 in a northern-hemisphere zone: one 23-hour day.
            const spring = {from: new Date(2026, 2, 26), to: new Date(2026, 3, 1)};
            // 25 October 2026: one 25-hour day.
            const autumn = {from: new Date(2026, 9, 22), to: new Date(2026, 9, 28)};

            assert.equal(shownRange(spring, undefined, NOW).days, 7);
            assert.equal(shownRange(autumn, undefined, NOW).days, 7);
        });

        it("still prefers the count the server sent", () => {
            const selected = {from: new Date(2026, 7, 1), to: new Date(2026, 7, 7)};

            assert.equal(shownRange(selected, payload("2026-08-01", "2026-08-07", 3), NOW).days, 3);
        });

        // A parent proxies this request to its nodes, and a node running an
        // older version answers without it. Undefined is what the caller checks
        // for; a zero or a NaN would be divided by.
        it("is absent rather than wrong when the server sent none", () => {
            for (const days of [undefined, null, NaN, Infinity, "7"]) {
                const range = shownRange(null, payload("2025-03-04T10:00:00.000Z", "2026-08-07T09:00:00.000Z", days), NOW);

                assert.equal(range.days, undefined, `days ${String(days)}`);
            }
        });
    });

    // A parent proxies these requests to its nodes, and a node running an older
    // version answers without the echo. Falling through to "Invalid Date" would
    // render as the heading of the page.
    it("falls back to the stand-in window when nothing was echoed", () => {
        for (const statistics of [undefined, {}, {dateRange: {}}, {dateRange: {from: "2026-01-01T00:00:00.000Z"}}])
            assert.equal(formatDateParam(shownRange(null, statistics, NOW).to),
                formatDateParam(resolveAllTime(NOW).to));
    });
});
