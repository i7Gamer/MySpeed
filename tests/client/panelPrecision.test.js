import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { convertSpeed, formatWhole, formatWithUnit, NOT_MEASURED } from "@/common/utils/FormatUtil.js";

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

    it("the value cards' speeds", () => {
        const speed = (expanded, preferences = {}) => helper(average, "const speed = (mbps) => {", {
            props: {expanded}, preferences, convertSpeed, formatWhole, formatWithUnit,
            speedUnit: preferences === MBYTES ? "MB/s" : "Mbps"
        });

        assert.equal(speed(false)(841.25), "841 Mbps");
        assert.equal(speed(true)(841.25), "841.25 Mbps", "the enlarged view lost the decimals too");
    });

    // Rounded after the conversion, never before it: MB/s is an eighth of what
    // the column stores, so rounding first would print a different measurement.
    it("and it rounds them in the unit the reader chose", () => {
        const speed = helper(average, "const speed = (mbps) => {", {
            props: {expanded: false}, preferences: MBYTES,
            convertSpeed, formatWhole, formatWithUnit, speedUnit: "MB/s"
        });

        assert.equal(speed(100), "13 MB/s", "100 Mbps is 12.5 MB/s, which prints as 13");
    });

    it("the stability card's spreads", () => {
        const stdDev = (expanded) => helper(consistency, "const stdDev = (value) => {", {
            props: {expanded}, preferences: {}, speedUnit: "Mbps",
            convertSpeed, formatWhole,
            deviation: (value, unit) =>
                value === null || value === undefined ? NOT_MEASURED : `±${value} ${unit}`
        });

        assert.equal(stdDev(false)(123.12), "±123 Mbps");
        assert.equal(stdDev(true)(123.12), "±123.12 Mbps");
    });

    it("says nothing was measured rather than rounding an absent figure", () => {
        const stdDev = helper(consistency, "const stdDev = (value) => {", {
            props: {expanded: false}, preferences: {}, speedUnit: "Mbps",
            convertSpeed, formatWhole,
            deviation: (value, unit) =>
                value === null || value === undefined ? NOT_MEASURED : `±${value} ${unit}`
        });

        for (const absent of [null, undefined])
            assert.equal(stdDev(absent), NOT_MEASURED, `failed for ${String(absent)}`);
    });

    /**
     * The last-test card has no expanded branch of its own - opened, it renders
     * TestDetails, which is the same pane the overview rows open. So the rule
     * holds here as long as the card rounds and that pane never does.
     */
    it("the last-test card's three figures", () => {
        assert.match(latest, /const speedText = \(mbps\) => `\$\{formatWhole\(convertSpeed\(mbps, preferences\)\)}/,
            "the card states a speed at whatever precision it was measured at");
        assert.match(latest, /\$\{formatWhole\(props\.test\.ping\)}/,
            "the card states the ping at the pane's precision");
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
