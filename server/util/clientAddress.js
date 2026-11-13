import { trustsProxy } from './trustProxy.js';

const IPV4_MAPPED_PREFIX = "::ffff:";

/**
 * The address as its own family: a v4 address that arrived through a
 * dual-stack socket reads "::ffff:172.16.0.5", which is IPv4 to every rule
 * written about it and IPv6 to a literal comparison.
 */
export const normaliseAddress = (address) =>
    address.startsWith(IPV4_MAPPED_PREFIX) ? address.slice(IPV4_MAPPED_PREFIX.length) : address;

// Any of these means something relayed the request, so the socket address
// belongs to the relay rather than to the caller.
const FORWARDING_HEADERS = ["x-forwarded-for", "forwarded", "x-real-ip", "x-client-ip"];

/**
 * Whether a request came from the machine the server runs on.
 *
 * Shared by the passwordless-access gate and the HTTPS redirect, both of which
 * have to treat a local caller - the container healthcheck, a developer, an
 * operator on the console - differently from one arriving over the network.
 *
 * It answers "did this arrive on a loopback socket, with nothing suggesting it
 * was relayed", and every uncertainty resolves to false. Three ways it used to
 * say yes when it should not have:
 *
 *   - it read req.ip, which Express resolves from X-Forwarded-For once a proxy
 *     is trusted, so the caller supplied the address being checked;
 *   - it skipped the forwarding-header check whenever TRUST_PROXY was merely
 *     *defined*, so TRUST_PROXY=false and TRUST_PROXY=0 - both of which mean
 *     "do not trust a proxy" - turned the guard off;
 *   - it had no answer for a proxy that forwards without adding a header, where
 *     every remote caller arrives on loopback looking local.
 */
export const isLoopbackRequest = (req) => {
    if (FORWARDING_HEADERS.some((name) => req.headers?.[name] !== undefined)) return false;

    // The operator has said a proxy is in front. A loopback socket is therefore
    // that proxy, whether or not it bothered to add a header, so nothing
    // arriving this way can be shown to be local.
    if (trustsProxy()) return false;

    // The transport address, never req.ip: req.ip is derived from headers the
    // caller controls as soon as a proxy is trusted.
    const address = req.socket?.remoteAddress;
    if (typeof address !== "string") return false;

    const normalised = normaliseAddress(address);

    return normalised === "::1" || normalised.startsWith("127.");
};

const LOOPBACK_NAMES = new Set(["localhost", "::1"]);

// A whole dotted quad: "127.0.0.1.example.com" is a public name.
const LOOPBACK_IPV4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** The name in a Host header, without its port or its IPv6 brackets. */
const hostName = (host) => {
    const bracketed = host.match(/^\[([^\]]*)\]/);
    if (bracketed) return bracketed[1];

    // One colon separates a name from its port; more than one is a bare IPv6
    // address, which carries no port in this form.
    const colons = host.split(":").length - 1;

    return colons === 1 ? host.slice(0, host.indexOf(":")) : host;
};

/**
 * Whether the caller addressed this machine by name.
 *
 * The socket says where the bytes came from; the Host header says where the
 * caller thought it was sending them. A forwarder that terminates on loopback
 * and adds no header - `ssh -L`, `kubectl port-forward`, an nginx proxy_pass
 * without proxy_params - makes every remote caller arrive on loopback looking
 * local, and isLoopbackRequest has no way to tell. Those requests still name
 * the public host, so on a password-less instance the waiver asks for both.
 *
 * An absent header is allowed: HTTP/1.0 sends none, and the documented local
 * callers - the healthcheck asking 127.0.0.1, a developer asking localhost -
 * all name the machine.
 */
export const namesLoopbackHost = (req) => {
    const host = req.headers?.host;
    if (host === undefined) return true;

    const name = hostName(String(host).toLowerCase());

    return LOOPBACK_NAMES.has(name) || LOOPBACK_IPV4.test(normaliseAddress(name));
};

/**
 * What a browser reports for a request the app's own page made, and for one the
 * user typed or bookmarked. "same-site" is deliberately not here: on a public
 * name it is a sibling subdomain and on loopback it is another port, and either
 * is a different application.
 */
export const OWN_FETCH_SITES = new Set(["same-origin", "none"]);

/**
 * The host an Origin or Referer names, or null for one that names none - the
 * opaque "null" of a sandboxed frame, an array where a proxy sent the header
 * twice, anything that does not parse.
 */
export const hostOfOrigin = (value) => {
    if (typeof value !== "string") return null;

    try {
        return new URL(value).host.toLowerCase();
    } catch {
        return null;
    }
};

// A write carries the first, and a read the second wherever the page's
// referrer policy lets it.
const ORIGIN_HEADERS = ["origin", "referer"];

/**
 * Whether a browser says this request belongs to some other origin than the
 * host it was sent to.
 *
 * A loopback socket and a loopback Host say where a request arrived, not who
 * made it, and two callers satisfy both without being the operator at the
 * console. A page on any other site, open in the operator's own browser, can
 * post a form at http://127.0.0.1:5216. And a remote browser behind a same-host
 * proxy that rewrites Host to the upstream and adds no forwarding header -
 * nginx with a bare proxy_pass - arrives looking exactly as local as the
 * console does, while still naming the public origin in the headers the proxy
 * passes through untouched.
 *
 * The fetch metadata is not allowed to settle it alone, which is the difference
 * from isCrossSiteWrite in trustedProxyAuth.js: the proxied browser honestly
 * reports "same-origin", about an origin that is not the one that was asked.
 *
 * This narrows the waiver and no more. A caller that is not a browser sends
 * none of these headers, so behind such a proxy a script is still let through,
 * and so is a browser's read: this app's own pages send no Referer. Nothing in
 * the request can tell those from the console - only a password, the setup
 * token, or the proxy saying it is one (TRUST_PROXY, or any forwarding header)
 * closes that.
 */
export const namesForeignOrigin = (req) => {
    const headers = req.headers ?? {};

    const fetchSite = headers["sec-fetch-site"];
    if (fetchSite !== undefined && !OWN_FETCH_SITES.has(String(fetchSite).toLowerCase())) return true;

    const host = typeof headers.host === "string" ? headers.host.toLowerCase() : null;

    return ORIGIN_HEADERS.some((name) =>
        headers[name] !== undefined && (host === null || hostOfOrigin(headers[name]) !== host));
};
