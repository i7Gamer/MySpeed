import ChartWrapper from "@/common/components/ChartWrapper";
import { useMemo, useContext, memo } from "react";
import { t } from "i18next";
import { ThemeContext } from "@/common/contexts/Theme";
import { PreferencesContext } from "@/common/contexts/Preferences";
import { convertSpeed, formatHour, getSpeedUnit } from "@/common/utils/FormatUtil";
import { chartMotion, chartThemeColors, tooltipTheme } from "@/pages/Statistics/charts/lineChartConfig";
import { clickable } from "@/common/utils/Clickable";
import "./SpeedChart/styles.sass";

const HourlyChart = memo((props) => {
    const [isDarkMode] = useContext(ThemeContext);
    const [preferences] = useContext(PreferencesContext);
    const speedUnit = getSpeedUnit(preferences);


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
                    backgroundColor: 'hsla(187, 94%, 43%, 0.75)',
                    borderColor: 'hsl(187, 94%, 43%)',
                    borderWidth: 1.5,
                    borderRadius: 6
                },
                {
                    label: t("latest.up"),
                    data: props.hourlyAverages.map(h => convertSpeed(h.upload, preferences)),
                    backgroundColor: 'hsla(258, 90%, 66%, 0.75)',
                    borderColor: 'hsl(258, 90%, 66%)',
                    borderWidth: 1.5,
                    borderRadius: 6
                }
            ]
        };
    }, [props.hourlyAverages, preferences]);

    const themeColors = useMemo(() => chartThemeColors(isDarkMode), [isDarkMode]);

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
