import dns from 'node:dns/promises';

/**
 * Guards the one place the server fetches a URL the user typed: adding a remote
 * node.
 *
 * Deliberately narrow. Connecting MySpeed instances across a home LAN is the
 * whole point of the feature, so blocking RFC1918 would break the normal case
 * for almost everyone - and the endpoint requires an authenticated admin
 * anyway. What is blocked is what can never be a legitimate node: the machine's
 * own loopback, the link-local range that carries cloud metadata services, and
 * anything that is not plain HTTP.
 */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

const IPV4_MAPPED_PREFIX = "::ffff:";

const octets = (address) => address.split(".").map(Number);

const isBlockedIpv4 = (address) => {
    const parts = octets(address);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;

    const [first, second] = parts;

    if (first === 127) return true;                    // loopback
    if (first === 0) return true;                      // "this host on this network"
    return first === 169 && second === 254;            // link-local, incl. 169.254.169.254
};

const isBlockedIpv6 = (address) => {
    const normalised = address.toLowerCase().split("%")[0];

    if (normalised === "::1" || normalised === "::") return true;

    // fe80::/10 - link-local. The second nibble of the second byte only has to
    // fall in 8..b for the prefix to match.
    return /^fe[89ab]/.test(normalised);
};

export const isBlockedAddress = (address) => {
    if (typeof address !== "string" || address === "") return false;

    const bare = address.startsWith(IPV4_MAPPED_PREFIX) ? address.slice(IPV4_MAPPED_PREFIX.length) : address;

    return bare.includes(":") ? isBlockedIpv6(bare) : isBlockedIpv4(bare);
};

/**
 * Decides whether a node URL may be fetched.
 *
 * The hostname is resolved before the verdict, so a name that points at a
 * blocked address is refused too rather than only a literal one.
 *
 * @returns {Promise<{safe: true}|{safe: false, reason: string}>}
 */
export const checkNodeTarget = async (value) => {
    let url;
    try {
        url = new URL(value);
    } catch {
        return {safe: false, reason: "The node URL is not a valid URL"};
    }

    if (!ALLOWED_PROTOCOLS.has(url.protocol))
        return {safe: false, reason: "A node URL has to use http or https"};

    if (process.env.ALLOW_LOCAL_NODES === "true") return {safe: true};

    // Strips the brackets an IPv6 literal carries in a URL.
    const hostname = url.hostname.replace(/^\[|]$/g, "");

    if (isBlockedAddress(hostname))
        return {safe: false, reason: "A node cannot point at a loopback or link-local address"};

    let resolved;
    try {
        resolved = await dns.lookup(hostname, {all: true});
    } catch {
        return {safe: false, reason: "The node URL could not be resolved"};
    }

    if (resolved.some((entry) => isBlockedAddress(entry.address)))
        return {safe: false, reason: "A node cannot point at a loopback or link-local address"};

    return {safe: true};
};
