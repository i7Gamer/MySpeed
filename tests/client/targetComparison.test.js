import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

const read = (file) => fs.readFileSync(path.join(ROOT, "client", "src", file), "utf8");

const statistics = read("pages/Statistics/Statistics.jsx");
const card = read("pages/Statistics/charts/TargetCompareChart/TargetCompareChart.jsx");
const table = read("pages/Statistics/charts/TargetCompareChart/TargetCompareTable.jsx");
const cardStyles = read("pages/Statistics/charts/TargetCompareChart/styles.sass");
const english = JSON.parse(fs.readFileSync(
    path.join(ROOT, "client", "public", "assets", "locales", "en.json"), "utf8"));

/*
 * The compare effect's own text, sliced by its whole opening gate rather than
 * by a prefix of it: `if (targetFilter != null` alone also opens the page's own
 * request two hundred lines above, so a lift anchored there answered for that
 * one instead - and passed, because the page's fetch legitimately holds both of
 * the things this file asserts the compare fetch must not.
 */
const COMPARE_GATE = "if (targetFilter != null || targets.length < 2 || compareFresh) return;";
const COMPARE_DEPS = "}, [targetFilter, targets, dateRange, compare, compareKey, compareFresh]);";

const compareEffect = () => {
    const opens = statistics.indexOf(COMPARE_GATE);
    const closes = statistics.indexOf(COMPARE_DEPS);

    assert.notEqual(opens, -1, "the compare effect's gate changed; re-anchor this lift");
    assert.notEqual(closes, -1,
        "the compare effect's dependency list changed, so this lift slices to the end of the file "
        + "and asks its question of the whole page - re-anchor it");

    return statistics.slice(opens, closes);
};

/**
 * The comparison's wiring, held as source: node cannot parse JSX, and the
 * executable half - the summaries, the merged timeline, the series and the
 * colour cycle - has its own executed matrix in targetCompare.test.js.
 *
 * What these pin is the glue. One request rather than N, which is what makes
 * the figures affordable to draw without asking; the two gates in front of it;
 * the separate generation ref; the fresh-key gate in front of every render;
 * and the nearest-mode tooltip that replaced the shared options' index-mode
 * assumptions.
 */
