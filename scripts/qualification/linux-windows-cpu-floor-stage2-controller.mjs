import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {validateHostedContext} from "./linux-kvm-capability.mjs";
import {assessWindowsCpuFloorAdmission} from "./linux-windows-cpu-floor-admission.mjs";
import {runWindowsCpuFloorStage2, validateStage2Paths} from "./linux-windows-cpu-floor-stage2.mjs";
import {INSTALLER_BOOT_CONFIRMATION, INSTALLER_BOOT_CONFIRMATION_AFTER_FIRST_FRAME,
    INSTALLER_BOOT_CONFIRMATION_CADENCE,
    validateWinpeDiagnosticAuthorization} from "./linux-windows-cpu-floor-stage2-qmp.mjs";
import {WINPE_DIAGNOSTIC_RESERVATION_LABEL, admitWinpeDiagnosticReservation,
    collectHostedAdmissionObservations, createHostedCpuFloorCleanupOperations, createHostedStage2Operations} from
    "./linux-windows-cpu-floor-stage2-hosted.mjs";

const SCHEMA_VERSION = 1;
const MAX_REQUEST_BYTES = 262_144;
const MAX_EVIDENCE_BYTES = 4_194_304;
const MAX_KVM_BYTES = 262_144;
const MAX_PROBE_ARCHIVE_BYTES = 268_435_456;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CONFIRMATION = "RUN-CANDIDATE-NEUTRAL-STAGE2";
const CONTROLLER_STARTED_MARKER = "controller-started";
const LAUNCH_ATTEMPT_MARKER = "launch-attempted";
const CLEANUP_AUTHORITY_FILENAME = "cleanup-authority.json";
const HOSTED_TEMP_ROOT = "/home/runner/work/_temp";
const NONCE_PATTERN = /^[a-f0-9]{32}$/u;
const STAGE2_MODULE = "scripts/qualification/linux-windows-cpu-floor-stage2.mjs";

function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }

function assertKeys(value, keys, name) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort()))
        throw new TypeError(`${name} keys are invalid`);
}

function readVerified(target, maximumBytes) {
    const canonical = fs.realpathSync(target);
    const descriptor = fs.openSync(canonical, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const before = fs.fstatSync(descriptor);
        if (!before.isFile() || before.size < 1 || before.size > maximumBytes)
            throw new Error("verified input size is invalid");
        const bytes = Buffer.allocUnsafe(before.size);
        let offset = 0;
        while (offset < bytes.length) {
            const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
            if (count <= 0) throw new Error("verified input read was truncated");
            offset += count;
        }
        const after = fs.fstatSync(descriptor);
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs) throw new Error("verified input changed while reading");
        return {bytes, path: canonical, sha256: sha256(bytes)};
    } finally { fs.closeSync(descriptor); }
}

function verifyInput(record, maximumBytes, read) {
    assertKeys(record, ["bytes", "path", "sha256"], "input identity");
    if (!Number.isInteger(record.bytes) || record.bytes < 1 || record.bytes > maximumBytes ||
        typeof record.sha256 !== "string" || !SHA256_PATTERN.test(record.sha256))
        throw new TypeError("input identity is invalid");
    const observed = read(record.path, maximumBytes);
    if (observed.bytes.length !== record.bytes || observed.sha256 !== record.sha256)
        throw new Error("input identity differs");
    return observed;
}

function requireDirectInput(record, inputRoot, name) {
    assertKeys(record, ["bytes", "path", "sha256"], "staged input identity");
    if (record.path !== `${inputRoot}/${name}`) throw new TypeError("staged input path is invalid");
}

function lifecycleMarkerPath(root, marker) {
    if (typeof root !== "string" || !path.posix.isAbsolute(root) || path.posix.normalize(root) !== root)
        throw new TypeError("diagnostic cleanup root is invalid");
    return path.posix.join(root, marker);
}

function writeLifecycleMarker(root, marker) {
    fs.writeFileSync(lifecycleMarkerPath(root, marker), `${marker}\n`, {flag: "wx", mode: 0o600});
}

