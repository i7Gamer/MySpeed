import React, {forwardRef, useContext, useRef, useState, useImperativeHandle} from "react";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {
    faArrowDown, faArrowUp, faChevronDown, faClockRotateLeft, faClose,
    faExclamationTriangle, faInfo, faLinkSlash, faPingPongPaddleBall,
    faTrashCan, faWaveSquare
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
import {convertSpeed, formatLatency, formatShortDay, formatShortTime, getSpeedUnit} from "@/common/utils/FormatUtil";
import {
    bufferbloatInfo, downloadInfo, jitterInfo, packetLossInfo, pingInfo, uploadInfo
} from "@/common/utils/MetricInfo";
import {bufferbloatColour, isMeasured, jitterColour, packetLossColour} from "@/common/utils/TestUtil";
import HelpButton from "@/common/components/HelpButton";
import {useMetricInfo} from "@/common/hooks/useMetricInfo";

const SpeedtestComponent = forwardRef((props, forwardedRef) => {
    const updateToast = useContext(ToastNotificationContext);
    const [config] = useContext(ConfigContext);
    const {deleteTest} = useContext(SpeedtestContext);
    const [preferences] = useContext(PreferencesContext);
    const [expanded, setExpanded] = useState(false);

    const ref = useRef();
    // Shared with the detail pane this row opens, which draws the same icons
    // for the same measurements - the click is stopped in there, because the
    // whole row is the control that expands the panel.
    const openInfo = useMetricInfo();

    useImperativeHandle(forwardedRef, () => ref.current);

    // The friendly reason, or null when the output is not one we can explain.
    // The row shows only this sentence; the panel below appends the raw output,
    // which is a wall of JSON.
    const reason = describeError(props.error);

    let isAverage = props.type === "average";
    // An averaged row stands for a whole day, so it is labelled with the day
    // rather than a time. Spelled out through the shared formatter: it was the
    // one date left in the interface written numerically as DD.MM, which half
    // its readers parse as MM.DD.
    let timeString = isAverage
        ? formatShortDay(props.time)
        : formatShortTime(props.time, preferences);

    const downValue = props.error ? "" : convertSpeed(props.down, preferences);
    const upValue = props.error ? "" : convertSpeed(props.up, preferences);
    const speedUnit = getSpeedUnit(preferences);

    /**
     * What the line does before anything is asked of it, beside the latency
     * itself. The same pair the opened panel shows, in the same order and with
     * the same glyphs - the row used to carry only the jitter, so the other
     * half of the reading existed only for a row someone had expanded.
     *
     * A packet loss of zero is a measurement and the best one there is; only
     * null and undefined mean the provider never looked. Ookla is the only one
     * that does, so most histories carry rows of both kinds.
     *
     * Graded by the same two functions the panel uses, so one figure cannot
     * change colour between the row and the row opened. The colour goes on the
     * glyph and not on the number, which is how the three metrics beside it are
     * already read - a list of a hundred tests is scanned by icon colour.
     */
    const quality = [
        isMeasured(props.jitter) && {
            key: "jitter",
            icon: faWaveSquare,
            info: jitterInfo,
            label: t("info.jitter.title"),
            level: jitterColour(props.jitter),
            text: props.jitter
        },
        isMeasured(props.packetLoss) && {
            key: "packetLoss",
            icon: faLinkSlash,
            info: packetLossInfo,
            label: t("info.packet_loss.title"),
            level: packetLossColour(props.packetLoss),
            text: `${props.packetLoss}%`
        }
    ].filter(Boolean);

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
                        {/* Marked when there is no grade to sit under it, so
                            the narrower layouts can give the ping both lines of
                            its column and centre it - level with the date,
                            rather than hanging above an empty half. */}
                        <div className={"speedtest-row speedtest-ping"
                            + (props.bufferbloat ? "" : " speedtest-ping-alone")}>
                            <HelpButton label={t("info.ping.title")} onOpen={(event) => openInfo(event, pingInfo)}>
                                <FontAwesomeIcon icon={faPingPongPaddleBall}
                                                 className={"speedtest-icon icon-" + props.pingLevel}/>
                            </HelpButton>
                            <h2 className="speedtest-text">
                                {formatLatency(props.ping)}
                                <span className="speedtest-unit">{t("latest.ping_unit")}</span>
                                {quality.length > 0 && (
                                    <span className="quality-suffix">
                                        {quality.map(({key, icon, info, label, level, text}) => (
                                            <span key={key} className="quality-suffix-part">
                                                {/* Only the icon is the button: the
                                                    help cursor is the affordance,
                                                    and it must not promise that the
                                                    number is clickable. Outside the
                                                    button the value also stays
                                                    ordinary text - as button
                                                    content, the aria-label
                                                    swallowed it. */}
                                                <HelpButton label={label}
                                                            onOpen={(event) => openInfo(event, info)}>
                                                    <FontAwesomeIcon icon={icon}
                                                                     className={"quality-suffix-icon icon-" + level}/>
                                                </HelpButton>
                                                <span className="quality-suffix-value">{text}</span>
                                            </span>
                                        ))}
                                    </span>
                                )}
                            </h2>
                        </div>
                        {/* The wrapper is drawn whether or not there is a grade
                            to put in it. Grid items are placed in order, so a
                            column that renders nothing lets the download slide
                            into its track and every number below stops lining
                            up - which is the whole reason this list is a grid.

                            Left empty rather than filled with a dash: only
                            Ookla measures the latencies this is built from, so
                            on a mixed history the placeholder would be the
                            loudest thing in the column. */}
                        <div className="speedtest-row speedtest-bufferbloat">
                            {props.bufferbloat && (
                                /* The grade alone, where the other columns
                                   carry an icon, a number and a unit. It has
                                   never had a glyph anywhere in this interface
                                   - the letter is the glyph - and drawn as a
                                   number it took a full column's width to say
                                   one character's worth. The milliseconds it
                                   stands for follow it into the label, which is
                                   also where a screen reader finds the reading
                                   that the colour alone cannot give.

                                   The badge itself is the button here, unlike
                                   the metric icons: there the value beside the
                                   icon must not look clickable, and here the
                                   value is all there is. */
                                <HelpButton className="bufferbloat-button"
                                            label={`${t("info.bufferbloat.title")} ${props.bufferbloat.grade} · `
                                                + t("test.details.bufferbloat_value", {increase: props.bufferbloat.increase})}
                                            onOpen={(event) => openInfo(event, bufferbloatInfo)}>
                                    <span className={"bufferbloat-grade icon-"
                                        + bufferbloatColour(props.bufferbloat.grade)}>
                                        {props.bufferbloat.grade}
                                    </span>
                                    {/* Shown only once the row is a stack. A
                                        letter alone is a column heading the
                                        columns beside it explain; on a phone
                                        there are no columns, no pointer to
                                        hover for the title, and a green "A" on
                                        a line of its own says nothing. */}
                                    <span className="bufferbloat-increase">
                                        {t("test.details.bufferbloat_value", {increase: props.bufferbloat.increase})}
                                    </span>
                                </HelpButton>
                            )}
                        </div>
                        <div className="speedtest-row speedtest-download">
                            <HelpButton label={t("info.down.title")} onOpen={(event) => openInfo(event, downloadInfo)}>
                                <FontAwesomeIcon icon={faArrowDown}
                                                 className={"speedtest-icon icon-" + props.downLevel}/>
                            </HelpButton>
                            <h2 className="speedtest-text">{downValue}
                                <span className="speedtest-unit">{speedUnit}</span>
                            </h2>
                        </div>
                        <div className="speedtest-row speedtest-upload">
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
