/**
 * The stored preference values.
 *
 * Kept apart from the provider so a plain utility can read them without pulling
 * a React component - and its whole JSX dependency - along with it. FormatUtil
 * needed exactly that, which is why it had no tests.
 */
export const TIME_FORMAT_24H = "24h";
export const TIME_FORMAT_12H = "12h";

export const SPEED_UNIT_MBPS = "mbps";
export const SPEED_UNIT_MBYTES = "mbytes";
