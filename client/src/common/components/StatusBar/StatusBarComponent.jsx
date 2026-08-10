import {useContext, useEffect, useState} from "react";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {
    faCircleExclamation, faClockRotateLeft, faGaugeHigh, faPause, faTriangleExclamation
} from "@fortawesome/free-solid-svg-icons";
import {t} from "i18next";
import {useNavigate} from "react-router-dom";
import {serializeRange, TIMEFRAME_CUSTOM} from "@/common/utils/TimeframeUtil";
import {StatusContext} from "@/common/contexts/Status";
import {ConfigContext} from "@/common/contexts/Config";
import {PreferencesContext} from "@/common/contexts/Preferences";
import {SpeedtestContext} from "@/common/contexts/Speedtests";
import {convertSpeed, formatLastTest, formatTime, formatWithUnit, getSpeedUnit} from "@/common/utils/FormatUtil";
import {isFailedTest} from "@/common/utils/TestUtil";
import {progressPercent} from "@/common/utils/StatusUtil";
import "./styles.sass";

const PERCENT = 100;

// The relative time is recomputed on a timer of its own: "3 minutes ago" is
// wrong a minute later, and the status poll backs off to five seconds when
// nothing is running.
const RELATIVE_TIME_REFRESH_MS = 1000;

// Mirrors the window the server counts recentFailures over, so the badge opens
// the statistics on the same day it summarised.
const HOURS_PER_DAY = 24;
const RECENT_FAILURE_WINDOW_MS = HOURS_PER_DAY * 60 * 60 * 1000;

const StatusBarComponent = () => {
    const [status] = useContext(StatusContext);
    const [config] = useContext(ConfigContext);
    const [preferences] = useContext(PreferencesContext);
    const {speedtests} = useContext(SpeedtestContext);
    const navigate = useNavigate();

    const [lastTestText, setLastTestText] = useState(null);
    const [elapsed, setElapsed] = useState(null);

    /**
     * The status carries the last test, but a node running an older version
     * answers with only {paused, running} - so the loaded list is the fallback.
     * It is fetched per node from /speedtests and works against every version,
     * which is what the panel this replaced relied on.
     */
    const lastTest = status.lastTest
        ?? (speedtests.length > 0
            ? {created: speedtests[0].created, failed: isFailedTest(speedtests[0])}
            : null);

    useEffect(() => {
        const refresh = () => setLastTestText(formatLastTest(lastTest?.created));

        refresh();
        const timer = setInterval(refresh, RELATIVE_TIME_REFRESH_MS);
        return () => clearInterval(timer);
    }, [lastTest?.created]);

    // Ticks locally rather than waiting on the poll, so the seconds advance
    // smoothly instead of in one-second jumps that stall whenever a poll is slow.
    useEffect(() => {
        if (!status.startedAt) return setElapsed(null);

        const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - Date.parse(status.startedAt)) / 1000)));

        tick();
        const timer = setInterval(tick, RELATIVE_TIME_REFRESH_MS);
        return () => clearInterval(timer);
    }, [status.startedAt]);

    if (Object.entries(config).length === 0) return <></>;

    const speedUnit = getSpeedUnit(preferences);

    // The statistics for the same window the badge counted: the last day, as a
    // custom range spanning yesterday and today. The failure markers on the
    // charts there line up with whatever went wrong.
    const openRecentFailures = () => {
        const now = new Date();
        const yesterday = new Date(now.getTime() - RECENT_FAILURE_WINDOW_MS);
        const params = new URLSearchParams(serializeRange(TIMEFRAME_CUSTOM, yesterday, now));

        navigate(`/statistics?${params}`);
    };

    const percent = progressPercent(status);

    const phaseLabel = () => {
        // A provider that reports no progress reports no phase either, so there
        // is nothing more specific to say than that it is measuring.
        if (percent === null) return t("status.phase.measuring");
        if (!status.phase || status.phase === "start") return t("status.phase.starting");

        return t(`status.phase.${status.phase}`);
    };

    const stateText = () => {
        if (status.paused) return t("status.paused");
        if (status.running) return phaseLabel();

        return lastTestText;
    };

    const nextText = () => {
        if (status.running || status.paused || !status.nextTest) return null;

        // The schedule offset delays each run by up to a few minutes, so the
        // cron time is the earliest it could start rather than when it will.
        const key = status.nextTestApproximate ? "status.next_test_approx" : "status.next_test";

        return t(key, {time: formatTime(status.nextTest, preferences)});
    };

    const stateIcon = () => {
        if (status.paused) return faPause;
        if (status.running) return faGaugeHigh;
        if (lastTest?.failed) return faTriangleExclamation;

        return faClockRotateLeft;
    };

    const stateColour = () => {
        if (status.paused) return "orange";
        if (status.running) return "blue";
        if (lastTest?.failed) return "error";

        return "green";
    };

    return (
        <div className={`status-bar${status.running ? " status-bar-running" : ""}`}>
            <div className="status-main">
                <FontAwesomeIcon icon={stateIcon()} className={`status-icon icon-${stateColour()}`}
                                 spin={status.running}/>

                <div className="status-text">
                    <h2>{stateText()}</h2>
                    <div className="status-detail">
                        {nextText() && <span>{nextText()}</span>}

                        {status.running && status.speed !== null && status.speed !== undefined && (
                            <span className="status-speed">
                                {formatWithUnit(convertSpeed(status.speed, preferences), speedUnit)}
                            </span>
                        )}

                        {/* With no progress to show, elapsed time is the only
                            evidence the run is still moving. */}
                        {status.running && percent === null && elapsed !== null && (
                            <span>{t("status.elapsed", {seconds: elapsed})}</span>
                        )}

                        {/* Surfaced here rather than only in the statistics: a
                            run of failures is the one thing worth noticing
                            without opening another page. A button, not a badge -
                            it opens the statistics on the window it counted, so
                            noticing leads somewhere. */}
                        {!status.running && status.recentFailures > 0 && (
                            <button className="status-failures" onClick={openRecentFailures}>
                                <FontAwesomeIcon icon={faCircleExclamation} className="icon-error"/>
                                {/* Not `count`: that makes i18next resolve
                                    plural forms, which would need a key per
                                    form in all fifteen locales. */}
                                {t("status.recent_failures", {failures: status.recentFailures})}
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {/* An indeterminate track for a provider that reports no progress:
                a bar held at zero for the length of a run reads as a test that
                has hung rather than one that cannot say how far along it is. */}
            {status.running && (
                <div className="status-progress" role="progressbar"
                     aria-valuenow={percent === null ? undefined : percent}
                     aria-valuemin={0} aria-valuemax={PERCENT}>
                    {percent === null
                        ? <div className="status-progress-fill status-progress-indeterminate"/>
                        : <div className="status-progress-fill" style={{width: `${percent}%`}}/>}
                </div>
            )}
        </div>
    );
};

export default StatusBarComponent;
