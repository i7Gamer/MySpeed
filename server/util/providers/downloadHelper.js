import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { get } from 'node:https';
import { createHash, randomBytes } from 'node:crypto';
import decompress from '@xhmikosr/decompress';
import decompressTarGz from '@xhmikosr/decompress-targz';
import decompressUnzip from '@xhmikosr/decompress-unzip';

/**
 * What a refused download is, as its own type.
 *
 * Named rather than a bare Error because it is the one failure here that means
 * something other than "the network was unhelpful": the archive arrived intact
 * and is not the archive this build expects. A caller telling the two apart
 * should not have to match on a message.
 */
export class DigestMismatchError extends Error {
    constructor(message) {
        super(message);
        this.name = "DigestMismatchError";
        this.code = "EDIGESTMISMATCH";
    }
}

const SHA256 = /^[a-f0-9]{64}$/;

/**
 * Refuses a file that is not the one the manifest names.
 *
 * The first item in the tech debt register: these archives are unpacked and the
 * binary inside is then spawned by the server on a schedule, so a replaced
 * upstream asset is arbitrary code on the operator's machine once an hour for as
 * long as the instance runs. 1.3.5 stopped that running as root; this is the
 * other half.
 *
 * Fails closed. An expected digest that is absent or malformed is a manifest
 * that cannot say what should have arrived, and continuing on that basis is
 * exactly the state this ends - so it is refused rather than waved through as
 * "nothing to check against".
 *
 * Streamed rather than read whole: these are a few megabytes today, and reading
 * an archive into memory to hash it is a habit that only becomes a problem on
 * the machine least able to afford it.
 */
export const verifyDigest = (filePath, expected) => new Promise((resolve, reject) => {
    const wanted = String(expected ?? "").toLowerCase();

    if (!SHA256.test(wanted))
        return reject(new DigestMismatchError(
            `Refusing ${filePath}: no sha256 is pinned for it, so there is nothing to check it against`));

    const hash = createHash("sha256");
    const stream = fs.createReadStream(filePath);

    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => {
        const actual = hash.digest("hex");

        if (actual === wanted) return resolve();

        reject(new DigestMismatchError(
            `Refusing ${filePath}: expected sha256 ${wanted} but the download hashes to ${actual}`));
    });
});

export const tmpFile = (suffix = '') =>
    path.join(os.tmpdir(), randomBytes(16).toString('hex') + suffix);

/**
 * How many redirects a release download may chase. The real chains are one or
 * two hops to a CDN; without a bound, a URL that loops - or a chain long
 * enough - recursed until memory ran out instead of failing with a reason.
 */
export const MAX_DOWNLOAD_REDIRECTS = 10;

/**
 * How long the transfer may go quiet before it is abandoned.
 *
 * `get` arms no timer of its own, so a server that accepted the connection and
 * then said nothing left the promise unsettled - and with it the boot that
 * awaits the CLI install, with no error and nothing in the log naming what it
 * was waiting for. This is an *idle* timeout rather than a deadline for the
 * whole download: a large archive on a slow line keeps resetting it, and only a
 * transfer that has genuinely stopped runs it out.
 */
export const DOWNLOAD_IDLE_TIMEOUT = 60000;

// A peer can keep an idle timer alive indefinitely by sending occasional bytes.
// The whole redirect chain shares this budget, so boot and first-use retries
// eventually get an answer even from a transfer that never completes.
export const DOWNLOAD_TIMEOUT = 10 * DOWNLOAD_IDLE_TIMEOUT;

