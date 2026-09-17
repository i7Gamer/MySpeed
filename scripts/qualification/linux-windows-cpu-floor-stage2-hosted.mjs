import crypto from "node:crypto";
import {spawn} from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {readResourceObservation, resolveCgroupLayout,
    validateHostedContext} from "./linux-kvm-capability.mjs";
import {GUEST_FAILURE_FALLBACK_NAME, MAX_GUEST_BYTES, RECEIPT_REJECTION_CODES,
    MAX_PREDEADLINE_FRAME_BYTES,
    PREDEADLINE_FRAME_SKIPPED_REASONS,
    PREDEADLINE_FRAME_UNAVAILABLE_REASONS,
    PREDEADLINE_FRAME_MALFORMED_REASONS,
    STAGE2_PROVENANCE, TOP_LEVEL_PACKAGE_PINS, WINPE_DIAGNOSTIC_MEMBERS,
    WINPE_DIAGNOSTIC_OUTPUT_MARKER_NAME, validateWindowsSystemTools,
    winpeDiagnosticOutputMarker} from "./linux-windows-cpu-floor-stage2.mjs";
import {runEarlyBootQmpSession, validateInstallerBootConfirmation, validateInstallerBootInput,
    validateWinpeDiagnosticAuthorization, validateWinpeDiagnosticInput,
    validatePredeadlineScreenshotPath, PREDEADLINE_FRAME_FILENAME} from
    "./linux-windows-cpu-floor-stage2-qmp.mjs";

const APT_GET = "/usr/bin/apt-get";
const APT_CACHE = "/usr/bin/apt-cache";
const DPKG_DEB = "/usr/bin/dpkg-deb";
const GPGV = "/usr/bin/gpgv";
const INSTALL = "/usr/bin/install";
const KILL = "/usr/bin/kill";
const READLINK = "/usr/bin/readlink";
const SUDO = "/usr/bin/sudo";
const TIMEOUT = "/usr/bin/timeout";

const STAT = "/usr/bin/stat";
const UBUNTU_KEYRING = "/usr/share/keyrings/ubuntu-archive-keyring.gpg";
const COMMAND_TIMEOUT_MILLISECONDS = 30_000;
const PRIVILEGED_COMMAND_TIMEOUT_SECONDS = 25;
const WIM_EXTRACTION_TIMEOUT_MILLISECONDS = 900_000;
const DOWNLOAD_TIMEOUT_MILLISECONDS = 7_200_000;
const QEMU_TIMEOUT_SECONDS = 16_200;
const RESERVATION_KEYS = Object.freeze(["label", "executionMilliseconds", "cleanupMilliseconds"]);
const RESERVATION_LABEL = /^[a-z][a-z0-9-]{0,63}$/u;
const MINIMUM_RESERVATION_MILLISECONDS = 1_000;
const QEMU_OUTER_TIMEOUT_MILLISECONDS = 16_240_000;
export const DIAGNOSTIC_EXECUTION_MINUTES = 25;
export const DIAGNOSTIC_CLEANUP_MINUTES = 5;
export const DIAGNOSTIC_TIMEOUT_SECONDS = DIAGNOSTIC_EXECUTION_MINUTES * 60;
export const DIAGNOSTIC_CLEANUP_HEADROOM_SECONDS = 40;
export const DIAGNOSTIC_OUTER_TIMEOUT_MILLISECONDS =
    (DIAGNOSTIC_TIMEOUT_SECONDS + DIAGNOSTIC_CLEANUP_HEADROOM_SECONDS) * 1_000;
const OUTPUT_DISK_BYTES = 67_108_864n;
const MAX_WIMINFO_BYTES = 1_048_576;
const MAX_GUEST_FAILURE_MESSAGE_CHARACTERS = 512;
/*
 * The receipt extraction runs after QEMU has been reaped, inside the stage cleanup allowance
 * (DIAGNOSTIC_CLEANUP_MINUTES). Two sequential mcopy commands at the ordinary command timeout are
 * 60s against 300s of allowance and 360s of evidence retention reserve, so no deadline moves. The
 * budget shrinks across the pair so the fallback can never spend time the primary already used.
 */
const RECEIPT_EXTRACTION_BUDGET_MILLISECONDS = 2 * COMMAND_TIMEOUT_MILLISECONDS;
const CLEANUP_AUTHORITY_FILENAME = "cleanup-authority.json";
const CLEANUP_AUTHORITY_KIND = "myspeed-windows-cpu-floor-cleanup-authority";
const MAX_GUEST_ACTIVATION_FILE_BYTES = 1_048_576;
const MAX_GUEST_ACTIVATION_STRING_CHARACTERS = 1_024;
const MAX_PROBE_MANIFEST_BYTES = 262_144;
const MAX_STREAM_BYTES = 4_096;
const MAX_TREE_ENTRIES = 131_072;
const MAX_TREE_MANIFEST_BYTES = 33_554_432;
const DEFAULT_STAGE2_STREAM_BYTES = 2_097_152;
const QEMU_STREAM_BYTES = 65_536;
const MAX_EARLY_BOOT_SCREENSHOT_BYTES = 1_048_576;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PROCESS_CLEANUP_TIMEOUT_MILLISECONDS = 5_000;
const QEMU_IDENTITY_TIMEOUT_MILLISECONDS = 30_000;
const QEMU_CLEANUP_TIMEOUT_MILLISECONDS = 5_000;
const MAX_MONITOR_FAILURE_MESSAGE_CHARACTERS = 512;
const QEMU_IDENTITY_POLL_MILLISECONDS = 50;
const RESOURCE_POLL_MILLISECONDS = 5_000;
const LOW_MEMORY_ABORT_MILLISECONDS = 30_000;
const MINIMUM_RUNTIME_MEMORY_BYTES = 4_294_967_296n;
const MINIMUM_FREE_DISK_BYTES = 17_179_869_184n;
const MAXIMUM_TASK_BYTES = 63_986_931_712n;
const ILLEGAL_INSTRUCTION_EXIT = 3_221_225_501;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const REQUIRED_PROBE_ROLES = ["avx", "avx2", "cpuid", "illegal", "known-bad", "known-good", "popcnt", "sse42"];
const SEVEN_ZIP_LIBRARY_RELATIVE_PATH = "usr/lib/7zip";
const SEVEN_ZIP_RELATIVE_PATH = `${SEVEN_ZIP_LIBRARY_RELATIVE_PATH}/7z`;
const SEVEN_ZIP_MODULE_RELATIVE_PATH = `${SEVEN_ZIP_LIBRARY_RELATIVE_PATH}/7z.so`;
const SEVEN_ZIP_VERSION = "23.01";
const SEVEN_ZIP_ISO_FORMAT_PATTERN = /(?:^|\r?\n)[^\r\n]*\bIso\s+iso(?:\s|$)/u;
const INLINE_SEED_KINDS = new Set(["inline", "activation-handoff", "activation-inline", "activation-installer"]);

function sha256(bytes) {
    return crypto.createHash("sha256").update(bytes).digest("hex");
}

function assertSuccessful(observation, label) {
    if (!observation || !observation.process || observation.process.exitCode !== 0 ||
        observation.process.signal !== null || observation.process.timedOut !== false ||
        observation.process.stdoutOverflow !== false || observation.process.stderrOverflow !== false ||
        observation.process.cleanupProven !== true || observation.process.errorObserved !== false)
        throw new Error(`${label} did not complete safely`);
    return observation;
}

function appendBounded(chunks, chunk, state, maximumBytes) {
    if (state.overflow) return;
    const bytes = Buffer.from(chunk);
    const remaining = maximumBytes - state.bytes;
    if (bytes.length > remaining) {
        if (remaining > 0) chunks.push(bytes.subarray(0, remaining));
        state.bytes = maximumBytes;
        state.overflow = true;
        return;
    }
    chunks.push(bytes);
    state.bytes += bytes.length;
}

export async function runHostedOwnedProcess(command, argv, options = {}, dependencies = {}) {
    const maximumBytes = options.maxStreamBytes ?? DEFAULT_STAGE2_STREAM_BYTES;
    if (!Number.isInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > DEFAULT_STAGE2_STREAM_BYTES ||
        !Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) throw new TypeError("process bounds are invalid");
    const spawnImpl = dependencies.spawnImpl ?? spawn;
    const setTimer = dependencies.setTimer ?? setTimeout;
    const clearTimer = dependencies.clearTimer ?? clearTimeout;
    const killGroup = dependencies.killGroup ?? (pid => process.kill(-pid, "SIGKILL"));
    const isGroupAlive = dependencies.isGroupAlive ?? (pid => {
        try { process.kill(-pid, 0); return true; }
        catch (error) { if (error.code === "ESRCH") return false; throw error; }
    });
    return await new Promise((resolve, reject) => {
        const child = spawnImpl(command, argv, {stdio: [options.qmp ? "pipe" : "ignore", "pipe", "pipe"], detached: true,
            windowsHide: true, ...(options.env === undefined ? {} : {env: options.env})});
        const stdout = [], stderr = [];
        const stdoutState = {bytes: 0, overflow: false}, stderrState = {bytes: 0, overflow: false};
        let timedOut = false, errorObserved = false, settled = false, cleanupTimer = null, executionTimer = null;
        let qmpCancelHandle = null;
        const cancelQmp = () => {
            try { qmpCancelHandle?.cancel?.(); } catch { /* ignore */ }
        };
        const resolveResult = (exitCode, signal, cleanupProven) => {
            if (settled) return;
            settled = true;
            cancelQmp();
            if (executionTimer !== null) clearTimer(executionTimer);
            if (cleanupTimer !== null) clearTimer(cleanupTimer);
            child.stdin?.destroy();
            resolve({process: {exitCode, signal, timedOut, stdoutOverflow: stdoutState.overflow,
                stderrOverflow: stderrState.overflow, cleanupProven, errorObserved},
            stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr)});
        };
        options.onSpawn?.(child.pid);
        const terminate = reason => {
            cancelQmp();
            const externallyOwned = options.onTerminationRequested?.(reason) === true;
            if (!externallyOwned) try { killGroup(child.pid); } catch { /* cleanup remains unproved */ }
            if (cleanupTimer === null) cleanupTimer = setTimer(() => {
                child.stdout.destroy(); child.stderr.destroy(); child.unref?.();
                resolveResult(null, null, false);
            }, PROCESS_CLEANUP_TIMEOUT_MILLISECONDS);
            return externallyOwned;
        };
        options.onTerminationReady?.(terminate);
        executionTimer = setTimer(() => { timedOut = true; terminate("deadline"); }, options.timeoutMs);
        if (!options.qmp) child.stdout.on("data", chunk => {
            appendBounded(stdout, chunk, stdoutState, maximumBytes);
            if (stdoutState.overflow) terminate("stdout-overflow");
        });
        child.stderr.on("data", chunk => {
            appendBounded(stderr, chunk, stderrState, maximumBytes);
            if (stderrState.overflow) terminate("stderr-overflow");
        });
        child.once("error", error => {
            if (settled) return;
            cancelQmp();
            if (Number.isInteger(child.pid) && child.pid > 0) { errorObserved = true; terminate("process-error"); }
            else { settled = true; clearTimer(executionTimer); reject(error); }
        });
        child.once("close", (code, signal) => {
            if (settled) return;
            cancelQmp();
            let cleanupProven = false;
            try { cleanupProven = !isGroupAlive(child.pid); } catch { cleanupProven = false; }
            if (!cleanupProven) {
                if (terminate("lingering-process-group")) resolveResult(code, signal, false);
            } else resolveResult(code, signal, true);
        });
        if (options.qmp) {
            const writeBytes = bytes => new Promise((writeResolve, writeReject) => {
                if (!child.stdin || child.stdin.destroyed) return writeReject(new Error("QMP input pipe is unavailable"));
                child.stdin.write(bytes, error => error ? writeReject(error) : writeResolve());
            });
            const qmpSession = runEarlyBootQmpSession({
                readable: child.stdout,
                writeBytes,
                screenshotPaths: options.qmp.screenshotPaths,
                ...(options.qmp.bootConfirmation === undefined ? {} :
                    {bootConfirmation: options.qmp.bootConfirmation}),
                ...(options.qmp.lateScreenshotPaths ? {lateScreenshotPaths: options.qmp.lateScreenshotPaths} : {}),
                ...(options.qmp.winpeDiagnostic === undefined ? {} :
                    {winpeDiagnostic: options.qmp.winpeDiagnostic}),
                ...(options.qmp.predeadline ? {predeadline: options.qmp.predeadline} : {}),
                onSession: handle => {
                    qmpCancelHandle = handle;
                    options.onQmpSessionHandle?.(handle);
                    options.qmp.onSession?.(handle);
                },
                onLateObservation: promise => {
                    options.onLateObservation?.(promise);
                    options.qmp.onLateObservation?.(promise);
                },
                onPredeadlineObservation: observation => {
                    options.onPredeadlineObservation?.(observation);
                    options.qmp.onPredeadlineObservation?.(observation);
                }
            }, options.qmpDependencies);
            qmpSession.catch(() => undefined);
            options.onQmpSession?.(qmpSession);
        }
    });
}

function directChild(root, child, name) {
    if (path.posix.dirname(child) !== root || path.posix.basename(child) !== name)
        throw new TypeError(`${name} is not an exact direct child`);
    return child;
}

export function buildIsolatedAptVectors(pathsValue) {
    const aptRoot = `${pathsValue.root}/apt`;
    const sourceList = `${aptRoot}/sources.list`;
    const status = `${aptRoot}/status`;
    const lists = `${aptRoot}/lists`;
    const archives = pathsValue.packageRoot;
    const aptConfig = `${aptRoot}/apt.conf`;
    const aptEnvironment = Object.freeze({APT_CONFIG: aptConfig, HOME: aptRoot, LANG: "C", LC_ALL: "C",
        PATH: "/usr/sbin:/usr/bin:/sbin:/bin"});
    const common = ["-o", `Dir::Etc=${aptRoot}/etc`, "-o", `Dir::Etc::main=${aptConfig}`, "-o",
        `Dir::Etc::sourcelist=${sourceList}`, "-o", "Dir::Etc::sourceparts=-", "-o",
        "Dir::Etc::preferences=-", "-o", "Dir::Etc::preferencesparts=-", "-o",
        `Dir::State::status=${status}`, "-o", `Dir::State::lists=${lists}`, "-o", `Dir::Cache::archives=${archives}`,
        "-o", `Dir::State::extended_states=${aptRoot}/extended_states`, "-o", "Dir::Cache::pkgcache=", "-o",
        "Dir::Cache::srcpkgcache=", "-o", "DPkg::Pre-Invoke::=", "-o", "DPkg::Post-Invoke::=", "-o",
        "APT::Update::Pre-Invoke::=", "-o", "APT::Update::Post-Invoke::=", "-o",
        "APT::Update::Post-Invoke-Success::=", "-o", "Debug::NoLocking=true", "-o",
        "APT::Get::List-Cleanup=0", "-o", "Acquire::Languages=none"];
    const sourcesBytes = Buffer.from(STAGE2_PROVENANCE.ubuntuSnapshot.suites.map(suite =>
        `deb [arch=amd64 signed-by=${UBUNTU_KEYRING}] ${STAGE2_PROVENANCE.ubuntuSnapshot.baseUrl} ${suite} ` +
        `${STAGE2_PROVENANCE.ubuntuSnapshot.components.join(" ")}\n`).join(""));
    const pins = TOP_LEVEL_PACKAGE_PINS.map(value => `${value.name}:${value.architecture}=${value.version}`);
    const aptConfigBytes = Buffer.from(`Dir::Etc "${aptRoot}/etc";\nDir::Etc::Parts "-";\n` +
        `Dir::Etc::main "${aptConfig}";\n`, "utf8");
    return Object.freeze({aptRoot, aptConfig, aptConfigBytes, aptEnvironment, sourceList, status, lists, archives, common,
        sourcesBytes,
        emptyStatusBytes: Buffer.alloc(0),
        update: {command: APT_GET, argv: [...common, "update"]},
        resolve: {command: APT_GET, argv: [...common, "--simulate", "--no-install-recommends", "install", ...pins]},
        printUris: {command: APT_GET, argv: [...common, "--print-uris", "--yes", "--no-install-recommends",
            "--download-only", "install", ...pins]}});
}

function parseAptSimulation(bytes) {
    const text = new TextDecoder("utf-8", {fatal: true}).decode(bytes);
    const selected = [];
    for (const line of text.split(/\r?\n/u)) {
        const match = /^Inst ([a-z0-9+.-]+)(?::([a-z0-9]+))? \(([^ )]+) /u.exec(line);
        if (!match) continue;
        selected.push({name: match[1], architecture: match[2] ?? "amd64", version: match[3]});
    }
    if (selected.length < TOP_LEVEL_PACKAGE_PINS.length || selected.length > 512)
        throw new Error("apt simulation package set is invalid");
    return selected;
}

function parseDeb822(text) {
    const fields = new Map();
    let prior = null;
    for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
        if (/^[ \t]/u.test(line) && prior !== null) {
            fields.set(prior, `${fields.get(prior)} ${line.trim()}`); continue;
        }
        const match = /^([A-Za-z0-9-]+):\s*(.*)$/u.exec(line);
        if (!match) continue;
        if (!fields.has(match[1])) fields.set(match[1], match[2]);
        prior = match[1];
    }
    return fields;
}

function dependencyNames(expression) {
    if (!expression) return [];
    return expression.split(",").map(group => group.split("|").map(item => {
        const match = /^\s*([a-z0-9+.-]+)(?::(?:any|native|amd64|all))?/u.exec(item);
        return match?.[1] ?? null;
    }).filter(Boolean));
}

function providedNames(expression) {
    if (!expression) return [];
    return expression.split(",").map(item => {
        const match = /^\s*([a-z0-9+.-]+)(?::(?:any|native|amd64|all))?(?:\s*\([^)]*\))?\s*$/u.exec(item);
        if (!match) throw new Error("apt provided package name is invalid");
        return match[1];
    });
}

export function resolveSelectedDependencies(records, dependencyExpressions, provideExpressions) {
    const selectedByName = new Map(records.map(record => [record.name, record]));
    const providers = new Map();
    for (const record of records) {
        for (const name of providedNames(provideExpressions.get(record.name))) {
            const values = providers.get(name) ?? [];
            values.push(record);
            providers.set(name, values);
        }
    }
    for (const record of records) {
        const edges = new Set();
        for (const expression of dependencyExpressions.get(record.name) ?? []) {
            for (const alternatives of dependencyNames(expression)) {
                const candidates = new Map();
                for (const name of alternatives) {
                    const direct = selectedByName.get(name);
                    if (direct) candidates.set(reference(direct), direct);
                    for (const provider of providers.get(name) ?? []) candidates.set(reference(provider), provider);
                }
                if (candidates.size !== 1)
                    throw new Error(`apt selected dependency for ${record.name} is unavailable or ambiguous`);
                edges.add([...candidates.keys()][0]);
            }
        }
        record.dependsOn = [...edges].sort();
    }
    return records;
}

export function parseInReleaseIndexes(bytes, suite) {
    const text = new TextDecoder("utf-8", {fatal: true}).decode(bytes);
    const start = text.indexOf("\nSHA256:\n");
    if (start < 0) throw new Error("InRelease SHA256 section is absent");
    const lines = text.slice(start + 9).split("\n");
    const records = new Map();
    for (const line of lines) {
        if (!line.startsWith(" ")) break;
        const match = /^ ([a-f0-9]{64})\s+(0|[1-9][0-9]*)\s+(.+)$/u.exec(line);
        if (!match) throw new Error("signed package index checksum row is malformed");
        const relative = match[3];
        const component = relative.split("/")[0];
        if (!STAGE2_PROVENANCE.ubuntuSnapshot.components.includes(component) ||
            relative !== `${component}/binary-amd64/Packages.xz`) continue;
        if (match[2] === "0") throw new Error("signed package index size is invalid");
        if (records.has(component)) throw new Error("signed package index is duplicated");
        records.set(component, {suite, component, architecture: "amd64", path: `dists/${suite}/${relative}`,
            bytes: match[2], sha256: match[1], listedSha256: match[1]});
    }
    if (records.size !== STAGE2_PROVENANCE.ubuntuSnapshot.components.length)
        throw new Error("signed package index set is incomplete");
    return STAGE2_PROVENANCE.ubuntuSnapshot.components.map(component => records.get(component));
}

