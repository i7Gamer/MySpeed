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
const takesServerId = (provider) => REGISTRY[provider]?.serverList !== null;

// Providers whose targets carry an endpoint of their own. Only libre today;
// iperf3 joins when its registry entry lands.
const takesEndpoint = (provider) => provider === "libre";

const optimalProblem = (value, name) => {
    if (value === undefined || value === null) return null;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
        return `The optimal ${name} must be a number above zero, or unset`;
    return null;
};

/** What is wrong with a target, or null when nothing is. */
export const targetProblem = (target) => {
    const name = typeof target.name === "string" ? target.name.trim() : "";

    if (name === "") return "The target needs a name";
    if (name.length > TARGET_NAME_LIMIT)
        return `The name must be ${TARGET_NAME_LIMIT} characters or fewer`;

    if (!(target.provider in REGISTRY)) return "The provider does not exist";

    if (target.serverId !== undefined && target.serverId !== null) {
        if (!takesServerId(target.provider)) return "This provider has no servers to pin";
        if (!DIGITS.test(target.serverId)) return "The server id must be digits";
    }

    if (target.endpoint !== undefined && target.endpoint !== null) {
        if (!takesEndpoint(target.provider)) return "This provider takes no endpoint";

        let url;
        try {
            url = new URL(target.endpoint);
        } catch {
            return "The endpoint must be a URL";
        }

        if (!ALLOWED_PROTOCOLS.has(url.protocol)) return "The endpoint's protocol is not allowed";
    }

    return optimalProblem(target.optimalPing, "ping")
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