// `client` is injectable so the redirect handling is testable without the
// network; callers pass nothing and get node:https.
export const downloadToFile = (url, destPath, {redirectsLeft = MAX_DOWNLOAD_REDIRECTS,
    client = get, timeoutMs = DOWNLOAD_TIMEOUT} = {}) =>
    new Promise((resolve, reject) => {
        let settled = false;
        let response;
        let writeStream;
        const requests = new Set();

        const fail = (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);

            for (const request of requests) request.destroy?.();
            response?.destroy?.();
            // Wait for the descriptor to close before unlinking on Windows.
            // A newly-created stream may still be opening its file when the
            // deadline fires; removing it earlier can leave a late partial file.
            const closed = writeStream && !writeStream.closed
                ? new Promise((done) => writeStream.once("close", done)) : Promise.resolve();
            writeStream?.destroy();
            closed.then(() => writeStream ? fs.promises.unlink(destPath).catch(() => undefined) : undefined)
                .then(() => reject(error));
        };

        const deadline = setTimeout(() => fail(new Error(
            `Download failed: ${url} exceeded the ${timeoutMs}ms overall deadline`)), timeoutMs);

        const visit = (currentUrl, remaining) => {
            let discarded = false;
            const onError = (error) => { if (!discarded) fail(error); };
            const request = client(currentUrl, (res) => {
                if (settled) return res.destroy?.();
                response = res;
                res.on('error', onError);
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    if (remaining <= 0)
                        return fail(new Error(`Download failed: ${url} redirected more than ${MAX_DOWNLOAD_REDIRECTS} times`));

                    // Resolved against the URL that sent it. A Location header need
                    // not be absolute - RFC 9110 allows a relative reference, and a
                    // CDN answering `Location: /bin/cli.tgz` reached https.get as a
                    // path and died on ERR_INVALID_URL, naming neither the download
                    // nor the redirect.
                    let next;
                    try {
                        next = new URL(res.headers.location, currentUrl);
                    } catch {
                        return fail(new Error(
                            `Download failed: ${url} redirected to "${res.headers.location}", which is not a URL`));
                    }

                    // This fetches an executable the server then runs, so a
                    // redirect onto plain HTTP is a downgrade that hands anyone on
                    // the path its contents. Refused with a reason: an http:// URL
                    // handed to https.get failed on ERR_INVALID_PROTOCOL instead,
                    // which says nothing about a redirect having happened.
                    if (next.protocol !== "https:")
                        return fail(new Error(
                            `Download failed: ${url} redirected to ${next.protocol}//, and only https is followed`));

                    try {
                        // The redirect body is unused. Close it now rather than
                        // letting it outlive a successful final download, and
                        // ignore errors caused by closing that discarded hop.
                        discarded = true;
                        res.destroy?.();
                        return visit(next.href, remaining - 1);
                    } catch (error) {
                        return fail(error);
                    }
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    return fail(new Error(`Download failed: ${url} returned ${res.statusCode}`));
                }
                writeStream = fs.createWriteStream(destPath);
                writeStream.on('finish', () => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(deadline);
                    resolve();
                });
                writeStream.on('error', fail);
                res.pipe(writeStream);
            });

            requests.add(request);
            request.on('error', onError);
            if (settled) return;

            // Optional so the scripted clients the tests inject stay two-line
            // stubs; a real ClientRequest always has it.
            request.setTimeout?.(DOWNLOAD_IDLE_TIMEOUT, () => {
                onError(new Error(
                    `Download failed: ${url} sent nothing for ${DOWNLOAD_IDLE_TIMEOUT}ms`));
            });
        };

        try {
            visit(url, redirectsLeft);
        } catch (error) {
            fail(error);
        }
    });

/**
 * Fetches a release archive, takes the binary out of it, and removes the
 * archive however that went.
 *
 * All three loaders did the first two steps and stopped, so every download left
 * a .tgz or .zip of some tens of megabytes in os.tmpdir() for good - under a
 * random name, so nothing would ever overwrite it either. Once per install
 * sounds harmless until ./bin is not persisted, at which point it is once per
 * container start.
 *
 * `extract` and `tmp` are injectable for the same reason `client` is: so the
 * cleanup can be tested without a real archive or the network.
 */
export const downloadAndExtract = async (url, {outputDir, binaryRegex, outputName, sha256,
    client = get, extract = extractBinary, tmp = tmpFile, suffix = '', requiredFiles,
    operations} = {}) => {

    const archivePath = tmp(suffix);

    try {
        await downloadToFile(url, archivePath, {client});
        // Between the download and the extraction, and it has to be there rather
        // than after: unpacking writes whatever the archive contains into ./bin,
        // and removing it afterwards is not the same as never having written it -
        // the file the loader is about to spawn would have existed in between.
        await verifyDigest(archivePath, sha256);
        await extract(archivePath, outputDir, binaryRegex, outputName, {requiredFiles, operations});
    } finally {
        await fs.promises.unlink(archivePath).catch(() => undefined);
    }
};

