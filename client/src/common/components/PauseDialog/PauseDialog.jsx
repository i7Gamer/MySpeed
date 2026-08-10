import React, {useContext, useState} from "react";
import {Dialog, DialogHeader, DialogBody, DialogFooter} from "@/common/contexts/Dialog";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faExclamationTriangle, faInfinity, faClock, faMugHot, faMoon, faChevronDown} from "@fortawesome/free-solid-svg-icons";
import {t} from "i18next";
import {assertOk, postRequest, RequestError} from "@/common/utils/RequestUtil";
import {ToastNotificationContext} from "@/common/contexts/ToastNotification";
import SelectableOption, {SelectableList} from "@/common/components/SelectableOption";
import "./styles.sass";

const PRESETS = [
    {id: "manual", hours: null, icon: faInfinity},
    {id: "short", hours: 1, icon: faMugHot},
    {id: "medium", hours: 6, icon: faClock},
    {id: "long", hours: 12, icon: faMoon}
];

export const PauseDialog = ({open, onClose, onPause}) => {
    const updateToast = useContext(ToastNotificationContext);
    const [selected, setSelected] = useState("manual");
    const [customHours, setCustomHours] = useState("");
    const [showCustom, setShowCustom] = useState(false);

    const handleSave = async (close) => {
        const preset = PRESETS.find(p => p.id === selected);

        // Checked, not assumed: postRequest hands back the raw Response, so a
        // refused pause used to close the dialog as if the schedule had stopped.
        const pause = async (resumeIn) => assertOk(await postRequest("/speedtests/pause", {resumeIn}), "pause");

        try {
            if (selected === "custom") {
                if (customHours && parseFloat(customHours) > 0) {
                    await pause(parseFloat(customHours));
                } else {
                    return;
                }
            } else if (preset.hours === null) {
                await pause(0);
            } else {
                await pause(preset.hours);
            }
        } catch (e) {
            updateToast(e instanceof RequestError ? e.message : t("dropdown.changes_unsaved"),
                "red", faExclamationTriangle);
            return;
        }

        onPause?.();
        close();
    };

    const isCustomValid = selected !== "custom" || (customHours && parseFloat(customHours) > 0);

    return (
        <Dialog open={open} onClose={onClose} className="pause-dialog">
            {({close}) => (
                <>
                    <DialogHeader onClose={close}>{t("update.pause_title")}</DialogHeader>
                    <DialogBody>
                        <div className="pause-content">
                            <SelectableList>
                                {PRESETS.map(preset => (
                                    <SelectableOption key={preset.id}
                                                      icon={preset.icon}
                                                      title={t(`pause.${preset.id}`)}
                                                      description={t(`pause.${preset.id}_desc`)}
                                                      active={selected === preset.id}
                                                      onClick={() => setSelected(preset.id)}/>
                                ))}
                            </SelectableList>
                            
                            <button 
                                className={`pause-custom-toggle${showCustom ? " pause-custom-open" : ""}`}
                                onClick={() => setShowCustom(!showCustom)}
                            >
                                <span>{t("pause.custom")}</span>
                                <FontAwesomeIcon icon={faChevronDown}/>
                            </button>
                            
                            {showCustom && (
                                <div className="pause-custom">
                                    <input type="number"
                                           className={`dialog-input pause-input${selected === "custom" && !isCustomValid ? " input-error" : ""}`}
                                           value={customHours}
                                           onChange={(e) => {
                                               setCustomHours(e.target.value);
                                               setSelected("custom");
                                           }}
                                           placeholder={t("update.hours")}
                                           min="0.1"
                                           step="0.5"/>
                                </div>
                            )}
                        </div>
                    </DialogBody>
                    <DialogFooter>
                        <button className="dialog-btn" onClick={() => handleSave(close)} disabled={!isCustomValid}>
                            {t("update.pause")}
                        </button>
                    </DialogFooter>
                </>
            )}
        </Dialog>
    );
};