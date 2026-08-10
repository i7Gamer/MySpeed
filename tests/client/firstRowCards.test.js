import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

describe("the packet-loss row on the latest-test card", () => {
    // Zero is a measurement and the commonest one, so a truthiness check would
    // hide the row on exactly the tests it has the best news for.
    it("shows a loss of zero rather than hiding it", () => {
        assert.match(latest, /typeof props\.test\.packetLoss === "number"/);
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
        assert.match(consistency, /jitterColour\(data\.ping\.jitter\)/);
    });

    // A range in which nothing measured jitter returns an explicit null, and
    // `{value} {unit}` around that leaves a bare "ms" standing on its own.
    it("formats it rather than interpolating a unit onto it", () => {
        assert.match(consistency, /formatWithUnit\(data\.ping\.jitter, t\("latest\.jitter_unit"\)\)/);
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

        assert.match(hourly, /formatHour\(hour, preferences\)/);
        assert.doesNotMatch(hourly, /const suffix = hour >= 12/);
        assert.match(overview, /formatHour/);
    });
});
