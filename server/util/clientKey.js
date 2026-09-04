const IPV4_MAPPED_PREFIX = "::ffff:";

// A home IPv6 allocation is a /64 - 18 quintillion addresses, all one customer.
// Keying a limiter on the full address means picking a new one per request, so
// no counter ever reaches two. Truncating to the routing prefix counts the
// allocation, which is what the limits are actually about. Anything longer
// starts grouping unrelated customers together, so /64 is the conventional
// stopping point.
const IPV6_PREFIX_GROUPS = 4;

const UNKNOWN = "unknown";

/**
 * The identity every per-client limit is counted against.
 *
 * Shared by the request rate limiter and the failed-password throttle so the two
 * cannot disagree about who a caller is.
 */
export const clientKey = (req) => {
    const address = req?.ip ?? req?.socket?.remoteAddress;
    if (typeof address !== "string" || address === "") return UNKNOWN;

    return normaliseAddress(address);
};

export const normaliseAddress = (address) => {
    // Strip the zone id an IPv6 address can carry: fe80::1%eth0 and fe80::1 are
    // the same caller, and leaving it in would hand out a free extra bucket.
    const bare = address.split("%")[0].toLowerCase();

    // An IPv4-mapped address is an IPv4 client; counting ::ffff:203.0.113.5
    // separately from 203.0.113.5 gives the same caller two budgets.
    if (bare.startsWith(IPV4_MAPPED_PREFIX)) return bare.slice(IPV4_MAPPED_PREFIX.length);

    if (!bare.includes(":")) return bare;

    return ipv6Prefix(bare);
};

const IPV6_GROUPS = 8;

/**
 * The first four groups of an IPv6 address in one canonical spelling.
 *
 * Cut from the text as written, one /64 answered three keys - "2001:db8::",
 * "2001:0db8:0000:0000" and "2001:db8:0:0" - so a caller who reaches req.ip
 * through a trusted proxy and can spell the address held three throttle
 * budgets. Expanded to eight groups first, then each of the first four is
 * stripped of its leading zeros, so every spelling of a prefix is one key.
 */
const ipv6Prefix = (address) => {
    const [head, tail = ""] = address.split("::");
    const headGroups = head === "" ? [] : head.split(":");
    const tailGroups = tail === "" ? [] : tail.split(":");
    const elided = address.includes("::") ? Math.max(0, IPV6_GROUPS - headGroups.length - tailGroups.length) : 0;
    const groups = [...headGroups, ...Array(elided).fill("0"), ...tailGroups];

    return groups.slice(0, IPV6_PREFIX_GROUPS)
        .map((group) => group.replace(/^0+(?=.)/, ""))
        .join(":");
};
