import React, {useContext, useState} from "react";
import {Dialog, DialogHeader, DialogBody, DialogFooter} from "@/common/contexts/Dialog";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {
    faCheck, faChartLine, faClock, faDesktop, faDroplet, faGauge, faMoon, faPalette, faSun, faSwatchbook
} from "@fortawesome/free-solid-svg-icons";
import {t} from "i18next";
import {ToastNotificationContext} from "@/common/contexts/ToastNotification";
import {ThemeContext} from "@/common/contexts/Theme";
import {
    DEFAULT_THEME, resolveTheme, THEME_DARK, THEME_LIGHT, THEME_SYSTEM
} from "@/common/contexts/Theme/themeChoice";
import {DEFAULT_PALETTE, PALETTES} from "@/common/contexts/Theme/paletteChoice";
import {PALETTE_NAMES} from "@/common/utils/InvariantText";
import {
    fullDetailInfo, gradeValuesInfo, paletteInfo, speedUnitInfo, themeInfo, timeFormatInfo
} from "@/common/utils/PreferencesInfo";
import {useMetricInfo} from "@/common/hooks/useMetricInfo";
import HelpButton from "@/common/components/HelpButton";
import SegmentedControl from "@/common/components/SegmentedControl";
import ToggleSwitch from "@/common/components/ToggleSwitch";
import {
    FULL_DETAIL_POINTS,
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
 * The hue families, built from the list rather than written out.
 *
 * PALETTES is what ThemeContext will accept and what _colors.sass emits a block
 * for; a hand-written array here would be a third list to keep in step, and the
 * one most likely to fall behind - a palette missing a row is invisible rather
 * than broken.
 *
 * The name is a constant and only the line under it is translated - see
 * PALETTE_NAMES. `swatch` is the palette's own id, which the chip stamps on a
 * small preview so the colours inside it resolve that palette's properties
 * instead of the active one. That is the whole of the preview: no colour is
 * named twice.
 */
const PALETTE_OPTIONS = PALETTES.map((id) => ({
    id, swatch: id, label: PALETTE_NAMES[id], descKey: `preferences.palette.${id}_desc`
}));

/**
 * How far a verdict is carried across a reading.
 *
 * Two named options rather than a switch, because "glyph only" says what it does
 * where "off" does not. The preference itself has existed since 1.3.2 - stamped
 * on the document, read by the stylesheets, covered by a test - with nothing
 * anywhere that could turn it on.
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

/**
 * A preview of a palette, painted in that palette.
 *
 * The attributes are the point: _colors.sass declares its blocks against
 * [data-palette] and [data-palette][data-theme=light], and a custom property
 * resolves from the nearest ancestor that matches - so stamping both on this
 * span makes the properties the mixin emits resolve to that palette's values
 * while the rest of the dialog stays in the active one. Naming the four hexes
 * here instead would be a second copy of the palette, in the one place a reader
 * compares them.
 */
const PaletteSwatch = ({palette, theme}) => (
    <span className="palette-swatch" data-palette={palette} data-theme={theme} aria-hidden="true">
        <span className="palette-swatch-dot palette-swatch-good"/>
        <span className="palette-swatch-dot palette-swatch-fair"/>
        <span className="palette-swatch-dot palette-swatch-poor"/>
    </span>
);

/**
 * A heading whose icon is the explanation.
 *
 * The sentence under the title, and the sentence under every option, used to be
 * printed here. Five sections of that ran to about 55rem in a dialog that caps
 * at the viewport, so it scrolled on any laptop and each new preference made it
 * worse. They are behind the icon now - HelpButton and useMetricInfo, the same
 * pair the overview puts on every metric glyph, so it is a gesture the reader
 * has already met rather than a new one invented for this dialog.
 */
const PreferencesSection = ({icon, title, info, openInfo, children}) => (
    <div className="preferences-section">
        <div className="preferences-section-header">
            <HelpButton label={title} onOpen={(event) => openInfo(event, info)}>
                <FontAwesomeIcon icon={icon}/>
            </HelpButton>
            <h3>{title}</h3>
        </div>
        {children}
    </div>
);

/** A segmented control over one of the option arrays above. */
const Choice = ({options, value, onChange, label, className, theme}) => (
    <SegmentedControl
        label={label}
        className={className}
        value={value}
        onChange={onChange}
        options={options.map((option) => ({
            id: option.id,
            icon: option.icon,
            // A name that is the same in every language is a constant, not a key
            // - see InvariantText. Every option has exactly one of the two.
            label: option.label ?? t(option.labelKey),
            adornment: option.swatch ? <PaletteSwatch palette={option.swatch} theme={theme}/> : undefined
        }))}
    />
);

export const PreferencesDialog = ({open, onClose}) => {
    const [preferences, updatePreferences] = useContext(PreferencesContext);
    const {theme: activeTheme, setTheme: applyTheme, palette: activePalette,
        setPalette: applyPalette, systemDark} = useContext(ThemeContext);
    const updateToast = useContext(ToastNotificationContext);
    const openInfo = useMetricInfo();

    // Read when the dialog opens, not at mount - see useSyncOnOpen. This also
    // replaces the hand-rolled reset the old close handler carried for the
    // same purpose.
    const [timeFormat, setTimeFormat] = useState(null);
    const [speedUnit, setSpeedUnit] = useState(null);
    const [theme, setTheme] = useState(DEFAULT_THEME);
    const [palette, setPalette] = useState(DEFAULT_PALETTE);
    const [gradeValues, setGradeValues] = useState(GRADE_VALUE_OPTIONS[0].id);
    const [fullDetail, setFullDetail] = useState(false);

    useSyncOnOpen(open, () => {
        setTimeFormat(preferences.timeFormat);
        setSpeedUnit(preferences.speedUnit);
        // The chosen theme, not the resolved one: opening the dialog while
        // "system" is in force must show System selected, not whichever of dark
        // and light the machine happens to be asking for.
        setTheme(activeTheme);
        setPalette(activePalette);
        setGradeValues(preferences.gradeValues ? "values" : "glyph");
        setFullDetail(preferences.fullChartDetail === true);
    });

    const handleSave = (close) => {
        updatePreferences({
            timeFormat, speedUnit,
            gradeValues: gradeValues === "values",
            fullChartDetail: fullDetail
        });
        if (theme !== activeTheme) applyTheme(theme);
        if (palette !== activePalette) applyPalette(palette);
        updateToast(t("dropdown.changes_applied"), "green", faCheck);
        close();
    };

    // The mode each swatch is previewed in, resolved from the PENDING theme
    // rather than the applied one. "System" matches no stylesheet block, so a
    // preview has to be shown in one of the two - and taking that from the
    // context's `resolved` showed the theme still in force, so selecting System
    // on a light machine left all four swatches dark until Save flipped the app.
    const previewTheme = resolveTheme(theme, systemDark);

    return (
        <Dialog open={open} onClose={onClose} className="preferences-dialog">
            {({close}) => (
                <>
                    <DialogHeader onClose={close}>{t("preferences.title")}</DialogHeader>
                    <DialogBody>
                        <div className="preferences-content">
                            <PreferencesSection icon={faPalette} title={t("preferences.theme.title")}
                                                info={themeInfo} openInfo={openInfo}>
                                <Choice options={THEME_OPTIONS} value={theme} onChange={setTheme}
                                        label={t("preferences.theme.title")}/>
                            </PreferencesSection>

                            <PreferencesSection icon={faSwatchbook} title={t("preferences.palette.title")}
                                                info={paletteInfo(PALETTE_NAMES)} openInfo={openInfo}>
                                <Choice options={PALETTE_OPTIONS} value={palette} onChange={setPalette}
                                        label={t("preferences.palette.title")} theme={previewTheme}
                                        className="segmented-control-stacked"/>
                            </PreferencesSection>

                            <PreferencesSection icon={faClock} title={t("preferences.time_format.title")}
                                                info={timeFormatInfo} openInfo={openInfo}>
                                <Choice options={TIME_FORMAT_OPTIONS} value={timeFormat} onChange={setTimeFormat}
                                        label={t("preferences.time_format.title")}/>
                            </PreferencesSection>

                            <PreferencesSection icon={faGauge} title={t("preferences.speed_unit.title")}
                                                info={speedUnitInfo} openInfo={openInfo}>
                                <Choice options={SPEED_UNIT_OPTIONS} value={speedUnit} onChange={setSpeedUnit}
                                        label={t("preferences.speed_unit.title")}/>
                            </PreferencesSection>

                            <PreferencesSection icon={faDroplet} title={t("preferences.grade_values.title")}
                                                info={gradeValuesInfo} openInfo={openInfo}>
                                <Choice options={GRADE_VALUE_OPTIONS} value={gradeValues} onChange={setGradeValues}
                                        label={t("preferences.grade_values.title")}/>
                            </PreferencesSection>

                            {/* Until now this could only be set from the toolbar of an expanded
                                chart, so the one preference about how much a chart shows had no
                                home among the preferences. Both write the same value. */}
                            <PreferencesSection icon={faChartLine} title={t("statistics.detail.title")}
                                                info={fullDetailInfo(FULL_DETAIL_POINTS)} openInfo={openInfo}>
                                <div className="preferences-switch-row">
                                    <span>{t("statistics.detail.title")}</span>
                                    <ToggleSwitch id="preferences-full-detail" checked={fullDetail}
                                                  onChange={setFullDetail} label={t("statistics.detail.title")}/>
                                </div>
                            </PreferencesSection>
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
