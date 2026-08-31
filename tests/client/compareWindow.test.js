import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource, withoutJsComments } from "../helpers/source.js";
import {
    compareToParams, formatDateParam, parseCompareParams, rangeKey
} from "@/common/utils/TimeframeUtil.js";

const params = (query) => new URLSearchParams(query);

/**
 * The window the statistics compare against, when the reader names one
 * instead of taking the period immediately before.
 *
 * It travels in the URL like the range does, so "this August against last
 * August" is a link somebody can keep - and it is deliberately NOT one of the
 * range parameters, for the reason rangeKey's own note gives: that list is
 * what the overview's provider re-fetches a page of rows on, and a comparison
 * window changes which deltas the statistics draw and nothing at all about
 * which tests any list holds.
 */
describe("parseCompareParams", () => {
    it("reads the pair the URL carries", () => {
        const window = parseCompareParams(params("compareFrom=2025-08-01&compareTo=2025-08-31"));

        assert.equal(formatDateParam(window.from), "2025-08-01");
        assert.equal(formatDateParam(window.to), "2025-08-31");
    });

    // Half a pair is a window nobody named - the same ruling the route makes
    // on the wire, kept here so the page never sends one.
    it("names nothing for half a pair, or none of it", () => {
        for (const query of ["compareFrom=2025-08-01", "compareTo=2025-08-31", "", "range=7d"])
            assert.equal(parseCompareParams(params(query)), null, `"${query}" produced a window`);
    });

    // A hand-edited bookmark names a window either way round; the range
    // parser's own rule, applied to the same kind of pair.
    it("swaps a pair somebody typed backwards", () => {
        const window = parseCompareParams(params("compareFrom=2025-08-31&compareTo=2025-08-01"));

        assert.equal(formatDateParam(window.from), "2025-08-01");
        assert.equal(formatDateParam(window.to), "2025-08-31");
    });

    it("refuses a date that is not a date", () => {
        for (const query of ["compareFrom=2025-02-30&compareTo=2025-03-05",
            "compareFrom=2025-08-01&compareTo=not-a-date", "compareFrom=20250801&compareTo=20250831"])
            assert.equal(parseCompareParams(params(query)), null, `"${query}" parsed as a window`);
    });
});

describe("compareToParams", () => {
    it("writes the pair back", () => {
        assert.deepEqual(compareToParams({from: new Date(2025, 7, 1), to: new Date(2025, 7, 31)}),
            {compareFrom: "2025-08-01", compareTo: "2025-08-31"});
    });

    // Absent, not empty: `?compareFrom=` is a parameter somebody sent, and the
    // route would have to decide what an empty half means.
    it("writes nothing at all for the default", () => {
        assert.deepEqual(compareToParams(null), {});
        assert.deepEqual(compareToParams(undefined), {});
    });

    it("survives the round trip", () => {
        const window = {from: new Date(2025, 0, 5), to: new Date(2025, 1, 3)};
        const read = parseCompareParams(params(new URLSearchParams(compareToParams(window)).toString()));

        assert.equal(formatDateParam(read.from), formatDateParam(window.from));
        assert.equal(formatDateParam(read.to), formatDateParam(window.to));
    });
});

/**
 * The pin this whole shape exists for: SpeedtestProvider is mounted above the
 * router outlet, so it is alive on every page, and it rebuilds its query -
 * fetching a page of rows the statistics never show - whenever rangeKey
 * changes. A comparison window in that key would buy that page of rows on
 * every compare change.
 */
describe("the comparison window stays out of the range key", () => {
    it("changes nothing about which tests a list holds", () => {
        assert.equal(rangeKey(params("range=7d&compareFrom=2025-08-01&compareTo=2025-08-31")),
            "range=7d",
            "the comparison window reached the range key, so choosing one re-fetches a page of rows");
    });

    it("still answers for the range itself", () => {
        assert.equal(rangeKey(params("from=2026-08-01&to=2026-08-31&compareFrom=2025-08-01")),
            "from=2026-08-01&to=2026-08-31");
    });
});

/**
 * The page's own side of it: which requests carry the window, which
 * deliberately do not, and the row that lets a reader choose one.
 */
describe("the statistics page and its comparison window", () => {
    const statistics = readSource("client/src/pages/Statistics/Statistics.jsx");

    // One applier for both request sites, so the page and the comparison card
    // cannot ask different questions of the same window.
    it("asks the same question from one place", () => {
        assert.match(statistics, /const applyCompare = \(query, dateRange, compareWindow\) => \{/);
        assert.match(statistics, /if \(!dateRange\) return query;/,
            "the applier stopped refusing a rangeless request - nothing precedes all time");
        assert.equal((statistics.match(/applyCompare\(query, dateRange, compareWindow\)/g) ?? []).length, 2,
            "the page and the card no longer read the window through one applier");
    });

    /**
     * The high-resolution series is fetched to draw more points, and a
     * comparison there would be a second table scan for a payload nothing
     * reads.
     */
    it("never compares the detail series", () => {
        const detail = statistics.slice(statistics.indexOf('query.set("points"'),
            statistics.indexOf("}, [wantsDetail, isDownsampled, dateRange, targetFilter, currentNode]);"));

        assert.notEqual(detail.length, 0, "the detail effect moved; re-anchor this lift");
        assert.doesNotMatch(detail, /applyCompare|compare/,
            "the detail fetch buys a comparison nothing on screen reads");
    });

    // The control that CHOOSES the window lives in the row, so gating the row
    // on there being something to compare would lock a young instance out.
    it("draws the row for any bounded range", () => {
        assert.match(statistics, /\{dateRange && \(\s*<div className="statistics-compare-row">/);
    });

    /**
     * No presets on the comparison picker: "last 7 days" as a comparison
     * window is a window that moves under the bookmark naming it - and
     * omitting onTimeframeChange is what suppresses the list.
     */
    it("offers no presets, and names itself for the second picker it is", () => {
        // Read without the comments: the note above the picker NAMES the
        // prop it leaves off, and a pin that reads prose is satisfied by
        // prose.
        const row = withoutJsComments(statistics.slice(
            statistics.indexOf('<div className="statistics-compare-row">'),
            statistics.indexOf("</div>", statistics.indexOf('statistics-compare-reset'))));

        assert.doesNotMatch(row, /onTimeframeChange/,
            "the comparison picker offers presets, which name a window that moves");
        assert.match(row, /label=\{t\("statistics\.compare\.picker_label"\)\}/,
            "two pickers on one page, and this one answers to a pair of dates like the other");
    });
});
