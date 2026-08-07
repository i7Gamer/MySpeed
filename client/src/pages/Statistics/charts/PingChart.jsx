import ChartWrapper from "@/common/components/ChartWrapper";
import { useMemo, useContext, memo } from "react";
import { t } from "i18next";
import { ThemeContext } from "@/common/contexts/Theme";
import { PreferencesContext } from "@/common/contexts/Preferences";
import { TIME_FORMAT_12H } from "@/common/utils/FormatUtil";
import DownsampleNote from "@/pages/Statistics/components/DownsampleNote";
import { lineTensionFor, pointStyleFor } from "@/pages/Statistics/charts/pointDensity";
import "./SpeedChart/styles.sass";

const PingChart = memo(({ compact = false, ...props }) => {
    const [isDarkMode] = useContext(ThemeContext);
    const [preferences] = useContext(PreferencesContext);
    const use12h = preferences?.timeFormat === TIME_FORMAT_12H;

    const filteredData = useMemo(() => {
        if (!props.data?.ping || !props.labels) return { labels: [], data: [], jitter: [], average: 0, jitterAverage: 0, failed: [], errors: [], isSingleDay: false };

        const filtered = props.labels.map((label, index) => ({
            label,
            value: props.data.ping[index],
            jitter: props.data.jitter?.[index],
            isFailed: props.failed?.[index] || false,
            error: props.errors?.[index] || null,
            date: new Date(label)
        }));

        const validValues = filtered.filter(item => item.value !== null && item.value !== undefined && item.value > 0).map(item => item.value);
        const average = validValues.length > 0
            ? Math.round((validValues.reduce((a, b) => a + b, 0) / validValues.length) * 100) / 100
            : 0;

        const validJitter = filtered.filter(item => item.jitter !== null && item.jitter !== undefined).map(item => item.jitter);
        const jitterAverage = validJitter.length > 0
            ? Math.round((validJitter.reduce((a, b) => a + b, 0) / validJitter.length) * 100) / 100
            : null;

        const dates = filtered.map(item => new Date(item.label).toDateString());
        const uniqueDates = [...new Set(dates)];
        const isSingleDay = uniqueDates.length === 1;

        return {
            labels: filtered.map(item => item.label),
            data: filtered.map(item => item.value),
            jitter: filtered.map(item => item.jitter),
            failed: filtered.map(item => item.isFailed),
            errors: filtered.map(item => item.error),
            average,
            jitterAverage,
            isSingleDay
        };
    }, [props.labels, props.data, props.failed, props.errors]);

    const hasJitterData = useMemo(() => filteredData.jitter.some(j => j !== null && j !== undefined), [filteredData.jitter]);

    const failedMarkerData = useMemo(() => {
        return filteredData.labels.map((_, index) => 
            filteredData.failed[index] ? 0 : null
        );
    }, [filteredData]);

    const hasFailedTests = useMemo(() => failedMarkerData.some(v => v !== null), [failedMarkerData]);

    // The detail view can request far more points than the card ever shows, so
    // the marker size follows the series length rather than the layout.
    const pointStyle = useMemo(() => pointStyleFor(filteredData.labels.length, {compact}),
        [filteredData.labels.length, compact]);

    const lineTension = useMemo(() => lineTensionFor(filteredData.labels.length),
        [filteredData.labels.length]);

    const themeColors = useMemo(() => ({
        gridColor: isDarkMode ? 'rgba(42, 52, 65, 0.6)' : 'rgba(203, 213, 225, 0.8)',
        tickColor: isDarkMode ? 'hsl(215, 20%, 50%)' : 'hsl(215, 25%, 40%)',
        tooltipBg: isDarkMode ? 'hsl(215, 28%, 10%)' : 'hsl(0, 0%, 100%)',
        tooltipTitle: isDarkMode ? 'hsl(210, 40%, 96%)' : 'hsl(215, 25%, 20%)',
        tooltipBody: isDarkMode ? 'hsl(215, 20%, 65%)' : 'hsl(215, 15%, 40%)',
        tooltipBorder: isDarkMode ? 'hsl(215, 25%, 22%)' : 'hsl(215, 20%, 85%)'
    }), [isDarkMode]);

    const chartOptions = useMemo(() => ({
        responsive: true,
        maintainAspectRatio: false,
        resizeDelay: 100,
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
        },
        plugins: {
            tooltip: {
                backgroundColor: themeColors.tooltipBg,
                titleColor: themeColors.tooltipTitle,
                bodyColor: themeColors.tooltipBody,
                borderColor: themeColors.tooltipBorder,
                borderWidth: 1,
                padding: 14,
                cornerRadius: 10,
                displayColors: true,
                boxPadding: 8,
                filter: (item) => item.dataset.label !== t("statistics.failed_test"),
                callbacks: {
                    title: (items) => {
                        if (items.length > 0) {
                            const date = new Date(filteredData.labels[items[0].dataIndex]);
                            return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) +
                                   ' ' + date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: use12h });
                        }
                        return '';
                    },
                    label: (item) => {
                        if (item.dataset.label === t("statistics.failed_test")) {
                            const error = filteredData.errors[item.dataIndex];
                            return error ? `${t("statistics.failed_test")}: ${error}` : t("statistics.failed_test");
                        }
                        return `${item.dataset.label}: ${item.formattedValue} ${t("latest.ping_unit")}`;
                    },
                    afterBody: (items) => {
                        if (items.length > 0) {
                            const index = items[0].dataIndex;
                            if (filteredData.failed[index]) {
                                const error = filteredData.errors[index];
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
                    maxTicksLimit: filteredData.isSingleDay ? 12 : 5,
                    callback: function(value, index) {
                        const date = new Date(filteredData.labels[index]);
                        if (filteredData.isSingleDay) {
                            return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: use12h });
                        }
                        return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
                               date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: use12h });
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
                    color: themeColors.tickColor
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
    }), [themeColors, filteredData.labels, filteredData.errors, filteredData.failed, filteredData.isSingleDay, pointStyle, lineTension, use12h]);

    const chartData = useMemo(() => ({
        labels: filteredData.labels,
        datasets: [
            {
                label: t("latest.ping"),
                data: filteredData.data,
                borderColor: 'hsl(38, 92%, 50%)',
                backgroundColor: (context) => {
                    const ctx = context.chart.ctx;
                    const gradient = ctx.createLinearGradient(0, 0, 0, context.chart.height);
                    gradient.addColorStop(0, 'hsla(38, 92%, 50%, 0.25)');
                    gradient.addColorStop(1, 'hsla(38, 92%, 50%, 0.01)');
                    return gradient;
                },
                fill: true,
                pointBackgroundColor: 'hsl(38, 92%, 50%)',
                pointBorderColor: 'hsl(38, 92%, 50%)',
                pointRadius: pointStyle.radius,
                pointHoverRadius: pointStyle.hoverRadius,
                spanGaps: true,
                order: 1
            },
            ...(hasJitterData ? [{
                label: t("latest.jitter"),
                data: filteredData.jitter,
                borderColor: 'hsl(280, 70%, 55%)',
                backgroundColor: (context) => {
                    const ctx = context.chart.ctx;
                    const gradient = ctx.createLinearGradient(0, 0, 0, context.chart.height);
                    gradient.addColorStop(0, 'hsla(280, 70%, 55%, 0.15)');
                    gradient.addColorStop(1, 'hsla(280, 70%, 55%, 0.01)');
                    return gradient;
                },
                fill: true,
                pointBackgroundColor: 'hsl(280, 70%, 55%)',
                pointBorderColor: 'hsl(280, 70%, 55%)',
                pointRadius: pointStyle.radius,
                pointHoverRadius: pointStyle.hoverRadius,
                spanGaps: true,
                order: 2
            }] : []),
            {
                label: t("statistics.average"),
                data: filteredData.labels.map(() => filteredData.average),
                borderColor: 'hsl(330, 80%, 60%)',
                backgroundColor: 'transparent',
                borderWidth: 2,
                borderDash: [6, 4],
                pointRadius: 0,
                pointHoverRadius: 0,
                fill: false,
                order: 4
            },
            ...(hasFailedTests ? [{
                label: t("statistics.failed_test"),
                data: failedMarkerData,
                borderColor: 'transparent',
                backgroundColor: 'hsl(0, 72%, 51%)',
                pointBackgroundColor: 'hsl(0, 72%, 51%)',
                pointBorderColor: 'hsl(0, 84%, 60%)',
                pointBorderWidth: compact ? 1 : 2,
                pointRadius: compact ? 3 : 6,
                pointHoverRadius: compact ? 4 : 8,
                pointStyle: 'crossRot',
                showLine: false,
                fill: false,
                order: 0
            }] : [])
        ],
    }), [filteredData, compact, pointStyle, hasJitterData, hasFailedTests, failedMarkerData]);

    return (
        <div className="chart-container ping-chart" onClick={props.onClick}>
            <div className="chart-header">
                <h3 className="chart-title">{t("latest.ping")} ({t("latest.ping_unit")})</h3>
            </div>
            <div className="chart-body">
                <ChartWrapper type="line" data={chartData} options={chartOptions} />
            </div>
            <DownsampleNote downsampled={props.downsampled} shown={props.dataPoints} total={props.rawDataPoints} />
        </div>
    );
});

export default PingChart;