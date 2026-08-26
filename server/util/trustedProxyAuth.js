import net from 'node:net';
import { normaliseAddress } from './clientAddress.js';

/**
 * Header authentication for a reverse proxy that has already signed the
 * caller in (upstream #767: Authelia, Authentik, forward-auth setups
 * generally). The proxy decides who may pass and forwards the identity in a
 * header; a request carrying it is admitted as the operator, no password
 * asked.
 *
 * Trusting a header is only safe when the request provably came from the
 * proxy that set it - anyone who can reach the port directly can type
 * "Remote-User: admin" into a request of their own. So the feature arms only
 * when BOTH variables are set:
 *
 *   TRUSTED_AUTH_HEADER   the header's name, e.g. Remote-User
 *   TRUSTED_AUTH_PROXIES  the addresses the assertion may come from,
 *                         comma-separated addresses and CIDR subnets
 *
 * and the address checked is the socket's own, never a forwarded header,
 * because forwarded headers are the caller's to write. The proxy, for its
 * part, must strip the header from incoming requests before adding its own -
 * which is what forward-auth middlewares do by default.
 */

const FAMILY = {4: "ipv4", 6: "ipv6"};
const PREFIX_BITS = {4: 32, 6: 128};

/** One list entry into the BlockList, or false for one that cannot be read. */
const addEntry = (proxies, entry) => {
    const [address, prefix, excess] = entry.split("/");
    const family = net.isIP(address);

    if (excess !== undefined || family === 0) return false;

    if (prefix === undefined) {
        proxies.addAddress(address, FAMILY[family]);
        return true;
    }

    if (!/^\d+$/.test(prefix) || Number(prefix) > PREFIX_BITS[family]) return false;

    proxies.addSubnet(address, Number(prefix), FAMILY[family]);
    return true;
};

/**
 * The proxy list as something addresses can be checked against, or null.
 *
 * Null for unset and null for unreadable, and unreadable means the WHOLE
 * list: skipping just the entry that cannot be parsed would leave the
 * operator believing the list they wrote is the list in force. Refusing it
 * all fails closed - header authentication stays off, the login prompt
 * appears, and the misconfiguration is noticed.
 */
export const parseTrustedProxies = (text) => {
    if (text === undefined || text === null) return null;

    const entries = text.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
    if (entries.length === 0) return null;

    const proxies = new net.BlockList();

    for (const entry of entries)
        if (!addEntry(proxies, entry)) return null;

    return proxies;
};

/** Whether a socket address is one of the proxies the operator vouched for. */
export const isTrustedAddress = (address, proxies) => {
    if (proxies === null || typeof address !== "string") return false;

    const normalised = normaliseAddress(address);
    const family = net.isIP(normalised);

    return family !== 0 && proxies.check(normalised, FAMILY[family]);
};

/*
 * The parsed list, keyed on the exact text it was parsed from. Parsing builds
 * a BlockList per call, and this runs on every request - but the environment
 * can also legitimately differ between reads (tests do, and so does a
 * hot-reloading supervisor), so the cache is invalidated by comparing the raw
 * text rather than trusting the first read forever.
 */
// Its own value rather than undefined, which is also what an unset variable
// reads as - the collision made the very first request skip the parse, and
// with it the warning the parse is trusted to print.
const NEVER_PARSED = Symbol("never parsed");

let cachedText = NEVER_PARSED;
let cachedProxies = null;

/** Forgets the cache and the warning's memory. Exists for the tests. */
export const resetTrustedProxyAuth = () => {
    cachedText = NEVER_PARSED;
    cachedProxies = null;
};

const trustedProxies = (text) => {
    if (text !== cachedText) {
        cachedText = text;
        cachedProxies = parseTrustedProxies(text);

        // Once per configuration rather than once per request: the header is
        // named, so the operator believes this works, and silence would leave
        // them facing a login prompt with nothing saying why.
        if (cachedProxies === null)
            console.warn(text === undefined || text.trim() === ""
                ? "TRUSTED_AUTH_HEADER is set but TRUSTED_AUTH_PROXIES is not; header authentication stays off."
                : `TRUSTED_AUTH_PROXIES ("${text}") could not be read as addresses and subnets; header authentication stays off.`);
    }

    return cachedProxies;
};

/**
 * The identity the trusted proxy asserted for this request, or null.
 *
 * Null is every kind of no: the feature is not configured, the socket is not
 * a listed proxy, the header is absent, empty, or not the single plain
 * string a proxy sends. The value itself is not interpreted - MySpeed has one
 * operator, not accounts - so its only job is to be non-empty, but it is
 * returned rather than swallowed so a caller that wants to log it can.
 */
export const trustedProxyUser = (req) => {
    const headerName = process.env.TRUSTED_AUTH_HEADER?.trim().toLowerCase();
    if (!headerName) return null;

    const proxies = trustedProxies(process.env.TRUSTED_AUTH_PROXIES);
    if (!isTrustedAddress(req.socket?.remoteAddress, proxies)) return null;

    const asserted = req.headers?.[headerName];
    if (typeof asserted !== "string" || asserted.trim() === "") return null;

    return asserted.trim();
};
