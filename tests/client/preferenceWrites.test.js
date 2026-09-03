import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { useContext } from "react";
import { act, cleanup, click, createElement, render, window } from "../helpers/renderHarness.js";
import { AlertProvider } from "@/common/contexts/Alert";
import { PreferencesContext, PreferencesProvider, TIME_FORMAT_12H } from "@/common/contexts/Preferences";
import { ThemeContext } from "@/common/contexts/Theme";
import { ToastNotificationContext } from "@/common/contexts/ToastNotification";
import PreferencesDialog from "@/common/components/PreferencesDialog";
import { DEFAULT_TIMEFRAME } from "@/common/utils/TimeframeUtil.js";

/**
 * What saving the preferences writes down, and what it deliberately leaves
 * alone.
 *
 * `defaultTimeframe` is not a field of this dialog: it is written by the
 * statistics page, when the reader picks a range from the toolbar. But the
 * store held one object, and every save wrote the whole of it - the merged
 * object, defaults filled in - so pressing Save on an unrelated preference
 * stamped a default range into the store for a reader who had never chosen
 * one. Frozen there, at whatever DEFAULT_TIMEFRAME happened to be that
 * release, and indistinguishable afterwards from a range somebody picked.
 *
 * The store holds what was chosen now, and DEFAULTS fill the rest at read
 * time - so a preference nobody set has no stored value, and no save can
 * invent one. The same shape as the password dialog only writing the access
 * level when it changed; see dialogOpenSync.test.js.
 */
afterEach(cleanup);

const noop = () => undefined;

const STORAGE_KEY = "preferences";

// A default range this reader really did choose, and one that is not what
// DEFAULTS would have filled in - "7d" is DEFAULT_TIMEFRAME, so a clobber
// with it would be invisible.
const CHOSEN_RANGE = "30d";

const stored = () => JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");

const storeAlready = (preferences) =>
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));

const nest = (child, ...layers) =>
    layers.reduceRight((inner, [Provider, value]) => createElement(Provider, {value}, inner), child);

// The page's own write, reached through the context the toolbar's range
// control writes through - see handleTimeframeChange on the statistics page.
const controls = {};
const Driver = () => {
    const [preferences, updatePreferences] = useContext(PreferencesContext);

    controls.update = updatePreferences;
    controls.preferences = preferences;

    return null;
};

const mount = () => render(createElement(PreferencesProvider, null,
    nest(createElement(AlertProvider, null,
        createElement("div", null,
            createElement(Driver),
            createElement(PreferencesDialog, {open: true, onClose: noop}))),
    [ThemeContext.Provider,
        {theme: "dark", palette: "slate", setTheme: noop, setPalette: noop, systemDark: false}],
    [ToastNotificationContext.Provider, noop])));

const optionNamed = (label) => [...window.document.body.querySelectorAll(".segmented-option")]
    .find((option) => option.textContent.trim() === label);

const saveButton = () => [...window.document.body.querySelectorAll("button")]
    .find((button) => button.textContent.trim() === "Save");

/** Changes one preference that has nothing to do with the range, and saves. */
const saveAnUnrelatedPreference = () => {
    const option = optionNamed("12-hour");
    assert.ok(option, "the dialog offers no clock format to change");
    click(option);

    const save = saveButton();
    assert.ok(save, "the dialog has no save button");
    click(save);
};

describe("saving the preferences", () => {
    it("leaves a default range the reader chose exactly as it was", () => {
        storeAlready({defaultTimeframe: CHOSEN_RANGE});
        mount();

        saveAnUnrelatedPreference();

        assert.equal(stored().timeFormat, TIME_FORMAT_12H, "the change the reader made was not written");
        assert.equal(stored().defaultTimeframe, CHOSEN_RANGE,
            "saving a clock format rewrote which range the statistics open on");
    });

    /**
     * And an unset one stays unset, which is the case the whole-object write
     * could not express: absent means "whatever this release opens on", and a
     * stored "7d" means "this reader asked for a week" - two different things
     * that a save silently turned into one.
     */
    it("invents no default range for a reader who has never chosen one", () => {
        mount();

        saveAnUnrelatedPreference();

        assert.equal(Object.hasOwn(stored(), "defaultTimeframe"), false,
            "an unrelated save wrote down a default range nobody picked");
        assert.equal(controls.preferences.defaultTimeframe, DEFAULT_TIMEFRAME,
            "the page is left without a range to open on");
    });

    // The other half: the write that IS the reader choosing a range still
    // reaches the store, and a later save does not undo it.
    it("still records the range the reader picks on the page", () => {
        mount();

        act(() => controls.update({defaultTimeframe: CHOSEN_RANGE}));
        assert.equal(stored().defaultTimeframe, CHOSEN_RANGE,
            "choosing a range no longer remembers it");

        saveAnUnrelatedPreference();
        assert.equal(stored().defaultTimeframe, CHOSEN_RANGE,
            "the save dropped the range the reader had just chosen");
    });
});
