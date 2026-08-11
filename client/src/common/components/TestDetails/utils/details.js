/**
 * The numbers a test's detail pane shows beyond the raw measurement.
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
 * How well the measurement meets the optimum configured in the settings, as a
 * percentage where more is always better.
 *
 * getIconBySpeed already computes this ratio and then throws the number away in
 * favour of a three-bucket colour; the reader never sees how close they got.
 *
 * The ratio is inverted for latency. Reporting ping the same way as throughput
 * gave "120% of your target" a full green bar for a connection 20% *over* its
 * latency budget - the number was right and everything around it read as
 * "target beaten".
 *
 * @returns a whole percentage, or null when there is nothing to compare against
 */
export const percentOfTarget = (current, target, {higherIsBetter = true} = {}) => {
    const optimum = asTarget(target);
    if (optimum === null || !isUsable(current)) return null;

    if (higherIsBetter) return Math.round((current / optimum) * PERCENT);

    // A latency of zero is not a measurement, and dividing by it is worse.
    if (current <= 0) return null;

    return Math.round((optimum / current) * PERCENT);
};

/**
 * The distance from the configured optimum, in the metric's own unit.
 *
 * Used where a percentage is ambiguous: "4 ms over your target" says in one
 * phrase what a latency ratio needs a paragraph to explain.
 *
 * @returns {{difference: number, direction: "over"|"under"|"same"}|null}
 */
export const differenceFromTarget = (current, target) => {
    const optimum = asTarget(target);
    if (optimum === null || !isUsable(current)) return null;

    const difference = parseFloat((current - optimum).toFixed(CHANGE_DECIMALS));
    if (difference === 0) return {difference, direction: "same"};

    return {difference: Math.abs(difference), direction: difference > 0 ? "over" : "under"};
};

/**
 * What each provider is called, in its own spelling.
 *
 * Proper nouns, so they are not translated - only the label beside them is.
 */
const PROVIDER_NAMES = {ookla: "Ookla", libre: "LibreSpeed", cloudflare: "Cloudflare"};

/**
 * The name of the provider that measured a test, or null if the row cannot say.
 *
 * Null rather than a fallback: every test recorded before the column existed
 * carries nothing, and naming whichever provider happens to be configured today
 * would dress a guess up as a record - which is the opposite of what the column
 * was added for.
 *
 * hasOwn rather than a plain lookup: the stored value is whatever reached the
 * column, and "constructor" would otherwise resolve off the prototype and put a
 * function where the pane expects a provider's name.
 *
 * @returns {string|null}
 */
export const providerName = (provider) =>
    Object.hasOwn(PROVIDER_NAMES, provider) ? PROVIDER_NAMES[provider] : null;

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