function defaultReadLifecycleMarker(target, marker) {
    let descriptor;
    try {
        descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const before = fs.fstatSync(descriptor, {bigint: true});
        if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.getuid?.() ?? -1) ||
            (before.mode & 0o077n) !== 0n || before.size !== BigInt(Buffer.byteLength(`${marker}\n`)))
            throw new TypeError("diagnostic lifecycle marker is unsafe");
        const bytes = Buffer.alloc(Number(before.size));
        if (fs.readSync(descriptor, bytes, 0, bytes.length, 0) !== bytes.length)
            throw new TypeError("diagnostic lifecycle marker was truncated");
        const after = fs.fstatSync(descriptor, {bigint: true});
        if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs ||
            !bytes.equals(Buffer.from(`${marker}\n`))) throw new TypeError("diagnostic lifecycle marker differs");
        return marker;
    } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
    } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function defaultPathExists(target) {
    try { fs.lstatSync(target); return true; }
    catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

function defaultReadRejectedBeforeLaunchResult(target, nonce) {
    let descriptor;
    try {
        descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const before = fs.fstatSync(descriptor, {bigint: true});
        if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.getuid?.() ?? -1) ||
            (before.mode & 0o077n) !== 0n || before.size < 3n || before.size > BigInt(MAX_EVIDENCE_BYTES))
            throw new TypeError("diagnostic result proof is unsafe");
        const bytes = Buffer.alloc(Number(before.size));
        if (fs.readSync(descriptor, bytes, 0, bytes.length, 0) !== bytes.length)
            throw new TypeError("diagnostic result proof was truncated");
        const after = fs.fstatSync(descriptor, {bigint: true});
        if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs)
            throw new TypeError("diagnostic result proof changed while reading");
        const value = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes));
        if (!bytes.equals(Buffer.from(`${JSON.stringify(value)}\n`))) return false;
        assertKeys(value, ["admission", "qualifying", "releaseGateCleared", "schemaVersion", "status"],
            "diagnostic no-launch result");
        const admission = value.admission;
        return value.schemaVersion === SCHEMA_VERSION && value.status === "rejected" && value.qualifying === false &&
            value.releaseGateCleared === false && admission?.schemaVersion === SCHEMA_VERSION &&
            admission.status === "rejected" && admission.admitted === false &&
            admission.qemuLaunchAuthorized === false && admission.context?.nonce === nonce;
    } catch (error) {
        if (error?.code === "ENOENT") return false;
        if (error instanceof SyntaxError) return false;
        throw error;
    } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

/*
 * The independent workflow cleanup has two safe success cases. An authenticated cleanup receipt
 * can prove a spawned QEMU process was gone; a sealed controller marker can prove that it never
 * reached the only call site capable of launching Stage 2. Missing state is deliberately neither.
 */
