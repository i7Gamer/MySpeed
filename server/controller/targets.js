import targets from '../models/Targets.js';
import db from '../config/database.js';
import { REGISTRY, IPERF_MAX_BITRATE_MBPS, IPERF_MAX_DURATION_SECONDS, IPERF_MAX_STREAMS,
    IPERF_MIN_BITRATE_MBPS, IPERF_MIN_DURATION_SECONDS, IPERF_MIN_STREAMS, IPERF_UDP_STREAMS }
    from '../util/providers/registry.js';
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

    /*
     * Brackets mean exactly one thing: the whole address wrapped once, with
     * nothing but an optional :port after the "]". Anything else used to slip
     * through - "[fd00::1" reads below as a host with its own port swallowed -
     * and splitEndpoint then dials the brackets verbatim, which getaddrinfo
     * can never resolve. The target was created happily and failed every
     * scheduled run, which is the exact fate this door exists to refuse.
     */
    const closing = value.indexOf("]");
    if (value.includes("[") || closing !== -1) {
        const wrapped = value.startsWith("[") && closing !== -1
            && value.lastIndexOf("[") === 0 && closing === value.lastIndexOf("]");
        const rest = closing === -1 ? "" : value.slice(closing + 1);

        if (!wrapped || (rest !== "" && !rest.startsWith(":")))
            return "Brackets belong around the whole address, like [fd00::1]:5201";
    }

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

/**
 * The tuning columns an iperf3 target may carry, with the bounds each is held
 * to and the word the refusal names it by.
 *
 * A table rather than two hand-written branches because the rule is the same
 * for both and the messages have to differ only in the field they name - which
 * is what the operator needs and what the dialog highlights on.
 */
const TUNING_COLUMNS = [
    {key: "iperfDuration", label: "duration in seconds",
        min: IPERF_MIN_DURATION_SECONDS, max: IPERF_MAX_DURATION_SECONDS},
    {key: "iperfStreams", label: "stream count",
        min: IPERF_MIN_STREAMS, max: IPERF_MAX_STREAMS},
    {key: "iperfBitrate", label: "bitrate in Mbit/s",
        min: IPERF_MIN_BITRATE_MBPS, max: IPERF_MAX_BITRATE_MBPS}
];

/**
 * What is wrong with a target's iperf3 run tuning, or null when nothing is.
 *
 * Null and absent both mean "inherit the shipped default", the same spelling
 * the three optimal columns use - so a target that names neither is the
 * ordinary case and has nothing to answer for. That is also every target on
 * every instance that upgrades into these columns.
 *
 * A value on a provider that does not run iperf3 is refused rather than
 * ignored, the way an endpoint on a provider that takes none already is: the
 * dialog would otherwise show a duration the run can never honour, and nothing
 * on the row or in the interface would say the number is inert.
 *
 * Whole numbers only, and refused rather than rounded or coerced - the
 * reasoning flagProblem states verbatim. iperf3 takes integers, and a target
 * quietly measuring for something other than the figure that was typed is a
 * worse surprise than a 400 naming the field.
 *
 * Exported and pure over a row, because the API route and the import path both
 * have to make the same call and a test should be able to ask it without a
 * database.
 */
