import targets from '../models/Targets.js';
import { REGISTRY } from '../util/providers/registry.js';
import { ALLOWED_PROTOCOLS } from '../util/safeUrl.js';

/**
 * The named provider+server pairings the round tests, and the judgements
 * about them.
 *
 * The validation and the viewer redaction are pure functions over a row, for
 * the same reason localeGaps keeps its half pure: the API route and the
 * import path both have to make the same call, and a test should be able to
 * ask it without a database.
 */

export const TARGET_NAME_LIMIT = 64;

const DIGITS = /^\d+$/;

// Providers whose targets may pin a listed server id. Cloudflare has exactly
// one endpoint, so an id on such a target is a mistake worth naming rather
// than a value to quietly ignore.
//
// Object.hasOwn, not a bare lookup: `REGISTRY["toString"]` answers with
// Object.prototype's function, whose `serverList` is undefined - so a prototype
// name was told it may pin a server, and its id was then judged against a
// provider that is a function. The same trap the config and integration
// controllers were already fixed for.
const takesServerId = (provider) =>
    Object.hasOwn(REGISTRY, provider) && REGISTRY[provider].serverList !== null;

// Providers whose targets carry an endpoint of their own, and what kind.
// libre's is a URL to a backend; iperf3's is a host and port.
const takesEndpoint = (provider) => provider === "libre" || provider === "iperf3";

// And the one that cannot do without it: a libre target with no endpoint uses
// the public backend list, where an iperf3 target with no host has nothing to
// measure against at all.
const requiresEndpoint = (provider) => provider === "iperf3";

const PORT_DIGITS = /^\d+$/;
const MAX_PORT = 65535;

/**
 * What is wrong with an iperf3 target's `host[:port]`, or null when nothing is.
 *
 * Deliberately not a URL and not held to one: an iperf3 server is a host the
 * operator runs, dialled directly, and there is no scheme to speak of.
 *
 * Deliberately not held to the address rules the node list applies either.
 * Those exist to stop this server being aimed at private addresses on the
 * operator's behalf, and here the operator is aiming it at their own machine
 * on purpose - a LAN host, or loopback, is the ordinary case and the main
 * reason to want this provider. What is refused is only what cannot be dialled.
 */
export const iperfEndpointProblem = (endpoint) => {
    const value = String(endpoint).trim();

    if (value === "") return "The target needs a host to measure against";
    if (/\s/.test(value)) return "The host cannot contain spaces";
    if (value.includes("/") || value.includes("@"))
        return "Give a host and port, like 10.0.0.5:5201 - not a URL";

    // The last colon separates the port, so a bracketed IPv6 literal keeps its
    // own. splitEndpoint reads it the same way when the run is built.
    const separator = value.lastIndexOf(":");
    const bracketed = value.startsWith("[");
    const hasPort = separator !== -1
        && (bracketed ? value.indexOf("]") < separator : value.indexOf(":") === separator);

    const host = hasPort ? value.slice(0, separator) : value;

    if (host === "" || host === "[]") return "The target needs a host to measure against";

    if (hasPort) {
        const port = value.slice(separator + 1);

        if (!PORT_DIGITS.test(port)) return "The port must be digits";
        if (Number(port) < 1 || Number(port) > MAX_PORT)
            return `The port must be between 1 and ${MAX_PORT}`;
    }

    return null;
};

const optimalProblem = (value, name) => {
    if (value === undefined || value === null) return null;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
        return `The optimal ${name} must be a number above zero, or unset`;
    return null;
};

/**
 * A flag as either shape it legitimately arrives in.
 *
 * targetProblem judges two: the fragment a request carried, where a flag is a
 * JSON boolean, and the row a PATCH would become - merged from a raw database
 * read, where SQLite's BOOLEAN is an integer. 0 and 1 are therefore as valid
 * as false and true, and refusing them refuses every PATCH of an existing
 * target.
 */
const FLAG_VALUES = [true, false, 0, 1];

/**
 * What is wrong with one of the two flags, or null when nothing is.
 *
 * These were the only writable fields nothing judged, and the column does not
 * catch what gets through. Sequelize's BOOLEAN coerces the values that read as
 * one - 'true', 'false', '0', '1' - and stores anything else verbatim, so a
 * target created with `enabled: "yes"` kept the string. It then read truthy
 * everywhere JavaScript asked - the dialog drew it as part of the round,
 * `if (target.alerts)` sent its notifications - while roundTargets()'s
 * `where: {enabled: true}` compares against SQL 1 and left it out. The round
 * silently never ran a target the interface showed as scheduled.
 *
 * Refused rather than coerced, unlike importConfig's `Boolean(...)`: for a
 * value arriving over the API, `Boolean("false")` being true is a worse
 * surprise than a 400 naming the field.
 */
const flagProblem = (value, name) => {
    if (value === undefined || value === null) return null;
    if (!FLAG_VALUES.includes(value)) return `The ${name} flag must be true or false`;
    return null;
};

