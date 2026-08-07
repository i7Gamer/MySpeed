import React, {createContext, useCallback, useState} from "react";
import {DEFAULT_TIMEFRAME} from "@/common/utils/TimeframeUtil";

export const TIME_FORMAT_24H = "24h";
export const TIME_FORMAT_12H = "12h";
export const SPEED_UNIT_MBPS = "mbps";
export const SPEED_UNIT_MBYTES = "mbytes";

const STORAGE_KEY = "preferences";

const DEFAULTS = {
    timeFormat: TIME_FORMAT_24H,
    speedUnit: SPEED_UNIT_MBPS,
    defaultTimeframe: DEFAULT_TIMEFRAME,
    // Off by default: the extra resolution costs a second request and is only
    // worth it when the reader is chasing something specific.
    fullChartDetail: false
};

const loadPreferences = () => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return {...DEFAULTS};
        const parsed = JSON.parse(raw);
        return {...DEFAULTS, ...parsed};
    } catch {
        return {...DEFAULTS};
    }
};

const persistPreferences = (preferences) => {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
    } catch {}
};

export const PreferencesContext = createContext({});

export const PreferencesProvider = (props) => {
    const [preferences, setPreferences] = useState(loadPreferences);

    const updatePreferences = useCallback((partial) => {
        setPreferences(prev => {
            const next = {...prev, ...partial};
            persistPreferences(next);
            return next;
        });
    }, []);

    return (
        <PreferencesContext.Provider value={[preferences, updatePreferences]}>
            {props.children}
        </PreferencesContext.Provider>
    );
};
