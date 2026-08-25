import {t} from "i18next";

/**
 * What each preference section means, and what each of its choices does.
 *
 * The preferences dialog used to print all of this: every option was a row with
 * its sentence underneath, and five sections of that came to about 55rem in a
 * dialog capped at the viewport height. The choices are one-line controls now,
 * and the sentences moved here - reached by clicking the section's icon, which
 * is the same gesture the overview already puts on every metric glyph.
 *
 * Not a string was dropped to do it, and not one was added. Every key below is
 * one the dialog was already showing, so no locale file changed and nothing had
 * to be translated again; the same words are one click away instead of always
 * on screen.
 *
 * Read at call time rather than built once, exactly as MetricInfo is: `t`
 * resolves against the language loaded right now, and a module-level object
 * would freeze whichever one happened to be active at first import.
 */

/** A section's own sentence, then a line naming what each choice does. */
const explains = (key, choices) => () => ({
    title: t(`preferences.${key}.title`),
    description: [t(`preferences.${key}.description`),
        ...choices.map((choice) => `${t(`preferences.${key}.${choice}`)} — ${t(`preferences.${key}.${choice}_desc`)}`)]
        .join("\n"),
    buttonText: t("dialog.okay")
});

export const themeInfo = explains("theme", ["system", "dark", "light"]);
export const timeFormatInfo = explains("time_format", ["h24", "h12"]);
export const speedUnitInfo = explains("speed_unit", ["mbps", "mbytes"]);
export const gradeValuesInfo = explains("grade_values", ["glyph", "values"]);

/**
 * The palettes name themselves in constants rather than keys - translating Nord
 * and Carbon produces a compass direction and an element, see InvariantText -
 * so this one takes the names it is given and translates only the lines under
 * them.
 */
export const paletteInfo = (names) => () => ({
    title: t("preferences.palette.title"),
    description: [t("preferences.palette.description"),
        ...Object.entries(names).map(([id, name]) => `${name} — ${t(`preferences.palette.${id}_desc`)}`)].join("\n"),
    buttonText: t("dialog.okay")
});

/**
 * The chart resolution, which until now could only be set from the toolbar of
 * an expanded chart - so it was a preference with no home among the preferences.
 * Its own strings, reused rather than restated: the toggle here and the toggle
 * there write the same value, so they had better say the same thing.
 */
export const fullDetailInfo = (maxPoints) => () => ({
    title: t("statistics.detail.title"),
    description: t("statistics.detail.description", {max: maxPoints}),
    buttonText: t("dialog.okay")
});
