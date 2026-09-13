#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {collectSummary as collectQualificationSummary} from "./collect-summary.mjs";
import {
    assertHostedMacEnvironment,
    buildSandboxProfile,
    runMacosIsolationCanary,
    validateProbeResult
} from "./macos-isolation.mjs";

const SCHEMA_VERSION = 1;
const SANDBOX_EXECUTABLE = "/usr/bin/sandbox-exec";
const SOURCE_PARAMETER = "SOURCE_ROOT";
const VERIFIER_PARAMETER = "VERIFIER_ROOT";
const SOURCE_SENTINEL = "package.json";
const TASK_PREFIX = "myspeed-macos-standalone-";
const RUNTIME_DIRECTORY = "runtime";
const POPULATED_DIRECTORY = "populated";
const RESET_DIRECTORY = "reset";
const CHECKER_EVIDENCE_DIRECTORY = "checker-evidence";
const QUALIFICATION_EVIDENCE_DIRECTORY = "qualification-evidence";
const HANDOFF_FILE = "fixture-handoff.json";
const SEED_PROFILE_FILE = "macos-seed-profile.sb";
const CANARY_SOURCE_PROFILE_FILE = "macos-isolation.sb";
const CANARY_SOURCE_RECORD_FILE = "macos-isolation.json";
const CANARY_PROFILE_FILE = "macos-canary-profile.sb";
const CANARY_RECORD_FILE = "macos-canary.json";
const RUNTIME_PROFILE_FILE = "macos-runtime-profile.sb";
const RUNTIME_RECORD_FILE = "macos-runtime-isolation.json";
const SUMMARY_FILE = "qualification-summary.json";
const FAILURE_FILE = "macos-wrapper-failure.json";
const OWNERSHIP_FILE = ".myspeed-macos-standalone.json";
const NONCE_HEX_LENGTH = 48;
const FILE_MODE = 0o400;
const EXECUTABLE_MODE = 0o500;
const DIRECTORY_MODE = 0o700;
const READONLY_DIRECTORY_MODE = 0o500;
const PROCESS_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_FAILURE_TEXT_BYTES = 16 * 1024;
const MAX_FAILURE_LOG_BYTES = 8 * 1024;
const MAX_OWNERSHIP_FILE_BYTES = 4 * 1024;
const MAX_DIAGNOSTIC_DIRECTORY_ENTRIES = 64;
const FAILURE_DIAGNOSTICS_TRUST = "untrusted-failure-only";
const FAILURE_RAW_DIRECTORY_PATTERN = /^myspeed-evidence-[A-Za-z0-9]{6}$/;
const FAILURE_LOG_FILES = ["summary.json", "artifact.stdout.log", "artifact.stderr.log", "fixture.log"];
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const REPOSITORY_PATTERN = /^[^/\s]+\/[^/\s]+$/;
const ALLOWED_DENIAL_CODES = new Set(["EACCES", "EPERM"]);
const DENIAL_KEYS = ["tcp4", "tcp6", "udp4", "udp6"];
const ARCHITECTURE_ARTIFACTS = new Map([
    ["x64", "MySpeed-macos-x64"],
    ["arm64", "MySpeed-macos-arm64"]
]);
const VERIFIER_FILES = [
    "check-artifact.mjs",
    "fixture.mjs",
    "macos-isolation.mjs",
    "safety.mjs",
    "sqlite-check.mjs"
];
const failureDetails = new WeakMap();
const SAFE_ENVIRONMENT_KEYS = ["PATH", "LANG", "LC_ALL", "TZ"];
const REQUIRED_OPTIONS = [
    "artifact", "artifactSha256", "repo", "evidenceDir", "sourceSha", "expectedArch",
    "runId", "runAttempt", "repository"
];
const OPTION_KEYS = new Map([
    ["artifact", "artifact"],
    ["artifact-sha256", "artifactSha256"],
    ["repo", "repo"],
    ["evidence-dir", "evidenceDir"],
    ["source-sha", "sourceSha"],
    ["expected-arch", "expectedArch"],
    ["run-id", "runId"],
    ["run-attempt", "runAttempt"],
    ["repository", "repository"]
]);

const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const sha256File = file => sha256(fs.readFileSync(file));

export const buildMacosSeedProfile = () => `(version 1)
(allow default)
(deny network*)
`;

export const buildMacosRuntimeProfile = () => `${buildSandboxProfile()}(deny file-write*
    (literal (param "${VERIFIER_PARAMETER}"))
    (subpath (param "${VERIFIER_PARAMETER}")))
`;

export const parseArguments = values => {
    const options = {};
    for (let index = 0; index < values.length; index += 2) {
        const name = values[index];
        const value = values[index + 1];
        if (!name?.startsWith("--") || value === undefined) throw new Error(`Invalid argument ${name ?? ""}`);
        const key = OPTION_KEYS.get(name.slice(2));
        if (!key) throw new Error(`Unknown argument ${name}`);
        if (Object.hasOwn(options, key)) throw new Error(`Duplicate argument ${name}`);
        options[key] = value;
    }
    for (const key of REQUIRED_OPTIONS)
        if (!options[key]) throw new Error(`Missing --${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`);
    for (const key of ["runId", "runAttempt"]) {
        if (!/^\d+$/.test(options[key])) throw new Error(`${key} must be a positive integer`);
        options[key] = Number(options[key]);
        if (!Number.isSafeInteger(options[key]) || options[key] <= 0)
            throw new Error(`${key} must be a positive safe integer`);
    }
    return options;
};

