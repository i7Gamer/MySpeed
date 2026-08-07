/**
 * Turns the TRUST_PROXY environment variable into the value Express expects.
 *
 * This has to be opt-in. Trusting X-Forwarded-For unconditionally would let any
 * caller spoof their own address and walk straight past the per-IP throttle;
 * never trusting it collapses every client behind a reverse proxy onto the
 * proxy's single address, so one attacker locks out everybody. Only the
 * operator knows which of the two applies.
 *
 * @returns the Express `trust proxy` setting, or undefined to leave it alone
 */
export const parseTrustProxy = (value) => {
    if (value === undefined || value === null || value.trim() === "") return undefined;

    const trimmed = value.trim();

    if (trimmed === "true") return true;
    if (trimmed === "false") return false;

    // A bare number is a hop count: "how many proxies sit in front of me".
    if (/^\d+$/.test(trimmed)) return Number(trimmed);

    // Anything else is handed over as-is: Express accepts presets such as
    // "loopback" and comma-separated address or subnet lists.
    return trimmed;
};
