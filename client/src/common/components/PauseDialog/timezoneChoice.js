/**
 * The zones the timezone picker offers, and how a stored one reaches the select.
 *
 * The setting decides when the cron fires and which hours the quiet window
 * silences - upstream #1115 and #748 - so it belongs beside those hours rather
 * than in a settings page of its own.
 *
 * Its own module rather than lines inside PauseDialog.jsx, for the reason
 * quietHoursWindow.js is one: node cannot parse JSX, so anything living in the
 * component can only be asserted on as text.
 */

/** The sentinel the configuration stores for "the host's own clock". */
export const TIMEZONE_OFF = "none";

const isZoneName = (value) => typeof value === "string" && value !== "" && value !== TIMEZONE_OFF;

/**
 * Every zone this runtime knows.
 *
 * Asked of Intl rather than shipped as a table: there are some 400 of them, the
 * zone database moves, and a copy would be one more thing to keep current.
 *
 * `supportedValuesOf` is ES2022. Every browser this app supports has it, but a
 * missing one must cost the list rather than the dialog - so an empty answer
 * falls through to whatever the caller can add, which is at least the browser's
 * own zone and the one already stored.
 */
const knownZones = () => {
    try {
        return Intl.supportedValuesOf("timeZone");
    } catch {
        return [];
    }
};

/** What this browser believes it is in. */
export const browserTimezone = () => {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
    } catch {
        return "";
    }
};

/**
 * The list to render, with the stored zone in it whatever else is.
 *
 * `supportedValuesOf` answers canonical names only, and a stored value can be an
 * alias - "Europe/Kiev" for "Europe/Kyiv", "Asia/Calcutta" for "Asia/Kolkata".
 * A select whose value is absent from its own options renders as some other
 * option entirely, so without this the operator opens the dialog, is shown a
 * zone they never chose, and saves it by touching anything else in the form.
 */
export const timezoneOptions = (stored) => {
    const zones = new Set(knownZones());

    if (isZoneName(stored)) zones.add(stored);

    const own = browserTimezone();
    if (isZoneName(own)) zones.add(own);

    return [...zones].sort();
};

/**
 * The stored setting as the select's value.
 *
 * Absent means the same as the sentinel, and absent is not hypothetical:
 * /api/config withholds this key from an untrusted reader, so the dialog can be
 * holding a configuration with no timezone in it at all.
 */
export const storedTimezoneToInput = (stored) => isZoneName(stored) ? stored : TIMEZONE_OFF;
