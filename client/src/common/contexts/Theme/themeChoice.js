/**
 * Which theme is in force, and which one that actually means.
 *
 * The theme used to be a boolean with a toggle, defaulting to dark for
 * everybody: `prefers-color-scheme` was not read anywhere in the client, so a
 * reader whose machine is set to light was shown a dark instance on first visit
 * and had to go and say otherwise. A boolean has no room for "whichever the
 * machine says", which is the answer most people would pick if offered it.
 *
 * Kept apart from the provider for the reason LanguageChoice.js is: the provider
 * is JSX that only vite can resolve, and this has to stay readable from a test.
 */

export const THEME_SYSTEM = "system";
export const THEME_DARK = "dark";
export const THEME_LIGHT = "light";

/** Every value the stored preference may take, in the order the dialog lists them. */
export const THEMES = [THEME_SYSTEM, THEME_DARK, THEME_LIGHT];

/**
 * What an instance does before anyone has said otherwise.
 *
 * Following the machine, rather than the dark this used to assume. The old
 * default was only correct by accident: it was what a boolean initialised to,
 * not a decision about what a first-time reader should see.
 */
export const DEFAULT_THEME = THEME_SYSTEM;

/**
 * The stored value, or the default for anything that is not one.
 *
 * This is the whole of the migration. "dark" and "light" are exactly what the
 * old boolean wrote to localStorage, and both are members of the new set, so an
 * instance that had been told which theme to use keeps using it. Only the
 * absence of a value changes meaning - and only for readers who never chose.
 */
export const normaliseTheme = (stored) => THEMES.includes(stored) ? stored : DEFAULT_THEME;

/**
 * The theme to actually paint, given what the reader asked for and what the
 * machine reports.
 *
 * Resolved here rather than in the stylesheets, which is what keeps "system"
 * free: _colors.sass defines dark on a bare :root and light under
 * [data-theme="light"] - two cases, and it stays two cases, because what gets
 * stamped on the document is always one of those two.
 *
 * `prefersDark` may be undefined, from a browser with no matchMedia to ask.
 * That resolves to dark rather than light: a machine that cannot state a
 * preference has not stated light, and dark is what this instance looked like
 * before it was asked.
 */
export const resolveTheme = (theme, prefersDark) =>
    theme === THEME_SYSTEM ? (prefersDark === false ? THEME_LIGHT : THEME_DARK) : theme;
