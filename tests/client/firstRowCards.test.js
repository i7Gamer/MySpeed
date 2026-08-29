import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    formatBytes, formatDuration, formatLatencyWithUnit, formatPercent, NOT_MEASURED
} from "@/common/utils/FormatUtil.js";
import { failureRate, readableFigure } from "@/common/utils/TestUtil.js";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const CLIENT_SRC = path.join(ROOT, "client", "src");

const read = (file) => fs.readFileSync(path.join(CLIENT_SRC, file), "utf8");

const overview = read("pages/Statistics/charts/OverviewChart/OverviewChart.jsx");
const latest = read("pages/Statistics/charts/LatestTestChart/LatestTestChart.jsx");
const consistency = read("pages/Statistics/charts/ConsistencyChart/ConsistencyChart.jsx");
const statistics = read("pages/Statistics/Statistics.jsx");
const english = JSON.parse(fs.readFileSync(
    path.join(ROOT, "client", "public", "assets", "locales", "en.json"), "utf8"));

/**
 * Each of the three cards across the top of the statistics gained a row, and
 * each row states something the page could not say before: how far the line
 * falls at its worst hour, what share of packets the last test lost, and how
 * much a single test's pings varied.
 */
describe("the peak-hour row on the overview card", () => {
    it("is computed rather than restated in the component", () => {
        assert.match(overview, /import \{peakSlowdown} from "@\/pages\/Statistics\/charts\/peakHours"/);
        assert.match(overview, /const peak = peakSlowdown\(props\.hourlyAverages\)/);
    });

    // A range too thin to say anything about a day has no slowdown, and a row
    // reading "0%" would claim a flat line rather than an unanswerable question.
    it("renders no row at all when the range cannot support it", () => {
        assert.match(overview, /if \(peak\) items\.push\(/);
    });

    it("is fed the hourly buckets by the page, on the card and in the modal", () => {
        const feeds = statistics.match(/hourlyAverages=\{deferredStatistics\.hourlyAverages}/g) ?? [];

        // The card, its modal, and the hourly chart's own two.
        assert.ok(feeds.length >= 4, `only ${feeds.length} components receive the hourly buckets`);
    });

    // The previous window's summary carries no hourly buckets, so there is
    // nothing to compare the slowdown against.
    it("carries no delta", () => {
        assert.match(overview, /value: `\$\{peak\.slowdown}%`,\s*delta: null/);
    });

    it("names both hours on the clock the reader chose", () => {
        assert.match(overview, /formatHour\(peak\.slowestHour, preferences\)/);
        assert.match(overview, /formatHour\(peak\.fastestHour, preferences\)/);
    });

    it("has both of its strings", () => {
        assert.equal(typeof english.statistics.overview.peak_title, "string");
        assert.match(english.statistics.overview.peak_description, /\{\{slowest}}/);
        assert.match(english.statistics.overview.peak_description, /\{\{fastest}}/);
    });
});

describe("the packet-loss row on the overview card", () => {
    /**
     * The average over the range, read through readableFigure like every
     * stored figure. The bare typeof gate it replaces knew neither the
     * placeholder nor the text spelling: a proxied node's -1 printed "-1%"
     * (and NaN printed "NaN%") beside a delta computed from the same
     * non-reading, while an older node's text average was hidden as N/A.
     */
    it("prints the reading through the shared reader", () => {
        assert.match(overview, /const packetLoss = readableFigure\(props\.packetLoss\);/);
        assert.match(overview, /value: formatPercent\(packetLoss\)/,
            "the score is glued to its % by hand again instead of the shared rule");
        assert.doesNotMatch(overview, /typeof props\.packetLoss === "number"/,
            "the bare typeof gate is back, which prints the placeholder and hides the text spelling");
    });

    // One reading for the row: an arrow computed from a value the printer
    // beside it refuses would claim a change in a figure nobody measured.
    it("feeds the delta the same reading", () => {
        assert.match(overview, /delta: \{current: packetLoss, previous: readableFigure\(previous\?\.packetLoss\)/,
            "the delta reads the raw column while the printer reads the coerced one");
    });

    /**
     * The row's wiring, executed off the card's own statements rather than
     * pattern-matched: a revert that respells the reader - `const packetLoss
     * = props.packetLoss;` - satisfies every source regex above while
     * reintroducing the placeholder deltas. formatPercent hides such a
     * revert from the printed VALUE (it re-reads idempotently), so the
     * discriminator is delta.current: null for everything refused, the
     * coerced number for everything read.
     */
    it("builds the row from the coerced reading, delta included", () => {
        const start = overview.indexOf("const rate = failureRate");
        assert.notEqual(start, -1, "the card no longer derives its rows where this lift expects");

        const end = overview.indexOf("];", start);
        assert.notEqual(end, -1, "the items list no longer closes where this lift expects");

        const stub = (key, values) => values === undefined ? key : {key, ...values};

        // Only the names the region reads - a closure that also supplies the
        // old shape's NOT_MEASURED would let a revert to the hand-glued
        // ternary evaluate instead of throwing.
        const lossRow = (packetLoss, previous) => new Function(
            "props", "t", "formatDuration", "formatPercent", "readableFigure", "failureRate",
            "faGaugeHigh", "faCircleExclamation", "faStopwatch", "faLinkSlash",
            `${overview.slice(start, end + 2)}\nreturn items;`)(
            {tests: {total: 10, failed: 1}, time: {avg: 6}, packetLoss, previous}, stub,
            formatDuration, formatPercent, readableFigure, failureRate,
            null, null, null, null)
            .find((item) => item.title === "statistics.overview.packet_loss_title");

        for (const [refused, label] of [[-1, "the placeholder"], ["-1", "its text spelling"],
            ["auto", "junk"], [NaN, "NaN"]]) {
            const item = lossRow(refused);

            assert.equal(item.value, NOT_MEASURED, `${label} printed as a reading`);
            assert.equal(item.delta.current, null,
                `${label} reached the delta, so the arrow claims a change in a figure nobody measured`);
        }

        const zero = lossRow(0);
        assert.equal(zero.value, "0%", "a measured zero is the best reading there is");
        assert.equal(zero.delta.current, 0);

        const text = lossRow("0.5", {packetLoss: "1.5"});
        assert.equal(text.value, "0.5%", "a text reading prints the number it spells");
        assert.equal(text.delta.current, 0.5);
        assert.equal(text.delta.previous, 1.5, "the previous window's figure is not read the same way");
    });

    /**
     * The duration row beside it, held to the same destinations: its
     * formatter was the one that neither coerced nor refused, so a proxied
     * node's -1 printed "-1s" with a green improvement arrow computed from
     * the placeholder - one row above a loss row answering N/A for the
     * identical payload.
     */
    it("builds the duration row from the coerced reading too", () => {
        const start = overview.indexOf("const rate = failureRate");
        const end = overview.indexOf("];", start);
        const stub = (key, values) => values === undefined ? key : {key, ...values};

        const durationRow = (avg, previous) => new Function(
            "props", "t", "formatDuration", "formatPercent", "readableFigure", "failureRate",
            "faGaugeHigh", "faCircleExclamation", "faStopwatch", "faLinkSlash",
            `${overview.slice(start, end + 2)}\nreturn items;`)(
            {tests: {total: 10, failed: 1}, time: {avg}, packetLoss: null, previous}, stub,
            formatDuration, formatPercent, readableFigure, failureRate,
            null, null, null, null)
            .find((item) => item.title === "statistics.overview.average_title");

        for (const [refused, label] of [[-1, "the placeholder"], ["-1", "its text spelling"],
            ["auto", "junk"]]) {
            const item = durationRow(refused, {time: {avg: 6}});

            assert.equal(item.value, NOT_MEASURED, `${label} printed as a duration`);
            assert.equal(item.delta.current, null,
                `${label} reached the delta, so the arrow claims an improvement from a figure nobody measured`);
        }

        const text = durationRow("6", {time: {avg: "-1"}});
        assert.equal(text.value, "6s", "a text duration prints the number it spells");
        assert.equal(text.delta.current, 6);
        assert.equal(text.delta.previous, null, "a refused previous window still feeds the arrow");
    });
});

/**
 * The enlarged view's rows, run off the card's own statements: the ping,
 * duration-spread and data-used gates were the null-only shape the loss row
 * dropped, so a proxied node's placeholder payload rendered "between N/A and
 * N/A" rows whose deltas were computed from -1.
 */
describe("the enlarged overview's rows refuse what no reader can read", () => {
    const lifted = (props) => {
        const start = overview.indexOf("const expandedItems = (props) => {");
        assert.notEqual(start, -1, "the enlarged rows are no longer derived where this lift expects");

        const end = overview.indexOf("\n};", start);
        assert.notEqual(end, -1, "expandedItems no longer closes where this lift expects");

        const stub = (key, values) => values === undefined ? key : {key, ...values};

        return new Function(
            "t", "formatLatencyWithUnit", "formatDuration", "formatBytes", "readableFigure", "testsPerDay",
            "faPingPongPaddleBall", "faHourglassHalf", "faCalendarDay", "faDatabase",
            `${overview.slice(start, end + 3)}\nreturn expandedItems;`)(
            stub, formatLatencyWithUnit, formatDuration, formatBytes, readableFigure, () => null,
            null, null, null, null)(props);
    };

    // Every fixture carries tests: testsPerDay's argument is dereferenced
    // before the stub can decline the row.
    const BASE = {tests: {total: 10}};

    const row = (props, title) => lifted({...BASE, ...props}).find((item) => item.title === title);

    it("hides the latency row for an average nothing can read", () => {
        for (const refused of [-1, "-1", "auto", NaN])
            assert.equal(row({ping: {avg: refused, min: refused, max: refused, median: refused}},
                "latest.ping"), undefined, `an average of ${JSON.stringify(refused)} still drew the row`);
    });

    it("keeps it for a readable average, delta included, in either spelling", () => {
        const item = row({ping: {avg: "23.47", min: 8.91, max: 132.76, median: 22.05},
            previous: {ping: {avg: -1}}}, "latest.ping");

        assert.notEqual(item, undefined);
        assert.equal(item.delta.current, 23.47, "the delta reads the raw column");
        assert.equal(item.delta.previous, null, "a refused previous window still feeds the arrow");
    });

    /**
     * The accepted trade, pinned as decided: the row's existence hangs on
     * the AVERAGE alone, and the sentence's parts refuse individually - a
     * readable average is not hidden because the spread beside it is junk,
     * so a mixed payload renders the value with N/A parts in its caption.
     * The caption is also the row's only statement that the figure is an
     * average over the range, which is why it does not simply vanish.
     */
    it("keeps a readable average even when every spread part refuses", () => {
        const item = row({ping: {avg: 23.47, min: -1, max: -1, median: -1}}, "latest.ping");

        assert.notEqual(item, undefined, "junk beside a readable average hid the row");
        assert.deepEqual(item.description,
            {key: "statistics.overview.ping_description", min: "N/A", max: "N/A", median: "N/A"},
            "a refused spread part printed as a reading inside the sentence");
        assert.equal(item.delta.current, 23.47);
    });

    /**
     * The delta compares the raw averages, not the printed ones -
     * AverageChart's own stated convention: a percentage is the same in
     * either unit, and rounding both sides first reports a change that is
     * an artefact of the one decimal. The accepted edge, pinned: two
     * windows that PRINT the same trimmed figure can still show a small
     * arrow, because the measurement moved even though the display did not.
     */
    it("computes the delta from the measurement, not from its display", () => {
        const item = row({ping: {avg: 23.44, min: 8.91, max: 132.76, median: 22.05},
            previous: {ping: {avg: 23.41}}}, "latest.ping");

        assert.deepEqual({current: item.delta.current, previous: item.delta.previous},
            {current: 23.44, previous: 23.41},
            "both windows print 23.4 ms, and the arrow between them reads the stored change by convention");
    });

    it("hides the duration spread unless both ends read", () => {
        assert.equal(row({time: {min: -1, max: -1}}, "statistics.overview.span_title"), undefined,
            "a placeholder pair printed as a spread");
        assert.equal(row({time: {min: 2, max: "auto"}}, "statistics.overview.span_title"), undefined,
            "a spread with a refused end printed as \"2s – N/A\"");
        assert.notEqual(row({time: {min: "2", max: "9"}}, "statistics.overview.span_title"), undefined,
            "a readable text pair vanished");
    });

    it("hides the data row for a total nothing can read", () => {
        assert.equal(row({dataUsed: {total: -1, download: -1, upload: -1}},
            "test.details.data_used"), undefined, "a placeholder total drew the row");

        const item = row({dataUsed: {total: 3000, download: 2000, upload: 1000},
            previous: {dataUsed: {total: "-1"}}}, "test.details.data_used");
        assert.equal(item.delta.current, 3000);
        assert.equal(item.delta.previous, null);
    });
});

describe("the packet-loss row on the latest-test card", () => {
    // Zero is a measurement and the commonest one, so a truthiness check would
    // hide the row on exactly the tests it has the best news for - and junk
    // is not one, so the gate reads through readableFigure: the row's label
    // prints the stored column raw, and a value the colour beside it grades
    // as never-measured must not print at all. The detail pane gates the same
    // column the same way - one rule, decided by what is CORRECT to show,
    // then applied to both views.
    it("shows a loss of zero rather than hiding it, and junk not at all", () => {
        assert.match(latest, /hasPacketLoss = readableFigure\(props\.test\.packetLoss\) !== null/);
        assert.doesNotMatch(latest, /\{props\.test\.packetLoss && /);
    });

    // Only Ookla reports one; the other providers get the same treatment the
    // bufferbloat row already has.
    it("renders nothing for a provider that measured none", () => {
        assert.match(latest, /\{hasPacketLoss && \(/);
    });

    it("grades it by what a call needs, there being no configured optimum", () => {
        assert.match(latest, /packetLossColour\(props\.test\.packetLoss\)/);
    });

    it("has its label", () => {
        assert.equal(english.latest.packet_loss, "Packet loss");
    });
});

describe("the jitter row on the stability card", () => {
    /**
     * The server has averaged jitter over the range since the consistency block
     * was written and nothing has ever rendered it - the payload carried a
     * figure no screen showed.
     */
    it("renders the average the payload already carried", () => {
        assert.match(consistency, /data\.ping\.jitter/);
        assert.match(consistency, /jitterColour\(formatLatency\(data\.ping\.jitter\)\)/);
    });

    // A range in which nothing measured jitter returns an explicit null, and
    // `{value} {unit}` around that leaves a bare "ms" standing on its own.
    // The latency variant, so the figure is also trimmed to the one decimal
    // every other latency on screen shows.
    it("formats it rather than interpolating a unit onto it", () => {
        assert.match(consistency, /formatLatencyWithUnit\(data\.ping\.jitter, t\("latest\.jitter_unit"\)\)/);
    });

    it("has its sub-label", () => {
        assert.equal(typeof english.statistics.consistency.jitter_detail, "string");
    });
});

/**
 * Two components wrote "20:00" from the same preference, and the second one was
 * about to be a third.
 */
describe("the hour formatter", () => {
    it("is shared rather than reimplemented per chart", () => {
        const hourly = read("pages/Statistics/charts/HourlyChart.jsx");

        // Whatever the hour is called at the call site: what matters is that the
        // preference reaches the one formatter, and that the 12-hour arithmetic
        // is not written out a second time beside it.
        assert.match(hourly, /formatHour\([\w.]+, preferences\)/);
        assert.doesNotMatch(hourly, /const suffix = hour >= 12/);
        assert.match(overview, /formatHour/);
    });
});
