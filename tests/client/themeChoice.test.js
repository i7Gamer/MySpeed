import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    DEFAULT_THEME, normaliseTheme, resolveTheme, THEME_DARK, THEME_LIGHT, THEME_SYSTEM, THEMES
} from "@/common/contexts/Theme/themeChoice.js";

/**
 * Three states where there were two.
 *
 * The theme was a boolean with a toggle, and it defaulted to dark for everyone:
 * `prefers-color-scheme` was not consulted anywhere in the client, so a reader
 * whose machine is set to light got a dark instance on first visit and had to go
 * and say so. A boolean has no room for "whichever the machine says", which is
 * the answer most people would pick.
 *
 * Split out of the provider for the reason LanguageChoice.js was: this has to be
 * readable from a test, and the provider it lives beside is JSX that only vite
 * can resolve.
 */
describe("normaliseTheme", () => {
    it("keeps a theme it knows", () => {
        for (const theme of THEMES) assert.equal(normaliseTheme(theme), theme);
    });

    /**
     * The migration, and the whole of it: "dark" and "light" were what the old
     * boolean wrote down, and both are values of the new set. Only an absent
     * value changes meaning - from dark to system.
     */
    it("carries the value the boolean used to store", () => {
        assert.equal(normaliseTheme("dark"), THEME_DARK);
        assert.equal(normaliseTheme("light"), THEME_LIGHT);
    });

    it("falls back to following the machine", () => {
        for (const absent of [null, undefined, "", "midnight", 7, {}])
            assert.equal(normaliseTheme(absent), THEME_SYSTEM);
    });

    it("follows the machine by default", () => {
        assert.equal(DEFAULT_THEME, THEME_SYSTEM);
    });
});

/**
 * The stylesheets never learn that a third state exists.
 *
 * _colors.sass defines dark on a bare :root and light under [data-theme="light"],
 * which is two cases and stays two cases. What is stamped on the document is the
 * resolved answer, so "system" costs the CSS nothing at all - and a palette added
 * later inherits the same arrangement without knowing about it either.
 */
describe("resolveTheme", () => {
    it("asks the machine only when told to", () => {
        assert.equal(resolveTheme(THEME_SYSTEM, true), THEME_DARK);
        assert.equal(resolveTheme(THEME_SYSTEM, false), THEME_LIGHT);
    });

    it("ignores the machine when a theme was chosen", () => {
        assert.equal(resolveTheme(THEME_DARK, false), THEME_DARK);
        assert.equal(resolveTheme(THEME_LIGHT, true), THEME_LIGHT);
    });

    it("only ever resolves to a theme the stylesheet has", () => {
        for (const theme of THEMES)
            for (const prefersDark of [true, false])
                assert.ok([THEME_DARK, THEME_LIGHT].includes(resolveTheme(theme, prefersDark)),
                    `${theme} resolved to something data-theme cannot carry`);
    });

    /**
     * A machine that will not answer. matchMedia is absent in some embedded
     * webviews and returns undefined rather than throwing; treating that as
     * "light" would flip an instance on a browser that simply cannot say.
     */
    it("stays dark when the machine has no preference to give", () => {
        assert.equal(resolveTheme(THEME_SYSTEM, undefined), THEME_DARK);
        assert.equal(resolveTheme(THEME_SYSTEM, null), THEME_DARK);
    });
});
