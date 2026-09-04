import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {readSource, withoutJsComments, bodyOf} from "../helpers/source.js";

/**
 * The charts format their axis ticks in the app's locale, not the browser's.
 *
 * chart.js formats a numeric tick with Intl through `options.locale`, and
 * leaves that undefined - which Intl reads as "whatever the browser says".
 * Every figure the app prints itself goes through appLocale(), so a German
 * browser looking at an English-language MySpeed read "1.000" on the axis
 * beside "1,000" in the tooltip the app formatted. Both option builders name
 * the locale.
 */
const BUILDERS = [
    {file: "client/src/pages/Statistics/charts/lineChartConfig.js", opener: "export const lineChartOptions = ("},
    {file: "client/src/pages/Statistics/charts/HourlyChart.jsx", opener: "const chartOptions = useMemo(() => ("},
];

describe("the chart options", () => {
    for (const {file, opener} of BUILDERS) {
        it(`in ${file.split("/").pop()} name the app's locale`, () => {
            const source = withoutJsComments(readSource(file));
            assert.match(source, /\bappLocale\b[^\n]*from "/, "appLocale is not imported");
            assert.match(bodyOf(source, opener), /\blocale: appLocale\(\)/);
        });
    }
});
