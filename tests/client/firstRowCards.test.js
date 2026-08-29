import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatDuration, formatPercent, NOT_MEASURED } from "@/common/utils/FormatUtil.js";
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
