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
        assert.match(overview, /value: formatLatencyWithUnit\(ping\.avg, ms\)/);
        assert.match(statistics, /ping=\{deferredStatistics\.ping}/);
    });

    /**
     * At one decimal, like every other latency in the app.
     *
     * buildStatistics returns the ping through mapFixed at two, and this pane
     * was the last reader still printing them raw: "23.47 ms" and "between
     * 8.91 ms and 132.76 ms", where the stability card one panel away and the
     * detail pane one click away both say 23.5. ConsistencyChart was changed to
     * fix exactly this; the twin was never applied here.
     *
     * The assertion above used to pin the two-decimal spelling verbatim, which
     * meant the test had to move with the fix - so it is written out here as
     * what it is rather than left as an incidental match.
     */
    it("trims that latency the way every other panel does", () => {
        for (const figure of ["ping.avg", "ping.min", "ping.max", "ping.median"])
            assert.match(overview, new RegExp(`formatLatencyWithUnit\\(${figure.replace(".", "\\.")}, ms\\)`),
                `${figure} is printed at the two decimals the server stores`);

        assert.doesNotMatch(overview, /formatWithUnit\(ping\./,
            "a latency on this pane is still printed raw");
    });

    it("compares that latency with the previous window, the right way up", () => {
        assert.match(overview,
            /previous: readableFigure\(props\.previous\?\.ping\?\.avg\), higherIsBetter: false/,
            "the delta reads the raw column, so a placeholder in the previous window claims a change");
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
            "density_title", "density_description", "density_description_partial"])
            assert.equal(typeof english.statistics.overview[key], "string", `statistics.overview.${key}`);

        assert.match(english.statistics.overview.ping_description, /\{\{min}}[\s\S]*\{\{max}}/);
        assert.match(english.statistics.overview.ping_description, /\{\{median}}/,
            "the latency row interpolates a median its string does not name");
        assert.match(english.statistics.overview.density_description, /\{\{days}}/);
        assert.match(english.statistics.overview.density_description_partial, /\{\{elapsed}}[\s\S]*\{\{days}}/);
    });
});

/**
 * What the testing itself cost in traffic. Stored per row since the transfer
 * columns arrived, stated per test in the detail panel - and the range's total
 * was nowhere.
 */
describe("the data the range's tests used", () => {
    it("states the total in the detail panel's own words", () => {
        assert.match(overview, /title: t\("test\.details\.data_used"\)/,
            "the row invents a wording of its own for a fact the panel already names");
        assert.match(overview, /value: formatBytes\(dataUsed\.total\)/);
    });

    it("is fed by the page, collapsed and expanded alike", () => {
        const handed = statistics.match(/dataUsed=\{deferredStatistics\.dataUsed}/g) ?? [];

        assert.equal(handed.length, 2,
            "one of the two OverviewChart renders lost the prop - the trap props.ping already sits in");
    });

    it("renders no row rather than a total of nought when nothing measured it", () => {
        assert.match(overview, /const dataTotal = readableFigure\(dataUsed\?\.total\);/);
        assert.doesNotMatch(overview, /typeof dataUsed\?\.total === "number"/,
            "the bare typeof gate is back, which renders the placeholder and hides the text spelling");
    });

    it("compares the total without colouring it", () => {
        assert.match(overview,
            /previous: readableFigure\(props\.previous\?\.dataUsed\?\.total\), higherIsBetter: null/);
    });
});

/**
 * The same parity for the ping. The expanded pane's rows describe the range's
 * latency from props.ping, and the collapsed render was the only mount not
 * handed it - latent while nothing collapsed reads it, and exactly the silent
 * blank the dataUsed assertion above calls "the trap props.ping already sits
 * in" the day something does.
 */
describe("the ping the overview describes", () => {
    it("is fed by the page, collapsed and expanded alike", () => {
        const handed = statistics.match(/ping=\{deferredStatistics\.ping}/g) ?? [];

        assert.equal(handed.length, 2,
            "one of the two OverviewChart renders lost the prop the detail rows read");
    });
});

/**
 * The median on the averages pane: the mean the card leads with moves with one
 * bad afternoon, and the middle of the range does not.
 */