describe("the comparison panels on the statistics page", () => {
    /**
     * Two gates, and they are different questions. One target has nothing to
     * compare - the chips' own gate. A chip narrows the page to a single
     * target, at which point every panel above is about that one, and a
     * comparison of all of them here is the only thing on screen contradicting
     * the filter the reader just set.
     */
    it("draws them only with two targets to compare, and only unnarrowed", () => {
        assert.match(statistics, /\{targets\.length >= 2 && targetFilter == null && \(/,
            "a single-target instance grew a comparison of one, or a chip no longer hides it");
    });

    /**
     * One request, not one per target - which is what pays for drawing the
     * figures without being asked twice.
     *
     * The statistics family is rate limited to a fixed window because each
     * request there costs a full range scan, and asking per target made the
     * page's cost scale with how many targets an operator keeps: at three, a
     * reader stepping through the timeframe presets reached the ceiling on
     * their own, and a 429 there blanks the whole page. That is what forced
     * the old card to wait for a click before it drew anything.
     */
    it("asks once for every target rather than once per target", () => {
        assert.match(statistics, /query\.set\("targets", targets\.map\(\(\{id}\) => id\)\.join\(","\)\)/,
            "the comparison stopped batching, so its cost scales with the target count again");
        assert.doesNotMatch(compareEffect(), /Promise\.allSettled/,
            "the per-target fan-out is back");
    });

    it("fetches as soon as there is something to compare, without waiting for a click", () => {
        assert.match(statistics, new RegExp(COMPARE_GATE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
            "the fetch grew a gate on the open panel again, so the figures are hidden until asked for");
    });

    /**
     * Its own generation counter. Bumping updateStats' shared ref from here
     * makes a page request already in flight fail its isCurrent() check and
     * return before setLoading(false) - a page that spins forever because
     * somebody changed the range during a slow load.
     */
    it("guards staleness with its own generation, never the page's", () => {
        const effect = compareEffect();

        assert.match(effect, /compareGeneration\.current/,
            "the compare fetch has no stale-response guard at all");
        assert.doesNotMatch(effect, /requestGeneration/,
            "the compare fetch bumps the page's own generation - the forever-spinner the review named");
    });

    /**
     * A target the answer left out is the null the table names "couldn't
     * load", and so is the whole request failing - said for every target at
     * once rather than leaving four panels spinning on a promise that already
     * rejected. The per-target fan-out got this from allSettled; one request
     * has to state it.
     */
    it("names a missing target and a failed request the same way", () => {
        const effect = compareEffect();

        assert.match(effect, /byTarget\[id] \?\? byTarget\[String\(id\)] \?\? null/,
            "a target the server left out lands as undefined, which is neither a figure nor a failure");
        assert.match(effect, /\.catch\(\(error\) => \{/,
            "a rejected request leaves every panel on its loading line forever");
    });

    /**
     * The key is values, not identities: dateRange is a fresh object on every
     * unrelated URL change and the targets array is replaced by a cosmetic
     * reload. The query the request carries, the aimed node and the id list
     * are what a cached answer must match.
     */
    it("keys the cache by the query it actually sent", () => {
        assert.match(statistics, /\[String\(rangeQuery\(dateRange\)\), String\(currentNode \?\? ""\),\s*targets\.map\(\(\{id}\) => id\)\.join\(","\)/,
            "the cache key drifted from the request's own values");
        // The comparison offset too: the rows' deltas are read against it, so
        // an answer cached under one offset is the wrong answer under the
        // next - and the control that changes it sits beside these panels.
        assert.match(statistics, /\.join\("\|"\), \[dateRange, currentNode, targets, compare]\)/,
            "a compare change beside an open panel serves the previous offset's deltas");
    });

    /**
     * Every render site hands the payloads over only while the cache answers
     * for the shown key: a stale byId is the previous range's series wearing
     * this range's heading - the fault the page's own stale guard exists for,
     * and the Back button reaches it with a panel open.
     *
     * Resolved once rather than at each site. Four panels and two modal cases
     * each spelling the gate for themselves is six places for one of them to
     * forget it, which is how a gate written six times goes wrong.
     */
    it("hands the panels a payload only while the key still matches", () => {
        assert.match(statistics, /const compareStatsById = compareFresh \? compareStats\.byId : null;/,
            "the fresh-key gate is no longer resolved in one place");
        assert.doesNotMatch(statistics, /statsById=\{compareFresh \?/,
            "a render site spells the gate for itself instead of reading the resolved one");
    });

    // The modal is plain state and would outlive either gate: deleting targets
    // down to one left it standing over nothing, and pressing a chip under an
    // open panel left a comparison of every target over a page showing one.
    it("closes the panel when either gate closes under it", () => {
        assert.match(statistics,
            /if \(\(targets\.length < 2 \|\| targetFilter != null\) && TARGET_PANELS\.includes\(expandedChart\)\)/);
    });

    /**
     * The three overlays are charts and take the charts' treatment; the table
     * beside them is a grid and takes the wide one. They were one panel that
     * was neither, which is why it had a plot with a height nothing else on
     * the page needed.
     */
    it("gives the overlays the chart treatment and the table the wide one", () => {
        assert.match(statistics,
            /const FULL_HEIGHT_CHARTS = \[\.\.\.LINE_CHARTS, 'hourly', \.\.\.TARGET_COMPARE_CHARTS];/,
            "the overlays lost the full-height treatment, so the plot has no height in the modal");
        assert.match(statistics, /const WIDE_PANELS = \['latest', 'targets'];/,
            "the table lost its width, so it stacks into a 400px column");
    });

    /**
     * The metric is read off the panel's own name rather than written a second
     * time beside it. Three modal cases each naming their metric again is
     * three chances for one to draw the chart next to it.
     */
    it("takes each overlay's metric from the panel it is", () => {
        assert.match(statistics, /const metricOf = \(panel\) => panel\.slice\("targets"\.length\)\.toLowerCase\(\);/);
        assert.match(statistics, /metric=\{metricOf\(chartType\)}/,
            "the modal names its metric independently of the panel that opened it");

        for (const metric of ["ping", "download", "upload"])
            assert.match(statistics, new RegExp(`metric="${metric}"`),
                `no panel draws ${metric}`);
    });
});

describe("the overlay chart", () => {
    /**
     * The shared options assume every dataset reads one label array - index
     * mode resolves one index and takes it from EVERY series, and these
     * series each keep their own instants. Nearest is the honest answer, and
     * the axis is stated so a later default added to the shared builder
     * cannot silently retarget this chart.
     */
    it("interacts by nearest point, axis stated", () => {
        assert.match(card, /options\.interaction = \{mode: "nearest", axis: "xy", intersect: false\};/);
    });

    it("titles the tooltip from the point's own instant", () => {
        assert.match(card, /new Date\(items\[0\]\.parsed\.x\)/,
            "the tooltip title indexes a shared label array that names another series' instant");
    });

    // A TARGET may be named exactly what the failed-test dataset is called -
    // operator free text - and must be neither reprinted as a failure nor
    // hidden from the legend.
    it("carries no failed-test branch and no legend filter", () => {
        assert.doesNotMatch(card, /statistics\.failed_test/,
            "a target named like the failure dataset has its readings reprinted as failures");
        assert.match(card, /filter: undefined/,
            "the stock legend filter hides a target wearing the failure dataset's name");
    });

    /**
     * The two density knobs read different inputs on purpose: marker size is
     * how many points are DRAWN on the whole canvas, tension is one line's
     * own spacing. One count for both drew the same data two ways depending
     * on how many neighbours it had.
     */
    it("sizes markers by the drawn total and tension by the longest series", () => {
        assert.match(card, /pointStyleFor\(drawnPoints/,
            "marker density no longer follows the total the canvas actually draws");
        assert.match(card, /lineTensionFor\(longestSeries/,
            "tension no longer follows one line's own spacing");
    });

    it("colours a line from the same token as its chip dot", () => {
        assert.match(card, /themeColors\[targetSeriesToken\(one\.colourIndex\)\]/,
            "the canvas colour left the cycle the dots draw from");
    });

    it("draws lines only - no fills to bury each other under", () => {
        assert.match(card, /backgroundColor: "transparent",\s*fill: false/);
    });

    /**
     * And it is one of the page's charts rather than a card of its own kind:
     * the same container, header and body the ping and speed charts use, which
     * is what makes the six size, scroll and expand identically instead of
     * nearly so.
     */
    it("draws in the same container as the charts it sits beside", () => {
        assert.match(card, /className="chart-container target-compare-chart"/,
            "the overlay went back to a container of its own, which sizes unlike the row it joins");
        assert.match(card, /import "@\/pages\/Statistics\/charts\/SpeedChart\/styles\.sass";/,
            "the shared chart container is never imported, so the class resolves to nothing on its own");
        assert.doesNotMatch(card, /SegmentedControl/,
            "the metric switcher is back, so two thirds of the comparison is behind a click again");
    });

    // Every state says which metric it is about. A card that has not decided
    // what it is yet cannot be found by somebody looking for one of the three.
    it("names its metric while loading and while empty", () => {
        const heading = card.slice(card.indexOf('className="chart-header"'));

        assert.match(heading, /t\(METRIC_TITLES\[metric]\)/,
            "the heading no longer names the metric this instance draws");
        assert.match(card, /if \(!fresh\) return <p className="target-compare-hint">/,
            "the loading line replaces the whole chart, heading and all");
    });
});

describe("the comparison table", () => {
    it("prints every figure through the shared formatters", () => {
        assert.match(table, /formatLatencyWithUnit\(row\.ping, t\("latest\.ping_unit"\)\)/,
            "the latency cell prints the stored decimals raw");
        assert.match(table, /formatPercent\(row\.failureRate\)/,
            "the failure cell glues its % by hand");
        assert.match(table, /formatWithUnit\(\s*expanded \? convertSpeed\(mbps, preferences\) : wholeSpeed\(mbps, preferences\), speedUnit\)/,
            "the speed cells left the value cards' precision rule");
    });

    // A failed fetch is not a line that answered with nothing - it must not
    // wear the honest N/A of an empty range.
    it("says when a target's figures could not be loaded", () => {
        assert.match(table, /row\.unavailable \? \(/);
        assert.match(table, /statistics\.targets\.unavailable/);
    });

    /**
     * The failure rate has no series anywhere, so this panel is the only place
     * it is stated. Living inside one metric's expansion would have hidden it
     * behind a chart that says nothing about it.
     */
    it("stands beside the charts rather than inside one of them", () => {
        assert.match(table, /<StatisticContainer title=\{t\("statistics\.targets\.title"\)} size="wide"/,
            "the table is no longer its own panel");
        assert.match(table, /statistics\.targets\.failure_rate/,
            "the only statement of the failure rate on the page is gone");
    });
});

describe("the panels' stylesheet", () => {
    /**
     * The table is the only content of a full-width panel, so its columns
     * share that width. Without a fixed layout they take their content's width
     * instead, and five columns of short figures drew themselves in the first
     * third of a very wide box with two thirds of it empty beside them.
     */
    it("spreads the table across the panel it fills", () => {
        const rules = cardStyles.slice(cardStyles.indexOf(".target-compare-table"));

        assert.match(rules, /width: 100%/);
        assert.match(rules, /table-layout: fixed/,
            "the columns size to their content again, so the table huddles at the left of a wide panel");
    });

    /**
     * The plot's height comes from the shared .chart-body now. The block that
     * used to state it here was four tiers of min-height for a wrapper only
     * this card had, kept in step with .modal-body-chart's own four by hand.
     */
    it("leaves the plot's height to the container it borrows", () => {
        assert.doesNotMatch(cardStyles, /target-compare-plot/,
            "the private plot wrapper is back, with a second set of height tiers to keep in step");
        assert.doesNotMatch(cardStyles, /\.stats-content/,
            "a height on .stats-content loses to the modal's own reset by import order");
    });

    // Under the figure, not beside it - four nowrap annotations is 240px this
    // table does not have, and AverageChart answered the same question first.
    it("stacks the delta under its figure", () => {
        assert.match(cardStyles, /tbody td \.stat-delta/,
            "the deltas widen every column of the table instead of stacking");
    });
});

describe("the panels' strings", () => {
    it("names the panel and each of its three charts", () => {
        for (const key of ["title", "failure_rate", "empty", "unavailable"])
            assert.equal(typeof english.statistics.targets[key], "string",
                `statistics.targets.${key} is missing`);

        for (const metric of ["ping", "download", "upload"])
            assert.equal(typeof english.statistics.targets.chart[metric], "string",
                `statistics.targets.chart.${metric} is missing`);
    });

    /**
     * And the two the redesign left nothing to render are gone rather than
     * left behind: `metric` labelled the switcher that chose between the three
     * charts, and `open_hint` was the invitation that stood where the figures
     * now are.
     */
    it("keeps no string for the switcher or the invitation", () => {
        for (const key of ["metric", "open_hint"])
            assert.equal(english.statistics.targets[key], undefined,
                `statistics.targets.${key} outlived what rendered it`);
    });
});

/**
 * The deltas beside each target's figures, and the window they are read
 * against. The request asks for each target's OWN previous window, so a row
 * compares against its line a week ago rather than against the page's mixture
 * of every target.
 */
describe("the comparison table's deltas", () => {
    it("asks for the previous window, gated the way the page gates its own", () => {
        assert.match(compareEffect(), /applyCompare\(query, dateRange, compare\);/,
            "the request stopped asking for the window its deltas are read against - "
            + "and it asks through the page's own applier, so the two cannot compare "
            + "against different windows");
    });

    it("annotates every figure, each in its own direction", () => {
        assert.equal((table.match(/<Delta /g) ?? []).length, 4,
            "a figure lost its delta, or grew a second");
        assert.match(table, /previous=\{row\.previous\?\.download\}\s*higherIsBetter=\{true\}/);
        assert.match(table, /previous=\{row\.previous\?\.upload\}\s*higherIsBetter=\{true\}/);
        assert.match(table, /previous=\{row\.previous\?\.ping\}\s*higherIsBetter=\{false\}/,
            "more latency became good news");
        assert.match(table, /previous=\{row\.previous\?\.failureRate\}\s*higherIsBetter=\{false\} mode="absolute" unit="%"/,
            "the failure rate is compared as a percentage of a percentage - 5% to 7% is +2 points, not +40%");
    });

    /**
     * The raw averages on both sides, never the printed ones: a delta taken
     * from speed() would change with the reader's unit preference and differ
     * between the collapsed card and the expanded modal, which is exactly
     * what the shared printer exists to prevent. The accepted edge, stated:
     * two figures that both print "900" can carry an arrow between them.
     */
    it("compares the measurements rather than their printed form", () => {
        assert.doesNotMatch(table, /<Delta current=\{speed\(/,
            "the delta reads the printed figure, so it moves with the unit preference");
        assert.doesNotMatch(table, /<Delta[^/]*current=\{formatLatencyWithUnit/);
        assert.match(table, /<Delta current=\{row\.download\}/);
    });
});