async function collectAptClosure(io, {context, paths: pathsValue, vectors}) {
    const simulation = assertSuccessful(await io.runOwned(vectors.resolve.command, vectors.resolve.argv,
        {timeoutMs: COMMAND_TIMEOUT_MILLISECONDS, env: vectors.aptEnvironment}), "apt closure simulation");
    const selected = parseAptSimulation(simulation.stdout);
    const records = [];
    const dependencyExpressions = new Map(), provideExpressions = new Map();
    for (const selection of selected) {
        const observation = assertSuccessful(await io.runOwned(APT_CACHE,
            [...vectors.common, "show", "--no-all-versions",
                `${selection.name}:${selection.architecture}=${selection.version}`],
            {timeoutMs: COMMAND_TIMEOUT_MILLISECONDS, env: vectors.aptEnvironment}), "apt package metadata");
        const fields = parseDeb822(new TextDecoder("utf-8", {fatal: true}).decode(observation.stdout).split(/\n\s*\n/u)[0]);
        const record = {name: fields.get("Package"), version: fields.get("Version"),
            architecture: fields.get("Architecture"), filename: fields.get("Filename"), bytes: fields.get("Size"),
            sha256: fields.get("SHA256"), dependsOn: []};
        if (record.name !== selection.name || record.version !== selection.version ||
            ![selection.architecture, "all"].includes(record.architecture) || !record.filename || !record.bytes ||
            !record.sha256) throw new Error("apt selected package metadata differs");
        records.push(record);
        dependencyExpressions.set(record.name, [fields.get("Pre-Depends"), fields.get("Depends")].filter(Boolean));
        provideExpressions.set(record.name, fields.get("Provides"));
    }
    resolveSelectedDependencies(records, dependencyExpressions, provideExpressions);
    const releases = [], indexes = [];
    for (const suite of STAGE2_PROVENANCE.ubuntuSnapshot.suites) {
        const releasePath = `${vectors.lists}/snapshot.ubuntu.com_ubuntu_${STAGE2_PROVENANCE.ubuntuSnapshot.id}_dists_${suite}_InRelease`;
        const releaseBytes = io.readOwned(releasePath);
        const signature = assertSuccessful(await io.runOwned(GPGV,
            ["--status-fd=1", "--keyring", UBUNTU_KEYRING, releasePath],
            {timeoutMs: COMMAND_TIMEOUT_MILLISECONDS}), "Ubuntu InRelease signature");
        const status = signature.stdout.toString("utf8");
        if (!status.includes(`[GNUPG:] VALIDSIG ${STAGE2_PROVENANCE.ubuntuArchiveSignerFingerprint.toUpperCase()} `) &&
            !status.includes(`[GNUPG:] VALIDSIG ${STAGE2_PROVENANCE.ubuntuArchiveSignerFingerprint} `))
            throw new Error("Ubuntu InRelease signer differs");
        const releaseHash = sha256(releaseBytes);
        releases.push({suite, inReleasePath: `dists/${suite}/InRelease`, bytes: String(releaseBytes.length),
            sha256: releaseHash, signatureVerified: true,
            signerFingerprint: STAGE2_PROVENANCE.ubuntuArchiveSignerFingerprint});
        for (const index of parseInReleaseIndexes(releaseBytes, suite)) {
            const target = `${vectors.aptRoot}/signed-${suite}-${index.component}-Packages.xz`;
            await io.downloadPinned({url: `${STAGE2_PROVENANCE.ubuntuSnapshot.baseUrl}${index.path}`,
                path: target, bytes: index.bytes, sha256: index.sha256});
            indexes.push({...index, inReleaseSha256: releaseHash});
        }
    }
    void context;
    return {schemaVersion: 1, snapshot: structuredClone(STAGE2_PROVENANCE.ubuntuSnapshot), indexes, releases,
        roots: TOP_LEVEL_PACKAGE_PINS.map(value => value.name), packages: records};
}

function parseBlocks(bytes, maximumBytes, label) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > maximumBytes)
        throw new TypeError(`${label} exceeded its bound`);
    let text;
    try { text = new TextDecoder("utf-8", {fatal: true}).decode(bytes); }
    catch { throw new TypeError(`${label} is not UTF-8`); }
    return text.replace(/\r\n/g, "\n").trim().split(/\n\s*\n/u);
}

export function parseWimInfo(bytes) {
    const imageBlocks = parseBlocks(bytes, MAX_WIMINFO_BYTES, "WIM metadata")
        .flatMap(block => block.split(/(?=^Index:\s*)/mu)).filter(block => /^Index:\s*/u.test(block));
    if (imageBlocks.length < 1 || imageBlocks.length > 64) throw new TypeError("WIM image set is invalid");
    return imageBlocks.map(block => {
        const fields = new Map();
        for (const line of block.split("\n")) {
            const match = /^([^:]+):\s*(.*)$/u.exec(line);
            if (!match || fields.has(match[1])) throw new TypeError("WIM metadata field is invalid");
            fields.set(match[1], match[2]);
        }
        const index = Number(fields.get("Index"));
        const architecture = fields.get("Architecture") === "x86_64" ? "x64" : fields.get("Architecture");
        const value = {index, name: fields.get("Name"), architecture, editionId: fields.get("Edition ID"),
            installationType: fields.get("Installation Type"), totalBytes: fields.get("Total Bytes")};
        if (!Number.isInteger(index) || index < 1 || Object.values(value).some(item => item === undefined))
            throw new TypeError("WIM metadata record is incomplete");
        return value;
    });
}

function decodeBase64(value, label) {
    if (typeof value !== "string" || value.length > Math.ceil(MAX_STREAM_BYTES / 3) * 4)
        throw new TypeError(`${label} is invalid`);
    const bytes = Buffer.from(value, "base64");
    if (bytes.toString("base64") !== value || bytes.length > MAX_STREAM_BYTES)
        throw new TypeError(`${label} is invalid`);
    return bytes;
}

function parseJson(bytes, label) {
    let text;
    try { text = new TextDecoder("utf-8", {fatal: true}).decode(bytes).trim(); }
    catch { throw new TypeError(`${label} is not UTF-8`); }
    try { return JSON.parse(text); } catch { throw new TypeError(`${label} is not JSON`); }
}

/*
 * Which region of the receipt parsers refused a receipt, recorded beside the rejection instead of
 * on it. A WeakMap keyed by the thrown error keeps the error itself byte-identical to the one this
 * module has always thrown - same class, same message, same own properties - so callers that match
 * on either are unaffected, and nothing new can leak into anything that serializes an error.
 *
 * It is also the provenance boundary. A code is only ever read back out of this map, so an error
 * that merely carries a `code` property, a copy of a genuine rejection, or any value a guest could
 * influence resolves to null and is published as the historical `schema-invalid`. The allowlist is
 * checked on the way out as well, so a typo inside this module cannot publish an unknown reason.
 */
const RECEIPT_REJECTIONS = new WeakMap();

export function receiptRejectionCode(error) {
    const code = RECEIPT_REJECTIONS.get(error);
    return typeof code === "string" && RECEIPT_REJECTION_CODES.includes(code) ? code : null;
}

/*
 * Wrap an existing check region without touching what it checks. The innermost region wins, so a
 * nested wrapper can never relabel a rejection a more specific one already accounted for.
 */
function rejectIn(code, region) {
    try {
        return region();
    } catch (error) {
        if (error instanceof Error && !RECEIPT_REJECTIONS.has(error)) RECEIPT_REJECTIONS.set(error, code);
        throw error;
    }
}

function requireKeys(value, keys, label) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort()))
        throw new TypeError(`${label} schema is invalid`);
}

function parseControl(run, role, expectedExit, expectedResult) {
    if (run.exitCode !== expectedExit || decodeBase64(run.stderrBase64, `${role} stderr`).length !== 0)
        throw new TypeError(`${role} control failed`);
    const output = parseJson(decodeBase64(run.stdoutBase64, `${role} stdout`), `${role} output`);
    requireKeys(output, ["kind", "result", "schemaVersion"], `${role} output`);
    if (output.schemaVersion !== 1 || output.kind !== role || output.result !== expectedResult)
        throw new TypeError(`${role} control failed`);
}

function parseGuestActivation(value) {
    requireKeys(value, ["files", "nativeMsiExecutionStarted", "setupCompleted", "startupTask",
        "startupTaskInstalled", "state"], "guest activation");
    if (value.state !== "windows-setup-complete-startup-dispatch-ready" || value.setupCompleted !== true ||
        value.startupTaskInstalled !== true || value.nativeMsiExecutionStarted !== false)
        throw new TypeError("guest activation state is invalid");
    requireKeys(value.files, ["dispatcher", "setupComplete"], "guest activation files");
    for (const [name, expectedPath] of [["setupComplete", "C:\\Windows\\Setup\\Scripts\\SetupComplete.cmd"],
        ["dispatcher", "C:\\Windows\\Setup\\Scripts\\myspeed-msi-setupcomplete.ps1"]]) {
        const file = value.files[name];
        requireKeys(file, ["bytes", "path", "sha256"], `guest activation ${name}`);
        if (file.path !== expectedPath || !Number.isSafeInteger(file.bytes) || file.bytes < 1 ||
            file.bytes > MAX_GUEST_ACTIVATION_FILE_BYTES || typeof file.sha256 !== "string" ||
            !SHA256_PATTERN.test(file.sha256)) throw new TypeError(`guest activation ${name} is invalid`);
    }
    requireKeys(value.startupTask, ["arguments", "executable", "name", "path", "principal", "runLevel", "trigger"],
        "guest activation startup task");
    for (const field of Object.values(value.startupTask))
        if (typeof field !== "string" || field.length < 1 || field.length > MAX_GUEST_ACTIVATION_STRING_CHARACTERS ||
            /[\x00-\x1f\x7f]/u.test(field)) throw new TypeError("guest activation startup task is invalid");
    return structuredClone(value);
}

export function parseGuestOutput(bytes, expectedNonce) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_GUEST_BYTES)
        throw new TypeError("guest result exceeded its bound");
    const value = parseJson(bytes, "guest result");
    rejectIn("result-header-invalid", () => {
        requireKeys(value, ["activation", "network", "nonce", "runs", "schemaVersion", "systemTools"], "guest result");
        if (value.schemaVersion !== 1 || value.nonce !== expectedNonce || !Array.isArray(value.runs) ||
            value.runs.length !== REQUIRED_PROBE_ROLES.length) throw new TypeError("guest result header is invalid");
    });
    const runs = rejectIn("probe-run-invalid", () => {
        const collected = new Map();
        for (const run of value.runs) {
            requireKeys(run, ["exitCode", "role", "stderrBase64", "stdoutBase64"], "guest probe run");
            if (!REQUIRED_PROBE_ROLES.includes(run.role) || collected.has(run.role) ||
                !Number.isInteger(run.exitCode) || run.exitCode < 0 || run.exitCode > 0xffff_ffff)
                throw new TypeError("guest probe run is invalid");
            collected.set(run.role, run);
        }
        return collected;
    });
    const cpuidRun = runs.get("cpuid");
    rejectIn("cpuid-run-failed", () => {
        if (cpuidRun.exitCode !== 0 || decodeBase64(cpuidRun.stderrBase64, "CPUID stderr").length !== 0)
            throw new TypeError("CPUID run failed");
    });
    const cpuid = rejectIn("cpuid-output-invalid", () => {
        const observed = parseJson(decodeBase64(cpuidRun.stdoutBase64, "CPUID stdout"), "CPUID output");
        requireKeys(observed, ["features", "kind", "leaf1", "leaf7Subleaf0", "maxBasicLeaf", "schemaVersion", "xcr0"],
            "CPUID output");
        requireKeys(observed.features, ["avx", "avx2", "osxsave", "popcnt", "sse42"], "CPUID features");
        requireKeys(observed.leaf1, ["eax", "ebx", "ecx", "edx"], "CPUID leaf1");
        requireKeys(observed.leaf7Subleaf0, ["eax", "ebx", "ecx", "edx"], "CPUID leaf7");
        const register = /^0x[a-f0-9]{8}$/u;
        for (const item of [...Object.values(observed.leaf1), ...Object.values(observed.leaf7Subleaf0)])
            if (typeof item !== "string" || !register.test(item)) throw new TypeError("CPUID register is invalid");
        if (!Number.isInteger(observed.maxBasicLeaf) || observed.maxBasicLeaf < 7 ||
            observed.maxBasicLeaf > 0xffff_ffff) throw new TypeError("CPUID maximum basic leaf is invalid");
        return observed;
    });
    const recomputed = rejectIn("cpu-floor-unmet", () => {
        const leaf1 = Number.parseInt(cpuid.leaf1.ecx.slice(2), 16);
        const leaf7 = Number.parseInt(cpuid.leaf7Subleaf0.ebx.slice(2), 16);
        const observed = {sse42: ((leaf1 >>> 20) & 1) === 1, popcnt: ((leaf1 >>> 23) & 1) === 1,
            osxsave: ((leaf1 >>> 27) & 1) === 1, avx: ((leaf1 >>> 28) & 1) === 1,
            avx2: ((leaf7 >>> 5) & 1) === 1};
        if (cpuid.schemaVersion !== 1 || cpuid.kind !== "cpuid" ||
            Object.keys(observed).some(key => cpuid.features[key] !== observed[key]) ||
            observed.sse42 !== true || observed.popcnt !== true || observed.osxsave !== false ||
            observed.avx !== false || observed.avx2 !== false || cpuid.xcr0 !== null)
            throw new TypeError("CPUID target floor is invalid");
        return observed;
    });
    rejectIn("control-probe-mismatch", () => {
        parseControl(runs.get("known-good"), "known-good", 0, 42);
        parseControl(runs.get("known-bad"), "known-bad", 19, 13);
        parseControl(runs.get("sse42"), "sse42", 0, 2_276_049_685);
        parseControl(runs.get("popcnt"), "popcnt", 0, 32);
    });
    rejectIn("fault-probe-not-illegal", () => {
        for (const role of ["illegal", "avx", "avx2"]) {
            const run = runs.get(role);
            if (run.exitCode !== ILLEGAL_INSTRUCTION_EXIT ||
                decodeBase64(run.stdoutBase64, `${role} stdout`).length !== 0 ||
                decodeBase64(run.stderrBase64, `${role} stderr`).length !== 0)
                throw new TypeError(`${role.toUpperCase()} did not terminate with illegal instruction`);
        }
    });
    rejectIn("network-not-isolated", () => {
        requireKeys(value.network, ["enabledNonLoopbackInterfaces", "hardwareNics", "nonLoopbackRoutes"],
            "guest network");
        if (![value.network.hardwareNics, value.network.enabledNonLoopbackInterfaces,
            value.network.nonLoopbackRoutes].every(item => item === 0))
            throw new TypeError("guest network was not isolated");
    });
    return {activation: rejectIn("activation-invalid", () => parseGuestActivation(value.activation)),
        cpu: recomputed,
        instructions: {sse42: "completed", popcnt: "completed", avx: "illegal-instruction",
            avx2: "illegal-instruction"}, network: structuredClone(value.network),
        systemTools: rejectIn("system-tools-invalid", () => validateWindowsSystemTools(value.systemTools))};
}

export function parseGuestFailure(bytes, expectedNonce) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_GUEST_BYTES)
        throw new TypeError("guest failure evidence exceeded its bound");
    const value = parseJson(bytes, "guest failure evidence");
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new TypeError("guest failure evidence schema is invalid");
    const keys = Object.keys(value).sort();
    const isWorker = JSON.stringify(keys) === JSON.stringify(["failure", "hostNonce", "schemaVersion", "stage", "status"]);
    const isBootstrap = JSON.stringify(keys) === JSON.stringify(["failure", "nonce", "schemaVersion", "stage", "status"]);
    if (!isWorker && !isBootstrap)
        throw new TypeError("guest failure evidence schema is invalid");
    if (value.schemaVersion !== 1 || value.status !== "failed" || typeof value.failure !== "string" ||
        value.failure.length < 1 || value.failure.length > MAX_GUEST_FAILURE_MESSAGE_CHARACTERS ||
        /[\x00-\x1f\x7f]/u.test(value.failure))
        throw new TypeError("guest failure evidence is invalid");
    if (isWorker) {
        if (value.stage !== "post-setup-completion" || value.hostNonce !== expectedNonce)
            throw new TypeError("guest failure evidence is invalid");
        return {schemaVersion: 1, status: "failed", nonce: value.hostNonce, stage: "post-setup-completion", failure: value.failure};
    }
    if (value.stage !== "guest-bootstrap" || value.nonce !== expectedNonce)
        throw new TypeError("guest failure evidence is invalid");
    return {schemaVersion: 1, status: "failed", nonce: value.nonce, stage: "guest-bootstrap", failure: value.failure};
}

export function parseGuestOutcome(bytes, expectedNonce) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_GUEST_BYTES)
        throw new TypeError("guest outcome evidence exceeded its bound");
    const value = parseJson(bytes, "guest outcome evidence");
    return value?.status === "failed" ? parseGuestFailure(bytes, expectedNonce) : parseGuestOutput(bytes, expectedNonce);
}

export function parseProbeArtifactEvidence(bytes, artifact) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_PROBE_MANIFEST_BYTES)
        throw new TypeError("probe evidence exceeded its bound");
    const value = parseJson(bytes, "probe evidence");
    requireKeys(value, ["calibrationPassed", "classification", "eventSha", "failures", "imageVersion", "kind", "nonce",
        "observations", "qualifying", "runAttempt", "runId", "schemaVersion", "sourceSha", "status"], "probe evidence");
    if (value.schemaVersion !== 1 || value.kind !== "myspeed-windows-cpu-readiness" || value.status !== "completed" ||
        value.qualifying !== false || value.calibrationPassed !== true ||
        value.classification !== "windows-native-host-observation-nonqualifying" ||
        value.sourceSha !== artifact.sourceSha || value.runId !== artifact.runId || value.runAttempt !== artifact.runAttempt ||
        !Array.isArray(value.failures) || value.failures.length !== 0)
        throw new TypeError("probe evidence header differs");
    requireKeys(value.observations, ["build", "calibration", "cleanup", "closureFiles", "disassembly", "discovery",
        "operations", "preflight"], "probe evidence observations");
    if (!Array.isArray(value.observations.build) || value.observations.build.length !== REQUIRED_PROBE_ROLES.length)
        throw new TypeError("probe evidence build set differs");
    const builds = new Map();
    for (const record of value.observations.build) {
        requireKeys(record, ["architecture", "compileArguments", "executable", "linkArguments", "macro", "mode", "object"],
            "probe build record");
        if (!REQUIRED_PROBE_ROLES.includes(record.mode) || builds.has(record.mode))
            throw new TypeError("probe build mode differs");
        requireKeys(record.executable, ["bytes", "fileId", "fileVersion", "finalPath", "lastWriteFileTime", "linkCount",
            "name", "path", "productVersion", "role", "schemaVersion", "sha256", "volumeSerial"],
        "probe executable identity");
        builds.set(record.mode, record.executable);
    }
    for (const expected of artifact.files) {
        const observed = builds.get(expected.role);
        if (!observed || observed.role !== "generated-command" || !Number.isSafeInteger(observed.bytes) ||
            observed.bytes < 1 || String(observed.bytes) !== expected.bytes ||
            observed.sha256 !== expected.sha256 || path.win32.basename(observed.path) !== expected.name)
            throw new TypeError("probe executable evidence differs");
    }
    requireKeys(value.observations.calibration, ["assessment", "calibrationPassed", "runs"], "probe calibration");
    if (value.observations.calibration.calibrationPassed !== true ||
        value.observations.calibration.assessment?.calibrationPassed !== true)
        throw new TypeError("probe calibration did not pass");
    return Object.freeze({sourceSha: value.sourceSha, runId: value.runId, runAttempt: value.runAttempt,
        eventSha: value.eventSha, nonce: value.nonce, imageVersion: value.imageVersion});
}

