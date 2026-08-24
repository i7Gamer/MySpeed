import { spawn } from 'node:child_process';
import { parseCliOutput } from './providers/cliOutput.js';
import { parseProgressLine } from './providers/progress.js';
import { isMuslLinux, MUSL_CLOUDFLARE_REASON } from './providers/libc.js';
import * as interfacesModule from '../util/loadInterfaces.js';
import * as config from '../controller/config.js';
import * as loadLibre from './providers/loadLibre.js';
import * as loadOokla from './providers/loadOokla.js';
import * as loadCloudflare from './providers/loadCloudflare.js';
import { toErrorMessage } from './helpers.js';
import fs from 'node:fs';
import path from 'node:path';

const MS_PER_SECOND = 1000;
const CLI_TIMEOUT = 180 * MS_PER_SECOND;

// How long a CLI gets to honour SIGTERM before it is killed outright.
export const KILL_GRACE = 5 * MS_PER_SECOND;

/**
 * Whether the child is actually gone.
 *
 * Not `killed`, which only says a signal was delivered - kill() sets it whether
 * or not the child does anything about it, so a child that ignores SIGTERM
 * looks killed and is still running.
 */
export const hasExited = (child) => child.exitCode !== null || child.signalCode !== null;

/**
 * Ends a run, escalating if the CLI will not take the hint.
 *
 * kill() sends SIGTERM, which a process blocked in a socket read is free to
 * ignore - and several of these CLIs do. The child then never exits, 'close'
 * never fires, the promise below never settles, and the run latch
 * tasks/speedtest.js drops in its `finally` is never dropped: no scheduled
 * speedtest runs again for the life of the process. A timeout that cannot end
 * the process it is timing is not a timeout.
 *
 * Returns the escalation handle so a child that does close cleanly can cancel
 * it rather than leave the event loop holding a five-second timer.
 */
/**
 * The run in flight, so that something other than the run itself can end it.
 *
 * The child used to be held in a local, reachable only from the function that
 * spawned it. Nothing in the shutdown sequence could therefore stop it: the
 * timers stopped, the listeners closed, the database closed and the process
 * exited, and the CLI carried on. Under docker the kernel tears the namespace
 * down and takes the orphan with it, which is why this went unseen - under the
 * Windows service there is no namespace, so the speedtest outlives the server
 * and finishes by writing into a database handle that has already been closed.
 *
 * Only the newest is held. Runs are serialised by the latch in
 * tasks/speedtest.js, so there is never more than one.
 */
let activeProcess = null;

/** Records the run so a shutdown can reach it, and hands it straight back. */
export const trackProcess = (child) => {
    activeProcess = child;
    return child;
};

/**
 * Lets go of a run that has ended - but only if it is still the one being held.
 *
 * The handlers used to clear the tracker outright, whatever was in it. Node
 * emits 'error' before 'close' for a spawn that failed, and the rejection the
 * 'error' handler triggers resumes the caller in a microtask - so the retry in
 * tasks/speedtest.js can spawn and track a second child while the first one's
 * 'close' is still queued. Nothing here stopped that queued 'close' from wiping
 * the newer child, which leaves terminateActiveProcess with nothing to find and
 * the CLI still running after the server has gone.
 *
 * What prevents it today is that the retry awaits two configuration reads before
 * it spawns, so the queued 'close' always lands first. That is a property of the
 * retry's shape rather than of this file, and not one anybody editing either
 * would know they were relying on.
 */
export const untrackProcess = (child) => {
    if (activeProcess === child) activeProcess = null;
};

/**
 * How long a CLI gets to honour SIGTERM while the server is shutting down.
 *
 * Shorter than KILL_GRACE, which is the whole of the shutdown's own deadline
 * (SHUTDOWN_GRACE_MS): escalating on that would send the SIGKILL at the moment
 * the process was leaving anyway, which is no escalation at all. This has to
 * land comfortably inside the shutdown, so a CLI that ignores the request is
 * still gone before the exit rather than orphaned by it.
 */
export const SHUTDOWN_KILL_GRACE = 1000;