/** What is wrong with a target, or null when nothing is. */
export const targetProblem = (target) => {
    const name = typeof target.name === "string" ? target.name.trim() : "";

    if (name === "") return "The target needs a name";
    if (name.length > TARGET_NAME_LIMIT)
        return `The name must be ${TARGET_NAME_LIMIT} characters or fewer`;

    // `in`, which this was, is true for every name on Object.prototype. So a
    // target could be created with provider "toString" - accepted with a 200,
    // joined to every scheduled round, and failing each run against a binary
    // called ./bin/undefined, because descriptor()'s `if (!entry)` reads that
    // inherited function as a provider that exists.
    if (!Object.hasOwn(REGISTRY, target.provider)) return "The provider does not exist";

    if (target.serverId !== undefined && target.serverId !== null) {
        if (!takesServerId(target.provider)) return "This provider has no servers to pin";
        if (!DIGITS.test(target.serverId)) return "The server id must be digits";
    }

    if (target.endpoint !== undefined && target.endpoint !== null) {
        if (!takesEndpoint(target.provider)) return "This provider takes no endpoint";

        if (target.provider === "iperf3") {
            const problem = iperfEndpointProblem(target.endpoint);
            if (problem) return problem;
        } else {
            let url;
            try {
                url = new URL(target.endpoint);
            } catch {
                return "The endpoint must be a URL";
            }

            if (!ALLOWED_PROTOCOLS.has(url.protocol)) return "The endpoint's protocol is not allowed";
        }
    } else if (requiresEndpoint(target.provider)) {
        // Refused at the door rather than at the first run: a target that can
        // never measure anything would otherwise be created happily and then
        // fail on a schedule, with the reason three clicks away in a row's
        // error column.
        return "An iperf3 target needs the host of the iperf3 server to measure against";
    }

    return flagProblem(target.enabled, "enabled")
        ?? flagProblem(target.alerts, "alerts")
        ?? optimalProblem(target.optimalPing, "ping")
        ?? optimalProblem(target.optimalDownload, "download")
        ?? optimalProblem(target.optimalUpload, "upload");
};

/**
 * The optimal values a target's runs are judged against: its own where set,
 * the instance-wide ones everywhere else. The one home of the fallback rule,
 * so the grading and whatever else reads limits cannot drift apart.
 *
 * @param target the target row, or {} for rows with no target
 * @param global the stored config values, as strings the way config keeps them
 */
export const resolveLimits = (target, global) => ({
    ping: target.optimalPing ?? Number(global.ping),
    download: target.optimalDownload ?? Number(global.download),
    upload: target.optimalUpload ?? Number(global.upload)
});

/**
 * What a read-only visitor may know of a target: enough to label and order
 * the interface (name, provider, the optimal values the grading needs), and
 * nothing that describes the operator's network - the endpoint can carry a
 * credential, and a server id narrows down where the instance lives.
 */
export const viewerFacing = ({id, name, provider, enabled, sortOrder,
    optimalPing, optimalDownload, optimalUpload}) =>
    ({id, name, provider, enabled, sortOrder, optimalPing, optimalDownload, optimalUpload});

const LIST_ORDER = [["sortOrder", "ASC"], ["id", "ASC"]];

export const listAll = async () => await targets.findAll({order: LIST_ORDER});

export const getOne = async (id) => await targets.findOne({where: {id}});

/** The members of a scheduled round, in the order they run. */
export const roundTargets = async () =>
    await targets.findAll({where: {enabled: true}, order: LIST_ORDER});

/**
 * The target the instance-wide readings pin to: the Prometheus series without
 * a target label describe it. The first enabled one by order - which is also
 * the first the round runs.
 */
export const primaryTarget = async () => (await roundTargets())[0];

/**
 * The target the recommendations sample: the first scheduled one that takes
 * part in alerting. The two can differ - a diagnostic box may lead the round
 * with alerts off - and recommendations must describe a line someone watches.
 */
export const alertsTarget = async () =>
    (await roundTargets()).find((target) => target.alerts);

export const create = async (target) => await targets.create({
    name: target.name.trim(),
    provider: target.provider,
    serverId: target.serverId ?? null,
    endpoint: target.endpoint ?? null,
    enabled: target.enabled ?? true,
    alerts: target.alerts ?? true,
    optimalPing: target.optimalPing ?? null,
    optimalDownload: target.optimalDownload ?? null,
    optimalUpload: target.optimalUpload ?? null,
    sortOrder: target.sortOrder ?? await nextSortOrder(),
    created: new Date().toISOString()
});

const nextSortOrder = async () => {
    const last = await targets.findOne({order: [["sortOrder", "DESC"]]});
    return last ? last.sortOrder + 1 : 0;
};

export const update = async (id, changes) => await targets.update(changes, {where: {id}});

export const deleteTarget = async (id) => await targets.destroy({where: {id}});

/** Rewrites the round order to the given id sequence; unknown ids are ignored. */
export const reorder = async (ids) => {
    for (const [index, id] of ids.entries())
        await targets.update({sortOrder: index}, {where: {id}});
};

export const removeAll = async (transaction = undefined) =>
    await targets.destroy({where: {}, transaction});

export const count = async () => await targets.count();
