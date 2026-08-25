import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import i18next from "i18next";
import {
    averageLineDataset, chartMotion, chartThemeColors, failedMarkersDataset, failureMarkers,
    isSingleDaySeries, lineChartOptions, seriesAverage, timeAxisBounds, timeAxisStep, timePoints,
    tooltipTheme, verticalGradientFill
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
    themeColors: chartThemeColors(),
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

/*
 * There is no document here, so every property comes back as the fallback. The
 * theme's own answers cannot be read without a browser - what the stylesheet
 * declares and what this asks it for are compared in chartPalette.test.js
 * instead, which reads the compiled CSS. What is left to check here is that no
 * caller is ever handed an empty string: chart.js takes one without complaint
 * and draws the mark in black.
 */
describe("chartThemeColors", () => {
    const SERIES = ["download", "upload", "ping", "loaded", "jitter", "average", "failed"];
    const CHROME = ["gridColor", "crosshair", "tickColor", "tooltipBg", "tooltipTitle", "tooltipBody", "tooltipBorder"];

    it("answers every mark and every piece of chrome", () => {
        const colors = chartThemeColors();

        for (const key of [...SERIES, ...CHROME]) assert.ok(colors[key], `${key} came back empty`);
    });

    it("falls back to something visible where there is no document to ask", () => {
        for (const value of Object.values(chartThemeColors()))
            assert.match(value, /^#[\da-f]{6}$/i, "the fallback is not a colour a canvas would draw");
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

/**
 * Every point carries the instant it was measured at, not its position in the
 * list.
 *
 * The x axis used to be a category axis, which places points at equal intervals
 * whatever their timestamps say. A test run manually between two scheduled ones,
 * a paused night, an outage, a changed interval - all of it rendered as though
 * the tests had been evenly spaced, so the shape of the line said something the
 * data did not - upstream #791. On a linear axis the spacing is the elapsed
 * time, and a gap in the history looks like a gap.
 */
describe("timePoints", () => {
    it("places each value at the instant its label names", () => {
        assert.deepEqual(timePoints(LABELS, [10, 20, 30]), [
            {x: Date.parse(LABELS[0]), y: 10},
            {x: Date.parse(LABELS[1]), y: 20},
            {x: Date.parse(LABELS[2]), y: 30}
        ]);
    });

    // The distances between the points are the whole point: the first two are
    // four hours apart and the next is nineteen.
    it("spaces the points by the time between them", () => {
        const [first, second, third] = timePoints(LABELS, [1, 2, 3]);

        assert.equal(second.x - first.x, 4 * 3600 * 1000);
        assert.equal(third.x - second.x, 19 * 3600 * 1000);
    });

    it("keeps a gap a gap rather than dropping to zero", () => {
        assert.deepEqual(timePoints(LABELS, [10, null, 30]).map((point) => point.y), [10, null, 30]);
        assert.deepEqual(timePoints(LABELS, [10, undefined, 30]).map((point) => point.y), [10, null, 30]);
    });

    // A measured zero is a reading - "this line delivered nothing" - and must
    // not be confused with the absent value above.
    it("keeps a measured zero", () => {
        assert.equal(timePoints(LABELS, [0, 1, 2])[0].y, 0);
    });

    /**
     * An unplaceable point is emitted as an empty one rather than dropped: the
     * tooltip reads `errors` and `failed` by data index, so removing an entry
     * here would shift every reason onto the wrong test.
     */
    it("keeps its place for a label that names no instant", () => {
        const points = timePoints(["not a date", LABELS[1]], [10, 20]);

        assert.equal(points.length, 2);
        assert.deepEqual(points[0], {x: null, y: null});
        assert.equal(points[1].y, 20);
    });
});

/**
 * One reading of the labels per chart, not one per thing built from them.
 *
 * Pulling an instant out of a timestamp string is the expensive half of
 * building a series, and the ping chart asked for the same one eight times over
 * a single recompute: the ping, loaded-latency and jitter datasets, the average
 * line, the failure markers, and the axis reading the span twice more to choose
 * its bounds and its step. The server hands over up to a thousand points, so
 * that is eight thousand parses where a thousand say the same thing.
 */
describe("parsing the labels", () => {
    /**
     * How many timestamps were read while the work ran.
     *
     * The module looks `Date` up on the global at each call, so this counts the
     * parses it actually performs. Only a string costs anything - an instant is
     * already a number, and building a Date from one parses nothing. Both
     * spellings of reading a string count, `new Date(label)` and
     * `Date.parse(label)`: they are the same parse, and trading one for the
     * other must not read as the cache breaking.
     */
    const parsesDuring = (work) => {
        const RealDate = globalThis.Date;
        let parses = 0;

        globalThis.Date = class extends RealDate {
            constructor(...args) {
                if (typeof args[0] === "string") parses++;
                super(...args);
            }

            static parse(...args) {
                if (typeof args[0] === "string") parses++;
                return RealDate.parse(...args);
            }
        };

        try {
            work();
        } finally {
            globalThis.Date = RealDate;
        }

        return parses;
    };

    it("counts what it is watching for", () => {
        assert.equal(parsesDuring(() => new Date("2026-08-09T10:00:00.000Z")), 1);
        assert.equal(parsesDuring(() => Date.parse("2026-08-09T10:00:00.000Z")), 1);
        assert.equal(parsesDuring(() => new Date(0)), 0);
        assert.equal(parsesDuring(() => new Date(new Date(0))), 0);
    });

    // Everything one PingChart recompute builds out of one series.
    const buildEveryDataset = (labels) => {
        const values = labels.map((_, index) => index);

        isSingleDaySeries(labels);
        lineChartOptions({
            themeColors: chartThemeColors(), labels, errors: labels.map(() => null),
            failed: labels.map(() => false), isSingleDay: false,
            pointStyle: {radius: 3, hoverRadius: 6}, lineTension: 0.35, use12h: false, valueUnit: "ms"
        });
        timePoints(labels, values);
        timePoints(labels, values);
        timePoints(labels, values);
        averageLineDataset(labels, 42, 4);
        failedMarkersDataset(labels, failureMarkers(labels.map(() => false)), false);
    };

    it("reads each label once, whatever is built from it", () => {
        // Its own array: a series is read once and the answer kept against the
        // array it came from, and the shared LABELS have been read already.
        const labels = [...LABELS];

        assert.equal(parsesDuring(() => buildEveryDataset(labels)), labels.length);
    });

    it("reads a series it has not seen before", () => {
        const labels = LABELS.map((label) => new Date(Date.parse(label) + 1000).toISOString());

        assert.equal(parsesDuring(() => buildEveryDataset(labels)), labels.length);
    });

    // The saving is worthless if a series is answered with another's instants.
    it("keeps each series' own instants", () => {
        const first = ["2026-08-09T10:00:00.000Z"];
        const second = ["2026-08-10T10:00:00.000Z"];

        assert.equal(timePoints(first, [1])[0].x, Date.parse(first[0]));
        assert.equal(timePoints(second, [1])[0].x, Date.parse(second[0]));
        // The day between the two of them, in five ticks: six hours.
        assert.equal(timeAxisStep([...first, ...second], 5), 6 * 60 * 60 * 1000);
    });

    // A label that names no instant is not a day, exactly as it was never a
    // readable date before - all of them collapse onto one another.
    it("still tells a single day from a series it cannot place", () => {
        assert.equal(isSingleDaySeries(["not a date", "nor this"]), true);
        assert.equal(isSingleDaySeries(["not a date", LABELS[0]]), false);
    });
});

describe("datasets", () => {
    it("draws the average as a dashed, pointless line", () => {
        const dataset = averageLineDataset(LABELS, 42, 4);

        assert.deepEqual(dataset.data, timePoints(LABELS, [42, 42, 42]));
        assert.deepEqual(dataset.borderDash, [6, 4]);
        assert.equal(dataset.pointRadius, 0);
        assert.equal(dataset.order, 4);
    });

    it("sizes the failure markers for the layout", () => {
        assert.equal(failedMarkersDataset(LABELS, [null, 0, null], true).pointRadius, 3);
        assert.equal(failedMarkersDataset(LABELS, [null, 0, null], false).pointRadius, 6);
        assert.equal(failedMarkersDataset(LABELS, [null, 0, null], false).pointStyle, "crossRot");
    });

    it("puts each failure marker at the instant that test failed", () => {
        const dataset = failedMarkersDataset(LABELS, failureMarkers([false, true, false]), false);

        assert.deepEqual(dataset.data, [
            {x: Date.parse(LABELS[0]), y: null},
            {x: Date.parse(LABELS[1]), y: 0},
            {x: Date.parse(LABELS[2]), y: null}
        ]);
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

/**
 * Chart.js's own "nice" tick stepping is nice in decimal terms, which for
 * milliseconds means ticks every 5,000,000 of them - one hour and twenty-three
 * minutes. The step is chosen from durations a person reads instead.
 */
describe("timeAxisStep", () => {
    const MINUTE = 60 * 1000;
    const HOUR = 60 * MINUTE;
    const DAY = 24 * HOUR;

    const spanOf = (ms) => ["2026-08-09T00:00:00.000Z", new Date(Date.parse("2026-08-09T00:00:00.000Z") + ms).toISOString()];

    it("steps a day in hours and a fortnight in days", () => {
        assert.equal(timeAxisStep(spanOf(DAY), 12), 3 * HOUR);
        assert.equal(timeAxisStep(spanOf(14 * DAY), 5), 7 * DAY);
    });

    it("steps a short range in minutes", () => {
        assert.equal(timeAxisStep(spanOf(30 * MINUTE), 5), 10 * MINUTE);
    });

    /**
     * Nothing on the list stood between a quarter and a year, so a year and a
     * bit of history - "All time" on an install that has been running that long
     * - was divided in years: one tick at each end and nothing between them.
     */
    it("halves a year rather than stepping a whole one", () => {
        assert.equal(timeAxisStep(spanOf(400 * DAY), 5), 180 * DAY);
    });

    /**
     * The rule the numbers above are instances of: the finest step on the list
     * that still fits inside the tick budget. A step any smaller would overrun
     * maxTicksLimit and chart.js would drop labels back out again.
     */
    it("picks the finest step that stays inside the tick budget", () => {
        for (const span of [30 * MINUTE, 6 * HOUR, DAY, 3 * DAY, 14 * DAY, 200 * DAY]) {
            for (const maxTicks of [5, 12]) {
                const step = timeAxisStep(spanOf(span), maxTicks);

                assert.ok(span / step <= maxTicks - 1,
                    `${span}ms in ${maxTicks} ticks: a ${step}ms step overruns the budget`);
            }
        }
    });

    it("never steps below a minute", () => {
        assert.equal(timeAxisStep(spanOf(10 * 1000), 5), MINUTE);
    });

    // The axis is read left to right whatever order the series arrived in.
    it("reads the span regardless of which end comes first", () => {
        const [from, to] = spanOf(DAY);

        assert.equal(timeAxisStep([to, from], 12), timeAxisStep([from, to], 12));
    });

    it("leaves the step to chart.js when there is no span to divide", () => {
        assert.equal(timeAxisStep([], 5), undefined);
        assert.equal(timeAxisStep([LABELS[0]], 5), undefined);
        assert.equal(timeAxisStep([LABELS[0], LABELS[0]], 5), undefined);
        assert.equal(timeAxisStep(["not a date", "nor this"], 5), undefined);
    });
});

/**
 * A series with no width of its own still has to draw on a sensible axis.
 *
 * A linear axis is measured in epoch milliseconds, and chart.js widens a range
 * whose min equals its max by five per cent *of the value* - five per cent of a
 * 2026 timestamp being a little over a thousand days. So a range holding a
 * single test drew that test in the middle of a six-year axis, with ticks
 * nineteen months apart and no two of them near the reading. The category axis
 * this replaced simply drew one tick at the test's own time.
 *
 * Reachable on an ordinary install: a fresh one, or "Today" looked at shortly
 * after the day's first test. Statistics only shows its empty state when the
 * range holds no tests at all, so one test renders the charts.
 */
describe("timeAxisBounds", () => {
    const HALF_HOUR = 30 * 60 * 1000;
    const DAY = 24 * 60 * 60 * 1000;

    // A series that already spans time spaces its own points, and chart.js
    // pads it proportionately. Nothing to impose.
    it("leaves a series that spans time to chart.js", () => {
        assert.deepEqual(timeAxisBounds(LABELS), {});
    });

    it("puts a window around a single point", () => {
        const instant = Date.parse(LABELS[0]);

        assert.deepEqual(timeAxisBounds([LABELS[0]]),
            {min: instant - HALF_HOUR, max: instant + HALF_HOUR});
    });

    // Several tests sharing an instant have no width either - two rows imported
    // with the same `created`, say.
    it("puts a window around a series whose points share an instant", () => {
        const instant = Date.parse(LABELS[0]);

        assert.deepEqual(timeAxisBounds([LABELS[0], LABELS[0], LABELS[0]]),
            {min: instant - HALF_HOUR, max: instant + HALF_HOUR});
    });

    // Nothing placeable: leave the axis alone rather than invent a window
    // around an epoch of zero.
    it("leaves an unplaceable series alone entirely", () => {
        assert.deepEqual(timeAxisBounds([]), {});
        assert.deepEqual(timeAxisBounds(["not a date", "nor this"]), {});
    });

    /**
     * The property the whole thing exists for, stated without reference to the
     * padding above: one test must not draw a multi-year axis.
     */
    it("keeps a single point's axis inside a day", () => {
        const {min, max} = timeAxisBounds([LABELS[0]]);

        assert.ok(max - min <= DAY,
            `a single test spans ${((max - min) / DAY).toFixed(1)} days`);
    });
});

describe("lineChartOptions", () => {
    /**
     * A category axis draws every point the same distance from the last, so a
     * manual test wedged between two scheduled ones, or a night with no tests at
     * all, looked exactly like a regular interval - upstream #791.
     */
    it("measures the x axis in time rather than in points", () => {
        assert.equal(options().scales.x.type, "linear");
    });

    // The axis carries the bounds rather than merely offering them: chart.js is
    // only asked to choose where there is a span for it to choose within.
    it("bounds the axis itself when the series names one instant", () => {
        const {min, max} = options({labels: [LABELS[0]]}).scales.x;

        assert.deepEqual({min, max}, timeAxisBounds([LABELS[0]]));
    });

    it("leaves the axis unbounded for a series that spans time", () => {
        const {min, max} = options().scales.x;

        assert.equal(min, undefined);
        assert.equal(max, undefined);
    });

    it("steps the axis by a duration a person would read", () => {
        assert.equal(options().scales.x.ticks.stepSize, timeAxisStep(LABELS, 5));
        assert.equal(options({isSingleDay: true}).scales.x.ticks.stepSize, timeAxisStep(LABELS, 12));
    });

    it("shows more ticks inside a single day", () => {
        assert.equal(options({isSingleDay: true}).scales.x.ticks.maxTicksLimit, 12);
        assert.equal(options().scales.x.ticks.maxTicksLimit, 5);
    });

    // The tick is now placed at an instant of the axis's choosing rather than on
    // a data point, so the callback has to read the value it is handed instead
    // of looking the index up in the labels.
    it("labels a tick with the instant it sits at, not with a data point", () => {
        const instant = Date.parse("2026-08-09T18:30:00.000Z");
        const tick = options({isSingleDay: true}).scales.x.ticks.callback(instant, 0);

        assert.equal(tick, new Date(instant).toLocaleTimeString("en",
            {hour: "2-digit", minute: "2-digit", hour12: false}));
    });

    // The marker is a cross on the axis with no meaning of its own in a list of
    // series, so it stays out of the legend. The tooltip is the opposite case -
    // see below.
    it("keeps the failure markers out of the legend", () => {
        assert.equal(options().plugins.legend.labels.filter({text: "statistics.failed_test"}), false);
    });

    it("appends the metric's unit to the tooltip line", () => {
        const line = options().plugins.tooltip.callbacks.label(
            {dataset: {label: "Download"}, formattedValue: "100", dataIndex: 0});

        assert.equal(line, "Download: 100 Mbps");
    });

    /**
     * The tooltip on a failed test, which used to be no tooltip at all.
     *
     * The options carried `filter: (item) => item.dataset.label !== failed_test`,
     * and every measurement series holds null where a test failed - buildStatistics
     * puts the gap there on purpose, so the line reads as a hole rather than as a
     * reading of zero. So at a failed index the failure marker is the *only*
     * dataset with a point, the filter removed it, and chart.js suppresses a
     * tooltip with no items left: hovering the red cross showed nothing, and the
     * `label` branch written to name the reason could never run. The one place an
     * operator goes to ask why a test failed was the one place that would not say.
     *
     * `afterBody` said it instead, which is why this went unnoticed on a bucket
     * that also held a successful test - there the tooltip had a line to attach
     * itself to. It is gone now: with the filter lifted, `label` names the failure
     * on both, and keeping both printed the reason twice.
     */
    describe("the tooltip on a failed test", () => {
        const failedItem = {dataset: {label: "statistics.failed_test"}, dataIndex: 1, formattedValue: "0"};

        it("is not suppressed by a filter", () => {
            const built = options();

            assert.equal(built.plugins.tooltip.filter?.(failedItem) ?? true, true,
                "the only dataset with a point at that index is dropped, so no tooltip is drawn at all");
        });

        it("names the failure and the reason it carries", () => {
            const line = options().plugins.tooltip.callbacks.label(failedItem);

            assert.match(line, /statistics\.failed_test/, "the tooltip line does not say the test failed");
            assert.match(line, /Too many requests/, "the reason the run recorded is not shown");
        });

        it("still names the failure when no reason was recorded", () => {
            const line = options().plugins.tooltip.callbacks.label(
                {...failedItem, dataIndex: 0});

            assert.match(line, /statistics\.failed_test/);
        });

        // Two callbacks naming the same failure printed it twice on any bucket
        // that held a successful test beside it.
        it("says it once", () => {
            assert.equal(options().plugins.tooltip.callbacks.afterBody, undefined,
                "the reason is printed by both the label and the body");
        });
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
            const instant = Date.parse(LABELS[0]);
            const tick = options().scales.x.ticks.callback(instant, 0);
            const date = new Date(instant);
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
        const colors = chartThemeColors();

        assert.equal(options().plugins.tooltip.backgroundColor, tooltipTheme(colors).backgroundColor);
    });

    it("hands the crosshair its colour rather than letting the plugin look it up", () => {
        assert.equal(options().plugins.crosshair.color, chartThemeColors().crosshair);
    });
});
