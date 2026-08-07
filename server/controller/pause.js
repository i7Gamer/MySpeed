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

export const resumeIn = (hours) => {
    if (/[^0-9]/.test(hours)) return false;

    updateState(true);

    // Beyond the cap the pause simply stays on until it is lifted by hand,
    // which is what someone asking for a 25-day pause meant anyway.
    const delay = Math.min(hours * MS_PER_HOUR, MAX_TIMEOUT_MS);
    if (delay < MAX_TIMEOUT_MS) updateTimer = setTimeout(() => updateState(false), delay);

    return true;
}

export { currentStateVar as currentState };
