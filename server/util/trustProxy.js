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
const SINGLE_PROXY = 1;

export const parseTrustProxy = (value) => {
    if (value === undefined || value === null || value.trim() === "") return undefined;

    const trimmed = value.trim();

    // "true" is Express's trust-all mode, where req.ip becomes the *leftmost*
    // X-Forwarded-For entry - a value the caller writes. Every per-IP control
    // here keys on req.ip, so honouring it would let anyone forge their way
    // past the throttles by adding a header. It is read as the overwhelmingly
    // common intent instead: one proxy in front.
    if (trimmed === "true") {
        console.warn("TRUST_PROXY=true would let any caller forge their own address; treating it as 1 (a single proxy). " +
            "Set the number of proxies in front of MySpeed, or a subnet, to be explicit.");
        return SINGLE_PROXY;
    }

    if (trimmed === "false") return false;

    // A bare number is a hop count: "how many proxies sit in front of me".
    if (/^\d+$/.test(trimmed)) return Number(trimmed);

    // Anything else is handed over as-is: Express accepts presets such as
    // "loopback" and comma-separated address or subnet lists.
    return trimmed;
};

/**
 * Whether the operator has told us a reverse proxy sits in front.
 *
 * Distinct from "is the variable set": TRUST_PROXY=false and TRUST_PROXY=0 are
 * both settings that mean *no* proxy resolution. The loopback gate has to know
 * the effective answer, because testing the variable's mere presence made it
 * fail open on exactly those two values.
 */
export const trustsProxy = (value = process.env.TRUST_PROXY) => {
    const setting = parseTrustProxy(value);
    return setting !== undefined && setting !== false && setting !== 0;
};
