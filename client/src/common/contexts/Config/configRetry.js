/*
 * How often a config load that could not reach the server is tried again.
 *
 * The first wait is short because the common cause is a restart, which is over
 * in seconds; it doubles from there so a server that is down for longer is not
 * asked several times a second by every tab left open on it, and stops growing
 * at the cap so the page still notices within half a minute once it is back.
 */
export const CONFIG_RETRY_BASE_MS = 2000;
export const CONFIG_RETRY_MAX_MS = 30000;
const CONFIG_RETRY_FACTOR = 2;

/** The wait before retry number `attempt`, counted from 0. */
export const configRetryDelay = (attempt) =>
    Math.min(CONFIG_RETRY_BASE_MS * CONFIG_RETRY_FACTOR ** attempt, CONFIG_RETRY_MAX_MS);
