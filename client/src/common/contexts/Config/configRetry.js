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

/*
 * How long refusals are left alone after a session check found nothing to do.
 *
 * A lost session shows on the config load too, so one check settles it. A 401
 * the config load does not share is some route refusing for its own reasons,
 * and checking again on every refused poll would reload the config for as
 * long as the tab stays open.
 */
export const SESSION_RECOVERY_PAUSE_MS = 60000;

/** The wait before retry number `attempt`, counted from 0. */
export const configRetryDelay = (attempt) =>
    Math.min(CONFIG_RETRY_BASE_MS * CONFIG_RETRY_FACTOR ** attempt, CONFIG_RETRY_MAX_MS);
