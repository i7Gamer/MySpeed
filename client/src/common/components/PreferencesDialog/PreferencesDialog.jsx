import React, {useContext, useState} from "react";
import {Dialog, DialogHeader, DialogBody, DialogFooter} from "@/common/contexts/Dialog";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faCheck, faClock, faDesktop, faDroplet, faGauge, faMoon, faPalette, faSun} from "@fortawesome/free-solid-svg-icons";
import {t} from "i18next";
import {ToastNotificationContext} from "@/common/contexts/ToastNotification";
import {ThemeContext} from "@/common/contexts/Theme";
import {DEFAULT_THEME, THEME_DARK, THEME_LIGHT, THEME_SYSTEM} from "@/common/contexts/Theme/themeChoice";
import SelectableOption, {SelectableList} from "@/common/components/SelectableOption";
import {
    PreferencesContext,
    SPEED_UNIT_MBPS,
    SPEED_UNIT_MBYTES,
    TIME_FORMAT_12H,
    TIME_FORMAT_24H
} from "@/common/contexts/Preferences";
import {useSyncOnOpen} from "@/common/hooks/useSyncOnOpen";
import "./styles.sass";

// System first, because it is the default and the answer most readers would
// pick: the theme followed nothing but its own initial value before, so a
// machine set to light was shown a dark instance and had to be told otherwise.
const THEME_OPTIONS = [
    {id: THEME_SYSTEM, labelKey: "preferences.theme.system", descKey: "preferences.theme.system_desc", icon: faDesktop},
    {id: THEME_DARK, labelKey: "preferences.theme.dark", descKey: "preferences.theme.dark_desc", icon: faMoon},
    {id: THEME_LIGHT, labelKey: "preferences.theme.light", descKey: "preferences.theme.light_desc", icon: faSun}
];

/**
 * How far a verdict is carried across a reading.
 *
 * Two named options rather than a switch: every other control in this dialog is
 * a list, a boolean toggle would be the only one of its kind, and "glyph only"
 * says what it does where "off" does not. The preference itself has existed
 * since 1.3.2 - stamped on the document, read by the stylesheets, covered by a
 * test - with nothing anywhere that could turn it on.
 */
const GRADE_VALUE_OPTIONS = [
    {id: "glyph", labelKey: "preferences.grade_values.glyph", descKey: "preferences.grade_values.glyph_desc"},
    {id: "values", labelKey: "preferences.grade_values.values", descKey: "preferences.grade_values.values_desc"}
];

const TIME_FORMAT_OPTIONS = [
    {id: TIME_FORMAT_24H, labelKey: "preferences.time_format.h24", descKey: "preferences.time_format.h24_desc"},
    {id: TIME_FORMAT_12H, labelKey: "preferences.time_format.h12", descKey: "preferences.time_format.h12_desc"}
];

const SPEED_UNIT_OPTIONS = [
    {id: SPEED_UNIT_MBPS, labelKey: "preferences.speed_unit.mbps", descKey: "preferences.speed_unit.mbps_desc"},
    {id: SPEED_UNIT_MBYTES, labelKey: "preferences.speed_unit.mbytes", descKey: "preferences.speed_unit.mbytes_desc"}
];

const PreferencesSection = ({icon, title, description, options, value, onChange}) => (
    <div className="preferences-section">
        <div className="preferences-section-header">
            <FontAwesomeIcon icon={icon}/>
            <div>
                <h3>{title}</h3>
                <p>{description}</p>
            </div>
        </div>
        <SelectableList>
            {options.map(option => (
                <SelectableOption
                    key={option.id}
                    icon={option.icon}
                    title={t(option.labelKey)}
                    description={t(option.descKey)}
                    active={value === option.id}
                    onClick={() => onChange(option.id)}
                />
            ))}
        </SelectableList>
    </div>
);

export const PreferencesDialog = ({open, onClose}) => {
    const [preferences, updatePreferences] = useContext(PreferencesContext);
    const {theme: activeTheme, setTheme: applyTheme} = useContext(ThemeContext);
    const updateToast = useContext(ToastNotificationContext);
    // Read when the dialog opens, not at mount - see useSyncOnOpen. This also
    // replaces the hand-rolled reset the old close handler carried for the
    // same purpose.
    const [timeFormat, setTimeFormat] = useState(null);
    const [speedUnit, setSpeedUnit] = useState(null);
    const [theme, setTheme] = useState(DEFAULT_THEME);
    const [gradeValues, setGradeValues] = useState(GRADE_VALUE_OPTIONS[0].id);

    useSyncOnOpen(open, () => {
        setTimeFormat(preferences.timeFormat);
        setSpeedUnit(preferences.speedUnit);
        // The chosen theme, not the resolved one: opening the dialog while
        // "system" is in force must show System selected, not whichever of dark
        // and light the machine happens to be asking for.
        setTheme(activeTheme);
        setGradeValues(preferences.gradeValues ? "values" : "glyph");
    });

    const handleSave = (close) => {
        updatePreferences({timeFormat, speedUnit, gradeValues: gradeValues === "values"});
        if (theme !== activeTheme) applyTheme(theme);
        updateToast(t("dropdown.changes_applied"), "green", faCheck);
        close();
    };

    return (
        <Dialog open={open} onClose={onClose} className="preferences-dialog">
            {({close}) => (
                <>
                    <DialogHeader onClose={close}>{t("preferences.title")}</DialogHeader>
                    <DialogBody>
                        <div className="preferences-content">
                            <PreferencesSection
                                icon={faPalette}
                                title={t("preferences.theme.title")}
                                description={t("preferences.theme.description")}
                                options={THEME_OPTIONS}
                                value={theme}
                                onChange={setTheme}
                            />
                            <PreferencesSection
                                icon={faClock}
                                title={t("preferences.time_format.title")}
                                description={t("preferences.time_format.description")}
                                options={TIME_FORMAT_OPTIONS}
                                value={timeFormat}
                                onChange={setTimeFormat}
                            />
                            <PreferencesSection
                                icon={faGauge}
                                title={t("preferences.speed_unit.title")}
                                description={t("preferences.speed_unit.description")}
                                options={SPEED_UNIT_OPTIONS}
                                value={speedUnit}
                                onChange={setSpeedUnit}
                            />
                            <PreferencesSection
                                icon={faDroplet}
                                title={t("preferences.grade_values.title")}
                                description={t("preferences.grade_values.description")}
                                options={GRADE_VALUE_OPTIONS}
                                value={gradeValues}
                                onChange={setGradeValues}
                            />
                        </div>
                    </DialogBody>
                    <DialogFooter>
                        <button className="dialog-btn" onClick={() => handleSave(close)}>
                            {t("dialog.save")}
                        </button>
                    </DialogFooter>
                </>
            )}
        </Dialog>
    );
};
