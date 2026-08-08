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

/**
 * Pulls the IPv4 address out of a v6 form that embeds one, in any spelling.
 *
 * This is the whole reason the guard could be walked past. A URL never carries
 * the readable `::ffff:127.0.0.1`: WHATWG serialises it to the hex form
 * `::ffff:7f00:1`, so a strip of the literal text prefix left `7f00:1` - still
 * colon-bearing, routed to the v6 checks, matched nothing, declared safe. Both
 * `http://[::ffff:127.0.0.1]` and `http://[::ffff:169.254.169.254]` sailed
 * through, and dns.lookup hands the same string back so the post-resolve check
 * missed it too.
 *
 * @returns the dotted IPv4 address, or null when none is embedded
 */
const embeddedIpv4 = (address) => {
    const normalised = address.toLowerCase().split("%")[0];

    // ::ffff:a.b.c.d and the deprecated ::a.b.c.d compat form.
    const dotted = /^::(?:ffff:)?((?:\d{1,3}\.){3}\d{1,3})$/.exec(normalised);
    if (dotted) return dotted[1];

    // The hex spellings a URL actually produces. 64:ff9b::/96 is NAT64, which
    // embeds IPv4 the same way, and the bare `::` form is the deprecated
    // IPv4-compatible address - no current stack routes that one to the
    // embedded address, but recognising it costs nothing.
    const hex = /^(?:::ffff:|64:ff9b::|::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalised);
    if (!hex) return null;

    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);

    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
};

export const isBlockedAddress = (address) => {
    if (typeof address !== "string" || address === "") return false;

    const embedded = embeddedIpv4(address);
    if (embedded !== null) return isBlockedIpv4(embedded);

    return address.includes(":") ? isBlockedIpv6(address) : isBlockedIpv4(address);
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
