import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const CLIENT_SRC = path.join(ROOT, "client", "src");

const read = (file) => fs.readFileSync(path.join(CLIENT_SRC, file), "utf8");

const overview = read("pages/Statistics/charts/OverviewChart/OverviewChart.jsx");
const consistency = read("pages/Statistics/charts/ConsistencyChart/ConsistencyChart.jsx");
const statistics = read("pages/Statistics/Statistics.jsx");
const english = JSON.parse(fs.readFileSync(
    path.join(ROOT, "client", "public", "assets", "locales", "en.json"), "utf8"));

// Everything each pane opens with. A card that renders exactly what its modal
// renders is a card there is no reason to click, which is what all three of
// these were.
const EXPANDED_CHARTS = ["overview", "latest", "consistency"];

describe("every first-row card opens into more than itself", () => {
    for (const chart of EXPANDED_CHARTS) {
        it(`asks the ${chart} pane for its enlarged view`, () => {
            const branch = statistics.match(new RegExp(`case '${chart}':([\\s\\S]*?)case '`));

            assert.notEqual(branch, null, `no render branch for ${chart}`);
            assert.match(branch[1], /\bexpanded\b/, `the ${chart} modal renders the plain card`);
        });
    }

    // The cards themselves must not: `expanded` is what tells a pane it has the
    // whole dialog to spend rather than a third of a row, and the page grid
    // gives it a third of a row.
    it("leaves the cards themselves unexpanded", () => {
        const cards = statistics.slice(statistics.indexOf("<div className={`statistic-area${isStale"));

        assert.notEqual(cards, "", "the page body was not found");
        for (const card of ["OverviewChart", "LatestTestChart", "ConsistencyChart"])
            assert.doesNotMatch(cards, new RegExp(`<${card}[^>]*\\bexpanded\\b`), `the ${card} card is expanded`);
    });
});

/**
 * Latency had no min/max/avg anywhere - download and upload each have a card of
 * their own at the foot of the page and ping has only a line chart - the
 * duration card stated an average with no spread, and nothing said how often
 * the schedule actually ran.
 */
describe("the overview pane", () => {
    it("states the latency the page never put a number on", () => {
        assert.match(overview, /icon: faPingPongPaddleBall/);
        assert.match(overview, /value: formatWithUnit\(ping\.avg, ms\)/);
        assert.match(statistics, /ping=\{deferredStatistics\.ping}/);
    });

    it("compares that latency with the previous window, the right way up", () => {
        assert.match(overview, /previous: props\.previous\?\.ping\?\.avg, higherIsBetter: false/);
    });

    it("states the duration spread the card summarises as an average", () => {
        assert.match(overview, /formatDuration\(props\.time\.min\)} – \$\{formatDuration\(props\.time\.max\)/);
    });

    // The count the server sent for the window it actually answered for, so the
    // divisor and the dates in the heading cannot describe different windows.
    it("divides by the day count the server sent", () => {
        assert.match(overview, /if \(typeof dateRange\?\.days === "number" && Number\.isFinite\(dateRange\.days\)\) return dateRange\.days/);
    });

    // A parent proxies this request to its nodes, and a node running an older
    // version answers without the count.
    it("falls back to the bounds when none was sent", () => {
        assert.match(overview, /new Date\(dateRange\?\.to\) - new Date\(dateRange\?\.from\)/);
        assert.match(overview, /Math\.max\(1, Math\.ceil\(span\)\)/);
    });

    // A range of zero width divides by zero, and all-time on a fresh instance
    // is exactly that.
    it("renders no density row rather than dividing by an empty range", () => {
        assert.match(overview, /if \(!Number\.isFinite\(span\) \|\| span <= 0\) return null/);
        assert.match(overview, /if \(days === null \|\| days <= 0\) return null/);
    });

    it("adds none of this to the card", () => {
        assert.match(overview, /if \(props\.expanded\) items\.push\(\.\.\.expandedItems\(props\)\)/);
    });

    it("has every string it interpolates", () => {
        for (const key of ["ping_description", "span_title", "span_description",
            "density_title", "density_description"])
            assert.equal(typeof english.statistics.overview[key], "string", `statistics.overview.${key}`);

        assert.match(english.statistics.overview.ping_description, /\{\{min}}[\s\S]*\{\{max}}/);
        assert.match(english.statistics.overview.density_description, /\{\{days}}/);
    });
});

/**
 * A standard deviation is the honest figure and an unreadable one: nobody has
 * an intuition for ±34 Mbps, and everybody has one for "between 180 and 260".
 */
describe("the stability pane", () => {
    it("puts the two ends under each deviation it already showed", () => {
        for (const metric of ["download", "upload", "ping", "jitter"])
            assert.match(consistency, new RegExp(`spreads\\.${metric} && <span`), `${metric} shows no spread`);
    });

    it("is fed those ranges by the page", () => {
        assert.match(statistics, /ranges=\{\{download: deferredStatistics\.download/);
        assert.match(statistics, /jitter: deferredStatistics\.jitter}}/);
    });

    // A range in which nothing measured jitter returns explicit nulls, and
    // "Between N/A and N/A" is worse than saying nothing.
    it("renders no spread for a metric nothing measured", () => {
        assert.match(consistency, /if \(range\.min === null \|\| range\.min === undefined\) return null/);
    });

    it("shows nothing extra on the card", () => {
        assert.match(consistency, /if \(!props\.expanded \|\| !range\) return null/);
    });

    // A grade of "A" from three tests and one from three hundred look exactly
    // alike, and the count has only ever been in a title attribute.
    it("brings the bufferbloat sample count out of its tooltip", () => {
        assert.match(consistency, /props\.expanded && \(\s*<span className="consistency-detail">\s*\{t\("statistics\.consistency\.sample_count"/);
    });

    it("has both of its strings", () => {
        assert.match(english.statistics.consistency.range, /\{\{min}}[\s\S]*\{\{max}}/);
        assert.match(english.statistics.consistency.sample_count, /\{\{tests}}/);
    });
});

/**
 * Every aggregate on this page is an explicit null when nothing in the range
 * succeeded, and `{value} {unit}` around one of those is what put "nulls" and a
 * bare " Mbps" on screen before.
 */
describe("an empty range", () => {
    it("drops the latency row rather than describing it as N/A to N/A", () => {
        assert.match(overview, /props\.ping\?\.avg === null \|\| props\.ping\?\.avg === undefined \? null : props\.ping/);
    });

    it("drops the duration spread the same way", () => {
        assert.match(overview, /props\.time\?\.min !== null && props\.time\?\.min !== undefined/);
    });
});