const assertSha256 = (value, label) => {
    if (!SHA256_PATTERN.test(value ?? "")) throw new Error(`${label} must be a lowercase SHA-256 digest`);
};

const assertPositiveInteger = (value, label) => {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
};

const validateDenialProbe = (probe, label) => {
    if (!probe || probe.inherited !== true || !probe.forbidden || typeof probe.forbidden !== "object")
        throw new Error(`${label} is malformed`);
    if (JSON.stringify(Object.keys(probe.forbidden).sort()) !== JSON.stringify([...DENIAL_KEYS].sort()))
        throw new Error(`${label} has an unexpected denial set`);
    for (const key of DENIAL_KEYS) {
        const result = probe.forbidden[key];
        if (result?.denied !== true || result.timedOut !== false || !ALLOWED_DENIAL_CODES.has(result.code))
            throw new Error(`${label} ${key} did not prove immediate policy denial`);
    }
    return probe;
};

const validateVerifierFiles = verifierFiles => {
    if (!verifierFiles || typeof verifierFiles !== "object" || Array.isArray(verifierFiles)
        || JSON.stringify(Object.keys(verifierFiles).sort()) !== JSON.stringify([...VERIFIER_FILES].sort()))
        throw new Error("Isolation record must bind the exact verifier file closure");
    for (const [file, digest] of Object.entries(verifierFiles)) assertSha256(digest, `Verifier ${file}`);
};

export const createMacosRuntimeIsolationRecord = options => {
    if (!COMMIT_PATTERN.test(options.sourceSha ?? ""))
        throw new Error("Source SHA must be a lowercase 40-character commit SHA");
    for (const [label, digest] of Object.entries({
        "Artifact SHA-256": options.artifactSha256,
        "Summary SHA-256": options.summarySha256,
        "Runtime profile SHA-256": options.profileSha256,
        "Canary SHA-256": options.canarySha256,
        "Canary profile SHA-256": options.canaryProfileSha256,
        "Handoff SHA-256": options.handoffSha256,
        "Seed profile SHA-256": options.seed?.profileSha256
    })) assertSha256(digest, label);
    if (!ARCHITECTURE_ARTIFACTS.has(options.architecture)) throw new Error("Unsupported macOS architecture");
    assertPositiveInteger(options.runId, "Run ID");
    assertPositiveInteger(options.runAttempt, "Run attempt");
    if (!REPOSITORY_PATTERN.test(options.repository ?? "")) throw new Error("Repository identity is malformed");
    if (options.seed?.sandboxStatus !== 0 || options.seed?.sandboxSignal !== null)
        throw new Error("Seed sandbox did not exit cleanly");
    validateDenialProbe(options.seed?.probe, "Seed denial probe");
    validateDenialProbe(options.canaryHelper, "Canary helper probe");
    const artifactName = ARCHITECTURE_ARTIFACTS.get(options.architecture);
    if (options.candidateFile?.name !== artifactName
        || options.candidateFile?.sha256 !== options.artifactSha256)
        throw new Error("Candidate evidence identity is malformed");
    validateVerifierFiles(options.verifierFiles);
    return {
        schemaVersion: SCHEMA_VERSION,
        status: "passed",
        sourceSha: options.sourceSha,
        artifactSha256: options.artifactSha256,
        architecture: options.architecture,
        platform: "darwin",
        runId: options.runId,
        runAttempt: options.runAttempt,
        repository: options.repository,
        summarySha256: options.summarySha256,
        profileSha256: options.profileSha256,
        canarySha256: options.canarySha256,
        canaryProfileSha256: options.canaryProfileSha256,
        handoffSha256: options.handoffSha256,
        seed: options.seed,
        canaryHelper: options.canaryHelper,
        candidateFile: options.candidateFile,
        verifierFiles: options.verifierFiles
    };
};

const assertUnlinkedRegularFile = (file, label) => {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
        throw new Error(`${label} must be an unlinked regular file`);
    return info;
};

const assertCanonicalAbsolute = (value, label) => {
    if (!path.isAbsolute(value) || path.resolve(value) !== value) throw new Error(`${label} must be canonical absolute`);
};

const copyVerifiedFile = ({source, destination, label, mode}) => {
    assertUnlinkedRegularFile(source, label);
    const digest = sha256File(source);
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(destination, mode);
    assertUnlinkedRegularFile(destination, `Copied ${label}`);
    if (sha256File(destination) !== digest) throw new Error(`Copied ${label} hash changed`);
    return digest;
};