/**
 * The mode a downloaded executable is given, when the platform has modes.
 *
 * Owner may read, write and execute; group and others may read and execute.
 * The server spawns this file, so it has to carry the bit - a release asset
 * published as a bare binary arrives without one, unlike a tar member, which
 * carries its mode inside the archive.
 */
export const EXECUTABLE_MODE = 0o755;

// Runtime libraries are data, not entry points. Neither mode is taken from the
// archive: release metadata must not get to add privilege bits.
export const RUNTIME_LIBRARY_MODE = 0o644;
const PRIVILEGED_MODE_BITS = 0o7000;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const DRIVE_PREFIX = /^[a-z]:/i;
const ARCHIVE_PLUGINS = [decompressTarGz(), decompressUnzip()];
const installLocks = new Map();

const lockKey = (outputDir) => path.resolve(outputDir);

/** Waits until this process has finished publishing into an install directory. */
export const waitForInstall = async (outputDir) => {
    const key = lockKey(outputDir);

    // A second publication may be appended while this waiter is behind the
    // first one. Re-read the tail after every completion; snapshotting it once
    // lets a consumer run while that later publication is between pair members.
    while (true) {
        const install = installLocks.get(key);
        if (!install) return;
        await install.catch(() => undefined);
    }
};

const serializeInstall = (outputDir, task) => {
    const key = lockKey(outputDir);
    const previous = installLocks.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    installLocks.set(key, current);

    return current.finally(() => {
        if (installLocks.get(key) === current) installLocks.delete(key);
    });
};

const defaultOperations = {
    chmod: fs.promises.chmod.bind(fs.promises),
    copyFile: fs.promises.copyFile.bind(fs.promises),
    lstat: fs.promises.lstat.bind(fs.promises),
    mkdir: fs.promises.mkdir.bind(fs.promises),
    mkdtemp: fs.promises.mkdtemp.bind(fs.promises),
    realpath: fs.promises.realpath.bind(fs.promises),
    rename: fs.promises.rename.bind(fs.promises),
    rm: fs.promises.rm.bind(fs.promises),
    unlink: fs.promises.unlink.bind(fs.promises),
    writeFile: fs.promises.writeFile.bind(fs.promises)
};

const operationsFor = (overrides) => ({...defaultOperations, ...overrides});

