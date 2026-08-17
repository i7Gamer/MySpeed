import React, {createContext, useEffect, useState} from "react";
import {readStored, writeStored} from "@/common/utils/Storage";

export const ThemeContext = createContext({});

export const ThemeProvider = (props) => {
    const [isDarkMode, setIsDarkMode] = useState(() => {
        const savedTheme = readStored("theme");
        if (savedTheme) return savedTheme === "dark";
        return true;
    });

    const toggleTheme = () => {
        const newTheme = !isDarkMode;
        setIsDarkMode(newTheme);
        writeStored("theme", newTheme ? "dark" : "light");
    };

    useEffect(() => {
        document.documentElement.setAttribute('data-theme', isDarkMode ? 'dark' : 'light');
    }, [isDarkMode]);

    return (
        <ThemeContext.Provider value={[isDarkMode, toggleTheme]}>
            {props.children}
        </ThemeContext.Provider>
    );
};
