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
import {useEffect, useState, useCallback, useContext, useMemo, startTransition, useDeferredValue} from "react";
import {useSearchParams} from "react-router-dom";
import {jsonRequest} from "@/common/utils/RequestUtil";
import {PreferencesContext} from "@/common/contexts/Preferences";
import {
    DEFAULT_TIMEFRAME,
    TIMEFRAME_CUSTOM,
    formatDateParam,
    parseRangeParams,
    resolveTimeframe,
    serializeRange
} from "@/common/utils/TimeframeUtil";
import DateRangePicker from "@/common/components/DateRangePicker";
import ChartModal from "@/common/components/ChartModal";
import SpeedChart from "@/pages/Statistics/charts/SpeedChart";
import LatestTestChart from "@/pages/Statistics/charts/LatestTestChart";
import PingChart from "@/pages/Statistics/charts/PingChart";
import OverviewChart from "@/pages/Statistics/charts/OverviewChart";
import AverageChart from "@/pages/Statistics/charts/AverageChart";
import HourlyChart from "@/pages/Statistics/charts/HourlyChart.jsx";
import ConsistencyChart from "@/pages/Statistics/charts/ConsistencyChart";
import ExportButton from "@/common/components/ExportButton";
import ToggleSwitch from "@/common/components/ToggleSwitch";
import i18n, {t} from "i18next";
import "./styles.sass";

// The charts a resolution control makes sense for. The hourly chart is 24 fixed
// buckets and the rest are not time series at all.
const LINE_CHARTS = ['download', 'upload', 'ping'];

const FULL_HEIGHT_CHARTS = [...LINE_CHARTS, 'hourly'];

// A request, not a guarantee: the server clamps this to its own ceiling and
// echoes what it actually used as `maxDataPoints`.
const FULL_DETAIL_POINTS = 1000;

// Only the newest test is needed here now. The bufferbloat trend used to be
// built from a batch fetched alongside the statistics, ignoring the selected
// range entirely; it travels with the range statistics since it became an
// average over that range.
const LATEST_TEST_ONLY = 1;

ChartJS.register(ArcElement, Tooltip, CategoryScale, LinearScale, PointElement, LineElement, Title, Legend, BarElement, RadialLinearScale, Filler);

