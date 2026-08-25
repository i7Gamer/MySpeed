import {t} from "i18next";
import {appLocale} from "@/common/utils/FormatUtil";

/**
 * The configuration the statistics charts share.
 *
 * The ping and speed charts carried byte-identical copies of everything here -
 * palette, motion tuning, tooltip, tick formatting, the average line, the
 * failure markers, the fill gradient - and the hourly chart a third copy of
 * the palette and tooltip. Copies drift: the two line charts already disagreed
 * about nothing but their y-step, and every theme tweak had to be made three
 * times to hold.
 *
 * Dates are formatted in the app's language rather than the browser's - the
 * ticks and tooltip titles were the last place still asking the browser, the
 * exact mismatch the overview's shared formatter was adopted to end.
 */
// Taken from FormatUtil rather than written out again here: this was the second
// copy, and while the two agreed, the three surfaces that had neither did not.

/**
 * The chart colours, read from the stylesheet that already declares them.
 *
 * This was a boolean and a column of hsl() literals - a second palette, in
 * JavaScript, restating what _colors.sass had already said. The seven
 * --chart-* properties it duplicated had, between them, zero readers: changing
 * a chart colour in the stylesheet moved nothing on screen, and the two
 * palettes were free to drift because nothing compared them.
 *
 * A boolean also cannot answer a third theme. It was `isDarkMode`, which the
 * theme has now outgrown - "system" resolves to one of two, but a palette does
 * not, and every colour below would have needed another branch.
 *
 * Read at call time rather than cached at module scope: the properties change
 * when the document's data-theme does, and the memo each chart wraps this in is
 * keyed on the resolved theme so it is asked again whenever that happens.
 */
const FALLBACK = "#8b99ab";

export const chartThemeColors = () => {
    const styles = typeof window !== "undefined" && typeof getComputedStyle === "function"
        ? getComputedStyle(document.documentElement)
        : null;

    // Trimmed: a custom property comes back with the whitespace that followed
    // the colon in the source, and Chart.js hands the string to the canvas
    // unchanged.
    const token = (name) => styles?.getPropertyValue(`--${name}`).trim() || FALLBACK;

    return {
        download: token("chart-download"),
        upload: token("chart-upload"),
        ping: token("chart-ping"),
        loaded: token("chart-loaded"),
        jitter: token("chart-jitter"),
        average: token("chart-average"),
        failed: token("chart-failed"),
        gridColor: token("chart-grid"),
        crosshair: token("chart-crosshair"),
        tickColor: token("chart-tick"),
        tooltipBg: token("chart-tooltip-bg"),
        tooltipTitle: token("chart-tooltip-title"),
        tooltipBody: token("chart-tooltip-body"),
        tooltipBorder: token("chart-tooltip-border")
    };
};

/** Quick draws, no colour/x animation, instant resizes - shared by every chart. */
export const chartMotion = {
    animation: {
        duration: 250,
        easing: 'easeOutQuart'
    },
    animations: {
        colors: false,
        x: false
    },
    transitions: {
        active: {
            animation: {
                duration: 100
            }
        },
        resize: {
            animation: {
                duration: 0
            }
        }
    }
};

export const tooltipTheme = (themeColors) => ({
    backgroundColor: themeColors.tooltipBg,
    titleColor: themeColors.tooltipTitle,
    bodyColor: themeColors.tooltipBody,
    borderColor: themeColors.tooltipBorder,
    borderWidth: 1,
    padding: 14,
    cornerRadius: 10,
    displayColors: true,
    boxPadding: 8
});

const instantOf = (label) => {
    const time = new Date(label).getTime();

    return Number.isFinite(time) ? time : null;
};

/**
 * The instants a series' labels name, read once.
 *
 * Pulling a timestamp out of a string is the expensive half of building a
 * chart, and everything below used to do it for itself: one recompute of the
 * ping chart read the same labels eight times over - its three datasets, the
 * average line, the failure markers, and the axis reading the span twice more
 * to choose its bounds and its step. At the thousand points the server will
 * hand over that is eight thousand parses saying what a thousand do.
 *
 * Kept against the array it was read from, which the charts replace whenever
 * the series changes rather than editing in place, and which is dropped with it.
 */
