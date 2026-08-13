/**
 * The two ends of the daily quiet window, as the dialog handles them.
 *
 * The window is a pair of configuration values rather than one, which makes
 * three things go wrong quietly unless they are handled here: half a window
 * does nothing at all on the server, clearing one end leaves the other looking
 * like part of a setting, and the stored "switched off" sentinel is not a time
 * a time input can be handed.
 */

/** The sentinel the configuration stores for "no window", as everywhere else. */
export const QUIET_HOURS_OFF = "none";

export const CONFIG_KEYS = {start: "quietHoursStart", end: "quietHoursEnd"};

const TIME_OF_DAY = /^([0-9]{1,2}):([0-9]{2})$/;

/**
 * A stored value as a `<input type="time">` value.
 *
 * The sentinel and anything unparseable both become an empty field: the input
 * would otherwise be handed a string it cannot represent, and browsers differ
 * on whether that shows as blank or as the previous value.
 */
export const storedTimeToInput = (stored) => {
    const match = typeof stored === "string" ? TIME_OF_DAY.exec(stored.trim()) : null;
    if (!match) return "";

    const hours = Number(match[1]);
    const minutes = Number(match[2]);

    if (hours > 23 || minutes > 59) return "";

    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
};

/**
 * What is wrong with the window as it stands, or null.
 *
 * Both ends empty is a window switched off, which is fine. One end is not a
 * window - the server reads it as none - so saving it would report success for
 * a setting that never applies. Two ends on the same minute is a window of no
 * length, which the server also reads as off.
 *
 * @returns "start" | "end" | "same" | null
 */
export const windowProblem = (start, end) => {
    const from = storedTimeToInput(start);
    const until = storedTimeToInput(end);

    if (from === "" && until === "") return null;
    if (from === "") return "start";
    if (until === "") return "end";
    if (from === until) return "same";

    return null;
};

/**
 * The configuration writes that put this window into effect.
 *
 * Always both keys: clearing only the end would leave a start sitting in the
 * configuration, which reads as half a setting to anyone who looks at it later
 * and does nothing at all to the schedule.
 */
export const quietHoursUpdates = (start, end) => {
    const from = storedTimeToInput(start);
    const until = storedTimeToInput(end);
    const complete = from !== "" && until !== "" && from !== until;

    return [
        {key: CONFIG_KEYS.start, value: complete ? from : QUIET_HOURS_OFF},
        {key: CONFIG_KEYS.end, value: complete ? until : QUIET_HOURS_OFF}
    ];
};
