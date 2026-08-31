/**
 * The digest opt-in, in the one home every reader can actually import.
 *
 * The controller cannot be that home for the integration modules: it imports
 * the generated index that imports every module, so a module importing the
 * controller back evaluates the index while its own default export is still
 * in temporal-dead-zone - the suites load modules directly and die on the
 * ReferenceError before a single assertion runs. A leaf module with no
 * imports of its own is what breaks the cycle, and the controller re-exports
 * from here so its callers keep one name.
 */
export const DIGEST_WEEKLY_FIELD = "digest_weekly";
export const DIGEST_MONTHLY_FIELD = "digest_monthly";

/**
 * Whether one integration's stored settings ask for this digest. Truthiness,
 * the way every module reads its own send_* flags - a row from before the
 * fields existed has no key, which reads falsy, so nobody is opted in by an
 * upgrade.
 */
export const wantsDigest = (data, kind) =>
    Boolean(data?.[kind === "weekly" ? DIGEST_WEEKLY_FIELD : DIGEST_MONTHLY_FIELD]);