const parsedSeries = new WeakMap();

const instantsOf = (labels) => {
    const parsed = parsedSeries.get(labels);
    if (parsed) return parsed;

    const instants = labels.map((label) => instantOf(label));
    parsedSeries.set(labels, instants);

    return instants;
};

// A label that names no instant belongs to no day - and to the same no day as
// every other such label, exactly as they all used to read "Invalid Date".
const dayOf = (instant) => instant === null ? null : new Date(instant).toDateString();

/** Whether every label falls on one calendar day, which changes the tick format. */
export const isSingleDaySeries = (labels) =>
    new Set(instantsOf(labels).map(dayOf)).size === 1;

/**
 * A series placed on the clock rather than in a queue.
 *
 * The x axis used to be a category axis, which draws every point the same
 * distance from the last whatever the timestamps say. A test run by hand
 * between two scheduled ones, a night the tests were paused, an outage, a
 * changed interval - all of it rendered as an even cadence, so the shape of the
 * line described a history that never happened. Pairing each value with its own
 * instant lets the axis space them by the time between them, and a hole in the
 * history reads as a hole.
 *
 * An absent value stays absent - `{y: null}` is the gap chart.js draws nothing
 * for, where zero would be a reading. A label that names no instant yields an
 * empty point rather than being dropped: the tooltip looks `errors` and
 * `failed` up by data index, and removing an entry would shift every reason
 * onto the neighbouring test.
 */
export const timePoints = (labels, values) => instantsOf(labels).map((x, index) => {
    const y = values[index];

    return x === null
        ? {x: null, y: null}
        : {x, y: y === undefined ? null : y};
});

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * The intervals an axis is allowed to step in.
 *
 * Chart.js picks "nice" numbers for a linear axis, but nice in decimal terms -
 * on an axis measured in milliseconds that lands on steps like 5,000,000, an
 * hour and twenty-three minutes apart. These are the durations someone reading
 * a chart expects to see a tick at.
 *
 * Half a year is on the list because the gap either side of it was the widest:
 * a quarter is too fine to divide a year of history into five, so the step
 * chosen was a whole year, and "All time" on an install a year old was marked
 * at its two ends and nowhere in between.
 */
const TIME_STEPS = [
    MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE, 30 * MINUTE,
    HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR,
    DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 90 * DAY, 180 * DAY, 365 * DAY
];

/**
 * The ends of a series and how many of its labels named an instant at all.
 *
 * Folded rather than spread into Math.min/Math.max. The series is capped at
 * MAX_CHART_POINTS today, but the same spread is what put a RangeError in the
 * statistics aggregate, and the bound here is the server's to change.
 */
const timeSpanOf = (labels) => {
    let earliest = Infinity;
    let latest = -Infinity;
    let counted = 0;

    for (const instant of instantsOf(labels)) {
        if (instant === null) continue;

        if (instant < earliest) earliest = instant;
        if (instant > latest) latest = instant;
        counted++;
    }

    return {earliest, latest, counted};
};

/**
 * Half the window drawn around a series that names a single instant.
 *
 * Wide enough that the point sits in a readable hour rather than on a hairline,
 * narrow enough that the ticks either side of it are minutes rather than years.
 */
const SINGLE_POINT_PADDING = 30 * MINUTE;

/**
 * The x axis bounds to impose, or an empty object to let chart.js choose.
 *
 * A linear axis is measured in epoch milliseconds, and chart.js widens a range
 * whose min equals its max by five per cent *of the value* - five per cent of a
 * 2026 timestamp being a little over a thousand days. So a range holding one
 * test drew it in the middle of a six-year axis, ticks nineteen months apart
 * and not one of them near the reading. The category axis this replaced drew a
 * single tick at the test's own time.
 *
 * That is an ordinary install, not a corner: a fresh one, or "Today" looked at
 * shortly after the day's first test. Several tests sharing an instant - two
 * rows imported with the same `created` - have no width either.
 *
 * A series that does span time is left alone: it spaces its own points, and
 * chart.js pads it proportionately.
 */
