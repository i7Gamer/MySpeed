import { spawn as spawnProcess } from 'node:child_process';
import net from 'node:net';
import { hasExited, isShuttingDown as serverShuttingDown, terminate, trackProcess, untrackProcess } from './speedtest.js';
import { splitEndpoint } from './providers/registry.js';
import { latencyMeets } from './targetLimits.js';
import { toErrorMessage } from './helpers.js';

/**
 * The route to the test server, hop by hop, for a run that went badly.
 *
 * A failed test or a slow one says that something between this machine and
 * the server was wrong, and nothing more. The hop table says where: a first
 * hop that never answers is the Wi-Fi or the router, a gap after the second
 * is the provider's gateway, and a run of stars far out is somebody else's
 * exchange. MySpeed does not read the table - it cannot, since operators that
 * drop ICMP make a healthy hop look dead - but a person can, and this is what
 * puts it in front of them.
 *
 * The operating system's own tool, not a bundled one. tracert ships with
 * every Windows, traceroute with macOS and most Linux installs, and tracepath
 * is what the Docker image gets, because it needs no raw socket and the
 * container runs as an unprivileged user. A tool that is not there fails to
 * spawn at once, is remembered for the life of the process, and costs nothing
 * afterwards.
 */

/** How far out to look. Twenty hops reaches any speedtest server on earth. */
export const MAX_HOPS = 20;

/**
 * How long one probe waits for an answer. A hop that has not answered in a
 * second is either dropping probes or slower than any latency this app would
 * call a spike, and the table can say "lost" either way.
 */
export const PROBE_WAIT_SECONDS = 1;

/**
 * tracert's own wait, in its own unit, and shorter than the Unix one: it
 * sends three probes a hop with no way to send fewer, so a dead hop costs
 * three of these, and twenty dead hops must still finish inside the deadline.
 */
export const WINDOWS_PROBE_WAIT_MS = 500;

/**
 * The whole trace's deadline. Twenty dead hops on Windows at three probes of
 * half a second is thirty seconds, which this just covers; anything slower is
 * killed and the hops it did print are kept. Held inside the gap to the next
 * scheduled run, and the shutdown terminates the trace like any other child,
 * so this is a ceiling on wasted time rather than on anything the server
 * waits for.
 */
export const TRACE_TIMEOUT_MS = 30_000;

/**
 * How much output is read before the tool is stopped. A real table is a few
 * kilobytes; a tool that prints more than this is not printing a table.
 */
export const MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * What a hop's "<1 ms" is recorded as. tracert prints nothing finer than a
 * millisecond and marks anything under one this way; a figure is what the
 * table stores, and one millisecond is the honest ceiling on it.
 */
export const UNDER_ONE_MS = 1;

/**
 * Where a failure traces to when the run parsed no server and the target pins
 * none: the provider's own front door, which is on the same side of the
 * internet as its fleet and answers a trace from anywhere.
 *
 * iperf3 has none, since its server is a host the operator runs; a target
 * with no endpoint is not traced.
 */
export const TRACE_FALLBACK_HOSTS = Object.freeze({
    ookla: "www.speedtest.net",
    cloudflare: "speed.cloudflare.com",
    libre: "librespeed.org"
});

/** Why a run earned a trace, in the order the verdict ranks them. */
export const TRACE_REASONS = Object.freeze({
    failed: "failed",
    baseline: "baseline",
    latency: "latency"
});

/**
 * Which tools to try, in order, per platform. Every option is fixed and the
 * host is the last argument, so a host is never read as an option whatever it
 * starts with - and isTraceableHost refuses the ones that could be anyway.
 *
 * -n / -d: no name resolution, which costs a DNS round trip per hop and puts a
 * name where the parser wants an address. -q 1: one probe per hop, so a dead
 * hop costs one wait rather than three. tracepath has no probe count or wait
 * to set, only the hop ceiling.
 */
export const traceCommands = (host, platform = process.platform) => {
    const hops = String(MAX_HOPS);

    if (platform === "win32")
        return [{file: "tracert", args: ["-d", "-w", String(WINDOWS_PROBE_WAIT_MS), "-h", hops, host]}];

    const traceroute = {file: "traceroute", args: ["-n", "-q", "1", "-w", String(PROBE_WAIT_SECONDS), "-m", hops, host]};

    if (platform === "darwin") return [traceroute];

    return [traceroute, {file: "tracepath", args: ["-n", "-m", hops, host]}];
};