const optionalLstat = async (target, operations) => {
    try {
        return await operations.lstat(target);
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
};

const assertSafeArchivePath = (entryPath) => {
    if (typeof entryPath !== 'string' || entryPath.length === 0 || entryPath.includes('\0'))
        throw new Error('Extraction failed: selected member has an unsafe empty or NUL path');
    if (entryPath.includes('\\'))
        throw new Error(`Extraction failed: selected member has an unsafe backslash path: ${entryPath}`);
    if (path.posix.isAbsolute(entryPath) || entryPath.startsWith('//') || DRIVE_PREFIX.test(entryPath))
        throw new Error(`Extraction failed: selected member has an unsafe absolute path: ${entryPath}`);

    const segments = entryPath.split('/');
    if (segments.some((segment) => segment === '..' || segment === ''))
        throw new Error(`Extraction failed: selected member has an unsafe traversal path: ${entryPath}`);
    if (segments.some((segment) => segment.includes(':') || WINDOWS_RESERVED_NAME.test(segment)
        || segment.endsWith('.') || segment.endsWith(' ')))
        throw new Error(`Extraction failed: selected member has a path unsafe on Windows: ${entryPath}`);
};

const assertSafeOutputName = (name) => {
    assertSafeArchivePath(name);
    if (path.posix.basename(name) !== name)
        throw new Error(`Extraction failed: output name must be a basename: ${name}`);
};

const regexMatches = (regex, value) => {
    regex.lastIndex = 0;
    return regex.test(value);
};

const decodeSelected = async (archivePath, fileRegex, outputName, requiredFiles) => {
    const entries = await decompress(archivePath, {plugins: ARCHIVE_PLUGINS});
    const matches = entries.filter((entry) => regexMatches(fileRegex, entry.path));

    if (matches.length === 0)
        throw new Error(`Extraction failed: nothing matching ${fileRegex} was found in ${archivePath}`
            + ' - the archive may be in a format this build cannot unpack, or the download may not be an archive at all');

    const requiredByKey = requiredFiles
        ? new Map(requiredFiles.map((name) => {
            assertSafeOutputName(name);
            return [name.toLowerCase(), name];
        })) : null;
    const selected = [];
    const seenNames = new Set();

    for (const entry of matches) {
        assertSafeArchivePath(entry.path);
        if (entry.type !== 'file')
            throw new Error(`Extraction failed: selected member ${entry.path} is not an ordinary regular file`);
        if (!Buffer.isBuffer(entry.data) || entry.data.length === 0)
            throw new Error(`Extraction failed: selected member ${entry.path} is empty`);
        if ((entry.mode & PRIVILEGED_MODE_BITS) !== 0)
            throw new Error(`Extraction failed: selected member ${entry.path} has unsafe privilege mode bits`);

        const archiveBasename = path.posix.basename(entry.path);
        const candidate = outputName ?? archiveBasename;
        const canonicalName = requiredByKey?.get(candidate.toLowerCase()) ?? candidate;
        assertSafeOutputName(canonicalName);

        if (requiredByKey && !requiredByKey.has(candidate.toLowerCase()))
            throw new Error(`Extraction failed: unexpected selected member ${entry.path}`);

        const key = canonicalName.toLowerCase();
        if (seenNames.has(key))
            throw new Error(`Extraction failed: ambiguous duplicate output name ${canonicalName}`);
        seenNames.add(key);
        selected.push({data: entry.data, name: canonicalName});
    }

    if (requiredByKey) {
        const missing = [...requiredByKey]
            .filter(([key]) => !seenNames.has(key))
            .map(([, name]) => name);
        if (missing.length > 0)
            throw new Error(`Extraction failed: archive is missing required ${missing.join(' and ')}`);

        selected.sort((left, right) => requiredFiles.indexOf(left.name) - requiredFiles.indexOf(right.name));
    }

    return selected;
};

const pathIsWithin = (root, target) => {
    const relative = path.relative(root, target);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..'
        && !path.isAbsolute(relative));
};

const samePath = (left, right) => process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase() : left === right;

const trustedInstallRoot = (outputDir) => {
    const target = path.resolve(outputDir);
    const candidates = [process.cwd(), os.tmpdir()]
        .map((candidate) => path.resolve(candidate))
        .filter((candidate) => pathIsWithin(candidate, target))
        .sort((left, right) => right.length - left.length);

    if (candidates.length === 0)
        throw new Error(`Refusing to install outside untrusted process and temporary roots: ${outputDir}`);
    return candidates[0];
};

/**
 * Creates an output directory without following links below a canonical root.
 *
 * Canonicalizing the root itself intentionally accepts platform aliases such
 * as macOS /var -> /private/var. Every component beneath that already-trusted
 * process or temporary root is lstat'd separately rather than trusting an
 * arbitrary nearest ancestor chosen by the caller-controlled output path.
 */
const assertSafeOutputDirectory = async (outputDir, operations) => {
    const resolvedOutput = path.resolve(outputDir);
    const resolvedRoot = trustedInstallRoot(resolvedOutput);
    const canonicalRoot = await operations.realpath(resolvedRoot);
    const relative = path.relative(resolvedRoot, resolvedOutput);
    let current = canonicalRoot;

    for (const component of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, component);
        let stats = await optionalLstat(current, operations);
        if (!stats) {
            try {
                await operations.mkdir(current);
            } catch (error) {
                if (error.code !== 'EEXIST') throw error;
            }
            stats = await operations.lstat(current);
        }
        if (stats.isSymbolicLink())
            throw new Error(`Refusing to install through linked parent or output directory ${current}`);
        if (!stats.isDirectory())
            throw new Error(`Refusing to install because output path component is not a directory: ${current}`);
    }

    const actual = await operations.realpath(resolvedOutput);
    if (!samePath(actual, current))
        throw new Error(`Refusing output-directory escape from ${resolvedOutput} to ${actual}`);
    return current;
};

