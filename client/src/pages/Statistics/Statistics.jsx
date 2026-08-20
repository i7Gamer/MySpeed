import {
    ArcElement, BarElement,
    CategoryScale,
    Chart as ChartJS,
    Legend,
    LinearScale,
    LineElement,
    PointElement,
    RadialLinearScale,
    Title,
    Tooltip,
    Filler
} from "chart.js";
import {useEffect, useState, useCallback, useContext, useMemo, useRef, startTransition, useDeferredValue} from "react";
import {useSearchParams} from "react-router-dom";
import {jsonRequest} from "@/common/utils/RequestUtil";
import {PreferencesContext} from "@/common/contexts/Preferences";
import {ConfigContext} from "@/common/contexts/Config";
import {
    DEFAULT_TIMEFRAME,
    TIMEFRAME_ALL,
    TIMEFRAME_CUSTOM,
    formatDateParam,
    isAllTime,
    parseRangeParams,
    resolveAllTime,
    selectionOf,
    serializeRange,
    shownRange,
    timezoneParams
} from "@/common/utils/TimeframeUtil";
import PageToolbar from "@/common/components/PageToolbar";
import ChartModal from "@/common/components/ChartModal";
import {formatDay} from "@/common/utils/FormatUtil";
import {hasPreviousData} from "@/common/components/Delta/deltas";
import {previousConnection} from "@/common/utils/TestUtil";
import SpeedChart from "@/pages/Statistics/charts/SpeedChart";
import LatestTestChart from "@/pages/Statistics/charts/LatestTestChart";
import PingChart from "@/pages/Statistics/charts/PingChart";
import OverviewChart from "@/pages/Statistics/charts/OverviewChart";
import AverageChart from "@/pages/Statistics/charts/AverageChart";
import HourlyChart from "@/pages/Statistics/charts/HourlyChart.jsx";
import ConsistencyChart from "@/pages/Statistics/charts/ConsistencyChart";
import ToggleSwitch from "@/common/components/ToggleSwitch";
import {crosshairPlugin} from "@/pages/Statistics/crosshairPlugin";
import i18n, {t} from "i18next";
import "./styles.sass";

// The charts a resolution control makes sense for. The hourly chart is 24 fixed
// buckets and the rest are not time series at all.
const LINE_CHARTS = ['download', 'upload', 'ping'];

/**
 * What the expanded chart's dialog announces as, one entry per case in
 * renderChart - chartModalDialog.test.js holds the two lists to each other.
 * Each key is the one the chart already draws as its own visible title, so the
 * dialog and its content answer to the same name.
 */
const CHART_MODAL_LABELS = {
    overview: "page.overview",
    latest: "latest.latest",
    consistency: "statistics.consistency.title",
    download: "latest.down",
    upload: "latest.up",
    ping: "latest.ping",
    hourly: "statistics.hourly.title",
    avgDownload: "statistics.values.down",
    avgUpload: "statistics.values.up"
};

const FULL_HEIGHT_CHARTS = [...LINE_CHARTS, 'hourly'];

// Panels that are a responsive grid rather than a plot: they need the dialog to
// have a width before they can lay out at all, but not a chart's height. Without
// it the latest test's whole record stacked into one 400px column - see
// .modal-wide.
const WIDE_PANELS = ['latest'];

// A request, not a guarantee: the server clamps this to its own ceiling and
// echoes what it actually used as `maxDataPoints`.
const FULL_DETAIL_POINTS = 1000;

// The newest test and enough of its neighbours for the detail pane to say what
// changed with it: the one before supplies every "since last time" figure, and
// previousConnection walks further back for the nearest test that names a
// connection at all - the row immediately before may carry none.
//
// Deliberately small. This is not the bufferbloat trend, which used to be built
// from a batch fetched here while ignoring the selected range entirely; that
// figure travels with the range statistics since it became an average over the
// range.
const RECENT_TESTS = 10;