export const timeAxisBounds = (labels) => {
    const {earliest, latest, counted} = timeSpanOf(labels);

    // Nothing placeable at all, so there is no instant to build a window
    // around; imposing one would invent a window around the epoch.
    if (counted === 0) return {};

    if (latest > earliest) return {};

    return {min: earliest - SINGLE_POINT_PADDING, max: latest + SINGLE_POINT_PADDING};
};

/**
 * The tick interval for a series, or undefined to let chart.js decide.
 *
 * Undefined for anything with no span to divide - an empty series, a single
 * point, every test at the same instant - where any step at all would be
 * arbitrary. timeAxisBounds above is what keeps those cases readable.
 */
export const timeAxisStep = (labels, maxTicks) => {
    const {earliest, latest, counted} = timeSpanOf(labels);

    if (counted < 2) return undefined;

    const span = latest - earliest;
    if (span <= 0) return undefined;

    const ideal = span / Math.max(1, maxTicks - 1);

    return TIME_STEPS.find((step) => step >= ideal) ?? TIME_STEPS[TIME_STEPS.length - 1];
};

const AVERAGE_DECIMALS_FACTOR = 100;

/**
 * The dashed average line's value: measured points only, two decimals.
 *
 * Null when nothing was measured, so the caller can leave the line off. Zero is
 * a reading - "this line delivered nothing" - and both charts drew it for a
 * range in which every test failed: a dashed line along the axis labelled
 * "Average" with a tooltip reading "Average: 0 Mbps", while the average card
 * beside it correctly said N/A for the same range.
 */
export const seriesAverage = (values) => {
    const valid = values.filter((value) => value !== null && value !== undefined && value > 0);
    if (valid.length === 0) return null;

    return Math.round((valid.reduce((a, b) => a + b, 0) / valid.length) * AVERAGE_DECIMALS_FACTOR)
        / AVERAGE_DECIMALS_FACTOR;
};

/** A failure sits on the axis (0); everything else stays off the series (null). */
export const failureMarkers = (failed) => failed.map((isFailed) => isFailed ? 0 : null);

/**
 * A colour at an alpha, whatever notation it arrived in.
 *
 * This only knew hsl(): swap the name for `hsla` and put a comma before the
 * closing bracket. Every colour it was ever handed was an hsl() literal written
 * three lines away, so that held - and stopped holding the moment the palette
 * moved into the stylesheet, because a custom property comes back as the hex it
 * was declared as. The replace would have found nothing to replace and handed
 * `#0891b2` back unchanged for both stops of a gradient, drawing a flat fill at
 * full opacity over the chart below it.
 */
export const withAlpha = (color, alpha) => {
    const hex = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(String(color).trim());

    if (hex) {
        const pairs = hex[1].length === 3 ? [...hex[1]].map((digit) => digit + digit) : hex[1].match(/../g);

        return `rgba(${pairs.map((pair) => parseInt(pair, 16)).join(", ")}, ${alpha})`;
    }

    // The a-form of whichever function it is. Sliced to three arguments so a
    // value that already carries an alpha has that one replaced rather than a
    // second one appended, which is not a colour any canvas would take.
    const functional = /^(hsl|rgb)a?\((.+)\)$/i.exec(String(color).trim());

    if (functional) {
        const parts = functional[2].split(",").slice(0, 3).map((part) => part.trim());

        return `${functional[1].toLowerCase()}a(${parts.join(", ")}, ${alpha})`;
    }

    return color;
};

const GRADIENT_FLOOR_ALPHA = 0.01;
const DEFAULT_PEAK_ALPHA = 0.25;

