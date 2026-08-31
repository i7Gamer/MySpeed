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
import {FULL_DETAIL_POINTS, PreferencesContext} from "@/common/contexts/Preferences";
import {ConfigContext} from "@/common/contexts/Config";
import {NodeContext} from "@/common/contexts/Node";
import {TargetsContext} from "@/common/contexts/Targets";
import {previousOfTarget, resolveLimits} from "@/common/utils/TargetUtil";
import {
    DEFAULT_TIMEFRAME,
    TIMEFRAME_ALL,
    TIMEFRAME_CUSTOM,
    compareToParams,
    formatDateParam,
    isAllTime,
    parseCompareParams,
    parseRangeParams,
    resolveAllTime,
    selectionOf,
    serializeRange,
    shownRange,
    timezoneParams
} from "@/common/utils/TimeframeUtil";
import PageToolbar from "@/common/components/PageToolbar";
import ChartModal from "@/common/components/ChartModal";
import CompareSelect from "@/pages/Statistics/components/CompareSelect";
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
import TargetCompareChart, {TargetCompareTable} from "@/pages/Statistics/charts/TargetCompareChart";
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
    avgUpload: "statistics.values.up",
    targets: "statistics.targets.title",
    targetsPing: "statistics.targets.chart.ping",
    targetsDownload: "statistics.targets.chart.download",
    targetsUpload: "statistics.targets.chart.upload"
};

/*
 * The comparison's four panels - three overlay charts and the table of figures
 * beside them - named together because they share both of their gates: two
 * targets to compare, and no chip narrowing the page. The modal is plain state
 * and has to be closed when either gate shuts under an open one.
 */
const TARGET_COMPARE_CHARTS = ['targetsPing', 'targetsDownload', 'targetsUpload'];
const TARGET_PANELS = ['targets', ...TARGET_COMPARE_CHARTS];

// Which metric a comparison panel draws, taken from the panel's own name so the
// two cannot drift: 'targetsUpload' is the upload chart by construction rather
// than by a second table somebody has to keep in step with this one.
const metricOf = (panel) => panel.slice("targets".length).toLowerCase();

const FULL_HEIGHT_CHARTS = [...LINE_CHARTS, 'hourly', ...TARGET_COMPARE_CHARTS];

// Panels that are a responsive grid rather than a plot: they need the dialog to
// have a width before they can lay out at all, but not a chart's height. Without
// it the latest test's whole record stacked into one 400px column - see
// .modal-wide.
const WIDE_PANELS = ['latest', 'targets'];

// A request, not a guarantee: the server clamps this to its own ceiling and
// echoes what it actually used as `maxDataPoints`.
// Shared with the preferences dialog, which promises the same number in the
// sentence behind its icon - see contexts/Preferences/constants.

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

/**
 * How a request says what to compare the range against.
 *
 * One helper for both request sites, so the page and the comparison card
 * cannot ask different questions of the same window. Nothing precedes all
 * time, so a rangeless request asks for no comparison at all - the route
 * refuses it anyway, and asking buys a second table scan over a window that
 * cannot hold a test.
 */
const applyCompare = (query, dateRange, compare) => {
    if (!dateRange) return query;

    query.set("compare", compare);

    return query;
};

if (!ChartJS.registry.plugins.get('crosshair')) ChartJS.register(crosshairPlugin);