/*
 * ---------------------------------------------------------------------------------------------
 * WinPE answer-file diagnostic: bounded extraction, decoding, redaction and publication.
 *
 * The bound is enforced while mcopy runs, not after it. `mcopy -i <disk> ::<member> -` writes the
 * member to stdout (GNU mtools: a destination of `-` is standard output), and the shipped
 * `runHostedOwnedProcess` caps that stream, terminates the process group the moment the cap is
 * exceeded and reports whether the group was proven gone. No temporary file is created, so a member
 * a rogue guest grew without limit can neither fill the runner disk nor be read back whole. A
 * pre-size check would bound nothing: the source can grow between the check and the copy, and only
 * the collector's own accounting is evidence.
 *
 * Order of operations: read(cap) -> decode(bounded) -> account for every secret occurrence in the
 * raw bytes -> redact -> re-check the exact bytes that would be published, in both supported
 * encodings -> only then truncate for publication. Truncating first is what leaks a split secret,
 * so truncation is last; and a global nonzero redaction count is not proof that redaction was
 * complete, so the occurrences are counted per encoding and matched against what was redacted.
 * Anything that does not add up is withheld rather than sanitized harder.
 * ---------------------------------------------------------------------------------------------
 */
export const WINPE_DIAGNOSTIC_MEMBER_READ_BYTES = 262_144;
export const WINPE_DIAGNOSTIC_PUBLISHED_BYTES = 131_072;
export const WINPE_DIAGNOSTIC_REDACTION_MARKER = "[redacted]";
export const WINPE_DIAGNOSTIC_PARTIAL_REDACTION_MARKER = "[redacted-partial]";
/* Shorter than this is not treated as a credential fragment, and the threshold is asserted. */
export const WINPE_DIAGNOSTIC_MINIMUM_SECRET_FRAGMENT = 8;
/* The two encodings this pipeline can reason about. It claims nothing about any other. */
const WINPE_DIAGNOSTIC_ENCODINGS = Object.freeze(["utf-8", "utf-16le"]);
const WINPE_DIAGNOSTIC_UTF16_NUL_DENSITY = 0.3;
const MAX_WINPE_DIAGNOSTIC_REASON_CHARACTERS = 256;

/*
 * The one secret this diagnostic can meet, derived host-side from the run nonce exactly as the
 * answer-file renderer derives it, so the collector never has to be handed a password.
 */
export function winpeDiagnosticGuestSecret(nonce) {
    if (typeof nonce !== "string" || !/^[a-f0-9]{32}$/u.test(nonce))
        throw new TypeError("WinPE diagnostic nonce is invalid");
    return `Myspeed-Eval-${nonce.slice(0, 16)}!aA1`;
}

function winpeDiagnosticEncodedSecret(secret, encoding) {
    return Buffer.from(secret, encoding === "utf-16le" ? "utf16le" : "utf8");
}

function countOccurrences(haystack, needle) {
    if (needle.length === 0) return 0;
    let count = 0, index = haystack.indexOf(needle);
    while (index >= 0) { count += 1; index = haystack.indexOf(needle, index + needle.length); }
    return count;
}

export function detectWinpeDiagnosticEncoding(bytes) {
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return {encoding: "utf-16le", bom: 2};
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
        return {encoding: "utf-8", bom: 3};
    /* No BOM: Windows Setup logs are commonly UTF-16LE, which shows a NUL in every odd position. */
    const sample = Math.min(bytes.length, 4_096);
    let oddNuls = 0, oddTotal = 0;
    for (let index = 1; index < sample; index += 2) { oddTotal += 1; if (bytes[index] === 0) oddNuls += 1; }
    if (oddTotal >= 16 && oddNuls / oddTotal >= WINPE_DIAGNOSTIC_UTF16_NUL_DENSITY)
        return {encoding: "utf-16le", bom: 0};
    return {encoding: "utf-8", bom: 0};
}

export function decodeWinpeDiagnosticBytes(bytes) {
    const {encoding, bom} = detectWinpeDiagnosticEncoding(bytes);
    let body = bytes.subarray(bom);
    let trailingOddByte = false;
    /* The read cap can cut a UTF-16 unit in half; the half unit is dropped, never guessed at. */
    if (encoding === "utf-16le" && body.length % 2 === 1) {
        body = body.subarray(0, body.length - 1);
        trailingOddByte = true;
    }
    const text = new TextDecoder(encoding, {fatal: false}).decode(body);
    /* UTF-16LE yields at most one character per two bytes, UTF-8 at most one per byte. */
    if (text.length > WINPE_DIAGNOSTIC_MEMBER_READ_BYTES)
        throw new Error("decoded expansion exceeded its bound");
    const replacements = (text.match(/�/gu) ?? []).length;
    return Object.freeze({encoding, bom: bom > 0, trailingOddByte, text, replacements});
}

/* Every proper prefix of a secret, longest first, so a split tail is caught by the longest match. */
function secretPrefixes(secret) {
    const prefixes = [];
    for (let length = secret.length - 1; length >= WINPE_DIAGNOSTIC_MINIMUM_SECRET_FRAGMENT; length -= 1)
        prefixes.push(secret.slice(0, length));
    return prefixes;
}

export function redactWinpeDiagnosticText(text, secrets) {
    let redacted = text;
    let hits = 0, partialHits = 0;
    for (const secret of secrets) {
        const parts = redacted.split(secret);
        hits += parts.length - 1;
        redacted = parts.join(WINPE_DIAGNOSTIC_REDACTION_MARKER);
    }
    /*
     * The read cap can cut a secret in half and the surviving head is still a credential fragment.
     * Only the very end of the buffer can hold one, so only the tail is swept.
     */
    for (const secret of secrets) {
        const window = Math.min(redacted.length, secret.length - 1);
        if (window < WINPE_DIAGNOSTIC_MINIMUM_SECRET_FRAGMENT) continue;
        const head = redacted.slice(0, redacted.length - window);
        let tail = redacted.slice(redacted.length - window);
        for (const prefix of secretPrefixes(secret)) {
            if (tail.endsWith(prefix)) {
                tail = `${tail.slice(0, tail.length - prefix.length)}${WINPE_DIAGNOSTIC_PARTIAL_REDACTION_MARKER}`;
                partialHits += 1;
                break;
            }
        }
        redacted = `${head}${tail}`;
    }
    return {text: redacted, hits, partialHits};
}

/*
 * The last word on whether anything may be published: the exact bytes, searched in both supported
 * encodings, for a whole secret anywhere or a secret head at the very end. This is what makes the
 * hit count unnecessary as proof - it is checked against the artefact, not against the bookkeeping.
 */
export function winpeDiagnosticBytesCarrySecret(bytes, secrets) {
    for (const secret of secrets) {
        for (const encoding of WINPE_DIAGNOSTIC_ENCODINGS) {
            const encoded = winpeDiagnosticEncodedSecret(secret, encoding);
            if (bytes.includes(encoded)) return true;
            const unit = encoding === "utf-16le" ? 2 : 1;
            const minimum = WINPE_DIAGNOSTIC_MINIMUM_SECRET_FRAGMENT * unit;
            for (let length = encoded.length - unit; length >= minimum; length -= unit)
                if (bytes.length >= length && bytes.subarray(bytes.length - length).equals(encoded.subarray(0, length)))
                    return true;
        }
    }
    return false;
}

function boundedReason(value) {
    return String(value).replace(/[\x00-\x1f\x7f]+/gu, " ").slice(0, MAX_WINPE_DIAGNOSTIC_REASON_CHARACTERS) ||
        "unspecified";
}

/*
 * Publication of one extracted member. Absent evidence, a timed-out extraction, a tool failure and
 * an extraction whose own process group was not proven gone are four different outcomes, and none
 * of them is allowed to read as "collected nothing, all well".
 */
export function publishWinpeDiagnosticMember(name, observed, secrets) {
    const state = observed?.process ?? {};
    const stdout = observed?.stdout ?? Buffer.alloc(0);
    const base = {name, acceptedBytes: stdout.length, readCapReached: state.stdoutOverflow === true};
    const withheld = (status, reason) => Object.freeze({...base, status, reason: boundedReason(reason)});
    if (state.timedOut === true) return withheld("timeout", "extraction deadline exceeded");
    if (state.errorObserved === true) return withheld("tool-error", "extraction process error");
    if (state.cleanupProven !== true)
        return withheld("cleanup-unproven", "extraction process group was not proven gone");
    if (state.exitCode !== 0 && state.stdoutOverflow !== true)
        return Object.freeze({...base, status: "absent", exitCode: state.exitCode ?? null});
    let decoded;
    try { decoded = decodeWinpeDiagnosticBytes(stdout); }
    catch (error) { return withheld("unreadable", error instanceof Error ? error.message : error); }
    /*
     * Per-encoding accounting. A member that carries a secret in an encoding the decode did not
     * choose cannot be redacted by operating on the decoded text, and the fact that some other
     * occurrence redacted cleanly says nothing about this one - so it is withheld outright.
     */
    const rawCounts = Object.fromEntries(WINPE_DIAGNOSTIC_ENCODINGS.map(encoding => [encoding,
        secrets.reduce((sum, secret) =>
            sum + countOccurrences(stdout, winpeDiagnosticEncodedSecret(secret, encoding)), 0)]));
    const foreign = WINPE_DIAGNOSTIC_ENCODINGS
        .filter(encoding => encoding !== decoded.encoding)
        .reduce((sum, encoding) => sum + rawCounts[encoding], 0);
    if (foreign > 0)
        return withheld("withheld-mixed-encoding",
            `secret present in an encoding other than the decoded ${decoded.encoding}`);
    const {text, hits, partialHits} = redactWinpeDiagnosticText(decoded.text, secrets);
    if (hits < rawCounts[decoded.encoding])
        return withheld("withheld-unaccounted",
            `${rawCounts[decoded.encoding]} raw occurrences but ${hits} redacted`);
    /* Markers may only ever add their own length, once per hit. */
    const expansionBound = decoded.text.length + hits * WINPE_DIAGNOSTIC_REDACTION_MARKER.length +
        partialHits * WINPE_DIAGNOSTIC_PARTIAL_REDACTION_MARKER.length;
    if (text.length > expansionBound)
        return withheld("withheld-unredactable", "redaction expanded beyond its bound");
    const full = Buffer.from(text, "utf8");
    const published = full.subarray(0, WINPE_DIAGNOSTIC_PUBLISHED_BYTES);
    for (const candidate of [full, published])
        if (winpeDiagnosticBytesCarrySecret(candidate, secrets))
            return withheld("withheld-unredactable", "publishable bytes still carry a secret");
    return Object.freeze({...base, status: "captured", encoding: decoded.encoding, bom: decoded.bom,
        trailingOddByte: decoded.trailingOddByte, decodeReplacements: decoded.replacements,
        redactionHits: hits, partialRedactionHits: partialHits,
        publishedBytes: published.length, publicationTruncated: full.length > WINPE_DIAGNOSTIC_PUBLISHED_BYTES,
        sha256: sha256(published), textBase64: published.toString("base64")});
}

/*
 * ---------------------------------------------------------------------------------------------
 * WinPE answer-file diagnostic: the whole-job bound.
 *
 * Anchored to authenticated job metadata, exactly as the reviewed Stage 3 CPU workflow anchors its
 * sequence: the job's own `started_at` from the API, one unambiguous in-progress match or nothing.
 * There is no fallback to a fresh local clock, because a fresh clock is the error being corrected.
 *
 * The execute job declares a 25-minute ceiling. That is a planning limit, not a promise about how
 * long anything takes: the GitHub job timeout is the final hard stop and is never the mechanism
 * that reserves anything. Out of the ceiling come, in order, the retention reserve that has to be
 * left for bounding and uploading the evidence, the cleanup allowance that funds proving the
 * process group gone and re-validating the output disk, and the collection reserve that funds the
 * extraction itself. Whatever is left may fund the guest - and if that is less than the six minutes
 * the guest allowance asks for, the run is refused before QEMU is launched rather than started on a
 * budget that cannot reach the +300s frame.
 * ---------------------------------------------------------------------------------------------
 */
const MINUTE_MILLISECONDS = 60_000;
export const WINPE_DIAGNOSTIC_RESERVATION_LABEL = "winpe-answer-file-diagnostic";
export const WINPE_DIAGNOSTIC_JOB_CEILING_MILLISECONDS = 25 * MINUTE_MILLISECONDS;
export const WINPE_DIAGNOSTIC_RETENTION_RESERVE_MILLISECONDS = 3 * MINUTE_MILLISECONDS;
export const WINPE_DIAGNOSTIC_CLEANUP_MILLISECONDS = 5 * MINUTE_MILLISECONDS;
export const WINPE_DIAGNOSTIC_COLLECTION_RESERVE_MILLISECONDS = MINUTE_MILLISECONDS;
export const WINPE_DIAGNOSTIC_GUEST_ALLOWANCE_MILLISECONDS = 6 * MINUTE_MILLISECONDS;
export const WINPE_DIAGNOSTIC_KILL_GRACE_MILLISECONDS = 30_000;
export const WINPE_DIAGNOSTIC_MINIMUM_SEQUENCE_MILLISECONDS =
    WINPE_DIAGNOSTIC_GUEST_ALLOWANCE_MILLISECONDS + WINPE_DIAGNOSTIC_CLEANUP_MILLISECONDS +
    WINPE_DIAGNOSTIC_COLLECTION_RESERVE_MILLISECONDS;
export const WINPE_DIAGNOSTIC_MINIMUM_SEQUENCE_SECONDS = WINPE_DIAGNOSTIC_MINIMUM_SEQUENCE_MILLISECONDS / 1_000;
const WINPE_DIAGNOSTIC_MAX_JOB_METADATA_ENTRIES = 256;

export function anchorWinpeDiagnosticJobBudget(value, unixMilliseconds) {
    requireKeys(value, ["jobName", "jobs", "runAttempt", "runId", "runnerName", "totalCount"],
        "WinPE diagnostic job anchor request");
    const name = text => typeof text === "string" && text.length > 0 && text.length <= 255;
    if (!name(value.jobName) || !name(value.runnerName) ||
        !name(value.runId) || !/^(?:0|[1-9][0-9]*)$/u.test(value.runId) ||
        !name(value.runAttempt) || !/^(?:0|[1-9][0-9]*)$/u.test(value.runAttempt))
        throw new TypeError("WinPE diagnostic job anchor request is invalid");
    if (!Array.isArray(value.jobs) || value.jobs.length > WINPE_DIAGNOSTIC_MAX_JOB_METADATA_ENTRIES ||
        value.jobs.some(job => !job || typeof job !== "object" || Array.isArray(job)))
        throw new TypeError("WinPE diagnostic job metadata is invalid");
    if (!Number.isSafeInteger(value.totalCount) || value.totalCount !== value.jobs.length)
        throw new TypeError("WinPE diagnostic job metadata is incomplete");
    const matches = value.jobs.filter(job => job.name === value.jobName &&
        String(job.run_id) === value.runId && String(job.run_attempt) === value.runAttempt &&
        job.runner_name === value.runnerName && job.status === "in_progress");
    if (matches.length !== 1)
        throw new Error(`WinPE diagnostic job anchor is ambiguous or absent: ${matches.length} matching jobs`);
    const startedAt = typeof matches[0].started_at === "string" ? Date.parse(matches[0].started_at) : Number.NaN;
    if (!Number.isSafeInteger(startedAt) || startedAt < 1)
        throw new TypeError("WinPE diagnostic job start is invalid");
    if (typeof unixMilliseconds !== "function") throw new TypeError("WinPE diagnostic budget clock is invalid");
    const now = unixMilliseconds();
    if (!Number.isSafeInteger(now) || now < 1) throw new TypeError("WinPE diagnostic budget clock is invalid");
    if (startedAt > now || now - startedAt > WINPE_DIAGNOSTIC_JOB_CEILING_MILLISECONDS)
        throw new TypeError("WinPE diagnostic job start is invalid");
    const hardStopUnixMilliseconds = startedAt + WINPE_DIAGNOSTIC_JOB_CEILING_MILLISECONDS -
        WINPE_DIAGNOSTIC_RETENTION_RESERVE_MILLISECONDS;
    const wallDeadlineUnixMilliseconds = hardStopUnixMilliseconds - WINPE_DIAGNOSTIC_KILL_GRACE_MILLISECONDS;
    return Object.freeze({startedAtUnixMilliseconds: startedAt, hardStopUnixMilliseconds,
        wallDeadlineUnixMilliseconds, remainingMilliseconds: wallDeadlineUnixMilliseconds - now});
}

/*
 * The wall deadline converted, once, into the monotonic accounting everything after it uses. The
 * preparation and download this job has already paid for are inside it by construction: the anchor
 * is the job's start, not this call.
 */
export function admitWinpeDiagnosticReservation(budget, unixMilliseconds, monotonicMilliseconds) {
    requireKeys(budget, ["label", "wallDeadlineUnixMilliseconds"], "WinPE diagnostic budget");
    if (budget.label !== WINPE_DIAGNOSTIC_RESERVATION_LABEL ||
        !Number.isSafeInteger(budget.wallDeadlineUnixMilliseconds) || budget.wallDeadlineUnixMilliseconds < 1)
        throw new TypeError("WinPE diagnostic budget is invalid");
    if (typeof unixMilliseconds !== "function" || typeof monotonicMilliseconds !== "function")
        throw new TypeError("WinPE diagnostic budget clock is invalid");
    const now = unixMilliseconds();
    if (!Number.isSafeInteger(now) || now < 1) throw new TypeError("WinPE diagnostic budget clock is invalid");
    const spendable = budget.wallDeadlineUnixMilliseconds - now -
        WINPE_DIAGNOSTIC_CLEANUP_MILLISECONDS - WINPE_DIAGNOSTIC_COLLECTION_RESERVE_MILLISECONDS;
    if (spendable < WINPE_DIAGNOSTIC_GUEST_ALLOWANCE_MILLISECONDS)
        throw new Error(`WinPE diagnostic guest allowance of ` +
            `${WINPE_DIAGNOSTIC_GUEST_ALLOWANCE_MILLISECONDS}ms does not fit in the ${spendable}ms left`);
    const monotonic = monotonicMilliseconds();
    if (!Number.isFinite(monotonic)) throw new TypeError("WinPE diagnostic budget clock is invalid");
    return Object.freeze({
        reservation: Object.freeze({label: WINPE_DIAGNOSTIC_RESERVATION_LABEL,
            executionMilliseconds: WINPE_DIAGNOSTIC_GUEST_ALLOWANCE_MILLISECONDS,
            cleanupMilliseconds: WINPE_DIAGNOSTIC_CLEANUP_MILLISECONDS}),
        collectionDeadlineMilliseconds: monotonic + WINPE_DIAGNOSTIC_GUEST_ALLOWANCE_MILLISECONDS +
            WINPE_DIAGNOSTIC_CLEANUP_MILLISECONDS + WINPE_DIAGNOSTIC_COLLECTION_RESERVE_MILLISECONDS
    });
}

/*
 * The remaining-time gate every collection command passes through. It is checked before each phase,
 * not once at the top, and a clock that has gone backwards is refused rather than clamped.
 */
export function createWinpeDiagnosticCollectionBudget(collectionDeadlineMilliseconds, monotonicMilliseconds) {
    if (!Number.isFinite(collectionDeadlineMilliseconds) || typeof monotonicMilliseconds !== "function")
        throw new TypeError("WinPE diagnostic collection budget is invalid");
    let observed = monotonicMilliseconds();
    if (!Number.isFinite(observed)) throw new TypeError("WinPE diagnostic collection clock is invalid");
    return Object.freeze({
        remaining() {
            const now = monotonicMilliseconds();
            if (!Number.isFinite(now) || now < observed)
                throw new Error("WinPE diagnostic collection clock is not monotonic");
            observed = now;
            return collectionDeadlineMilliseconds - now;
        },
        admit(requested) {
            const remaining = this.remaining();
            if (remaining < 1) throw new Error("WinPE diagnostic collection budget is exhausted");
            return Math.min(requested, remaining);
        }
    });
}

