import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {validateHostedContext} from "../qualification/linux-kvm-capability.mjs";
import {stage2ClosureFromStage3Closure, executeStage3Launcher} from
    "../qualification/linux-windows-cpu-floor-stage3-launcher.mjs";
import {WINDOWS_BASELINE_RUNTIME_BUNDLE_CONSTANTS} from
    "../qualification/windows-baseline-guest-runtime-bundle.mjs";
import {prepareV161PostReleaseCpuFloorGuestFiles} from "./post-release-cpu-floor-guest-preparation.mjs";
import {createV161PostReleaseCpuFloorBinding, acquireV161PostReleaseCpuFloorBaselineSummary} from
    "./post-release-cpu-floor.mjs";

const CANDIDATE_BINDING_ID = "candidate-baseline";
const CANDIDATE_SOURCE_SHA = "4fa4dd40a89a062735f98bd85d685e0624ff46a8";
const BASELINE_ROOT_NAME = "baseline";
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const exactKeys = (value, keys, label) => {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort()))
        throw new TypeError(`${label} schema differs`);
};
function readOwned(identity, label) {
    const expected = Number(identity?.bytes);
    if (!identity || typeof identity.path !== "string" || !path.isAbsolute(identity.path) ||
        !Number.isSafeInteger(expected) || expected < 1 || expected > MAX_FILE_BYTES ||
        !/^[0-9a-f]{64}$/u.test(identity.sha256)) throw new TypeError(`${label} identity differs`);
    const lexical = fs.lstatSync(identity.path, {bigint: true});
    const handle = fs.openSync(identity.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
        const before = fs.fstatSync(handle, {bigint: true});
        if (!lexical.isFile() || lexical.isSymbolicLink() || lexical.nlink !== 1n || before.nlink !== 1n ||
            before.dev !== lexical.dev || before.ino !== lexical.ino || before.size !== BigInt(expected) ||
            fs.realpathSync.native(identity.path) !== identity.path) throw new Error(`${label} physical identity differs`);
        const bytes = Buffer.alloc(expected); let offset = 0;
        while (offset < bytes.length) { const count = fs.readSync(handle, bytes, offset, bytes.length - offset, offset);
            if (count < 1) throw new Error(`${label} was truncated`); offset += count; }
        const trailing = fs.readSync(handle, Buffer.alloc(1), 0, 1, bytes.length);
        const after = fs.fstatSync(handle, {bigint: true});
        const lexicalAfter = fs.lstatSync(identity.path, {bigint: true});
        if (trailing !== 0 || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
            before.mtimeNs !== after.mtimeNs || after.dev !== lexicalAfter.dev || after.ino !== lexicalAfter.ino ||
            lexicalAfter.isSymbolicLink() || lexicalAfter.nlink !== 1n ||
            fs.realpathSync.native(identity.path) !== identity.path || sha256(bytes) !== identity.sha256)
            throw new Error(`${label} content identity differs`);
        return bytes;
    } finally { fs.closeSync(handle); }
}
function writeOwned(target, bytes) {
    fs.writeFileSync(target, bytes, {flag: "wx", mode: FILE_MODE});
    if (!fs.readFileSync(target).equals(bytes)) throw new Error("hosted input staging identity differs");
}
const baselineIdentity = (root, file, expectedRelativePath, harnessSourceSha) => {
    const expectedRole = expectedRelativePath.startsWith("runtime/") ? "harness" : "candidate";
    const expectedSourceSha = expectedRole === "harness" ? harnessSourceSha : CANDIDATE_SOURCE_SHA;
    if (!file || file.relativePath !== expectedRelativePath || file.sourceRole !== expectedRole ||
        file.sourceSha !== expectedSourceSha)
        throw new Error(`observed baseline file is missing or differs: ${expectedRelativePath}`);
    return {path: path.join(root, ...file.relativePath.split("/")), bytes: String(file.bytes), sha256: file.sha256};
};