// No default text colour: it was a grey picked for a dark page and set once at
// import, which no theme change can reach. Every chart names its own tick and
// legend colour from the palette - see lineChartOptions - so this only ever
// applied to text that no longer exists.
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
    // The comparison card's per-target payloads, with the key they answer for
    // - see the compare effect below for why they are fetched lazily.
    const [compareStats, setCompareStats] = useState(null);
    // Its own generation, never updateStats' ref: bumping the shared one from
    // here would make a page request already in flight fail its isCurrent()
    // check and return before setLoading(false) - a page that spins forever
    // because somebody opened a card during a slow load.
    const compareGeneration = useRef(0);
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
    const {targets, selectedTarget, pageTargetFor} = useContext(TargetsContext);

    // Which target the page is narrowed to, or null for all of them - the
    // same resolved chip selection the overview reads, so the two pages cannot
    // show different slices under one chip row.
    const targetFilter = selectedTarget;

    /*
     * The active node, read by position the way SpeedtestContext reads it.
     *
     * Not to aim the requests - RequestUtil builds its root from the stored
     * selection at request time, so every fetch below already reaches the
     * right node - but to notice the selection changed under the page.
     * Reachable without leaving it: NodeContext's reconciliation drops a node
     * deleted from another browser, and the charts then kept showing the
     * dropped node's figures under the new node's header until the next range
     * change happened to re-ask.
     */
    const [, , currentNode] = useContext(NodeContext);

    // The URL is the source of truth so a view stays bookmarkable and shareable;
    // the stored preference only supplies the default when the URL says nothing.
    const selection = useMemo(() => {
        const fromUrl = parseRangeParams(searchParams);
        if (fromUrl) return fromUrl;

        return selectionOf(preferences.defaultTimeframe ?? DEFAULT_TIMEFRAME);
    }, [searchParams, preferences.defaultTimeframe]);

    // The window the deltas are read against, or null for the period before
    // the range - which is what the server does when nothing names one. Read
    // from the URL like the range, so a comparison is a link somebody keeps.
    const compare = useMemo(() => parseCompareParams(searchParams), [searchParams]);

    // Null for all time, which is the absence of a bound rather than a very wide
    // one: every caller below that needs a window says so for itself.
    const dateRange = useMemo(() => isAllTime(selection.timeframe)
        ? null
        : { from: selection.from, to: selection.to }, [selection]);

    const deferredStatistics = useDeferredValue(statistics);

    /*
     * The gate in front of every delta: a previous window nobody tested in has
     * no figures to compare against, and its zeros must not colour the page.
     *
     * Declared here, beside the payload it reads, rather than down among the
     * charts. It used to sit there because the charts were its only readers -
     * and then the comparison row, which names the window this answers for,
     * was lifted out of the returned tree into a const of its own. A const is
     * evaluated where it is written, so the row read this one two hundred
     * lines before the line that declares it: "Cannot access 'previous' before
     * initialization", thrown while rendering, from a build that compiles
     * cleanly and a suite that never renders the page.
     *
     * And optional on the way in, which everything reading this payload above
     * the `if (!deferredStatistics)` guard has to be: `statistics` opens as
     * null, so the first render of every visit reaches this line with nothing
     * in it. Down among the charts that was already settled - the guard stands
     * between - and moving up here put it back in front of the question. The
     * two other early readers, gradeLimits and isDownsampled, have always
     * spelled it this way.
     */
    const previousWindow = deferredStatistics?.previous;
    const previous = hasPreviousData(previousWindow) ? previousWindow : null;

    // The dates both wordings of the note fill in - the same pair either way,
    // since what differs between them is only whether the window held anything.
    // Optional on the way in, like everything else that reads this payload
    // above the guard that settles it. `previousWindow &&` answers for the
    // object and not for what is inside it, and a previous window arriving
    // without its dateRange - an older node, a shape nobody has shipped yet -
    // would throw here during render rather than draw one sentence less.
    const comparedWindow = previousWindow?.dateRange && {
        from: formatDay(previousWindow.dateRange.from),
        to: formatDay(previousWindow.dateRange.to)
    };

    const isStale = deferredStatistics !== statistics;

    /*
     * What the cards and charts grade against: the optima of the target the
     * page is showing where it is showing one - the chip's, or the sole target
     * of an instance that draws no chips - and the instance-wide settings for a
     * genuine mixture, whose averages only the global values can judge. See
     * pageTarget for why this is not simply the chip selection.
     *
     * Asked of the payload the cards are drawn from rather than of the newest
     * one in flight, and below it rather than beside the context read, because
     * the payload is half the question: a single-target instance still holds
     * the rows of every target it deleted, and only the answer that carried
     * these figures knows whether they are in them. Taking the grade from one
     * payload and the numbers from another is how a stale range would be judged
     * by the target composition of the range replacing it.
     */
    const gradeLimits = resolveLimits(pageTargetFor(deferredStatistics?.targetIds), config ?? {});

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

        // The summary of the window the deltas are read against - the period
        // before by default, or the one the URL names. Nothing precedes all
        // time, so it is asked for only when the range is bounded.
        applyCompare(query, dateRange, compare);

        if (targetFilter != null) query.set("target", String(targetFilter));

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
            // The latest-test card follows the chip too - "the latest test"
            // on a filtered page means the filtered target's latest.
            jsonRequest(`/speedtests?limit=${RECENT_TESTS}`
                + (targetFilter != null ? `&target=${targetFilter}` : ""))
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
        }).catch(error => {
            // allSettled cannot reject; the handler above it can. Without this
            // that throw was terminal - setLoading(false) never ran, so the page
            // span for ever with nothing on it and nothing logged. The old
            // .catch went out with Promise.all on the reading that it had become
            // redundant, and what it actually guards is this handler.
            if (!isCurrent()) return;

            console.error("Failed to render the statistics:", error);
            startTransition(() => {
                setLoadError(error);
                setLoading(false);
            });
        });
        // currentNode: see its destructure above - a page whose requests have
        // been re-aimed under it has to re-ask. The rule cannot see that
        // dependency, since what the value changes is where the api module
        // points rather than anything named in this callback, and reads it as
        // one to drop.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dateRange, currentNode, targetFilter, compare]);

    const handleTimeframeChange = useCallback((timeframe) => {
        setSearchParams(serializeRange(timeframe), { replace: true });
        updatePreferences({ defaultTimeframe: timeframe });
    }, [setSearchParams, updatePreferences]);

    const handleDateRangeChange = useCallback((from, to) => {
        setSearchParams(serializeRange(TIMEFRAME_CUSTOM, from, to), { replace: true });
    }, [setSearchParams]);

    /**
     * The window the page compares against, chosen rather than implied.
     *
     * The whole selection is rewritten, because setSearchParams replaces the
     * query string: the range has to be re-stated or naming a comparison
     * window would silently drop the page back to its default range.
     *
     * A range change drops the comparison window on purpose, and for free -
     * the two callbacks above replace the query string without it. "This
     * August against last August" narrowed to "last 7 days" would otherwise
     * compare a week against a month, which is the mismatch the elapsed cut
     * exists to prevent.
     */
    const handleCompareChange = useCallback((choice) => {
        setSearchParams({
            ...serializeRange(selection.timeframe, selection.from, selection.to),
            ...compareToParams(choice)
        }, { replace: true });
    }, [setSearchParams, selection]);

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
    // chronologically earlier one - but only rows of the same target are
    // comparable, and with no chip selected this list interleaves them all.
    // See previousOfTarget; previousConnection walks the same way for the
    // same kind of reason.
    const latestTest = recentTests[0] ?? null;
    const previousTest = previousOfTarget(recentTests, 0) ?? null;
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
        if (targetFilter != null) query.set("target", String(targetFilter));

        let cancelled = false;
        setDetailLoading(true);

        jsonRequest(`/speedtests/statistics/?${query}`)
            .then(stats => { if (!cancelled) setDetailStatistics(stats); })
            .catch(error => console.error("Failed to load the detailed statistics:", error))
            .finally(() => { if (!cancelled) setDetailLoading(false); });

        return () => { cancelled = true; };
        // currentNode for the reason updateStats lists it: a page whose
        // requests have been re-aimed under it has to re-ask, or the previous
        // node's thousand-point series renders under the new node's heading.
        // Today the layout happens to make that unreachable - switching nodes
        // unmounts this page - but the dependency is what guards it on purpose.
    }, [wantsDetail, isDownsampled, dateRange, targetFilter, currentNode]);

    /*
     * What the comparison card's figures answer for, by value rather than by
     * identity: dateRange is a fresh object on every unrelated URL change, and
     * the targets array is replaced by a cosmetic reload - the query the
     * requests actually carry, the aimed node and the id list are the three
     * things a cached answer must match. Ids, not the array: add, delete and
     * reorder all change the list; a rename changes nothing these payloads
     * hold.
     */
    const compareKey = useMemo(() => [String(rangeQuery(dateRange)), String(currentNode ?? ""),
        targets.map(({id}) => id).join(","),
        // The comparison window too: the rows' deltas are read against it, so
        // a cached answer taken under one window is the wrong answer under
        // the next - and the card can be open while the row below it changes
        // the window.
        compare
    ].join("|"), [dateRange, currentNode, targets, compare]);
    const compareFresh = compareStats?.key === compareKey;

    /*
     * What the four comparison panels read, resolved once. A stale byId is the
     * previous range's series wearing this range's heading - the fault the
     * page's own stale guard exists for, which the Back button reaches with a
     * panel open - and four render sites each spelling the gate for themselves
     * is four places for one of them to forget it.
     */
    const compareStatsById = compareFresh ? compareStats.byId : null;

    /*
     * The comparison's fetch: eager now, and one request rather than N.
     *
     * It used to wait for a click, because asking per target spent the
     * statistics family's own fixed-window budget - 60 a minute for a
     * question that costs a full range scan - and a 429 there blanks the whole
     * page. At three targets a reader stepping through the timeframe presets
     * reached that ceiling on its own. So the panels showed an invitation
     * instead of figures, which is the wrong trade: the comparison is a
     * reading, and a reading nobody can see without asking twice is not one.
     *
     * `targets=` is what makes the eager fetch affordable. The server scans
     * the range once and partitions by target in memory, so this costs one
     * request whatever the target count - the same one the page itself spends
     * - and the ceiling stops scaling with how many targets an operator keeps.
     *
     * Not asked at all while a chip narrows the page: every other panel is
     * then about that one target, and a comparison of all of them beside them
     * contradicts the filter the reader just set. The panels are hidden in
     * that state, so this would be buying a payload nothing renders.
     *
     * The answer is cached against its key, so a re-render costs nothing. A
     * key that goes stale under an open panel - the Back button changes the
     * range without closing it - re-fires this and the panel shows its loading
     * line rather than the previous range's series.
     *
     * No languageChanged re-fetch, unlike the page's: the labels are ISO
     * instants and every rendered string re-resolves on its own.
     */
    useEffect(() => {
        if (targetFilter != null || targets.length < 2 || compareFresh) return;

        const generation = ++compareGeneration.current;

        const query = rangeQuery(dateRange);
        query.set("targets", targets.map(({id}) => id).join(","));
        // The same question the page asks, through the same applier - each
        // target narrowed to its own line, so a row compares against ITS week
        // rather than the page's mixture.
        applyCompare(query, dateRange, compare);

        jsonRequest(`/speedtests/statistics/?${query}`).then((answer) => {
            if (generation !== compareGeneration.current) return;

            /*
             * Every requested target gets an entry, and a target the server
             * left out becomes the null the table names "couldn't load" -
             * not the clean N/A of a line that answered honestly with
             * nothing. The whole request failing is the same finding for
             * every target at once, which the catch below states the same
             * way rather than leaving the panels spinning forever.
             */
            const byTarget = answer?.byTarget ?? {};
            setCompareStats({key: compareKey, byId: Object.fromEntries(targets.map(({id}) =>
                [id, byTarget[id] ?? byTarget[String(id)] ?? null]))});
        }).catch((error) => {
            if (generation !== compareGeneration.current) return;

            console.error("Failed to load the target comparison:", error);
            setCompareStats({key: compareKey,
                byId: Object.fromEntries(targets.map(({id}) => [id, null]))});
        });
    }, [targetFilter, targets, dateRange, compare, compareKey, compareFresh]);

    /*
     * The panels and their fetch are gated on two targets and on nothing
     * narrowing the page; the modal is plain state and would outlive either
     * gate. Deleting targets down to one with a panel open left it standing
     * over nothing, and pressing a chip under an open one left a comparison of
     * every target on screen while the page behind it showed exactly one.
     */
    useEffect(() => {
        if ((targets.length < 2 || targetFilter != null) && TARGET_PANELS.includes(expandedChart))
            setExpandedChart(null);
    }, [targets, targetFilter, expandedChart]);

    if (mountPhase === 0) return null;

    // The toolbar is real here rather than a shimmer: it needs nothing from the
    // statistics being fetched, and its controls - the range being loaded, and
    // starting a test - are exactly what someone waiting might want to reach.
    /* Stated once for the whole page, so every delta below can be a bare arrow
       and number instead of each repeating the window.

       One wording, and the dates are named as whole days even where the server
       cut the window at now's own wall clock. There were two, and the second
       said "up to the same time of day" - it went with the free-form comparison
       window it was written for. The cut is what MAKES the two windows
       comparable now, both covering the same elapsed span of the same number of
       days, so there is no asymmetry left for a caveat to disclose; the
       selected range's own heading has never carried one either. The server
       still ships `dateRange.partial` and nothing reads it - see
       expandedPanes.test.js, which pins the single wording deliberately.

       Built for any bounded range, not only when there is something to compare
       against: the control that CHOOSES the window lives in it, and gating that
       on a previous window having data would lock a young instance out of
       naming one.

       Handed to the toolbar as its aside rather than drawn under it. The chip
       row is a handful of names and this is one sentence and a picker, so on
       any ordinary width the two share a line and the page keeps a row it was
       spending on whitespace. They separate on their own where they no longer
       fit - see .toolbar-second-row. */
    const compareRow = dateRange ? (
        <div className="statistics-compare-row">
            {/* Two sentences, not one and a silence.
                The note used to render only when there was something to
                compare against, so choosing a window the instance has no tests
                in simply removed it - and every arrow on the page vanished with
                no statement anywhere of why. The window is named either way;
                what changes is whether it had anything in it. previousWindow is
                the payload as it arrived, which carries the dates even when it
                counted nothing, where `previous` is the gated one the deltas
                read. */}
            {previousWindow && (
                <p className="statistics-compare-note">
                    {previous
                        ? t("statistics.compare.note", comparedWindow)
                        : t("statistics.compare.empty", comparedWindow)}
                </p>
            )}
            {/* How far back to look, never how much to look at - so the two
                windows are the same length by construction and there is no
                second range for a reader to reconcile with the first. The
                default is itself an option rather than a state to reset out
                of, which is what removed the reset button beside this. */}
            <CompareSelect value={compare} onChange={handleCompareChange}/>
        </div>
    ) : null;

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
            aside={compareRow}
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
    // The window the page is actually showing, which the overview card is named
    // after. All time has none of its own, so it is the extent of the tests
    // themselves - the first to the last - as echoed by the server.
    const chartRange = shownRange(dateRange, deferredStatistics);

    const renderChart = (chartType, source) => {
        switch (chartType) {
            case 'overview':
                return <OverviewChart tests={deferredStatistics.tests} time={deferredStatistics.time} packetLoss={deferredStatistics.packetLoss} hourlyAverages={deferredStatistics.hourlyAverages} ping={deferredStatistics.ping} dataUsed={deferredStatistics.dataUsed} reliability={deferredStatistics.reliability} dateRange={chartRange} previous={previous} expanded/>;
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
                return <SpeedChart labels={source.labels} data={source.data} dataKey="download" titleKey={CHART_MODAL_LABELS.download} failed={source.failed} errors={source.errors} downsampled={source.downsampled} dataPoints={source.dataPoints} rawDataPoints={source.rawDataPoints} />;
            case 'upload':
                return <SpeedChart labels={source.labels} data={source.data} dataKey="upload" titleKey={CHART_MODAL_LABELS.upload} failed={source.failed} errors={source.errors} downsampled={source.downsampled} dataPoints={source.dataPoints} rawDataPoints={source.rawDataPoints} />;
            case 'ping':
                return <PingChart labels={source.labels} data={source.data} failed={source.failed} errors={source.errors} downsampled={source.downsampled} dataPoints={source.dataPoints} rawDataPoints={source.rawDataPoints}/>;
            case 'hourly':
                return <HourlyChart hourlyAverages={deferredStatistics.hourlyAverages}/>;
            case 'avgDownload':
                return <AverageChart title={t(CHART_MODAL_LABELS.avgDownload)} data={deferredStatistics.download} previous={previous?.download} target={gradeLimits.download}
                                    consistency={deferredStatistics.consistency?.download} tests={deferredStatistics.tests} expanded/>;
            case 'avgUpload':
                return <AverageChart title={t(CHART_MODAL_LABELS.avgUpload)} data={deferredStatistics.upload} previous={previous?.upload} target={gradeLimits.upload}
                                    consistency={deferredStatistics.consistency?.upload} tests={deferredStatistics.tests} expanded/>;
            case 'targets':
                // statsById only while the cache answers for the shown key:
                // a stale byId is the previous range's series wearing this
                // range's heading, the fault the page's own guard exists for.
                return <TargetCompareTable targets={targets} statsById={compareStatsById}
                                           fresh={compareFresh} expanded/>;
            case 'targetsPing':
            case 'targetsDownload':
            case 'targetsUpload':
                // The metric is the panel's own identity, read back off the key
                // rather than passed separately: three cases naming their own
                // metric a second time is three chances for a case to draw the
                // chart beside it.
                return <TargetCompareChart targets={targets} statsById={compareStatsById}
                                           fresh={compareFresh} metric={metricOf(chartType)}/>;
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
                          disabled={!isDownsampled} label={t("statistics.detail.title")}/>
            <div className="chart-detail-text">
                <span className="chart-detail-label">{t("statistics.detail.title")}</span>
                <span className="chart-detail-hint">{detailHint()}</span>
            </div>
        </div>
    ) : null;

    return (
        <div className={`statistic-area${isStale ? ' statistic-stale' : ''}`}>
            {toolbar}

            <OverviewChart tests={deferredStatistics.tests} time={deferredStatistics.time} packetLoss={deferredStatistics.packetLoss} hourlyAverages={deferredStatistics.hourlyAverages} ping={deferredStatistics.ping} dataUsed={deferredStatistics.dataUsed} reliability={deferredStatistics.reliability} dateRange={chartRange} previous={previous} onClick={() => setExpandedChart('overview')}/>
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
            <SpeedChart labels={deferredStatistics.labels} data={deferredStatistics.data} dataKey="download" titleKey={CHART_MODAL_LABELS.download} failed={deferredStatistics.failed} errors={deferredStatistics.errors} downsampled={deferredStatistics.downsampled} dataPoints={deferredStatistics.dataPoints} rawDataPoints={deferredStatistics.rawDataPoints} onClick={() => setExpandedChart('download')} compact/>
            <SpeedChart labels={deferredStatistics.labels} data={deferredStatistics.data} dataKey="upload" titleKey={CHART_MODAL_LABELS.upload} failed={deferredStatistics.failed} errors={deferredStatistics.errors} downsampled={deferredStatistics.downsampled} dataPoints={deferredStatistics.dataPoints} rawDataPoints={deferredStatistics.rawDataPoints} onClick={() => setExpandedChart('upload')} compact/>

            <HourlyChart hourlyAverages={deferredStatistics.hourlyAverages} onClick={() => setExpandedChart('hourly')}/>

            <AverageChart title={t(CHART_MODAL_LABELS.avgDownload)} data={deferredStatistics.download} previous={previous?.download} target={gradeLimits.download} onClick={() => setExpandedChart('avgDownload')}/>
            <AverageChart title={t(CHART_MODAL_LABELS.avgUpload)} data={deferredStatistics.upload} previous={previous?.upload} target={gradeLimits.upload} onClick={() => setExpandedChart('avgUpload')}/>

            {/* Two gates, both about whether there is a comparison to make.
                One target has nothing to compare - the chips' own gate. And a
                chip narrows the page to a single target, at which point every
                panel above is about that one and a comparison of all of them
                here would be the only thing on screen contradicting the filter
                the reader just set. Hidden rather than filtered: a comparison
                narrowed to one target compares nothing. */}
            {targets.length >= 2 && targetFilter == null && (
                <>
                    {/* One per metric, in the order of the row above - ping
                        leading, then the two speed charts - so the six charts
                        read down the page in matching columns. */}
                    <TargetCompareChart targets={targets} statsById={compareStatsById} fresh={compareFresh}
                                        metric="ping" compact onClick={() => setExpandedChart('targetsPing')}/>
                    <TargetCompareChart targets={targets} statsById={compareStatsById} fresh={compareFresh}
                                        metric="download" compact onClick={() => setExpandedChart('targetsDownload')}/>
                    <TargetCompareChart targets={targets} statsById={compareStatsById} fresh={compareFresh}
                                        metric="upload" compact onClick={() => setExpandedChart('targetsUpload')}/>

                    {/* And the figures no line can draw: the averages as
                        numbers, their deltas, and the failure rate. */}
                    <TargetCompareTable targets={targets} statsById={compareStatsById}
                                        fresh={compareFresh} onClick={() => setExpandedChart('targets')}/>
                </>
            )}

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