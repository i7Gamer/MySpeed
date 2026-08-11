import dns from 'node:dns/promises';
import dnsCallback from 'node:dns';

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

/**
 * An optional allowlist of hosts a node URL may point at.
 *
 * Unset - the default - leaves the guard as it was: anything except loopback
 * and link-local. Set, it turns "any URL an admin types" into "one of these",
 * which is what an instance reachable from outside the house wants. It narrows
 * the guard and never widens it: an allowlisted loopback address is still
 * refused unless ALLOW_LOCAL_NODES says otherwise.
 *
 * Entries are exact hosts, comma-separated, with an optional port:
 *
 *     ALLOWED_NODE_HOSTS=192.168.1.50,myspeed.example.net:5216,[fd00::1]
 *
 * A port pins the entry to that port; without one, any port on that host
 * matches. There are no wildcards - a pattern that quietly matches more than
 * the operator meant is exactly what this is here to prevent.
 */
let cachedRaw = null;
let cachedHosts = null;

/**
 * The port an entry actually names, or "" for none.
 *
 * Read off the text after the host, so a default port is kept rather than
 * normalised away: "[fd00::1]:80" and "192.168.1.50:80" both name one,
 * "[fd00::1]" does not. Only entries the URL parser already accepted reach
 * this, so what follows the colon is either empty or digits.
 *
 * Those digits still need the normalisation the parser would have applied, or
 * "080" would never match the ":80" it names - the same silent lockout this
 * helper exists to prevent, in the other direction.
 */
const declaredPort = (entry) => {
    const afterHost = entry.startsWith("[") ? entry.slice(entry.indexOf("]") + 1) : entry;
    const colon = afterHost.lastIndexOf(":");
    if (colon === -1) return "";

    const port = afterHost.slice(colon + 1);

    return port === "" ? "" : String(Number(port));
};

// Both sides of the comparison have to be explicit about the port, because the
// URL being checked drops its own when it is the protocol's default.
const DEFAULT_PORTS = {"http:": "80", "https:": "443"};

const effectivePort = (url) => url.port || DEFAULT_PORTS[url.protocol] || "";

const parseAllowedHosts = (raw) => {
    const entries = [];

    for (const part of raw.split(",")) {
        const entry = part.trim();
        if (entry === "") continue;

        try {
            // Parsed as a URL so brackets, ports and case are handled the same
            // way they are on the value being checked.
            const parsed = new URL(`http://${entry}`);
            if (parsed.hostname === "") throw new Error("no host");

            // The port comes from the entry's own text, not from the parser.
            // WHATWG strips a default port, and it was parsed as http - so
            // "host:80" arrived here with an empty port, which isAllowedHost
            // reads as the "any port" wildcard, silently discarding the pin.
            // "host:443" survived parsing but could never match, because
            // new URL("https://host:443").port is empty on the other side.
            entries.push({hostname: parsed.hostname, port: declaredPort(entry)});
        } catch {
            console.warn(`ALLOWED_NODE_HOSTS: ignoring "${entry}", which is not a host[:port]`);
        }
    }

    return entries;
};

const allowedHosts = () => {
    const raw = process.env.ALLOWED_NODE_HOSTS ?? "";

    if (raw !== cachedRaw) {
        cachedRaw = raw;
        cachedHosts = raw.trim() === "" ? null : parseAllowedHosts(raw);
    }

    return cachedHosts;
};

const isAllowedHost = (url) => {
    const allowed = allowedHosts();
    if (allowed === null) return true;

    // Every entry was unusable. Refusing everything is the safe reading of
    // "the operator meant to restrict this".
    if (allowed.length === 0) return false;

    return allowed.some((entry) =>
        entry.hostname === url.hostname && (entry.port === "" || entry.port === effectivePort(url)));
};

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

export class BlockedAddressError extends Error {
    constructor(hostname) {
        super(`${hostname} resolves to a loopback or link-local address`);
        this.name = "BlockedAddressError";
        this.code = "EBLOCKEDADDRESS";
    }
}

/**
 * A `lookup` for http.request that refuses to hand back a blocked address.
 *
 * This is what actually closes DNS rebinding. Checking a name and then handing
 * the *name* to the HTTP client means the client resolves it a second time, and
 * a record that changes in between is checked as one address and connected to
 * as another. Node calls this function from inside the connect path, so the
 * address it returns is the address the socket uses - there is no second
 * resolution to disagree with.
 *
 * The hostname still travels for SNI and certificate validation, so pinning the
 * address does not weaken TLS.
 */
export const safeLookup = (hostname, options, callback) => {
    if (process.env.ALLOW_LOCAL_NODES === "true") return dnsCallback.lookup(hostname, options, callback);

    dnsCallback.lookup(hostname, {...options, all: true}, (error, addresses) => {
        if (error) return callback(error);

        const allowed = addresses.filter((entry) => !isBlockedAddress(entry.address));
        if (allowed.length === 0) return callback(new BlockedAddressError(hostname));

        if (options.all) return callback(null, allowed);
        return callback(null, allowed[0].address, allowed[0].family);
    });
};

/**
 * Decides whether a node URL may be fetched.
 *
 * The hostname is resolved before the verdict, so a name that points at a
 * blocked address is refused too rather than only a literal one. This is the
 * check that produces a useful message for the operator adding a node; the
 * connection itself is pinned separately by safeLookup, which is what makes the
 * verdict impossible to outrun.
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

    // Checked before the local opt-out, so ALLOW_LOCAL_NODES cannot be used to
    // step around a list the operator set deliberately.
    if (!isAllowedHost(url))
        return {safe: false, reason: "This host is not in ALLOWED_NODE_HOSTS"};

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
