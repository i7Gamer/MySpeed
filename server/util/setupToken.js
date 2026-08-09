import crypto from 'node:crypto';

/**
 * The credential that stands in for a password on an instance that has none.
 *
 * MySpeed used to wave every request through while `password` held the
 * "none" sentinel, which made a fresh install on a routable address a fully
 * unauthenticated admin API. Refusing to serve at all instead would make the
 * common Docker first run impossible: the operator's browser is not on the
 * container's loopback, so there would be no way to set the first password.
 *
 * A token generated per boot and printed to the log resolves both: the operator
 * reads it out of `docker logs` and types it into the prompt the client shows
 * on a 401, then sets a real password from the UI. It lives only in memory and
 * holds for the whole process lifetime - reusable after a typo, replaced by a
 * restart. The announcement is the one copy that leaves the process: both
 * supported deployments write stdout to a log file, which is exactly where a
 * locked-out operator is sent to look for it.
 */
const TOKEN_BYTES = 24;

/**
 * How long the banner stays quiet after printing.
 *
 * It used to print at most once per process, which made a lost log line
 * unrecoverable: the only way to see the token again was a restart, which
 * mints a different one. Reprinting has to be bounded, though - the banner is
 * reachable by any unauthenticated caller a 401 turns away, and an unbounded
 * reprint would be a way to fill the log from outside. Ten minutes keeps a
 * reload useful to the operator and useless as a firehose.
 */
export const ANNOUNCE_COOLDOWN_MS = 10 * 60 * 1000;

let token = null;
let announcedAt = 0;

export const getSetupToken = () => {
    if (token === null) token = crypto.randomBytes(TOKEN_BYTES).toString("hex");
    return token;
};

/** Drops the current token so the next call issues a fresh one. For tests. */
export const resetSetupToken = () => {
    token = null;
    announcedAt = 0;
};

/**
 * Prints the token, at most once per cooldown window.
 *
 * It used to be printed only by the startup banner, and only when the instance
 * booted with no password. An operator who removed the password on a running
 * instance therefore locked out every remote client: they were told to use a
 * setup token that had never been issued, and only a restart would print one.
 * Announcing on demand means the token exists whenever something is actually
 * being refused for want of it, and the cooldown means losing the log line
 * costs a reload, not a restart.
 *
 * `now` is injectable so the cooldown is testable; callers pass nothing.
 */
export const announceSetupToken = (now = Date.now()) => {
    if (process.env.PREVIEW_MODE === "true") return;
    if (now - announcedAt < ANNOUNCE_COOLDOWN_MS) return;
    announcedAt = now;

    console.log("");
    console.log("  No password is configured. Requests from other machines need this");
    console.log("  setup token - enter it when the interface asks for it, then set a");
    console.log("  real password from the settings menu.");
    console.log("");
    console.log(`      Setup token: ${getSetupToken()}`);
    console.log("");
    console.log("  The token holds until the next restart, which issues a new one. Set");
    console.log("  ALLOW_NO_PASSWORD=true to run without one, only on a network you trust.");
    console.log("");
};

/**
 * Constant-time comparison against the active token.
 *
 * timingSafeEqual throws on a length mismatch, so the lengths are compared
 * first - that leaks only the length of a value the log already prints in full.
 */
export const matchesSetupToken = (candidate) => {
    if (typeof candidate !== "string" || candidate.length === 0) return false;

    const expected = Buffer.from(getSetupToken(), "utf8");
    const supplied = Buffer.from(candidate, "utf8");

    if (expected.length !== supplied.length) return false;
    return crypto.timingSafeEqual(expected, supplied);
};
