import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NOT_MEASURED, printableFigure } from "@/common/utils/FormatUtil.js";
import { withoutJsComments } from "../helpers/source.js";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const read = (file) => fs.readFileSync(path.join(CLIENT_SRC, file), "utf8");

const component = read("common/components/FigureWithUnit/FigureWithUnit.jsx");
const formatUtil = read("common/utils/FormatUtil.js");
const row = read("pages/Home/components/Speedtest/SpeedtestComponent.jsx");
const pane = read("common/components/TestDetails/TestDetails.jsx");

/**
 * The JSX twin of formatWithUnit, for the one shape the string form cannot
 * serve: a value whose unit needs its own styled span. Both build on ONE
 * exported predicate - printableFigure - so the two forms cannot drift, and
 * both halves of that chain are pinned here: the component's use of the
 * predicate, and formatWithUnit's whole condition being nothing but it.
 */
describe("the one renderer for a figure beside its styled unit", () => {
    it("decides through the shared predicate, not a re-judgement", () => {
        assert.match(component, /!printableFigure\(value\) \? NOT_MEASURED/,
            "the component re-judges the value, so the JSX and string forms can drift apart");
    });

    // The other half of the no-drift claim: formatWithUnit's condition IS the
    // predicate, whole - a condition merely containing it could grow a second
    // clause the component never sees.
    it("shares that predicate with formatWithUnit, whole", () => {
        assert.match(formatUtil,
            /formatWithUnit = \(value, unit\) => printableFigure\(value\) \? `\$\{value\} \$\{unit\}` : NOT_MEASURED;/,
            "formatWithUnit no longer decides through printableFigure alone, so the two printers can disagree");
    });

    // The raw-render scan forbids a value interpolated beside a quoted
    // unit-bearing class; this component's own span carries its class in
    // braces, which is what keeps the one legitimate adjacency out of the
    // scan without an exemption.
    it("carries its unit class in braces, out of the raw-render scan's sight", () => {
        assert.match(component, /className=\{unitClass\}/);
        assert.doesNotMatch(component, /className="/);
    });

    it("is the renderer the Home row's three figures go through", () => {
        for (const figure of ["pingValue", "downValue", "upValue"])
            assert.match(row, new RegExp(`<FigureWithUnit value=\\{${figure}}`),
                `${figure} is glued to its unit by hand again`);

        assert.match(row, /unitClass="speedtest-unit"/);
    });

    it("is the renderer the detail cards' values go through", () => {
        assert.match(pane, /<FigureWithUnit value=\{value\} unit=\{unit\} unitClass="detail-metric-unit"\/>/);
    });

    it("is exported through the tree's barrel convention", () => {
        assert.match(read("common/components/FigureWithUnit/index.js"),
            /export \{[\s\S]*FigureWithUnit[\s\S]*} from "\.\/FigureWithUnit"/);
    });
});

/**
 * The component's own decision, executed.
 *
 * node cannot evaluate the JSX half, so the fragment is swapped for a plain
 * object by ONE anchored replacement and the arrow is run as the component
 * wrote it - comments stripped first, so a refusal moved into prose cannot
 * satisfy anything. What is executed is the real wiring: the predicate call,
 * the ternary's polarity, and which branch each input class lands in. A
 * mutant that drops the refusal returns the object for the placeholder and
 * fails here, whatever its comments say.
 */
describe("what the renderer does with each class of value", () => {
    const rendered = (() => {
        const code = withoutJsComments(component);
        const jsx = "<>{value}<span className={unitClass}>{unit}</span></>";

        const start = code.indexOf("export const FigureWithUnit =");
        assert.notEqual(start, -1, "the component's declaration moved");

        const declaration = code.slice(start, code.indexOf(";", code.indexOf(jsx, start)) + 1);
        assert.ok(declaration.includes(jsx), "the JSX fragment no longer has the shape this swap is anchored to");

        const runnable = declaration
            .replace("export const FigureWithUnit =", "return ")
            .replace(jsx, "({value, unit, unitClass})");

        return new Function("printableFigure", "NOT_MEASURED", runnable)(printableFigure, NOT_MEASURED);
    })();

    it("says N/A for everything no formatter would print", () => {
        // "25.4" is the contract, not an accident: the component prints
        // FIGURES, and coercion belongs to the formatter each caller chose -
        // a text reading handed raw refuses, loudly, instead of printing a
        // column nothing coerced.
        for (const refused of [-1, "-1", "auto", "25.4", NaN, null, undefined])
            assert.equal(rendered({value: refused, unit: "ms", unitClass: "u"}), NOT_MEASURED,
                `${JSON.stringify(refused)} rendered as a reading`);
    });

    it("renders a figure beside its unit, zero included", () => {
        assert.deepEqual(rendered({value: 0, unit: "ms", unitClass: "u"}),
            {value: 0, unit: "ms", unitClass: "u"});
        assert.deepEqual(rendered({value: 12.5, unit: "MB/s", unitClass: "u"}),
            {value: 12.5, unit: "MB/s", unitClass: "u"});
    });
});