/** The fill under a line: its own colour, fading to nothing at the bottom. */
export const verticalGradientFill = (color, peakAlpha = DEFAULT_PEAK_ALPHA) => (context) => {
    const ctx = context.chart.ctx;
    const gradient = ctx.createLinearGradient(0, 0, 0, context.chart.height);
    gradient.addColorStop(0, withAlpha(color, peakAlpha));
    gradient.addColorStop(1, withAlpha(color, GRADIENT_FLOOR_ALPHA));
    return gradient;
};

/**
 * The dashed average line. `order` differs per chart - it sits behind the data.
 *
 * `color` comes from chartThemeColors.average rather than a literal here, so the
 * line follows the theme like every other mark. Defaulted, because both callers
 * pass it and a third that forgets should draw a visible line rather than none.
 */
export const averageLineDataset = (labels, average, order, color = FALLBACK) => ({
    label: t("statistics.average"),
    data: timePoints(labels, labels.map(() => average)),
    borderColor: color,
    backgroundColor: 'transparent',
    borderWidth: 2,
    borderDash: [6, 4],
    pointRadius: 0,
    pointHoverRadius: 0,
    fill: false,
    order
});

/**
 * The red crosses marking failed tests along the axis.
 *
 * One colour where there were two. A crossRot has no interior - the canvas
 * strokes it - so `pointBackgroundColor` was never what anyone saw, and the two
 * shades were a distinction with nothing on screen to carry it.
 */
export const failedMarkersDataset = (labels, markers, compact, color = FALLBACK) => ({
    label: t("statistics.failed_test"),
    data: timePoints(labels, markers),
    borderColor: 'transparent',
    backgroundColor: color,
    pointBackgroundColor: color,
    pointBorderColor: color,
    pointBorderWidth: compact ? 1 : 2,
    pointRadius: compact ? 3 : 6,
    pointHoverRadius: compact ? 4 : 8,
    pointStyle: 'crossRot',
    showLine: false,
    fill: false,
    order: 0
});

// Inside one day the hours carry the information; across days five marks are
// all the axis has room for once each carries a date.
const SINGLE_DAY_TICKS = 12;
const MULTI_DAY_TICKS = 5;

const maxTicksFor = (isSingleDay) => isSingleDay ? SINGLE_DAY_TICKS : MULTI_DAY_TICKS;

/**
 * The whole options object of a statistics line chart.
 *
 * @param themeColors from chartThemeColors
 * @param labels      the ISO timestamps under the points
 * @param errors      per-point error text, for the tooltip of a failure
 * @param isSingleDay from isSingleDaySeries, decides the tick format
 * @param pointStyle  from pointStyleFor - the density-aware marker size
 * @param lineTension from lineTensionFor
 * @param use12h      the stored clock preference
 * @param valueUnit   appended to every tooltip value line
 * @param yStepSize   optional fixed y-tick step (the speed charts use 100)
 */
