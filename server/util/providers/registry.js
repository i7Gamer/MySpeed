import path from 'node:path';
import * as loadOokla from './loadOokla.js';
import * as loadLibre from './loadLibre.js';
import * as loadCloudflare from './loadCloudflare.js';
import * as loadIperf3 from './loadIperf3.js';

/**
 * How long each LibreSpeed measurement phase runs, in seconds.
 *
 * librespeed-cli's own default. It ran at 5 for a while, and upstream #694's
 * doubled upload readings are what a window that short looks like: TCP spends
 * its first seconds filling buffers at above line rate, and on a five-second
 * sample that spike is most of the average. Three times the data per run is
 * the price of a number that means anything.
 */
export const LIBRE_DURATION_SECONDS = 15;

/**
 * How long each iperf3 direction runs, how many streams carry it, and how much
 * of the start is thrown away.
 *
 * Ten seconds is iperf3's own default and the figure every published
 * measurement is quoted at. It is per direction, so a test costs twice this
 * plus the latency sample - comfortably inside the run's own timeout.
 *
 * The omitted seconds are TCP slow start: the connection spends its first
 * moments discovering how fast it may go, and averaging that in reports less
 * than the line carries. iperf3 measures them and leaves them out rather than
 * simply starting late, which is why the figure is `--omit` rather than a
 * shorter `--time`.
 */
export const IPERF_DURATION_SECONDS = 10;
export const IPERF_STREAMS = 4;
export const IPERF_OMIT_SECONDS = 1;

/**
 * How long the control connection may take to come up.
 *
 * Without it a host that accepts nothing - the usual case for a LAN target
 * that has been switched off - holds the run until its own three-minute
 * timeout, which is reported as a test that did not finish rather than as a
 * server that could not be reached. In milliseconds, as iperf3 takes it.
 */
export const IPERF_CONNECT_TIMEOUT_MS = 5000;

/** iperf3's own default port, used when a target names a host and no port. */
export const IPERF_DEFAULT_PORT = 5201;

/**
 * The range a TCP port number falls in.
 *
 * targetProblem holds an endpoint to the same bounds at the door, so a stored
 * target has already passed them; this is for the reading, which also runs on
 * values that never went through the door - a legacy fold, a restored backup.
 */
const LOWEST_PORT = 1;
const HIGHEST_PORT = 65535;

const isPort = (value) => Number.isInteger(value) && value >= LOWEST_PORT && value <= HIGHEST_PORT;

/**
 * A target's `host:port`, split - with iperf3's default port when it names
 * only a host.
 *
 * Exported because the same reading has to be made twice from different
 * places: here, to build the arguments, and by the runner, to know where to
 * time its handshakes. Two readings of one string is two chances to disagree
 * about which port was meant.
 *
 * The last colon separates them, so a bracketed IPv6 literal keeps its own.
 */
export const splitEndpoint = (endpoint) => {
    const value = String(endpoint ?? "").trim();

    /*
     * A bracketed literal is answered whole, before the port question is asked.
     *
     * The brackets are the URL spelling of an address and never part of the
     * host that is dialled, but they used to come off only on the branch that
     * also parses a port. "[fd00::1]" has its last colon inside the literal, so
     * it took the no-port branch below and kept them - and since
     * iperfEndpointProblem accepts that spelling, the target was created,
     * scheduled, and handed "[fd00::1]" to --client, which getaddrinfo cannot
     * resolve. It could never produce a measurement.
     */
    const closing = value.startsWith("[") ? value.indexOf("]") : -1;

    if (closing !== -1) {
        const host = value.slice(1, closing);
        const rest = value.slice(closing + 1);

        if (rest === "") return {host, port: IPERF_DEFAULT_PORT};

        const bracketedPort = rest.startsWith(":") ? Number(rest.slice(1)) : NaN;

        return isPort(bracketedPort) ? {host, port: bracketedPort}
            : {host, port: IPERF_DEFAULT_PORT};
    }

    const separator = value.lastIndexOf(":");

    // No colon at all, or the only colons are inside an unbracketed IPv6
    // literal - which is a host, not a host and a port.
    if (separator === -1 || value.indexOf(":") !== separator)
        return {host: value, port: IPERF_DEFAULT_PORT};

    const port = Number(value.slice(separator + 1));

    if (!isPort(port)) return {host: value, port: IPERF_DEFAULT_PORT};

    return {host: value.slice(0, separator), port};
};

/**
 * One descriptor per provider - the whole of what makes a provider one.
 *
 * The providers used to be named in twelve places: a binary-path ternary, an
 * args if/else chain, two loader maps, a result-shape check, a progress
 * gate, a server-list switch, a route allow-list, and their client mirrors.
 * Adding a provider meant finding all twelve, and the ternary's else branch
 * meant a mode nobody added still got cfspeedtest's binary path and failed
 * naming the wrong file. Here, a provider is one entry, and a mode that has
 * no entry throws by name.
 *
 * buildArgs is pure: it answers the argv plus, for a libre custom backend,
 * the server file the runner has to write first - as {path, content}, so the
 * side effect stays where the process lifecycle (and the cleanup in finish())
 * already lives. `platform` is injectable for the tests.
 */

const CUSTOM_LIBRE_SERVER = [{
    id: 1,
    name: "Custom Server",
    server: null,
    dlURL: "garbage.php",
    ulURL: "empty.php",
    pingURL: "empty.php",
    getIpURL: "getIP.php"
}];

