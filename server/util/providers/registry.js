import path from 'node:path';
import * as loadOokla from './loadOokla.js';
import * as loadLibre from './loadLibre.js';
import * as loadCloudflare from './loadCloudflare.js';

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
    }
};

export const providerIds = () => Object.keys(REGISTRY);

export const descriptor = (mode) => {
    const entry = REGISTRY[mode];
    if (!entry) throw new Error(`Unknown provider "${mode}"`);
    return entry;
};

/** The on-disk path of a provider's CLI, platform suffix included. */
export const binaryPath = (mode, platform = process.platform) =>
    `./bin/${descriptor(mode).binaryName}${platform === "win32" ? ".exe" : ""}`;
