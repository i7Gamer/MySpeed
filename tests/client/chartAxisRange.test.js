import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import i18next from "i18next";
import { LinearScale, defaults } from "chart.js";
import { chartThemeColors, lineChartOptions } from "../../client/src/pages/Statistics/charts/lineChartConfig.js";

/**
 * What a statistics line chart actually plots, run through chart.js's own scale.
 *
 * The x axis became a linear one measured in epoch milliseconds, and a linear
 * scale defaults to `bounds: 'ticks'` - it pushes the axis outward onto whole
 * multiples of the tick step counted from the Unix epoch. On an axis whose unit
 * is a millisecond that margin is a step of real time: a year of history stepped
 * in years drew on a two-year axis, most of it empty, with three ticks of which
 * one stood anywhere near a reading. chart.js's own time scale overrides the
 * same default to `bounds: 'data'` for exactly this reason, and the category
 * axis this replaced filled the width with ticks at real test timestamps.
 *
 * Asserting the option would only restate the fix, so the scale is driven here:
 * the numbers below are the ones chart.js computes.
 */
before(async () => {
    await i18next.init({lng: "en", fallbackLng: "en", resources: {en: {translation: {}}}});
});

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// A statistics chart across a desktop, and the line height of its tick font. A
// scale sizes its tick budget against the canvas it will be drawn on, and there
// is no canvas here.
const PLOT_WIDTH = 800;
const TICK_LINE_HEIGHT = 12;

// Enough points that the series is a series rather than its two ends.
const POINTS = 40;

const SERIES_START = Date.parse("2025-07-01T13:37:00.000Z");

const seriesOf = (span) => Array.from({length: POINTS}, (_, index) =>
    new Date(SERIES_START + (span * index) / (POINTS - 1)).toISOString());

/**
 * The axis chart.js builds from the options the chart hands it.
 *
 * Only the two lookups a scale makes into the chart it belongs to are stood in
 * for - how wide it is, and which way round it runs - because there is no chart
 * here. Everything else, the tick generation included, is chart.js's own.
 */
const axisOf = (labels, {isSingleDay = false} = {}) => {
    const x = lineChartOptions({
        themeColors: chartThemeColors(true),
        labels,
        errors: labels.map(() => null),
        failed: labels.map(() => false),
        isSingleDay,
        pointStyle: {radius: 3, hoverRadius: 6},
        lineTension: 0.35,
        use12h: false,
        valueUnit: "ms"
    }).scales.x;

    assert.ok(x.ticks.stepSize, "a series the chart gave no step is not what this harness drives");

    const scale = new LinearScale({id: "x", type: "linear", ctx: null, chart: null});

    // chart.js merges the scale defaults underneath whatever a config sets, so
    // an option the chart leaves out arrives as its default rather than as
    // undefined - which is the whole subject of this file.
    scale.options = {
        bounds: x.bounds ?? defaults.scale.bounds,
        min: x.min,
        max: x.max,
        reverse: x.reverse,
        ticks: {maxTicksLimit: x.ticks.maxTicksLimit, stepSize: x.ticks.stepSize}
    };

    // What determineDataLimits would read off the plotted points.
    const instants = labels.map((label) => Date.parse(label));
    scale.min = x.min ?? Math.min(...instants);
    scale.max = x.max ?? Math.max(...instants);

    scale.isHorizontal = () => true;
    scale._maxDigits = () => PLOT_WIDTH / TICK_LINE_HEIGHT;

    return {ticks: scale.buildTicks().map((tick) => tick.value), min: scale.min, max: scale.max};
};

// Five is the multi-day budget, and a range that draws only its own two ends has
// nothing to read the middle of the line against.
const MIN_TICKS = 3;

const RANGES = [
    {name: "a week", span: 7 * DAY},
    {name: "a month", span: 30 * DAY},
    {name: "a quarter", span: 90 * DAY},
    // Between the 90-day and 365-day steps, where the list had nothing to
    // offer: "All time" on an install that has been running a year.
    {name: "half a year", span: 180 * DAY},
    {name: "a year and a month", span: 400 * DAY},
    {name: "two years", span: 730 * DAY}
];

describe("the range a line chart plots", () => {
    for (const {name, span} of RANGES) {
        const labels = seriesOf(span);
        const earliest = Date.parse(labels[0]);
        const latest = Date.parse(labels[labels.length - 1]);

        it(`gives ${name} of history the whole width`, () => {
            const {min, max} = axisOf(labels);
            const dead = (max - min) - (latest - earliest);

            assert.equal(min, earliest,
                `the axis starts ${((earliest - min) / DAY).toFixed(0)} days before the first test`);
            assert.equal(max, latest,
                `the axis runs ${((max - latest) / DAY).toFixed(0)} days past the last test`);
            assert.equal(dead, 0);
        });

        it(`marks ${name} at instants the data covers`, () => {
            const {ticks} = axisOf(labels);
            const inside = ticks.filter((tick) => tick >= earliest && tick <= latest);

            assert.deepEqual(inside, ticks,
                `${ticks.length - inside.length} of ${ticks.length} ticks sit outside the history: ` +
                ticks.map((tick) => new Date(tick).toISOString()).join(", "));
            assert.ok(ticks.length >= MIN_TICKS,
                `${name} is divided by only ${ticks.length} ticks`);
        });
    }

    // The finer budget a single day gets is spent on that day, not on the margin
    // around it.
    it("gives one day the whole width too", () => {
        const labels = seriesOf(DAY);
        const {ticks, min, max} = axisOf(labels, {isSingleDay: true});

        assert.equal(min, Date.parse(labels[0]));
        assert.equal(max, Date.parse(labels[labels.length - 1]));
        assert.ok(ticks.length >= MIN_TICKS, `a day is divided by only ${ticks.length} ticks`);
    });

    /**
     * The margin was the axis's, not the ticks': every tick was a whole number
     * of steps from the epoch, so a day-or-larger step put them at 00:00 UTC -
     * an hour or two into the previous day for most of Europe. Anchored to the
     * data instead, the first tick is a time a test really ran.
     */
    it("starts its ticks at the first test rather than at a multiple of the epoch", () => {
        const labels = seriesOf(400 * DAY);

        assert.equal(axisOf(labels).ticks[0], Date.parse(labels[0]));
    });
});