export const REGISTRY = {
    ookla: {
        binaryName: "speedtest",
        loader: loadOokla,
        listName: "Ookla",
        serverList: "ookla",
        streamsProgress: true,
        buildArgs(target, iface, {platform = process.platform} = {}) {
            // jsonl rather than json: the CLI reports each phase as it goes
            // instead of only the finished result, which is what the
            // interface follows a run with.
            const args = ['--accept-license', '--accept-gdpr', '--format=jsonl'];

            if (platform === "win32") args.push('--ip=' + iface.address);
            else args.push('--interface=' + iface.name);

            if (target.serverId) args.push(`--server-id=${target.serverId}`);

            return {args, temporaryServer: null};
        },
        isResult: (data) => data.type === "result"
    },
    libre: {
        binaryName: "librespeed-cli",
        loader: loadLibre,
        listName: "librespeed",
        serverList: "libre",
        streamsProgress: false,
        buildArgs(target, iface) {
            const args = ['--json', '--duration=' + LIBRE_DURATION_SECONDS, '--source=' + iface.address];

            if (target.endpoint) {
                const file = path.join('data', 'servers', 'libre_custom.json');
                const config = [{...CUSTOM_LIBRE_SERVER[0], server: target.endpoint}];

                args.push(`--local-json=${file}`, '--server=1');

                return {args, temporaryServer: {path: file, content: JSON.stringify(config)}};
            }

            if (target.serverId) args.push(`--server=${target.serverId}`);

            return {args, temporaryServer: null};
        },
        isResult: () => true
    },
    cloudflare: {
        binaryName: "cfspeedtest",
        loader: loadCloudflare,
        listName: "Cloudflare",
        serverList: null,
        streamsProgress: false,
        buildArgs(target, iface) {
            const args = ['--output-format=json'];

            args.push((iface.address.includes(':') ? '--ipv6=' : '--ipv4=') + iface.address);

            return {args, temporaryServer: null};
        },
        // A top-level array is not a result cloudflare produces, and spreading
        // one gives an object keyed by index that the parser quietly reads as
        // a measurement of zero.
        isResult: (data) => !Array.isArray(data)
    },
    iperf3: {
        binaryName: "iperf3",
        loader: loadIperf3,
        listName: "iperf3",
        // Nothing to list: an iperf3 server is a host the operator runs, named
        // on the target itself, not one of a provider's published fleet.
        serverList: null,
        streamsProgress: true,
        /*
         * Fetched the first time a target actually uses it, rather than at
         * boot with the others.
         *
         * The three speedtest CLIs are what a default install measures with,
         * so having them on disk before the first scheduled run is worth the
         * download. iperf3 measures against a server the operator runs
         * themselves, which most instances do not have - and the static build
         * is some sixteen megabytes. ensureBinary already asks the loader
         * before every run and costs one existsSync once the file is there, so
         * an instance that does add an iperf3 target gets it on the first test
         * rather than never.
         */
        downloadedOnDemand: true,
        /*
         * iperf3 measures throughput and reports no latency of any kind, where
         * the other three talk to a backend that answers one. The runner
         * measures it instead - see iperfLatency - because the ping column is
         * not optional: every row on the overview is graded on one, and
         * storing the failure placeholder on a run that succeeded would read
         * as a broken line.
         */
        providesLatency: false,
        // One direction per invocation - see runsOf. The download runs first,
        // as it does for every other provider, so the phases the interface
        // shows arrive in the order it draws them.
        runs: [
            {key: "download", args: ["-R"]},
            {key: "upload", args: []}
        ],
        buildArgs(target, iface) {
            const {host, port} = splitEndpoint(target.endpoint);

            const args = [
                '--client', host,
                '--port', String(port),
                // Line-delimited, which is what the shared parser reads and
                // what carries the interval records the progress bar follows.
                // Plain --json pretty-prints one object across many lines, and
                // none of them parse on their own.
                '--json-stream',
                '--time', String(IPERF_DURATION_SECONDS),
                // Several streams, because one TCP connection is limited by
                // its window over a long fat path and will under-report a fast
                // line badly. Four is what a speedtest does.
                '--parallel', String(IPERF_STREAMS),
                // The first seconds are TCP working out how fast it may go,
                // and averaging them in reports less than the line carries.
                '--omit', String(IPERF_OMIT_SECONDS),
                // Bounds the one thing that would otherwise hang until the
                // run's own three-minute timeout: a host that accepts nothing.
                '--connect-timeout', String(IPERF_CONNECT_TIMEOUT_MS),
                // The interface every other provider is also bound to, so the
                // measurement describes the line the instance is watching.
                '--bind', iface.address
            ];

            return {args, temporaryServer: null};
        },
        // The end event, and only one that carried something: a run that fails
        // reports {"event":"error",...} and then an empty end event, and
        // taking that for the result would store a failure as a test that
        // produced nothing.
        isResult: (data) => data.event === "end" && data.data
            && Object.keys(data.data).length > 0,
        errorOf: (data) => data.event === "error" ? data.data : undefined
    }
};

export const providerIds = () => Object.keys(REGISTRY);

export const descriptor = (mode) => {
    // Object.hasOwn rather than truthiness on the lookup: REGISTRY is a plain
    // object, so `REGISTRY["toString"]` answers Object.prototype's function -
    // truthy, so it walked straight past this guard, and the caller then read
    // `binaryName` off it as undefined and spawned ./bin/undefined. Refused
    // here as well as at the door, because this is what every caller asks.
    if (!Object.hasOwn(REGISTRY, mode)) throw new Error(`Unknown provider "${mode}"`);
    return REGISTRY[mode];
};

/** The on-disk path of a provider's CLI, platform suffix included. */
export const binaryPath = (mode, platform = process.platform) =>
    `./bin/${descriptor(mode).binaryName}${platform === "win32" ? ".exe" : ""}`;