export async function verifyWinpeDiagnosticCleanup(pathsValue, dependencies = {}) {
    assertKeys(pathsValue, ["controllerResult", "nonce", "qemuPid", "root"], "diagnostic cleanup paths");
    const root = pathsValue.root;
    if (typeof pathsValue.nonce !== "string" || !NONCE_PATTERN.test(pathsValue.nonce) ||
        root !== `${HOSTED_TEMP_ROOT}/myspeed-windows-cpu-floor-${pathsValue.nonce}` ||
        pathsValue.controllerResult !== `${HOSTED_TEMP_ROOT}/myspeed-winpe-diagnostic-transport-${pathsValue.nonce}/diagnostic-result.json`)
        throw new TypeError("diagnostic cleanup paths are invalid");
    const startedPath = lifecycleMarkerPath(root, CONTROLLER_STARTED_MARKER);
    const attemptedPath = lifecycleMarkerPath(root, LAUNCH_ATTEMPT_MARKER);
    const receiptPath = path.posix.join(root, CLEANUP_AUTHORITY_FILENAME);
    const expectedPidPath = path.posix.join(root, "qemu.pid");
    if (pathsValue.qemuPid !== expectedPidPath)
        throw new TypeError("diagnostic cleanup paths are invalid");
    const pathExists = dependencies.pathExists ?? defaultPathExists;
    const readLifecycleMarker = dependencies.readLifecycleMarker ?? defaultReadLifecycleMarker;
    const started = readLifecycleMarker(startedPath, CONTROLLER_STARTED_MARKER) === CONTROLLER_STARTED_MARKER;
    const attempted = readLifecycleMarker(attemptedPath, LAUNCH_ATTEMPT_MARKER) === LAUNCH_ATTEMPT_MARKER;
    const receiptExists = pathExists(receiptPath);
    const pidExists = pathExists(pathsValue.qemuPid);
    if (!receiptExists) {
        if (started && !attempted && !pidExists)
            return Object.freeze({cleanupProven: true, status: "known-no-launch"});
        if (!started && !attempted && !pidExists &&
            (dependencies.readRejectedBeforeLaunchResult ?? defaultReadRejectedBeforeLaunchResult)(
                pathsValue.controllerResult, pathsValue.nonce) === true)
            return Object.freeze({cleanupProven: true, status: "known-no-launch"});
        if (attempted || pidExists) throw new Error("QEMU cleanup authority is absent after a possible launch");
        throw new Error("QEMU cleanup no-launch proof is absent");
    }
    const cleanupModule = await import("./linux-windows-cpu-floor-stage3-cleanup.mjs");
    const receipt = (dependencies.readCleanupAuthorityReceipt ?? cleanupModule.readCpuFloorCleanupAuthorityReceipt)(receiptPath);
    if (!Array.isArray(receipt.authorities) || receipt.authorities.length < 1)
        throw new Error("QEMU cleanup authority is empty");
    const proof = await (dependencies.cleanupTaskOwnedCpuProcesses ?? cleanupModule.cleanupTaskOwnedCpuProcesses)({
        authorities: receipt.authorities,
        deadlineMilliseconds: cleanupModule.CPU_FLOOR_CLEANUP_CONSTANTS.DEFAULT_CLEANUP_MILLISECONDS
    }, dependencies.cleanupOperations ?? createHostedCpuFloorCleanupOperations());
    if (proof.cleanupProven !== true) throw new Error("QEMU cleanup was not proven");
    return proof;
}

