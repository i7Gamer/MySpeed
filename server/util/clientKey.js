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

    if (!bare.includes(":")) return bare;

    return ipv6Prefix(bare);
};

const IPV6_GROUPS = 8;

// ::ffff:0:0/96 - the six groups in front of a mapped IPv4 address.
const IPV4_MAPPED_GROUPS = ["0", "0", "0", "0", "0", "ffff"];

const HEX = 16;
const OCTET = 256;

const stripZeros = (group) => group.replace(/^0+(?=.)/, "");

/**
 * The eight groups of an IPv6 address, each without leading zeros. A dotted
 * quad at the end - the mapped form the socket writes - stays one group and
 * stands for two.
 */
const expand = (address) => {
    const [head, tail = ""] = address.split("::");
    const headGroups = head === "" ? [] : head.split(":");
    const tailGroups = tail === "" ? [] : tail.split(":");
    const written = [...headGroups, ...tailGroups];
    const dotted = written.at(-1)?.includes(".") ? 1 : 0;
    const elided = address.includes("::") ? Math.max(0, IPV6_GROUPS - written.length - dotted) : 0;

    return [...headGroups, ...Array(elided).fill("0"), ...tailGroups]
        .map((group) => group.includes(".") ? group : stripZeros(group));
};

/** The IPv4 address the last two groups of a mapped address spell. */
const dottedQuad = (groups) => {
    if (groups.length === 1) return groups[0];

    const value = parseInt(groups[0], HEX) * OCTET * OCTET + parseInt(groups[1], HEX);

    return [Math.floor(value / OCTET ** 3), Math.floor(value / OCTET ** 2) % OCTET,
        Math.floor(value / OCTET) % OCTET, value % OCTET].join(".");
};

/**
 * The first four groups of an IPv6 address in one canonical spelling.
 *
 * Cut from the text as written, one /64 answered three keys - "2001:db8::",
 * "2001:0db8:0000:0000" and "2001:db8:0:0" - so a caller who reaches req.ip
 * through a trusted proxy and can spell the address held three throttle
 * budgets. Expanded to eight groups first, then each of the first four is
 * stripped of its leading zeros, so every spelling of a prefix is one key.
 *
 * Two families are read after the expansion rather than off the text. An
 * IPv4-mapped address is an IPv4 client - counting ::ffff:203.0.113.5
 * separately from 203.0.113.5 gives the same caller two budgets - and a
 * literal "::ffff:" test caught only the socket's spelling of it: the
 * hexadecimal tail and the fully written form were two more keys. And an
 * address inside ::/64 - loopback above all - is keyed whole: there is no
 * customer allocation there, and cut to the prefix "::1" shared a bucket
 * with every fully written mapped address.
 */
const ipv6Prefix = (address) => {
    const groups = expand(address);

    if (IPV4_MAPPED_GROUPS.every((group, index) => groups[index] === group))
        return dottedQuad(groups.slice(IPV4_MAPPED_GROUPS.length));

    const prefix = groups.slice(0, IPV6_PREFIX_GROUPS);
    if (prefix.every((group) => group === "0")) return groups.join(":");

    return prefix.join(":");
};
