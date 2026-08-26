import { spawn } from 'node:child_process';
import { parseCliOutput } from './providers/cliOutput.js';
import { parseProgressLine } from './providers/progress.js';
import { isMuslLinux, MUSL_CLOUDFLARE_REASON } from './providers/libc.js';
import * as interfacesModule from '../util/loadInterfaces.js';
import * as config from '../controller/config.js';
import { REGISTRY, descriptor, binaryPath as providerBinaryPath } from './providers/registry.js';
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
 * How long the exit waits for the child terminateActiveProcess signalled.
 *
 * Longer than SHUTDOWN_KILL_GRACE, or the wait would give up before the SIGKILL
 * it exists to wait out has even been sent - and comfortably inside shutdown.js's
 * SHUTDOWN_GRACE_MS deadline, which outranks everything and keeps the last word.
 * cliTermination.test.js holds the ordering of the three.
 */
export const SHUTDOWN_EXIT_WAIT = 2000;

/**
 * Resolves once the tracked run is actually gone, or after timeoutMs.
 *
 * terminateActiveProcess only *starts* the ending: SIGTERM at once, SIGKILL a
 * second later on a timer that is deliberately unref'd. On a quiet shutdown the
 * listeners close in milliseconds and exit(0) won that race - the escalation
 * never fired, and a CLI that ignores SIGTERM outlived the server. Docker tears
 * the namespace down and takes the orphan with it, and Windows' kill() cannot be
 * ignored, so the survivor was the bare Linux install - exactly the machine the
 * tracker's own comment promises to cover.
 *
 * 'close' rather than 'exit', as the run's own promise settles: gone means the
 * pipes have drained too. Answers true when the child is gone and false when the
 * wait gave up - the caller proceeds either way, this only decides when.
 */
export const waitForActiveProcessExit = (timeoutMs = SHUTDOWN_EXIT_WAIT) =>
    new Promise((resolve) => {
        if (activeProcess === null || hasExited(activeProcess)) return resolve(true);

        const child = activeProcess;

        const onClose = () => {
            clearTimeout(timer);
            resolve(true);
        };

        // A child that cannot die - wedged in uninterruptible IO, or SIGKILL
        // lost to a zombie reaper - must not hold the shutdown. The deadline in
        // shutdown.js would exit regardless; giving up here keeps the cleanup
        // behind this wait on the ordinary path instead of being skipped by
        // that exit.
        const timer = setTimeout(() => {
            child.removeListener("close", onClose);
            resolve(false);
        }, timeoutMs);
        timer.unref?.();

        child.once("close", onClose);
    });

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
 * it - the registry's loaders, in the map shape ensureBinary can be handed a
 * fake of. Injectable so the recovery below is testable without the network.
 */
const PROVIDER_LOADERS = Object.fromEntries(
    Object.entries(REGISTRY).map(([id, entry]) => [id, entry.loader]));

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

/**
 * What a run may keep of what its CLI printed.
 *
 * Both streams were accumulated without bound for the run's whole three-minute
 * timeout, so a CLI wedged in a logging loop could grow the heap as fast as a
 * pipe can carry - the stored reason is capped at two thousand characters, but
 * only after the whole of both streams had been held to produce it.
 *
 * Both ends are kept and the middle is dropped, because the two things worth
 * keeping live at opposite ends: a failure explains itself in its opening lines,
 * and with --format=jsonl the Ookla CLI writes its progress records first and
 * the result record *last* - a healthy minute-long test writes more progress
 * than any sane head-only cap allows, so capping the head alone would throw
 * away the very line the run exists to produce. The joint always carries its
 * own newline, so the head's torn last line and the tail's torn first line
 * stay two lines - each parses as chatter and is skipped, rather than fusing
 * into one line that says something neither of them said.
 */
export const MAX_STREAM_HEAD = 1024 * 1024;
export const MAX_STREAM_TAIL = 256 * 1024;

export const streamAccumulator = ({headLimit = MAX_STREAM_HEAD, tailLimit = MAX_STREAM_TAIL} = {}) => {
    let head = "";
    let tail = "";
    let truncated = false;

    return {
        append(text) {
            if (!truncated) {
                if (head.length + text.length <= headLimit) {
                    head += text;
                    return;
                }

                const room = headLimit - head.length;
                head += text.slice(0, room);
                text = text.slice(room);
                truncated = true;
            }

            tail = (tail + text).slice(-tailLimit);
        },
        value() {
            return truncated ? `${head}\n${tail}` : head;
        },
        get truncated() {
            return truncated;
        }
    };
};

export default async (mode, serverId, serverUrl, onProgress) => {
    // Throws for a mode the registry does not know - the old ternary's else
    // branch handed anything unrecognised cfspeedtest's path instead, and the
    // run then failed naming a binary that had nothing to do with it.
    const provider = descriptor(mode);
    const binaryPath = providerBinaryPath(mode);

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

    const built = provider.buildArgs({serverId, endpoint: serverUrl},
        {name: currentInterface, address: interfaceIp});
    const args = built.args;

    // The custom-server file, when this run writes one. buildArgs answers it
    // as {path, content} rather than writing it, so the side effect lives
    // here, beside the handler that ends the run and removes it again.
    let temporaryServer = null;

    if (built.temporaryServer) {
        temporaryServer = built.temporaryServer.path;
        fs.writeFileSync(temporaryServer, built.temporaryServer.content);
    }

    let result;
    const stdout = streamAccumulator();
    const stderr = streamAccumulator();

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
        // land last rather than the actual failure. Bounded - see
        // streamAccumulator - so a CLI wedged in a logging loop cannot grow
        // the heap for its whole three-minute timeout.
        stderr.append(buffer.toString());
    });

    // Holds the tail of a chunk that ended mid-line: the CLI writes one record
    // per line, but a read can split one anywhere.
    let incomplete = '';

    testProcess.stdout.on('data', (buffer) => {
        const text = buffer.toString();
        stdout.append(text);

        if (!onProgress || !provider.streamsProgress) return;

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
            result = parseCliOutput(mode, stdout.value(), stderr.value());

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