export function defaultValidateOutputDisk(target, expectedIdentity = null, fileSystem = fs, expectedOwner = null) {
    if (typeof target !== "string" || target.length === 0) {
        throw new TypeError("target must be a non-empty string");
    }
    const lstat = fileSystem.lstatSync(target, {bigint: true});
    if (typeof lstat.isSymbolicLink === "function" && lstat.isSymbolicLink()) {
        throw new Error("output disk must not be a symlink");
    }
    if (typeof lstat.isFile === "function" && !lstat.isFile()) {
        throw new Error("output disk must be an ordinary file");
    }
    if (lstat.nlink !== 1n && lstat.nlink !== 1) {
        throw new Error("output disk must be a single-link file");
    }
    const oReadOnly = fileSystem.constants?.O_RDONLY ?? fs.constants.O_RDONLY;
    const oNoFollow = fileSystem.constants?.O_NOFOLLOW ?? fs.constants.O_NOFOLLOW;
    const flags = oReadOnly | oNoFollow;
    const descriptor = fileSystem.openSync(target, flags);
    let fstat;
    try {
        fstat = fileSystem.fstatSync(descriptor, {bigint: true});
    } finally {
        fileSystem.closeSync(descriptor);
    }
    if (typeof fstat.isFile === "function" && !fstat.isFile()) {
        throw new Error("output disk descriptor must be a regular file");
    }
    if (fstat.nlink !== 1n && fstat.nlink !== 1) {
        throw new Error("output disk descriptor must be a single-link file");
    }
    if (fstat.size !== OUTPUT_DISK_BYTES && fstat.size !== Number(OUTPUT_DISK_BYTES)) {
        throw new Error("output disk size must match expected raw FAT size (stat mismatch)");
    }
    if (fstat.dev !== lstat.dev || fstat.ino !== lstat.ino || fstat.uid !== lstat.uid || fstat.gid !== lstat.gid) {
        throw new Error("output disk lexical and descriptor stat mismatch");
    }

    // Retain and compare all permission bits
    const lstatMode = (lstat.mode !== undefined && lstat.mode !== null) ? (BigInt(lstat.mode) & 0o7777n) : null;
    const fstatMode = (fstat.mode !== undefined && fstat.mode !== null) ? (BigInt(fstat.mode) & 0o7777n) : null;
    if (lstatMode === null || fstatMode === null) {
        throw new Error("output disk mode is missing");
    }
    if (lstatMode !== fstatMode) {
        throw new Error("output disk lexical and descriptor mode mismatch");
    }
    if ((fstatMode & 0o022n) !== 0n) {
        throw new Error("output disk permissions are unsafe (group/world-writable)");
    }
    if ((fstatMode & 0o200n) === 0n) {
        throw new Error("output disk permissions must retain owner writability");
    }

    // Reject unknown owner identity rather than skipping ownership checks
    const resolvedOwner = expectedOwner ?? (typeof process.getuid === "function" ?
        {uid: BigInt(process.getuid()), gid: typeof process.getgid === "function" ? BigInt(process.getgid()) : null} : null);
    if (resolvedOwner === null || resolvedOwner.uid === undefined || resolvedOwner.uid === null) {
        throw new Error("output disk owner identity is unknown");
    }
    if (BigInt(fstat.uid) !== BigInt(resolvedOwner.uid)) {
        throw new Error("output disk owner UID does not match expected task owner");
    }
    if (resolvedOwner.gid !== undefined && resolvedOwner.gid !== null && BigInt(fstat.gid) !== BigInt(resolvedOwner.gid)) {
        throw new Error("output disk owner GID does not match expected task owner");
    }

    const modeOctal = (fstatMode & 0o7777n).toString(8);
    if (expectedIdentity !== null && expectedIdentity !== undefined) {
        if (fstat.dev !== expectedIdentity.dev || fstat.ino !== expectedIdentity.ino ||
            BigInt(fstat.uid) !== BigInt(expectedIdentity.uid) || BigInt(fstat.gid) !== BigInt(expectedIdentity.gid) ||
            BigInt(fstat.size) !== BigInt(expectedIdentity.size)) {
            throw new Error("output disk identity does not match pre-launch identity");
        }
        const expectedMode = typeof expectedIdentity.mode === "bigint" ?
            (expectedIdentity.mode & 0o7777n).toString(8) : String(expectedIdentity.mode);
        if (modeOctal !== expectedMode) {
            throw new Error("output disk mode changed post-launch");
        }
    }
    return {dev: fstat.dev, ino: fstat.ino, uid: fstat.uid, gid: fstat.gid, size: fstat.size, mode: modeOctal};
}

function defaultWriteExclusive(target, bytes) {
    fs.writeFileSync(target, bytes, {flag: "wx", mode: 0o600});
}

function defaultMkdirExclusive(target) {
    fs.mkdirSync(target, {recursive: false, mode: 0o700});
}

async function defaultDownloadPinned({url, finalUrl = url, path: target, bytes: expectedBytes, sha256: expectedHash,
    expectedEtag}) {
    if (expectedHash == null && (finalUrl === url || typeof expectedEtag !== "string"))
        throw new Error("an unpinned download requires exact redirect and ETag identity");
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MILLISECONDS);
    let response;
    try { response = await fetch(url, {redirect: finalUrl === url ? "error" : "follow", signal: controller.signal}); }
    catch (error) { clearTimeout(deadline); throw error; }
    if (!response.ok || response.url !== finalUrl || response.headers.get("content-length") !== expectedBytes ||
        (expectedEtag !== undefined && response.headers.get("etag") !== expectedEtag) || !response.body) {
        clearTimeout(deadline);
        throw new Error("download response identity is invalid");
    }
    let handle;
    try { handle = fs.openSync(target, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY |
        fs.constants.O_NOFOLLOW, 0o600); }
    catch (error) { clearTimeout(deadline); throw error; }
    const digest = crypto.createHash("sha256");
    let count = 0n;
    try {
        for await (const chunk of response.body) {
            const value = Buffer.from(chunk); count += BigInt(value.length);
            if (count > BigInt(expectedBytes)) throw new Error("download exceeded its bound");
            digest.update(value);
            let written = 0;
            while (written < value.length) {
                const countWritten = fs.writeSync(handle, value, written, value.length - written);
                if (countWritten <= 0) throw new Error("download write was truncated");
                written += countWritten;
            }
        }
        fs.fsyncSync(handle);
    } finally { clearTimeout(deadline); fs.closeSync(handle); }
    const observed = digest.digest("hex");
    if (count.toString() !== expectedBytes || expectedHash !== null && expectedHash !== undefined &&
        observed !== expectedHash) throw new Error("download digest is invalid");
    return {path: target, bytes: expectedBytes, sha256: observed, ...(finalUrl !== url || expectedEtag !== undefined ?
        {finalUrl: response.url, etag: response.headers.get("etag")} : {})};
}

function defaultInventoryOwnedTree(root, selector = () => true) {
    const entries = [];
    let visited = 0;
    const visit = (directory, relativeRoot = "") => {
        for (const name of fs.readdirSync(directory, {encoding: "utf8"}).sort()) {
            if (/[/\\\x00-\x1f\x7f]/u.test(name)) throw new Error("portable tree entry name is invalid");
            const relative = relativeRoot ? `${relativeRoot}/${name}` : name;
            const target = `${directory}/${name}`;
            const stat = fs.lstatSync(target, {bigint: true});
            visited += 1;
            if (visited > MAX_TREE_ENTRIES) throw new Error("portable tree manifest entry bound exceeded");
            let record;
            if (stat.isDirectory()) {
                record = {path: relative, type: "directory", mode: Number(stat.mode & 0o777n).toString(8),
                    uid: stat.uid.toString(), gid: stat.gid.toString()};
            } else if (stat.isFile()) {
                const identity = defaultInspectOwned(target);
                record = {path: relative, type: "file", bytes: identity.bytes, sha256: identity.sha256,
                    mode: identity.ownership.mode, uid: identity.ownership.uid, gid: identity.ownership.gid};
            } else if (stat.isSymbolicLink()) {
                const linkTarget = fs.readlinkSync(target, {encoding: "utf8"});
                if (!linkTarget || /[\x00-\x1f\x7f]/u.test(linkTarget))
                    throw new Error("portable tree link target is invalid");
                record = {path: relative, type: "symlink", target: linkTarget,
                    uid: stat.uid.toString(), gid: stat.gid.toString()};
            } else throw new Error("portable tree contains a special file");
            if (selector(relative, record.type)) entries.push(record);
            if (stat.isDirectory()) visit(target, relative);
        }
    };
    visit(root);
    const bytes = Buffer.from(`${JSON.stringify(entries)}\n`, "utf8");
    if (bytes.length > MAX_TREE_MANIFEST_BYTES) throw new Error("portable tree manifest byte bound exceeded");
    return {bytes: String(bytes.length), sha256: sha256(bytes)};
}

function defaultInspectOwned(target) {
    const canonical = fs.realpathSync(target);
    const descriptor = fs.openSync(canonical, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const digest = crypto.createHash("sha256");
    let stat;
    try {
        stat = fs.fstatSync(descriptor);
        if (!stat.isFile()) throw new Error("owned path is not an ordinary file");
        const buffer = Buffer.allocUnsafe(1_048_576);
        let offset = 0;
        while (offset < stat.size) {
            const count = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
            if (count <= 0) throw new Error("owned file read was truncated");
            digest.update(buffer.subarray(0, count)); offset += count;
        }
        const after = fs.fstatSync(descriptor);
        if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
            throw new Error("owned file changed while hashing");
    } finally { fs.closeSync(descriptor); }
    return {path: canonical, bytes: String(stat.size), sha256: digest.digest("hex"),
        ownership: {uid: String(stat.uid), gid: String(stat.gid),
        mode: (stat.mode & 0o777).toString(8), ordinaryUserWritable: (stat.mode & 0o022) !== 0}};
}

function defaultInspectDirectory(target) {
    const lexical = fs.lstatSync(target, {bigint: true});
    const canonical = fs.realpathSync(target);
    const stat = fs.statSync(canonical, {bigint: true});
    if (!lexical.isDirectory() || !stat.isDirectory() || lexical.dev !== stat.dev || lexical.ino !== stat.ino)
        throw new Error("owned directory identity is invalid");
    return {path: canonical, dev: stat.dev.toString(), ino: stat.ino.toString(), uid: stat.uid.toString(),
        gid: stat.gid.toString(), mode: Number(stat.mode & 0o7777n).toString(8),
        ordinaryUserWritable: (stat.mode & 0o022n) !== 0n, sticky: (stat.mode & 0o1000n) !== 0n};
}

function defaultReadOwnedVerified(target, maximumBytes, options = {}) {
    const canonical = fs.realpathSync(target);
    const descriptor = fs.openSync(canonical, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const before = fs.fstatSync(descriptor);
        if (!before.isFile() || (!options.allowEmpty && before.size < 1) || before.size > maximumBytes)
            throw new Error("owned file read bound is invalid");
        const bytes = Buffer.allocUnsafe(before.size);
        let offset = 0;
        while (offset < bytes.length) {
            const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
            if (count <= 0) throw new Error("owned file read was truncated");
            offset += count;
        }
        const after = fs.fstatSync(descriptor);
        if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
            after.mtimeMs !== before.mtimeMs) throw new Error("owned file changed while reading");
        return {bytes, identity: {path: canonical, bytes: String(before.size), sha256: sha256(bytes)}};
    } finally { fs.closeSync(descriptor); }
}

/*
 * This is deliberately separate from defaultReadOwnedVerified: its only consumer is the failure
 * diagnostic, where retaining a fixed prefix is preferable to losing all evidence. Other callers
 * continue to require a complete, bounded file. The path is checked before opening and the same
 * descriptor is checked afterwards, so an unsafe replacement cannot become diagnostic evidence.
 */
export function defaultReadOwnedPrefixVerified(target, maximumBytes, options = {}) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
        throw new TypeError("owned prefix maximum is invalid");
    const lexical = fs.lstatSync(target);
    if (!lexical.isFile()) throw new Error("owned prefix path is not an ordinary file");
    const canonical = fs.realpathSync(target);
    const resolved = fs.lstatSync(canonical);
    if (!resolved.isFile() || lexical.dev !== resolved.dev || lexical.ino !== resolved.ino)
        throw new Error("owned prefix path identity is invalid");
    const descriptor = fs.openSync(canonical, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const before = fs.fstatSync(descriptor);
        if (!before.isFile() || before.nlink !== 1 || (!options.allowEmpty && before.size < 1))
            throw new Error("owned prefix read bound is invalid");
        if (before.dev !== lexical.dev || before.ino !== lexical.ino || before.uid !== lexical.uid ||
            before.gid !== lexical.gid || before.mode !== lexical.mode)
            throw new Error("owned prefix descriptor identity is invalid");
        const capturedBytes = Math.min(before.size, maximumBytes);
        const bytes = Buffer.allocUnsafe(capturedBytes);
        let offset = 0;
        while (offset < bytes.length) {
            const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
            if (count <= 0) throw new Error("owned prefix read was truncated");
            offset += count;
        }
        const after = fs.fstatSync(descriptor);
        if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
            after.mtimeMs !== before.mtimeMs || after.uid !== before.uid || after.gid !== before.gid ||
            after.mode !== before.mode || after.nlink !== before.nlink)
            throw new Error("owned prefix changed while reading");
        return {bytes, identity: {path: canonical, bytes: String(capturedBytes), sha256: sha256(bytes),
            observedBytes: String(before.size), truncated: before.size > maximumBytes}};
    } finally { fs.closeSync(descriptor); }
}

function parsePidBytes(bytes) {
    const text = new TextDecoder("utf-8", {fatal: true}).decode(bytes);
    if (!/^[1-9][0-9]{0,9}\n?$/u.test(text)) throw new Error("QEMU pidfile is invalid");
    const pid = Number(text.trim());
    if (!Number.isInteger(pid) || pid > 0x7fff_ffff) throw new Error("QEMU pidfile is invalid");
    return pid;
}

function defaultReadProcessIdentity(processId) {
    try {
        const stat = fs.readFileSync(`/proc/${processId}/stat`, "utf8");
        const close = stat.lastIndexOf(")");
        if (close < 1) throw new Error("QEMU process stat is invalid");
        const fields = stat.slice(close + 2).trim().split(/\s+/u);
        const processGroupId = Number(fields[2]);
        const startTicks = fields[19];
        if (!/^[1-9][0-9]*$/u.test(startTicks) || !Number.isInteger(processGroupId) || processGroupId < 1 ||
            processGroupId > 0x7fff_ffff) throw new Error("QEMU process stat is invalid");
        let executablePath = null;
        try { executablePath = fs.realpathSync(`/proc/${processId}/exe`); }
        catch (error) { if (error?.code !== "EACCES" && error?.code !== "EPERM") throw error; }
        return {state: "present", pid: processId, processGroupId, startTicks, executablePath};
    } catch (error) {
        if (error?.code === "ENOENT") return {state: "absent"};
        throw error;
    }
}

async function defaultReadQemuProcessIdentity(io, processId) {
    const before = io.readProcessIdentity(processId);
    if (before.state === "absent" || before.executablePath !== null) return before;
    const tool = io.inspectOwned(READLINK);
    if (tool.path !== READLINK || tool.ownership.uid !== "0" || tool.ownership.ordinaryUserWritable !== false)
        throw new Error("readlink observer identity is unsafe");
    const command = boundedSudo([READLINK, "-e", "--", `/proc/${processId}/exe`]);
    const observation = assertSuccessful(await io.runOwned(command.command, command.argv,
        {timeoutMs: COMMAND_TIMEOUT_MILLISECONDS, maxStreamBytes: MAX_STREAM_BYTES}), "QEMU executable observation");
    if (observation.stderr.length !== 0) throw new Error("QEMU executable observer stderr is not empty");
    const text = new TextDecoder("utf-8", {fatal: true}).decode(observation.stdout);
    if (!/^\/[^\x00-\x1f\x7f]{1,511}\n$/u.test(text)) throw new Error("QEMU executable observation is invalid");
    const after = io.readProcessIdentity(processId);
    if (after.state !== "present" || after.startTicks !== before.startTicks ||
        after.processGroupId !== before.processGroupId) throw new Error("QEMU identity changed during observation");
    return {...after, executablePath: text.slice(0, -1)};
}

function defaultIsProcessGroupAlive(processGroupId) {
    try { process.kill(-processGroupId, 0); return true; }
    catch (error) {
        if (error?.code === "ESRCH") return false;
        if (error?.code === "EPERM") return true;
        throw error;
    }
}

export function measureOwnedTreeBytes(roots, fileSystem = fs) {
    let count = 0, total = 0n;
    const visit = target => {
        const stat = fileSystem.lstatSync(target, {bigint: true});
        count += 1;
        if (count > MAX_TREE_ENTRIES) throw new Error("runtime tree entry bound exceeded");
        if (stat.isSymbolicLink()) { total += stat.size; return; }
        if (stat.isFile()) { total += stat.size; return; }
        if (!stat.isDirectory()) throw new Error("runtime tree contains a special file");
        for (const name of fileSystem.readdirSync(target, {encoding: "utf8"})) {
            if (/[/\\\x00-\x1f\x7f]/u.test(name)) throw new Error("runtime tree entry name is invalid");
            visit(`${target}/${name}`);
        }
    };
    for (const root of roots) visit(root);
    return total;
}

export async function observeHostedRuntimeResources(io, request) {
    const memory = io.readResources(request.taskPath).memory;
    if (!memory || !/^[1-9][0-9]*$/u.test(memory.effectiveAvailableBytes))
        throw new Error("runtime memory observation is invalid");
    const stat = assertSuccessful(await io.runOwned(STAT,
        ["--file-system", "--printf=%a\\n%S\\n", "--", request.taskPath],
        {timeoutMs: COMMAND_TIMEOUT_MILLISECONDS, maxStreamBytes: MAX_STREAM_BYTES}), "runtime statvfs observation");
    const lines = new TextDecoder("utf-8", {fatal: true}).decode(stat.stdout).split("\n").filter(Boolean);
    if (lines.length !== 2 || !lines.every(value => /^[1-9][0-9]*$/u.test(value)))
        throw new Error("runtime statvfs observation is invalid");
    return {taskBytes: io.treeBytes(request.roots).toString(),
        freeBytes: (BigInt(lines[0]) * BigInt(lines[1])).toString(),
        effectiveMemoryBytes: memory.effectiveAvailableBytes};
}

async function defaultTerminateQemuGroup(io, request) {
    if (!Number.isInteger(request.processGroupId) || request.processGroupId < 1 || request.processGroupId > 0x7fff_ffff)
        return false;
    const command = boundedSudo([KILL, "-KILL", "--", `-${request.processGroupId}`]);
    const observation = await io.runOwned(command.command, command.argv,
        {timeoutMs: COMMAND_TIMEOUT_MILLISECONDS, maxStreamBytes: MAX_STREAM_BYTES});
    if (observation.process.exitCode !== 0 || observation.process.signal !== null || observation.process.timedOut ||
        !observation.process.cleanupProven || observation.process.stdoutOverflow || observation.process.stderrOverflow ||
        observation.process.errorObserved || observation.stdout.length !== 0 || observation.stderr.length !== 0) return false;
    const deadline = io.monotonicMilliseconds() + QEMU_CLEANUP_TIMEOUT_MILLISECONDS;
    while (io.monotonicMilliseconds() <= deadline) {
        if (!io.isProcessGroupAlive(request.processGroupId)) {
            if (request.identity === null) return true;
            const after = await io.readQemuProcessIdentity(request.identity.pid);
            return after.state === "absent";
        }
        await io.wait(QEMU_IDENTITY_POLL_MILLISECONDS);
    }
    return false;
}

