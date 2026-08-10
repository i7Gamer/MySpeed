import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const read = (file) => fs.readFileSync(path.join(CLIENT_SRC, file), "utf8");

const statistics = read("pages/Statistics/Statistics.jsx");
const overviewChart = read("pages/Statistics/charts/OverviewChart/OverviewChart.jsx");

/**
 * The statistics used to be the one page that could not show everything: the
 * charts bucket over the window they are asked for, so a stand-in window wide
 * enough to hold anything the server keeps would have drawn a year of tests as
 * a handful of points at its right edge. Asked for by name, the server leaves
 * the rows unfiltered and buckets over the extent of the tests themselves.
 */
describe("the statistics ask for all time by name", () => {
    it("names the range rather than sending dates alone", () => {
        assert.match(statistics, /query\.set\("range", TIMEFRAME_ALL\)/);
    });

    // A parent proxies this request to its nodes, and a node running an older
    // version understands only from/to.
    it("sends the stand-in window beside the name", () => {
        assert.match(statistics, /resolveAllTime\(\)/);
    });

    // Nothing precedes everything, and asking anyway costs a second table scan
    // for a window that cannot contain a test.
    it("only asks for the previous window when the range is bounded", () => {
        assert.match(statistics, /if \(dateRange\)\s*query\.set\("compare", "previous"\)/);
    });

    // The page request and the high-resolution one a reader opens a chart for.
    it("builds both of its requests the same way", () => {
        assert.equal((statistics.match(/rangeQuery\(dateRange\)/g) ?? []).length, 2);
    });
});

/**
 * All time can span years, and the card that titles the page carried a date
 * formatter of its own that named a day without one - "from 04 Mar to 07 Aug"
 * for a two-year history. The shared formatter carries the year, and reads the
 * language the app is set to rather than the one the browser is.
 */
describe("the overview card's title", () => {
    it("names its days with the shared formatter", () => {
        assert.match(overviewChart, /formatDay/);
        assert.doesNotMatch(overviewChart, /toLocaleDateString/,
            "the card still carries a date formatter of its own");
    });
});