const safeEnvironment = (environment, taskRoot) => {
    const child = {HOME: taskRoot, TMPDIR: taskRoot};
    for (const key of SAFE_ENVIRONMENT_KEYS)
        if (typeof environment[key] === "string" && environment[key]) child[key] = environment[key];
    return child;
};

const spawnFailure = result => {
    if (result?.error) throw result.error;
    if (result?.status !== 0 || result?.signal)
        throw new Error(`sandbox-exec failed with ${result?.signal ?? result?.status}: ${result?.stderr ?? ""}`);
};

const spawnOptions = (cwd, environment) => ({
    cwd,
    env: environment,
    encoding: "utf8",
    timeout: PROCESS_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"]
});

const writeWithDigest = (file, bytes, mode = FILE_MODE) => {
    fs.writeFileSync(file, bytes, {flag: "wx", mode});
    const digest = sha256(bytes);
    fs.writeFileSync(`${file}.sha256`, `${digest}\n`, {flag: "wx", mode: FILE_MODE});
    return digest;
};

const parseLastJsonLine = (output, label) => {
    try {
        return JSON.parse(String(output).trim().split(/\r?\n/).at(-1));
    } catch (error) {
        throw new Error(`${label} did not emit valid JSON`, {cause: error});
    }
};

const validateCanary = ({canary, sourceRoot, sourceSentinel, architecture, profileSha256}) => {
    if (canary?.schemaVersion !== SCHEMA_VERSION || canary.status !== "passed"
        || canary.platform !== "darwin" || canary.architecture !== architecture
        || canary.sourceRoot !== sourceRoot || canary.sourceRootPreSandboxReadable !== true
        || canary.sourceSentinel?.path !== sourceSentinel
        || canary.sourceSentinel?.preSandboxReadable !== true
        || canary.profile?.sha256 !== profileSha256
        || canary.sandbox?.status !== 0 || canary.sandbox?.signal !== null
        || canary.cleanup?.temporaryFilesRemoved !== true
        || canary.cleanup?.processTreeExitProven !== true)
        throw new Error("macOS isolation canary evidence is malformed or incomplete");
    validateProbeResult(canary.probe);
};

const validateSummary = ({summary, sourceSha, artifactSha256, architecture, sourceRoot,
    sourceSentinel, workRoot, populatedRoot, resetRoot}) => {
    if (summary?.status !== "passed" || summary.exit !== 0 || summary.mode !== "full"
        || summary.sourceSha !== sourceSha || summary.artifactSha256 !== artifactSha256
        || summary.platform !== "darwin" || summary.architecture !== architecture
        || summary.networkIsolation?.kind !== "macos-seatbelt"
        || summary.networkIsolation.sourceRoot !== sourceRoot
        || summary.networkIsolation.sourceSentinel !== sourceSentinel
        || summary.networkIsolation.workRoot !== workRoot
        || summary.fixtures?.populated?.root !== populatedRoot
        || summary.fixtures?.reset?.root !== resetRoot)
        throw new Error("Qualification summary does not match the macOS candidate and fixture context");
    validateProbeResult(summary.networkIsolation.probe);
};

const moveRawEvidence = ({checkerEvidence, evidenceDir}) => {
    if (!checkerEvidence || !fs.existsSync(checkerEvidence)) return false;
    const entries = fs.readdirSync(checkerEvidence, {withFileTypes: true})
        .filter(entry => entry.isDirectory() && !entry.isSymbolicLink()
            && entry.name.startsWith("myspeed-evidence-"));
    if (entries.length === 0) return false;
    if (entries.length !== 1) throw new Error("Expected at most one raw qualification evidence directory");
    const destination = path.join(evidenceDir, QUALIFICATION_EVIDENCE_DIRECTORY);
    if (fs.existsSync(destination)) throw new Error("Qualification evidence destination already exists");
    fs.renameSync(path.join(checkerEvidence, entries[0].name), destination);
    return true;
};

const boundedText = (value, maximumBytes = MAX_FAILURE_TEXT_BYTES) => {
    const bytes = Buffer.from(String(value ?? ""));
    return bytes.subarray(0, maximumBytes).toString("utf8");
};

const boundedTailText = (value, maximumBytes = MAX_FAILURE_TEXT_BYTES) => {
    const bytes = Buffer.from(String(value ?? ""));
    return bytes.subarray(Math.max(0, bytes.length - maximumBytes)).toString("utf8");
};

const statIdentity = info => ["dev", "ino", "size", "mtimeMs", "ctimeMs", "nlink"]
    .map(key => String(info[key])).join(":");

const assertSameIdentity = (before, after, label) => {
    if (statIdentity(before) !== statIdentity(after)) throw new Error(`${label} changed while being read`);
};

const assertPlainDirectory = ({directory, expected, label, fileSystem}) => {
    if (directory !== expected || !path.isAbsolute(directory) || path.resolve(directory) !== directory)
        throw new Error(`${label} path is not the exact canonical owned path`);
    const info = fileSystem.lstatSync(directory, {bigint: true});
    if (!info.isDirectory() || info.isSymbolicLink() || fileSystem.realpathSync(directory) !== directory)
        throw new Error(`${label} must be a plain non-aliased directory`);
    return info;
};

