import ChartWrapper from "@/common/components/ChartWrapper";
import { useMemo, useContext, memo } from "react";
import { t } from "i18next";
import { PreferencesContext } from "@/common/contexts/Preferences";
import { convertSpeed, getSpeedUnit, TIME_FORMAT_12H } from "@/common/utils/FormatUtil";
import DownsampleNote from "@/pages/Statistics/components/DownsampleNote";
import { lineTensionFor, pointStyleFor } from "@/pages/Statistics/charts/pointDensity";
import { clickable } from "@/common/utils/Clickable";
import { useChartTheme } from "@/pages/Statistics/charts/useChartTheme";
import {
    averageLineDataset, failedMarkersDataset, failureMarkers,
    isSingleDaySeries, lineChartOptions, seriesAverage, timePoints, verticalGradientFill
} from "@/pages/Statistics/charts/lineChartConfig";
import "./styles.sass";

// The average line sits behind the measured one.
const AVERAGE_ORDER = 3;

// Multiples of 100 Mbps suit the range gigabit lines move in; smaller ranges
// still get finer ticks - chart.js scales the step down to fit them.
const SPEED_TICK_STEP = 100;

export const SpeedChart = memo(({ labels, data, dataKey, titleKey, onClick, failed, errors, compact = false, downsampled, dataPoints, rawDataPoints }) => {
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

    const themeColors = useChartTheme();

    // The line takes the colour the palette holds for the series it draws.
    // This was a `color` prop, and Statistics.jsx passed the same two literals
    // at four call sites - a fifth caller would have chosen its own, and the
    // download line in one place would not have matched the download line in
    // another. `dataKey` already names the series; nothing else has to.
    const seriesColor = themeColors[dataKey] ?? themeColors.download;

    const chartOptions = useMemo(() => lineChartOptions({
        themeColors,
        labels: filteredData.labels,
        errors: filteredData.errors,
        isSingleDay: filteredData.isSingleDay,
        pointStyle,
        lineTension,
        use12h,
        valueUnit: speedUnit,
        yStepSize: SPEED_TICK_STEP
    }), [themeColors, filteredData.labels, filteredData.errors, filteredData.isSingleDay,
        pointStyle, lineTension, speedUnit, use12h]);

    const hasFailedTests = useMemo(() => failedMarkerData.some(v => v !== null), [failedMarkerData]);

    const chartData = useMemo(() => ({
        labels: filteredData.labels,
        datasets: [
            {
                label: t(titleKey),
                data: timePoints(filteredData.labels, filteredData.data),
                borderColor: seriesColor,
                backgroundColor: verticalGradientFill(seriesColor),
                fill: true,
                pointBackgroundColor: seriesColor,
                pointBorderColor: seriesColor,
                pointRadius: pointStyle.radius,
                pointHoverRadius: pointStyle.hoverRadius,
                spanGaps: true,
                order: 1
            },
            // Left off entirely when nothing was measured: a line at zero is a
            // reading, and a range in which every test failed made none.
            ...(filteredData.average !== null ? [averageLineDataset(filteredData.labels, filteredData.average, AVERAGE_ORDER, themeColors.average)] : []),
            ...(hasFailedTests ? [failedMarkersDataset(filteredData.labels, failedMarkerData, compact, themeColors.failed)] : [])
        ],
    }), [filteredData, seriesColor, themeColors, titleKey, compact, pointStyle, hasFailedTests, failedMarkerData]);

    return (
        <div className="chart-container" {...clickable(onClick)}>
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
