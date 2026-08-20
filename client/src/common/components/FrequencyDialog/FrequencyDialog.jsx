import React, {useState, useContext, useMemo} from "react";
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
import {clickable} from "@/common/utils/Clickable";
import {firstRunOutsideWindow} from "@/common/components/PauseDialog/quietHoursWindow";
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

/**
 * Whether the expression describes a schedule at all, the quiet hours aside.
 *
 * Kept separate from the preview below: a window that happens to swallow every
 * occurrence of a perfectly good cron must not make it unsaveable, and the way
 * out of that is the quiet hours dialog rather than this one.
 */
const isCronValid = (cron) => {
    try {
        CronExpressionParser.parse(cron).next();
        return true;
    } catch {
        return false;
    }
};

/**
 * When a test would actually run next, or null if the window swallows them all.
 *
 * Quiet-aware because the scheduler is: server/tasks/timer.js steps over the
 * occurrences inside the window, since runTask refuses them, and the status bar
 * counts down to what it answers. A bare next() here announced 00:00 to an
 * operator whose quiet hours ran to 08:00 - disagreeing with the countdown on
 * the same screen about a test that was never going to happen.
 */
const getNextRunDate = (cron, quietStart, quietEnd) => {
    try {
        const schedule = CronExpressionParser.parse(cron);

        return firstRunOutsideWindow(() => schedule.next().toDate(), quietStart, quietEnd);
    } catch {
        return null;
    }
};

export const FrequencyDialog = ({open, onClose}) => {
    const [config, reloadConfig] = useContext(ConfigContext);
    const updateToast = useContext(ToastNotificationContext);
    const [preferences] = useContext(PreferencesContext);

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

    const toggleScheduleOffset = () => setScheduleOffset(!scheduleOffset);

    const handleSave = async (close) => {
        const cronValue = selected === "custom" ? customCron : PRESETS.find(p => p.id === selected)?.cron;
        if (!cronValue || !isCronValid(cronValue)) return;

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

    const isCustomValid = selected !== "custom" || isCronValid(customCron);

    // The window comes out of the same /config payload the schedule does. View
    // mode withholds both, and withholds this dialog with them - it is reached
    // from an operator-only entry in the dropdown - so anyone who can see the
    // preview can see what shapes it.
    //
    // Memoized, and skipped outright while closed: this dialog stays mounted
    // under the dropdown, which re-renders with every status poll, and a window
    // that swallows the schedule makes each evaluation walk up to
    // MAX_QUIET_OCCURRENCES occurrences. Going stale across an occurrence while
    // the dialog sits open is the cheaper wrong.
    const nextRunDate = useMemo(
        () => open ? getNextRunDate(customCron, config.quietHoursStart, config.quietHoursEnd) : null,
        [open, customCron, config.quietHoursStart, config.quietHoursEnd]);
    const nextRun = nextRunDate ? formatDateTime(nextRunDate, preferences) : null;

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
                            
                            {/* The shared key handling, with the role a toggle
                                actually has - clickable() spells "button",
                                and this reports a state rather than firing an
                                action, so a reader is told whether it is on.
                                As a bare div with an onClick it was the one
                                control in this dialog a keyboard could not
                                reach: the presets are SelectableOption and the
                                disclosure above is a real button. */}
                            <div className="frequency-option" {...clickable(toggleScheduleOffset)}
                                 role="switch" aria-checked={scheduleOffset}>
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