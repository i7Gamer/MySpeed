import crypto from 'node:crypto';

/**
 * The one-time credential that stands in for a password on an instance that has
 * none.
 *
 * MySpeed used to wave every request through while `password` held the
 * "none" sentinel, which made a fresh install on a routable address a fully
 * unauthenticated admin API. Refusing to serve at all instead would make the
 * common Docker first run impossible: the operator's browser is not on the
 * container's loopback, so there would be no way to set the first password.
 *
 * A token generated per boot and printed to the log resolves both: the operator
 * reads it out of `docker logs` and types it into the password prompt the client
 * already shows on a 401, then sets a real password from the UI. It is
 * deliberately not persisted - a restart issues a new one, and nothing on disk
 * can leak it.
 */
const TOKEN_BYTES = 24;

let token = null;
let announced = false;

export const getSetupToken = () => {
    if (token === null) token = crypto.randomBytes(TOKEN_BYTES).toString("hex");
    return token;
};

/** Drops the current token so the next call issues a fresh one. For tests. */
export const resetSetupToken = () => {
    token = null;
    announced = false;
};

/**
 * Prints the token, once.
 *
 * It used to be printed only by the startup banner, and only when the instance
 * booted with no password. An operator who removed the password on a running
 * instance therefore locked out every remote client: they were told to use a
 * setup token that had never been issued, and only a restart would print one.
 * Announcing on demand means the token exists whenever something is actually
 * being refused for want of it.
 */
export const announceSetupToken = () => {
    if (announced || process.env.PREVIEW_MODE === "true") return;
    announced = true;

    console.log("");
    console.log("  No password is configured. Requests from other machines need this");
    console.log("  one-time setup token - enter it when the interface asks for a password,");
    console.log("  then set a real password from the settings menu.");
    console.log("");
    console.log(`      Setup token: ${getSetupToken()}`);
    console.log("");
    console.log("  A new token is issued every restart. Set ALLOW_NO_PASSWORD=true to run");
    console.log("  without one, only on a network you trust.");
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
