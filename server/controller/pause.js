const MS_PER_HOUR = 3600000;

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
    updateTimer = setTimeout(() => updateState(false), hours * MS_PER_HOUR);

    return true;
}

export { currentStateVar as currentState };
