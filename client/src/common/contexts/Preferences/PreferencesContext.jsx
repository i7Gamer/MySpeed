import React, {createContext, useCallback, useEffect, useState} from "react";
import {DEFAULT_TIMEFRAME} from "@/common/utils/TimeframeUtil";
import {
    GRADE_VALUES_ATTRIBUTE, GRADE_VALUES_OFF, GRADE_VALUES_ON, TIME_FORMAT_24H, SPEED_UNIT_MBPS
} from "./constants";

// Re-exported so every existing import of this module keeps working. The values
// themselves live in a plain module, which lets a utility read them without
// pulling React in behind them.
export {
    TIME_FORMAT_24H, TIME_FORMAT_12H, SPEED_UNIT_MBPS, SPEED_UNIT_MBYTES,
    GRADE_VALUES_ATTRIBUTE, GRADE_VALUES_ON, GRADE_VALUES_OFF
} from "./constants";

const STORAGE_KEY = "preferences";

const DEFAULTS = {
    timeFormat: TIME_FORMAT_24H,
    speedUnit: SPEED_UNIT_MBPS,
    defaultTimeframe: DEFAULT_TIMEFRAME,
    // Off by default: the extra resolution costs a second request and is only
    // worth it when the reader is chasing something specific.
    fullChartDetail: false,
    // Off by default: the glyph is what carries a verdict everywhere in this
    // interface, so a figure that is itself coloured states the grade twice.
    // On, every graded value in every view follows its own icon.
    gradeValues: false
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
    } catch {
        // Full, or blocked entirely in a private window. A preference that
        // cannot be written down is not worth failing a render over - it simply
        // lasts as long as the tab does.
    }
};

export const PreferencesContext = createContext({});

export const PreferencesProvider = (props) => {
    const [preferences, setPreferences] = useState(loadPreferences);

    /**
     * The one preference the stylesheets read for themselves.
     *
     * Stamped on the document the way the theme is, and for the same reason: it
     * answers for every view at once, and threading it through four component
     * trees to reach a colour would be four chances for one of them to be
     * missed. See the graded-value mixin for what reads it.
     */
    useEffect(() => {
        document.documentElement.setAttribute(GRADE_VALUES_ATTRIBUTE,
            preferences.gradeValues ? GRADE_VALUES_ON : GRADE_VALUES_OFF);
    }, [preferences.gradeValues]);

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