const assertReplaceableDestination = async (destination, operations) => {
    const stats = await optionalLstat(destination, operations);
    if (!stats) return false;
    if (stats.isSymbolicLink())
        throw new Error(`Refusing to replace destination symlink ${destination}`);
    if (!stats.isFile())
        throw new Error(`Refusing to replace non-file destination ${destination}`);
    if (stats.nlink > 1)
        throw new Error(`Refusing to replace hardlinked destination ${destination} with link count ${stats.nlink}`);
    return true;
};

const modeFor = (name) => name.toLowerCase().endsWith('.dll')
    ? RUNTIME_LIBRARY_MODE : EXECUTABLE_MODE;

const validateStagedFile = async (stagedPath, expectedMode, operations) => {
    const stats = await operations.lstat(stagedPath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.size === 0)
        throw new Error(`Extraction failed: staged output is not a nonempty unlinked regular file: ${stagedPath}`);
    if (process.platform !== 'win32' && (stats.mode & 0o777) !== expectedMode)
        throw new Error(`Extraction failed: staged output has unsafe mode: ${stagedPath}`);
};

const publishSelected = async (selected, outputDir, operationOverrides) => {
    const operations = operationsFor(operationOverrides);
    const canonicalOutputDir = await assertSafeOutputDirectory(outputDir, operations);
    const destinations = selected.map((entry) => path.join(canonicalOutputDir, entry.name));
    for (const destination of destinations)
        await assertReplaceableDestination(destination, operations);

    const stageDirectory = await operations.mkdtemp(path.join(canonicalOutputDir, '.myspeed-install-'));
    const staged = [];
    let keepEvidence = false;

    try {
        for (const entry of selected) {
            const stagedPath = path.join(stageDirectory, `${entry.name}.new`);
            const mode = modeFor(entry.name);
            await operations.writeFile(stagedPath, entry.data, {flag: 'wx', mode});
            if (process.platform !== 'win32') await operations.chmod(stagedPath, mode);
            await validateStagedFile(stagedPath, mode, operations);
            staged.push(stagedPath);
        }

        // A single rename is the atomic replacement primitive. The finite
        // Windows pair needs backups because the second rename can still fail.
        if (selected.length === 1) {
            await assertReplaceableDestination(destinations[0], operations);
            await operations.rename(staged[0], destinations[0]);
            return selected;
        }

        const backups = new Map();
        const published = [];
        try {
            for (let index = 0; index < destinations.length; index++) {
                const destination = destinations[index];
                if (await assertReplaceableDestination(destination, operations)) {
                    const backup = path.join(stageDirectory, `${selected[index].name}.previous`);
                    await operations.rename(destination, backup);
                    backups.set(destination, backup);
                }
            }
            for (let index = 0; index < destinations.length; index++) {
                await operations.rename(staged[index], destinations[index]);
                published.push(destinations[index]);
            }
        } catch (publicationError) {
            const rollbackErrors = [];
            for (const destination of published.toReversed()) {
                try {
                    await operations.unlink(destination);
                } catch (error) {
                    if (error.code !== 'ENOENT') rollbackErrors.push(error);
                }
            }
            for (const [destination, backup] of backups) {
                try {
                    await operations.rename(backup, destination);
                } catch (error) {
                    rollbackErrors.push(error);
                }
            }
            if (rollbackErrors.length > 0) {
                keepEvidence = true;
                throw new AggregateError([publicationError, ...rollbackErrors],
                    `Installation failed and rollback also failed; evidence retained in ${stageDirectory}`,
                    {cause: publicationError});
            }
            throw publicationError;
        }

        return selected;
    } finally {
        if (!keepEvidence)
            await operations.rm(stageDirectory, {recursive: true, force: true}).catch(() => undefined);
    }
};

/**
 * Fetches a release asset that is the executable itself, rather than an
 * archive containing one.
 *
 * The three CLIs that came before all publish archives, so everything here
 * unpacked. iperf3's static builds are published as bare binaries per
 * architecture - `iperf3-amd64` - and handing one to the extractor fails on
 * "nothing matching /iperf3/ was found", which is true and explains nothing.
 *
 * Verified before it is put in place, and put in place by a rename rather than
 * a second download: the check is what stands between a replaced upstream
 * asset and a file this server spawns on a schedule, so nothing unverified may
 * ever exist at the path the runner reaches for. A rename within one
 * filesystem is atomic, so there is no moment where a half-written file sits
 * there either - and the temporary directory can be on another filesystem, so
 * the copy fallback is not optional.
 */
