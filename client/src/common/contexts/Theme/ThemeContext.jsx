import React, {createContext, useCallback, useEffect, useMemo, useState} from "react";
import {readStored, writeStored} from "@/common/utils/Storage";
import {DEFAULT_THEME, normaliseTheme, resolveTheme, THEME_SYSTEM} from "./themeChoice";

export const ThemeContext = createContext({});

const STORAGE_KEY = "theme";
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

    useEffect(() => {
        document.documentElement.setAttribute("data-theme", resolved);
    }, [resolved]);

    const setTheme = useCallback((next) => {
        const chosen = normaliseTheme(next);

        setStoredTheme(chosen);
        writeStored(STORAGE_KEY, chosen);
    }, []);

    /**
     * `isDarkMode` is kept because the charts still ask in booleans - see
     * chartThemeColors, which takes one. It is the resolved answer, so a chart
     * drawn while the theme is "system" follows the machine like everything else.
     */
    const value = useMemo(() => ({
        theme, setTheme, resolved,
        isDarkMode: resolved !== "light",
        followsSystem: theme === THEME_SYSTEM
    }), [theme, setTheme, resolved]);

    return (
        <ThemeContext.Provider value={value}>
            {props.children}
        </ThemeContext.Provider>
    );
};

export {DEFAULT_THEME, THEME_SYSTEM};
