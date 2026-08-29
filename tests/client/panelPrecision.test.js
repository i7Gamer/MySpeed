import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { convertSpeed, formatWithUnit, NOT_MEASURED, wholeSpeed } from "@/common/utils/FormatUtil.js";
import { readableFigure } from "@/common/utils/TestUtil.js";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const read = (file) => fs.readFileSync(path.join(CLIENT_SRC, file), "utf8");

const average = read("pages/Statistics/charts/AverageChart/AverageChart.jsx");
const consistency = read("pages/Statistics/charts/ConsistencyChart/ConsistencyChart.jsx");
const latest = read("pages/Statistics/charts/LatestTestChart/LatestTestChart.jsx");
const pane = read("common/components/TestDetails/TestDetails.jsx");

/**
 * A helper lifted out of a component and run.
 *
 * These are plain JavaScript above the JSX, so what matters - which figure comes
 * out at which precision - is observable directly rather than through the
 * spelling of the call.
 */
const helper = (source, declaration, closure) => {
    const start = source.indexOf(declaration);
    assert.notEqual(start, -1, `no "${declaration}" left to check`);

    const end = source.indexOf("\n    };", start);
    assert.notEqual(end, -1, `"${declaration}" is no longer a block`);

    const names = Object.keys(closure);
    const body = source.slice(start, end + "\n    };".length);
    const name = declaration.match(/const (\w+)/)[1];

    return new Function(...names, `${body}\nreturn ${name};`)(...names.map((key) => closure[key]));
};

/**
 * A card is read at a glance down its figures, and a column of figures reads as
 * a column when they are one width - the same reason the overview rows round.
 * The pane a card opens is where someone has gone looking for the number itself,
 * so that is where the decimals live.
 *
 * The rule only holds if both halves do: a card that rounds and a pane that also
 * rounds loses the figure altogether.
 */
describe("a statistics card rounds what the pane it opens states exactly", () => {
    const MBYTES = {speedUnit: "mbytes"};

    // Closures carry only the names each region actually reads: a closure that
    // also supplies the OLD shape's helpers is what lets a revert to that
    // shape still evaluate green - the band fixtures below are the second net.
    const speed = (expanded, preferences = {}) => helper(average, "const speed = (mbps) => {", {
        props: {expanded}, preferences, convertSpeed, formatWithUnit, wholeSpeed,
        speedUnit: preferences === MBYTES ? "MB/s" : "Mbps"
    });

    /**
     * The card's own refusing reader, lifted rather than stubbed: a stub that
     * re-implements the gate is how this suite stayed green while the real
     * one printed "±-1 Mbps" for a placeholder a proxied node can send.
     */
    const realDeviation = () => helper(consistency, "const deviation = (value, unit) => {",
        {readableFigure, NOT_MEASURED});

    const stdDev = (expanded, preferences = {}) => helper(consistency, "const stdDev = (value) => {", {
        props: {expanded}, preferences, speedUnit: preferences === MBYTES ? "MB/s" : "Mbps",
        convertSpeed, wholeSpeed, deviation: realDeviation()
    });

    it("the value cards' speeds", () => {
        assert.equal(speed(false)(841.25), "841 Mbps");
        assert.equal(speed(true)(841.25), "841.25 Mbps", "the enlarged view lost the decimals too");
    });

    // Rounded after the conversion, never before it: MB/s is an eighth of what
    // the column stores, so rounding first would print a different measurement.
    // And rounded ONCE - the band fixture separates the single rounding from a
    // revert to formatWhole(convertSpeed(...)), which the 100 case cannot.
    it("and it rounds them in the unit the reader chose", () => {
        assert.equal(speed(false, MBYTES)(100), "13 MB/s", "100 Mbps is 12.5 MB/s, which prints as 13");
        assert.equal(speed(false, MBYTES)(99.97), "12 MB/s", "12.49625 rounds once to 12, not via 12.5 to 13");
    });

    it("the stability card's spreads", () => {
        assert.equal(stdDev(false)(123.12), "±123 Mbps");
        assert.equal(stdDev(true)(123.12), "±123.12 Mbps");
        assert.equal(stdDev(false, MBYTES)(99.97), "±12 MB/s",
            "the spread is re-rounded through the two-decimal conversion again");
    });

    it("says nothing was measured rather than rounding an absent figure", () => {
        for (const absent of [null, undefined])
            assert.equal(stdDev(false)(absent), NOT_MEASURED, `failed for ${String(absent)}`);
    });

    // The spread is server-fed, and a proxied older node's payload can hold
    // anything: what no reader can read must say so, not wear a ± in front.
    it("refuses a spread nothing can read rather than printing it", () => {
        for (const junk of ["auto", -1, "-1"])
            assert.equal(stdDev(false)(junk), NOT_MEASURED,
                `a spread of ${JSON.stringify(junk)} printed as a reading`);
    });

    // The consistency score beside it reads the same way - a text score from
    // an older node prints as the number it spells, junk and the placeholder
    // say N/A instead of "auto%" beside the blue the colour already grades.
    it("prints a score in either spelling and refuses what is no score", () => {
        const percentage = helper(consistency, "const percentage = (value) => {",
            {readableFigure, NOT_MEASURED});

        assert.equal(percentage(92.5), "92.5%");
        assert.equal(percentage("85.50"), "85.5%", "a text score reads as the number it spells");
        for (const junk of ["auto", -1, null, undefined])
            assert.equal(percentage(junk), NOT_MEASURED, `${JSON.stringify(junk)} printed as a score`);
    });

    /**
     * The last-test card has no expanded branch of its own - opened, it renders
     * TestDetails, which is the same pane the overview rows open. So the rule
     * holds here as long as the card rounds and that pane never does.
     */
    it("the last-test card's three figures", () => {
        // Through formatWithUnit, not a bare template: `${wholeSpeed(null)}`
        // printed the literal "null Mbps" for a legacy row, and junk printed
        // as a reading - the same strings for real figures, N/A for the rest.
        assert.match(latest, /const speedText = \(mbps\) => formatWithUnit\(wholeSpeed\(mbps, preferences\), speedUnit\);/,
            "the card glues a speed to its unit by hand, which prints null and junk as readings");
        assert.match(latest, /formatWithUnit\(formatWhole\(props\.test\.ping\), t\("latest\.ping_unit"\)\)/,
            "the card states the ping at the pane's precision, through the refusing formatter");
        assert.match(latest, /if \(props\.expanded\) return \(\s*<StatisticContainer[^>]*>\s*<TestDetails/,
            "opened, the card no longer hands over to the detail pane");
    });

    // The one assertion that catches the rule being broken from the other side:
    // a detail view that starts rounding has nowhere left to show the figure.
    it("and no detail view rounds anything", () => {
        assert.doesNotMatch(pane, /formatWhole/,
            "the detail pane rounds a figure, which is the only place the exact one was left");
    });
});
