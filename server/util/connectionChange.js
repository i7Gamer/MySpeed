import net from 'node:net';

/**
 * Whether the connection changed between two runs, and what a notifier's
 * settings call the switch that tells it.
 *
 * Every Ookla row stores the address the provider saw and the network it
 * named, and the detail pane has long marked a row whose pair differs from
 * the row before. This is the same verdict judged once on the server, after
 * the row is written, so it can be kept in a log the retention sweep does
 * not silently truncate and told to the integrations as an event of its own.
 *
 * A leaf: the modules read the two field names from here, and a module
 * cannot import the controller that loads it - see the import-cycle rule
 * tasks/integrations.js follows.
 */

/** The event the change travels as - upstream's own name for it. */
export const IP_CHANGED_EVENT = "ipChanged";

/** The boolean on every notifier that opts into the event. Off until turned on: nobody is opted in by an upgrade. */
export const SEND_IP_CHANGED_FIELD = "send_ip_changed";

/** The operator's own template for the message, on every notifier that writes prose. */
export const IP_CHANGED_MESSAGE_FIELD = "ip_changed_message";

/** What net.isIP answers for each family. */
export const IPV4 = 4;
export const IPV6 = 6;

/**
 * Which family an address belongs to, or zero for anything that is not one.
 *
 * A dual-stack line answers one run over IPv6 and the next over IPv4, and
 * that is not the address rotating: an address is only ever compared with
 * the last one of its own family.
 */
export const addressFamily = (ip) => typeof ip === "string" ? net.isIP(ip.trim()) : 0;

const named = (value) => typeof value === "string" && value.trim() !== "";

/**
 * A provider's name as it is compared: case folded, runs of whitespace
 * collapsed. The provider spells its own network however it likes from one
 * run to the next, and "Telekom  Deutschland" against "telekom deutschland"
 * is not a new provider. Null for nothing at all.
 */
export const normalisedIsp = (isp) => named(isp) ? isp.trim().replace(/\s+/g, " ").toLowerCase() : null;

/**
 * The address a row may store, or null: an IP literal, trimmed, and nothing
 * else. A run's parser already nulls what the provider left blank, but an
 * imported history passes the column through as written - and a stored ""
 * or "unknown" is picked as "the newest earlier address of this family" by
 * shape, then refused as a comparison, so the real previous address behind
 * it is never reached and one rotation goes unlogged.
 */
export const storableAddress = (ip) => addressFamily(ip) === 0 ? null : ip.trim();

/** The provider name a row may store, or null: non-blank text, trimmed. */
export const storableIsp = (isp) => named(isp) ? isp.trim() : null;

// Compare the complete IPv6 address, preserving a case-sensitive interface
// scope. Mirrored in TestUtil.js; addressEquivalence.test.js checks both paths.
const comparableAddress = (value) => {
    if (typeof value !== "string" || !value.includes(":")
        || !/^[0-9a-f:.]+(?:%[0-9a-z.:-]+)?$/i.test(value)) return value;
    const [address, ...scope] = value.split("%");
    try {
        return new URL(`http://[${address}]/`).hostname + (scope.length ? `%${scope.join("%")}` : "");
    } catch {
        return value;
    }
};

/**
 * What changed between the run just written and the connection seen before
 * it, or null for nothing.
 *
 * Only a value present on both sides can change: a run that reported no
 * address - cloudflare names no network, iperf3 names neither - is not a
 * change to nothing, and the first run after an upgrade has nothing before
 * it. Only the half that changed is filled, so a reader can tell "the
 * address rotated" from "the address rotated and the provider is new"
 * without comparing the pairs again.
 *
 * @param current   {externalIp, isp} as the row just written stores them
 * @param previous  {externalIp, isp}: the last address of the same family
 *                  and the last name the same provider gave, each nullable
 */
export const describeChange = (current, previous) => {
    const currentIp = named(current?.externalIp) ? current.externalIp.trim() : null;
    const previousIp = named(previous?.externalIp) ? previous.externalIp.trim() : null;
    const ipChanged = currentIp !== null && previousIp !== null
        && addressFamily(currentIp) === addressFamily(previousIp)
        && comparableAddress(currentIp) !== comparableAddress(previousIp);

    const currentIsp = normalisedIsp(current?.isp);
    const previousIsp = normalisedIsp(previous?.isp);
    const ispChanged = currentIsp !== null && previousIsp !== null && currentIsp !== previousIsp;

    if (!ipChanged && !ispChanged) return null;

    return {
        previousIp: ipChanged ? previous.externalIp : null,
        ip: ipChanged ? current.externalIp : null,
        previousIsp: ispChanged ? previous.isp : null,
        isp: ispChanged ? current.isp : null
    };
};