function waitMilliseconds(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function defaultCreateOwnedPidFile(target) {
    const descriptor = fs.openSync(target, fs.constants.O_CREAT | fs.constants.O_EXCL |
        fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    try {
        fs.fsyncSync(descriptor);
        const stat = fs.fstatSync(descriptor, {bigint: true});
        if (!stat.isFile() || stat.nlink !== 1n || stat.size !== 0n || (stat.mode & 0o777n) !== 0o600n)
            throw new Error("QEMU pidfile precreation identity is invalid");
        const canonical = fs.realpathSync(target);
        if (canonical !== target || fs.realpathSync(`/proc/self/fd/${descriptor}`) !== target)
            throw new Error("QEMU pidfile precreation path differs");
        return {path: target, dev: stat.dev.toString(), ino: stat.ino.toString(), uid: stat.uid.toString(),
            gid: stat.gid.toString(), mode: "600"};
    } finally { fs.closeSync(descriptor); }
}

function defaultReadOwnedPidFile(target, maximumBytes, expected) {
    const canonical = fs.realpathSync(target);
    if (canonical !== target) throw new Error("QEMU pidfile path differs");
    const descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const before = fs.fstatSync(descriptor, {bigint: true});
        if (!before.isFile() || before.nlink !== 1n || before.dev.toString() !== expected.dev
            || before.ino.toString() !== expected.ino || before.uid.toString() !== expected.uid
            || before.gid.toString() !== expected.gid || (before.mode & 0o777n) !== 0o600n
            || before.size > BigInt(maximumBytes)) throw new Error("QEMU pidfile identity changed");
        const bytes = Buffer.alloc(Number(before.size));
        let offset = 0;
        while (offset < bytes.length) {
            const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
            if (count < 1) throw new Error("QEMU pidfile read was truncated");
            offset += count;
        }
        const after = fs.fstatSync(descriptor, {bigint: true});
        if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
            || after.mtimeNs !== before.mtimeNs) return null;
        return {bytes};
    } finally { fs.closeSync(descriptor); }
}

function defaultRemoveOwnedPidFile(target, expected) {
    const lexical = fs.lstatSync(target, {bigint: true});
    if (!lexical.isFile() || lexical.isSymbolicLink() || lexical.nlink !== 1n
        || lexical.dev.toString() !== expected.dev || lexical.ino.toString() !== expected.ino)
        throw new Error("QEMU pidfile cleanup identity changed");
    fs.unlinkSync(target);
}

function diagnosticIdentity(value) {
    if (value?.state === "absent") return {state: "absent"};
    if (value?.state !== "present") return null;
    const integer = candidate => Number.isInteger(candidate) && candidate > 0 && candidate <= 0x7fff_ffff ?
        candidate : null;
    const text = (candidate, pattern) => typeof candidate === "string" && pattern.test(candidate) ? candidate : null;
    return {state: "present", pid: integer(value.pid), processGroupId: integer(value.processGroupId),
        startTicks: text(value.startTicks, /^[1-9][0-9]{0,23}$/u),
        executablePath: text(value.executablePath, /^\/[\x20-\x7e]{1,511}$/u)};
}

function boundedMonitorFailure(phase, error, identity) {
    const message = (error instanceof Error ? error.message : String(error)).replace(/[\x00-\x1f\x7f]+/gu, " ")
        .slice(0, MAX_MONITOR_FAILURE_MESSAGE_CHARACTERS);
    return {phase, message: message || "unspecified monitor failure", identity};
}

export function cpuFloorCleanupAuthorityPath(pidPath) {
    if (typeof pidPath !== "string" || !path.posix.isAbsolute(pidPath) ||
        path.posix.normalize(pidPath) !== pidPath) throw new TypeError("QEMU pid path is invalid");
    return path.posix.join(path.posix.dirname(pidPath), CLEANUP_AUTHORITY_FILENAME);
}

function defaultWriteCleanupAuthority(pidPath, identity) {
    const receipt = {schemaVersion: 1, kind: CLEANUP_AUTHORITY_KIND, authorities: [structuredClone(identity)]};
    fs.writeFileSync(cpuFloorCleanupAuthorityPath(pidPath), `${JSON.stringify(receipt)}\n`, {flag: "wx", mode: 0o600});
}

export async function runMonitoredQemu(io, request) {
    const pidfile = request.precreatePidFile === true ? io.createOwnedPidFile(request.pidPath) : null;
    let finished = false;
    let outerProcessGroupId = null;
    let requestOwnedSettlement = null;
    let qmpSession = null;
    let qmpObservation = null;
    let qmpSessionHandle = null;
    let lateBootObservation = null;
    let lateBootSettled = false;
    let predeadlineObservation = null;
    let qmpState = request.qmp ? "missing" : "unused";
    let monitorFailure = null;
    const cancelQmp = () => {
        try { qmpSessionHandle?.cancel?.(); } catch { /* ignore */ }
    };
    const identityAttempt = {pid: null, expected: {processGroupId: null,
        executablePath: request.expectedExecutable}, observed: null};
    const terminationReasons = [];
    const operation = io.runOwned(request.command, request.argv,
        {timeoutMs: request.timeoutMs, maxStreamBytes: request.maxStreamBytes,
            onSpawn: pid => { outerProcessGroupId = pid; },
            onTerminationRequested: reason => {
                cancelQmp();
                terminationReasons.push(reason);
                return true;
            },
            onTerminationReady: requestTermination => { requestOwnedSettlement = requestTermination; },
            ...(request.qmp ? {
                qmp: request.qmp,
                qmpDependencies: request.qmpDependencies,
                onQmpSessionHandle: handle => {
                    qmpSessionHandle = handle;
                    request.onQmpSessionHandle?.(handle);
                },
                onLateObservation: promise => {
                    request.onLateObservation?.(promise);
                    promise.then(
                        observation => {
                            lateBootSettled = true;
                            lateBootObservation = observation;
                        },
                        () => {
                            lateBootSettled = true;
                            lateBootObservation = null;
                        }
                    ).catch(() => undefined);
                },
                onPredeadlineObservation: observation => {
                    predeadlineObservation = observation;
                    request.onPredeadlineObservation?.(observation);
                },
                onQmpSession: value => {
                    qmpSession = value;
                    qmpState = "pending";
                    value.then(observation => { qmpObservation = observation; qmpState = "complete"; },
                        () => { qmpState = "failed"; });
                }
            } : {})})
        .finally(() => {
            cancelQmp();
            finished = true;
        });
    const identityDeadline = io.monotonicMilliseconds() + QEMU_IDENTITY_TIMEOUT_MILLISECONDS;
    let identity = null;
    let monitorFailed = false;
    try {
        while (!finished && io.monotonicMilliseconds() <= identityDeadline) {
            if (io.pathExists(request.pidPath)) {
                const observedPid = pidfile === null ? io.readOwnedVerified(request.pidPath, 32, {allowEmpty: true})
                    : io.readOwnedPidFile(request.pidPath, 32, pidfile);
                if (observedPid === null) { await io.wait(QEMU_IDENTITY_POLL_MILLISECONDS); continue; }
                const pidBytes = observedPid.bytes;
                if (pidBytes.length === 0) {
                    await io.wait(QEMU_IDENTITY_POLL_MILLISECONDS);
                    continue;
                }
                const pid = parsePidBytes(pidBytes);
                identityAttempt.pid = pid;
                identityAttempt.expected.processGroupId = outerProcessGroupId;
                const observed = await io.readQemuProcessIdentity(pid);
                identityAttempt.observed = diagnosticIdentity(observed);
                if (observed.state !== "present" || observed.executablePath !== request.expectedExecutable ||
                    typeof observed.startTicks !== "string" || !/^[1-9][0-9]{0,23}$/u.test(observed.startTicks) ||
                    observed.processGroupId !== outerProcessGroupId)
                    throw new Error("QEMU live process identity differs");
                identity = {pid, processGroupId: observed.processGroupId, startTicks: observed.startTicks,
                    executablePath: observed.executablePath};
                if (io.writeCleanupAuthority) {
                    const leader = await io.readQemuProcessIdentity(outerProcessGroupId);
                    if (leader.state !== "present" || leader.pid !== outerProcessGroupId ||
                        leader.processGroupId !== outerProcessGroupId ||
                        typeof leader.startTicks !== "string" || !/^[1-9][0-9]{0,23}$/u.test(leader.startTicks) ||
                        typeof leader.executablePath !== "string" || leader.executablePath.length < 1)
                        throw new Error("QEMU process group leader identity differs");
                    io.writeCleanupAuthority(request.pidPath, {pid: outerProcessGroupId,
                        processGroupId: outerProcessGroupId, startTicks: leader.startTicks,
                        executablePath: leader.executablePath});
                }
                break;
            }
            await io.wait(QEMU_IDENTITY_POLL_MILLISECONDS);
        }
        if (!finished && identity === null) terminationReasons.push("identity-timeout");
    } catch (error) {
        monitorFailed = true;
        monitorFailure = boundedMonitorFailure("identity-observation", error, identityAttempt);
        terminationReasons.push("identity-observation-failed");
    }
    let lowMemorySince = null;
    while (!finished && terminationReasons.length === 0) {
        if (request.qmp && (qmpState === "missing" || qmpState === "failed")) {
            terminationReasons.push("qmp-failed");
            break;
        }
        try {
            const sample = await io.observeRuntimeResources(request.resources);
            const now = io.monotonicMilliseconds();
            if (BigInt(sample.taskBytes) > MAXIMUM_TASK_BYTES) terminationReasons.push("task-bytes");
            if (BigInt(sample.freeBytes) < MINIMUM_FREE_DISK_BYTES) terminationReasons.push("free-disk");
            if (BigInt(sample.effectiveMemoryBytes) < MINIMUM_RUNTIME_MEMORY_BYTES) {
                lowMemorySince ??= now;
                if (now - lowMemorySince >= LOW_MEMORY_ABORT_MILLISECONDS) terminationReasons.push("low-memory");
            } else lowMemorySince = null;
            if (now >= request.executionDeadline) terminationReasons.push("deadline");
        } catch { terminationReasons.push("telemetry-failed"); }
        if (!finished && terminationReasons.length === 0) await io.wait(RESOURCE_POLL_MILLISECONDS);
    }
    if (request.qmp && qmpState === "pending" && finished) {
        try { qmpObservation = await qmpSession; qmpState = "complete"; }
        catch { qmpState = "failed"; terminationReasons.push("qmp-failed"); }
    }
    let teardownProven = true;
    if (terminationReasons.length > 0) {
        cancelQmp();
        if (outerProcessGroupId !== null) {
        let terminationRequired = true;
        try { terminationRequired = io.isProcessGroupAlive(outerProcessGroupId); }
        catch {
            monitorFailed = true;
            terminationReasons.push("group-observation-failed");
        }
        if (terminationRequired) {
            try { teardownProven = await io.terminateQemuGroup({processGroupId: outerProcessGroupId, identity,
                reason: terminationReasons[0]}); }
            catch { teardownProven = false; }
        }
    }
    }
    if (terminationReasons.length > 0) {
        if (typeof requestOwnedSettlement !== "function") teardownProven = false;
        else requestOwnedSettlement(`monitor-${terminationReasons[0]}`);
    }
    let observation = await operation;
    if (teardownProven && outerProcessGroupId !== null) {
        try {
            if (!io.isProcessGroupAlive(outerProcessGroupId))
                observation = {...observation, process: {...observation.process, cleanupProven: true}};
        } catch {
            monitorFailed = true;
            terminationReasons.push("group-observation-failed");
        }
    }
    const finalLateBoot = (lateBootSettled && lateBootObservation) ? lateBootObservation : null;
    const finish = value => {
        const enriched = {...value, predeadline: predeadlineObservation};
        if (pidfile && io.pathExists(request.pidPath)) {
            if (enriched.absentAfter !== true || enriched.processGroupGone !== true)
                return {...enriched, terminationReason: enriched.terminationReason ?? "pidfile-cleanup-deferred"};
            io.removeOwnedPidFile(request.pidPath, pidfile);
        }
        return enriched;
    };
    if (monitorFailed || identity === null || !teardownProven)
        return finish({observation, identity, qmp: qmpObservation, lateBoot: finalLateBoot, monitorFailure, absentAfter: false, processGroupGone: false,
            terminationReason: terminationReasons[0] ?? null});
    const cleanupDeadline = io.monotonicMilliseconds() + QEMU_CLEANUP_TIMEOUT_MILLISECONDS;
    while (io.monotonicMilliseconds() <= cleanupDeadline) {
        const after = await io.readQemuProcessIdentity(identity.pid);
        if (after.state === "absent") {
            let processGroupGone = false;
            try { processGroupGone = !io.isProcessGroupAlive(identity.processGroupId); }
            catch {
                monitorFailed = true;
                terminationReasons.push("group-observation-failed");
            }
            return finish({observation, identity, qmp: qmpObservation, lateBoot: finalLateBoot, monitorFailure, absentAfter: true,
                processGroupGone, terminationReason: terminationReasons[0] ?? null});
        }
        if (after.startTicks !== identity.startTicks || after.executablePath !== identity.executablePath)
            return finish({observation, identity, qmp: qmpObservation, lateBoot: finalLateBoot, monitorFailure, absentAfter: false,
                processGroupGone: false,
                terminationReason: terminationReasons[0] ?? null});
        await io.wait(QEMU_IDENTITY_POLL_MILLISECONDS);
    }
    return finish({observation, identity, qmp: qmpObservation, lateBoot: finalLateBoot, monitorFailure, absentAfter: false,
        processGroupGone: false, terminationReason: terminationReasons[0] ?? null});
}

/*
 * The vector gives the guest a serial port that writes to a file, and OVMF can put that UART in
 * ConOut, so the file can carry UEFI console text such as the boot option BDS chose or a loader
 * prompt. This records only a bounded prefix, so empty
 * serial text is not proof that no boot prompt appeared. A failure to safely read it stays explicit
 * without replacing the rest of the launch diagnostic or exposing an exception message.
 */
function readSerialConsole(io, target) {
    try {
        const observed = io.readOwnedPrefixVerified(target, QEMU_STREAM_BYTES, {allowEmpty: true});
        return {serialLog: {status: "captured", bytes: observed.identity.bytes, sha256: observed.identity.sha256,
            bytesBase64: observed.bytes.toString("base64"), observedBytes: observed.identity.observedBytes,
            truncated: observed.identity.truncated}};
    } catch { return {serialLog: {status: "unavailable"}}; }
}

/*
 * An advisory note on the sampled frames, and nothing more. The verdict compares the captured frame
 * digests from the last early frame onwards, so an identical sequence says the sampled images were
 * equal - not that no intermediate frame changed, and not that nothing happened after the last
 * milestone, which in run 35016673141 left roughly twenty unobserved minutes. Progress between the
 * two early frames is firmware still painting its first screen and is deliberately outside the
 * comparison. A chain too short to compare stays null rather than borrowing "did not advance".
 * Nothing reads this to abort, accept or gate a run; the serial console above is the evidence.
 */
function displayProgressVerdict(earlyBoot, milestones) {
    const digests = [...(earlyBoot === null ? [] : [earlyBoot.screenshots.at(-1).sha256]),
        ...milestones.map(item => item.screenshot.sha256)];
    if (digests.length < 2) return null;
    return digests.some((digest, index) => index > 0 && digest !== digests[index - 1]);
}

function normalizeDependencies(value) {
    const normalized = {mkdirExclusive: value.mkdirExclusive ?? defaultMkdirExclusive,
        writeExclusive: value.writeExclusive ?? defaultWriteExclusive,
        downloadPinned: value.downloadPinned ?? defaultDownloadPinned,
        runOwned: value.runOwned ?? ((command, argv, options) => runHostedOwnedProcess(command, argv, options)),
        inspectOwned: value.inspectOwned ?? defaultInspectOwned,
        inspectDirectory: value.inspectDirectory ?? defaultInspectDirectory,
        readOwnedVerified: value.readOwnedVerified ?? defaultReadOwnedVerified,
        readOwnedPrefixVerified: value.readOwnedPrefixVerified ?? defaultReadOwnedPrefixVerified,
        createOwnedPidFile: value.createOwnedPidFile ?? defaultCreateOwnedPidFile,
        readOwnedPidFile: value.readOwnedPidFile ?? defaultReadOwnedPidFile,
        removeOwnedPidFile: value.removeOwnedPidFile ?? defaultRemoveOwnedPidFile,
        writeCleanupAuthority: value.writeCleanupAuthority ?? defaultWriteCleanupAuthority,
        readProcessIdentity: value.readProcessIdentity ?? defaultReadProcessIdentity,
        isProcessGroupAlive: value.isProcessGroupAlive ?? defaultIsProcessGroupAlive,
        wait: value.wait ?? waitMilliseconds,
        monotonicMilliseconds: value.monotonicMilliseconds ?? (() => Number(process.hrtime.bigint() / 1_000_000n)),
        pathExists: value.pathExists ?? (target => fs.existsSync(target)),
        assertWritable: value.assertWritable ?? (target => fs.accessSync(target, fs.constants.W_OK)),
        readResources: value.readResources ?? (target => readResourceObservation({workRoot: target})),
        readCgroupLayout: value.readCgroupLayout ?? (() => resolveCgroupLayout({
            cgroup: fs.readFileSync("/proc/self/cgroup", "utf8"),
            mountInfo: fs.readFileSync("/proc/self/mountinfo", "utf8")})),
        readOwned: value.readOwned ?? (target => fs.readFileSync(target)),
        removeOwned: value.removeOwned ?? (target => fs.unlinkSync(target)),
        copyExclusive: value.copyExclusive ?? ((source, target) => fs.copyFileSync(source, target,
            fs.constants.COPYFILE_EXCL)),
        makeSizedFile: value.makeSizedFile ?? ((target, bytes) => {
            const descriptor = fs.openSync(target, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY |
                fs.constants.O_NOFOLLOW, 0o600);
            try { fs.ftruncateSync(descriptor, Number(bytes)); fs.fsyncSync(descriptor); }
            finally { fs.closeSync(descriptor); }
        }),
        inventoryOwnedTree: value.inventoryOwnedTree ?? defaultInventoryOwnedTree,
        treeBytes: value.treeBytes ?? measureOwnedTreeBytes,
        observeRuntimeResources: value.observeRuntimeResources,
        terminateQemuGroup: value.terminateQemuGroup,
        resolveAptClosure: value.resolveAptClosure,
        validateOutputDisk: value.validateOutputDisk ??
            ((target, expected, owner) => defaultValidateOutputDisk(target, expected, fs,
                owner ?? (typeof process.getuid === "function" ? {uid: BigInt(process.getuid()), gid: BigInt(process.getgid())} : null))),
        parseProbeEvidence: value.parseProbeEvidence ?? parseProbeArtifactEvidence};
    normalized.readQemuProcessIdentity = value.readQemuProcessIdentity ??
        (processId => defaultReadQemuProcessIdentity(normalized, processId));
    normalized.observeRuntimeResources = value.observeRuntimeResources ??
        (request => observeHostedRuntimeResources(normalized, request));
    normalized.terminateQemuGroup = value.terminateQemuGroup ??
        (request => defaultTerminateQemuGroup(normalized, request));
    normalized.runMonitoredQemu = value.runMonitoredQemu ?? (request => runMonitoredQemu(normalized, request));
    return normalized;
}

export function createHostedCpuFloorCleanupOperations(dependencies = {}) {
    const io = normalizeDependencies(dependencies);
    return Object.freeze({
        readProcessIdentity: processId => io.readQemuProcessIdentity(processId),
        isProcessGroupAlive: processGroupId => io.isProcessGroupAlive(processGroupId),
        monotonicMilliseconds: () => io.monotonicMilliseconds(),
        wait: milliseconds => io.wait(milliseconds),
        async signalProcessGroup(processGroupId, signal) {
            if (!Number.isInteger(processGroupId) || processGroupId < 1 || processGroupId > 0x7fff_ffff ||
                !["SIGTERM", "SIGKILL"].includes(signal)) throw new TypeError("cleanup signal request is invalid");
            const tool = io.inspectOwned(KILL);
            if (tool.path !== KILL || tool.ownership.uid !== "0" || tool.ownership.ordinaryUserWritable !== false)
                throw new Error("cleanup kill tool identity is unsafe");
            const command = boundedSudo([KILL, signal === "SIGTERM" ? "-TERM" : "-KILL", "--",
                `-${processGroupId}`]);
            const observation = assertSuccessful(await io.runOwned(command.command, command.argv,
                {timeoutMs: COMMAND_TIMEOUT_MILLISECONDS, maxStreamBytes: MAX_STREAM_BYTES}),
            "cleanup process group signal");
            if (observation.stdout.length !== 0 || observation.stderr.length !== 0)
                throw new Error("cleanup process group signal output differs");
        }
    });
}

