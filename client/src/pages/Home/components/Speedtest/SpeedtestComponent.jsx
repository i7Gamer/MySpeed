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
import {describeError} from "@/pages/Home/components/Speedtest/utils/errors";
import {changeFrom, differenceFromTarget, percentOfTarget} from "@/pages/Home/components/Speedtest/utils/details";
import {t} from "i18next";
import {ConfigContext} from "@/common/contexts/Config";
import {ToastNotificationContext} from "@/common/contexts/ToastNotification";
import {PreferencesContext} from "@/common/contexts/Preferences";
import {convertSpeed, formatDateTime, formatShortTime, formatWithUnit, getSpeedUnit} from "@/common/utils/FormatUtil";
import {useAlert} from "@/common/contexts/Alert";
import {bufferbloat, bufferbloatColour, connectionChange} from "@/common/utils/TestUtil";
import {downloadInfo, jitterInfo, pingInfo, uploadInfo} from "@/pages/Home/components/Speedtest/utils/dialogs";

const RESULT_URL = "https://www.speedtest.net/result/c/";

/**
 * A metric icon that opens its explanation.
 *
 * A button rather than a click handler on the svg, so it can be tabbed to and
 * activated with the keyboard - Enter and Space come free with the element.
 * `type="button"` because it sits inside no form but browsers default to
 * submit, and the label is what a screen reader announces in place of an icon
 * that means nothing to it.
 */
const HelpButton = ({label, onOpen, className = "", children}) => (
    <button type="button" className={`help-button help-icon ${className}`.trim()}
            aria-label={label} title={label} onClick={onOpen}>
        {children}
    </button>
);

// The bar would otherwise run off its track on a line that beats its target,
// which is the one case where the number is unambiguously good news.
const MAX_BAR_PERCENT = 100;

const DIRECTION_ICONS = {up: faArrowUp, down: faArrowDown, same: faArrowRight};

/**
 * One measurement, with how it compares to the configured optimum and to the
 * test before it.
 */
