import ChartWrapper from "@/common/components/ChartWrapper";
import { useMemo, useContext, memo } from "react";
import { t } from "i18next";
import { ThemeContext } from "@/common/contexts/Theme";
import { PreferencesContext } from "@/common/contexts/Preferences";
import { convertSpeed, getSpeedUnit, TIME_FORMAT_12H } from "@/common/utils/FormatUtil";
import { chartMotion, chartThemeColors, tooltipTheme } from "@/pages/Statistics/charts/lineChartConfig";
import "./SpeedChart/styles.sass";

const HourlyChart = memo((props) => {
    const [isDarkMode] = useContext(ThemeContext);
    const [preferences] = useContext(PreferencesContext);
    const speedUnit = getSpeedUnit(preferences);
    const use12h = preferences?.timeFormat === TIME_FORMAT_12H;

    const formatHourLabel = (hour) => {
        if (use12h) {
            const suffix = hour >= 12 ? "PM" : "AM";
            let h = hour % 12;
            if (h === 0) h = 12;
            return `${h}:00 ${suffix}`;
        }
        return `${hour.toString().padStart(2, '0')}:00`;
    };

    const chartData = useMemo(() => {
        if (!props.hourlyAverages) return { labels: [], datasets: [] };

        const labels = props.hourlyAverages.map(h => formatHourLabel(h.hour));

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
    }, [props.hourlyAverages, preferences, use12h]);

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
        <div className="chart-container" onClick={props.onClick}>
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
