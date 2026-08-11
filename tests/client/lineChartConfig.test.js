import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import i18next from "i18next";
import {
    averageLineDataset, chartMotion, chartThemeColors, failedMarkersDataset, failureMarkers,
    isSingleDaySeries, lineChartOptions, seriesAverage, tooltipTheme, verticalGradientFill
} from "../../client/src/pages/Statistics/charts/lineChartConfig.js";

/**
 * The shared configuration behind the three statistics charts. Ping and speed
 * carried byte-identical copies of all of it - theme palette, tooltip, tick
 * formatting, the average line, the failure markers - and the hourly chart a
 * third copy of the palette. One module, so the next change happens once.
 *
 * i18next answers with the key itself for anything unknown, which is exactly
 * what these assertions pin against.
 */
before(async () => {
    await i18next.init({lng: "en", fallbackLng: "en", resources: {en: {translation: {}}}});
});

const LABELS = ["2026-08-09T10:00:00.000Z", "2026-08-09T14:00:00.000Z", "2026-08-10T09:00:00.000Z"];

const options = (overrides = {}) => lineChartOptions({
    themeColors: chartThemeColors(true),
    labels: LABELS,
    errors: [null, "Too many requests", null],
    failed: [false, true, false],
    isSingleDay: false,
    pointStyle: {radius: 3, hoverRadius: 6},
    lineTension: 0.35,
    use12h: false,
    valueUnit: "Mbps",
    ...overrides
});

describe("chartThemeColors", () => {
    it("answers both themes with the full palette", () => {
        for (const dark of [true, false]) {
            const colors = chartThemeColors(dark);
            for (const key of ["gridColor", "tickColor", "tooltipBg", "tooltipTitle", "tooltipBody", "tooltipBorder"])
                assert.ok(colors[key], `${key} missing in ${dark ? "dark" : "light"}`);
        }
    });

    it("does not hand the dark palette to the light theme", () => {
        assert.notEqual(chartThemeColors(true).tooltipBg, chartThemeColors(false).tooltipBg);
    });
});

describe("isSingleDaySeries", () => {
    it("recognises one day, in any timezone the labels land in", () => {
        assert.equal(isSingleDaySeries(["2026-08-09T10:00:00.000Z", "2026-08-09T11:00:00.000Z"]), true);
    });

    it("recognises a span of days", () => {
        assert.equal(isSingleDaySeries(LABELS), false);
    });

    it("does not call an empty series a single day", () => {
        assert.equal(isSingleDaySeries([]), false);
    });
});

describe("seriesAverage", () => {
    it("averages the measured values to two decimals", () => {
        assert.equal(seriesAverage([10, 20, 25.555]), 18.52);
    });

    it("skips gaps and zeroes rather than dragging the line down", () => {
        assert.equal(seriesAverage([null, undefined, 0, 30]), 30);
    });

    /**
     * Null, not zero. Zero is a reading - "this line delivered nothing" - and
     * both line charts added the average dataset unconditionally, so a range in
     * which every test failed drew a dashed line along the axis labelled
     * "Average" with a tooltip reading "Average: 0 Mbps". The AverageChart card
     * beside it correctly said N/A for the same range, and `tests.total` counts
     * failures so the page never reached its empty state.
     */
    it("answers null when nothing was measured", () => {
        assert.equal(seriesAverage([]), null);
        assert.equal(seriesAverage([null, null]), null);
        assert.equal(seriesAverage([0, 0]), null, "a range in which every test failed measured nothing");
    });
});