/**
 * Whether the process has begun leaving, for the one reader that must care:
 * the failure handler's automatic retry in tasks/speedtest.js.
 *
 * terminateActiveProcess ends the run in flight, but to the run that looks
 * like any other failure - and a failed first attempt answers by starting a
 * second. That fresh child spawns after the only moment the shutdown could
 * reach it, which rebuilds exactly the orphan trackProcess exists to prevent.
 *
 * A flag the shutdown sets rather than something the kill implies: ending the
 * active run is not the same statement as "the process is leaving", and a
 * future caller ending a run for its own reasons must not turn retries off
 * for the life of the process. One-way, because nothing un-shuts-down.
 */
let shuttingDown = false;

export const markShutdown = () => {
    shuttingDown = true;
};

export const isShuttingDown = () => shuttingDown;

/**
 * Ends the speedtest currently running, if one is.
 *
 * @returns whether there was anything to end
 */
export const terminateActiveProcess = (graceMs = SHUTDOWN_KILL_GRACE) => {
    if (activeProcess === null || hasExited(activeProcess)) return false;

    // Escalating, as the run's own timeout does - SIGTERM is a request, and a
    // CLI blocked in a socket read may ignore it.
    terminate(activeProcess, graceMs);
    return true;
};

export const terminate = (child, graceMs = KILL_GRACE) => {
    child.kill();

    const escalation = setTimeout(() => {
        if (!hasExited(child)) child.kill("SIGKILL");
    }, graceMs);

    // Never a reason to hold the process open on its own.
    escalation.unref?.();

    return escalation;
};

/**
 * The failure an exit code implies, or null when the streams already said
 * everything worth saying.
 *
 * Only consulted when nothing at all was parsed: a non-zero exit alongside a
 * result is the Ookla CLI's habit of failing after it has already printed the
 * measurement, and the measurement is the thing worth keeping. A clean exit
 * with no result is left alone too - that is a killed run, and the timeout is
 * what should explain it.
 */
export const exitError = (code, result) =>
    code !== 0 && !result.error && Object.keys(result).length === 0
        ? `The speedtest CLI exited with code ${code} without producing a result`
        : null;

/**
 * Why the configured interface cannot carry this run, or null when it can.
 *
 * Detection needs the network, so a boot without one leaves the interface map
 * empty and the configured name without an address. That used to flow straight
 * into the CLI arguments: cloudflare threw a TypeError on
 * `interfaceIp.includes(':')`, ookla on Windows and librespeed were handed the
 * literal `--ip=undefined` - and the stored failure described none of it.
 *
 * Ookla anywhere but Windows binds by interface *name*, which can be usable
 * even when the address probe came up empty, so that combination passes.
 */
export const missingInterfaceMessage = (mode, platform, currentInterface, interfaceIp) => {
    if (interfaceIp) return null;
    if (mode === "ookla" && platform !== "win32") return null;

    return `The configured network interface "${currentInterface}" has no usable address. ` +
        "Check the interface setting, and that the server can reach the network";
};

/**
 * What to record instead of a bare spawn failure, or null when the failure
 * speaks for itself.
 *
 * A CLI that is not on disk fails with `ENOENT: posix_spawn './bin/cfspeedtest'`,
 * which reads as a missing file and says nothing about why it is missing.
 * loadCli reports a download that did not happen to the log and carries on by
 * design, so that line has scrolled away long before anyone opens the failed
 * test - and on a musl system the download can never succeed at all, so every
 * scheduled run recorded the same unexplained ENOENT forever.
 */
export const missingBinaryMessage = (mode, binaryPath, errorCode, musl = isMuslLinux()) => {
    if (errorCode !== 'ENOENT') return null;

    if (mode === "cloudflare" && musl)
        return `${MUSL_CLOUDFLARE_REASON}, so ${binaryPath} could not be downloaded. `
            + 'The MySpeed image ships a musl build in bin/; restore it, or install cfspeedtest into bin/ yourself';

    return `The speedtest CLI ${binaryPath} is not there. It is downloaded when the server starts, `
        + 'so the server log says why that did not finish';
};

/**
 * The module that knows how to fetch each provider's CLI, by the mode that runs
 * it. Injectable so the recovery below is testable without the network.
 */
const PROVIDER_LOADERS = {ookla: loadOokla, libre: loadLibre, cloudflare: loadCloudflare};

