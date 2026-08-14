import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { percentOfTarget } from "../../client/src/common/components/TestDetails/utils/details.js";
import { getIconBySpeed } from "../../client/src/common/utils/TestUtil.js";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const CLIENT_SRC = path.join(ROOT, "client", "src");

const read = (file) => fs.readFileSync(path.join(CLIENT_SRC, file), "utf8");

const average = read("pages/Statistics/charts/AverageChart/AverageChart.jsx");
const statistics = read("pages/Statistics/Statistics.jsx");
const english = JSON.parse(fs.readFileSync(
    path.join(ROOT, "client", "public", "assets", "locales", "en.json"), "utf8"));

/**
 * The download and upload cards stated a minimum, a maximum and an average and
 * left the reader to divide by what they pay for. The connection-stability card
 * shows a percentage too and means something entirely different by it - it
 * divides the line by itself - so this one has to say "of your target" rather
 * than stand as a bare number.
 */
describe("the target percentage on the value cards", () => {
    it("is measured against the optimum from the settings", () => {
        assert.match(average, /const reached = percentOfTarget\(props\.data\.avg, props\.target\)/);
    });

    it("is fed that optimum by the page, on both cards and in both modals", () => {
        assert.equal((statistics.match(/target=\{config\?\.download}/g) ?? []).length, 2);
        assert.equal((statistics.match(/target=\{config\?\.upload}/g) ?? []).length, 2);
        assert.match(statistics, /import \{ConfigContext} from "@\/common\/contexts\/Config"/);
    });

    // The min and max of a range are single tests. A percentage on the slowest
    // one reads as a verdict on the connection rather than on one bad
    // afternoon, which is why the delta is left off them too.
    it("sits on the average alone", () => {
        assert.equal((average.match(/percentOfTarget\(/g) ?? []).length, 1);
    });

    it("reuses the label the expanded test row already had translated", () => {
        assert.match(average, /t\("test\.details\.of_target", \{percent: reached}\)/);
        assert.match(english.test.details.of_target, /\{\{percent}}/);
        assert.match(english.test.details.of_target, /target/i);
    });

    // "86%" here and a green arrow on the overview must not disagree about
    // whether the line is meeting its target.
    it("is coloured by the same grading every other speed on the page uses", () => {
        assert.match(average, /getIconBySpeed\(props\.data\.avg, props\.target, true\)/);
    });

    it("renders nothing rather than a bare percentage sign when there is nothing to compare", () => {
        assert.match(average, /description=\{reached !== null && </);
    });
});

/**
 * The percentage is taken on the stored Mbps, never on the converted figure:
 * the configured target is in Mbps whatever the reader has chosen to see.
 */
describe("the arithmetic behind it", () => {
    it("is the average over the target, as a whole percentage", () => {
        assert.equal(percentOfTarget(214, 250), 86);
        assert.equal(percentOfTarget(250, 250), 100);
    });

    it("goes past 100 for a line that beats what it was sold as", () => {
        assert.equal(percentOfTarget(300, 250), 120);
    });

    it("says nothing on an instance nobody has set a target on", () => {
        for (const target of [null, undefined, "", 0, "0"])
            assert.equal(percentOfTarget(214, target), null, `target ${JSON.stringify(target)}`);
    });

    // Every aggregate is an explicit null for a range in which nothing
    // succeeded, and 0/250 would report the line at 0% of its target.
    it("says nothing for a range in which nothing succeeded", () => {
        assert.equal(percentOfTarget(null, 250), null);
    });

    // The config stores what was typed into the settings dialog, which is a
    // string - Number("250") is the target, but the guard has to allow it.
    it("reads a target stored as a string, which is how the config holds it", () => {
        assert.equal(percentOfTarget(214, "250"), 86);
    });

    /**
     * The percentage and the colour are two readings of one ratio, and a card
     * showing "80%" in red would be arguing with itself. getIconBySpeed's
     * buckets are 75 and 30.
     */
    it("agrees with the colour it is shown in", () => {
        const cases = [[200, 250, "green"], [100, 250, "orange"], [50, 250, "red"]];

        for (const [average, target, expected] of cases) {
            assert.equal(getIconBySpeed(average, target, true), expected);
            assert.ok(percentOfTarget(average, target) > 0);
        }
    });

    // A target set but nothing measured yet is the fresh-install case, and it
    // must not paint the card red before a single test has run.
    it("is blue rather than red before anything has been measured", () => {
        assert.equal(getIconBySpeed(null, 250, true), "blue");
    });
});

/**
 * These two panes opened to exactly what their cards showed, same as the other
 * three did. Opened, they now add what the page holds and puts nowhere near
 * these numbers: the bar behind the percentage, the optimum it is measured
 * against, how steady the metric was, and how many tests all three figures are
 * over - a minimum taken over eleven tests and one over eleven thousand are the
 * same number and not the same claim.
 */
describe("the expanded value panes", () => {
    // The bar hangs inside the description the percentage above it already
    // gates on `reached`, so the expanded gate no longer restates it.
    it("draw the bar the expanded test row draws for the same ratio", () => {
        assert.match(average, /description=\{reached !== null && <>[\s\S]*\{props\.expanded && \(/);
        assert.match(average, /Math\.min\(reached, MAX_BAR_PERCENT\)/);
    });

    it("name the optimum, which lives in a dialog nobody has open while reading", () => {
        assert.match(average, /t\("statistics\.values\.target",/);
        assert.match(english.statistics.values.target, /\{\{target}}/);
    });

    // The target is stored in Mbps whatever the reader has chosen to see, so
    // naming it has to convert where the ratio above deliberately did not.
    // Through the same formatter every other figure on the card goes through -
    // it was the fourth hand-written convert-and-label on a card with four
    // speeds on it.
    it("convert that optimum into the unit being read", () => {
        assert.match(average, /const speed = \(mbps\) => formatWithUnit\(convertSpeed\(mbps, preferences\), speedUnit\)/);
        assert.match(average, /target: speed\(Number\(props\.target\)\)/);
    });

    it("score how steady the metric was, beside the average it qualifies", () => {
        assert.match(average, /consistencyColour\(steadiness\.consistency\)/);
        assert.match(statistics, /consistency=\{deferredStatistics\.consistency\?\.download}/);
        assert.match(statistics, /consistency=\{deferredStatistics\.consistency\?\.upload}/);
    });

    // Every aggregate is an explicit null for a range in which nothing
    // succeeded, and "null%" is what interpolating one produces.
    it("say N/A rather than null when nothing was measured", () => {
        assert.match(average, /steadiness\.consistency === null \|\| steadiness\.consistency === undefined\s*\?\s*NOT_MEASURED/);
    });

    // The figures are over the tests that succeeded; the failures are in the
    // total and in none of the arithmetic.
    it("count the successful tests, not every row in the range", () => {
        assert.match(average, /props\.tests\.total - props\.tests\.failed/);
    });

    it("add none of it to the cards", () => {
        const cards = statistics.slice(statistics.indexOf("<div className={`statistic-area${isStale"));

        assert.doesNotMatch(cards, /<AverageChart[^>]*\bexpanded\b/);
        for (const key of ["target", "consistency", "samples"])
            assert.equal(typeof english.statistics.values[key], "string", `statistics.values.${key}`);
    });
});

/**
 * The stability card and the value panes score the same thing and used to hold
 * their own copies of the thresholds, which is two places to disagree about
 * what counts as a steady line.
 */
describe("the consistency grading", () => {
    it("is shared rather than reimplemented per card", () => {
        const stability = read("pages/Statistics/charts/ConsistencyChart/ConsistencyChart.jsx");

        assert.match(stability, /consistencyColour\(data\.(down|up)load\.consistency\)/,
            "the stability card no longer grades its speeds through the shared grader");
        assert.match(average, /consistencyColour\(steadiness\.consistency\)/,
            "the value cards no longer grade their steadiness through it either");

        for (const card of [stability, average])
            assert.doesNotMatch(card, /value >= 90/, "a card carries its own copy of the thresholds again");
    });
});
