import React, {createContext, useCallback, useEffect, useMemo, useState} from "react";
import {DEFAULT_TIMEFRAME} from "@/common/utils/TimeframeUtil";
import {
    GRADE_VALUES_ATTRIBUTE, GRADE_VALUES_OFF, GRADE_VALUES_ON, TIME_FORMAT_24H, SPEED_UNIT_MBPS
} from "./constants";
import {readStored, writeStored} from "@/common/utils/Storage";

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

/**
 * What was actually chosen, which is all the store holds.
 *
 * The defaults used to be merged in here and written back out on the next
 * save, so every preference the reader had never touched was stamped into the
 * store the first time they saved any other one. `defaultTimeframe` is the one
 * that hurt: no control in this dialog writes it - the statistics toolbar does,
 * when a range is picked - so saving a clock format recorded a default range
 * nobody had chosen, frozen at whatever DEFAULT_TIMEFRAME was that release and
 * afterwards indistinguishable from a range somebody meant.
 *
 * Absent and "set to the current default" are different answers, and only the
 * first of them can follow a default that later moves.
 */
const loadStored = () => {
    try {
        const raw = readStored(STORAGE_KEY);
        if (!raw) return {};

        // A store holding "null", a number or an array is a store somebody else
        // wrote; the defaults answer for all of it.
        const parsed = JSON.parse(raw);
        return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
};

const persistPreferences = (preferences) => {
    try {
        writeStored(STORAGE_KEY, JSON.stringify(preferences));
    } catch {
        // Full, or blocked entirely in a private window. A preference that
        // cannot be written down is not worth failing a render over - it simply
        // lasts as long as the tab does.
    }
};

export const PreferencesContext = createContext({});

export const PreferencesProvider = (props) => {
    const [chosen, setChosen] = useState(loadStored);

    // The defaults fill the gaps for every reader of this context, so nothing
    // downstream can tell a preference that was chosen from one that was not -
    // and nothing downstream should. Only the store keeps them apart.
    const preferences = useMemo(() => ({...DEFAULTS, ...chosen}), [chosen]);

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

    // Written onto what was chosen before, never onto the merged object: a
    // save records the fields it names and leaves every other preference where
    // the reader left it, unset ones included.
    const updatePreferences = useCallback((partial) => {
        setChosen(prev => {
            const next = {...prev, ...partial};
            persistPreferences(next);
            return next;
        });
    }, []);

    // One identity per change, the way AlertContext hands its value out: the
    // providers nest, and an inline array re-rendered every consumer whenever
    // a parent re-rendered, to show what was already on screen.
    const contextValue = useMemo(() => [preferences, updatePreferences],
        [preferences, updatePreferences]);

    return (
        <PreferencesContext.Provider value={contextValue}>
            {props.children}
        </PreferencesContext.Provider>
    );
};
