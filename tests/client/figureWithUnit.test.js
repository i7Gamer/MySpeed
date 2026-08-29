import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const read = (file) => fs.readFileSync(path.join(CLIENT_SRC, file), "utf8");

const component = read("common/components/FigureWithUnit/FigureWithUnit.jsx");
const row = read("pages/Home/components/Speedtest/SpeedtestComponent.jsx");
const pane = read("common/components/TestDetails/TestDetails.jsx");

/**
 * The JSX twin of formatWithUnit, for the one shape the string form cannot
 * serve: a value whose unit needs its own styled span. Everything that renders
 * a figure beside a styled unit goes through it, so the refusal - N/A for the
 * placeholder, junk and an absent column - is decided once, by the same
 * judgement the string-printing views use.
 *
 * The behaviour table lives with formatWithUnit's own suite; what is pinned
 * here is the delegation and the wiring, because those are what let the two
 * forms drift: a component that re-judges the value can disagree with the
 * card printed beside it, and a call site that goes back to gluing the value
 * to its span reopens exactly the raw prints this component closed.
 */
describe("the one renderer for a figure beside its styled unit", () => {
    it("delegates the judgement to formatWithUnit rather than re-deciding it", () => {
        assert.match(component, /formatWithUnit\(value, unit\) === NOT_MEASURED \? NOT_MEASURED/,
            "the component re-judges the value, so the JSX and string forms can drift apart");
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
