import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as sass from "sass";
import { fileURLToPath, pathToFileURL } from "node:url";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const read = (file) => fs.readFileSync(path.join(CLIENT_SRC, file), "utf8");

const aliasImporter = {
    findFileUrl(url) {
        if (!url.startsWith("@/")) return null;
        return pathToFileURL(path.join(CLIENT_SRC, url.slice(2)));
    }
};

const compile = (file) => sass.compile(path.join(CLIENT_SRC, file), {importers: [aliasImporter]}).css;

const ROW_DIR = "pages/Statistics/components/PanelRow";
const row = read(`${ROW_DIR}/PanelRow.jsx`);
// The sizes live apart from the rules that use them, so a card can reach for
// one without compiling the whole layout into its own sheet - see the partial.
const rowSizes = read(`${ROW_DIR}/_variables.sass`);
const css = compile(`${ROW_DIR}/styles.sass`);

// The four panels that state readings as rows. The charts are excluded: a plot
// has no row to share.
const PANELS = [
    {name: "OverviewChart", file: "pages/Statistics/charts/OverviewChart/OverviewChart.jsx",
        styles: "pages/Statistics/charts/OverviewChart/styles.sass", retired: ".overview-item:"},
    {name: "LatestTestChart", file: "pages/Statistics/charts/LatestTestChart/LatestTestChart.jsx",
        styles: "pages/Statistics/charts/LatestTestChart/styles.sass", retired: ".test-container"},
    {name: "ConsistencyChart", file: "pages/Statistics/charts/ConsistencyChart/ConsistencyChart.jsx",
        styles: "pages/Statistics/charts/ConsistencyChart/styles.sass", retired: ".consistency-item"},
    {name: "AverageChart", file: "pages/Statistics/charts/AverageChart/AverageChart.jsx",
        styles: "pages/Statistics/charts/AverageChart/styles.sass", retired: ".value-item"}
];

const bodyOf = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = css.match(new RegExp(`${escaped}(?![-\\w])\\s*\\{([^}]*)}`));

    assert.notEqual(match, null, `${selector} is not a rule in the shared stylesheet`);
    return match[1];
};

const sizeOf = (selector) => {
    const size = bodyOf(selector).match(/font-size:\s*([\d.]+)rem/);
    assert.notEqual(size, null, `${selector} states no size in rem`);

    return parseFloat(size[1]);
};

/**
 * The four statistics panels drew this row four times over.
 *
 * Two of them were mirror images: the overview card put the icon first and the
 * value last, and the other three put the text first and the icon last. The
 * value was 1.1rem on three and an unstated h2 default - 1.5rem - on the fourth,
 * so the same kind of figure came out a third larger on one card than on the
 * card beside it. Four copies of one layout is the split that keeps widening:
 * every figure added to any of them since has had to pick a side.
 */
describe("the shared panel row", () => {
    it("states the reading larger than what the reading is called", () => {
        const value = sizeOf(".panel-row-value");

        assert.ok(value > sizeOf(".panel-row-title"),
            `the value is ${value}rem, no larger than its own label`);
        assert.ok(sizeOf(".panel-row-title") > sizeOf(".panel-row-description"),
            "the description is as loud as the title it hangs under");
    });

    // The whole reason the row moved: the value is what the eye lands on.
    it("states it larger than the 1.1rem the panels used to", () => {
        assert.ok(sizeOf(".panel-row-value") > 1.1);
    });

    it("names the size once rather than repeating a literal", () => {
        assert.match(rowSizes, /\$panel-value-size:\s*[\d.]+rem/,
            "the value size is a literal, so the next change to it has several places to remember");
        assert.match(rowSizes, /\$panel-value-size-narrow:\s*[\d.]+rem/,
            "the step down the squeezed cards take is a literal of its own");
    });

    /**
     * The grade goes on the icon and on the value together. Three of the four
     * panels colour a reading by what it earns - a stability percentage, a
     * bufferbloat grade, a ping against its target - and the overview card
     * colours none of its own, having no thresholds to grade against. A row
     * that only ever wore the overview's colours would have thrown the other
     * three cards' gradings away.
     */
    it("dresses the icon and the value in the same grade", () => {
        const graded = row.match(/const graded = ([^\n]*)/);
        assert.notEqual(graded, null, "the row no longer derives a grade class");

        const apply = (className) => new RegExp(`"${className}" \\+ graded`).test(row);

        assert.ok(apply("panel-row-icon"), "the icon does not wear the grade");
        assert.ok(apply("panel-row-value"), "the value does not wear the grade");
    });

    it("leaves a row with no grade to the card's own colours", () => {
        const graded = new Function("level", `return ${row.match(/const graded = ([^;]*)/)[1]};`);

        assert.equal(graded(undefined), "");
        assert.equal(graded("orange"), " icon-orange");
    });

    // A description is what qualifies a reading, and plenty of rows have none.
    // Rendering the wrapper regardless leaves an empty second line under the
    // title, which reads as a measurement that went missing.
    it("draws no description when there is none", () => {
        assert.match(row, /\{description && /,
            "the description wrapper is drawn whether or not there is one");
    });
});

describe("the panels that state readings", () => {
    for (const {name, file, styles, retired} of PANELS) {
        const source = read(file);

        it(`${name} draws its rows through the shared row`, () => {
            assert.match(source, /import PanelRow from "@\/pages\/Statistics\/components\/PanelRow"/,
                `${name} does not use the shared row`);
            assert.match(source, /<PanelRow/, `${name} imports the shared row and never draws one`);
        });

        it(`${name} keeps no row layout of its own`, () => {
            assert.ok(!source.includes(retired),
                `${name} still draws ${retired} by hand`);
            assert.ok(!read(styles).includes(retired),
                `${name}'s stylesheet still dresses ${retired}`);
        });
    }
});