const DetailMetric = ({icon, label, value, unit, level, percent, targetLabel, change, changeUnit, higherIsBetter}) => {
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
                    <span className="detail-target-label">{targetLabel}</span>
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
    const alert = useAlert();

    useImperativeHandle(forwardedRef, () => ref.current);

    /**
     * Opens the explanation of a measurement.
     *
     * These used to hang off the latest-test panel, so only the newest test
     * explained itself. The click is stopped here because the whole row is the
     * control that expands the detail panel.
     */
    const openInfo = (event, info) => {
        event.stopPropagation();
        const {title, description, buttonText} = info();
        alert.openAlert(title, description, {buttonText});
    };

    // The friendly reason, or null when the output is not one we can explain.
    const reason = describeError(props.error);

    // The panel keeps the raw output appended when there is no translation for
    // it; the row does not, because that output is a wall of JSON.
    let errorMessage = reason ?? (t("test.unknown_error") + " " + props.error);

    let isAverage = props.type === "average";
    let timeString = isAverage
        ? String(props.time.getDate()).padStart(2, '0') + "." + String(props.time.getMonth() + 1).padStart(2, '0')
        : formatShortTime(props.time, preferences);

    const downValue = props.error ? "" : convertSpeed(props.down, preferences);
    const upValue = props.error ? "" : convertSpeed(props.up, preferences);
    const speedUnit = getSpeedUnit(preferences);

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

    // A percentage says everything worth saying about throughput. For latency it
    // does not: the plain distance from the target is what the reader wants, and
    // it cannot be read backwards.
    const latencyTargetLabel = () => {
        const distance = differenceFromTarget(props.ping, config.ping);
        if (distance === null) return null;
        if (distance.direction === "same") return t("test.details.on_target");

        return t(`test.details.${distance.direction}_target`,
            {amount: distance.difference, unit: t("latest.ping_unit")});
    };

    const metrics = [
        {
            key: "ping",
            icon: faPingPongPaddleBall,
            label: t("latest.ping"),
            value: props.ping,
            unit: t("latest.ping_unit"),
            changeUnit: t("latest.ping_unit"),
            level: props.pingLevel,
            percent: percentOfTarget(props.ping, config.ping, {higherIsBetter: false}),
            targetLabel: latencyTargetLabel(),
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
            targetLabel: t("test.details.of_target", {percent: percentOfTarget(props.down, config.download)}),
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
            targetLabel: t("test.details.of_target", {percent: percentOfTarget(props.up, config.upload)}),
            change: changeFrom(convertSpeed(props.up, preferences), convertSpeed(previous.upload, preferences)),
            higherIsBetter: true
        }
    ];

    const serverLabel = props.serverName || props.serverHost;

    // A packet loss of zero is a measurement; only null and undefined mean the
    // provider never reported one.
    const isMeasured = (value) => value !== null && value !== undefined;

    const bloat = bufferbloat({
        ping: props.ping, downloadLatency: props.downloadLatency, uploadLatency: props.uploadLatency
    });

    // Against the nearest earlier test that carries an identity, not simply the
    // row before - see previousConnection.
    const change = connectionChange(props, props.previousConnection);

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
                            {/* No weekday: it was the least informative token in
                                the longest value on the panel. */}
                            {formatDateTime(props.created ?? props.time, preferences,
                                {day: "numeric", month: "short", year: "numeric"})}
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
                                {formatWithUnit(props.jitter, t("latest.jitter_unit"))}
                            </DetailFact>
                        )}

                        {/* Only for a test that carried them. A row recorded
                            before these were captured, or from a provider that
                            cannot measure them, has no value rather than zero -
                            and a packet loss of zero is a result worth showing. */}
                        {isMeasured(props.downloadLatency) && isMeasured(props.uploadLatency) && (
                            <DetailFact label={t("test.details.loaded_latency")}>
                                {/* The same two arrows the speed rows use,
                                    rather than the words "down" and "up". The
                                    sentence stays as the accessible name: an
                                    arrow points somewhere only to someone who
                                    can see it. */}
                                <span className="detail-latency"
                                      role="img"
                                      aria-label={t("test.details.loaded_latency_value",
                                          {down: props.downloadLatency, up: props.uploadLatency})}>
                                    <span className="detail-latency-part">
                                        <FontAwesomeIcon icon={faArrowDown} className="detail-latency-icon"/>
                                        {props.downloadLatency}
                                    </span>
                                    <span className="detail-latency-part">
                                        <FontAwesomeIcon icon={faArrowUp} className="detail-latency-icon"/>
                                        {props.uploadLatency}
                                    </span>
                                    <span className="detail-latency-unit">{t("latest.ping_unit")}</span>
                                </span>
                            </DetailFact>
                        )}

                        {/* The grade is the readable form of the two figures
                            above: how much latency the line gains once it is
                            saturated, which is what a call breaking up during
                            an upload actually is. */}
                        {bloat && (
                            <DetailFact label={t("test.details.bufferbloat")}>
                                <span className={"bufferbloat-grade icon-" + bufferbloatColour(bloat.grade)}>
                                    {bloat.grade}
                                </span>
                                {/* A real space, not only margin: inline spans
                                    create no word break, so the accessible text
                                    read "Aadds 19 ms". */}
                                {" " + t("test.details.bufferbloat_value", {increase: bloat.increase})}
                            </DetailFact>
                        )}

                        {isMeasured(props.packetLoss) && (
                            <DetailFact label={t("test.details.packet_loss")}>
                                {props.packetLoss}%
                            </DetailFact>
                        )}

                        {props.isp && (
                            <DetailFact label={t("test.details.isp")}>
                                {props.isp}
                                {/* A real space: inline spans create no word
                                    break, so this read "Salt MobileCHANGED". */}
                                {change?.isp && <> <span className="detail-changed">{t("test.details.changed")}</span></>}
                            </DetailFact>
                        )}

                        {/* The address the test went out from. A change here is
                            usually why a run of results steps: a reassigned
                            lease, a failover, a swapped router. */}
                        {props.externalIp && (
                            <DetailFact label={t("test.details.external_ip")}>
                                <span className="detail-address">{props.externalIp}</span>
                                {change?.externalIp && <> <span className="detail-changed">{t("test.details.changed")}</span></>}
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
                {/* A failed test says why here rather than showing three empty
                    columns that have to be expanded to mean anything. The
                    reason is one line; the unabridged output is in the panel. */}
                {props.error ? (
                    <div className="speedtest-failure">
                        <FontAwesomeIcon icon={faClose} className="speedtest-icon icon-error"/>
                        <h2 className="speedtest-failure-text" title={reason ?? props.error}>
                            {reason ?? t("test.unknown_error")}
                        </h2>
                    </div>
                ) : (
                    <>
                        {/* Each icon explains its measurement. Real buttons, not
                            svgs carrying a click handler: the row itself is
                            keyboard-operable, and these sit inside it, so as
                            bare svgs they were the one thing on the card a
                            keyboard could not reach at all. */}
                        <div className="speedtest-row">
                            <HelpButton label={t("info.ping.title")} onOpen={(event) => openInfo(event, pingInfo)}>
                                <FontAwesomeIcon icon={faPingPongPaddleBall}
                                                 className={"speedtest-icon icon-" + props.pingLevel}/>
                            </HelpButton>
                            <h2 className="speedtest-text">
                                {props.ping}
                                <span className="speedtest-unit">{t("latest.ping_unit")}</span>
                                {props.jitter !== null && props.jitter !== undefined && (
                                    <span className="jitter-suffix">
                                        {/* Only the icon is the button: the help
                                            cursor is the affordance, and it must
                                            not promise that the number is
                                            clickable. Outside the button the
                                            value also stays ordinary text - as
                                            button content, the aria-label
                                            swallowed it. */}
                                        <HelpButton label={t("info.jitter.title")}
                                                    onOpen={(event) => openInfo(event, jitterInfo)}>
                                            <FontAwesomeIcon icon={faWaveSquare} className="jitter-icon" />
                                        </HelpButton>
                                        {props.jitter}
                                    </span>
                                )}
                            </h2>
                        </div>
                        <div className="speedtest-row">
                            <HelpButton label={t("info.down.title")} onOpen={(event) => openInfo(event, downloadInfo)}>
                                <FontAwesomeIcon icon={faArrowDown}
                                                 className={"speedtest-icon icon-" + props.downLevel}/>
                            </HelpButton>
                            <h2 className="speedtest-text">{downValue}
                                <span className="speedtest-unit">{speedUnit}</span>
                            </h2>
                        </div>
                        <div className="speedtest-row">
                            <HelpButton label={t("info.up.title")} onOpen={(event) => openInfo(event, uploadInfo)}>
                                <FontAwesomeIcon icon={faArrowUp}
                                                 className={"speedtest-icon icon-" + props.upLevel}/>
                            </HelpButton>
                            <h2 className="speedtest-text">{upValue}
                                <span className="speedtest-unit">{speedUnit}</span>
                            </h2>
                        </div>
                    </>
                )}
                <FontAwesomeIcon icon={faChevronDown} className="speedtest-chevron"
                                 title={t(expanded ? "test.details.hide" : "test.details.show")}/>
            </div>

            {expanded && details}
        </div>
    );
});

export default SpeedtestComponent;