export const iperfTuningProblem = (target) => {
    const named = TUNING_COLUMNS.filter((column) =>
        target[column.key] !== undefined && target[column.key] !== null);

    /*
     * The mode is named only when it is on.
     *
     * false is not a setting, it is every target on every provider once the
     * column exists - so reading it as "named" the way the numbers above are
     * would refuse every ookla target the moment a backup was restored.
     */
    const udp = Boolean(target.iperfUdp);

    if (named.length === 0 && !udp) return null;

    if (target.provider !== "iperf3") return "This provider takes no iperf3 tuning";

    for (const column of named) {
        const value = target[column.key];

        if (!Number.isInteger(value) || value < column.min || value > column.max)
            return `The iperf3 ${column.label} must be a whole number `
                + `between ${column.min} and ${column.max}, or unset`;
    }

    /*
     * A UDP run must name its rate, because the CLI's own default is 1 Mbit/s
     * and it does not say so. A capture of it measured 1.04 Mbit/s on the same
     * loopback that measured 99.2 when asked for 100 - a gigabit line stored
     * as a megabit, a plausible number in the right column, and the payload
     * echoes a target_bitrate that reads the same as an explicit `-b 1M`. So
     * nothing after the fact can tell the two apart, and the rate has to be
     * required here.
     */
    if (udp && (target.iperfBitrate === undefined || target.iperfBitrate === null))
        return "A UDP run must name the bitrate it sends at";

    // And a rate on a run that sends no datagrams is inert, refused for the
    // same reason a duration on an ookla target is: nothing on the row or in
    // the dialog would say the number does nothing.
    if (!udp && target.iperfBitrate !== undefined && target.iperfBitrate !== null)
        return "A bitrate applies only to a UDP run";

    /*
     * Not a preference: `-u -P 2` fails on the Cygwin build this downloads,
     * twice out of two attempts and at two different rates, with "unable to
     * read from stream socket: Resource temporarily unavailable". Refusing the
     * pair here is the difference between a configuration error the operator
     * sees once and a target that fails every scheduled run forever.
     */
    if (udp && Number.isInteger(target.iperfStreams) && target.iperfStreams !== IPERF_UDP_STREAMS)
        return `A UDP run measures over ${IPERF_UDP_STREAMS} stream`;

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
        ?? optimalProblem(target.optimalUpload, "upload")
        ?? iperfTuningProblem(target);
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
 *
 * Deliberately not the iperf3 tuning. How long a target's test runs and over
 * how many streams is needed to label, order or grade nothing, which is the
 * whole of what this answers - and it is one more detail of how the operator's
 * own machines are being measured.
 */
export const viewerFacing = ({id, name, provider, enabled, sortOrder,
    optimalPing, optimalDownload, optimalUpload}) =>
    ({id, name, provider, enabled, sortOrder, optimalPing, optimalDownload, optimalUpload});

const LIST_ORDER = [["sortOrder", "ASC"], ["id", "ASC"]];

export const listAll = async () => await targets.findAll({order: LIST_ORDER});

export const getOne = async (id) => await targets.findOne({where: {id}});

/**
 * The local targets indexed both ways, for the history backup round trip.
 *
 * A history backup carries each row's `targetId`, and that id belongs to the
 * instance that wrote the file. Read back somewhere else it does not merely
 * fail to mean anything - it means something wrong. Restored onto an instance
 * that already measures its own lines, every row the old instance measured
 * against "Ookla Frankfurt" carries targetId 1 and is handed to whatever holds
 * id 1 here: from then on it is returned by GET /speedtests?target=1, graded
 * against that target's optimal values, counted into its statistics, sampled
 * by listSuccessful for its recommendations and exported under its name, with
 * nothing in the interface or in the import's counts saying a re-attribution
 * happened.
 *
 * So the export writes the target's *name* beside every row - the one part of
 * a target that survives a move between instances - and this index is what the
 * import resolves that name against.
 *
 * Maps rather than plain objects, and not for tidiness: the names are what an
 * operator typed, so on an object `byName["toString"]` answers with
 * Object.prototype's own function and `byName["__proto__"] = 3` sets a
 * prototype instead of a key. That is the trap targetProblem, importConfig and
 * the integrations controller were each fixed for separately, and a
 * hand-edited backup is the shortest route to it. `byId` is keyed by numbers
 * out of our own column, but an import older than the rule below could leave a
 * string there, and the rows it wrote are in the table still - so it gets the
 * same treatment.
 *
 * Pure over the rows, so the rule below can be asked without a database.
 */
export const targetIndex = (rows) => {
    const byName = new Map();
    const byId = new Map();

    for (const target of rows) {
        byId.set(target.id, target.name);

        // Nothing stops two targets sharing a name, so the first in round
        // order wins - the one the interface lists first. A duplicate name is
        // already ambiguous to a reader; what this settles is that the answer
        // does not depend on the order the rows happen to come back in.
        if (!byName.has(target.name)) byName.set(target.name, target.id);
    }

    return {byName, byId};
};

/** The same index over the stored targets. */
export const readTargetIndex = async () => targetIndex(await listAll());

/**
 * Which local target a restored history row belongs to, or null for an orphan.
 *
 * A backup's `targetId` values belong to the instance that wrote the file.
 * Written through onto a different one they do not merely fail to mean
 * anything - they mean something wrong: every row the old instance measured
 * against "Ookla Frankfurt" carries targetId 1 and is handed to whatever holds
 * id 1 here. From then on it is returned by GET /speedtests?target=1, graded
 * against that target's optimal values, counted into its statistics, sampled
 * by listSuccessful for its recommendations and re-exported under its name,
 * and nothing in the interface or in the import's counts says a re-attribution
 * happened.
 *
 * So the row's own id is not read at all. What is read is the target *name*
 * the export writes beside every row - the one part of a row's attribution
 * that means the same thing on both instances - resolved against the targets
 * this instance holds. Always, and that word is the design: the same file
 * landing on the same targets is attributed the same way whether the history
 * table is empty or holds two years, whether this is the first attempt at the
 * import or the fourth.
 *
 * Because the alternative was tried three times and fails in disaster
 * recovery, which is the one flow a history backup exists for. Every rule that
 * also consulted the state of the destination - "an empty history means this
 * instance is being rebuilt, so keep the file's own ids" - gives two different
 * answers to one file, and something ordinary flips it mid-recovery:
 *
 *   - A rebuild that sat through a cron tick. The scheduled round is a cron
 *     expression, not an interval: DEFAULTS.cron in config.js is "0 * * * *",
 *     so a reinstall at :55 records a round of its own five minutes later. The
 *     table is no longer empty, the rule changes, and the restore begun after
 *     that orphans the rows the same restore begun before it kept.
 *
 *   - An import that is retried or split. RequestUtil aborts a request after
 *     REQUEST_TIMEOUT while importTests commits chunk by chunk on purpose, so
 *     a large restore can leave part of the file written and still report an
 *     error - and the operator's next move is to import the same file again,
 *     onto a table the first attempt made non-empty. IMPORT_BODY_LIMIT forces
 *     the same shape on any history above 50mb, which cannot arrive in one
 *     PUT at all.
 *
 * A name lookup cannot do that: it reads the row and the targets table, and
 * neither is changed by how far a previous attempt got.
 *
 * On a same-instance restore the answer is the id the row started with - the
 * export wrote the name that id resolved to, and the configuration backup puts
 * the targets back under their own ids. What it costs is a target renamed
 * between the export and the import: its rows resolve to nothing and land
 * unattributed. That is visible and explicable - they show in the history and
 * in every "all targets" view with no target rather than under a wrong one,
 * and the file still holds the truth - which is exactly what a row filed under
 * a live target that never measured it is not.
 *
 * null, then, whenever the name is missing or answers to nothing here. A file
 * written by an instance older than the export's targetName column carries no
 * name on any row, so every row of such a file is imported unattributed; there
 * is deliberately no fallback to the raw `targetId`, because trusting that id
 * is the silent re-attribution this rule exists to end.
 *
 * Pure over an index of the local targets, because which target a name means
 * is a judgement about targets and this suite can neither mock modules nor
 * reach a database from tests/server. That index is a Map: the names are what
 * an operator typed, and on a plain object `byName["toString"]` answers with
 * Object.prototype's own function - the trap targetProblem, importConfig and
 * the integrations controller were each fixed for separately.
 */
export const importedTargetId = ({targetName}, {byName}) => {
    // Only a string can be a name. A Map would answer undefined for a number
    // or an object anyway, but the guard says so rather than leaving it to
    // luck, and it keeps this readable as the one thing it is - a name lookup,
    // with no branch anywhere that reads the row's id.
    if (typeof targetName !== "string") return null;

    return byName.get(targetName) ?? null;
};

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
 * Which line an instance-wide surface speaks for, as the whole preference
 * rather than as its winner.
 *
 * The recommendation card and the public preview image both have to name a
 * single line - a gigabit LAN box averaged into a WAN figure describes
 * neither - and both were spelling this preference out for themselves, in two
 * files, each with a comment saying it was the same rule as the other's. It
 * has one home so that a change to which line an instance headlines cannot
 * land in one of them and not the other.
 *
 * In order: the first scheduled target that alerts; then any target that
 * alerts, scheduled or not, because a manual-only target still describes a
 * line somebody watches and a scheduled one with alerts off does not; then
 * the round's leader; then the first target on record. Empty only when there
 * are no targets at all.
 *
 * The whole sequence, because "prefers" must not mean "or nothing" and each
 * surface asks a different question of the line it lands on. The card wants
 * one with a full sample of successful tests; the preview image wants one with
 * rows in the two days it averages. Resolved to a single answer here, a
 * preferred line that could not answer the caller's question was the end of it:
 * the recommendations sat frozen at whatever they held before, for the life of
 * the database, while a scheduled line beside them measured every hour. So
 * each caller walks this with its own predicate, and the ranking stays in one
 * place.
 *
 * Read loosely, because sqlite hands booleans back as 0/1 under the global raw
 * mapping and a strict comparison would match nothing.
 *
 * Deliberately not isPrimaryMember's question, which asks which member owns
 * the instance-wide *surfaces* - the base MQTT topic, the unlabelled
 * Prometheus series - and answers by round order alone, with no preference
 * about alerting at all.
 */
export const headlineOrder = async () => {
    const all = await listAll();

    const tiers = [
        (target) => target.alerts && target.enabled,
        (target) => target.alerts,
        (target) => target.enabled,
        () => true
    ];

    const ordered = [];

    for (const tier of tiers)
        for (const target of all)
            if (tier(target) && !ordered.includes(target)) ordered.push(target);

    return ordered;
};

/**
 * Whether this edit is the one that takes the base MQTT topic quiet.
 *
 * The base topic speaks for the instance's first line on record and for no
 * other, deliberately: moving it as targets are scheduled and unscheduled
 * hands one line's Home Assistant entities to another line's numbers, and the
 * retained discovery configs are keyed to the topic, so no correction is ever
 * announced. isPrimaryMember's docstring holds the full reasoning.
 *
 * The cost of that rule is that unscheduling the first line - an ordinary
 * thing to do to a line during an outage - takes the topic quiet, and every
 * entity announced from it keeps its last value with nothing anywhere saying
 * why. The interface has no way to show that, so the operator doing it is told.
 *
 * Only on the edit that changes it, so a later edit to a row already
 * unscheduled does not repeat something the operator has been told.
 */
export const quietsBaseTopic = async (current, fields) => {
    if (fields.enabled === undefined || fields.enabled || !current.enabled) return false;

    return (await listAll())[0]?.id === current.id;
};

/**
 * Which targets' stored rows the alerting speaks for, as ids - or null when the
 * question does not apply because no target exists at all.
 *
 * The keep-alive reads the last test to decide whether healthchecks.io's check
 * should stay down, and it read the last test *of the instance*. With one
 * provider that was the same question. With targets it is not: a diagnostic
 * iperf3 box with alerts off - the case this file's model docstring describes -
 * fails because the machine is asleep, sends no failure notification because of
 * the flag, and is then the newest row in the table. The keep-alive pinged
 * /fail once a minute for the whole hour until the next round, so the uptime
 * monitor reported the internet line down on behalf of a target the operator
 * had explicitly opted out of alerting.
 *
 * Every target that alerts, enabled or not. `enabled` decides membership of the
 * scheduled round; `alerts` decides whether anything is said about a result -
 * and a disabled target is still runnable by hand, so its failure still sends
 * the testFailed that puts the check down. A scope that left it out could never
 * take the check back up again.
 *
 * The two empty answers are different questions and must not be spelled the
 * same way. An empty list means targets exist and none of them alert: nothing
 * is being watched, there is nothing to report, and the instance-wide latest
 * would be precisely the row that has to be ignored. `null` means there is no
 * target at all - a pre-migration install, and the demo, whose rows carry no
 * targetId - and for those the instance-wide latest is the only answer there
 * is.
 *
 * Pure and exported, because that distinction is the whole of the fix and
 * deserves a test that needs no database.
 */
export const alertingScope = (targets) => targets.length === 0
    ? null
    : targets.filter((target) => target.alerts).map((target) => target.id);

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
    iperfDuration: target.iperfDuration ?? null,
    iperfStreams: target.iperfStreams ?? null,
    iperfUdp: target.iperfUdp ?? false,
    iperfBitrate: target.iperfBitrate ?? null,
    sortOrder: target.sortOrder ?? await nextSortOrder(),
    created: new Date().toISOString()
});