describe("the averages pane's median", () => {
    const averages = read("pages/Statistics/charts/AverageChart/AverageChart.jsx");

    it("shows the median only in the enlarged view", () => {
        assert.match(averages,
            /props\.expanded && \(\s*<PanelRow icon=\{faScaleBalanced} title=\{t\("statistics\.values\.median"\)/);
    });

    it("compares it against the previous window the way the average is", () => {
        assert.match(averages, /current=\{props\.data\.median} previous=\{props\.previous\?\.median}/);
    });

    it("has its string", () => {
        assert.equal(typeof english.statistics.values.median, "string");
    });
});

/**
 * The density divisor for a window that is still running.
 *
 * A seven-day range at Wednesday noon has been sampled for two and a half
 * days, and dividing by seven understated the rate by the days that have not
 * happened yet. Lifted out and run rather than pattern-matched: what matters
 * is which figure a partial window divides by, and only handing the function
 * a range can say.
 */
describe("tests per day on a still-running range", () => {
    const lifted = () => {
        const start = overview.indexOf("const MS_PER_DAY");
        const end = overview.indexOf("const expandedItems");
        assert.notEqual(start, -1, "the density helpers are no longer derived above the pane");
        assert.notEqual(end, -1, "const expandedItems no longer follows them");

        return new Function(`${overview.slice(start, end)}\nreturn {testsPerDay};`)();
    };

    it("divides by the elapsed fraction when the server sent one", () => {
        assert.deepEqual(lifted().testsPerDay(25, {days: 7, elapsedDays: 2.5}),
            {perDay: 10, days: 7, elapsed: 2.5});
    });

    it("divides by whole days when none was sent", () => {
        assert.deepEqual(lifted().testsPerDay(70, {days: 7}),
            {perDay: 10, days: 7, elapsed: null});
    });

    // Zero would divide, NaN would poison, and a string would concatenate.
    it("falls back to whole days for a fraction that is not a positive number", () => {
        for (const elapsedDays of [0, -1, NaN, "2"])
            assert.equal(lifted().testsPerDay(70, {days: 7, elapsedDays}).perDay, 10,
                `elapsedDays ${String(elapsedDays)}`);
    });

    it("names both figures when the window is partial", () => {
        assert.match(overview, /density\.elapsed\s*\?\s*t\("statistics\.overview\.density_description_partial"/,
            "a rate over part of the window reads as a claim about all of it");
    });
});

/**
 * The note every delta on the page is read against. A window cut at now's own
 * wall clock - the range is still running - has to say so, or its dates would
 * claim whole days it only partly covers.
 */
describe("the comparison note", () => {
    it("says when the window it names was cut", () => {
        assert.match(statistics,
            /previous\.dateRange\.partial\s*\?\s*"statistics\.compare\.note_partial"\s*:\s*"statistics\.compare\.note"/);
    });

    it("has both wordings, each naming the window", () => {
        for (const key of ["note", "note_partial"])
            assert.match(english.statistics.compare[key], /\{\{from}}[\s\S]*\{\{to}}/,
                `statistics.compare.${key}`);
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
    // "Between N/A and N/A" is worse than saying nothing - and a proxied
    // node's placeholder pair is no range either: the null-only gate this
    // replaces rendered exactly that sentence for {-1, -1}, one sub-line
    // from a deviation refusing the same value. Both ends must read, or a
    // half-readable pair prints "between 12 and N/A".
    it("renders no spread for a range nothing can read", () => {
        assert.match(consistency,
            /if \(readableFigure\(range\.min\) === null \|\| readableFigure\(range\.max\) === null\) return null/);
        assert.doesNotMatch(consistency, /range\.min === null/,
            "the null-only gate is back, which lets the placeholder pair through as a sentence");
    });

    it("shows nothing extra on the card", () => {
        assert.match(consistency, /if \(!props\.expanded \|\| !range\) return null/);
    });

    // A grade of "A" from three tests and one from three hundred look exactly
    // alike, and the count has only ever been in a title attribute.
    it("brings the bufferbloat sample count out of its tooltip", () => {
        assert.match(consistency,
            /props\.expanded && \(\s*<span>\{t\("statistics\.consistency\.sample_count"/);
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
    // Through the shared reader, like the loss row: the null-only gate
    // rendered a proxied node's -1 as an N/A row whose delta was computed
    // from the placeholder, and hid an older node's text average while it
    // was a reading.
    it("drops the latency row rather than describing it as N/A to N/A", () => {
        assert.match(overview, /const pingAverage = readableFigure\(props\.ping\?\.avg\);/);
        assert.doesNotMatch(overview, /props\.ping\?\.avg === null \|\| props\.ping\?\.avg === undefined/,
            "the null-only gate is back, which renders the placeholder as an N/A row with a live delta");
    });

    // Both ends must read, the spread()'s own rule one card over: a one-end
    // gate printed "2s – N/A", and a placeholder pair "-1s – -1s".
    it("drops the duration spread the same way", () => {
        assert.match(overview,
            /readableFigure\(props\.time\?\.min\) !== null && readableFigure\(props\.time\?\.max\) !== null/);
        assert.doesNotMatch(overview, /props\.time\?\.min !== null/,
            "the one-end gate is back, which prints a spread with a refused end");
    });
});
