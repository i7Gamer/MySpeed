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

const octets = (address) => address.split(".").map(Number);

const isBlockedIpv4 = (address) => {
    const parts = octets(address);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;

    const [first, second] = parts;

    if (first === 127) return true;                    // loopback
    if (first === 0) return true;                      // "this host on this network"
    return first === 169 && second === 254;            // link-local, incl. 169.254.169.254
};

/**
 * The IPv6 address the cloud metadata service answers on.
 *
 * AWS serves IMDS over IPv6 at fd00:ec2::254, which is Unique-Local - the IPv6
 * analogue of RFC1918, not link-local. So every range check in this file walked
 * past it: the guard blocks fe80::/10 because nothing legitimate lives there,
 * while fd00::/8 is somebody's LAN and a node or an integration on one is
 * ordinary. Blocking the range would break those installs; blocking the range
 * is also not what the IPv4 side does, where 10/8 and 192.168/16 are allowed
 * and 169.254.169.254 alone is refused.
 *
 * So this is one address, matched however it is spelled. A v6 address has many
 * legal spellings of the same value - leading zeros in any group, `::` standing
 * for a different run of them, either case - and a text comparison catches one.
 * Expanding to the eight groups and reading them as numbers compares the value.
 */
const IPV6_GROUPS = 8;

const METADATA_IPV6 = [0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x0254];

/** The eight groups of a v6 literal as numbers, or null when it is not one. */
const ipv6Groups = (address) => {
    const normalised = address.toLowerCase().split("%")[0];
    if (!/^[0-9a-f:]+$/.test(normalised)) return null;

    const halves = normalised.split("::");
    if (halves.length > 2) return null;

    const parse = (half) => half === "" ? [] : half.split(":").map((group) => {
        if (!/^[0-9a-f]{1,4}$/.test(group)) return NaN;
        return parseInt(group, 16);
    });

    const head = parse(halves[0]);
    const tail = halves.length === 2 ? parse(halves[1]) : [];
    if ([...head, ...tail].some((group) => Number.isNaN(group))) return null;

    // Without a `::` the address has to be written out in full.
    if (halves.length === 1) return head.length === IPV6_GROUPS ? head : null;

    const gap = IPV6_GROUPS - head.length - tail.length;
    if (gap < 1) return null;

    return [...head, ...Array(gap).fill(0), ...tail];
};

const isMetadataIpv6 = (address) => {
    const groups = ipv6Groups(address);

    return groups !== null && groups.every((group, index) => group === METADATA_IPV6[index]);
};

/**
 * The metadata service in either family, which is the one destination in the
 * otherwise-allowed private ranges with anything to gain. Exported so the two
 * guards below - which disagree about loopback and about LAN ranges - can still
 * agree about this.
 */
export const isMetadataAddress = (address) => {
    if (typeof address !== "string" || address === "") return false;

    const embedded = embeddedIpv4(address);
    const dotted = embedded ?? address;

    if (!dotted.includes(":")) {
        const parts = octets(dotted);

        return parts.length === 4 && parts[0] === 169 && parts[1] === 254 && parts[2] === 169 && parts[3] === 254;
    }

    return isMetadataIpv6(dotted);
};

