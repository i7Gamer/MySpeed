import dns from 'node:dns';
import net from 'node:net';

/**
 * Which server an Ookla run on a dual-stack Windows host can actually reach.
 *
 * The CLI cannot bind an interface on Windows ("Failed binding local
 * connection end"), so it is bound by address - the interface's IPv4 one. On
 * a host that also has a global IPv6 address, Windows hands the CLI a server's
 * AAAA records, and the CLI (1.2.0.84) opens the IPv6 address first from its
 * IPv4 socket, fails with "Cannot open socket" and never tries the A record.
 * Binding the IPv6 address instead fails earlier: the CLI's configuration
 * endpoint is IPv4 only. The CLI has no flag to choose a family either.
 *
 * So a run the provider would choose a server for is pointed at the nearest
 * listed server that has an A record and no AAAA. A pinned server is left
 * alone - it is the operator's own choice - and so is every host on which the
 * failure cannot happen.
 */

// Per lookup. A DNS server that does not answer must not hold the run open:
// the server it was asked about is simply not chosen.
export const DNS_TIMEOUT_MS = 2000;
export const DNS_TRIES = 1;

const IPV6_FAMILIES = new Set(["IPv6", 6]);
const LINK_LOCAL = /^fe[89ab][0-9a-f]:/i;
const IPV4 = 4;
const IPV6 = 6;

/**
 * The answers that mean "this name has no AAAA record". Node says ENODATA;
 * Bun, which the release binaries run on, says ENOTFOUND. Only asked once the
 * A lookup has succeeded, so the name exists and ENOTFOUND cannot mean that.
 */
const NO_RECORD = new Set([dns.NODATA, dns.NOTFOUND]);

const BRACKETED = /^\[([^\]]+)\](?::\d+)?$/;
const PORT = /:\d+$/;

const defaultResolver = () => new dns.promises.Resolver({timeout: DNS_TIMEOUT_MS, tries: DNS_TRIES});

/** Whether any interface carries an IPv6 address beyond loopback and link-local. */
export const hasGlobalIpv6 = (interfacesNode) => Object.values(interfacesNode ?? {}).flat()
    .some((entry) => entry && IPV6_FAMILIES.has(entry.family) && !entry.internal
        && !LINK_LOCAL.test(entry.address));

/** The name in a server list's "host:port". */
export const hostName = (host) => {
    const bracketed = BRACKETED.exec(host);
    if (bracketed) return bracketed[1];

    return host.replace(PORT, "");
};

const settle = (lookup) => {
    try {
        return Promise.resolve(lookup());
    } catch (error) {
        return Promise.reject(error);
    }
};

/** Whether the server has an A record and no AAAA. Anything uncertain is no. */
export const isIpv4Only = async (host, resolver) => {
    if (!host) return false;

    const name = hostName(host);
    const literal = net.isIP(name);
    if (literal === IPV4) return true;
    if (literal === IPV6) return false;

    const [a, aaaa] = await Promise.allSettled([
        settle(() => resolver.resolve4(name)), settle(() => resolver.resolve6(name))]);

    if (a.status !== "fulfilled" || a.value.length === 0) return false;
    if (aaaa.status === "fulfilled") return aaaa.value.length === 0;

    return NO_RECORD.has(aaaa.reason?.code);
};

/**
 * The id of the nearest IPv4-only server in the Ookla list, or undefined.
 *
 * The list is keyed by id, which JavaScript iterates in numeric order, so the
 * distance is what orders it. Every server is asked at once: twenty lookups in
 * parallel cost one lookup's time, where in sequence a few slow answers would
 * add up to more than the run itself.
 */
export const ipv4OnlyServerId = async (servers, resolver = defaultResolver()) => {
    const candidates = Object.entries(servers ?? {})
        .filter(([, server]) => server && server.host)
        .sort(([, a], [, b]) => (a.distance ?? Infinity) - (b.distance ?? Infinity));

    const verdicts = await Promise.all(candidates.map(([, server]) => isIpv4Only(server.host, resolver)));
    const index = verdicts.indexOf(true);

    return index === -1 ? undefined : candidates[index][0];
};

/**
 * The server id an Ookla run should be started with: the one it was given,
 * or - for an unpinned run bound to IPv4 on a Windows host that has IPv6 -
 * the nearest server the CLI can reach over IPv4. When none can be found the
 * provider chooses, as it always did.
 */
export const ooklaServerFor = async ({mode, platform, serverId, serverUrl, address, interfacesNode,
                                      servers, resolver, log = console.log}) => {
    if (serverId || serverUrl) return serverId;
    if (mode !== "ookla" || platform !== "win32") return serverId;
    if (!address || net.isIP(address) !== IPV4 || !hasGlobalIpv6(interfacesNode)) return serverId;

    const chosen = await ipv4OnlyServerId(servers, resolver);

    log(chosen === undefined
        ? "Found no IPv4-only Ookla server to use from an IPv4 address on a host with IPv6; "
            + "leaving the choice to the provider"
        : `Using Ookla server ${chosen}: it has no IPv6 address, which the CLI bound to IPv4 cannot reach`);

    return chosen ?? serverId;
};
