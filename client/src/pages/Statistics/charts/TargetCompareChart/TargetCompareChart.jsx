import {useContext, useMemo} from "react";
import {t} from "i18next";
import ChartWrapper from "@/common/components/ChartWrapper";
import {PreferencesContext} from "@/common/contexts/Preferences";
import {
    appLocale, convertSpeed, getSpeedUnit, TIME_FORMAT_12H
} from "@/common/utils/FormatUtil";
import {targetSeriesToken} from "@/common/utils/TargetUtil";
import {clickable} from "@/common/utils/Clickable";
import {useChartTheme} from "@/pages/Statistics/charts/useChartTheme";
import {isSingleDaySeries, lineChartOptions, timePoints} from "@/pages/Statistics/charts/lineChartConfig";
import {lineTensionFor, lonePointHoverRadius, lonePointRadius, pointStyleFor} from "@/pages/Statistics/charts/pointDensity";
import {Interaction} from "chart.js";
import {getRelativePosition} from "chart.js/helpers";
import {mergedTimeline, nearestPerDataset, overlayOutcome} from "./targetCompare";
// .chart-container and its header/body, borrowed the way PingChart borrows
// them: these three are that row's siblings, and the shared stylesheet is what
// makes them size and expand identically rather than nearly so.
import "@/pages/Statistics/charts/SpeedChart/styles.sass";
import "./styles.sass";

/**
 * One title per metric, each naming the metric first - "Download by target"
 * rather than "Target comparison: download", so the three read as siblings of
 * the Download and Upload charts a row above rather than as three copies of one
 * card. The keys are listed here as literals so the locale scanner can see them
 * even though the lookup itself is by metric.
 */
const METRIC_TITLES = {
    download: "statistics.targets.chart.download",
    upload: "statistics.targets.chart.upload",
    ping: "statistics.targets.chart.ping"
};

// The stock options close over a per-point error list; this chart draws no
// failure markers, so there is nothing for the callback to find.
const NO_ERRORS = [];

/**
 * How far from the cursor a target's reading still counts as under it.
 *
 * In pixels, and the unit is the argument: a reader sees points, not
 * timestamps, and two readings drawn at the same place should be reported
 * together however many minutes apart the zoom makes them. Twelve is about a
 * fingertip - wide enough that the plot answers wherever it is hovered, short
 * of the ~20px at which two visibly separate rounds start being read as one.
 */
const HOVER_TOLERANCE_PX = 12;

// The mode's name in chart.js's own registry, which is global: a second
// registration under this name would silently replace this one, so it is
// stated once here and used by name below.
const COMPARE_HOVER_MODE = "nearestPerTarget";

/*
 * Registered at import, beside the only chart that asks for it.
 *
 * chart.js resolves an interaction mode by name out of a shared registry, so
 * this has to exist before the first render rather than be built per chart -
 * and being shared, it is deliberately named for what it does rather than for
 * this component, since anything else drawing several series of one quantity
 * wants exactly this.
 */
Interaction.modes[COMPARE_HOVER_MODE] = (chart, event, options, useFinalPosition) => {
    const position = getRelativePosition(event, chart);

    const datasets = chart.getSortedVisibleDatasetMetas().map((meta) => ({
        index: meta.index,
        points: meta.data.map((element) => element.getProps(["x", "skip"], useFinalPosition))
    }));

    return nearestPerDataset(datasets, position.x, HOVER_TOLERANCE_PX)
        .map(({datasetIndex, index}) => ({
            element: chart.getDatasetMeta(datasetIndex).data[index], datasetIndex, index
        }));
};

/**
 * One metric's targets, overlaid - the payoff the chips only filter towards.
 *
 * Three of these are drawn rather than one card with a metric switcher, and the
 * shape is the point: they take the same .chart-container the ping and speed
 * charts a row above take, so the page shows six lines of the same kind rather
 * than five charts and one panel that behaves differently from all of them. The
 * switcher it replaced hid two thirds of the comparison behind a click, inside a
 * card that had to be opened before it drew anything at all.
 *
 * Deliberately every target in list order: the chip narrows the page, and a
 * comparison narrowed to one target compares nothing - which is why the page
 * draws these only while nothing is narrowing it, and why there is no filtering
 * to do here.
 *
 * @param metric which of download, upload or ping this instance draws
 * @param fresh  whether statsById answers for the range on screen
 */
