// Percentage of the configured optimum at which a measurement stops counting
// as good, then as acceptable. Latency is inverted: there, higher is worse.
const SPEED_GOOD = 75;
const SPEED_FAIR = 30;
const LATENCY_BAD = 180;
const LATENCY_FAIR = 130;

const FAILED_TEST = -1;

// Number("") and Number(null) are both 0, which would read as a genuine
// measurement of zero rather than as an absent one.
const isMissing = (value) => value === null || value === undefined || value === "";

export function getIconBySpeed(current, optional, higherIsBetter) {
    if (current === FAILED_TEST) return "error";
    if (isMissing(current) || isMissing(optional)) return "blue";

    const speed = Math.floor((Number(current) / Number(optional)) * 100);

    // Nothing has been measured yet. On a fresh install `current` is the "N/A"
    // placeholder, which makes this NaN - and NaN fails every comparison below,
    // so download and upload fell through to "red". The dashboard reported a bad
    // connection before a single test had run.
    if (!Number.isFinite(speed)) return "blue";

    if (higherIsBetter) {
        if (speed >= SPEED_GOOD) return "green";
        if (speed >= SPEED_FAIR) return "orange";
        return "red";
    }

    if (speed >= LATENCY_BAD) return "red";
    if (speed >= LATENCY_FAIR) return "orange";
    return "green";
}