ChartJS.register(ArcElement, Tooltip, CategoryScale, LinearScale, PointElement, LineElement, Title, Legend, BarElement, RadialLinearScale, Filler);

/**
 * The query naming the window to summarise.
 *
 * All time travels as `range=all` rather than as dates, so the server leaves the
 * rows unfiltered and buckets the charts over the extent of the tests
 * themselves. It carries the stand-in window as well, because a parent proxies
 * this request to its nodes and a node running an older version understands only
 * from/to - that window provably contains every test it can still hold, so it
 * answers with the same figures and merely coarser buckets.
 */
const rangeQuery = (dateRange) => {
    const requested = dateRange ?? resolveAllTime();

    const query = new URLSearchParams({
        from: formatDateParam(requested.from),
        to: formatDateParam(requested.to),
        // The server would otherwise cut days on its own clock, which is UTC in
        // the Docker image and rarely matches the viewer's.
        ...timezoneParams()
    });

    if (!dateRange) query.set("range", TIMEFRAME_ALL);

    return query;
};

if (!ChartJS.registry.plugins.get('crosshair')) ChartJS.register(crosshairPlugin);

ChartJS.defaults.color = "hsl(215, 20%, 55%)";
ChartJS.defaults.font.color = "hsl(215, 20%, 55%)";
ChartJS.defaults.font.family = "Inter, sans-serif";
ChartJS.defaults.font.weight = 500;
ChartJS.defaults.font.size = 11;
ChartJS.defaults.elements.line.tension = 0.35;
ChartJS.defaults.elements.line.borderWidth = 2.5;
ChartJS.defaults.elements.point.radius = 0;
ChartJS.defaults.elements.point.hoverRadius = 5;
ChartJS.defaults.elements.point.hoverBorderWidth = 2;
ChartJS.defaults.elements.arc.borderWidth = 0;
ChartJS.defaults.plugins.legend.labels.usePointStyle = true;
ChartJS.defaults.plugins.legend.labels.pointStyle = 'circle';
ChartJS.defaults.plugins.legend.labels.padding = 16;
ChartJS.defaults.plugins.legend.labels.boxWidth = 8;
ChartJS.defaults.plugins.legend.labels.boxHeight = 8;