function validateRequest(request) {
    const requestKeys = ["authorization", "closure", "context", "kvm", "paths", "probeArtifact", "probeStage",
        "schemaVersion"];
    /*
     * The diagnostic budget travels with the request that authorizes the diagnostic and only with
     * it: an ordinary calibration request that carried one would be refused by the exact-key check
     * below, and a diagnostic request without one has nothing to convert into a reservation.
     */
    const diagnosticAuthorized = Object.hasOwn(request?.authorization ?? {}, "winpeDiagnostic");
    if (diagnosticAuthorized) requestKeys.push("winpeDiagnosticBudget");
    assertKeys(request, requestKeys, "Stage 2 controller request");
    if (request.schemaVersion !== SCHEMA_VERSION) throw new TypeError("request schema is invalid");
    const context = validateHostedContext(request.context);
    request.paths = validateStage2Paths(request.paths, context);
    const authorizationKeys = ["confirmation", "media", "qemu", "scope"];
    if (Object.hasOwn(request.authorization ?? {}, "bootConfirmation")) {
        authorizationKeys.push("bootConfirmation");
        if (![INSTALLER_BOOT_CONFIRMATION, INSTALLER_BOOT_CONFIRMATION_AFTER_FIRST_FRAME,
            INSTALLER_BOOT_CONFIRMATION_CADENCE].includes(request.authorization.bootConfirmation))
            throw new TypeError("Stage 2 boot confirmation is not authorized");
    }
    if (diagnosticAuthorized) {
        authorizationKeys.push("winpeDiagnostic");
        const diagnostic = validateWinpeDiagnosticAuthorization(request.authorization.winpeDiagnostic);
        if (diagnostic === undefined || diagnostic.nonce !== context.nonce)
            throw new TypeError("Stage 2 WinPE diagnostic is not authorized");
        assertKeys(request.winpeDiagnosticBudget, ["label", "wallDeadlineUnixMilliseconds"],
            "Stage 2 WinPE diagnostic budget");
        if (request.winpeDiagnosticBudget.label !== WINPE_DIAGNOSTIC_RESERVATION_LABEL ||
            !Number.isSafeInteger(request.winpeDiagnosticBudget.wallDeadlineUnixMilliseconds) ||
            request.winpeDiagnosticBudget.wallDeadlineUnixMilliseconds < 1)
            throw new TypeError("Stage 2 WinPE diagnostic budget is invalid");
    }
    /*
     * Positive opt-in only, next to the boot-confirmation opt-in above: absence means disabled, and
     * only the literal `true` is ever accepted - a truthy non-boolean is refused rather than treated
     * as an implicit mode. It cannot combine with a WinPE diagnostic authorization, which runs its own
     * reservation-bound session and never the fixed 25/5 diagnostic deadlines this field is scoped to.
     */
    const midWindowFramesRequested = Object.hasOwn(request.authorization ?? {}, "midWindowFrames");
    if (midWindowFramesRequested) {
        authorizationKeys.push("midWindowFrames");
        if (request.authorization.midWindowFrames !== true)
            throw new TypeError("Stage 2 mid-window frames flag is invalid");
        if (diagnosticAuthorized)
            throw new TypeError("Stage 2 mid-window frames cannot combine with a WinPE diagnostic authorization");
    }
    assertKeys(request.authorization, authorizationKeys, "Stage 2 authorization");
    if (request.authorization.confirmation !== CONFIRMATION || request.authorization.media !== true ||
        request.authorization.qemu !== true || request.authorization.scope !== "candidate-neutral-cpu-calibration")
        throw new TypeError("Stage 2 execution is not authorized");
    assertKeys(request.kvm, ["combined", "ordinary"], "Stage 2 KVM inputs");
    assertKeys(request.probeStage, ["archive", "files", "result"], "probe staging");
    if (!Array.isArray(request.probeStage.files) || request.probeStage.files.length !== 8)
        throw new TypeError("probe staging file set is invalid");
    assertKeys(request.probeArtifact, ["archive", "artifactId", "artifactName", "files", "innerManifest",
        "repository", "runAttempt", "runId", "schemaVersion", "sourceSha"], "probe artifact");
    if (request.probeArtifact.schemaVersion !== SCHEMA_VERSION ||
        request.probeArtifact.repository !== context.repository ||
        request.probeArtifact.artifactName !== "windows-cpu-readiness-evidence" ||
        !Array.isArray(request.probeArtifact.files) || request.probeArtifact.files.length !== 8)
        throw new TypeError("probe artifact binding is invalid");
    assertKeys(request.closure, ["files", "root"], "Stage 2 closure");
    const closureRoot = `/home/runner/work/_temp/myspeed-stage2-closure-${context.nonce}`;
    const baseClosureNames = ["scripts/qualification/linux-windows-cpu-floor-admission.mjs",
        "scripts/qualification/linux-windows-cpu-floor-stage2-controller.mjs",
        "scripts/qualification/linux-windows-cpu-floor-stage2-hosted.mjs",
        "scripts/qualification/linux-windows-cpu-floor-stage2-qmp.mjs",
        STAGE2_MODULE,
        "scripts/qualification/linux-kvm-capability.mjs",
        "scripts/qualification/linux-kvm-privileged-capability.mjs",
        "scripts/qualification/windows-msi-post-setup-activation.mjs"];
    const stage2ModuleIndex = baseClosureNames.indexOf(STAGE2_MODULE);
    if (stage2ModuleIndex < 0) throw new Error("Stage 2 closure member is absent");
    const diagnosticClosureNames = [...baseClosureNames.slice(0, stage2ModuleIndex + 1),
        "scripts/qualification/linux-windows-cpu-floor-stage3-cleanup.mjs",
        ...baseClosureNames.slice(stage2ModuleIndex + 1)];
    const closureNames = request.closure?.files?.length === diagnosticClosureNames.length
        ? diagnosticClosureNames
        : baseClosureNames;
    if (request.closure.root !== closureRoot || !Array.isArray(request.closure.files) ||
        request.closure.files.length !== closureNames.length) throw new TypeError("Stage 2 closure is invalid");
    for (const [index, name] of closureNames.entries()) {
        const record = request.closure.files[index];
        if (record?.path !== `${closureRoot}/${name}`) throw new TypeError("Stage 2 closure member path is invalid");
    }
    const inputRoot = `/home/runner/work/_temp/myspeed-stage2-input-${context.nonce}`;
    requireDirectInput(request.kvm.ordinary, inputRoot, "ordinary.json");
    requireDirectInput(request.kvm.combined, inputRoot, "combined.json");
    requireDirectInput(request.probeStage.archive, inputRoot, "artifact.zip");
    requireDirectInput(request.probeStage.result, inputRoot, "result.json");
    const stagedPairs = [[request.probeStage.archive, request.probeArtifact.archive, "artifact.zip"],
        [request.probeStage.result, request.probeArtifact.innerManifest, "result.json"]];
    for (const [staged, expected, expectedName] of stagedPairs) {
        if (path.posix.basename(staged.path) !== expectedName || String(staged.bytes) !== expected.bytes ||
            staged.sha256 !== expected.sha256) throw new TypeError("probe staging identity differs");
    }
    const expectedFiles = new Map(request.probeArtifact.files.map(file => [file.name, file]));
    if (expectedFiles.size !== 8) throw new TypeError("probe artifact file set is invalid");
    const stagedNames = new Set();
    for (const staged of request.probeStage.files) {
        const name = path.posix.basename(staged.path);
        requireDirectInput(staged, inputRoot, name);
        const expected = expectedFiles.get(name);
        if (!expected || stagedNames.has(name) || String(staged.bytes) !== expected.bytes ||
            staged.sha256 !== expected.sha256)
            throw new TypeError("probe staging file identity differs");
        stagedNames.add(name);
    }
    return {context, request: structuredClone(request)};
}