export async function collectHostedAdmissionObservations({context, paths: pathsValue, dependencies = {}}) {
    validateHostedContext(context);
    const io = normalizeDependencies(dependencies);
    const taskPath = path.posix.dirname(pathsValue.root);
    const expectedRoot = `${taskPath}/myspeed-windows-cpu-floor-${context.nonce}`;
    if (pathsValue.root !== expectedRoot) throw new TypeError("admission task root path differs");
    const resources = io.readResources(taskPath);
    const layout = io.readCgroupLayout();
    if (!resources?.filesystem || !resources?.memory || !Array.isArray(resources.memory.cgroupLevels) ||
        !layout || JSON.stringify(resources.memory.cgroupLevels.map(level => level.path)) !==
        JSON.stringify(layout.ancestorDirectories)) throw new Error("admission cgroup observation differs");
    const statIdentity = io.inspectOwned(STAT);
    if (statIdentity.ownership.uid !== "0" || statIdentity.ownership.ordinaryUserWritable !== false)
        throw new Error("statvfs observer identity is unsafe");
    const mount = assertSuccessful(await io.runOwned(STAT, ["--printf=%m\\n", "--", taskPath],
        {timeoutMs: COMMAND_TIMEOUT_MILLISECONDS}), "filesystem mount observation");
    const mountLines = new TextDecoder("utf-8", {fatal: true}).decode(mount.stdout).split("\n");
    if (mountLines.at(-1) === "") mountLines.pop();
    if (mountLines.length !== 1 || !path.posix.isAbsolute(mountLines[0]))
        throw new Error("filesystem mount observation is invalid");
    const stat = assertSuccessful(await io.runOwned(STAT,
        ["--file-system", "--printf=%a\\n%S\\n", "--", taskPath],
        {timeoutMs: COMMAND_TIMEOUT_MILLISECONDS}), "statvfs observation");
    const statLines = new TextDecoder("utf-8", {fatal: true}).decode(stat.stdout).split("\n");
    if (statLines.at(-1) === "") statLines.pop();
    if (statLines.length !== 2 || !/^[1-9][0-9]*$/u.test(statLines[0]) ||
        !/^[1-9][0-9]*$/u.test(statLines[1])) throw new Error("statvfs observation is invalid");
    const availableBlocks = BigInt(statLines[0]), fragmentSize = BigInt(statLines[1]);
    let parentWritable = true;
    try { io.assertWritable(taskPath); } catch { parentWritable = false; }
    return {taskRoot: {path: pathsValue.root, exists: io.pathExists(pathsValue.root),
        parentWritableByCurrentUser: parentWritable}, filesystem: {taskPath, mountPoint: mountLines[0],
        type: resources.filesystem.type, mountOptions: resources.filesystem.mountOptions,
        remote: !["btrfs", "ext4", "overlay", "xfs"].includes(resources.filesystem.type),
        availableBlocks: availableBlocks.toString(), fragmentSizeBytes: fragmentSize.toString(),
        availableBytes: (availableBlocks * fragmentSize).toString()}, memory: {
        memAvailableBytes: resources.memory.memAvailableBytes,
        cgroupLevels: resources.memory.cgroupLevels.map(level => ({...level, mountPoint: layout.mountPoint,
            mountRoot: layout.root})), cgroupHeadroomBytes: resources.memory.cgroupHeadroomBytes,
        effectiveAvailableBytes: resources.memory.effectiveAvailableBytes, selfCgroupPath: layout.processDirectory}};
}

function reference(record) {
    return `${record.name}:${record.architecture}=${record.version}`;
}

function portableInvocation(toolchain, tool, argv) {
    if (typeof tool?.invocationPath !== "string" || !tool.invocationPath.startsWith("/") ||
        path.posix.normalize(tool.invocationPath) !== tool.invocationPath)
        throw new TypeError("portable tool invocation path is invalid");
    return {command: toolchain.runtime.loader.path,
        argv: ["--argv0", tool.invocationPath, "--library-path", toolchain.runtime.libraryPath.join(":"), tool.path,
            ...argv]};
}

function boundedSudo(argv) {
    return {command: SUDO, argv: ["-n", "--", TIMEOUT, "--foreground", "--signal=KILL",
        `${PRIVILEGED_COMMAND_TIMEOUT_SECONDS}s`, ...argv]};
}

function sameIdentity(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function assertPortableRoot(io, portableRoot) {
    const temporary = io.inspectDirectory("/tmp");
    if (temporary.path !== "/tmp" || temporary.uid !== "0" || temporary.gid !== "0" || temporary.mode !== "1777" ||
        temporary.sticky !== true) throw new Error("system temporary directory identity is unsafe");
    const portable = io.inspectDirectory(portableRoot);
    if (portable.path !== portableRoot || portable.uid !== "0" || portable.gid !== "0" || portable.mode !== "755" ||
        portable.ordinaryUserWritable !== false || portable.sticky !== false)
        throw new Error("portable root directory identity is unsafe");
    return {temporary, portable};
}

function assertCriticalFileUnchanged(io, expected, label) {
    const observed = io.inspectOwned(expected.path);
    if (observed.path !== expected.path || observed.bytes !== expected.bytes || observed.sha256 !== expected.sha256 ||
        !sameIdentity(observed.ownership, expected.ownership))
        throw new Error(`${label} identity changed before privileged use`);
}

function assertPortableAncestry(io, portableRoot, fileTargets, directoryTargets = []) {
    assertPortableRoot(io, portableRoot);
    const directories = new Set([portableRoot]);
    for (const target of [...fileTargets.map(value => path.posix.dirname(value)), ...directoryTargets]) {
        let current = target;
        while (current !== portableRoot) {
            if (!current.startsWith(`${portableRoot}/`)) throw new Error("portable path escaped its owned root");
            directories.add(current); current = path.posix.dirname(current);
        }
    }
    for (const directory of directories) {
        const facts = io.inspectDirectory(directory);
        if (facts.path !== directory || facts.uid !== "0" || facts.gid !== "0" || facts.ordinaryUserWritable !== false ||
            !/^[0-7]*[0-5][0-5]$/u.test(facts.mode)) throw new Error("portable path ancestry is unsafe");
    }
}

async function launchHostedQemuProcess(io, stageStartedMilliseconds, input) {
    validateInstallerBootConfirmation(input.bootConfirmation);
    const winpeDiagnostic = validateWinpeDiagnosticAuthorization(input.winpeDiagnostic);
    if (input.privilegeMode !== "ordinary-kvm" && input.privilegeMode !== "reviewed-sudo-kvm")
        throw new TypeError("QEMU privilege mode is invalid");
    assertPortableAncestry(io, input.paths.portableRoot,
        [input.toolchain.runtime.loader.path, input.toolchain.qemu.path, input.toolchain.firmware.kvmvapic.path,
            input.toolchain.firmware.vga.path], [...input.toolchain.runtime.libraryPath, input.toolchain.firmware.searchPath]);
    assertCriticalFileUnchanged(io, input.toolchain.runtime.loader, "portable runtime loader");
    assertCriticalFileUnchanged(io, input.toolchain.qemu, "QEMU executable");
    assertCriticalFileUnchanged(io, input.toolchain.firmware.kvmvapic, "QEMU kvmvapic firmware");
    assertCriticalFileUnchanged(io, input.toolchain.firmware.vga, "QEMU VGA firmware");
    let timeoutSeconds = QEMU_TIMEOUT_SECONDS;
    let outerTimeoutMs = QEMU_OUTER_TIMEOUT_MILLISECONDS;
    const isDiagnostic = input.deadlines !== undefined;
    /*
     * A named reservation, for a caller whose cost is charged against a budget this launcher cannot
     * see - the containment preflight, which boots before the matrix that would otherwise admit it.
     * It is deliberately not the CPU diagnostic's flag: that one names one fixed 25-minute mode, and
     * widening it would make a second caller's budget depend on the first one's constant. It can
     * only tighten the default deadline, never reach past it.
     */
    const isReserved = input.reservation !== undefined;
    if (isReserved) {
        const reservation = input.reservation;
        if (!reservation || typeof reservation !== "object" || Array.isArray(reservation) || isDiagnostic
            || Object.keys(reservation).length !== RESERVATION_KEYS.length
            || RESERVATION_KEYS.some(name => !Object.hasOwn(reservation, name))
            || typeof reservation.label !== "string" || !RESERVATION_LABEL.test(reservation.label)
            || !Number.isSafeInteger(reservation.executionMilliseconds)
            || reservation.executionMilliseconds < MINIMUM_RESERVATION_MILLISECONDS
            || reservation.executionMilliseconds > QEMU_TIMEOUT_SECONDS * 1_000
            || !Number.isSafeInteger(reservation.cleanupMilliseconds)
            || reservation.cleanupMilliseconds < MINIMUM_RESERVATION_MILLISECONDS)
            throw new TypeError("QEMU reservation is invalid");
        timeoutSeconds = Math.floor(reservation.executionMilliseconds / 1_000);
        outerTimeoutMs = reservation.executionMilliseconds + reservation.cleanupMilliseconds;
    }
    if (isDiagnostic) {
        if (!input.deadlines || typeof input.deadlines !== "object" ||
            input.deadlines.executionMinutes !== DIAGNOSTIC_EXECUTION_MINUTES ||
            input.deadlines.cleanupMinutes !== DIAGNOSTIC_CLEANUP_MINUTES) {
            throw new TypeError("unsupported QEMU deadlines");
        }
        timeoutSeconds = DIAGNOSTIC_TIMEOUT_SECONDS;
        outerTimeoutMs = DIAGNOSTIC_OUTER_TIMEOUT_MILLISECONDS;
    }
    const qemuInvocation = portableInvocation(input.toolchain, input.toolchain.qemu, input.argv);
    const launcher = input.privilegeMode === "reviewed-sudo-kvm" ? {
        command: SUDO, argv: ["-n", "--", TIMEOUT, "--foreground", "--signal=KILL",
            `${timeoutSeconds}s`, qemuInvocation.command, ...qemuInvocation.argv]
    } : {command: TIMEOUT, argv: ["--foreground", "--signal=KILL", `${timeoutSeconds}s`,
        qemuInvocation.command, ...qemuInvocation.argv]};
    const sudoIdentity = input.privilegeMode === "reviewed-sudo-kvm" ? io.inspectOwned(SUDO) : null;
    const timeoutIdentity = io.inspectOwned(TIMEOUT);
    const killIdentity = io.inspectOwned(KILL);
    const readlinkIdentity = io.inspectOwned(READLINK);
    for (const [name, identity] of [["sudo", sudoIdentity], ["timeout", timeoutIdentity], ["kill", killIdentity],
        ["readlink", readlinkIdentity]]) {
        if (identity && (identity.ownership.uid !== "0" || identity.ownership.ordinaryUserWritable !== false))
            throw new Error(`${name} launcher identity is unsafe`);
    }
    const launchTime = io.monotonicMilliseconds();
    /*
     * A reserved launch is launch-relative: its reservation was opened when the preflight started
     * and has already charged everything spent since, so measuring it from the stage start again
     * would take the same time twice.
     */
    const executionDeadline = isDiagnostic || isReserved ?
        (launchTime + timeoutSeconds * 1_000) :
        Math.min(launchTime + timeoutSeconds * 1_000, stageStartedMilliseconds + timeoutSeconds * 1_000);
    if (executionDeadline <= launchTime) throw new Error("Stage 2 execution budget expired before QEMU launch");
    const screenshotPaths = [`${input.paths.root}/early-boot-1.png`, `${input.paths.root}/early-boot-2.png`];
    if (screenshotPaths.some(target => io.pathExists(target)))
        throw new Error("early-boot screenshot target already exists");
    /*
     * The WinPE diagnostic needs the late capture for its own reasons: its one input window opens
     * after the first frame, and the second frame is the only host-side observation of what the
     * typed line did. It runs on a reservation rather than the CPU diagnostic's fixed deadlines, so
     * the two stay mutually exclusive exactly as before.
     */
    const lateScreenshotPaths = isDiagnostic || winpeDiagnostic !== undefined ?
        [`${input.paths.root}/late-boot-1.png`, `${input.paths.root}/late-boot-2.png`] : null;
    if (lateScreenshotPaths !== null && lateScreenshotPaths.some(target => io.pathExists(target)))
        throw new Error("late-boot screenshot target already exists");
    const isPredeadlineActive = isDiagnostic && winpeDiagnostic === undefined && !isReserved;
    const predeadlineScreenshotPath = isPredeadlineActive ? `${input.paths.root}/predeadline-frame.png` : null;
    if (predeadlineScreenshotPath !== null && io.pathExists(predeadlineScreenshotPath))
        throw new Error("predeadline screenshot target already exists");
    const monitored = await io.runMonitoredQemu({command: launcher.command, argv: launcher.argv,
        timeoutMs: outerTimeoutMs, pidPath: input.paths.qemuPid,
        expectedExecutable: input.toolchain.runtime.loader.path, maxStreamBytes: QEMU_STREAM_BYTES,
        executionDeadline, precreatePidFile: input.privilegeMode === "reviewed-sudo-kvm",
        resources: {taskPath: path.posix.dirname(input.paths.root),
            roots: [input.paths.root, input.paths.portableRoot]},
        qmp: {screenshotPaths, ...(lateScreenshotPaths !== null ? {lateScreenshotPaths} : {}),
            ...(predeadlineScreenshotPath !== null ? {
                predeadline: {screenshotPath: predeadlineScreenshotPath, executionDeadline}
            } : {}),
            ...(input.bootConfirmation === undefined ? {} : {bootConfirmation: input.bootConfirmation}),
            ...(winpeDiagnostic === undefined ? {} : {winpeDiagnostic})},
        qmpDependencies: {
            now: io.monotonicMilliseconds,
            ...(io.wait ? {wait: io.wait} : {}),
            ...(io.setTimer ? {setTimer: io.setTimer} : {}),
            ...(io.clearTimer ? {clearTimer: io.clearTimer} : {})
        }});
    const observation = monitored.observation;
    const cleanupProven = observation.process.cleanupProven === true && monitored.identity !== null &&
        monitored.absentAfter === true && monitored.processGroupGone === true;
    const processRecord = {...observation.process, cleanupProven, treeGone: cleanupProven,
        qemuPid: monitored.identity?.pid ?? null, qemuStartTicks: monitored.identity?.startTicks ?? null,
        launcherExecutablePath: monitored.identity?.executablePath ?? null,
        processGroupId: monitored.identity?.processGroupId ?? null,
        qemuPidAbsentAfter: monitored.absentAfter, terminationReason: monitored.terminationReason ?? null};
    let earlyBoot = null;
    if (monitored.qmp?.running === true && monitored.qmp.status === "running" &&
        JSON.stringify(monitored.qmp.screenshotPaths) === JSON.stringify(screenshotPaths)) {
        try {
            validateInstallerBootInput(monitored.qmp.inputSent, input.bootConfirmation);
            const screenshots = screenshotPaths.map(target => {
                const observed = io.readOwnedVerified(target, MAX_EARLY_BOOT_SCREENSHOT_BYTES);
                if (observed.identity.path !== target || observed.bytes.length < PNG_SIGNATURE.length ||
                    !observed.bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE))
                    throw new Error("early-boot screenshot is invalid");
                return {...observed.identity, bytesBase64: observed.bytes.toString("base64")};
            });
            earlyBoot = {schemaVersion: 1, kind: "qemu-early-boot-observation",
                inputSent: structuredClone(monitored.qmp.inputSent),
                version: structuredClone(monitored.qmp.version), status: monitored.qmp.status, running: true, screenshots};
        } catch { /* a missing or changed screenshot keeps the launch non-acceptable */ }
    }
    let lateBoot = null;
    if (cleanupProven && processRecord.treeGone && monitored.lateBoot?.milestones &&
        Array.isArray(monitored.lateBoot.milestones)) {
        try {
            const validatedMilestones = monitored.lateBoot.milestones.map(item => {
                const observed = io.readOwnedVerified(item.screenshotPath, MAX_EARLY_BOOT_SCREENSHOT_BYTES);
                if (observed.identity.path !== item.screenshotPath || observed.bytes.length < PNG_SIGNATURE.length ||
                    !observed.bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
                    sha256(observed.bytes) !== observed.identity.sha256) {
                    throw new Error("late-boot screenshot is invalid");
                }
                return {
                    milestone: item.milestone,
                    offsetMs: item.offsetMs,
                    status: item.status,
                    running: item.running,
                    screenshot: {
                        path: item.screenshotPath,
                        bytes: observed.identity.bytes,
                        sha256: observed.identity.sha256,
                        bytesBase64: observed.bytes.toString("base64")
                    }
                };
            });
            if (validatedMilestones.length > 0) {
                lateBoot = {
                    schemaVersion: 1,
                    kind: "qemu-late-boot-observation",
                    displayAdvanced: displayProgressVerdict(earlyBoot, validatedMilestones),
                    milestones: validatedMilestones
                };
            }
        } catch {
            lateBoot = null;
        }
    }
    /*
     * The typed sequence's own record, kept out of `lateBoot` on purpose: it is evidence about the
     * host's writes, not about a frame, and a frame this launcher could not validate must not erase
     * it. It is the only host-side assertion the diagnostic makes, and it asserts monitor
     * acceptance and nothing beyond it.
     */
    let winpeDiagnosticInput = null;
    if (winpeDiagnostic !== undefined && monitored.lateBoot?.winpeDiagnostic !== undefined) {
        try { winpeDiagnosticInput = validateWinpeDiagnosticInput(monitored.lateBoot.winpeDiagnostic, winpeDiagnostic); }
        catch { winpeDiagnosticInput = null; }
    }
    const result = {process: {exitCode: processRecord.exitCode, signal: processRecord.signal,
        timedOut: processRecord.timedOut, cleanupProven: processRecord.cleanupProven,
        treeGone: processRecord.treeGone, qemuPid: processRecord.qemuPid,
        qemuStartTicks: processRecord.qemuStartTicks,
        launcherExecutablePath: processRecord.launcherExecutablePath,
        processGroupId: processRecord.processGroupId,
        qemuPidAbsentAfter: processRecord.qemuPidAbsentAfter,
        terminationReason: processRecord.terminationReason}, argv: input.argv, earlyBoot,
        ...(lateBoot !== null ? {lateBoot} : {})};
    const guestParsingAllowed = processRecord.exitCode === 0 && processRecord.signal === null
        && !processRecord.timedOut && processRecord.cleanupProven && !processRecord.errorObserved
        && !processRecord.stdoutOverflow && !processRecord.stderrOverflow && earlyBoot !== null;
    const processFlags = {errorObserved: processRecord.errorObserved,
        stdoutOverflow: processRecord.stdoutOverflow, stderrOverflow: processRecord.stderrOverflow};
    if (!guestParsingAllowed) result.failureDiagnostic = {schemaVersion: 1, kind: "qemu-launch-failure-diagnostic",
        process: structuredClone(result.process), processFlags: structuredClone(processFlags),
        monitorFailure: monitored.monitorFailure ?? null, stderr: {
            bytes: String(observation.stderr.length), sha256: sha256(observation.stderr),
            bytesBase64: observation.stderr.toString("base64")},
        ...readSerialConsole(io, input.paths.serialLog)};
    return {
        result,
        guestParsingAllowed,
        processFlags,
        winpeDiagnosticInput,
        predeadline: monitored.predeadline,
        cleanupProven
    };
}

/*
 * The collection, after the guest is gone. Every precondition is separate and every one of them
 * produces a distinct recorded outcome rather than an empty success:
 *
 *   - the QEMU process group has to be proven gone and the tree with it, because mcopy reads the
 *     same image file the guest was writing;
 *   - the output disk has to still be the file this task created, by the same pre/post identity
 *     check the ordinary guest receipt already uses;
 *   - the collection budget has to have time left before each member, and the member's own
 *     extraction has to have ended and had its process group proven gone before it is published.
 */