/**
 * Makes sure the CLI this run is about to spawn is actually on disk.
 *
 * loadCli fetches all three at boot and reports a failure rather than
 * propagating it - one unreachable release must not stop the dashboard coming
 * up. But nothing ever tried again, so an instance started during a brief
 * github.com outage, or on a connection that came up a moment after the server
 * did, recorded a failed test every scheduled run for the life of the process.
 * The reason stored on those rows said the binary was missing and pointed at a
 * boot log that had scrolled away hours before anyone looked.
 *
 * `load()` is the same call the boot makes and asks the same question: it
 * checks whether the file is there and downloads it only if it is not. So this
 * costs one existsSync on the ordinary run, and turns a permanent failure into
 * one that clears itself the moment the network comes back.
 *
 * A failed download is thrown here rather than left to the spawn. The loader
 * knows why - a 403, a platform with no published build, the musl refusal
 * cfspeedtest carries - where the ENOENT that would follow can only say the
 * file is not there. A mode with no loader is left alone: there is nothing to
 * ask, and refusing here would replace a failure naming the binary with one
 * naming an internal lookup.
 */
export const ensureBinary = async (mode, binaryPath, loaders = PROVIDER_LOADERS) => {
    const loader = loaders[mode];
    if (!loader) return;

    try {
        await loader.load();
    } catch (error) {
        // The reason is in the message because that is what reaches the failed
        // test's error column, and `cause` because the log is where the whole
        // chain is worth having.
        throw new Error(`The speedtest CLI ${binaryPath} is not there and could not be downloaded: `
            + toErrorMessage(error), {cause: error});
    }
};

/**
 * The custom-server file a librespeed run writes, taken back off disk.
 *
 * A run against a custom backend writes that backend's address into
 * data/servers/libre_custom.json for the CLI to read, and nothing ever removed
 * it. A URL is allowed userinfo, so the address can carry a credential - the
 * same one the config export strips and GET /api/config withholds - and it sat
 * there in the data volume, outliving the run by however long the instance
 * lived, for anyone reading a backup of that directory.
 *
 * Failures are swallowed. The file has done its job by the time this runs, and
 * a run that measured the line successfully must not be reported as failed
 * because a temporary file could not be deleted.
 */
export const removeTemporaryServer = (file) => {
    if (!file) return;

    try {
        fs.unlinkSync(file);
    } catch {
        // Already gone, or a directory that has become read-only. Neither is
        // something this run can do anything about.
    }
};

