import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

const read = (file) => fs.readFileSync(path.join(ROOT, "client", "src", file), "utf8");

const statistics = read("pages/Statistics/Statistics.jsx");
const card = read("pages/Statistics/charts/TargetCompareChart/TargetCompareChart.jsx");
const cardStyles = read("pages/Statistics/charts/TargetCompareChart/styles.sass");
const english = JSON.parse(fs.readFileSync(
    path.join(ROOT, "client", "public", "assets", "locales", "en.json"), "utf8"));

/**
 * The comparison card's wiring, held as source: node cannot parse JSX, and
 * the executable half - the summaries, the merged timeline, the series and
 * the colour cycle - has its own executed matrix in targetCompare.test.js.
 * What these pin is the glue the design review vetoed first drafts of: the
 * lazy fetch against the shared rate budget, the separate generation ref,
 * the fresh-key gate in front of every render, and the nearest-mode tooltip
 * that replaced the shared options' index-mode assumptions.
 */
describe("the comparison card on the statistics page", () => {
    it("renders only with two targets to compare, like the chips", () => {
        assert.match(statistics, /\{targets\.length >= 2 && \(\s*<TargetCompareChart/,
            "a single-target instance grew a comparison of one");
    });

    /**
     * Lazy on purpose: N statistics requests per range change spend the same
     * fixed-window budget the page's own request lives on, and a 429 there
     * blanks the whole page. Nothing is fetched until the card is opened.
     */
    it("fetches nothing until the card is opened", () => {
        assert.match(statistics, /if \(expandedChart !== "targets" \|\| targets\.length < 2 \|\| compareFresh\) return;/,
            "the compare fetch lost its lazy gate, so every range change spends N requests");
    });

    it("asks once per target, narrowed to it", () => {
        assert.match(statistics, /targets\.map\(\(\{id\}\) => \{\s*const query = rangeQuery\(dateRange\);\s*query\.set\("target", String\(id\)\)/,
            "the per-target requests no longer narrow to their target");
    });

    /**
     * Its own generation counter. Bumping updateStats' shared ref from here
     * makes a page request already in flight fail its isCurrent() check and
     * return before setLoading(false) - a page that spins forever because
     * somebody opened a card during a slow load.
     */
    it("guards staleness with its own generation, never the page's", () => {
        const closes = statistics.indexOf("}, [expandedChart, targets, dateRange, compare, compareKey, compareFresh]);");
        assert.notEqual(closes, -1,
            "the compare effect's dependency list changed, so this lift slices to the end of the file "
            + "and asks its question of the whole page - re-anchor it");

        const effect = statistics.slice(statistics.indexOf('if (expandedChart !== "targets"'), closes);
        assert.match(effect, /compareGeneration\.current/,
            "the compare fetch has no stale-response guard at all");
        assert.doesNotMatch(effect, /requestGeneration/,
            "the compare fetch bumps the page's own generation - the forever-spinner the review named");
    });

    /**
     * The key is values, not identities: dateRange is a fresh object on every
     * unrelated URL change and the targets array is replaced by a cosmetic
     * reload. The query the requests carry, the aimed node and the id list
     * are what a cached answer must match.
     */
    it("keys the cache by the query it actually sent", () => {
        assert.match(statistics, /\[String\(rangeQuery\(dateRange\)\), String\(currentNode \?\? ""\),\s*targets\.map\(\(\{id\}\) => id\)\.join\(","\)/,
            "the cache key drifted from the request's own values");
        // The comparison offset too: the rows' deltas are read against it, so
        // an answer cached under one offset is the wrong answer under the
        // next - and the control that changes it sits beside an open card.
        assert.match(statistics, /\.join\("\|"\), \[dateRange, currentNode, targets, compare\]\)/,
            "a compare change under an open card serves the previous offset's deltas");
    });

    /**
     * Both render sites hand the payloads over only while the cache answers
     * for the shown key: a stale byId is the previous range's series wearing
     * this range's heading - the fault the page's own stale guard exists
     * for, and the Back button reaches it with the panel open.
     */
    it("hands the card a payload only while the key still matches", () => {
        const gated = statistics.match(/statsById=\{compareFresh \? compareStats\.byId : null\}/g) ?? [];

        assert.equal(gated.length, 2,
            "a render site reads the cached payloads without the fresh-key gate");
    });

    // The modal is plain state and would outlive the gate: deleting targets
    // down to one with the panel open left it standing over nothing.
    it("closes the panel when the gate closes under it", () => {
        assert.match(statistics, /if \(targets\.length < 2 && expandedChart === "targets"\) setExpandedChart\(null\);/);
    });

    it("joins the wide panels, not the full-height charts", () => {
        assert.match(statistics, /const WIDE_PANELS = \['latest', 'targets'\];/,
            "the panel lost its width, so the table stacks into a 400px column");
        assert.doesNotMatch(statistics, /FULL_HEIGHT_CHARTS = \[[^\]]*'targets'/,
            "the full-height treatment keys on .chart-container, which this card does not render");
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
});

describe("the comparison table", () => {
    it("prints every figure through the shared formatters", () => {
        assert.match(card, /formatLatencyWithUnit\(row\.ping, t\("latest\.ping_unit"\)\)/,
            "the latency cell prints the stored decimals raw");
        assert.match(card, /formatPercent\(row\.failureRate\)/,
            "the failure cell glues its % by hand");
        assert.match(card, /formatWithUnit\(\s*expanded \? convertSpeed\(mbps, preferences\) : wholeSpeed\(mbps, preferences\), speedUnit\)/,
            "the speed cells left the value cards' precision rule");
    });

    // A failed fetch is not a line that answered with nothing - it must not
    // wear the honest N/A of an empty range.
    it("says when a target's figures could not be loaded", () => {
        assert.match(card, /row\.unavailable \? \(/);
        assert.match(card, /statistics\.targets\.unavailable/);
    });
});

describe("the card's stylesheet", () => {
    // The modal resets every height above the plot, so the height lives on
    // the plot's own wrapper - stated on .chart-modal-body's side, never on
    // .stats-content, whose reset wins by import order.
    it("gives the plot its height inside the modal, at all four tiers", () => {
        // The comment above the block names both selectors in prose; the
        // block itself is the last time the modal selector appears.
        const modal = cardStyles.slice(cardStyles.lastIndexOf(".chart-modal-body"));

        assert.notEqual(modal.length, 0, "the modal block is gone");
        assert.match(modal, /min-height: min\(60vh, 400px\)/);
        assert.match(modal, /min-height: min\(64vh, 620px\)/,
            "the tall tier is missing - the desktop reader keeps the 400px plot");
        assert.match(modal, /min-height: min\(40vh, 250px\)/);
        assert.match(modal, /min-height: min\(35vh, 220px\)/);
        assert.doesNotMatch(modal, /\.stats-content/,
            "a height on .stats-content loses to the modal's own reset by import order");
    });
});

describe("the card's strings", () => {
    it("has all six of them", () => {
        for (const key of ["title", "failure_rate", "metric", "empty", "open_hint", "unavailable"])
            assert.equal(typeof english.statistics.targets[key], "string",
                `statistics.targets.${key} is missing`);
    });
});

/**
 * The deltas beside each target's figures, and the window they are read
 * against. The card asks for each target's OWN previous window, so a row
 * compares against its line a week ago rather than against the page's
 * mixture of every target.
 */
describe("the comparison table's deltas", () => {
    it("asks for the previous window, gated the way the page gates its own", () => {
        const closes = statistics.indexOf("}, [expandedChart, targets, dateRange, compare, compareKey, compareFresh]);");
        assert.notEqual(closes, -1, "the compare effect moved; re-anchor this lift");

        const effect = statistics.slice(statistics.indexOf('if (expandedChart !== "targets"'), closes);
        assert.match(effect, /applyCompare\(query, dateRange, compare\);/,
            "the card's requests stopped asking for the window its deltas are read against - "
            + "and they ask through the page's own applier, so the two cannot compare "
            + "against different windows");
    });

    it("annotates every figure, each in its own direction", () => {
        assert.equal((card.match(/<Delta /g) ?? []).length, 4,
            "a figure lost its delta, or grew a second");
        assert.match(card, /previous=\{row\.previous\?\.download\}\s*higherIsBetter=\{true\}/);
        assert.match(card, /previous=\{row\.previous\?\.upload\}\s*higherIsBetter=\{true\}/);
        assert.match(card, /previous=\{row\.previous\?\.ping\}\s*higherIsBetter=\{false\}/,
            "more latency became good news");
        assert.match(card, /previous=\{row\.previous\?\.failureRate\}\s*higherIsBetter=\{false\} mode="absolute" unit="%"/,
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
        assert.doesNotMatch(card, /<Delta current=\{speed\(/,
            "the delta reads the printed figure, so it moves with the unit preference");
        assert.doesNotMatch(card, /<Delta[^/]*current=\{formatLatencyWithUnit/);
        assert.match(card, /<Delta current=\{row\.download\}/);
    });

    // Under the figure, not beside it - four nowrap annotations is 240px this
    // table does not have, and AverageChart answered the same question first.
    it("stacks the delta under its figure", () => {
        assert.match(cardStyles, /tbody td \.stat-delta/,
            "the deltas widen every column of the table instead of stacking");
    });
});