export const lineChartOptions = ({
    themeColors, labels, errors, isSingleDay,
    pointStyle, lineTension, use12h, valueUnit, yStepSize
}) => ({
    responsive: true,
    maintainAspectRatio: false,
    resizeDelay: 100,
    ...chartMotion,
    plugins: {
        tooltip: {
            ...tooltipTheme(themeColors),
            /*
             * No filter on the failure markers, though they are kept out of the
             * legend below.
             *
             * `filter: (item) => item.dataset.label !== failed_test` used to sit
             * here, and it took out the only dataset that has anything to say at
             * a failed index: every measurement series holds null there -
             * buildStatistics puts that gap in deliberately, so the line reads as
             * a hole rather than as a reading of zero - and the marker carries
             * the reason. So the `label` branch written to name that reason could
             * never run, and what an operator saw instead came from `afterBody`,
             * as a note appended to whatever else happened to be in the tooltip.
             *
             * What else happened to be there was the dashed average, which holds
             * the same value at every index including the failed ones. That is
             * why this went unnoticed: on any range where at least one test
             * succeeded the tooltip still opened, reading "Average: …" with the
             * failure noted underneath. It is only where the average is absent -
             * a range in which every test failed, which is exactly when someone
             * is looking - that nothing was left after the filter and chart.js
             * drew no tooltip at all.
             *
             * Both go. `label` names the failure and its reason on every index
             * that has one, and `afterBody` keyed on nothing but that same
             * `failed[index]` - so keeping it would print the reason a second
             * time at every one of them, under whatever else the tooltip held.
             */
            callbacks: {
                title: (items) => {
                    if (items.length > 0) {
                        const date = new Date(labels[items[0].dataIndex]);
                        return date.toLocaleDateString(appLocale(), {weekday: 'short', day: 'numeric', month: 'short', year: 'numeric'}) +
                            ' ' + date.toLocaleTimeString(appLocale(), {hour: '2-digit', minute: '2-digit', hour12: use12h});
                    }
                    return '';
                },
                label: (item) => {
                    if (item.dataset.label === t("statistics.failed_test")) {
                        const error = errors[item.dataIndex];
                        return error ? `${t("statistics.failed_test")}: ${error}` : t("statistics.failed_test");
                    }
                    return `${item.dataset.label}: ${item.formattedValue} ${valueUnit}`;
                }
            }
        },
        legend: {
            position: "bottom",
            labels: {
                usePointStyle: true,
                pointStyle: 'circle',
                padding: 20,
                color: themeColors.tickColor,
                font: {
                    size: 12,
                    weight: 500
                },
                filter: (item) => item.text !== t("statistics.failed_test")
            }
        },
        // Handed to the plugin through the options rather than read from the
        // document inside it: afterDraw runs on every frame the pointer moves,
        // and this object is already rebuilt whenever the theme changes.
        crosshair: {
            color: themeColors.crosshair
        }
    },
    scales: {
        // Linear, over the timestamps the points carry, rather than the category
        // axis this used to be: that one spaced every point equally whatever the
        // clock said, so an outage, a pause or a manually run test all drew as a
        // regular interval and the line described a history that never happened.
        x: {
            type: 'linear',
            // The data's own range, rather than the linear default of widening
            // the axis onto whole multiples of the tick step counted from the
            // epoch. A step is real time here, so a year of history stepped in
            // years drew on a two-year axis - half of it empty, and of the
            // three ticks there was then room for, only one stood anywhere near
            // a reading. Chart.js's own time scale overrides the same default
            // for the same reason.
            bounds: 'data',
            // Imposed only where there is no span for chart.js to work from -
            // otherwise it would pad a zero-width range by a proportion of the
            // timestamp itself, which is measured in years.
            ...timeAxisBounds(labels),
            reverse: false,
            grid: {
                color: themeColors.gridColor,
                drawBorder: false
            },
            border: {
                display: false
            },
            ticks: {
                color: themeColors.tickColor,
                maxTicksLimit: maxTicksFor(isSingleDay),
                // A tick now sits wherever the axis puts it rather than on a data
                // point, so the instant is the value itself - there is no index
                // to look up.
                stepSize: timeAxisStep(labels, maxTicksFor(isSingleDay)),
                callback: (value) => {
                    const date = new Date(value);
                    if (isSingleDay) {
                        return date.toLocaleTimeString(appLocale(), {hour: "2-digit", minute: "2-digit", hour12: use12h});
                    }
                    return date.toLocaleDateString(appLocale(), {month: 'short', day: 'numeric'}) + ' ' +
                        date.toLocaleTimeString(appLocale(), {hour: "2-digit", minute: "2-digit", hour12: use12h});
                }
            }
        },
        y: {
            beginAtZero: true,
            grid: {
                color: themeColors.gridColor,
                drawBorder: false
            },
            border: {
                display: false
            },
            ticks: {
                color: themeColors.tickColor,
                ...(yStepSize ? {stepSize: yStepSize} : {})
            }
        }
    },
    interaction: {
        intersect: false,
        mode: 'index'
    },
    elements: {
        line: {
            tension: lineTension,
            borderWidth: 2.5
        },
        point: {
            radius: pointStyle.radius,
            hoverRadius: pointStyle.hoverRadius,
            hoverBorderWidth: 2
        }
    }
});