/**
 * A host the tool can be handed as its last argument: a name or an address,
 * nothing that starts like an option, no whitespace. Brackets are refused
 * because they are endpoint notation rather than an address - hostOf strips
 * them before anything gets here.
 */
const HOST_SHAPE = /^[A-Za-z0-9][A-Za-z0-9.:-]*$/;

export const isTraceableHost = (host) => typeof host === "string" && HOST_SHAPE.test(host);

/**
 * The host inside whatever a provider stored: a URL for a librespeed backend,
 * host:port for an ookla server or an iperf3 endpoint, a bare name or address
 * for anything else. Null when nothing usable is in it.
 */
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

const hostOf = (value) => {
    if (typeof value !== "string" || value.trim() === "") return null;

    let host;

    if (URL_SCHEME.test(value)) {
        try {
            host = new URL(value).hostname;
        } catch {
            return null;
        }
    } else {
        host = splitEndpoint(value).host;
    }

    // URL.hostname keeps an IPv6 literal's brackets; splitEndpoint removes them.
    if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);

    return isTraceableHost(host) ? host : null;
};

/**
 * Where to trace to.
 *
 * The server the run used, when the run parsed one - the row's serverHost,
 * in the provider's own spelling. A failure parsed nothing, so the target says
 * where the run would have gone: the ookla server it pins, looked up in the
 * server list, or its own endpoint. The provider's front door is what is left.
 *
 * @param target     the round member, as stored
 * @param serverHost what the run's parser stored, on a success
 * @param servers    the provider's server list, keyed by id, for a pinned ookla server
 */
export const traceHost = (target, {serverHost = null, servers = {}} = {}) => {
    const provider = target?.provider;

    if (provider === "preview") return null;

    if (serverHost !== null) return hostOf(serverHost);

    if (provider === "ookla") {
        const pinned = target.serverId ? servers?.[target.serverId]?.host : null;
        return hostOf(pinned) ?? TRACE_FALLBACK_HOSTS.ookla;
    }

    if (provider === "libre") return hostOf(target.endpoint) ?? TRACE_FALLBACK_HOSTS.libre;

    if (provider === "iperf3") return hostOf(target.endpoint);

    return TRACE_FALLBACK_HOSTS[provider] ?? null;
};

/**
 * Whether a run is worth a trace, and why.
 *
 * A failure, unless the provider refused the run for being asked too often -
 * that fault is at the provider and a route to it says nothing. A success
 * whose line fell under its own rolling baseline. And a success whose latency
 * the screen would not paint green, judged by the same rule the screen uses
 * so that this is not a fourth spelling of it.
 *
 * @param failed           whether the run failed for good
 * @param rateLimited      whether that failure was the provider's refusal
 * @param baselineBreached the baseline verdict off the payload, or null/absent
 * @param ping             the measured latency, on a success
 * @param limits           resolveLimits' answer for this member
 */
export const degradedRun = ({failed = false, rateLimited = false, baselineBreached = null, ping = null, limits = {}} = {}) => {
    if (failed) return rateLimited ? null : TRACE_REASONS.failed;

    if (baselineBreached === true) return TRACE_REASONS.baseline;

    if (latencyMeets(ping, limits.ping ?? null) === false) return TRACE_REASONS.latency;

    return null;
};

/**
 * A line of the table: a hop number, then whatever the tool printed for it.
 * The number is the whole of what the parser recognises a hop by - every
 * tool starts its hop lines with one, and nothing else it prints does. The
 * colon is tracepath's; "1?:" is tracepath's own pmtu line and is not a hop.
 */
const HOP_LINE = /^\s*(\d+)(?::|\s)\s*(.*)$/;

/** A latency: a figure and its unit, with tracert's "<1" for under a millisecond. */
const LATENCY = /(<?)(\d+(?:[.,]\d+)?)\s*ms\b/g;