const nextSortOrder = async () => {
    const last = await targets.findOne({order: [["sortOrder", "DESC"]]});
    return last ? last.sortOrder + 1 : 0;
};

// The name is trimmed on this path the way create() and importConfig trim
// theirs: a padded PATCH otherwise survives into the table, and the history
// backup then exports " Ookla " beside rows a restore looks up as "Ookla" -
// an exact match byName can never make, so every one of those rows restores
// unattributed.
export const update = async (id, changes) => {
    const sanitized = typeof changes.name === "string"
        ? {...changes, name: changes.name.trim()}
        : changes;

    return await targets.update(sanitized, {where: {id}});
};

/**
 * Whether another target already wears this name.
 *
 * The name is the key the history backup files rows under - importedTargetId
 * keeps the first id in round order for a shared one, so two targets wearing
 * the same name silently merge their histories on the next restore. Refused
 * at the door instead. Compared trimmed and exactly, the way byName matches.
 */
export const nameTaken = async (name, excludeId = undefined) =>
    (await listAll()).some((row) =>
        row.id !== excludeId && String(row.name).trim() === String(name).trim());

export const deleteTarget = async (id) => await targets.destroy({where: {id}});

/**
 * Whether an id sequence is every target exactly once - the only thing reorder
 * may safely act on.
 *
 * A short list leaves the targets it omits on their old sortOrder, colliding
 * them with the ones it renumbers from zero; a duplicate leaves a target
 * unranked; a foreign id renumbers nothing but stands in for a real one that is
 * then missing. All three end in an order nobody chose, and since sortOrder is
 * the identity reorder's own docblock guards, the door is where they are
 * refused. The length guards a short or padded list, the Set size a duplicate,
 * and the membership a foreign id.
 */
export const coversAll = async (ids) => {
    const existing = await targets.findAll({attributes: ["id"]});
    const provided = new Set(ids);

    return provided.size === ids.length
        && ids.length === existing.length
        && existing.every((row) => provided.has(row.id));
};

/**
 * Rewrites the round order to the given id sequence; unknown ids are ignored.
 *
 * All of it or none of it: one UPDATE per id with nothing around them left
 * half the list renumbered when a write failed partway - an order the
 * operator never asked for, decided by where the loop died. And sortOrder is
 * not only presentation: it decides listAll()[0], which is the base MQTT
 * topic's owner and the unlabelled Prometheus series - the identity
 * isPrimaryMember exists to hold still.
 */
export const reorder = async (ids) => {
    await db.transaction(async (transaction) => {
        for (const [index, id] of ids.entries())
            await targets.update({sortOrder: index}, {where: {id}, transaction});
    });
};

export const removeAll = async (transaction = undefined) =>
    await targets.destroy({where: {}, transaction});

export const count = async () => await targets.count();
