import React, {useState, useContext} from "react";
import {Dialog, DialogHeader, DialogBody, DialogFooter} from "@/common/contexts/Dialog";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faCheck, faQuestionCircle, faBolt, faGauge, faClock, faLeaf, faSeedling, faChevronDown} from "@fortawesome/free-solid-svg-icons";
import {t} from "i18next";
import {assertOk, patchRequest, RequestError} from "@/common/utils/RequestUtil";
import {ConfigContext} from "@/common/contexts/Config";
import {ToastNotificationContext} from "@/common/contexts/ToastNotification";
import {PreferencesContext} from "@/common/contexts/Preferences";
import {formatDateTime} from "@/common/utils/FormatUtil";
import SelectableOption, {SelectableList} from "@/common/components/SelectableOption";
import {CronExpressionParser} from "cron-parser";
import {useSyncOnOpen} from "@/common/hooks/useSyncOnOpen";
import {CRON_PRESETS, DEFAULT_CRON, frequencyStateFrom} from "./frequencyState";
import "./styles.sass";

// The choices live in frequencyState.js, importable by tests; the icons are
// this file's clothing for them.
const PRESET_ICONS = {
    continuous: faBolt,
    frequent: faGauge,
    default: faClock,
    rare: faLeaf,
    really_rare: faSeedling
};

const PRESETS = CRON_PRESETS.map((preset) => ({...preset, icon: PRESET_ICONS[preset.id]}));

const getNextRunDate = (cron) => {
    try {
        return CronExpressionParser.parse(cron).next().toDate();
    } catch {
        return null;
    }
};

export const FrequencyDialog = ({open, onClose}) => {
    const [config, reloadConfig] = useContext(ConfigContext);
    const updateToast = useContext(ToastNotificationContext);
    const [preferences] = useContext(PreferencesContext);

    const getNextRun = (cron) => {
        const date = getNextRunDate(cron);
        if (!date) return null;
        return formatDateTime(date, preferences);
    };
    // Placeholders until the dialog opens: the stored values are read at that
    // moment, not at mount. This component mounts with the header, and on an
    // instance with read-level access the header first mounts against the
    // visitor config - which omits cron and scheduleOffset entirely, so a
    // mount-time capture showed defaults over the stored schedule for the
    // whole session. See useSyncOnOpen.
    const [selected, setSelected] = useState("default");
    const [customCron, setCustomCron] = useState(DEFAULT_CRON);
    const [scheduleOffset, setScheduleOffset] = useState(false);
    const [showAdvanced, setShowAdvanced] = useState(false);
    const [saving, setSaving] = useState(false);

    useSyncOnOpen(open, () => {
        const state = frequencyStateFrom(config);
        setSelected(state.selected);
        setCustomCron(state.customCron);
        setScheduleOffset(state.scheduleOffset);
        setShowAdvanced(state.showAdvanced);
    });

    const handlePresetClick = (preset) => {
        setSelected(preset.id);
        setCustomCron(preset.cron);
    };

    const handleSave = async (close) => {
        const cronValue = selected === "custom" ? customCron : PRESETS.find(p => p.id === selected)?.cron;
        if (!cronValue || !getNextRun(cronValue)) return;

        setSaving(true);
        try {
            // Two writes, checked one by one: the cron landing while the offset
            // bounced used to report the whole save as unsaved - over a
            // schedule that had in fact changed.
            await assertOk(await patchRequest("/config/cron", {value: cronValue}), "cron");
            await assertOk(await patchRequest("/config/scheduleOffset",
                {value: scheduleOffset ? "true" : "false"}), "scheduleOffset");

            updateToast(t("dropdown.changes_applied"), "green", faCheck);
            close();
        } catch (e) {
            updateToast(e instanceof RequestError ? e.message : t("dropdown.changes_unsaved"), "red");
        } finally {
            setSaving(false);
            // Either way: a partial save has to show up, or the dialog re-opens
            // on a schedule that is no longer the stored one.
            reloadConfig();
        }
    };

    const isCustomValid = selected !== "custom" || getNextRun(customCron);
    const nextRun = getNextRun(customCron);

    return (
        <Dialog open={open} onClose={onClose} className="frequency-dialog">
            {({close}) => (
                <>
                    <DialogHeader onClose={close}>{t("update.cron_title")}</DialogHeader>
                    <DialogBody>
                        <div className="frequency-content">
                            <SelectableList>
                                {PRESETS.map(preset => (
                                    <SelectableOption key={preset.id}
                                        icon={preset.icon}
                                        title={t(`options.cron.${preset.id}`)}
                                        description={t(`options.cron.${preset.id}_desc`)}
                                        active={selected === preset.id}
                                        onClick={() => handlePresetClick(preset)}/>
                                ))}
                            </SelectableList>
                            
                            <button 
                                className={`frequency-advanced-toggle${showAdvanced ? " frequency-advanced-open" : ""}`}
                                onClick={() => setShowAdvanced(!showAdvanced)}
                            >
                                <span>{t("update.custom_cron")}</span>
                                <FontAwesomeIcon icon={faChevronDown}/>
                            </button>
                            
                            {showAdvanced && (
                                <div className="frequency-custom">
                                    <div className="frequency-custom-input">
                                        <input type="text" 
                                            className={`dialog-input frequency-input${selected === "custom" && !isCustomValid ? " input-error" : ""}`}
                                            value={customCron} 
                                            onChange={(e) => { setCustomCron(e.target.value); setSelected("custom"); }}
                                            placeholder="0 * * * *"/>
                                        <a href="https://crontab.guru/" target="_blank" rel="noreferrer" className="frequency-help">
                                            <FontAwesomeIcon icon={faQuestionCircle}/>
                                        </a>
                                    </div>
                                    {nextRun && <p className="frequency-next-run">{t("update.cron_next_test")} {nextRun}</p>}
                                </div>
                            )}
                            
                            <div className="frequency-option" onClick={() => setScheduleOffset(!scheduleOffset)}>
                                <div className={`frequency-toggle${scheduleOffset ? " frequency-toggle-active" : ""}`}>
                                    <div className="frequency-toggle-knob"/>
                                </div>
                                <div className="frequency-option-text">
                                    <h3>{t("update.schedule_offset")}</h3>
                                    <p>{t("update.schedule_offset_desc")}</p>
                                </div>
                            </div>
                        </div>
                    </DialogBody>
                    <DialogFooter>
                        <button className="dialog-btn" onClick={() => handleSave(close)} disabled={saving || !isCustomValid}>
                            {saving ? t("dialog.saving") : t("dialog.save")}
                        </button>
                    </DialogFooter>
                </>
            )}
        </Dialog>
    );
};