import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource, withoutJsComments } from "../helpers/source.js";
import { compile, rules } from "../helpers/sass.mjs";
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
        assert.match(statistics,
            /const compareRow = dateRange \? \(\s*<div className="statistics-compare-row">/);
    });

    /**
     * And the row reaches the page by being handed to the toolbar, not by
     * being drawn under it.
     *
     * Two assertions rather than one, because the failure is silent in both
     * directions: a row built and never passed renders nothing at all, and a
     * row passed while also drawn below would render twice - two comparison
     * pickers on one page, both live, disagreeing about the window.
     */
    it("hands the row to the toolbar rather than drawing it below", () => {
        const body = withoutJsComments(statistics);

        assert.match(body, /aside=\{compareRow}/,
            "the comparison row is built and never given to anything");
        assert.equal(body.match(/<div className="statistics-compare-row">/g)?.length, 1,
            "the comparison row is rendered from more than one place");
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

/**
 * The row shares the chip line where there is room for it.
 *
 * The comparison row was a full-width block of its own under the chips: two
 * lines spent on a handful of target names and one sentence, on every ordinary
 * width. They share a line now, and separate on their own where they do not
 * fit - which is what flex-wrap means and why nothing here is measured.
 *
 * Read out of the compiled stylesheets rather than a rendered page, the way
 * every layout assertion in this suite's neighbours is: the rule is what
 * decides this, and a jsdom with no layout engine could not tell either way.
 */
describe("the comparison row beside the target chips", () => {
    const toolbar = compile("common/components/PageToolbar/styles.sass");
    const page = compile("pages/Statistics/styles.sass");
    const chips = compile("common/components/TargetChips/styles.sass");

    // The last block written for a selector, which is what the cascade leaves
    // standing at equal specificity.
    const ruleFor = (css, selector) => rules(css)
        .filter((rule) => rule.selector.trim() === selector)
        .map((rule) => rule.body)
        .at(-1) ?? null;

    const value = (rule, property) => {
        const match = new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`).exec(rule ?? "");
        return match === null ? null : match[1].trim();
    };

    it("gives the pair a wrapping row of their own", () => {
        const row = ruleFor(toolbar, ".toolbar-second-row");

        assert.notEqual(row, null, ".toolbar-second-row is not declared");
        assert.equal(value(row, "display"), "flex");
        assert.equal(value(row, "flex-wrap"), "wrap",
            "the aside cannot drop below the chips, so a long one overflows the page");
        assert.equal(value(row, "width"), "100%",
            "the row is content-sized, so the page summary is drawn up beside it");
    });

    /**
     * Both of them have to give up the full width they claim when they stand
     * alone, or the one that keeps it takes the whole line and the other is
     * pushed onto the row this change exists to save.
     */
    it("takes the full width off both of them inside it", () => {
        assert.equal(value(ruleFor(toolbar, ".toolbar-second-row > .target-chips"), "width"), "auto",
            "the chips still claim the whole line, so the aside can never sit beside them");
        assert.notEqual(value(ruleFor(page, ".statistics-compare-row"), "width"), "100%",
            "the comparison row still claims the whole line");
    });

    // And the chips keep their standalone rule, which the overview and every
    // instance with no aside still renders.
    it("leaves the chips their own width where they stand alone", () => {
        assert.equal(value(ruleFor(chips, ".target-chips"), "width"), "100%",
            "the chip row is content-sized on the page that draws it without an aside");
    });
});
