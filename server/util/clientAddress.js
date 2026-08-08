import { trustsProxy } from './trustProxy.js';

const IPV4_MAPPED_PREFIX = "::ffff:";

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

    const normalised = address.startsWith(IPV4_MAPPED_PREFIX)
        ? address.slice(IPV4_MAPPED_PREFIX.length)
        : address;

    return normalised === "::1" || normalised.startsWith("127.");
};
