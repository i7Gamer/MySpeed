import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {validateHostedContext} from "./linux-kvm-capability.mjs";
import {assessWindowsCpuFloorAdmission} from "./linux-windows-cpu-floor-admission.mjs";
import {runWindowsCpuFloorStage2, validateStage2Paths} from "./linux-windows-cpu-floor-stage2.mjs";
import {collectHostedAdmissionObservations, createHostedStage2Operations} from
    "./linux-windows-cpu-floor-stage2-hosted.mjs";

const SCHEMA_VERSION = 1;
const MAX_REQUEST_BYTES = 262_144;
const MAX_EVIDENCE_BYTES = 4_194_304;
const MAX_KVM_BYTES = 262_144;
const MAX_PROBE_ARCHIVE_BYTES = 268_435_456;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CONFIRMATION = "RUN-CANDIDATE-NEUTRAL-STAGE2";

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

function validateRequest(request) {
    assertKeys(request, ["authorization", "closure", "context", "kvm", "paths", "probeArtifact", "probeStage",
        "schemaVersion"], "Stage 2 controller request");
    if (request.schemaVersion !== SCHEMA_VERSION) throw new TypeError("request schema is invalid");
    const context = validateHostedContext(request.context);
    request.paths = validateStage2Paths(request.paths, context);
    assertKeys(request.authorization, ["confirmation", "media", "qemu", "scope"], "Stage 2 authorization");
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
    const closureNames = ["scripts/qualification/linux-windows-cpu-floor-admission.mjs",
        "scripts/qualification/linux-windows-cpu-floor-stage2-controller.mjs",
        "scripts/qualification/linux-windows-cpu-floor-stage2-hosted.mjs",
        "scripts/qualification/linux-windows-cpu-floor-stage2-qmp.mjs",
        "scripts/qualification/linux-windows-cpu-floor-stage2.mjs",
        "scripts/qualification/linux-kvm-capability.mjs",
        "scripts/qualification/linux-kvm-privileged-capability.mjs",
        "scripts/qualification/windows-msi-post-setup-activation.mjs"];
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
    return await run({context, admission, paths: request.paths, probeArtifact: request.probeArtifact}, operations);
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
    if (result.status !== "observed") process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1; });
}

export const STAGE2_CONTROLLER_CONSTANTS = Object.freeze({CONFIRMATION, MAX_EVIDENCE_BYTES, MAX_REQUEST_BYTES});
