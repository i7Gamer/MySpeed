import {useContext, useMemo, useState} from "react";
import {t} from "i18next";
import StatisticContainer from "@/pages/Statistics/components/StatisticContainer";
import SegmentedControl from "@/common/components/SegmentedControl";
import ChartWrapper from "@/common/components/ChartWrapper";
import Delta from "@/common/components/Delta";
import {PreferencesContext} from "@/common/contexts/Preferences";
import {
    appLocale, convertSpeed, formatLatencyWithUnit, formatPercent, formatWithUnit, getSpeedUnit,
    wholeSpeed, TIME_FORMAT_12H
} from "@/common/utils/FormatUtil";
import {targetColour, targetSeriesToken} from "@/common/utils/TargetUtil";
import {useChartTheme} from "@/pages/Statistics/charts/useChartTheme";
import {isSingleDaySeries, lineChartOptions, timePoints} from "@/pages/Statistics/charts/lineChartConfig";
import {lineTensionFor, lonePointHoverRadius, lonePointRadius, pointStyleFor} from "@/pages/Statistics/charts/pointDensity";
import {mergedTimeline, overlaySeries, targetSummaries} from "./targetCompare";
import "./styles.sass";

// The overlay's metrics, each named by the key its own chart already wears.
const METRICS = [
    {id: "download", labelKey: "latest.down"},
    {id: "upload", labelKey: "latest.up"},
    {id: "ping", labelKey: "latest.ping"}
];

// The stock options close over a per-point error list; this chart draws no
// failure markers, so there is nothing for the callback to find.
const NO_ERRORS = [];

/**
 * The card that puts the targets side by side - the payoff the chips only
 * filter towards.
 *
 * Deliberately every target in list order whatever chip is active: the chip
 * narrows the page, and a comparison narrowed to one target compares nothing.
 * Collapsed it is the summary table once the figures for the shown range have
 * been fetched, and an invitation until then - the fetch is lazy, because N
 * statistics requests per range change would spend the rate budget the page's
 * own request lives on. Expanded it adds the overlaid series, one line per
 * target in the colour its chip dot already wears.
 */
export const TargetCompareChart = ({targets, statsById, fresh, expanded, onClick}) => {
    const [preferences] = useContext(PreferencesContext);
    const [metric, setMetric] = useState(METRICS[0].id);
    const themeColors = useChartTheme();
    const use12h = preferences?.timeFormat === TIME_FORMAT_12H;
    const speedUnit = getSpeedUnit(preferences);

    const rows = useMemo(() => targetSummaries(targets, statsById), [targets, statsById]);

    const series = useMemo(() => overlaySeries(targets, statsById, metric), [targets, statsById, metric]);

    // The union of the targets' instants feeds only the axis - span, step and
    // the single-day tick format. The datasets keep their own labels: the x
    // axis is linear epoch time, so disjoint instants share it natively.
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

    const pointStyle = useMemo(() => pointStyleFor(drawnPoints, {}), [drawnPoints]);
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
         * Index mode assumes every dataset shares one label array; these
         * datasets each keep their own, so the nearest single point is the
         * honest answer. axis stated explicitly - the shared builder leaves
         * it to the mode's default, and a later axis added there must not
         * silently retarget this chart.
         */
        options.interaction = {mode: "nearest", axis: "xy", intersect: false};

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

    // Whole numbers on the card, the conversion's decimals in the enlarged
    // view - the value cards' own precision rule, kept so the two surfaces
    // cannot state different figures for one payload.
    const speed = (mbps) => formatWithUnit(
        expanded ? convertSpeed(mbps, preferences) : wholeSpeed(mbps, preferences), speedUnit);

    const table = (
        <table className="target-compare-table">
            <thead>
                <tr>
                    <th scope="col">{t("targets.title")}</th>
                    <th scope="col">{t("latest.down")}</th>
                    <th scope="col">{t("latest.up")}</th>
                    <th scope="col">{t("latest.ping")}</th>
                    <th scope="col">{t("statistics.targets.failure_rate")}</th>
                </tr>
            </thead>
            <tbody>
                {rows.map((row) => (
                    <tr key={row.id}>
                        <th scope="row">
                            <span className="target-dot" style={{background: targetColour(row.colourIndex)}}/>
                            {row.name}
                        </th>
                        {row.unavailable ? (
                            // A failed fetch is not a line that answered with
                            // nothing - it must not wear the honest N/A.
                            <td colSpan={METRICS.length + 1} className="target-compare-unavailable">
                                {t("statistics.targets.unavailable")}
                            </td>
                        ) : (
                            /*
                             * The deltas compare the measurements, never the
                             * printed figures: a delta taken from speed()
                             * would move with the reader's unit preference
                             * and differ between this card and its modal,
                             * which is what the shared printer exists to
                             * prevent. The edge that buys, stated: the
                             * collapsed card rounds to whole units, so 899.6
                             * and 904.4 both print "900" with an arrow
                             * between them - wider than the one decimal the
                             * overview already accepts, and wider again in
                             * MB/s, where a whole unit is eight Mbit/s.
                             */
                            <>
                                <td>{speed(row.download)}
                                    <Delta current={row.download} previous={row.previous?.download}
                                           higherIsBetter={true}/></td>
                                <td>{speed(row.upload)}
                                    <Delta current={row.upload} previous={row.previous?.upload}
                                           higherIsBetter={true}/></td>
                                <td>{formatLatencyWithUnit(row.ping, t("latest.ping_unit"))}
                                    <Delta current={row.ping} previous={row.previous?.ping}
                                           higherIsBetter={false}/></td>
                                {/* Points of the percentage it already is,
                                    like the overview's loss row: 5% to 7% is
                                    two points, not forty per cent. */}
                                <td>{formatPercent(row.failureRate)}
                                    <Delta current={row.failureRate} previous={row.previous?.failureRate}
                                           higherIsBetter={false} mode="absolute" unit="%"/></td>
                            </>
                        )}
                    </tr>
                ))}
            </tbody>
        </table>
    );

    // The teaser costs no request: the names and their chip colours, and the
    // one line saying what opening the card does.
    const teaser = (
        <div className="target-compare-teaser">
            {targets.map((target, index) => (
                <span key={target.id} className="target-compare-name">
                    <span className="target-dot" style={{background: targetColour(index)}}/>
                    {target.name}
                </span>
            ))}
            <p className="target-compare-hint">{t("statistics.targets.open_hint")}</p>
        </div>
    );

    const body = () => {
        if (!fresh) return expanded
            ? <p className="target-compare-hint">{t("statistics.detail.loading")}</p>
            : teaser;

        if (!expanded) return table;

        return (
            <>
                <SegmentedControl className="target-compare-metric" label={t("statistics.targets.metric")}
                                  options={METRICS.map(({id, labelKey}) => ({id, label: t(labelKey)}))}
                                  value={metric} onChange={setMetric}/>
                {series.length > 0 ? (
                    <div className="target-compare-plot">
                        <ChartWrapper type="line" data={chartData} options={chartOptions}/>
                    </div>
                ) : (
                    <p className="target-compare-hint">{t("statistics.targets.empty")}</p>
                )}
                {table}
            </>
        );
    };

    return (
        <StatisticContainer title={t("statistics.targets.title")} size="wide" onClick={onClick}>
            <div className="target-compare-chart">
                {body()}
            </div>
        </StatisticContainer>
    );
};

export default TargetCompareChart;