describe("the charts that draw the average", () => {
    const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");
    const read = (file) => fs.readFileSync(path.join(CLIENT_SRC, file), "utf8");

    for (const chart of ["pages/Statistics/charts/SpeedChart/SpeedChart.jsx",
        "pages/Statistics/charts/PingChart.jsx"]) {
        const source = read(chart);
        const name = path.basename(chart, ".jsx");

        it(`${name} leaves the line off when there is no average`, () => {
            assert.match(source, /average !== null \? \[averageLineDataset\(/,
                `${name} still draws an average line for a range that measured nothing`);
        });

        it(`${name} does not fall back to zero`, () => {
            assert.doesNotMatch(source, /average: 0/,
                `${name} still seeds its empty state with a measured-looking zero`);
        });
    }
});

describe("failureMarkers", () => {
    it("marks failures on the axis and leaves the rest empty", () => {
        assert.deepEqual(failureMarkers([false, true, false]), [null, 0, null]);
    });
});

describe("datasets", () => {
    it("draws the average as a dashed, pointless line", () => {
        const dataset = averageLineDataset(LABELS, 42, 4);

        assert.deepEqual(dataset.data, [42, 42, 42]);
        assert.deepEqual(dataset.borderDash, [6, 4]);
        assert.equal(dataset.pointRadius, 0);
        assert.equal(dataset.order, 4);
    });

    it("sizes the failure markers for the layout", () => {
        assert.equal(failedMarkersDataset([null, 0], true).pointRadius, 3);
        assert.equal(failedMarkersDataset([null, 0], false).pointRadius, 6);
        assert.equal(failedMarkersDataset([null, 0], false).pointStyle, "crossRot");
    });

    it("builds the fill gradient from the line's own colour", () => {
        const stops = [];
        const context = {chart: {height: 100, ctx: {createLinearGradient: () => ({
            addColorStop: (offset, color) => stops.push([offset, color])
        })}}};

        verticalGradientFill("hsl(38, 92%, 50%)", 0.25)(context);

        assert.deepEqual(stops, [
            [0, "hsla(38, 92%, 50%, 0.25)"],
            [1, "hsla(38, 92%, 50%, 0.01)"]
        ]);
    });
});

describe("lineChartOptions", () => {
    it("shows more ticks inside a single day", () => {
        assert.equal(options({isSingleDay: true}).scales.x.ticks.maxTicksLimit, 12);
        assert.equal(options().scales.x.ticks.maxTicksLimit, 5);
    });

    it("keeps the failure markers out of the tooltip and the legend", () => {
        const built = options();
        const failedLabel = {dataset: {label: "statistics.failed_test"}};

        assert.equal(built.plugins.tooltip.filter(failedLabel), false);
        assert.equal(built.plugins.legend.labels.filter({text: "statistics.failed_test"}), false);
        assert.equal(built.plugins.tooltip.filter({dataset: {label: "anything else"}}), true);
    });

    it("appends the metric's unit to the tooltip line", () => {
        const line = options().plugins.tooltip.callbacks.label(
            {dataset: {label: "Download"}, formattedValue: "100", dataIndex: 0});

        assert.equal(line, "Download: 100 Mbps");
    });

    it("names the failure and its reason in the tooltip body", () => {
        const body = options().plugins.tooltip.callbacks.afterBody([{dataIndex: 1}]);

        assert.match(body, /Too many requests/);
    });

    it("only sets a y step when one is asked for", () => {
        assert.equal(options().scales.y.ticks.stepSize, undefined);
        assert.equal(options({yStepSize: 100}).scales.y.ticks.stepSize, 100);
    });

    /**
     * The ticks and tooltip titles used to ask for the browser's locale, while
     * everything else on the page follows the language the app is set to - the
     * exact mismatch the overview's shared formatter was adopted to end.
     */
    it("formats the ticks in the app's language, not the browser's", async () => {
        await i18next.changeLanguage("de");
        try {
            const tick = options().scales.x.ticks.callback(0, 0);
            const date = new Date(LABELS[0]);
            const expected = date.toLocaleDateString("de", {month: "short", day: "numeric"}) + " " +
                date.toLocaleTimeString("de", {hour: "2-digit", minute: "2-digit", hour12: false});

            assert.equal(tick, expected);
        } finally {
            await i18next.changeLanguage("en");
        }
    });

    it("carries the shared motion tuning", () => {
        const built = options();

        assert.deepEqual(built.animation, chartMotion.animation);
        assert.deepEqual(built.transitions, chartMotion.transitions);
    });

    it("themes the tooltip from the palette", () => {
        const colors = chartThemeColors(true);

        assert.equal(options().plugins.tooltip.backgroundColor, tooltipTheme(colors).backgroundColor);
    });
});
