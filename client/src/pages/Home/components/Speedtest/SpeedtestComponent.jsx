import React, {forwardRef, useContext, useRef, useState, useImperativeHandle} from "react";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {
    faArrowDown, faArrowRight, faArrowUp, faChevronDown, faClockRotateLeft, faClose,
    faExclamationTriangle, faInfo, faPingPongPaddleBall, faTrashCan, faUpRightFromSquare,
    faWaveSquare
} from "@fortawesome/free-solid-svg-icons";
import {SpeedtestContext} from "@/common/contexts/Speedtests";
import {assertOk, deleteRequest} from "@/common/utils/RequestUtil";
import "./styles.sass";
import {errors} from "@/pages/Home/components/Speedtest/utils/errors";
import {changeFrom, percentOfTarget} from "@/pages/Home/components/Speedtest/utils/details";
import {t} from "i18next";
import {ConfigContext} from "@/common/contexts/Config";
import {ToastNotificationContext} from "@/common/contexts/ToastNotification";
import {PreferencesContext} from "@/common/contexts/Preferences";
import {convertSpeed, formatDateTime, formatShortTime, getSpeedUnit} from "@/common/utils/FormatUtil";

const RESULT_URL = "https://www.speedtest.net/result/c/";

// The bar would otherwise run off its track on a line that beats its target,
// which is the one case where the number is unambiguously good news.
const MAX_BAR_PERCENT = 100;

const DIRECTION_ICONS = {up: faArrowUp, down: faArrowDown, same: faArrowRight};

/**
 * One measurement, with how it compares to the configured optimum and to the
 * test before it.
 */
const DetailMetric = ({icon, label, value, unit, level, percent, change, changeUnit, higherIsBetter}) => {
    const improved = change !== null && change.direction !== "same"
        && (change.direction === "up") === higherIsBetter;

    return (
        <div className="detail-metric">
            <div className="detail-metric-head">
                <FontAwesomeIcon icon={icon} className={"detail-metric-icon icon-" + level}/>
                <span className="detail-metric-label">{label}</span>
            </div>
            <div className="detail-metric-value">
                {value}<span className="detail-metric-unit">{unit}</span>
            </div>

            {percent !== null && (
                <div className="detail-target">
                    <div className="detail-target-track">
                        <div className={"detail-target-fill icon-" + level}
                             style={{width: `${Math.min(percent, MAX_BAR_PERCENT)}%`}}/>
                    </div>
                    <span className="detail-target-label">{t("test.details.of_target", {percent})}</span>
                </div>
            )}

            {change !== null && (
                <div className={`detail-change detail-change-${improved ? "better" : change.direction === "same" ? "same" : "worse"}`}>
                    <FontAwesomeIcon icon={DIRECTION_ICONS[change.direction]}/>
                    <span>
                        {change.direction === "same"
                            ? t("test.details.unchanged")
                            : `${change.difference > 0 ? "+" : ""}${change.difference} ${changeUnit}`}
                    </span>
                </div>
            )}
        </div>
    );
};

const DetailFact = ({label, children}) => (
    <div className="detail-fact">
        <span className="detail-fact-label">{label}</span>
        <span className="detail-fact-value">{children}</span>
    </div>
);

