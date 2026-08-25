import ChartWrapper from "@/common/components/ChartWrapper";
import { useMemo, useContext, memo } from "react";
import { t } from "i18next";
import { ThemeContext } from "@/common/contexts/Theme";
import { PreferencesContext } from "@/common/contexts/Preferences";
import { TIME_FORMAT_12H } from "@/common/utils/FormatUtil";
import DownsampleNote from "@/pages/Statistics/components/DownsampleNote";
import { lineTensionFor, pointStyleFor } from "@/pages/Statistics/charts/pointDensity";
import { clickable } from "@/common/utils/Clickable";
import {
    averageLineDataset, chartThemeColors, failedMarkersDataset, failureMarkers,
    isSingleDaySeries, lineChartOptions, seriesAverage, timePoints, verticalGradientFill
} from "@/pages/Statistics/charts/lineChartConfig";
import "./SpeedChart/styles.sass";

const PING_COLOR = 'hsl(38, 92%, 50%)';
const LOADED_COLOR = 'hsl(217, 91%, 60%)';
const JITTER_COLOR = 'hsl(280, 70%, 55%)';

// The jitter fill is fainter than the main line's: it is context, not the reading.
const JITTER_PEAK_ALPHA = 0.15;

// Behind the loaded (3) and jitter (2) lines, which sit behind the ping (1).
const AVERAGE_ORDER = 4;

const PingChart = memo(({ compact = false, ...props }) => {
    const {isDarkMode} = useContext(ThemeContext);
    const [preferences] = useContext(PreferencesContext);
    const use12h = preferences?.timeFormat === TIME_FORMAT_12H;

    const filteredData = useMemo(() => {
        if (!props.data?.ping || !props.labels) return { labels: [], data: [], jitter: [], loaded: [], average: null, failed: [], errors: [], isSingleDay: false };

        // The worse of the two directions per point, exactly as the grade takes
        // the worse direction - a line clean downstream and buffered upstream is
        // a buffered line. Null when neither was measured, which draws a gap.
        const loadedAt = (index) => {
            const down = props.data.downloadLatency?.[index];
            const up = props.data.uploadLatency?.[index];
            if (down === null || down === undefined) return up ?? null;
            if (up === null || up === undefined) return down;

            return Math.max(down, up);
        };

        const values = props.labels.map((_, index) => props.data.ping[index]);

        return {
            labels: props.labels,
            data: values,
            jitter: props.labels.map((_, index) => props.data.jitter?.[index]),
            loaded: props.labels.map((_, index) => loadedAt(index)),
            failed: props.labels.map((_, index) => props.failed?.[index] || false),
            errors: props.labels.map((_, index) => props.errors?.[index] || null),
            average: seriesAverage(values),
            isSingleDay: isSingleDaySeries(props.labels)
        };
    }, [props.labels, props.data, props.failed, props.errors]);

    const hasJitterData = useMemo(() => filteredData.jitter.some(j => j !== null && j !== undefined), [filteredData.jitter]);
    const hasLoadedData = useMemo(() => filteredData.loaded.some(v => v !== null && v !== undefined), [filteredData.loaded]);

    const failedMarkerData = useMemo(() => failureMarkers(filteredData.failed), [filteredData]);

    const hasFailedTests = useMemo(() => failedMarkerData.some(v => v !== null), [failedMarkerData]);

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
        isSingleDay: filteredData.isSingleDay,
        pointStyle,
        lineTension,
        use12h,
        valueUnit: t("latest.ping_unit")
    }), [themeColors, filteredData.labels, filteredData.errors, filteredData.isSingleDay,
        pointStyle, lineTension, use12h]);

    const chartData = useMemo(() => ({
        labels: filteredData.labels,
        datasets: [
            {
                label: t("latest.ping"),
                data: timePoints(filteredData.labels, filteredData.data),
                borderColor: PING_COLOR,
                backgroundColor: verticalGradientFill(PING_COLOR),
                fill: true,
                pointBackgroundColor: PING_COLOR,
                pointBorderColor: PING_COLOR,
                pointRadius: pointStyle.radius,
                pointHoverRadius: pointStyle.hoverRadius,
                spanGaps: true,
                order: 1
            },
            // Idle and under-load latency on one axis is the picture that
            // explains "the internet feels slow while something uploads". No
            // fill: the reading is the distance to the idle line below it.
            // Blue, not red - red is the failure markers' colour on this chart,
            // and a line must not read as a row of failures.
            ...(hasLoadedData ? [{
                label: t("statistics.loaded_latency"),
                data: timePoints(filteredData.labels, filteredData.loaded),
                borderColor: LOADED_COLOR,
                backgroundColor: 'transparent',
                fill: false,
                pointBackgroundColor: LOADED_COLOR,
                pointBorderColor: LOADED_COLOR,
                pointRadius: pointStyle.radius,
                pointHoverRadius: pointStyle.hoverRadius,
                spanGaps: true,
                order: 3
            }] : []),
            ...(hasJitterData ? [{
                label: t("latest.jitter"),
                data: timePoints(filteredData.labels, filteredData.jitter),
                borderColor: JITTER_COLOR,
                backgroundColor: verticalGradientFill(JITTER_COLOR, JITTER_PEAK_ALPHA),
                fill: true,
                pointBackgroundColor: JITTER_COLOR,
                pointBorderColor: JITTER_COLOR,
                pointRadius: pointStyle.radius,
                pointHoverRadius: pointStyle.hoverRadius,
                spanGaps: true,
                order: 2
            }] : []),
            // Left off entirely when nothing was measured: a line at zero is a
            // reading, and a range in which every test failed made none.
            ...(filteredData.average !== null ? [averageLineDataset(filteredData.labels, filteredData.average, AVERAGE_ORDER)] : []),
            ...(hasFailedTests ? [failedMarkersDataset(filteredData.labels, failedMarkerData, compact)] : [])
        ],
    }), [filteredData, compact, pointStyle, hasJitterData, hasLoadedData, hasFailedTests, failedMarkerData]);

    return (
        <div className="chart-container ping-chart" {...clickable(props.onClick)}>
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