export const Statistics = () => {
    const [statistics, setStatistics] = useState(null);
    const [recentTests, setRecentTests] = useState([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState(null);
    const [expandedChart, setExpandedChart] = useState(null);
    const [mountPhase, setMountPhase] = useState(0);
    const [detailStatistics, setDetailStatistics] = useState(null);
    const [detailLoading, setDetailLoading] = useState(false);
    // Which load is the current one. A ref rather than state: it is read inside
    // the callbacks of requests already in flight, and changing it must not
    // itself render.
    const requestGeneration = useRef(0);

    const [searchParams, setSearchParams] = useSearchParams();
    const [preferences, updatePreferences] = useContext(PreferencesContext);
    // The configured optima, which the value cards measure their averages
    // against. Absent until the config has loaded, and unset on an instance
    // nobody has told what it pays for - both render as no percentage.
    const [config] = useContext(ConfigContext);

    // The URL is the source of truth so a view stays bookmarkable and shareable;
    // the stored preference only supplies the default when the URL says nothing.
    const selection = useMemo(() => {
        const fromUrl = parseRangeParams(searchParams);
        if (fromUrl) return fromUrl;

        return selectionOf(preferences.defaultTimeframe ?? DEFAULT_TIMEFRAME);
    }, [searchParams, preferences.defaultTimeframe]);

    // Null for all time, which is the absence of a bound rather than a very wide
    // one: every caller below that needs a window says so for itself.
    const dateRange = useMemo(() => isAllTime(selection.timeframe)
        ? null
        : { from: selection.from, to: selection.to }, [selection]);

    const deferredStatistics = useDeferredValue(statistics);
    const isStale = deferredStatistics !== statistics;

    useEffect(() => {
        const timer = setTimeout(() => setMountPhase(1), 50);
        return () => clearTimeout(timer);
    }, []);

    useEffect(() => {
        if (mountPhase === 1) {
            const timer = setTimeout(() => setMountPhase(2), 150);
            return () => clearTimeout(timer);
        }
    }, [mountPhase]);

    const updateStats = useCallback(() => {
        const query = rangeQuery(dateRange);

        // The summary of the window immediately before, for the deltas. Nothing
        // precedes all time, so it is asked for only when the range is bounded.
        if (dateRange) query.set("compare", "previous");

        /**
         * Only the newest request may write to the page.
         *
         * Choosing a wide range and then a narrow one leaves the slow query in
         * flight, and it used to land regardless: the page then showed the
         * abandoned range's series and totals under the toolbar, URL and
         * heading of the range actually chosen. The failure path was worse - an
         * abandoned request that timed out set loadError after the newer one
         * had cleared it, replacing a page that had rendered correctly with the
         * full-screen error.
         */
        const generation = ++requestGeneration.current;
        const isCurrent = () => generation === requestGeneration.current;

        startTransition(() => {
            setLoadError(null);
            setLoading(true);
        });
        /*
         * Settled apart rather than awaited together.
         *
         * These are two independent reads: the aggregation the page is made of,
         * and the ten most recent tests behind the latest-test card and its
         * deltas. Under Promise.all either rejection took the whole page to the
         * full-screen error - so a recent-tests request timing out against a
         * flaky proxied node discarded a statistics payload that had arrived
         * perfectly, and two failure sources gated one page.
         *
         * Only the aggregation can blank the page now. The card simply draws
         * with nothing, which is what it already does before the first test.
         */
        Promise.allSettled([
            jsonRequest(`/speedtests/statistics/?${query}`),
            jsonRequest(`/speedtests?limit=${RECENT_TESTS}`)
        ]).then(([stats, tests]) => {
            if (!isCurrent()) return;

            if (stats.status === "rejected") {
                console.error("Failed to load statistics:", stats.reason);
                startTransition(() => {
                    setLoadError(stats.reason);
                    setLoading(false);
                });
                return;
            }

            if (tests.status === "rejected")
                console.error("Failed to load the recent tests:", tests.reason);

            startTransition(() => {
                setStatistics(stats.value);
                setRecentTests(tests.status === "fulfilled" && Array.isArray(tests.value) ? tests.value : []);
                setLoading(false);
            });
        });
    }, [dateRange]);

    const handleTimeframeChange = useCallback((timeframe) => {
        setSearchParams(serializeRange(timeframe), { replace: true });
        updatePreferences({ defaultTimeframe: timeframe });
    }, [setSearchParams, updatePreferences]);

    const handleDateRangeChange = useCallback((from, to) => {
        setSearchParams(serializeRange(TIMEFRAME_CUSTOM, from, to), { replace: true });
    }, [setSearchParams]);

    useEffect(() => {
        if (mountPhase >= 2) updateStats();
    }, [mountPhase, updateStats]);

    // `updateStats` has to be a dependency: with an empty array this kept the
    // very first closure alive and a language switch silently reloaded the
    // statistics for the *initial* date range instead of the selected one.
    useEffect(() => {
        const callback = () => updateStats();
        i18n.on("languageChanged", callback);
        return () => i18n.off("languageChanged", callback);
    }, [updateStats]);

    // The list is newest first, so the entry after the latest test is the
    // chronologically earlier one.
    const latestTest = recentTests[0] ?? null;
    const previousTest = recentTests[1] ?? null;
    const latestConnection = previousConnection(recentTests, 0);

    const isDownsampled = deferredStatistics?.downsampled === true;
    const wantsDetail = LINE_CHARTS.includes(expandedChart) && preferences.fullChartDetail === true;

    /**
     * Fetches the high-resolution series, on demand and only for the chart the
     * reader has actually opened.
     *
     * Deliberately a second payload rather than raising the resolution of the
     * page request: the eight cards on the overview gain nothing from a thousand
     * points each, and re-rendering all of them to serve one open chart is the
     * expensive part.
     */
    useEffect(() => {
        if (!wantsDetail || !isDownsampled) {
            setDetailStatistics(null);
            // Cleared here too: closing the chart while its request was in
            // flight left the flag latched, and the toolbar said "Loading…"
            // for the rest of the session.
            setDetailLoading(false);
            return;
        }

        const query = rangeQuery(dateRange);
        query.set("points", String(FULL_DETAIL_POINTS));

        let cancelled = false;
        setDetailLoading(true);

        jsonRequest(`/speedtests/statistics/?${query}`)
            .then(stats => { if (!cancelled) setDetailStatistics(stats); })
            .catch(error => console.error("Failed to load the detailed statistics:", error))
            .finally(() => { if (!cancelled) setDetailLoading(false); });

        return () => { cancelled = true; };
    }, [wantsDetail, isDownsampled, dateRange]);

    if (mountPhase === 0) return null;

    // The toolbar is real here rather than a shimmer: it needs nothing from the
    // statistics being fetched, and its controls - the range being loaded, and
    // starting a test - are exactly what someone waiting might want to reach.
    const toolbar = (
        <PageToolbar
            from={dateRange?.from ?? null}
            to={dateRange?.to ?? null}
            timeframe={selection.timeframe}
            onRangeChange={handleDateRangeChange}
            onTimeframeChange={handleTimeframeChange}
            // All-time carries no range, but the export endpoint takes one -
            // resolveAllTime is that window.
            exportRange={dateRange ?? resolveAllTime()}
        />
    );

    if (loading && !deferredStatistics) {
        return (
            <div className="statistic-area statistic-loading">
                {toolbar}
                <div className="skeleton-chart skeleton-visible"></div>
                <div className="skeleton-chart skeleton-visible"></div>
                <div className="skeleton-chart skeleton-visible"></div>
            </div>
        );
    }

    // The request failing used to leave `statistics` null with loading false,
    // which fell through to the empty fragment below: the page went completely
    // blank, with no message and nothing to click.
    //
    // Not gated on the statistics being absent any more. That gate made this
    // branch unreachable once anything had loaded, so a later failure fell
    // through and rendered the *previous* range's numbers under the new
    // range's heading - and OverviewChart divides them by the new range's day
    // count, so the heading and the density disagreed with nothing to say why.
    // An ordinary request timeout was enough to get there.
    if (loadError) {
        return (
            <div className="statistic-area">
                {/* The toolbar works without the statistics, and a failed load
                    is exactly when changing the range is the way out. */}
                {toolbar}
                <div className="statistics-empty">
                    <p className="icon-red">{loadError.message}</p>
                    <button className="dialog-btn" onClick={updateStats}>{t("dialog.retry")}</button>
                </div>
            </div>
        );
    }

    if (!deferredStatistics) return <></>;
    if (!deferredStatistics.tests || deferredStatistics.tests.total === 0) return (
        <div className="statistic-area">
            {toolbar}
            {/* Named rather than a bare "no tests available": the range is
                almost always what emptied this, and one click widens it back to
                everything. All time has no range to name, and nothing to widen -
                the instance simply has no tests. */}
            <div className="statistics-empty">
                {dateRange ? (
                    <>
                        <p>{t("test.not_available_in_range",
                            {from: formatDay(dateRange.from), to: formatDay(dateRange.to)})}</p>
                        <button className="dialog-btn" onClick={() => handleTimeframeChange(TIMEFRAME_ALL)}>
                            {t("test.show_all_time")}
                        </button>
                    </>
                ) : <p>{t("test.not_available")}</p>}
            </div>
        </div>
    );

    // `source` is the high-resolution payload when one has been fetched for this
    // chart, and the page payload otherwise.
    // The gate in front of every delta: a previous window nobody tested in has
    // no figures to compare against, and its zeros must not colour the page.
    const previous = hasPreviousData(deferredStatistics.previous) ? deferredStatistics.previous : null;

    // The window the page is actually showing, which the overview card is named
    // after. All time has none of its own, so it is the extent of the tests
    // themselves - the first to the last - as echoed by the server.
    const chartRange = shownRange(dateRange, deferredStatistics);

    const renderChart = (chartType, source) => {
        switch (chartType) {
            case 'overview':
                return <OverviewChart tests={deferredStatistics.tests} time={deferredStatistics.time} packetLoss={deferredStatistics.packetLoss} hourlyAverages={deferredStatistics.hourlyAverages} ping={deferredStatistics.ping} dateRange={chartRange} previous={previous} expanded/>;
            case 'latest':
                return <LatestTestChart test={latestTest} previous={previousTest}
                                        previousConnection={latestConnection} expanded/>;
            case 'consistency':
                // The spread each deviation summarises, which the page already
                // holds: a standard deviation is the honest figure and an
                // unreadable one.
                return <ConsistencyChart consistency={deferredStatistics.consistency} expanded
                                         ranges={{download: deferredStatistics.download, upload: deferredStatistics.upload,
                                             ping: deferredStatistics.ping, jitter: deferredStatistics.jitter}}/>;
            case 'download':
                return <SpeedChart labels={source.labels} data={source.data} dataKey="download" titleKey={CHART_MODAL_LABELS.download} color="hsl(187, 94%, 43%)" failed={source.failed} errors={source.errors} downsampled={source.downsampled} dataPoints={source.dataPoints} rawDataPoints={source.rawDataPoints} />;
            case 'upload':
                return <SpeedChart labels={source.labels} data={source.data} dataKey="upload" titleKey={CHART_MODAL_LABELS.upload} color="hsl(258, 90%, 66%)" failed={source.failed} errors={source.errors} downsampled={source.downsampled} dataPoints={source.dataPoints} rawDataPoints={source.rawDataPoints} />;
            case 'ping':
                return <PingChart labels={source.labels} data={source.data} failed={source.failed} errors={source.errors} downsampled={source.downsampled} dataPoints={source.dataPoints} rawDataPoints={source.rawDataPoints}/>;
            case 'hourly':
                return <HourlyChart hourlyAverages={deferredStatistics.hourlyAverages}/>;
            case 'avgDownload':
                return <AverageChart title={t(CHART_MODAL_LABELS.avgDownload)} data={deferredStatistics.download} previous={previous?.download} target={config?.download}
                                    consistency={deferredStatistics.consistency?.download} tests={deferredStatistics.tests} expanded/>;
            case 'avgUpload':
                return <AverageChart title={t(CHART_MODAL_LABELS.avgUpload)} data={deferredStatistics.upload} previous={previous?.upload} target={config?.upload}
                                    consistency={deferredStatistics.consistency?.upload} tests={deferredStatistics.tests} expanded/>;
            default:
                return null;
        }
    };

    const detailHint = () => {
        if (!isDownsampled) return t("statistics.detail.complete");
        if (detailLoading) return t("statistics.detail.loading");
        return t("statistics.detail.description", {max: FULL_DETAIL_POINTS});
    };

    // Only the time series can trade payload size for resolution; the others
    // have a fixed number of points by construction.
    const detailToolbar = LINE_CHARTS.includes(expandedChart) ? (
        <div className="chart-detail-toggle">
            <ToggleSwitch checked={preferences.fullChartDetail === true}
                          onChange={(value) => updatePreferences({fullChartDetail: value})}
                          disabled={!isDownsampled}/>
            <div className="chart-detail-text">
                <span className="chart-detail-label">{t("statistics.detail.title")}</span>
                <span className="chart-detail-hint">{detailHint()}</span>
            </div>
        </div>
    ) : null;

    return (
        <div className={`statistic-area${isStale ? ' statistic-stale' : ''}`}>
            {toolbar}

            {/* Stated once for the whole page, so every delta below can be a
                bare arrow and number instead of each repeating the window. */}
            {previous && (
                <p className="statistics-compare-note">
                    {t("statistics.compare.note", {
                        from: formatDay(previous.dateRange.from),
                        to: formatDay(previous.dateRange.to)
                    })}
                </p>
            )}

            <OverviewChart tests={deferredStatistics.tests} time={deferredStatistics.time} packetLoss={deferredStatistics.packetLoss} hourlyAverages={deferredStatistics.hourlyAverages} dateRange={chartRange} previous={previous} onClick={() => setExpandedChart('overview')}/>
            <LatestTestChart test={latestTest} onClick={() => setExpandedChart('latest')}/>
            <ConsistencyChart consistency={deferredStatistics.consistency} onClick={() => setExpandedChart('consistency')}/>

            {/* The latency chart leads the second row so that the two speed
                charts start at its second column - which is where the value
                cards below them start too, one row down. Led by a speed chart
                the columns came out shifted by one, and "Download" averages sat
                directly under the *upload* chart while "Upload" averages sat
                under the ping: two cards about the same metric, one above the
                other, naming different ones. Nothing else decides this - every
                card takes the same share of the row - so the pairing is a
                property of this order and statisticsReflow.test.js holds it. */}
            <PingChart labels={deferredStatistics.labels} data={deferredStatistics.data} failed={deferredStatistics.failed} errors={deferredStatistics.errors} downsampled={deferredStatistics.downsampled} dataPoints={deferredStatistics.dataPoints} rawDataPoints={deferredStatistics.rawDataPoints} onClick={() => setExpandedChart('ping')} compact/>
            <SpeedChart labels={deferredStatistics.labels} data={deferredStatistics.data} dataKey="download" titleKey={CHART_MODAL_LABELS.download} color="hsl(187, 94%, 43%)" failed={deferredStatistics.failed} errors={deferredStatistics.errors} downsampled={deferredStatistics.downsampled} dataPoints={deferredStatistics.dataPoints} rawDataPoints={deferredStatistics.rawDataPoints} onClick={() => setExpandedChart('download')} compact/>
            <SpeedChart labels={deferredStatistics.labels} data={deferredStatistics.data} dataKey="upload" titleKey={CHART_MODAL_LABELS.upload} color="hsl(258, 90%, 66%)" failed={deferredStatistics.failed} errors={deferredStatistics.errors} downsampled={deferredStatistics.downsampled} dataPoints={deferredStatistics.dataPoints} rawDataPoints={deferredStatistics.rawDataPoints} onClick={() => setExpandedChart('upload')} compact/>

            <HourlyChart hourlyAverages={deferredStatistics.hourlyAverages} onClick={() => setExpandedChart('hourly')}/>

            <AverageChart title={t(CHART_MODAL_LABELS.avgDownload)} data={deferredStatistics.download} previous={previous?.download} target={config?.download} onClick={() => setExpandedChart('avgDownload')}/>
            <AverageChart title={t(CHART_MODAL_LABELS.avgUpload)} data={deferredStatistics.upload} previous={previous?.upload} target={config?.upload} onClick={() => setExpandedChart('avgUpload')}/>

            <ChartModal
                isOpen={!!expandedChart}
                onClose={() => setExpandedChart(null)}
                isChart={FULL_HEIGHT_CHARTS.includes(expandedChart)}
                wide={WIDE_PANELS.includes(expandedChart)}
                toolbar={detailToolbar}
                label={expandedChart ? t(CHART_MODAL_LABELS[expandedChart]) : undefined}
            >
                {expandedChart && renderChart(expandedChart, detailStatistics ?? deferredStatistics)}
            </ChartModal>
        </div>
    );
}