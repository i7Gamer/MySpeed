const MS_PER_HOUR = 3600000;

// setTimeout stores its delay in a signed 32-bit int. Anything larger silently
// overflows and fires on the next tick, so a long pause ended immediately.
const MAX_TIMEOUT_MS = 2147483647;

let currentStateVar = false;
let updateTimer = null;

const clearTimer = () => {
    if (updateTimer === null) return;

    clearTimeout(updateTimer);
    updateTimer = null;
};

// Every state change drops the pending timer. Without this a /continue leaves
// the old timeout armed, which later flips the state back to running in the
// middle of a fresh pause.
export const updateState = (newState) => {
    clearTimer();
    currentStateVar = newState;
}

/** What pauseIntent answers for "until I say otherwise". */
export const PAUSE_INDEFINITE = "indefinite";

/**
 * What a pause request meant: a number of hours, PAUSE_INDEFINITE, or null when
 * it meant nothing usable.
 *
 * The route held `[0, -1]` and matched it with Array.includes, which compares
 * strictly - so a client sending the string "0" missed the indefinite branch
 * entirely and fell through to resumeIn("0"), which reads 0 as "no duration"
 * and answers 400. Both spellings are ordinary: 0 is what the pause dialog
 * sends by default and -1 is what older clients send, and JSON is not the only
 * way a body reaches here.
 *
 * Any other negative stays a rejection - -1 is grandfathered, -5 is a mistake.
 */
export const pauseIntent = (resumeIn) => {
    if (resumeIn === undefined || resumeIn === null || resumeIn === "") return null;
    if (typeof resumeIn === "object") return null;

    const value = Number(resumeIn);
    if (!Number.isFinite(value)) return null;

    if (value === 0 || value === -1) return PAUSE_INDEFINITE;

    return value > 0 ? value : null;
};

export const resumeIn = (hours) => {
    // A digits-only test rejected every fractional value, including the 0.5
    // steps the pause dialog's own input offers - and postRequest does not
    // check the status, so the dialog reported those pauses as applied.
    const value = Number(hours);
    if (!Number.isFinite(value) || value <= 0) return false;

    updateState(true);

    // Beyond the cap the pause simply stays on until it is lifted by hand,
    // which is what someone asking for a 25-day pause meant anyway.
    const delay = Math.min(value * MS_PER_HOUR, MAX_TIMEOUT_MS);
    if (delay < MAX_TIMEOUT_MS) updateTimer = setTimeout(() => updateState(false), delay);

    return true;
}

export { currentStateVar as currentState };
