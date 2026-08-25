import React, {createContext, useCallback, useEffect, useMemo, useState} from "react";
import {readStored, writeStored} from "@/common/utils/Storage";
import {normaliseTheme, resolveTheme, THEME_SYSTEM} from "./themeChoice";
import {normalisePalette} from "./paletteChoice";

export const ThemeContext = createContext({});

const STORAGE_KEY = "theme";
const PALETTE_KEY = "palette";
const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * What the machine says, or undefined where it cannot be asked.
 *
 * matchMedia is absent in a few embedded webviews. Undefined rather than false,
 * so resolveTheme can tell "the machine prefers light" from "there is no machine
 * preference to have" - the second must not flip an instance to light.
 */
const prefersDark = () => typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(DARK_QUERY).matches
    : undefined;

export const ThemeProvider = (props) => {
    const [theme, setStoredTheme] = useState(() => normaliseTheme(readStored(STORAGE_KEY)));
    const [palette, setStoredPalette] = useState(() => normalisePalette(readStored(PALETTE_KEY)));
    const [systemDark, setSystemDark] = useState(prefersDark);

    /**
     * The machine's answer, watched rather than sampled.
     *
     * Without this "system" would mean "whatever the machine said when the tab
     * was opened", so an instance left open across the evening keeps the theme
     * the morning had. Attached whatever the current choice is - the listener is
     * cheap, and the alternative is re-subscribing every time the reader changes
     * their mind.
     */
    useEffect(() => {
        if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;

        const query = window.matchMedia(DARK_QUERY);
        const onChange = (event) => setSystemDark(event.matches);

        query.addEventListener("change", onChange);
        return () => query.removeEventListener("change", onChange);
    }, []);

    const resolved = resolveTheme(theme, systemDark);

    /*
     * Stamped during this render, not in an effect after it.
     *
     * The charts read their colours off the document - chartThemeColors calls
     * getComputedStyle - and they do it inside a useMemo, during their own
     * render. An effect here runs after the children have rendered, so on the
     * frame a theme changes they would read the properties the outgoing theme
     * left behind; and the memo is keyed on the resolved theme, which has
     * already changed, so nothing would ever ask again. The charts would keep
     * the old palette until something else happened to invalidate them.
     *
     * A provider renders before its children, so setting the attribute here
     * puts it in place in time. Writing an attribute the value it already holds
     * is a no-op, which is what makes this safe to run on every render.
     */
    if (typeof document !== "undefined") {
        document.documentElement.setAttribute("data-theme", resolved);
        document.documentElement.setAttribute("data-palette", palette);
    }

    // And again after commit, because the render above may be one React throws
    // away - a concurrent render that never commits would otherwise leave the
    // document describing a theme the reader never chose.
    useEffect(() => {
        document.documentElement.setAttribute("data-theme", resolved);
        document.documentElement.setAttribute("data-palette", palette);
    }, [resolved, palette]);

    const setTheme = useCallback((next) => {
        const chosen = normaliseTheme(next);

        setStoredTheme(chosen);
        writeStored(STORAGE_KEY, chosen);
    }, []);

    const setPalette = useCallback((next) => {
        const chosen = normalisePalette(next);

        setStoredPalette(chosen);
        writeStored(PALETTE_KEY, chosen);
    }, []);

    /**
     * `systemDark` is passed on rather than kept private because `resolved`
     * only answers for the theme in force. The preferences dialog has to
     * resolve one the reader has selected and not yet saved - picking System
     * has to preview as light on a machine set to light, whatever the applied
     * theme is - and resolveTheme needs the machine's answer to do it.
     *
     * `isDarkMode` used to sit here too. Nothing read it once the charts
     * stopped asking in booleans, and a boolean cannot answer a palette.
     */
    const value = useMemo(() => ({
        theme, setTheme, resolved, palette, setPalette, systemDark,
        followsSystem: theme === THEME_SYSTEM
    }), [theme, setTheme, resolved, palette, setPalette, systemDark]);

    return (
        <ThemeContext.Provider value={value}>
            {props.children}
        </ThemeContext.Provider>
    );
};

