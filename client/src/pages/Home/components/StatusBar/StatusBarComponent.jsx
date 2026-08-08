import {useContext, useEffect, useState} from "react";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {
    faCircleExclamation, faClockRotateLeft, faGaugeHigh, faPause, faTriangleExclamation
} from "@fortawesome/free-solid-svg-icons";
import {t} from "i18next";
import {StatusContext} from "@/common/contexts/Status";
import {ConfigContext} from "@/common/contexts/Config";
import {PreferencesContext} from "@/common/contexts/Preferences";
import {SpeedtestContext} from "@/common/contexts/Speedtests";
import {useAlert} from "@/common/contexts/Alert";
import {convertSpeed, formatLastTest, formatTime, getSpeedUnit} from "@/common/utils/FormatUtil";
import {isFailedTest} from "@/common/utils/TestUtil";
import {startBlockedReason, START_BLOCKED_RUNNING, START_BLOCKED_VIEW_MODE} from "@/common/utils/StatusUtil";
import {startSpeedtest} from "@/common/utils/RunUtil";
import "./styles.sass";

const PERCENT = 100;

// The relative time is recomputed on a timer of its own: "3 minutes ago" is
// wrong a minute later, and the status poll backs off to five seconds when
// nothing is running.
const RELATIVE_TIME_REFRESH_MS = 1000;

const StatusBarComponent = () => {
    const [status, updateStatus, setRunning] = useContext(StatusContext);
    const [config] = useContext(ConfigContext);
    const [preferences] = useContext(PreferencesContext);
    const {speedtests, updateTests} = useContext(SpeedtestContext);
    const alert = useAlert();

    const [lastTestText, setLastTestText] = useState(null);

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

    if (Object.entries(config).length === 0) return <></>;

    const blocked = startBlockedReason(status, config);
    const speedUnit = getSpeedUnit(preferences);

    const start = () => startSpeedtest({status, config, updateStatus, setRunning, updateTests, alert});

    const phaseLabel = () => {
        if (!status.phase || status.phase === "start") return t("status.phase.starting");
        return t(`status.phase.${status.phase}`);
    };

    const progressPercent = Math.round((status.progress ?? 0) * PERCENT);

    const stateText = () => {
        if (status.paused) return t("status.paused");
        if (status.running) return phaseLabel();

        return lastTestText;
    };

    const nextText = () => {
        if (status.running || status.paused || !status.nextTest) return null;
        return t("status.next_test", {time: formatTime(status.nextTest, preferences)});
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
                                {convertSpeed(status.speed, preferences)} {speedUnit}
                            </span>
                        )}

                        {/* Surfaced here rather than only in the statistics: a
                            run of failures is the one thing worth noticing
                            without opening another page. */}
                        {!status.running && status.recentFailures > 0 && (
                            <span className="status-failures">
                                <FontAwesomeIcon icon={faCircleExclamation} className="icon-error"/>
                                {/* Not `count`: that makes i18next resolve
                                    plural forms, which would need a key per
                                    form in all fifteen locales. */}
                                {t("status.recent_failures", {failures: status.recentFailures})}
                            </span>
                        )}
                    </div>
                </div>

                {blocked !== START_BLOCKED_VIEW_MODE && (
                    <button className="status-start" onClick={start} disabled={blocked !== null}>
                        <FontAwesomeIcon icon={faGaugeHigh}/>
                        <span>{t(blocked === START_BLOCKED_RUNNING ? "status.running_button" : "status.start")}</span>
                    </button>
                )}
            </div>

            {status.running && (
                <div className="status-progress" role="progressbar" aria-valuenow={progressPercent}
                     aria-valuemin={0} aria-valuemax={PERCENT}>
                    <div className="status-progress-fill" style={{width: `${progressPercent}%`}}/>
                </div>
            )}
        </div>
    );
};

export default StatusBarComponent;