export async function runV161PostReleaseCpuFloorHostedInputs(input, dependencies = {}) {
    exactKeys(input, ["artifactRoot", "baselineArtifact", "baselineSummaryBytes", "closureRecords",
        "hostedContext", "observedAt", "observedMsiPreparation", "probeArtifact", "probes", "roots"],
    "hosted CPU-floor input");
    const {observedMsiPreparation: observed, hostedContext, artifactRoot, baselineArtifact,
        baselineSummaryBytes, observedAt, probeArtifact, probes, roots, closureRecords} = input;
    validateHostedContext(hostedContext);
    if (!observed?.target || observed.execution?.root !== artifactRoot || !path.isAbsolute(artifactRoot) ||
        observed.target.harness.sourceSha !== hostedContext.sourceSha)
        throw new Error("hosted MSI preparation binding differs");
    const baselineRoot = path.join(artifactRoot, "files", BASELINE_ROOT_NAME);
    const baselineFiles = new Map(observed.baselinePreparation.files.map(file => [file.relativePath, file]));
    const manifestIdentity = baselineIdentity(baselineRoot, baselineFiles.get("qualification-manifest.json"),
        "qualification-manifest.json", hostedContext.sourceSha);
    const manifestBytes = (dependencies.readOwned ?? readOwned)(manifestIdentity, "qualification manifest");
    const binding = createV161PostReleaseCpuFloorBinding({target: observed.target, manifestBytes, hostedContext});
    const acquired = acquireV161PostReleaseCpuFloorBaselineSummary(binding,
        {artifact: baselineArtifact, summaryBytes: baselineSummaryBytes, observedAt});
    const candidateSource = observed.execution.files.find(file => file.bindingId === CANDIDATE_BINDING_ID &&
        file.role === "exe");
    if (!candidateSource || candidateSource.bytes !== binding.candidate.exeAsset.bytes ||
        candidateSource.sha256 !== binding.candidate.exeAsset.sha256)
        throw new Error("observed candidate executable is missing or differs");

    exactKeys(roots, ["candidate", "closure", "envelope", "stage2Closure", "stage3", "transport"],
        "hosted CPU-floor roots");
    const temporaryRoot = "/home/runner/work/_temp";
    if (!roots || roots.stage3 !== `${temporaryRoot}/myspeed-stage3-${hostedContext.nonce}` ||
        roots.candidate !== `${roots.stage3}/candidate` ||
        roots.closure !== `${temporaryRoot}/myspeed-stage3-closure-${hostedContext.nonce}` ||
        roots.stage2Closure !== `${temporaryRoot}/myspeed-stage2-closure-${hostedContext.nonce}` ||
        roots.transport !== `${temporaryRoot}/myspeed-stage2-transport-${hostedContext.nonce}` ||
        roots.envelope !== `${temporaryRoot}/myspeed-stage3-sequence-envelope-${hostedContext.nonce}`)
        throw new Error("hosted Stage 3 roots differ");
    (dependencies.makeDirectory ?? (target => fs.mkdirSync(target, {mode: DIRECTORY_MODE})))(roots.stage3);
    const runtimeSources = WINDOWS_BASELINE_RUNTIME_BUNDLE_CONSTANTS.RUNTIME_PATHS.map(relativePath => ({
        relativePath, source: baselineIdentity(baselineRoot, baselineFiles.get(`runtime/${relativePath}`),
            `runtime/${relativePath}`, hostedContext.sourceSha)}));
    const runtimeInstaller = baselineIdentity(baselineRoot,
        baselineFiles.get("runtime/scripts/qualification/windows-baseline-guest-runtime-installer.ps1"),
        "runtime/scripts/qualification/windows-baseline-guest-runtime-installer.ps1", hostedContext.sourceSha);
    const fixture = {manifest: baselineIdentity(baselineRoot, baselineFiles.get("fixture/transport.json"),
        "fixture/transport.json", hostedContext.sourceSha),
        populatedRoot: path.join(baselineRoot, "fixture", "populated"),
        resetRoot: path.join(baselineRoot, "fixture", "reset")};
    const prepareGuest = dependencies.prepareGuest ?? prepareV161PostReleaseCpuFloorGuestFiles;
    const runtimeNode = {path: observed.execution.runtime.path, bytes: String(observed.execution.runtime.bytes),
        sha256: observed.execution.runtime.sha256};
    const guestProbes = probes.map(probe => ({...probe, bytes: String(probe.bytes)}));
    const preparedGuest = prepareGuest({context: hostedContext, candidate: {
        sourceSha: binding.candidate.sourceSha, artifactName: binding.candidate.artifact.name,
        file: {name: "MySpeed.exe", bytes: String(binding.candidate.exeAsset.bytes),
            sha256: binding.candidate.exeAsset.sha256}}, runtimeNode, fixture,
    runtimeSources, runtimeInstaller, probes: guestProbes, imageVersion: hostedContext.environment.ImageVersion,
    manifestSha256: binding.originalQualification.manifest.sha256, outputRoot: roots.candidate});

    const stageFile = dependencies.stageFile ?? writeOwned;
    stageFile(path.join(roots.candidate, "MySpeed.exe"),
        (dependencies.readOwned ?? readOwned)(candidateSource, "candidate executable"));
    stageFile(path.join(roots.candidate, "qualification-summary.json"), baselineSummaryBytes);
    stageFile(path.join(roots.candidate, "qualification-manifest.json"), manifestBytes);
    const makeStage2Closure = dependencies.makeStage2Closure ?? stage2ClosureFromStage3Closure;
    makeStage2Closure(roots.closure, roots.stage2Closure);
    const launch = dependencies.launch ?? executeStage3Launcher;
    const result = await launch({closureRoot: roots.closure, closureRecords, transportRoot: roots.transport,
        envelopeRoot: roots.envelope, binding, acquired, probeArtifact, guestFiles: preparedGuest.files},
    dependencies.launchDependencies);
    if (result?.accepted !== true) throw new Error("Stage 3 consumer did not accept the execution");
    return result;
}