const openVerifiedFile = ({file, label, maximumBytes, tail, fileSystem}) => {
    const before = fileSystem.lstatSync(file, {bigint: true});
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n)
        throw new Error(`${label} must be an unlinked regular file`);
    if (fileSystem.realpathSync(file) !== file) throw new Error(`${label} must not be aliased`);
    if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} is too large to inspect safely`);
    if (!tail && before.size > BigInt(maximumBytes)) throw new Error(`${label} exceeds its size limit`);

    const flags = fileSystem.constants.O_RDONLY | (fileSystem.constants.O_NOFOLLOW ?? 0);
    const descriptor = fileSystem.openSync(file, flags);
    try {
        const opened = fileSystem.fstatSync(descriptor, {bigint: true});
        if (!opened.isFile() || opened.nlink !== 1n || statIdentity(before) !== statIdentity(opened))
            throw new Error(`${label} identity changed before it was read`);
        const byteLength = Number(opened.size);
        const capturedBytes = tail ? Math.min(byteLength, maximumBytes) : byteLength;
        const bytes = Buffer.alloc(capturedBytes);
        const position = tail ? byteLength - capturedBytes : 0;
        let offset = 0;
        while (offset < capturedBytes) {
            const bytesRead = fileSystem.readSync(descriptor, bytes, offset, capturedBytes - offset, position + offset);
            if (bytesRead === 0) throw new Error(`${label} ended while it was being read`);
            offset += bytesRead;
        }
        const afterRead = fileSystem.fstatSync(descriptor, {bigint: true});
        assertSameIdentity(opened, afterRead, label);
        const afterPath = fileSystem.lstatSync(file, {bigint: true});
        assertSameIdentity(opened, afterPath, label);
        if (fileSystem.realpathSync(file) !== file) throw new Error(`${label} became aliased while being read`);
        return {bytes, byteLength, capturedBytes, truncated: byteLength > capturedBytes};
    } finally {
        fileSystem.closeSync(descriptor);
    }
};

const boundedDirectoryNames = ({directory, label, fileSystem}) => {
    const names = [];
    const handle = fileSystem.opendirSync(directory);
    try {
        for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
            names.push(entry.name);
            if (names.length > MAX_DIAGNOSTIC_DIRECTORY_ENTRIES)
                throw new Error(`${label} contains too many entries to inspect safely`);
        }
    } finally {
        handle.closeSync();
    }
    return names;
};

export const collectFailureLogSnapshots = ({taskRoot, runnerTemp, randomId, checkerEvidence},
    {fileSystem = fs} = {}) => {
    if (!new RegExp(`^[0-9a-f]{${NONCE_HEX_LENGTH}}$`).test(randomId ?? ""))
        throw new Error("Diagnostic task identity is malformed");
    const runnerInfo = assertPlainDirectory({directory: runnerTemp, expected: runnerTemp,
        label: "Diagnostic runner temporary root", fileSystem});
    const expectedTaskRoot = path.join(runnerTemp, `${TASK_PREFIX}${randomId}`);
    const taskInfo = assertPlainDirectory({directory: taskRoot, expected: expectedTaskRoot,
        label: "Diagnostic task root", fileSystem});
    const ownershipFile = path.join(taskRoot, OWNERSHIP_FILE);
    const ownershipRead = openVerifiedFile({file: ownershipFile, label: "Diagnostic ownership marker",
        maximumBytes: MAX_OWNERSHIP_FILE_BYTES, tail: false, fileSystem});
    let ownership;
    try {
        ownership = JSON.parse(ownershipRead.bytes.toString("utf8"));
    } catch (error) {
        throw new Error("Diagnostic ownership marker is malformed", {cause: error});
    }
    if (ownership?.schemaVersion !== SCHEMA_VERSION || ownership.randomId !== randomId
        || ownership.taskRoot !== taskRoot)
        throw new Error("Diagnostic ownership marker does not match the owned task root");

    const expectedCheckerEvidence = path.join(taskRoot, CHECKER_EVIDENCE_DIRECTORY);
    const checkerInfo = assertPlainDirectory({directory: checkerEvidence, expected: expectedCheckerEvidence,
        label: "Checker evidence", fileSystem});
    const matchingNames = boundedDirectoryNames({directory: checkerEvidence,
        label: "Checker evidence", fileSystem}).filter(name => FAILURE_RAW_DIRECTORY_PATTERN.test(name));
    if (matchingNames.length === 0) return {
        status: "unavailable", trust: FAILURE_DIAGNOSTICS_TRUST, bestEffort: true,
        reason: "No raw checker evidence directory exists"
    };
    if (matchingNames.length !== 1) throw new Error("Expected exactly one raw checker evidence directory");

    const rawDirectory = path.join(checkerEvidence, matchingNames[0]);
    const rawInfo = assertPlainDirectory({directory: rawDirectory, expected: rawDirectory,
        label: "Raw checker evidence", fileSystem});
    const rawNames = new Set(boundedDirectoryNames({directory: rawDirectory,
        label: "Raw checker evidence", fileSystem}));
    const files = {};
    for (const name of FAILURE_LOG_FILES) {
        if (!rawNames.has(name)) {
            files[name] = {present: false};
            continue;
        }
        const snapshot = openVerifiedFile({file: path.join(rawDirectory, name),
            label: `Diagnostic ${name}`, maximumBytes: MAX_FAILURE_LOG_BYTES, tail: true, fileSystem});
        files[name] = {
            present: true,
            byteLength: snapshot.byteLength,
            capturedBytes: snapshot.capturedBytes,
            truncated: snapshot.truncated,
            tail: snapshot.bytes.toString("utf8")
        };
    }
    assertSameIdentity(rawInfo, fileSystem.lstatSync(rawDirectory, {bigint: true}), "Raw checker evidence");
    assertSameIdentity(checkerInfo, fileSystem.lstatSync(checkerEvidence, {bigint: true}), "Checker evidence");
    assertSameIdentity(taskInfo, fileSystem.lstatSync(taskRoot, {bigint: true}), "Diagnostic task root");
    assertSameIdentity(runnerInfo, fileSystem.lstatSync(runnerTemp, {bigint: true}),
        "Diagnostic runner temporary root");
    return {
        status: "captured",
        trust: FAILURE_DIAGNOSTICS_TRUST,
        bestEffort: true,
        evidenceDirectory: matchingNames[0],
        files
    };
};

const writeFailureEvidence = ({evidenceDir, stage, error, result, processTreeExitProven, taskRoot,
    diagnostics}) => {
    if (!fs.existsSync(evidenceDir) || fs.existsSync(path.join(evidenceDir, FAILURE_FILE))) return null;
    const record = {
        schemaVersion: SCHEMA_VERSION,
        status: "failed",
        stage,
        error: boundedText(error?.stack ?? error),
        cleanup: {
            processTreeExitProven,
            taskRootRetained: Boolean(taskRoot && !processTreeExitProven)
        },
        diagnostics,
        sandbox: result ? {
            status: result.status ?? null,
            signal: result.signal ?? null,
            stdout: boundedTailText(result.stdout),
            stderr: boundedTailText(result.stderr),
            error: result.error ? boundedText(result.error.message ?? result.error) : null
        } : null
    };
    writeWithDigest(path.join(evidenceDir, FAILURE_FILE), Buffer.from(JSON.stringify(record, null, 2) + "\n"));
    return record;
};

const rememberFailureDetails = (error, details) => {
    if ((typeof error === "object" && error !== null) || typeof error === "function")
        failureDetails.set(error, details);
};

const stringifySingleLine = value => JSON.stringify(value)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

export const formatMacosStandaloneFailure = error => {
    const details = ((typeof error === "object" && error !== null) || typeof error === "function")
        ? failureDetails.get(error) : null;
    const diagnosticError = details?.diagnosticErrors?.length
        ? boundedText(details.diagnosticErrors.map(item => item?.stack ?? item).join("\n")) : null;
    return stringifySingleLine({
        schemaVersion: SCHEMA_VERSION,
        status: "failed",
        trust: FAILURE_DIAGNOSTICS_TRUST,
        diagnosticsBestEffort: true,
        error: boundedText(error?.stack ?? error),
        diagnostics: details?.failureRecord?.diagnostics ?? details?.diagnostics ?? null,
        cleanup: details?.failureRecord?.cleanup ?? null,
        diagnosticError
    });
};

const removeOwnedTaskRoot = ({taskRoot, runnerTemp, randomId, runtimeDirectory}) => {
    if (path.dirname(taskRoot) !== runnerTemp || path.basename(taskRoot) !== `${TASK_PREFIX}${randomId}`)
        throw new Error("Refusing cleanup outside the owned macOS standalone root");
    const taskInfo = fs.lstatSync(taskRoot);
    if (!taskInfo.isDirectory() || taskInfo.isSymbolicLink() || fs.realpathSync(taskRoot) !== taskRoot)
        throw new Error("Refusing cleanup of an aliased macOS standalone root");
    const ownershipFile = path.join(taskRoot, OWNERSHIP_FILE);
    assertUnlinkedRegularFile(ownershipFile, "Standalone ownership marker");
    const ownership = JSON.parse(fs.readFileSync(ownershipFile, "utf8"));
    if (ownership.schemaVersion !== SCHEMA_VERSION || ownership.randomId !== randomId
        || ownership.taskRoot !== taskRoot)
        throw new Error("Refusing cleanup after standalone ownership identity drift");
    const runtimeInfo = fs.lstatSync(runtimeDirectory);
    if (!runtimeInfo.isDirectory() || runtimeInfo.isSymbolicLink()
        || fs.realpathSync(runtimeDirectory) !== runtimeDirectory
        || runtimeDirectory !== path.join(taskRoot, RUNTIME_DIRECTORY))
        throw new Error("Refusing cleanup after runtime directory identity drift");
    fs.chmodSync(runtimeDirectory, DIRECTORY_MODE);
    fs.rmSync(taskRoot, {recursive: true, force: false});
};

export const runMacosStandaloneVerification = (options, dependencies = {}) => {
    const environment = dependencies.environment ?? process.env;
    const platform = dependencies.platform ?? process.platform;
    const architecture = dependencies.architecture ?? process.arch;
    const qualificationDirectory = dependencies.qualificationDirectory
        ?? path.dirname(fileURLToPath(import.meta.url));
    const runCanary = dependencies.runCanary ?? runMacosIsolationCanary;
    const runSandbox = dependencies.runSandbox ?? spawnSync;
    const collectSummary = dependencies.collectSummary ?? collectQualificationSummary;
    const collectFailureDiagnostics = dependencies.collectFailureDiagnostics ?? collectFailureLogSnapshots;
    const randomId = (dependencies.randomId ?? (() => crypto.randomBytes(NONCE_HEX_LENGTH / 2).toString("hex")))();
    let taskRoot;
    let runtimeDirectory;
    let checkerEvidence;
    let lastSandboxResult;
    let taskRootCreated = false;
    let processTreeExitProven = true;
    let stage = "input-validation";

    assertSha256(options.artifactSha256, "Artifact SHA-256");
    if (!COMMIT_PATTERN.test(options.sourceSha ?? ""))
        throw new Error("Source SHA must be a lowercase 40-character commit SHA");
    assertPositiveInteger(options.runId, "Run ID");
    assertPositiveInteger(options.runAttempt, "Run attempt");
    if (!REPOSITORY_PATTERN.test(options.repository ?? "")) throw new Error("Repository identity is malformed");
    const expectedArtifactName = ARCHITECTURE_ARTIFACTS.get(options.expectedArch);
    if (!expectedArtifactName) throw new Error("Expected architecture must be x64 or arm64");
    assertCanonicalAbsolute(options.artifact, "Artifact path");
    assertUnlinkedRegularFile(options.artifact, "Candidate artifact");
    if (path.basename(options.artifact) !== expectedArtifactName)
        throw new Error(`Candidate filename must be ${expectedArtifactName}`);
    if (sha256File(options.artifact) !== options.artifactSha256) throw new Error("Candidate artifact hash mismatch");
    assertCanonicalAbsolute(options.repo, "Source root");
    assertCanonicalAbsolute(options.evidenceDir, "Evidence directory");
    if (path.resolve(qualificationDirectory) !== path.join(options.repo, "scripts", "qualification"))
        throw new Error("Verifier files must come from the requested source checkout");
    const sourceSentinel = path.join(options.repo, SOURCE_SENTINEL);
    assertUnlinkedRegularFile(sourceSentinel, "Source sentinel");
    const context = assertHostedMacEnvironment({
        expectedArch: options.expectedArch,
        sourceRoot: options.repo,
        environment,
        platform,
        architecture
    });
    if (!new RegExp(`^[0-9a-f]{${NONCE_HEX_LENGTH}}$`).test(randomId))
        throw new Error("Random task identity is malformed");

    try {
        stage = "canary";
        const returnedCanary = runCanary({
            expectedArch: options.expectedArch,
            sourceRoot: context.sourceRoot,
            sourceSentinel: SOURCE_SENTINEL,
            evidenceDir: options.evidenceDir
        }, {environment, platform, architecture});
        const originalProfile = path.join(options.evidenceDir, CANARY_SOURCE_PROFILE_FILE);
        const originalRecord = path.join(options.evidenceDir, CANARY_SOURCE_RECORD_FILE);
        assertUnlinkedRegularFile(originalProfile, "Canary profile");
        assertUnlinkedRegularFile(originalRecord, "Canary record");
        const canaryProfileBytes = fs.readFileSync(originalProfile);
        if (!canaryProfileBytes.equals(Buffer.from(buildSandboxProfile())))
            throw new Error("Canary profile bytes do not match the trusted profile builder");
        const canaryProfileSha256 = sha256(canaryProfileBytes);
        const canaryBytes = fs.readFileSync(originalRecord);
        const canary = JSON.parse(canaryBytes.toString("utf8"));
        if (JSON.stringify(canary) !== JSON.stringify(returnedCanary))
            throw new Error("Returned canary does not match its evidence record");
        validateCanary({canary, sourceRoot: context.sourceRoot, sourceSentinel,
            architecture, profileSha256: canaryProfileSha256});
        const canaryProfileFile = path.join(options.evidenceDir, CANARY_PROFILE_FILE);
        const canaryRecordFile = path.join(options.evidenceDir, CANARY_RECORD_FILE);
        fs.renameSync(originalProfile, canaryProfileFile);
        fs.renameSync(originalRecord, canaryRecordFile);
        fs.chmodSync(canaryProfileFile, FILE_MODE);
        fs.chmodSync(canaryRecordFile, FILE_MODE);
        fs.writeFileSync(`${canaryProfileFile}.sha256`, `${canaryProfileSha256}\n`, {flag: "wx", mode: FILE_MODE});
        const canarySha256 = sha256(canaryBytes);
        fs.writeFileSync(`${canaryRecordFile}.sha256`, `${canarySha256}\n`, {flag: "wx", mode: FILE_MODE});

        stage = "runtime-staging";
        taskRoot = path.join(context.runnerTemp, `${TASK_PREFIX}${randomId}`);
        fs.mkdirSync(taskRoot, {mode: DIRECTORY_MODE});
        taskRootCreated = true;
        fs.writeFileSync(path.join(taskRoot, OWNERSHIP_FILE), JSON.stringify({
            schemaVersion: SCHEMA_VERSION,
            randomId,
            taskRoot
        }) + "\n", {flag: "wx", mode: FILE_MODE});
        runtimeDirectory = path.join(taskRoot, RUNTIME_DIRECTORY);
        const populated = path.join(taskRoot, POPULATED_DIRECTORY);
        const reset = path.join(taskRoot, RESET_DIRECTORY);
        checkerEvidence = path.join(taskRoot, CHECKER_EVIDENCE_DIRECTORY);
        for (const directory of [runtimeDirectory, populated, reset, checkerEvidence])
            fs.mkdirSync(directory, {mode: DIRECTORY_MODE});
        const handoff = path.join(taskRoot, HANDOFF_FILE);
        const seedProfile = Buffer.from(buildMacosSeedProfile());
        const seedProfileFile = path.join(taskRoot, SEED_PROFILE_FILE);
        fs.writeFileSync(seedProfileFile, seedProfile, {flag: "wx", mode: FILE_MODE});
        const runtimeProfile = Buffer.from(buildMacosRuntimeProfile());
        const runtimeProfileFile = path.join(options.evidenceDir, RUNTIME_PROFILE_FILE);
        const profileSha256 = writeWithDigest(runtimeProfileFile, runtimeProfile);
        const verifierFiles = {};
        for (const file of VERIFIER_FILES) {
            const source = path.join(qualificationDirectory, file);
            verifierFiles[file] = copyVerifiedFile({source, destination: path.join(runtimeDirectory, file),
                label: `Verifier ${file}`, mode: FILE_MODE});
        }
        const candidateCopy = path.join(runtimeDirectory, expectedArtifactName);
        const stagedArtifactSha256 = copyVerifiedFile({source: options.artifact, destination: candidateCopy,
            label: "Candidate artifact", mode: EXECUTABLE_MODE});
        if (stagedArtifactSha256 !== options.artifactSha256)
            throw new Error("Staged candidate artifact hash mismatch");
        fs.chmodSync(runtimeDirectory, READONLY_DIRECTORY_MODE);
        const childEnvironment = safeEnvironment(environment, taskRoot);

        stage = "seed-network-probe";
        processTreeExitProven = false;
        lastSandboxResult = runSandbox(SANDBOX_EXECUTABLE, [
            "-f", seedProfileFile,
            process.execPath, path.join(runtimeDirectory, "macos-isolation.mjs"), "helper"
        ], spawnOptions(taskRoot, childEnvironment));
        processTreeExitProven = !lastSandboxResult?.error && lastSandboxResult?.signal == null
            && lastSandboxResult?.status === 0;
        spawnFailure(lastSandboxResult);
        const seedProbe = validateDenialProbe(parseLastJsonLine(lastSandboxResult.stdout,
            "Seed denial helper"), "Seed denial probe");

        stage = "fixture-seed";
        processTreeExitProven = false;
        lastSandboxResult = runSandbox(SANDBOX_EXECUTABLE, [
            "-f", seedProfileFile,
            process.execPath, path.join(runtimeDirectory, "fixture.mjs"), "handoff",
            "--repo", context.sourceRoot,
            "--work", populated,
            "--reset-work", reset,
            "--manifest", handoff,
            "--source-sha", options.sourceSha
        ], spawnOptions(taskRoot, childEnvironment));
        processTreeExitProven = !lastSandboxResult?.error && lastSandboxResult?.signal == null
            && lastSandboxResult?.status === 0;
        spawnFailure(lastSandboxResult);
        assertUnlinkedRegularFile(handoff, "Fixture handoff");
        fs.chmodSync(handoff, FILE_MODE);
        const handoffSha256 = sha256File(handoff);

        stage = "runtime-verification";
        processTreeExitProven = false;
        lastSandboxResult = runSandbox(SANDBOX_EXECUTABLE, [
            "-D", `${SOURCE_PARAMETER}=${context.sourceRoot}`,
            "-D", `${VERIFIER_PARAMETER}=${runtimeDirectory}`,
            "-f", runtimeProfileFile,
            process.execPath, path.join(runtimeDirectory, "check-artifact.mjs"),
            "--command", candidateCopy,
            "--artifact", candidateCopy,
            "--work", populated,
            "--reset-work", reset,
            "--keep-work",
            "--preseeded-fixture-manifest", handoff,
            "--original-build-root", context.sourceRoot,
            "--macos-source-sentinel", sourceSentinel,
            "--evidence-dir", checkerEvidence,
            "--mode", "full"
        ], spawnOptions(runtimeDirectory, childEnvironment));
        processTreeExitProven = !lastSandboxResult?.error && lastSandboxResult?.signal == null
            && lastSandboxResult?.status === 0;
        spawnFailure(lastSandboxResult);

        stage = "evidence-seal";
        const summaryFile = path.join(options.evidenceDir, SUMMARY_FILE);
        const collected = collectSummary({evidenceDir: checkerEvidence, output: summaryFile,
            sourceSha: options.sourceSha, mode: "full"});
        validateSummary({summary: collected.summary, sourceSha: options.sourceSha,
            artifactSha256: options.artifactSha256, architecture, sourceRoot: context.sourceRoot,
            sourceSentinel, workRoot: populated, populatedRoot: populated, resetRoot: reset});
        if (!moveRawEvidence({checkerEvidence, evidenceDir: options.evidenceDir}))
            throw new Error("Raw qualification evidence was not produced");
        if (sha256File(seedProfileFile) !== sha256(seedProfile)
            || sha256File(runtimeProfileFile) !== profileSha256
            || sha256File(canaryProfileFile) !== canaryProfileSha256
            || sha256File(canaryRecordFile) !== canarySha256
            || sha256File(handoff) !== handoffSha256
            || sha256File(candidateCopy) !== options.artifactSha256)
            throw new Error("Qualification inputs or isolation evidence changed during execution");
        for (const [file, digest] of Object.entries(verifierFiles))
            if (sha256File(path.join(runtimeDirectory, file)) !== digest)
                throw new Error(`Verifier ${file} changed during execution`);
        const candidateEvidence = path.join(options.evidenceDir, expectedArtifactName);
        copyVerifiedFile({source: candidateCopy, destination: candidateEvidence,
            label: "Verified candidate artifact", mode: EXECUTABLE_MODE});
        fs.writeFileSync(`${candidateEvidence}.sha256`, `${options.artifactSha256}\n`,
            {flag: "wx", mode: FILE_MODE});
        const isolationRecord = createMacosRuntimeIsolationRecord({
            sourceSha: options.sourceSha,
            artifactSha256: options.artifactSha256,
            architecture,
            runId: options.runId,
            runAttempt: options.runAttempt,
            repository: options.repository,
            summarySha256: collected.sha256,
            profileSha256,
            canarySha256,
            canaryProfileSha256,
            handoffSha256,
            seed: {
                profileSha256: sha256(seedProfile),
                sandboxStatus: 0,
                sandboxSignal: null,
                probe: seedProbe
            },
            canaryHelper: canary.probe.helper,
            candidateFile: {name: expectedArtifactName, sha256: options.artifactSha256},
            verifierFiles
        });
        writeWithDigest(path.join(options.evidenceDir, RUNTIME_RECORD_FILE),
            Buffer.from(JSON.stringify(isolationRecord, null, 2) + "\n"));
        return {evidenceDir: options.evidenceDir, isolationRecord, summary: collected.summary};
    } catch (error) {
        let diagnostics = {
            status: "unavailable",
            trust: FAILURE_DIAGNOSTICS_TRUST,
            bestEffort: true,
            reason: "No owned checker evidence directory was created"
        };
        const diagnosticErrors = [];
        if (taskRoot && checkerEvidence) {
            try {
                diagnostics = collectFailureDiagnostics({taskRoot, runnerTemp: context.runnerTemp,
                    randomId, checkerEvidence});
            } catch (diagnosticError) {
                diagnosticErrors.push(diagnosticError);
                diagnostics = {
                    status: "rejected",
                    trust: FAILURE_DIAGNOSTICS_TRUST,
                    bestEffort: true,
                    error: boundedText(diagnosticError?.stack ?? diagnosticError)
                };
            }
        }
        let failureRecord = null;
        try {
            if (processTreeExitProven) moveRawEvidence({checkerEvidence, evidenceDir: options.evidenceDir});
        } catch (diagnosticError) {
            diagnosticErrors.push(diagnosticError);
        }
        try {
            failureRecord = writeFailureEvidence({evidenceDir: options.evidenceDir, stage, error,
                result: lastSandboxResult, processTreeExitProven, taskRoot, diagnostics});
        } catch (diagnosticError) {
            diagnosticErrors.push(diagnosticError);
        }
        rememberFailureDetails(error, {diagnostics, diagnosticErrors, failureRecord});
        throw error;
    } finally {
        if (taskRootCreated && processTreeExitProven)
            removeOwnedTaskRoot({taskRoot, runnerTemp: context.runnerTemp, randomId, runtimeDirectory});
    }
};

const invokedDirectly = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
    try {
        const result = runMacosStandaloneVerification(parseArguments(process.argv.slice(2)));
        process.stdout.write(`${JSON.stringify(result.isolationRecord)}\n`);
    } catch (error) {
        process.stderr.write(`${formatMacosStandaloneFailure(error)}\n`);
        process.exitCode = 1;
    }
}
