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
    data: labels.map(() => average),
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
export const failedMarkersDataset = (markers, compact) => ({
    label: t("statistics.failed_test"),
    data: markers,
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
        x: {
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
                maxTicksLimit: isSingleDay ? SINGLE_DAY_TICKS : MULTI_DAY_TICKS,
                callback: (value, index) => {
                    const date = new Date(labels[index]);
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
