import i18n, {t} from "i18next";

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
const appLocale = () => i18n.language || undefined;

export const chartThemeColors = (isDarkMode) => ({
    gridColor: isDarkMode ? 'rgba(42, 52, 65, 0.6)' : 'rgba(203, 213, 225, 0.8)',
    tickColor: isDarkMode ? 'hsl(215, 20%, 50%)' : 'hsl(215, 25%, 40%)',
    tooltipBg: isDarkMode ? 'hsl(215, 28%, 10%)' : 'hsl(0, 0%, 100%)',
    tooltipTitle: isDarkMode ? 'hsl(210, 40%, 96%)' : 'hsl(215, 25%, 20%)',
    tooltipBody: isDarkMode ? 'hsl(215, 20%, 65%)' : 'hsl(215, 15%, 40%)',
    tooltipBorder: isDarkMode ? 'hsl(215, 25%, 22%)' : 'hsl(215, 20%, 85%)'
});

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

/** Whether every label falls on one calendar day, which changes the tick format. */
export const isSingleDaySeries = (labels) =>
    new Set(labels.map((label) => new Date(label).toDateString())).size === 1;

const instantOf = (label) => {
    const time = new Date(label).getTime();

    return Number.isFinite(time) ? time : null;
};

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
export const timePoints = (labels, values) => labels.map((label, index) => {
    const x = instantOf(label);
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
 */
const TIME_STEPS = [
    MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE, 30 * MINUTE,
    HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR,
    DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 90 * DAY, 365 * DAY
];

/**
 * The tick interval for a series, or undefined to let chart.js decide.
 *
 * Undefined for anything with no span to divide - an empty series, a single
 * point, every test at the same instant - where any step at all would be
 * arbitrary.
 */
export const timeAxisStep = (labels, maxTicks) => {
    // Folded rather than spread into Math.min/Math.max. The series is capped at
    // MAX_CHART_POINTS today, but the same spread is what put a RangeError in
    // the statistics aggregate, and the bound here is the server's to change.
    let earliest = Infinity;
    let latest = -Infinity;
    let counted = 0;

    for (const label of labels) {
        const instant = instantOf(label);
        if (instant === null) continue;

        if (instant < earliest) earliest = instant;
        if (instant > latest) latest = instant;
        counted++;
    }

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

const withAlpha = (hsl, alpha) => hsl.replace('hsl', 'hsla').replace(')', `, ${alpha})`);

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

const AVERAGE_COLOR = 'hsl(330, 80%, 60%)';

/** The dashed average line. `order` differs per chart - it sits behind the data. */
export const averageLineDataset = (labels, average, order) => ({
    label: t("statistics.average"),
    data: timePoints(labels, labels.map(() => average)),
    borderColor: AVERAGE_COLOR,
    backgroundColor: 'transparent',
    borderWidth: 2,
    borderDash: [6, 4],
    pointRadius: 0,
    pointHoverRadius: 0,
    fill: false,
    order
});

const FAILED_COLOR = 'hsl(0, 72%, 51%)';
const FAILED_BORDER_COLOR = 'hsl(0, 84%, 60%)';

/** The red crosses marking failed tests along the axis. */
export const failedMarkersDataset = (labels, markers, compact) => ({
    label: t("statistics.failed_test"),
    data: timePoints(labels, markers),
    borderColor: 'transparent',
    backgroundColor: FAILED_COLOR,
    pointBackgroundColor: FAILED_COLOR,
    pointBorderColor: FAILED_BORDER_COLOR,
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
 * @param failed      per-point failure flags
 * @param isSingleDay from isSingleDaySeries, decides the tick format
 * @param pointStyle  from pointStyleFor - the density-aware marker size
 * @param lineTension from lineTensionFor
 * @param use12h      the stored clock preference
 * @param valueUnit   appended to every tooltip value line
 * @param yStepSize   optional fixed y-tick step (the speed charts use 100)
 */
export const lineChartOptions = ({
    themeColors, labels, errors, failed, isSingleDay,
    pointStyle, lineTension, use12h, valueUnit, yStepSize
}) => ({
    responsive: true,
    maintainAspectRatio: false,
    resizeDelay: 100,
    ...chartMotion,
    plugins: {
        tooltip: {
            ...tooltipTheme(themeColors),
            filter: (item) => item.dataset.label !== t("statistics.failed_test"),
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
                },
                afterBody: (items) => {
                    if (items.length > 0) {
                        const index = items[0].dataIndex;
                        if (failed[index]) {
                            const error = errors[index];
                            return error ? `\n⚠ ${t("statistics.failed_test")}: ${error}` : `\n⚠ ${t("statistics.failed_test")}`;
                        }
                    }
                    return '';
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
        }
    },
    scales: {
        // Linear, over the timestamps the points carry, rather than the category
        // axis this used to be: that one spaced every point equally whatever the
        // clock said, so an outage, a pause or a manually run test all drew as a
        // regular interval and the line described a history that never happened.
        x: {
            type: 'linear',
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