const isBlockedIpv6 = (address) => {
    const normalised = address.toLowerCase().split("%")[0];

    if (normalised === "::1" || normalised === "::") return true;

    // The metadata service, which is Unique-Local rather than link-local and so
    // is caught by neither of the rules around it - see isMetadataAddress.
    if (isMetadataIpv6(normalised)) return true;

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

/**
 * Just the link-local half of the block list, in every spelling.
 *
 * Split out for the outbound notification path, which allows loopback - an
 * integration on the same host is ordinary - and must still refuse
 * 169.254.169.254. Shares embeddedIpv4 with the full check, so the IPv6
 * spellings a URL actually produces are recognised here too.
 */
export const isLinkLocalAddress = (address) => {
    if (typeof address !== "string" || address === "") return false;

    const embedded = embeddedIpv4(address);
    const dotted = embedded ?? address;

    if (!dotted.includes(":")) {
        const parts = octets(dotted);
        if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
            return false;

        return parts[0] === 169 && parts[1] === 254;
    }

    // fe80::/10 - the second nibble of the second byte only has to fall in 8..b.
    return /^fe[89ab]/.test(dotted.toLowerCase().split("%")[0]);
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
 * Whether a URL the operator typed may be fetched at all.
 *
 * The address half of the guard, with no node allowlist in it - the part that
 * is true of every user-supplied destination rather than only of a node.
 *
 * This exists because the docstring at the top of this file was wrong. Adding a
 * node was not "the one place the server fetches a URL the user typed": five
 * integration modules fetch a stored one too - webhook, healthChecks, gotify,
 * ntfy and influxdb - and their only gate was the field's own
 * /^https?:\/\/\S+$/, which matches http://127.0.0.1:9200/ and
 * http://169.254.169.254/ as happily as anything else. So the machinery
 * routes/nodes.js sets out at length covered one of the six user-typed URLs in
 * the app.
 *
 * Deliberately narrower than checkNodeTarget, in three ways, and each one is a
 * decision rather than an omission.
 *
 * Loopback is allowed. A node is another machine by definition, so loopback
 * there is never anything but a mistake or an attack; an integration endpoint on
 * the same host is ordinary - InfluxDB on 127.0.0.1:8086 and a gotify container
 * beside MySpeed are how a great many self-hosters run this. Refusing it would
 * break more working installs than it protected.
 *
 * Link-local is not. Nothing legitimate notifies 169.254.0.0/16 or fe80::/10,
 * and 169.254.169.254 is the cloud metadata service - the one destination in
 * this space with anything to gain, and the reason routes/nodes.js singles it
 * out.
 *
 * It does not resolve the hostname. A node is added once, by hand, so a lookup
 * there costs nothing; this runs inside the run lock on every finished test, so
 * a lookup here would put a DNS round trip in front of every webhook and would
 * refuse an endpoint that is momentarily unresolvable - a working integration
 * having a bad minute rather than one pointed somewhere it should not be.
 *
 * It also does not consult ALLOWED_NODE_HOSTS. That list names the machines that
 * may be *nodes*; applying it here would refuse discord on any instance that set
 * it.
 *
 * The residual gap, named rather than hidden: a hostname that resolves to a
 * link-local address still passes, and the global fetch accepts no `lookup` to
 * pin it and follows redirects, so a far end answering 302 can still choose a
 * destination after the check. Closing either needs the node path's node:http
 * client. What this buys is that a webhook cannot be *pointed* at the metadata
 * service in the first place, which is the shape the field's regex allowed.
 *
 * @returns {{safe: true}|{safe: false, reason: string}}
 */
export const checkOutboundTarget = (value) => {
    let url;
    try {
        url = new URL(value);
    } catch {
        return {safe: false, reason: "The URL is not a valid URL"};
    }

    if (!ALLOWED_PROTOCOLS.has(url.protocol))
        return {safe: false, reason: "A URL has to use http or https"};

    // Strips the brackets an IPv6 literal carries in a URL.
    const hostname = url.hostname.replace(/^\[|]$/g, "");

    if (isLinkLocalAddress(hostname))
        return {safe: false, reason: "That address is a link-local one"};

    // The metadata service in the other family. Loopback and the private ranges
    // are allowed here on purpose - an integration on the same host or the same
    // LAN is ordinary - but fd00:ec2::254 is the one address in that space with
    // anything to gain, and it is Unique-Local rather than link-local, so the
    // check above does not reach it.
    if (isMetadataAddress(hostname))
        return {safe: false, reason: "That address is the cloud metadata service"};

    return {safe: true};
};

/**
 * Decides whether a node URL may be fetched.
 *
 * The address checks above, plus the allowlist that is specific to nodes. This
 * is the check that produces a useful message for the operator adding one; the
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

    // Resolved here and not in checkOutboundTarget: a node is added once, by
    // hand, so the lookup costs nothing and closes the name-to-loopback case
    // outright. The notification path cannot afford the same round trip - see
    // the note there.
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