export function deriveActualHostedContext(expectedNonce, environment = process.env,
    runtime = {platform: process.platform, architecture: process.arch}) {
    if (runtime.platform !== "linux" || runtime.architecture !== "x64" || environment.GITHUB_ACTIONS !== "true" ||
        environment.CI !== "true" || environment.RUNNER_OS !== "Linux" || environment.RUNNER_ARCH !== "X64" ||
        environment.RUNNER_ENVIRONMENT !== "github-hosted") throw new Error("actual hosted runtime is invalid");
    const context = {schemaVersion: SCHEMA_VERSION, repository: environment.GITHUB_REPOSITORY,
        sourceSha: environment.MYSPEED_SOURCE_SHA, eventSha: environment.GITHUB_SHA, runId: environment.GITHUB_RUN_ID,
        runAttempt: environment.GITHUB_RUN_ATTEMPT, nonce: expectedNonce, environment: {
            GITHUB_ACTIONS: environment.GITHUB_ACTIONS, CI: environment.CI, RUNNER_OS: environment.RUNNER_OS,
            RUNNER_ARCH: environment.RUNNER_ARCH, RUNNER_ENVIRONMENT: environment.RUNNER_ENVIRONMENT,
            ImageOS: environment.ImageOS, ImageVersion: environment.ImageVersion}};
    return validateHostedContext(context);
}

