/**
 * How long the schedule waits after a provider has answered "too many
 * requests".
 *
 * Upstream #846 and #1092. A refusal used to be thrown like any other failure,
 * which meant two requests where the limiter had just asked for none: the catch
 * in tasks/speedtest.js retried the run on the spot, and the next tick of the
 * cron asked again a minute later. On the minutely schedule the installer
 * scripts hand out, that is one refused request per minute, one failed row per
 * minute, and one alert per minute to every notifier - for as long as the limit
 * stands, which is the better part of an hour.
 *
 * Waiting is the only thing that ends a rate limit, so the schedule waits.
 *
 * Held in memory rather than in the configuration. The state is worth minutes,
 * not restarts, and a stored one would need a key, a migration and a decision
 * about what a stale hold from last week means. A restart is also no longer part
 * of this loop: the crash that used to end the process on a refusal is fixed, so
 * nothing bounces the server while it is being refused.
 */

const MS_PER_MINUTE = 60_000;

/**
 * The first wait, and the step each consecutive refusal doubles.
 *
 * Long enough to be a real pause on any schedule - the tightest cron a five
 * field expression can express is a minute - and short enough that a limit which
 * has already lifted is not waited out for nothing.
 */
export const FIRST_BACKOFF_MS = 15 * MS_PER_MINUTE;

/**
 * The longest the schedule is ever held.
 *
 * Doubling without a cap turns an afternoon of refusals into a day of silence,
 * and the operator watching a graph has no way to tell that apart from an
 * instance that has stopped working.
 */
export const MAX_BACKOFF_MS = 120 * MS_PER_MINUTE;

/**
 * Per provider, because the limiter is the provider's rather than ours.
 *
 * Switching away from a provider that is refusing is exactly what somebody does
 * about it - it is what two of the upstream reports did - and a single shared
 * hold would have gone on silencing the schedule after the fix, for up to the
 * cap, with nothing on screen saying why.
 *
 * Keyed by the setting's own spelling ("ookla", "libre", "cloudflare"), so
 * nothing has to translate between the name a run reports and the name a hold
 * was recorded under. Three keys at most, so nothing prunes it.
 */
const holds = new Map();

/**
 * Records a refusal and answers how long the schedule is now held.
 *
 * The escalation carries across the gap between two refusals rather than
 * restarting: the wait that just elapsed without the limit lifting is evidence
 * that the next one should be longer. Only a test that actually got through
 * clears it, which is what clearBackoff is for.
 */
export const recordRateLimit = (provider, now = Date.now()) => {
    if (!provider) return 0;

    const previous = holds.get(provider)?.wait ?? 0;
    const wait = previous === 0 ? FIRST_BACKOFF_MS : Math.min(previous * 2, MAX_BACKOFF_MS);

    holds.set(provider, {wait, until: now + wait});

    return wait;
};

/**
 * What a completed test says: this provider is answering again.
 *
 * The whole entry goes, not just the deadline, so the next refusal starts at the
 * first wait instead of resuming an escalation that a working connection has
 * already disproved.
 */
export const clearBackoff = (provider) => {
    holds.delete(provider);
};

/** Every hold, for the tests that walk the escalation from a known start. */
export const forgetAllBackoff = () => {
    holds.clear();
};

/**
 * How much of the hold is left, or 0 when there is none.
 *
 * Never negative: an elapsed hold is no hold, and a caller that logged the
 * remainder would otherwise report a negative wait.
 */
export const backoffRemainingMs = (provider, now = Date.now()) => {
    const until = holds.get(provider)?.until;

    if (until === undefined) return 0;

    return Math.max(0, until - now);
};

export const isBackingOff = (provider, now = Date.now()) => backoffRemainingMs(provider, now) > 0;