async function collectWinpeDiagnostic(io, context, input, launched, budget) {
    const secrets = [winpeDiagnosticGuestSecret(context.nonce)];
    const record = {schemaVersion: 1, kind: "winpe-answer-file-diagnostic-collection",
        status: "not-attempted", outputDiskVerified: false, members: [], failure: null};
    const fail = (status, reason) => {
        record.status = status;
        record.failure = boundedReason(reason);
        return Object.freeze({...record, members: Object.freeze(record.members)});
    };
    if (launched.process?.cleanupProven !== true || launched.process?.treeGone !== true)
        return fail("unsafe", "guest process tree was not proven gone");
    /*
     * Without a pre-launch identity there is nothing to compare the disk against, and validating it
     * against `null` would only prove it is some ordinary owned file. That is not the check.
     */
    if (input.preLaunchDiskIdentity === null || input.preLaunchDiskIdentity === undefined)
        return fail("unsafe", "output disk was not identified before the launch");
    const taskOwner = typeof process.getuid === "function" ?
        {uid: BigInt(process.getuid()), gid: typeof process.getgid === "function" ? BigInt(process.getgid()) : null} : null;
    try { io.validateOutputDisk(input.paths.outputDisk, input.preLaunchDiskIdentity, taskOwner); }
    catch (error) { return fail("unsafe", error instanceof Error ? error.message : error); }
    record.outputDiskVerified = true;
    for (const member of WINPE_DIAGNOSTIC_MEMBERS) {
        let allowedMilliseconds;
        try { allowedMilliseconds = budget.admit(COMMAND_TIMEOUT_MILLISECONDS); }
        catch (error) {
            record.members.push(Object.freeze({name: member.name, role: member.role, status: "budget-exhausted",
                reason: boundedReason(error instanceof Error ? error.message : error)}));
            return fail("inconclusive", "collection budget was exhausted before every member was read");
        }
        const invocation = portableInvocation(input.toolchain, input.toolchain.mcopy,
            ["-i", input.paths.outputDisk, `::${member.name}`, "-"]);
        let observed;
        try {
            observed = await io.runOwned(invocation.command, invocation.argv,
                {timeoutMs: Math.max(1, Math.floor(allowedMilliseconds)),
                    maxStreamBytes: WINPE_DIAGNOSTIC_MEMBER_READ_BYTES});
        } catch (error) {
            record.members.push(Object.freeze({name: member.name, role: member.role, status: "tool-error",
                reason: boundedReason(error instanceof Error ? error.message : error)}));
            continue;
        }
        record.members.push(Object.freeze({role: member.role,
            ...publishWinpeDiagnosticMember(member.name, observed, secrets)}));
    }
    const byName = new Map(record.members.map(member => [member.name, member]));
    /*
     * Complete means the guest wrote its own completion marker and nothing had to be withheld.
     * Anything else is inconclusive - including a run where every log came back but the marker did
     * not, because that is a collection the guest never said it finished.
     */
    const completed = byName.get("MSDIAG.OK")?.status === "captured";
    const withheld = record.members.some(member => String(member.status).startsWith("withheld"));
    record.status = completed && !withheld ? "capture-complete" : "inconclusive";
    if (withheld) record.failure = "at least one member was withheld rather than published";
    else if (!completed) record.failure = "the guest completion marker was not collected";
    return Object.freeze({...record, members: Object.freeze(record.members)});
}

export function createHostedQemuProcessLauncher({context, dependencies = {}}) {
    validateHostedContext(context);
    const io = normalizeDependencies(dependencies);
    const stageStartedMilliseconds = io.monotonicMilliseconds();
    return Object.freeze(async input => {
        const monitored = await launchHostedQemuProcess(io, stageStartedMilliseconds, input);
        return {...monitored.result, executionSucceeded: monitored.guestParsingAllowed,
            processFlags: monitored.processFlags};
    });
}

/*
 * Classification of one extraction attempt. A timed-out extraction, an extraction whose own process
 * reported an error, one whose streams overflowed, and one whose process group was not proven gone
 * are four different outcomes, and none of them may read as "read nothing, all well". They are all
 * terminal: once an extraction has ended unsafely nothing further is attempted on that disk.
 *
 * Only `not-retrieved` - a non-zero exit that produced no bytes at all - continues to the fallback.
 * A non-zero exit that DID produce bytes is a partial read of the primary and is recorded as such,
 * because letting a later clean read stand in its place would report incomplete bytes as complete.
 */
function classifyReceiptExtraction(observed) {
    const state = observed?.process ?? {};
    const stdout = Buffer.isBuffer(observed?.stdout) ? observed.stdout : Buffer.alloc(0);
    if (state.timedOut === true) return {kind: "unsafe", reason: "extraction-timeout"};
    if (state.errorObserved === true) return {kind: "unsafe", reason: "tool-error"};
    if (state.stderrOverflow === true) return {kind: "unsafe", reason: "extraction-unsafe"};
    if (state.cleanupProven !== true) return {kind: "unsafe", reason: "extraction-unsafe"};
    if (state.stdoutOverflow === true) return {kind: "capped", stdout};
    if (state.signal !== null && state.signal !== undefined) return {kind: "unsafe", reason: "tool-error"};
    if (state.exitCode === 0) return {kind: "read", stdout};
    if (stdout.length > 0) return {kind: "partial", stdout};
    return {kind: "not-retrieved"};
}

/*
 * The bounded, authenticated look at whatever the guest left on its output disk after an unclean
 * stop. It can never make a run acceptable: every record it produces is diagnostic only, and a
 * well-formed success receipt after an unclean stop stays a success receipt that is not calibration.
 *
 * Bytes come from the extraction's own streamed stdout and nowhere else. Reading a file that happens
 * to sit in the task root would let an unrelated artefact stand in for evidence the guest never
 * produced, which is the opposite of what this evidence exists for.
 */
export async function extractGuestReceiptDiagnostic(io, input, context, launched, taskOwner, preLaunchDiskIdentity) {
    const unavailable = reason => ({guestFailure: null,
        diagnostic: {schemaVersion: 1, status: "unavailable", reason}});
    if (launched.process?.cleanupProven !== true || launched.process?.treeGone !== true)
        return unavailable("cleanup-unproven");
    if (preLaunchDiskIdentity === null || preLaunchDiskIdentity === undefined)
        return unavailable("output-disk-unverified");
    try {
        io.validateOutputDisk(input.paths.outputDisk, preLaunchDiskIdentity, taskOwner);
    } catch {
        return unavailable("disk-identity-mismatch");
    }

    const budget = createWinpeDiagnosticCollectionBudget(
        io.monotonicMilliseconds() + RECEIPT_EXTRACTION_BUDGET_MILLISECONDS,
        () => io.monotonicMilliseconds());

    const attempt = async filename => {
        let allowedMilliseconds;
        try { allowedMilliseconds = budget.admit(COMMAND_TIMEOUT_MILLISECONDS); }
        catch { return {kind: "unsafe", reason: "extraction-budget-exhausted"}; }
        const invocation = portableInvocation(input.toolchain, input.toolchain.mcopy,
            ["-i", input.paths.outputDisk, "::" + filename, "-"]);
        let observed;
        try {
            observed = await io.runOwned(invocation.command, invocation.argv,
                {timeoutMs: Math.max(1, Math.floor(allowedMilliseconds)), maxStreamBytes: MAX_GUEST_BYTES});
        } catch {
            return {kind: "unsafe", reason: "tool-error"};
        }
        return classifyReceiptExtraction(observed);
    };

    const publish = (source, stdout) => {
        const bytes = String(stdout.length);
        const digest = sha256(stdout);
        const malformed = reason => ({guestFailure: null,
            diagnostic: {schemaVersion: 1, status: "malformed", source, reason, bytes, sha256: digest}});
        let parsed;
        try { parsed = parseJson(stdout, "guest receipt"); }
        catch { return malformed("json-syntax-error"); }
        const claimed = parsed?.nonce ?? parsed?.hostNonce;
        const nonceMismatch = typeof claimed === "string" && claimed !== context.nonce;
        if (parsed?.status === "failed") {
            try {
                const canonical = parseGuestFailure(stdout, context.nonce);
                return {guestFailure: canonical,
                    diagnostic: {schemaVersion: 1, status: "valid-failure", source, receipt: canonical}};
            } catch { return malformed(nonceMismatch ? "nonce-mismatch" : "failure-receipt-invalid"); }
        }
        /*
         * A success receipt is only ever published from the primary name, and only as metadata. It
         * is retained so that a guest which finished its work and then failed to stop cleanly is
         * distinguishable from one that never wrote anything - and it still fails calibration.
         */
        if (source !== "result.json") return malformed(nonceMismatch ? "nonce-mismatch" : "schema-invalid");
        try {
            parseGuestOutput(stdout, context.nonce);
            return {guestFailure: null,
                diagnostic: {schemaVersion: 1, status: "valid-success", source, bytes, sha256: digest}};
        } catch (error) {
            /* The code is read back out of the parser's own record; anything else stays historical. */
            return malformed(nonceMismatch ? "nonce-mismatch" : receiptRejectionCode(error) ?? "schema-invalid");
        }
    };

    const capped = (source, stdout) => ({guestFailure: null,
        diagnostic: {schemaVersion: 1, status: "malformed", source, reason: "read-cap-exceeded",
            bytes: String(stdout.length), sha256: sha256(stdout)}});
    const partial = (source, stdout) => ({guestFailure: null,
        diagnostic: {schemaVersion: 1, status: "malformed", source, reason: "partial-read",
            bytes: String(stdout.length), sha256: sha256(stdout)}});

    const primary = await attempt("result.json");
    if (primary.kind === "unsafe") return unavailable(primary.reason);
    if (primary.kind === "capped") return capped("result.json", primary.stdout);
    if (primary.kind === "partial") return partial("result.json", primary.stdout);
    if (primary.kind === "read") return publish("result.json", primary.stdout);

    const fallback = await attempt(GUEST_FAILURE_FALLBACK_NAME);
    if (fallback.kind === "unsafe") return unavailable(fallback.reason);
    if (fallback.kind === "capped") return capped(GUEST_FAILURE_FALLBACK_NAME, fallback.stdout);
    if (fallback.kind === "partial") return partial(GUEST_FAILURE_FALLBACK_NAME, fallback.stdout);
    if (fallback.kind === "read") return publish(GUEST_FAILURE_FALLBACK_NAME, fallback.stdout);

    return unavailable("receipt-not-retrieved");
}

/*
 * The optional diagnostic is collected for a launch that has already failed. Anything unexpected
 * inside it - a malformed toolchain record, a shape the classifier never anticipated - is retained
 * as a bounded unavailable reason rather than thrown, because throwing here would replace the QEMU
 * failure and the cleanup proof that are the run's primary evidence.
 */
export async function collectGuestReceiptDiagnostic(io, input, context, launched, taskOwner, preLaunchDiskIdentity) {
    try {
        return await extractGuestReceiptDiagnostic(io, input, context, launched, taskOwner, preLaunchDiskIdentity);
    } catch {
        return {guestFailure: null, diagnostic: {schemaVersion: 1, status: "unavailable", reason: "tool-error"}};
    }
}

/*
 * The optional predeadline frame is collected strictly after proven owned cleanup.
 * Missing capture, command failure or corruption are retained with fixed status and reasons.
 * Any thrown exception is caught and reported with a fixed status to never displace primary launch failure.
 */
export function collectPredeadlineFrameDiagnostic(io, input, predeadlineState, cleanupProven) {
    try {
        if (!predeadlineState) return null;
        if (cleanupProven !== true) {
            return {schemaVersion: 1, status: "unavailable", reason: "cleanup-unproven"};
        }
        if (predeadlineState.status === "skipped") {
            const reason = PREDEADLINE_FRAME_SKIPPED_REASONS.includes(predeadlineState.reason) ?
                predeadlineState.reason : "disabled";
            return {schemaVersion: 1, status: "skipped", reason};
        }
        if (predeadlineState.status === "unavailable") {
            const reason = PREDEADLINE_FRAME_UNAVAILABLE_REASONS.includes(predeadlineState.reason) ?
                predeadlineState.reason : "command-failed";
            return {schemaVersion: 1, status: "unavailable", reason};
        }
        if (predeadlineState.status === "captured") {
            const expectedPath = `${input?.paths?.root}/predeadline-frame.png`;
            const targetPath = predeadlineState.screenshotPath;
            if (typeof targetPath !== "string" || targetPath !== expectedPath) {
                return {
                    schemaVersion: 1, status: "malformed", reason: "path-mismatch",
                    bytes: "0", sha256: crypto.createHash("sha256").update("").digest("hex")
                };
            }
            let exists = false;
            try {
                exists = io.pathExists(targetPath);
            } catch {
                return {schemaVersion: 1, status: "unavailable", reason: "read-error"};
            }
            if (!exists) {
                return {schemaVersion: 1, status: "unavailable", reason: "file-missing"};
            }
            let observed;
            try {
                observed = io.readOwnedVerified(targetPath, MAX_PREDEADLINE_FRAME_BYTES);
            } catch {
                return {schemaVersion: 1, status: "unavailable", reason: "read-error"};
            }
            if (!observed || !observed.identity || typeof observed.identity.bytes !== "string" ||
                typeof observed.identity.sha256 !== "string" || !Buffer.isBuffer(observed.bytes)) {
                return {schemaVersion: 1, status: "unavailable", reason: "read-error"};
            }
            if (observed.identity.path !== targetPath) {
                return {
                    schemaVersion: 1, status: "malformed", reason: "path-mismatch",
                    bytes: String(observed.bytes.length), sha256: sha256(observed.bytes)
                };
            }
            if (observed.bytes.length < PNG_SIGNATURE.length ||
                !observed.bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
                return {
                    schemaVersion: 1, status: "malformed", reason: "invalid-png-signature",
                    bytes: String(observed.bytes.length), sha256: sha256(observed.bytes)
                };
            }
            const fileSha = sha256(observed.bytes);
            if (fileSha !== observed.identity.sha256) {
                return {
                    schemaVersion: 1, status: "malformed", reason: "hash-mismatch",
                    bytes: String(observed.bytes.length), sha256: fileSha
                };
            }
            return {
                schemaVersion: 1,
                status: "captured",
                offsetMs: Number.isSafeInteger(predeadlineState.offsetMs) && predeadlineState.offsetMs >= 0 ?
                    predeadlineState.offsetMs : 0,
                screenshot: {
                    path: targetPath,
                    bytes: observed.identity.bytes,
                    sha256: observed.identity.sha256,
                    bytesBase64: observed.bytes.toString("base64")
                }
            };
        }
        return {schemaVersion: 1, status: "unavailable", reason: "command-failed"};
    } catch {
        return {schemaVersion: 1, status: "unavailable", reason: "read-error"};
    }
}

