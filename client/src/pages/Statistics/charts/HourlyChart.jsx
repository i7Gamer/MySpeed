import ChartWrapper from "@/common/components/ChartWrapper";
import { useMemo, useContext, memo } from "react";
import { t } from "i18next";
import { PreferencesContext } from "@/common/contexts/Preferences";
import { convertSpeed, formatHour, getSpeedUnit } from "@/common/utils/FormatUtil";
import { chartMotion, tooltipTheme, withAlpha } from "@/pages/Statistics/charts/lineChartConfig";
import { useChartTheme } from "@/pages/Statistics/charts/useChartTheme";
import { clickable } from "@/common/utils/Clickable";
import "./SpeedChart/styles.sass";

// The bars are wide enough that a solid fill would flatten the grid behind
// them; the border carries the edge at full strength.
const BAR_FILL_ALPHA = 0.75;

const HourlyChart = memo((props) => {
    const [preferences] = useContext(PreferencesContext);
    const speedUnit = getSpeedUnit(preferences);
    const themeColors = useChartTheme();

    const chartData = useMemo(() => {
        if (!props.hourlyAverages) return { labels: [], datasets: [] };

        // Inline rather than through a one-line wrapper: the wrapper closed over
        // `preferences`, which this memo already depends on, so it was a second
        // name for the dependency the memo is keyed on.
        const labels = props.hourlyAverages.map(h => formatHour(h.hour, preferences));

        return {
            labels,
            datasets: [
                {
                    label: t("latest.down"),
                    data: props.hourlyAverages.map(h => convertSpeed(h.download, preferences)),
                    backgroundColor: withAlpha(themeColors.download, BAR_FILL_ALPHA),
                    borderColor: themeColors.download,
                    borderWidth: 1.5,
                    borderRadius: 6
                },
                {
                    label: t("latest.up"),
                    data: props.hourlyAverages.map(h => convertSpeed(h.upload, preferences)),
                    backgroundColor: withAlpha(themeColors.upload, BAR_FILL_ALPHA),
                    borderColor: themeColors.upload,
                    borderWidth: 1.5,
                    borderRadius: 6
                }
            ]
        };
    }, [props.hourlyAverages, preferences, themeColors]);

    const chartOptions = useMemo(() => ({
        responsive: true,
        maintainAspectRatio: false,
        resizeDelay: 100,
        ...chartMotion,
        plugins: {
            tooltip: {
                ...tooltipTheme(themeColors),
                callbacks: {
                    label: (item) => `${item.dataset.label}: ${item.formattedValue} ${speedUnit}`,
                    afterBody: (items) => {
                        const hourIndex = items[0].dataIndex;
                        const count = props.hourlyAverages[hourIndex]?.count || 0;
                        return `\n${t("statistics.hourly.sample_count")}: ${count}`;
                    }
                }
            },
            legend: {
                position: "bottom",
                labels: {
                    usePointStyle: true,
                    pointStyle: 'rect',
                    padding: 20,
                    color: themeColors.tickColor,
                    font: {
                        size: 12,
                        weight: 500
                    }
                }
            }
        },
        scales: {
            x: {
                grid: {
                    color: themeColors.gridColor,
                    drawBorder: false
                },
                border: {
                    display: false
                },
                ticks: {
                    color: themeColors.tickColor,
                    maxRotation: 0
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
        }
    }), [themeColors, props.hourlyAverages, speedUnit]);

    return (
        // Named, like the latency chart beside it, so the two-column stage can
        // give the two of them a row each - see pages/Statistics/styles.sass.
        <div className="chart-container hourly-chart" {...clickable(props.onClick)}>
            <div className="chart-header">
                <h3 className="chart-title">{t("statistics.hourly.title")}</h3>
            </div>
            <div className="chart-body">
                <ChartWrapper type="bar" data={chartData} options={chartOptions} />
            </div>
        </div>
    );
});

export default HourlyChart;