const crosshairPlugin = {
    id: 'crosshair',
    afterDraw: (chart) => {
        if (chart.tooltip?._active?.length) {
            const ctx = chart.ctx;
            const activePoint = chart.tooltip._active[0];
            const x = activePoint.element.x;
            const topY = chart.scales.y.top;
            const bottomY = chart.scales.y.bottom;

            ctx.save();
            ctx.beginPath();
            ctx.setLineDash([5, 5]);
            ctx.moveTo(x, topY);
            ctx.lineTo(x, bottomY);
            ctx.lineWidth = 1;
            ctx.strokeStyle = 'hsla(215, 20%, 65%, 0.6)';
            ctx.stroke();
            ctx.restore();
        }
    }
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
    const [latestTest, setLatestTest] = useState(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState(null);
    const [expandedChart, setExpandedChart] = useState(null);
    const [mountPhase, setMountPhase] = useState(0);
    const [detailStatistics, setDetailStatistics] = useState(null);
    const [detailLoading, setDetailLoading] = useState(false);

    const [searchParams, setSearchParams] = useSearchParams();
    const [preferences, updatePreferences] = useContext(PreferencesContext);

    // The URL is the source of truth so a view stays bookmarkable and shareable;
    // the stored preference only supplies the default when the URL says nothing.
    const selection = useMemo(() => {
        const fromUrl = parseRangeParams(searchParams);
        if (fromUrl) return fromUrl;

        const timeframe = preferences.defaultTimeframe ?? DEFAULT_TIMEFRAME;
        return { timeframe, ...resolveTimeframe(timeframe) };
    }, [searchParams, preferences.defaultTimeframe]);

    const dateRange = useMemo(() => ({ from: selection.from, to: selection.to }), [selection]);

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
        const query = new URLSearchParams({
            from: formatDateParam(dateRange.from),
            to: formatDateParam(dateRange.to),
            // The server would otherwise cut days on its own clock, which is UTC
            // in the Docker image and rarely matches the viewer's.
            tzOffset: String(new Date().getTimezoneOffset())
        });

        startTransition(() => {
            setLoadError(null);
            setLoading(true);
        });
        Promise.all([
            jsonRequest(`/speedtests/statistics/?${query}`),
            jsonRequest(`/speedtests?limit=${LATEST_TEST_ONLY}`)
        ]).then(([stats, tests]) => {
            startTransition(() => {
                setStatistics(stats);
                setLatestTest(tests.length > 0 ? tests[0] : null);
                setLoading(false);
            });
        }).catch(error => {
            console.error("Failed to load statistics:", error);
            startTransition(() => {
                setLoadError(error);
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

        const query = new URLSearchParams({
            from: formatDateParam(dateRange.from),
            to: formatDateParam(dateRange.to),
            tzOffset: String(new Date().getTimezoneOffset()),
            points: String(FULL_DETAIL_POINTS)
        });

        let cancelled = false;
        setDetailLoading(true);

        jsonRequest(`/speedtests/statistics/?${query}`)
            .then(stats => { if (!cancelled) setDetailStatistics(stats); })
            .catch(error => console.error("Failed to load the detailed statistics:", error))
            .finally(() => { if (!cancelled) setDetailLoading(false); });

        return () => { cancelled = true; };
    }, [wantsDetail, isDownsampled, dateRange]);

    if (mountPhase === 0) return null;

    if (loading && !deferredStatistics) {
        return (
            <div className="statistic-area statistic-loading">
                <div className="statistics-header">
                    <div className="skeleton-picker skeleton-visible"></div>
                </div>
                <div className="skeleton-chart skeleton-visible"></div>
                <div className="skeleton-chart skeleton-visible"></div>
                <div className="skeleton-chart skeleton-visible"></div>
            </div>
        );
    }

    // The request failing used to leave `statistics` null with loading false,
    // which fell through to the empty fragment below: the page went completely
    // blank, with no message and nothing to click.
    if (loadError && !deferredStatistics) {
        return (
            <div className="statistic-area">
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
            <div className="statistics-header">
                <DateRangePicker
                    from={dateRange.from}
                    to={dateRange.to}
                    onChange={handleDateRangeChange}
                    timeframe={selection.timeframe}
                    onTimeframeChange={handleTimeframeChange}
                />
            </div>
            <div className="statistics-empty">
                <p>{t("test.not_available")}</p>
            </div>
        </div>
    );

    // `source` is the high-resolution payload when one has been fetched for this
    // chart, and the page payload otherwise.
    const renderChart = (chartType, source) => {
        switch (chartType) {
            case 'overview':
                return <OverviewChart tests={deferredStatistics.tests} time={deferredStatistics.time} packetLoss={deferredStatistics.packetLoss} dateRange={dateRange}/>;
            case 'latest':
                return <LatestTestChart test={latestTest} expanded/>;
            case 'consistency':
                return <ConsistencyChart consistency={deferredStatistics.consistency}/>;
            case 'download':
                return <SpeedChart labels={source.labels} data={source.data} dataKey="download" titleKey="latest.down" color="hsl(187, 94%, 43%)" failed={source.failed} errors={source.errors} downsampled={source.downsampled} dataPoints={source.dataPoints} rawDataPoints={source.rawDataPoints} />;
            case 'upload':
                return <SpeedChart labels={source.labels} data={source.data} dataKey="upload" titleKey="latest.up" color="hsl(258, 90%, 66%)" failed={source.failed} errors={source.errors} downsampled={source.downsampled} dataPoints={source.dataPoints} rawDataPoints={source.rawDataPoints} />;
            case 'ping':
                return <PingChart labels={source.labels} data={source.data} failed={source.failed} errors={source.errors} downsampled={source.downsampled} dataPoints={source.dataPoints} rawDataPoints={source.rawDataPoints}/>;
            case 'hourly':
                return <HourlyChart hourlyAverages={deferredStatistics.hourlyAverages}/>;
            case 'avgDownload':
                return <AverageChart title={t("statistics.values.down")} data={deferredStatistics.download}/>;
            case 'avgUpload':
                return <AverageChart title={t("statistics.values.up")} data={deferredStatistics.upload}/>;
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
            <div className="statistics-header">
                <DateRangePicker
                    from={dateRange.from}
                    to={dateRange.to}
                    onChange={handleDateRangeChange}
                    timeframe={selection.timeframe}
                    onTimeframeChange={handleTimeframeChange}
                />
                <ExportButton dateRange={dateRange} />
            </div>

            <OverviewChart tests={deferredStatistics.tests} time={deferredStatistics.time} packetLoss={deferredStatistics.packetLoss} dateRange={dateRange} onClick={() => setExpandedChart('overview')}/>
            <LatestTestChart test={latestTest} onClick={() => setExpandedChart('latest')}/>
            <ConsistencyChart consistency={deferredStatistics.consistency} onClick={() => setExpandedChart('consistency')}/>

            <SpeedChart labels={deferredStatistics.labels} data={deferredStatistics.data} dataKey="download" titleKey="latest.down" color="hsl(187, 94%, 43%)" failed={deferredStatistics.failed} errors={deferredStatistics.errors} downsampled={deferredStatistics.downsampled} dataPoints={deferredStatistics.dataPoints} rawDataPoints={deferredStatistics.rawDataPoints} onClick={() => setExpandedChart('download')} compact/>
            <SpeedChart labels={deferredStatistics.labels} data={deferredStatistics.data} dataKey="upload" titleKey="latest.up" color="hsl(258, 90%, 66%)" failed={deferredStatistics.failed} errors={deferredStatistics.errors} downsampled={deferredStatistics.downsampled} dataPoints={deferredStatistics.dataPoints} rawDataPoints={deferredStatistics.rawDataPoints} onClick={() => setExpandedChart('upload')} compact/>
            <PingChart labels={deferredStatistics.labels} data={deferredStatistics.data} failed={deferredStatistics.failed} errors={deferredStatistics.errors} downsampled={deferredStatistics.downsampled} dataPoints={deferredStatistics.dataPoints} rawDataPoints={deferredStatistics.rawDataPoints} onClick={() => setExpandedChart('ping')} compact/>

            <HourlyChart hourlyAverages={deferredStatistics.hourlyAverages} onClick={() => setExpandedChart('hourly')}/>

            <AverageChart title={t("statistics.values.down")} data={deferredStatistics.download} onClick={() => setExpandedChart('avgDownload')}/>
            <AverageChart title={t("statistics.values.up")} data={deferredStatistics.upload} onClick={() => setExpandedChart('avgUpload')}/>

            <ChartModal
                isOpen={!!expandedChart}
                onClose={() => setExpandedChart(null)}
                isChart={FULL_HEIGHT_CHARTS.includes(expandedChart)}
                toolbar={detailToolbar}
            >
                {expandedChart && renderChart(expandedChart, detailStatistics ?? deferredStatistics)}
            </ChartModal>
        </div>
    );
}