export function createHostedStage2Operations({context, paths: pathsValue, dependencies = {}}) {
    validateHostedContext(context);
    const io = normalizeDependencies(dependencies);
    const stageStartedMilliseconds = io.monotonicMilliseconds();
    return Object.freeze({
        async resolveSignedPackageClosure(input) {
            const vectors = buildIsolatedAptVectors(input.paths);
            io.mkdirExclusive(vectors.aptRoot); io.mkdirExclusive(vectors.lists); io.mkdirExclusive(vectors.archives);
            io.writeExclusive(vectors.aptConfig, vectors.aptConfigBytes);
            io.writeExclusive(vectors.sourceList, vectors.sourcesBytes); io.writeExclusive(vectors.status,
                vectors.emptyStatusBytes);
            assertSuccessful(await io.runOwned(vectors.update.command, vectors.update.argv,
                {timeoutMs: COMMAND_TIMEOUT_MILLISECONDS, env: vectors.aptEnvironment}), "apt snapshot update");
            const resolver = io.resolveAptClosure ?? (request => collectAptClosure(io, request));
            return await resolver({context, paths: input.paths, vectors, gpgv: GPGV,
                keyring: UBUNTU_KEYRING, pins: TOP_LEVEL_PACKAGE_PINS});
        },
        async acquirePackages(input) {
            const packages = [];
            for (const record of input.packageClosure.packages) {
                const target = `${input.paths.packageRoot}/${record.name}_${sha256(Buffer.from(reference(record))).slice(0, 16)}.deb`;
                packages.push({reference: reference(record), ...await io.downloadPinned({
                    url: `${STAGE2_PROVENANCE.ubuntuSnapshot.baseUrl}${record.filename}`, path: target,
                    bytes: record.bytes, sha256: record.sha256})});
            }
            return {complete: true, packages};
        },
        async extractPortableTools(input) {
            const installRoot = input.paths.portableRoot;
            if (io.pathExists(installRoot)) throw new Error("portable root already exists");
            const temporaryBefore = io.inspectDirectory("/tmp");
            if (temporaryBefore.path !== "/tmp" || temporaryBefore.uid !== "0" || temporaryBefore.gid !== "0" ||
                temporaryBefore.mode !== "1777" || temporaryBefore.sticky !== true)
                throw new Error("system temporary directory identity is unsafe");
            let privileged = boundedSudo([INSTALL, "-d", "-o", "root", "-g", "root", "-m", "0755", installRoot]);
            assertSuccessful(await io.runOwned(privileged.command, privileged.argv,
                {timeoutMs: COMMAND_TIMEOUT_MILLISECONDS}), "portable root creation");
            const rootFacts = assertPortableRoot(io, installRoot);
            if (!sameIdentity(rootFacts.temporary, temporaryBefore))
                throw new Error("system temporary directory changed during portable-root creation");
            const stagedPackageRoot = `${installRoot}/.packages`;
            privileged = boundedSudo([INSTALL, "-d", "-o", "root", "-g", "root", "-m", "0755", stagedPackageRoot]);
            assertSuccessful(await io.runOwned(privileged.command, privileged.argv,
                {timeoutMs: COMMAND_TIMEOUT_MILLISECONDS}), "portable package root creation");
            for (const record of input.acquisition.packages) {
                assertPortableRoot(io, installRoot);
                const expected = input.packageClosure.packages.find(candidate => reference(candidate) === record.reference);
                const source = io.inspectOwned(record.path);
                if (!expected || source.path !== record.path || source.bytes !== expected.bytes ||
                    source.sha256 !== expected.sha256) throw new Error("portable package source identity differs");
                const staged = `${stagedPackageRoot}/${sha256(Buffer.from(record.reference)).slice(0, 16)}.deb`;
                privileged = boundedSudo([INSTALL, "-o", "root", "-g", "root", "-m", "0444", "--", record.path,
                    staged]);
                assertSuccessful(await io.runOwned(privileged.command, privileged.argv,
                    {timeoutMs: COMMAND_TIMEOUT_MILLISECONDS}), "portable package staging");
                const stagedIdentity = io.inspectOwned(staged);
                if (stagedIdentity.path !== staged || stagedIdentity.bytes !== expected.bytes ||
                    stagedIdentity.sha256 !== expected.sha256 || stagedIdentity.ownership.uid !== "0" ||
                    stagedIdentity.ownership.gid !== "0" || stagedIdentity.ownership.mode !== "444" ||
                    stagedIdentity.ownership.ordinaryUserWritable !== false)
                    throw new Error("staged portable package identity differs");
                assertPortableRoot(io, installRoot);
                privileged = boundedSudo([DPKG_DEB, "-x", staged, installRoot]);
                assertSuccessful(await io.runOwned(privileged.command, privileged.argv,
                    {timeoutMs: COMMAND_TIMEOUT_MILLISECONDS}), "portable package extraction");
            }
            assertPortableRoot(io, installRoot);
            const identify = relative => io.inspectOwned(`${installRoot}/${relative}`);
            const identifyCommand = relative => {
                const invocationPath = `${installRoot}/${relative}`;
                return {...io.inspectOwned(invocationPath), invocationPath};
            };
            const identifyFirst = candidates => {
                const failures = [];
                for (const relative of candidates) try { return identify(relative); }
                catch (error) { failures.push(error); }
                throw failures.at(-1) ?? new Error("portable tool identity is unavailable");
            };
            const qemu = identifyCommand("usr/bin/qemu-system-x86_64");
            const sevenZip = identifyCommand(SEVEN_ZIP_RELATIVE_PATH);
            const sevenZipModule = identify(SEVEN_ZIP_MODULE_RELATIVE_PATH);
            const loader = identifyFirst(["usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2",
                "lib/x86_64-linux-gnu/ld-linux-x86-64.so.2"]);
            const runtime = {loader, libraryPath: [path.posix.dirname(loader.path),
                `${installRoot}/${SEVEN_ZIP_LIBRARY_RELATIVE_PATH}`]};
            const firmware = {searchPath: `${installRoot}/usr/share/qemu`,
                kvmvapic: identify("usr/share/qemu/kvmvapic.bin"),
                vga: identify("usr/share/seabios/vgabios-stdvga.bin")};
            assertPortableAncestry(io, installRoot,
                [qemu.path, sevenZip.path, sevenZipModule.path, runtime.loader.path, firmware.kvmvapic.path,
                    firmware.vga.path], [...runtime.libraryPath, firmware.searchPath]);
            const invokeQemu = argv => portableInvocation({runtime}, qemu, argv);
            let invocation = invokeQemu(["--version"]);
            const version = assertSuccessful(await io.runOwned(invocation.command, invocation.argv,
                {timeoutMs: COMMAND_TIMEOUT_MILLISECONDS}), "QEMU version").stdout.toString("utf8").split(/\r?\n/u)[0];
            invocation = invokeQemu(["-cpu", "help"]);
            const cpuHelp = assertSuccessful(await io.runOwned(invocation.command, invocation.argv,
                {timeoutMs: COMMAND_TIMEOUT_MILLISECONDS}), "QEMU CPU help").stdout.toString("utf8");
            invocation = invokeQemu(["-machine", "help"]);
            const machineHelp = assertSuccessful(await io.runOwned(invocation.command, invocation.argv,
                {timeoutMs: COMMAND_TIMEOUT_MILLISECONDS}), "QEMU machine help").stdout.toString("utf8");
            invocation = invokeQemu(["-device", "help"]);
            const deviceHelp = assertSuccessful(await io.runOwned(invocation.command, invocation.argv,
                {timeoutMs: COMMAND_TIMEOUT_MILLISECONDS}), "QEMU device help").stdout.toString("utf8");
            invocation = portableInvocation({runtime}, sevenZip, ["i"]);
            const sevenZipInfo = assertSuccessful(await io.runOwned(invocation.command, invocation.argv,
                {timeoutMs: COMMAND_TIMEOUT_MILLISECONDS}), "7-Zip format inspection").stdout.toString("utf8");
            const expectedModuleLine = ` 0 : ${SEVEN_ZIP_VERSION} : ${sevenZipModule.path}`;
            if (!sevenZipInfo.split(/\r?\n/u).includes(expectedModuleLine))
                throw new Error("7-Zip module was not loaded from the pinned portable runtime");
            if (!SEVEN_ZIP_ISO_FORMAT_PATTERN.test(sevenZipInfo))
                throw new Error("7-Zip ISO support is unavailable through the pinned portable runtime");
            const installedInventory = io.inventoryOwnedTree(installRoot);
            const licenseInventory = io.inventoryOwnedTree(installRoot,
                relative => /^usr\/share\/doc\/[^/]+\/copyright$/u.test(relative));
            return {qemu: {...qemu, version}, qemuImg: identifyCommand("usr/bin/qemu-img"),
                genisoimage: identifyCommand("usr/bin/genisoimage"), mcopy: identifyCommand("usr/bin/mcopy"),
                mformat: identifyCommand("usr/bin/mformat"),
                sevenZip, wiminfo: identifyCommand("usr/bin/wiminfo"),
                ovmfCode: identify("usr/share/OVMF/OVMF_CODE_4M.fd"),
                ovmfVarsTemplate: identify("usr/share/OVMF/OVMF_VARS_4M.fd"),
                firmware, runtime,
                packageClosureSha256: sha256(Buffer.from(JSON.stringify(input.packageClosure))),
                installedFilesManifest: {bytes: installedInventory.bytes, sha256: installedInventory.sha256},
                licensesManifest: {bytes: licenseInventory.bytes, sha256: licenseInventory.sha256},
                capabilities: {cpuModels: cpuHelp.includes("Westmere-v2") ? ["Westmere-v2"] : [],
                    machines: machineHelp.includes("q35") ? ["q35"] : [],
                    devices: ["ich9-ahci", "ide-cd", "ide-hd", "isa-serial", "VGA", "qemu-xhci", "usb-kbd"]
                        .filter(item => deviceHelp.includes(item)),
                    accelerator: "kvm"}};
        },
        async acquireProbeClosure(input) {
            const archive = io.inspectOwned(`${input.paths.probeRoot}/artifact.zip`);
            const manifestRead = io.readOwnedVerified(`${input.paths.probeRoot}/result.json`, MAX_PROBE_MANIFEST_BYTES);
            const innerManifest = manifestRead.identity;
            if (innerManifest.bytes !== input.probeArtifact.innerManifest.bytes ||
                innerManifest.sha256 !== input.probeArtifact.innerManifest.sha256)
                throw new Error("probe evidence manifest identity differs");
            io.parseProbeEvidence(manifestRead.bytes, input.probeArtifact);
            const files = input.probeArtifact.files.map(file => {
                const observed = io.inspectOwned(`${input.paths.probeRoot}/${file.name}`);
                return {bytes: String(observed.bytes), name: file.name, path: observed.path,
                    role: file.role, sha256: observed.sha256};
            });
            return {archive: {bytes: String(archive.bytes), sha256: archive.sha256},
                innerManifest: {name: "result.json", bytes: String(innerManifest.bytes), sha256: innerManifest.sha256},
                files};
        },
        async acquireWindowsIso(input) {
            const request = {url: STAGE2_PROVENANCE.windowsIso.aliasUrl,
                finalUrl: STAGE2_PROVENANCE.windowsIso.finalUrl, path: input.paths.windowsIso,
                bytes: STAGE2_PROVENANCE.windowsIso.bytes, sha256: null,
                expectedEtag: STAGE2_PROVENANCE.windowsIso.strongEtag};
            const first = await io.downloadPinned(request);
            const second = io.inspectOwned(first.path);
            if (first.finalUrl !== request.finalUrl || first.etag !== request.expectedEtag || second.bytes !== first.bytes)
                throw new Error("Windows ISO response or reopened identity differs");
            return {finalUrl: first.finalUrl, bytes: first.bytes, etag: first.etag,
                observerA: {id: "streaming-download-sha256", sha256: first.sha256},
                observerB: {id: "independent-reopen-sha256", sha256: second.sha256}};
        },
        async extractInstallWim(input) {
            const invocation = portableInvocation(input.toolchain, input.toolchain.sevenZip,
                ["e", "-y", `-o${path.posix.dirname(input.paths.installWim)}`, input.paths.windowsIso,
                    "sources/install.wim"]);
            const observation = assertSuccessful(await io.runOwned(invocation.command, invocation.argv,
                {timeoutMs: WIM_EXTRACTION_TIMEOUT_MILLISECONDS}), "install WIM extraction");
            void observation;
            const identity = io.inspectOwned(input.paths.installWim);
            return {path: identity.path, bytes: String(identity.bytes), sha256: identity.sha256,
                sourceIsoSha256: input.iso.sha256};
        },
        async inspectInstallWim(input) {
            const invocation = portableInvocation(input.toolchain, input.toolchain.wiminfo, [input.paths.installWim]);
            let result;
            let failure = null;
            try {
                const observation = assertSuccessful(await io.runOwned(invocation.command, invocation.argv,
                    {timeoutMs: COMMAND_TIMEOUT_MILLISECONDS, maxStreamBytes: MAX_WIMINFO_BYTES}),
                "WIM metadata inspection");
                result = parseWimInfo(observation.stdout);
            } catch (error) { failure = error; }
            try {
                io.removeOwned(input.paths.installWim);
                if (io.pathExists(input.paths.installWim)) throw new Error("install WIM remained after removal");
            } catch (error) {
                const cleanupMessage = error instanceof Error ? error.message : String(error);
                if (failure) throw new Error(`${failure.message}; install WIM cleanup failed: ${cleanupMessage}`);
                throw new Error(`install WIM cleanup failed: ${cleanupMessage}`);
            }
            if (failure) throw failure;
            return {images: result, removal: {path: input.installWim.path, sha256: input.installWim.sha256,
                removed: true}};
        },
        async prepareOfflineMedia(input) {
            const winpeDiagnostic = validateWinpeDiagnosticAuthorization(input.winpeDiagnostic);
            if (winpeDiagnostic !== undefined && winpeDiagnostic.nonce !== context.nonce)
                throw new TypeError("WinPE diagnostic media authorization is not bound to this run");
            const seedRoot = directChild(input.paths.root, `${input.paths.root}/seed-files`, "seed-files");
            io.mkdirExclusive(seedRoot);
            for (const file of input.seedSpec.files) {
                const target = directChild(seedRoot, `${seedRoot}/${file.name}`, file.name);
                if (INLINE_SEED_KINDS.has(file.kind)) {
                    const bytes = Buffer.from(file.bytesBase64, "base64");
                    if (String(bytes.length) !== file.bytes || sha256(bytes) !== file.sha256)
                        throw new Error("inline seed file identity is invalid");
                    io.writeExclusive(target, bytes);
                } else if (file.kind === "owned-file") {
                    if (!file.sourcePath.startsWith(`${input.paths.probeRoot}/`))
                        throw new Error("probe seed source is invalid");
                    io.copyExclusive(file.sourcePath, target);
                    const copied = io.inspectOwned(target);
                    if (copied.bytes !== file.bytes || copied.sha256 !== file.sha256)
                        throw new Error("copied probe identity is invalid");
                } else throw new Error("seed file kind is invalid");
            }
            let invocation = portableInvocation(input.toolchain, input.toolchain.genisoimage,
                ["-quiet", "-J", "-r", "-V", "MYSPEEDSEED", "-o", input.paths.seedIso, seedRoot]);
            assertSuccessful(await io.runOwned(invocation.command, invocation.argv,
                {timeoutMs: COMMAND_TIMEOUT_MILLISECONDS}), "seed ISO creation");
            const seedVerifyRoot = directChild(input.paths.root, `${input.paths.root}/seed-verify`, "seed-verify");
            if (io.pathExists(seedVerifyRoot)) throw new Error("seed verification root already exists");
            invocation = portableInvocation(input.toolchain, input.toolchain.sevenZip,
                ["x", "-y", `-o${seedVerifyRoot}`, input.paths.seedIso]);
            assertSuccessful(await io.runOwned(invocation.command, invocation.argv,
                {timeoutMs: COMMAND_TIMEOUT_MILLISECONDS}), "seed ISO verification extraction");
            for (const file of input.seedSpec.files) {
                const verified = io.inspectOwned(directChild(seedVerifyRoot, `${seedVerifyRoot}/${file.name}`, file.name));
                if (verified.bytes !== file.bytes || verified.sha256 !== file.sha256)
                    throw new Error("seed ISO extracted file identity differs");
            }
            io.makeSizedFile(input.paths.outputDisk, 67_108_864n);
            invocation = portableInvocation(input.toolchain, input.toolchain.mformat,
                ["-i", input.paths.outputDisk, "-v", "MYSPEEDOUT", "::"]);
            assertSuccessful(await io.runOwned(invocation.command, invocation.argv,
                {timeoutMs: COMMAND_TIMEOUT_MILLISECONDS}), "guest output FAT creation");
            if (winpeDiagnostic !== undefined) {
                const marker = Buffer.from(`${winpeDiagnosticOutputMarker(winpeDiagnostic.nonce)}\r\n`, "ascii");
                const markerPath = directChild(input.paths.root,
                    `${input.paths.root}/winpe-output-marker`, "winpe-output-marker");
                io.writeExclusive(markerPath, marker);
                invocation = portableInvocation(input.toolchain, input.toolchain.mcopy,
                    ["-i", input.paths.outputDisk, markerPath, `::${WINPE_DIAGNOSTIC_OUTPUT_MARKER_NAME}`]);
                assertSuccessful(await io.runOwned(invocation.command, invocation.argv,
                    {timeoutMs: COMMAND_TIMEOUT_MILLISECONDS}), "WinPE output marker creation");
                invocation = portableInvocation(input.toolchain, input.toolchain.mcopy,
                    ["-i", input.paths.outputDisk, `::${WINPE_DIAGNOSTIC_OUTPUT_MARKER_NAME}`, "-"]);
                const verified = assertSuccessful(await io.runOwned(invocation.command, invocation.argv,
                    {timeoutMs: COMMAND_TIMEOUT_MILLISECONDS, maxStreamBytes: marker.length}),
                "WinPE output marker verification");
                if (!verified.stdout.equals(marker) || verified.stderr.length !== 0)
                    throw new Error("WinPE output marker identity differs");
            }
            invocation = portableInvocation(input.toolchain, input.toolchain.qemuImg,
                ["create", "-f", "qcow2", input.paths.systemDisk, "48G"]);
            assertSuccessful(await io.runOwned(invocation.command, invocation.argv,
                {timeoutMs: COMMAND_TIMEOUT_MILLISECONDS}), "guest system disk creation");
            invocation = portableInvocation(input.toolchain, input.toolchain.qemuImg,
                ["info", "--output=json", input.paths.systemDisk]);
            const diskInfoObservation = assertSuccessful(await io.runOwned(invocation.command, invocation.argv,
                {timeoutMs: COMMAND_TIMEOUT_MILLISECONDS}), "guest system disk inspection");
            const diskInfo = parseJson(diskInfoObservation.stdout, "guest system disk metadata");
            if (!diskInfo || typeof diskInfo !== "object" || Array.isArray(diskInfo) || diskInfo.format !== "qcow2" ||
                diskInfo["virtual-size"] !== 51_539_607_552) throw new Error("guest system disk metadata differs");
            io.copyExclusive(input.toolchain.ovmfVarsTemplate.path, input.paths.ovmfVars);
            const seed = io.inspectOwned(input.paths.seedIso);
            const output = io.inspectOwned(input.paths.outputDisk);
            const system = io.inspectOwned(input.paths.systemDisk);
            const variables = io.inspectOwned(input.paths.ovmfVars);
            return {seedIso: {path: seed.path, bytes: seed.bytes, sha256: seed.sha256, format: "iso9660",
                volumeLabel: "MYSPEEDSEED", sourceManifestSha256: input.seedSpec.sha256},
            outputDisk: {path: output.path, bytes: output.bytes, sha256: output.sha256, format: "raw-fat",
                volumeLabel: "MYSPEEDOUT"}, systemDisk: {path: system.path, bytes: system.bytes,
                sha256: system.sha256, virtualBytes: "51539607552", format: "qcow2"},
            ovmfVars: {path: variables.path, sha256: variables.sha256}};
        },
        async launchOwnedQemu(input) {
            const taskOwner = typeof process.getuid === "function" ?
                {uid: BigInt(process.getuid()), gid: typeof process.getgid === "function" ? BigInt(process.getgid()) : null} : null;
            let preLaunchDiskIdentity = null;
            try {
                preLaunchDiskIdentity = io.validateOutputDisk(input.paths.outputDisk, null, taskOwner);
            } catch {
                preLaunchDiskIdentity = null;
            }
            const monitoredLaunch = await launchHostedQemuProcess(io, stageStartedMilliseconds, input);
            const launched = monitoredLaunch.result;
            /*
             * A WinPE diagnostic run collects instead of parsing a guest receipt: the guest it was
             * launched for is Windows Setup, which produces none. Nothing here can make the launch
             * acceptable - the record it returns is diagnostic evidence and is rejected by every
             * calibration consumer.
             */
            if (input.winpeDiagnostic !== undefined) {
                const budget = createWinpeDiagnosticCollectionBudget(
                    input.winpeDiagnosticCollectionDeadlineMilliseconds ??
                        io.monotonicMilliseconds() + WINPE_DIAGNOSTIC_COLLECTION_RESERVE_MILLISECONDS,
                    () => io.monotonicMilliseconds());
                const collection = await collectWinpeDiagnostic(io, context,
                    {...input, preLaunchDiskIdentity}, launched, budget);
                return {...launched, guest: null, winpeDiagnostic: Object.freeze({schemaVersion: 1,
                    kind: "winpe-answer-file-diagnostic", nonce: context.nonce,
                    confirmation: input.winpeDiagnostic.confirmation,
                    input: monitoredLaunch.winpeDiagnosticInput, collection})};
            }
            if (!monitoredLaunch.guestParsingAllowed) {
                const {diagnostic: receiptDiagnostic, guestFailure} =
                    await collectGuestReceiptDiagnostic(io, input, context, launched, taskOwner,
                        preLaunchDiskIdentity);
                const predeadlineDiagnostic = collectPredeadlineFrameDiagnostic(
                    io, input, monitoredLaunch.predeadline, monitoredLaunch.cleanupProven);
                const failureDiagnostic = launched.failureDiagnostic ?
                    {
                        ...launched.failureDiagnostic,
                        receipt: receiptDiagnostic,
                        ...(predeadlineDiagnostic !== null ? {predeadlineFrame: predeadlineDiagnostic} : {})
                    } : undefined;
                return {
                    ...launched,
                    ...(failureDiagnostic !== undefined ? {failureDiagnostic} : {}),
                    guest: null,
                    ...(guestFailure !== null ? {guestFailure} : {})
                };
            }
            const guestResult = directChild(input.paths.root, `${input.paths.root}/guest-result.json`,
                "guest-result.json");
            try {
                const extractResult = portableInvocation(input.toolchain, input.toolchain.mcopy,
                    ["-i", input.paths.outputDisk, "::result.json", guestResult]);
                assertSuccessful(await io.runOwned(extractResult.command, extractResult.argv,
                    {timeoutMs: COMMAND_TIMEOUT_MILLISECONDS}), "guest result extraction");
                const guestRead = io.readOwnedVerified(guestResult, MAX_GUEST_BYTES);
                const parsed = parseGuestOutcome(guestRead.bytes, context.nonce);
                if (parsed.status === "failed") return {...launched, guest: parsed, guestFailure: parsed};
                const output = io.inspectOwned(input.paths.outputDisk);
                return {...launched,
                    guest: {schemaVersion: 1, status: "observed", cpu: {...parsed.cpu, xcr0: null},
                    instructions: parsed.instructions, network: parsed.network, activation: parsed.activation,
                    systemTools: parsed.systemTools,
                    output: {path: output.path, bytes: output.bytes, sha256: output.sha256}}};
            } catch {
                // A failed primary publication must not erase the guest's bounded
                // secondary failure receipt. This path can never produce success.
                try {
                    const fallback = directChild(input.paths.root,
                        `${input.paths.root}/${GUEST_FAILURE_FALLBACK_NAME}`, GUEST_FAILURE_FALLBACK_NAME);
                    const extractFailure = portableInvocation(input.toolchain, input.toolchain.mcopy,
                        ["-i", input.paths.outputDisk, `::${GUEST_FAILURE_FALLBACK_NAME}`, fallback]);
                    assertSuccessful(await io.runOwned(extractFailure.command, extractFailure.argv,
                        {timeoutMs: COMMAND_TIMEOUT_MILLISECONDS}), "guest fallback failure extraction");
                    const read = io.readOwnedVerified(fallback, MAX_GUEST_BYTES);
                    const fallbackFailure = parseGuestFailure(read.bytes, context.nonce);
                    return {...launched, guest: fallbackFailure, guestFailure: fallbackFailure};
                } catch { return {...launched, guest: null}; }
            }
        }
    });
}

export const HOSTED_STAGE2_NATIVE_CONSTANTS = Object.freeze({APT_GET, DPKG_DEB, GPGV, INSTALL, KILL, READLINK, STAT,
    SUDO, TIMEOUT, QEMU_TIMEOUT_SECONDS, QEMU_OUTER_TIMEOUT_MILLISECONDS, DIAGNOSTIC_EXECUTION_MINUTES,
    DIAGNOSTIC_CLEANUP_MINUTES, DIAGNOSTIC_TIMEOUT_SECONDS, DIAGNOSTIC_OUTER_TIMEOUT_MILLISECONDS,
    RESOURCE_POLL_MILLISECONDS,
    LOW_MEMORY_ABORT_MILLISECONDS, MINIMUM_RUNTIME_MEMORY_BYTES: MINIMUM_RUNTIME_MEMORY_BYTES.toString(),
    MINIMUM_FREE_DISK_BYTES: MINIMUM_FREE_DISK_BYTES.toString(), MAXIMUM_TASK_BYTES: MAXIMUM_TASK_BYTES.toString()});