export const TargetCompareChart = ({targets, statsById, fresh, metric, compact = false, onClick}) => {
    const [preferences] = useContext(PreferencesContext);
    const themeColors = useChartTheme();
    const use12h = preferences?.timeFormat === TIME_FORMAT_12H;
    const speedUnit = getSpeedUnit(preferences);

    /*
     * What to draw, and which nothing it is when there is nothing - see
     * overlayOutcome. A request that failed and a range nobody measured in are
     * different findings, and this chart used to report the first as the
     * second while the table beside it said "Couldn't load".
     */
    const outcome = useMemo(() => overlayOutcome(targets, statsById, metric),
        [targets, statsById, metric]);
    const series = outcome.series;

    // The union of the targets' instants feeds only the axis - span, step and
    // the single-day tick format. The datasets keep their own labels: the x
    // axis is linear epoch time, so disjoint instants share it natively, and
    // the tooltip reaches across them by pixel rather than by index - see
    // nearestPerDataset.
    const merged = useMemo(() => mergedTimeline(series), [series]);

    /*
     * The two density knobs read different inputs on purpose. Marker size is
     * about the canvas as a whole - markers touch and merge into a band by
     * how many are DRAWN, across every series - while tension is about one
     * line's own spacing, where a curve through close samples invents
     * overshoot: the longest series is the one that decides. One count for
     * both drew the same data two ways depending on how many neighbours it
     * had.
     */
    const drawnPoints = useMemo(() =>
        series.reduce((sum, one) => sum + one.values.length, 0), [series]);
    const longestSeries = useMemo(() =>
        series.reduce((longest, one) => Math.max(longest, one.labels.length), 0), [series]);

    const pointStyle = useMemo(() => pointStyleFor(drawnPoints, {compact}), [drawnPoints, compact]);
    const lineTension = useMemo(() => lineTensionFor(longestSeries), [longestSeries]);

    const valueUnit = metric === "ping" ? t("latest.ping_unit") : speedUnit;

    const chartOptions = useMemo(() => {
        const options = lineChartOptions({
            themeColors,
            labels: merged,
            errors: NO_ERRORS,
            isSingleDay: isSingleDaySeries(merged),
            pointStyle,
            lineTension,
            use12h,
            valueUnit
        });

        /*
         * Every target at the hovered moment, which is the whole point of
         * drawing them on one plot: a tooltip naming one line makes the reader
         * hover three times and hold two numbers in their head to compare
         * them.
         *
         * The mode registered above rather than one of chart.js's own - see
         * nearestPerDataset for why none of the three fit, each having been
         * tried against the real page. axis stated explicitly: the shared
         * builder leaves it to the mode's default, and a later axis added
         * there must not silently retarget this chart.
         */
        options.interaction = {mode: COMPARE_HOVER_MODE, axis: "x", intersect: false};

        /*
         * Only the targets that actually measured at this instant.
         *
         * Index mode hands the tooltip one entry per dataset whether or not
         * that dataset has a reading there, so every instant only one target
         * was tested at would otherwise list the other two with an empty
         * figure beside their names - which reads as "measured nothing"
         * rather than "was not measured".
         */
        options.plugins.tooltip.filter = (item) => item.parsed?.y !== null
            && item.parsed?.y !== undefined;

        options.plugins.tooltip.callbacks = {
            // The stock title reads labels[dataIndex], which names another
            // series' instant here; the point's own parsed x is the truth.
            title: (items) => {
                if (items.length === 0) return "";

                const date = new Date(items[0].parsed.x);
                return date.toLocaleDateString(appLocale(),
                    {weekday: "short", day: "numeric", month: "short", year: "numeric"})
                    + " " + date.toLocaleTimeString(appLocale(),
                        {hour: "2-digit", minute: "2-digit", hour12: use12h});
            },
            // No failed-test branch - this chart draws no markers, and a
            // TARGET wearing that very name must not have its readings
            // reprinted as failures.
            label: (item) => `${item.dataset.label}: ${item.formattedValue} ${valueUnit}`
        };
        // The stock legend filter hides the failed-test dataset by its
        // translated label - which here would hide a target named that.
        options.plugins.legend.labels = {...options.plugins.legend.labels, filter: undefined};

        return options;
    }, [themeColors, merged, pointStyle, lineTension, use12h, valueUnit]);

    const chartData = useMemo(() => ({
        datasets: series.map((one) => {
            const colour = themeColors[targetSeriesToken(one.colourIndex)];

            return {
                label: one.name,
                data: timePoints(one.labels,
                    metric === "ping" ? one.values
                        : one.values.map((value) => convertSpeed(value, preferences))),
                borderColor: colour,
                // No fill: N gradients on one plot bury each other, and the
                // reading is the lines' distance apart.
                backgroundColor: "transparent",
                fill: false,
                pointBackgroundColor: colour,
                pointBorderColor: colour,
                pointRadius: lonePointRadius(pointStyle),
                pointHoverRadius: lonePointHoverRadius(pointStyle)
            };
        })
    }), [series, metric, preferences, themeColors, pointStyle]);

    /*
     * The two states that are not a chart, said in the plot's own place rather
     * than in place of the whole card: the heading names the metric either way,
     * so a reader looking for "Upload by target" finds it while it is still
     * loading instead of finding a card that has not decided what it is yet.
     */
    const body = () => {
        if (!fresh || outcome.state === "loading")
            return <p className="target-compare-hint">{t("statistics.detail.loading")}</p>;

        // The table beside these says the same thing in its own cells; a
        // reader must not have to look there to find out which of the two
        // silences this one is.
        if (outcome.state === "unavailable")
            return <p className="target-compare-hint">{t("statistics.targets.unavailable")}</p>;

        if (outcome.state === "empty")
            return <p className="target-compare-hint">{t("statistics.targets.empty")}</p>;

        return <ChartWrapper type="line" data={chartData} options={chartOptions}/>;
    };

    return (
        <div className="chart-container target-compare-chart" {...clickable(onClick)}>
            <div className="chart-header">
                <h3 className="chart-title">{t(METRIC_TITLES[metric])} ({valueUnit})</h3>
            </div>
            <div className="chart-body">
                {body()}
            </div>
        </div>
    );
};

export default TargetCompareChart;
