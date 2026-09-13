import { isIP } from "node:net";

/**
 * Resolves the optional listener bind address.
 *
 * An omitted or empty value deliberately keeps Node's existing wildcard
 * behavior. Any supplied value must be an IP literal so a typo cannot silently
 * fall back to a network-wide listener.
 */
export const getBindAddress = (value) => {
    if (value === undefined || value === "") return undefined;

    if (typeof value === "string" && isIP(value) > 0) return value;

    throw new Error("SERVER_HOST must be a literal IPv4 or IPv6 address, or be unset");
};

export const bindAddress = getBindAddress(process.env.SERVER_HOST);
