import ChartWrapper from "@/common/components/ChartWrapper";
import { useMemo, useContext, memo } from "react";
import { t } from "i18next";
import { ThemeContext } from "@/common/contexts/Theme";
import { PreferencesContext } from "@/common/contexts/Preferences";
import { convertSpeed, getSpeedUnit, TIME_FORMAT_12H } from "@/common/utils/FormatUtil";
import DownsampleNote from "@/pages/Statistics/components/DownsampleNote";
import { lineTensionFor, pointStyleFor } from "@/pages/Statistics/charts/pointDensity";
import {
    averageLineDataset, chartThemeColors, failedMarkersDataset, failureMarkers,
    isSingleDaySeries, lineChartOptions, seriesAverage, timePoints, verticalGradientFill
} from "@/pages/Statistics/charts/lineChartConfig";
import "./styles.sass";

// The average line sits behind the measured one.
const AVERAGE_ORDER = 3;

// Multiples of 100 Mbps suit the range gigabit lines move in; smaller ranges
// still get finer ticks - chart.js scales the step down to fit them.
const SPEED_TICK_STEP = 100;

export const SpeedChart = memo(({ labels, data, dataKey, titleKey, color, onClick, failed, errors, compact = false, downsampled, dataPoints, rawDataPoints }) => {
    const [isDarkMode] = useContext(ThemeContext);
    const [preferences] = useContext(PreferencesContext);
    const speedUnit = getSpeedUnit(preferences);
    const use12h = preferences?.timeFormat === TIME_FORMAT_12H;

    const filteredData = useMemo(() => {
        if (!data?.[dataKey] || !labels) return { labels: [], data: [], average: null, failed: [], errors: [], isSingleDay: false };

        const values = labels.map((_, index) => convertSpeed(data[dataKey][index], preferences));

        return {
            labels,
            data: values,
            failed: labels.map((_, index) => failed?.[index] || false),
            errors: labels.map((_, index) => errors?.[index] || null),
            average: seriesAverage(values),
            isSingleDay: isSingleDaySeries(labels)
        };
    }, [labels, data, dataKey, failed, errors, preferences]);

    const failedMarkerData = useMemo(() => failureMarkers(filteredData.failed), [filteredData]);

    // The detail view can request far more points than the card ever shows, so
    // the marker size follows the series length rather than the layout.
    const pointStyle = useMemo(() => pointStyleFor(filteredData.labels.length, {compact}),
        [filteredData.labels.length, compact]);

    const lineTension = useMemo(() => lineTensionFor(filteredData.labels.length),
        [filteredData.labels.length]);

    const themeColors = useMemo(() => chartThemeColors(isDarkMode), [isDarkMode]);

    const chartOptions = useMemo(() => lineChartOptions({
        themeColors,
        labels: filteredData.labels,
        errors: filteredData.errors,
        failed: filteredData.failed,
        isSingleDay: filteredData.isSingleDay,
        pointStyle,
        lineTension,
        use12h,
        valueUnit: speedUnit,
        yStepSize: SPEED_TICK_STEP
    }), [themeColors, filteredData.labels, filteredData.errors, filteredData.failed,
        filteredData.isSingleDay, pointStyle, lineTension, speedUnit, use12h]);

    const hasFailedTests = useMemo(() => failedMarkerData.some(v => v !== null), [failedMarkerData]);

    const chartData = useMemo(() => ({
        labels: filteredData.labels,
        datasets: [
            {
                label: t(titleKey),
                data: timePoints(filteredData.labels, filteredData.data),
                borderColor: color,
                backgroundColor: verticalGradientFill(color),
                fill: true,
                pointBackgroundColor: color,
                pointBorderColor: color,
                pointRadius: pointStyle.radius,
                pointHoverRadius: pointStyle.hoverRadius,
                spanGaps: true,
                order: 1
            },
            // Left off entirely when nothing was measured: a line at zero is a
            // reading, and a range in which every test failed made none.
            ...(filteredData.average !== null ? [averageLineDataset(filteredData.labels, filteredData.average, AVERAGE_ORDER)] : []),
            ...(hasFailedTests ? [failedMarkersDataset(filteredData.labels, failedMarkerData, compact)] : [])
        ],
    }), [filteredData, color, titleKey, compact, pointStyle, hasFailedTests, failedMarkerData]);

    return (
        <div className="chart-container" onClick={onClick}>
            <div className="chart-header">
                <h3 className="chart-title">{t(titleKey)} ({speedUnit})</h3>
            </div>
            <div className="chart-body">
                <ChartWrapper type="line" data={chartData} options={chartOptions} />
            </div>
            <DownsampleNote downsampled={downsampled} shown={dataPoints} total={rawDataPoints} />
        </div>
    );
});