/** A probe that never came back. */
const LOST_PROBE = /(?:^|\s)\*(?=\s|$)/g;

const ADDRESS_WRAPPING = /^[[(]|[\])]$/g;

/**
 * The first token on the line that is an address. Never a word: tracert
 * prints its timeouts in the service's language, and a name beside an
 * address is a name.
 */
const addressIn = (rest) => {
    for (const token of rest.split(/\s+/)) {
        const bare = token.replace(ADDRESS_WRAPPING, "");
        if (net.isIP(bare) !== 0) return bare;
    }

    return null;
};

/**
 * The most latencies one hop may carry. Every tool probes a hop a handful
 * of times - three by default, one under the flags used here - and the
 * parser merges a hop's lines and cuts at this, so a hop past it is a
 * hand-edited file, and the pane draws a span per latency.
 */
export const MAX_RTT_PER_HOP = 10;

/**
 * The tool's output as a table.
 *
 * `[{hop, address, rtt, lost}]` in the order printed: the address that
 * answered or null, every latency it answered with, and how many probes never
 * came back. Lines of one hop are merged, since tracepath prints one per
 * probe. Nothing here matches a word, which is what keeps a German service's
 * tracert readable by the same code as an English one's.
 */
export const parseTrace = (output) => {
    const hops = [];
    const byNumber = new Map();

    for (const line of String(output ?? "").split(/\r?\n/)) {
        const match = HOP_LINE.exec(line);
        if (match === null) continue;

        const number = Number(match[1]);
        const rest = match[2];

        // A hop is numbered from one; a zero is a tool printing its own
        // interface, and isHopTable refuses it - so it must not be produced.
        if (number <= 0) continue;

        const rtt = [...rest.matchAll(LATENCY)]
            .map(([, under, figure]) => under ? UNDER_ONE_MS : Number(figure.replace(",", ".")));
        const address = addressIn(rest);
        let lost = (rest.match(LOST_PROBE) ?? []).length;

        // tracepath's "no reply" and anything else with neither an answer
        // nor a star: one probe, and it was lost.
        if (lost === 0 && address === null && rtt.length === 0) lost = 1;

        const known = byNumber.get(number);

        if (known) {
            // Capped where the readers cap it: tracepath prints one line per
            // probe, and a hop that answered eleven of them is a table the
            // pane, both exports and the import all refuse.
            known.rtt.push(...rtt.slice(0, Math.max(0, MAX_RTT_PER_HOP - known.rtt.length)));
            known.lost += lost;
            if (known.address === null) known.address = address;
            continue;
        }

        if (hops.length >= MAX_HOPS) break;

        const hop = {hop: number, address, rtt: rtt.slice(0, MAX_RTT_PER_HOP), lost};
        hops.push(hop);
        byNumber.set(number, hop);
    }

    return hops;
};

const isCount = (value) => Number.isInteger(value) && value >= 0;

/**
 * Whether a value is a table the parser could have produced - and so one
 * every reader may dereference: at most MAX_HOPS hops, each with a positive
 * integer number, an address string or null, a list of finite non-negative
 * latencies and a count of lost probes.
 *
 * The parser is the one honest writer of the column, but the history import
 * writes it too, from whatever a file holds, and a row that reaches the
 * detail pane with one malformed hop takes the whole pane down with it.
 */
export const isHopTable = (value) =>
    Array.isArray(value) && value.length <= MAX_HOPS && value.every((hop) =>
        hop !== null && typeof hop === "object" && !Array.isArray(hop)
        && Number.isInteger(hop.hop) && hop.hop > 0
        && (hop.address === null || typeof hop.address === "string")
        && Array.isArray(hop.rtt) && hop.rtt.length <= MAX_RTT_PER_HOP
        && hop.rtt.every((rtt) => Number.isFinite(rtt) && rtt >= 0)
        && isCount(hop.lost))
    // Numbered once each: the parser merges a hop's lines, and the pane keys
    // its rows on the number.
    && new Set(value.map((hop) => hop.hop)).size === value.length;

// Tools that failed to spawn, by file name, for the life of the process.
const missingTools = new Set();

/** Clears the memory of missing tools. Exists for the tests. */
export const resetMissingTools = () => missingTools.clear();

