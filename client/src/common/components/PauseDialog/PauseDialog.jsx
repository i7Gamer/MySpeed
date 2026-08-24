import React, {useContext, useState} from "react";
import {Dialog, DialogHeader, DialogBody, DialogFooter} from "@/common/contexts/Dialog";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faExclamationTriangle, faInfinity, faClock, faMugHot, faMoon, faChevronDown} from "@fortawesome/free-solid-svg-icons";
import {t} from "i18next";
import {assertOk, patchRequest, postRequest, RequestError} from "@/common/utils/RequestUtil";
import {ToastNotificationContext} from "@/common/contexts/ToastNotification";
import {ConfigContext} from "@/common/contexts/Config";
import SelectableOption, {SelectableList} from "@/common/components/SelectableOption";
import {useSyncOnOpen} from "@/common/hooks/useSyncOnOpen";
import {
    carriesWindow, storedTimeToInput, windowProblem, writeQuietHours
} from "@/common/components/PauseDialog/quietHoursWindow";
import {
    TIMEZONE_OFF, storedTimezoneToInput, timezoneOptions
} from "@/common/components/PauseDialog/timezoneChoice";
import "./styles.sass";

const PRESETS = [
    {id: "manual", hours: null, icon: faInfinity},
    {id: "short", hours: 1, icon: faMugHot},
    {id: "medium", hours: 6, icon: faClock},
    {id: "long", hours: 12, icon: faMoon}
];

export const PauseDialog = ({open, onClose, onPause}) => {
    const updateToast = useContext(ToastNotificationContext);
    const [config, reloadConfig, checkConfig] = useContext(ConfigContext);
    const [selected, setSelected] = useState("manual");
    const [customHours, setCustomHours] = useState("");
    const [showCustom, setShowCustom] = useState(false);

    // A pause is a one-shot; the quiet hours are the standing version of it,
    // which is what both upstream requests actually asked for - having to set a
    // pause again every evening is why neither was answered by pausing.
    const [showQuiet, setShowQuiet] = useState(false);
    const [quietStart, setQuietStart] = useState("");
    const [quietEnd, setQuietEnd] = useState("");
    const [savingQuiet, setSavingQuiet] = useState(false);

    // The clock both the window above and the cron are judged on. It lives here
    // rather than in a settings page of its own because these are the hours it
    // decides the meaning of: "no tests between 23:00 and 07:00" says nothing
    // until something says whose 23:00.
    const [timezone, setTimezone] = useState(TIMEZONE_OFF);

    // Built once per render of an open dialog rather than per keystroke: it is
    // some 400 entries, and the stored value is the only input that moves it.
    const zones = timezoneOptions(config.timezone);

    const showStoredWindow = (stored) => {
        setQuietStart(storedTimeToInput(stored.quietHoursStart));
        setQuietEnd(storedTimeToInput(stored.quietHoursEnd));
        setTimezone(storedTimezoneToInput(stored.timezone));
    };

    // Read when the dialog opens rather than at mount: the config arrives
    // asynchronously, and a value read once at mount is whatever was there
    // before it did.
    useSyncOnOpen(open, () => showStoredWindow(config));

    const quietProblem = windowProblem(quietStart, quietEnd);

    const saveQuietHours = async () => {
        if (quietProblem) return;

        setSavingQuiet(true);
        try {
            /*
             * Written first, and only when it moved.
             *
             * First, because the window is read *through* it: writing the pair
             * against the old zone and then changing the zone would leave a
             * moment - and, if the second write is refused, a lasting state -
             * where the stored hours mean something nobody asked for.
             *
             * Only when it moved, because the server restarts the schedule on
             * every write of this key: node-schedule compiles the zone into the
             * job and cannot be told otherwise. Saving an unchanged zone would
             * tear down a working timer and build an identical one, which for a
             * schedule with the offset enabled also re-randomises the next run.
             */
            if (timezone !== storedTimezoneToInput(config.timezone))
                assertOk(await patchRequest("/config/timezone", {value: timezone}), "update timezone");

            await writeQuietHours(
                async (key, value) => assertOk(await patchRequest(`/config/${key}`, {value}), "update quiet hours"),
                quietStart, quietEnd, config);

            updateToast(t("update.quiet_hours_saved"), "green", faMoon);
        } catch (e) {
            updateToast(e instanceof RequestError ? e.message : t("dropdown.changes_unsaved"),
                "red", faExclamationTriangle);

            // A refused write can leave the server holding a pair this dialog
            // never showed, and writeQuietHours only attempts to undo that - a
            // session that expired refuses the undo as well. The fields would
            // otherwise go on showing the window that was asked for, and
            // reopening would re-seed them from a config just as stale, so
            // nothing on screen would ever name the pair the scheduler obeys.
            const stored = await checkConfig().catch(() => null);
            if (carriesWindow(stored)) showStoredWindow(stored);
        } finally {
            setSavingQuiet(false);
            // Either way, and for everyone else reading these two keys: the
            // frequency dialog's next-test preview is one of them.
            reloadConfig();
        }
    };

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
                                type="button"
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

                            {/* The standing version of a pause: the same hours
                                every day, without having to set it again. */}
                            <button
                                type="button"
                                className={`pause-custom-toggle${showQuiet ? " pause-custom-open" : ""}`}
                                onClick={() => setShowQuiet(!showQuiet)}
                            >
                                <span>{t("pause.quiet_hours")}</span>
                                <FontAwesomeIcon icon={faChevronDown}/>
                            </button>

                            {showQuiet && (
                                <div className="pause-custom">
                                    <p className="pause-quiet-hint">{t("pause.quiet_hours_desc")}</p>
                                    <div className="pause-quiet-range">
                                        <label>
                                            <span>{t("pause.quiet_from")}</span>
                                            <input type="time" value={quietStart}
                                                   className={`dialog-input pause-input${quietProblem === "start" ? " input-error" : ""}`}
                                                   onChange={(e) => setQuietStart(e.target.value)}/>
                                        </label>
                                        <label>
                                            <span>{t("pause.quiet_until")}</span>
                                            <input type="time" value={quietEnd}
                                                   className={`dialog-input pause-input${["end", "same"].includes(quietProblem) ? " input-error" : ""}`}
                                                   onChange={(e) => setQuietEnd(e.target.value)}/>
                                        </label>
                                    </div>
                                    <label className="pause-quiet-timezone">
                                        <span>{t("pause.timezone")}</span>
                                        <select className="dialog-input timezone-select"
                                                aria-label={t("pause.timezone")}
                                                value={timezone}
                                                onChange={(e) => setTimezone(e.target.value)}>
                                            {/* The sentinel is offered by what it
                                                means, not by its stored spelling:
                                                "none" names nothing to a reader. */}
                                            <option value={TIMEZONE_OFF}>{t("pause.timezone_server")}</option>
                                            {zones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
                                        </select>
                                    </label>
                                    <p className="pause-quiet-hint">{t("pause.timezone_desc")}</p>
                                    <button type="button" className="dialog-btn pause-quiet-save"
                                            onClick={saveQuietHours} disabled={!!quietProblem || savingQuiet}>
                                        {t("dialog.save")}
                                    </button>
                                </div>
                            )}
                        </div>
                    </DialogBody>
                    <DialogFooter>
                        <button type="button" className="dialog-btn" onClick={() => handleSave(close)} disabled={!isCustomValid}>
                            {t("update.pause")}
                        </button>
                    </DialogFooter>
                </>
            )}
        </Dialog>
    );
};