export const downloadBinary = async (url, {outputPath, sha256, client = get, tmp = tmpFile,
    mode = EXECUTABLE_MODE, operations: operationOverrides} = {}) => {

    const downloaded = tmp('');
    const operations = operationsFor(operationOverrides);
    let stageDirectory;

    try {
        await downloadToFile(url, downloaded, {client});
        await verifyDigest(downloaded, sha256);
        if (!Number.isInteger(mode) || mode < 0 || mode > 0o777
            || (mode & PRIVILEGED_MODE_BITS) !== 0)
            throw new Error(`Refusing executable mode with unsafe privilege bits: ${mode}`);

        const outputDir = path.dirname(outputPath);
        const outputName = path.basename(outputPath);
        assertSafeOutputName(outputName);
        const canonicalOutputDir = await assertSafeOutputDirectory(outputDir, operations);
        const destination = path.join(canonicalOutputDir, outputName);
        await assertReplaceableDestination(destination, operations);
        stageDirectory = await operations.mkdtemp(path.join(canonicalOutputDir, '.myspeed-binary-'));
        const staged = path.join(stageDirectory, 'download.new');

        // Moving avoids a second full write when temp and bin share a filesystem.
        // EXDEV copies only to a fresh same-directory staging path, never final.
        try {
            await operations.rename(downloaded, staged);
        } catch (error) {
            if (error.code !== "EXDEV") throw error;
            await operations.copyFile(downloaded, staged, fs.constants.COPYFILE_EXCL);
        }

        if (process.platform !== 'win32') await operations.chmod(staged, mode);
        await validateStagedFile(staged, mode, operations);
        await assertReplaceableDestination(destination, operations);
        await operations.rename(staged, destination);
    } finally {
        await fs.promises.unlink(downloaded).catch(() => undefined);
        if (stageDirectory)
            await operations.rm(stageDirectory, {recursive: true, force: true}).catch(() => undefined);
    }
};

/**
 * Takes the binary out of a release archive, and says so when it could not.
 *
 * decompress resolves with an empty array rather than rejecting when no plugin
 * recognises the archive - both registered plugins return [] for an
 * unrecognised magic, and Promise.all([]) resolves - so an unhandled format (a
 * FreeBSD .pkg is tar+xz, and only targz and unzip are registered here), a
 * binaryRegex matching no member, and a 200 HTML error page saved as an archive
 * all looked exactly like a successful extraction. No caller checked:
 * downloadAndExtract only unlinks the archive, and both downloadFile() and
 * loadCli.load() went on to report success while ./bin/<cli> did not exist, so
 * the first run failed with a missing-file message instead of the download that
 * never worked.
 */
export const extractBinary = async (archivePath, outputDir, binaryRegex, outputName,
    {operations} = {}) => serializeInstall(outputDir, async () => {
        assertSafeOutputName(outputName);
        const selected = await decodeSelected(archivePath, binaryRegex, outputName);
        return publishSelected(selected, outputDir, operations);
    });

/**
 * Takes several members out of an archive, each under its own name.
 *
 * extractBinary above renames whatever it matched to one output name, which is
 * right when the archive holds one executable and wrong the moment it holds
 * that executable and something the executable needs: iperf3's Windows build
 * is a Cygwin one, and the published zip carries iperf3.exe beside the
 * cygwin1.dll without which it will not start. Matched by that helper's rule
 * both files would be written to the same path, leaving whichever came second.
 *
 * The basename is kept rather than the archive's path, so a member nested in a
 * directory still lands beside its siblings in ./bin - and a crafted archive
 * cannot write outside the output directory by naming itself "../".
 *
 * The fourth parameter is ignored and present so this can be handed to
 * downloadAndExtract in place of extractBinary.
 */
export const extractFiles = async (archivePath, outputDir, fileRegex, _outputName,
    {requiredFiles, operations} = {}) => serializeInstall(outputDir, async () => {
        const selected = await decodeSelected(archivePath, fileRegex, null, requiredFiles);
        return publishSelected(selected, outputDir, operations);
    });
