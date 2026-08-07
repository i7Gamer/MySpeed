const IPV4_MAPPED_PREFIX = "::ffff:";

/**
 * Whether a request came from the machine the server runs on.
 *
 * Shared by the passwordless-access gate and the HTTPS redirect, both of which
 * have to treat a local caller - the container healthcheck, a developer, an
 * operator on the console - differently from one arriving over the network.
 */
export const isLoopbackRequest = (req) => {
    // A reverse proxy on the same host makes every request look like it came
    // from loopback. Unless the operator has told us to trust the proxy - in
    // which case req.ip has already been resolved to the real client - a
    // forwarding header means this address belongs to the proxy, not the caller.
    if (req.headers?.["x-forwarded-for"] !== undefined && process.env.TRUST_PROXY === undefined) return false;

    const address = req.ip ?? req.socket?.remoteAddress;
    if (typeof address !== "string") return false;

    const normalised = address.startsWith(IPV4_MAPPED_PREFIX)
        ? address.slice(IPV4_MAPPED_PREFIX.length)
        : address;

    return normalised === "::1" || normalised.startsWith("127.");
};