const SpeedtestComponent = forwardRef((props, forwardedRef) => {
    const updateToast = useContext(ToastNotificationContext);
    const [config] = useContext(ConfigContext);
    const {deleteTest} = useContext(SpeedtestContext);
    const [preferences] = useContext(PreferencesContext);
    const [expanded, setExpanded] = useState(false);

    const ref = useRef();

    useImperativeHandle(forwardedRef, () => ref.current);

    let errorMessage = t("test.unknown_error") + " " + props.error;

    let isAverage = props.type === "average";
    let timeString = isAverage
        ? String(props.time.getDate()).padStart(2, '0') + "." + String(props.time.getMonth() + 1).padStart(2, '0')
        : formatShortTime(props.time, preferences);

    const downValue = props.error ? "" : convertSpeed(props.down, preferences);
    const upValue = props.error ? "" : convertSpeed(props.up, preferences);
    const speedUnit = getSpeedUnit(preferences);

    if (props.error) {
        for (let errorsKey in errors())
            if (props.error.includes(errorsKey)) errorMessage = errors()[errorsKey];
    }

    const fadeOut = () => {
        if (ref.current == null) return;
        ref.current.classList.add("speedtest-hidden");
        updateToast(t("test.deleted"), "green", faTrashCan);
        setTimeout(() => deleteTest(props.id), 300);
    }

    // The row only disappears once the server has actually deleted it.
    // deleteRequest hands back the raw response, so a refused delete used to
    // fade the test out and report success - it came back on the next refresh.
    const removeTest = async () => {
        try {
            await assertOk(await deleteRequest(`/speedtests/${props.id}`), "delete speedtest");
        } catch (e) {
            updateToast(e.message || t("dropdown.changes_unsaved"), "red", faExclamationTriangle);
            return;
        }

        fadeOut();
    }

    // The previous entry in the list is the chronologically earlier test, so a
    // comparison against it reads as "since last time".
    const previous = props.previous ?? {};

    const metrics = [
        {
            key: "ping",
            icon: faPingPongPaddleBall,
            label: t("latest.ping"),
            value: props.ping,
            unit: t("latest.ping_unit"),
            changeUnit: t("latest.ping_unit"),
            level: props.pingLevel,
            percent: percentOfTarget(props.ping, config.ping),
            change: changeFrom(props.ping, previous.ping),
            higherIsBetter: false
        },
        {
            key: "download",
            icon: faArrowDown,
            label: t("latest.down"),
            value: downValue,
            unit: speedUnit,
            changeUnit: speedUnit,
            level: props.downLevel,
            percent: percentOfTarget(props.down, config.download),
            change: changeFrom(convertSpeed(props.down, preferences), convertSpeed(previous.download, preferences)),
            higherIsBetter: true
        },
        {
            key: "upload",
            icon: faArrowUp,
            label: t("latest.up"),
            value: upValue,
            unit: speedUnit,
            changeUnit: speedUnit,
            level: props.upLevel,
            percent: percentOfTarget(props.up, config.upload),
            change: changeFrom(convertSpeed(props.up, preferences), convertSpeed(previous.upload, preferences)),
            higherIsBetter: true
        }
    ];

    const serverLabel = props.serverName || props.serverHost;

    const details = (
        <div className="speedtest-details">
            {props.error ? (
                <div className="detail-error">
                    <h3>{t("test.failed")}</h3>
                    <p>{errorMessage}. {t("test.recheck")}</p>
                    {/* The raw CLI output, once, rather than only the friendly
                        translation - it is what an issue report needs. */}
                    <code className="detail-error-raw">{props.error}</code>
                </div>
            ) : (
                <>
                    <div className="detail-metrics">
                        {metrics.map(({key, ...metric}) => <DetailMetric key={key} {...metric}/>)}
                    </div>

                    <div className="detail-facts">
                        <DetailFact label={t("test.details.measured_at")}>
                            {formatDateTime(props.created ?? props.time, preferences,
                                {weekday: "short", day: "numeric", month: "short", year: "numeric"})}
                        </DetailFact>

                        {props.duration !== undefined && props.duration !== null && (
                            <DetailFact label={t("test.details.duration")}>
                                {t("test.details.seconds", {seconds: props.duration})}
                            </DetailFact>
                        )}

                        <DetailFact label={t("test.details.trigger")}>
                            {t("test.result." + (props.type === "custom" ? "from_you" : "automatic"))}
                        </DetailFact>

                        {props.jitter !== null && props.jitter !== undefined && (
                            <DetailFact label={t("latest.jitter")}>
                                {props.jitter} {t("latest.jitter_unit")}
                            </DetailFact>
                        )}

                        {/* The host is the fallback: it is always set when a name
                            is not, and is still more useful than saying nothing
                            about which server was measured. */}
                        {serverLabel && (
                            <DetailFact label={t("test.details.server")}>{serverLabel}</DetailFact>
                        )}

                        {props.resultId && (
                            <DetailFact label={t("test.details.result")}>
                                <a href={RESULT_URL + props.resultId} target="_blank" rel="noreferrer"
                                   onClick={(event) => event.stopPropagation()}>
                                    {t("test.details.open_result")}
                                    <FontAwesomeIcon icon={faUpRightFromSquare} className="detail-link-icon"/>
                                </a>
                            </DetailFact>
                        )}
                    </div>
                </>
            )}

            {!config.viewMode && (
                <div className="detail-actions">
                    <button className="detail-delete" onClick={removeTest}>
                        <FontAwesomeIcon icon={faTrashCan}/> {t("test.delete")}
                    </button>
                </div>
            )}
        </div>
    );

    return (
        <div className={`speedtest-entry${expanded ? " speedtest-expanded" : ""}`} ref={ref}>
            {/* The detail panel deliberately sits outside this element and never
                carries the `speedtest` class: TestArea maps
                querySelectorAll('.speedtest') onto the test list by index to
                drive the floating date header, and a second match per row
                silently shifts every date after it. */}
            <div className="speedtest" onClick={() => setExpanded(!expanded)}
                 role="button" tabIndex={0} aria-expanded={expanded}
                 onKeyDown={(event) => {
                     if (event.key === "Enter" || event.key === " ") {
                         event.preventDefault();
                         setExpanded(!expanded);
                     }
                 }}>
                <div className="date">
                    <FontAwesomeIcon icon={props.error ? faInfo : faClockRotateLeft}
                                     className={"container-icon icon-" + (props.error ? "error" : "blue")}/>
                    <h2 className="date-text">{(t("time." + (isAverage ? "on" : "at"))) + " " + timeString}</h2>
                </div>
                <div className="speedtest-row">
                    <FontAwesomeIcon icon={props.error ? faClose : faPingPongPaddleBall}
                                     className={"speedtest-icon icon-" + props.pingLevel}/>
                    <h2 className="speedtest-text">
                        {props.error ? "" : props.ping}
                        {!props.error && props.jitter !== null && props.jitter !== undefined && (
                            <span className="jitter-suffix"><FontAwesomeIcon icon={faWaveSquare} className="jitter-icon" />{props.jitter}</span>
                        )}
                    </h2>
                </div>
                <div className="speedtest-row">
                    <FontAwesomeIcon icon={props.error ? faClose : faArrowDown}
                                     className={"speedtest-icon icon-" + props.downLevel}/>
                    <h2 className="speedtest-text">{downValue}</h2>
                </div>
                <div className="speedtest-row">
                    <FontAwesomeIcon icon={props.error ? faClose : faArrowUp}
                                     className={"speedtest-icon icon-" + props.upLevel}/>
                    <h2 className="speedtest-text">{upValue}</h2>
                </div>
                <FontAwesomeIcon icon={faChevronDown} className="speedtest-chevron"
                                 title={t(expanded ? "test.details.hide" : "test.details.show")}/>
            </div>

            {expanded && details}
        </div>
    );
});

export default SpeedtestComponent;
