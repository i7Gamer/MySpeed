import React, {forwardRef, useContext, useRef, useState, useImperativeHandle} from "react";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {
    faArrowDown, faArrowUp, faChevronDown, faClockRotateLeft, faClose,
    faExclamationTriangle, faInfo, faPingPongPaddleBall, faTrashCan,
    faWaveSquare
} from "@fortawesome/free-solid-svg-icons";
import {SpeedtestContext} from "@/common/contexts/Speedtests";
import {assertOk, deleteRequest} from "@/common/utils/RequestUtil";
import "./styles.sass";
import {describeError} from "@/common/components/TestDetails/utils/errors";
import TestDetails from "@/common/components/TestDetails";
import {t} from "i18next";
import {ConfigContext} from "@/common/contexts/Config";
import {ToastNotificationContext} from "@/common/contexts/ToastNotification";
import {PreferencesContext} from "@/common/contexts/Preferences";
import {convertSpeed, formatShortTime, getSpeedUnit} from "@/common/utils/FormatUtil";
import {useAlert} from "@/common/contexts/Alert";
import {downloadInfo, jitterInfo, pingInfo, uploadInfo} from "@/pages/Home/components/Speedtest/utils/dialogs";

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
    // The row shows only this sentence; the panel below appends the raw output,
    // which is a wall of JSON.
    const reason = describeError(props.error);

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

    // Everything the row itself does not have space for, and the same pane the
    // statistics show for the latest test - it reads the stored row rather than
    // this component's props, so the two views cannot drift apart.
    const details = (
        <TestDetails test={props.test} previous={props.previous}
                     previousConnection={props.previousConnection}
                     className="speedtest-details">
            {!config.viewMode && (
                <div className="detail-actions">
                    <button className="detail-delete" onClick={removeTest}>
                        <FontAwesomeIcon icon={faTrashCan}/> {t("test.delete")}
                    </button>
                </div>
            )}
        </TestDetails>
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