export async function runHostedStage2Controller(requestValue, dependencies = {}) {
    const {context, request} = validateRequest(requestValue);
    const read = dependencies.readVerified ?? readVerified;
    for (const member of request.closure.files) verifyInput(member, MAX_EVIDENCE_BYTES, read);
    const ordinary = verifyInput(request.kvm.ordinary, MAX_KVM_BYTES, read);
    const combined = verifyInput(request.kvm.combined, MAX_KVM_BYTES, read);
    const collect = dependencies.collectAdmission ?? collectHostedAdmissionObservations;
    const observations = await collect({context, paths: request.paths, dependencies: dependencies.native});
    const admission = assessWindowsCpuFloorAdmission({context, observations,
        kvmEvidence: {ordinaryBytes: ordinary.bytes, combinedBytes: combined.bytes}});
    if (!admission.admitted) return {schemaVersion: SCHEMA_VERSION, status: "rejected", admission,
        qualifying: false, releaseGateCleared: false};
    const mkdir = dependencies.mkdirExclusive ?? (target => fs.mkdirSync(target, {recursive: false, mode: 0o700}));
    const copy = dependencies.copyExclusive ?? ((source, target) =>
        fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL));
    mkdir(request.paths.root);
    mkdir(request.paths.probeRoot);
    if (request.authorization.winpeDiagnostic !== undefined)
        (dependencies.markControllerStarted ?? (target => writeLifecycleMarker(target, CONTROLLER_STARTED_MARKER)))(request.paths.root);
    const staged = [request.probeStage.archive, request.probeStage.result, ...request.probeStage.files];
    for (const record of staged) {
        const maximumBytes = record === request.probeStage.archive ? MAX_PROBE_ARCHIVE_BYTES : MAX_EVIDENCE_BYTES;
        const observed = verifyInput(record, maximumBytes, read);
        const name = path.posix.basename(record.path);
        const target = `${request.paths.probeRoot}/${name}`;
        copy(observed.path, target);
        const copied = read(target, maximumBytes);
        if (copied.sha256 !== observed.sha256 || copied.bytes.length !== observed.bytes.length)
            throw new Error("copied probe evidence differs");
    }
    const operations = dependencies.operations ?? createHostedStage2Operations({context, paths: request.paths,
        dependencies: dependencies.native});
    const run = dependencies.runStage2 ?? runWindowsCpuFloorStage2;
    /*
     * The wall deadline travels down as a function, not as a fixed reservation. It is evaluated
     * twice against the same anchored deadline: once here, before any expensive setup, so a job
     * that already cannot hold a guest refuses before it downloads eight gigabytes; and again
     * immediately before the launch, so the preparation and the downloads that just happened are
     * charged to the guest's allowance rather than assumed free. A refusal at either point leaves
     * the guest unlaunched.
     */
    const diagnostic = request.authorization.winpeDiagnostic === undefined ? {} : (() => {
        const unixMilliseconds = dependencies.unixMilliseconds ?? Date.now;
        const monotonicMilliseconds = dependencies.monotonicMilliseconds ??
            (() => Number(process.hrtime.bigint() / 1_000_000n));
        const admit = () => admitWinpeDiagnosticReservation(request.winpeDiagnosticBudget,
            unixMilliseconds, monotonicMilliseconds);
        admit();
        return {winpeDiagnostic: request.authorization.winpeDiagnostic, admitWinpeDiagnostic: admit};
    })();
    if (request.authorization.winpeDiagnostic !== undefined)
        (dependencies.markLaunchAttempt ?? (target => writeLifecycleMarker(target, LAUNCH_ATTEMPT_MARKER)))(request.paths.root);
    return await run({context, admission, paths: request.paths, probeArtifact: request.probeArtifact,
        ...(request.authorization.bootConfirmation === undefined ? {} :
            {bootConfirmation: request.authorization.bootConfirmation}),
        ...(request.authorization.midWindowFrames === true ? {midWindowFrames: true} : {}),
        ...diagnostic}, operations);
}

function writeExclusive(target, value) {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    if (bytes.length < 3 || bytes.length > MAX_EVIDENCE_BYTES) throw new Error("controller result size is invalid");
    fs.writeFileSync(target, bytes, {flag: "wx", mode: 0o600});
}

function parseArguments(argv) {
    if (argv.length !== 5 || argv[0] !== "run" || argv[1] !== "--request" || argv[3] !== "--result")
        throw new TypeError("arguments are invalid");
    return {request: argv[2], result: argv[4]};
}

async function main() {
    if (process.platform !== "linux" || process.arch !== "x64" || process.env.GITHUB_ACTIONS !== "true" ||
        process.env.RUNNER_ENVIRONMENT !== "github-hosted") throw new Error("actual hosted runtime is invalid");
    const options = parseArguments(process.argv.slice(2));
    const requestRead = readVerified(options.request, MAX_REQUEST_BYTES);
    const request = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(requestRead.bytes));
    const actualContext = deriveActualHostedContext(request?.context?.nonce);
    if (JSON.stringify(actualContext) !== JSON.stringify(request.context))
        throw new Error("actual hosted context differs from request");
    const result = await runHostedStage2Controller(request);
    writeExclusive(options.result, result);
    /*
     * A diagnostic record is a completed run of a different kind, not a failed calibration: the
     * workflow decides what it means from the record, and an exit code cannot say "collected
     * bounded evidence, drew no conclusion".
     */
    if (result.status !== "observed" && result.status !== "diagnostic") process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1; });
}

export const STAGE2_CONTROLLER_CONSTANTS = Object.freeze({CONFIRMATION, MAX_EVIDENCE_BYTES, MAX_REQUEST_BYTES});
