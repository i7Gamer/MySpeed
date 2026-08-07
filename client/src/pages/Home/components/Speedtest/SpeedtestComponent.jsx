import React, {forwardRef, useContext, useRef, useImperativeHandle} from "react";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {
    faArrowDown, faArrowUp, faClockRotateLeft, faClose, faExclamationTriangle,
    faInfo, faPingPongPaddleBall, faTrashCan, faWaveSquare
} from "@fortawesome/free-solid-svg-icons";
import {useAlert} from "@/common/contexts/Alert";
import {SpeedtestContext} from "@/common/contexts/Speedtests";
import {assertOk, deleteRequest} from "@/common/utils/RequestUtil";
import "./styles.sass";
import {averageResultDialog, resultDialog} from "@/pages/Home/components/Speedtest/utils/infos";
import {errors} from "@/pages/Home/components/Speedtest/utils/errors";
import {t} from "i18next";
import {ConfigContext} from "@/common/contexts/Config";
import {ToastNotificationContext} from "@/common/contexts/ToastNotification";
import {PreferencesContext} from "@/common/contexts/Preferences";
import {convertSpeed, formatShortTime} from "@/common/utils/FormatUtil";

const SpeedtestComponent = forwardRef((props, forwardedRef) => {
    const alert = useAlert();
    const updateToast = useContext(ToastNotificationContext);
    const [config] = useContext(ConfigContext);
    const {deleteTest} = useContext(SpeedtestContext);
    const [preferences] = useContext(PreferencesContext);

    const ref = useRef();

    useImperativeHandle(forwardedRef, () => ref.current);

    let errorMessage = t("test.unknown_error") + " " + props.error;

    let isAverage = props.type === "average";
    let timeString = isAverage
        ? String(props.time.getDate()).padStart(2, '0') + "." + String(props.time.getMonth() + 1).padStart(2, '0')
        : formatShortTime(props.time, preferences);

    const downValue = props.error ? "" : convertSpeed(props.down, preferences);
    const upValue = props.error ? "" : convertSpeed(props.up, preferences);

    // The result dialogs' sentence hardcodes "Mbps" in every locale, so they are
    // handed the raw Mbps figure rather than the card's converted one. On the
    // MB/s preference they were showing a MB/s number labelled Mbps - off by a
    // factor of eight. Making them unit-aware needs the translated strings to
    // grow a {{unit}} placeholder, which is a Crowdin change.
    const downMbps = props.error ? "" : props.down;
    const upMbps = props.error ? "" : props.up;

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

    const showErrorDialog = async () => {
        await alert.openAlert(
            t("test.failed"),
            errorMessage + ". " + t("test.recheck"),
            {
                buttonText: t("dialog.okay"),
                clearButton: t("test.delete"),
                onClear: () => removeTest()
            }
        );
    };

    const showInfoDialog = async () => {
        if (props.type === "average") {
            await alert.openAlert(
                t("test.average.title"),
                averageResultDialog(timeString, {...props, down: downMbps, up: upMbps}),
                {buttonText: t("dialog.okay")}
            );
        } else {
            await alert.openAlert(
                t("test.result.title"),
                resultDialog({...props, down: downMbps, up: upMbps}),
                {
                    buttonText: t("dialog.okay"),
                    clearButton: !config.viewMode ? t("test.delete") : undefined,
                    onClear: () => removeTest()
                }
            );
        }
    };

    return (
        <div className="speedtest" ref={ref} onClick={props.error ? showErrorDialog : showInfoDialog}>
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
        </div>
    );
});

export default SpeedtestComponent;