export default async (mode, serverId, serverUrl, onProgress) => {
    const binaryPath = mode === "ookla" ? './bin/speedtest' + (process.platform === "win32" ? ".exe" : "")
        : mode === "libre" ? './bin/librespeed-cli' + (process.platform === "win32" ? ".exe" : "")
            : './bin/cfspeedtest' + (process.platform === "win32" ? ".exe" : "");

    if (!interfacesModule.interfaces) throw new Error("No interfaces found");

    const currentInterface = await config.getValue("interface");
    const interfaceIp = interfacesModule.interfaces[currentInterface];

    const unusable = missingInterfaceMessage(mode, process.platform, currentInterface, interfaceIp);
    if (unusable) throw new Error(unusable);

    // Fetched now if the boot could not - see ensureBinary. Ahead of the
    // arguments rather than beside the spawn, so that nothing between writing
    // the librespeed server file below and starting the CLI can throw and leave
    // it behind - and so a download is not counted as time the test took.
    await ensureBinary(mode, binaryPath);

    const startTime = new Date().getTime();
    let args;

    // The custom-server file, when this run writes one. Held out here because
    // what removes it is the handler that ends the run, not the branch that
    // wrote it.
    let temporaryServer = null;

    if (mode === "ookla") {
        // jsonl rather than json: the CLI reports each phase as it goes instead
        // of only the finished result, which is what the interface follows a run
        // with. The final record is the same result either way.
        args = ['--accept-license', '--accept-gdpr', '--format=jsonl'];

        if (process.platform === "win32") {
            args.push('--ip=' + interfaceIp);
        } else {
            args.push('--interface=' + currentInterface);
        }

        if (serverId) args.push(`--server-id=${serverId}`);
    } else if (mode === "libre") {
        args = ['--json', '--duration=5', '--source=' + interfaceIp];
        if (serverUrl) {
            const customServerConfig = [{
                id: 1,
                name: "Custom Server",
                server: serverUrl,
                dlURL: "garbage.php",
                ulURL: "empty.php",
                pingURL: "empty.php",
                getIpURL: "getIP.php"
            }];
            temporaryServer = path.join('data', 'servers', 'libre_custom.json');
            fs.writeFileSync(temporaryServer, JSON.stringify(customServerConfig));
            args.push(`--local-json=${temporaryServer}`);
            args.push('--server=1');
        } else if (serverId) {
            args.push(`--server=${serverId}`);
        }
    } else if (mode === "cloudflare") {
        args = ['--output-format=json'];

        if (interfaceIp.includes(':')) {
            args.push('--ipv6=' + interfaceIp);
        } else {
            args.push('--ipv4=' + interfaceIp);
        }
    }

    let result;
    let stdout = '';
    let stderr = '';

    // A CLI that accepts the connection and then stalls would hold the run lock
    // for the lifetime of the process, and no scheduled test would ever run
    // again.
    //
    // The timer is kept here rather than passed to spawn as its `timeout`
    // option: when a spawn fails outright - a missing binary, which is exactly
    // what a fresh install before the download has finished looks like - node
    // emits 'error' and 'close' within milliseconds but never clears that timer,
    // and the whole process then stays alive until it fires. Owning it means it
    // is cleared however the run ends.
    const testProcess = trackProcess(spawn(binaryPath, args, {windowsHide: true}));

    let timedOut = false;
    let escalation;
    const timeout = setTimeout(() => {
        timedOut = true;
        escalation = terminate(testProcess);
    }, CLI_TIMEOUT);

    testProcess.stderr.on('data', (buffer) => {
        // Accumulated, not overwritten: stderr arrives in arbitrary chunks, so
        // keeping only the last one reported whatever fragment happened to
        // land last rather than the actual failure.
        stderr += buffer.toString();
    });

    // Holds the tail of a chunk that ended mid-line: the CLI writes one record
    // per line, but a read can split one anywhere.
    let incomplete = '';

    testProcess.stdout.on('data', (buffer) => {
        const text = buffer.toString();
        stdout += text;

        if (!onProgress) return;

        const lines = (incomplete + text).split('\n');
        incomplete = lines.pop();

        for (const line of lines) {
            const update = parseProgressLine(mode, line.trim());
            if (update) onProgress(update);
        }
    });

    // Everything the end of a run has to let go of, however it ended. The two
    // handlers below repeated this between them, which is how the temporary
    // server file came to be cleaned up by neither.
    const finish = () => {
        clearTimeout(timeout);
        clearTimeout(escalation);
        untrackProcess(testProcess);
        removeTemporaryServer(temporaryServer);
    };

    await new Promise((resolve, reject) => {
        // A binary that is not there is the one spawn failure whose own message
        // explains nothing, so it gets one that does. Everything else is
        // rejected as-is: wrapping it in {message: e} gave the wrapper a
        // `message` key holding an Error, which the caller then stored verbatim
        // in a string column.
        testProcess.on('error', (error) => {
            finish();

            const missing = missingBinaryMessage(mode, binaryPath, error.code);
            reject(missing ? new Error(missing) : error);
        });

        // 'close' rather than 'exit': the process can exit while its pipes still
        // hold output, and parsing then would read a truncated result.
        testProcess.on('close', (code) => {
            finish();
            result = parseCliOutput(mode, stdout, stderr);

            // The exit code has the last word when the streams had nothing to
            // say. Without it a run that failed instantly and explained itself
            // nowhere the parser looks was reported as "test timed out".
            const failure = exitError(code, result);
            if (failure) result.error = failure;

            resolve();
        });
    });

    // A killed run has whatever output it managed before the signal, which is
    // not a measurement - it has to say it timed out rather than report half a
    // test as a result.
    if (timedOut) throw new Error(`The speedtest did not finish within ${CLI_TIMEOUT / MS_PER_SECOND} seconds`);

    if (result.error) throw new Error(result.error);
    return {...result, elapsed: new Date().getTime() - startTime};
}