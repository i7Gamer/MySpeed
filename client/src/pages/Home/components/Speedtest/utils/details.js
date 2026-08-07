/**
 * The numbers the expanded test row shows beyond the raw measurement.
 *
 * Both are derived from data the list endpoint already returns, so the detail
 * view costs no extra request and works on every historic row.
 */
const PERCENT = 100;
const CHANGE_DECIMALS = 2;

// Written by the failure path in place of a real measurement. Comparing against
// it produces confident nonsense, so every helper here refuses it.
const FAILED_TEST = -1;

const isUsable = (value) =>
    typeof value === "number" && Number.isFinite(value) && value !== FAILED_TEST;

// Number("") and Number(null) are both 0, which would read as a configured
// target of zero rather than as an absent one.
const asTarget = (value) => {
    if (value === null || value === undefined || value === "") return null;

    const target = Number(value);
    return Number.isFinite(target) && target > 0 ? target : null;
};

/**
 * How the measurement compares with the optimum configured in the settings.
 *
 * getIconBySpeed already computes this ratio and then throws the number away in
 * favour of a three-bucket colour; the reader never sees how close they got.
 *
 * @returns a whole percentage, or null when there is nothing to compare against
 */
export const percentOfTarget = (current, target) => {
    const optimum = asTarget(target);
    if (optimum === null || !isUsable(current)) return null;

    return Math.round((current / optimum) * PERCENT);
};

/**
 * The change against the test before this one.
 *
 * @returns {{difference: number, direction: "up"|"down"|"same"}|null}
 */
export const changeFrom = (current, previous) => {
    if (!isUsable(current) || !isUsable(previous)) return null;

    const difference = parseFloat((current - previous).toFixed(CHANGE_DECIMALS));

    if (difference === 0) return {difference, direction: "same"};
    return {difference, direction: difference > 0 ? "up" : "down"};
};