/**
 * Runs one tool to completion, or to the deadline, or to the output ceiling.
 *
 * Resolves with what it printed and whether the spawn itself failed, and
 * never rejects: the caller decides what an empty table means. The child is
 * the process the shutdown terminates while it runs - the trace only starts
 * after the speedtest CLI has exited, so the one slot is free, and a trace
 * that was not in it would outlive a Windows service that stopped.
 */
const runTool = ({file, args}, {spawn, timeoutMs, track, untrack}) => new Promise((resolve) => {
    let child;
    let output = "";
    let settled = false;
    let missing = false;
    // Whether the tool was ended rather than ending: by the deadline, the
    // output ceiling, or the shutdown that terminates every tracked child.
    let stopped = false;

    const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (child) untrack(child);
        resolve({output, missing, stopped});
    };

    const stop = () => {
        stopped = true;
        if (child && !hasExited(child)) terminate(child);
    };

    try {
        child = spawn(file, args, {windowsHide: true, stdio: ["ignore", "pipe", "ignore"]});
    } catch (error) {
        missing = error?.code === "ENOENT";
        resolve({output, missing, error});
        return;
    }

    track(child);

    const deadline = setTimeout(stop, timeoutMs);
    deadline.unref?.();

    child.stdout.on("data", (chunk) => {
        if (output.length >= MAX_OUTPUT_BYTES) return;

        output += chunk.toString();

        if (output.length >= MAX_OUTPUT_BYTES) {
            output = output.slice(0, MAX_OUTPUT_BYTES);
            stop();
        }
    });

    child.on("error", (error) => {
        if (error?.code === "ENOENT") missing = true;
        else console.error(`Could not run ${file}: ${toErrorMessage(error)}`);
    });

    // Node emits 'close' after 'error' for a spawn that failed, so a missing
    // tool ends here too.
    // A close with no exit code is a child ended by a signal - the
    // shutdown's, when it was not this deadline's.
    child.on("close", (code) => {
        if (code === null) stopped = true;
        finish();
    });
});

/**
 * The route to a host, as a table, or null.
 *
 * Tries the platform's tools in order, skipping the ones already known to be
 * missing and moving on from one that ran to its end and printed no table.
 * Null for a host the tools cannot be handed, for tools that are all missing
 * or silent, for a tool ended by its deadline, and for a server that is
 * shutting down - which is checked here, immediately before the spawn, so a
 * trace cannot start after the moment the shutdown terminated everything it
 * knew about.
 *
 * The exit code is not consulted: a tool that printed hops and then failed -
 * a refused raw socket after a partial table, an unreachable target - still
 * printed hops, and they are what the reader wants.
 */
export const runTrace = async (host, {
    spawn = spawnProcess, platform = process.platform, timeoutMs = TRACE_TIMEOUT_MS,
    isShuttingDown = serverShuttingDown, track = trackProcess, untrack = untrackProcess
} = {}) => {
    if (!isTraceableHost(host)) return null;

    // One deadline for the whole trace, not one per tool. Linux offers two
    // tools, and since a tool that ends on its own having printed nothing
    // falls through to the next, a per-tool deadline let one trace spend
    // two of them - and the round's latch with it.
    const deadline = Date.now() + timeoutMs;

    for (const command of traceCommands(host, platform)) {
        if (missingTools.has(command.file)) continue;
        if (isShuttingDown()) return null;

        const remaining = deadline - Date.now();
        if (remaining <= 0) return null;

        const {output, missing, stopped} = await runTool(command, {spawn, timeoutMs: remaining, track, untrack});

        if (missing) {
            missingTools.add(command.file);
            console.log(`${command.file} is not installed, so no route can be traced with it`);
            continue;
        }

        const hops = parseTrace(output);
        if (hops.length > 0) return hops;

        // Ended by the deadline, the ceiling or the shutdown: the budget is
        // spent, and a second tool would spend it again.
        if (stopped) return null;

        // Ran to its end and printed no table: traceroute without the raw
        // socket it needs writes its refusal to stderr and nothing to
        // stdout, and tracepath is there for exactly that case. The next
        // tool gets its turn; the last one's silence is the answer.
    }

    return null;
};
