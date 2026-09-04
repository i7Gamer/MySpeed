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
