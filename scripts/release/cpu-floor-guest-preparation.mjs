import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {buildWindowsBaselineGuestFixtureBundle} from
    "../qualification/windows-baseline-guest-fixture-bundle.mjs";
import {buildWindowsBaselineGuestRuntimeBundle, WINDOWS_BASELINE_RUNTIME_BUNDLE_CONSTANTS} from
    "../qualification/windows-baseline-guest-runtime-bundle.mjs";
import {buildWindowsBaselineGuestSeedDocuments} from
    "../qualification/windows-baseline-guest-seed-documents.mjs";
import {validateHostedContext} from "../qualification/linux-kvm-capability.mjs";
import {CANDIDATE_PROVENANCE} from "../qualification/windows-cpu-floor-candidate-provenance.mjs";

const SCHEMA_VERSION = 1;
const KIND = "myspeed-cpu-floor-guest-preparation";
const NODE_RUNTIME_SHA256 = "995a3fb3cefad590cd3f4b321532a4b9582fb9c6575320ed2e3e894caac3e362";
/* The published release this module is pinned to. Meaningless on the branch path, which pins
 * the candidate to the harness commit instead. */
const PUBLISHED_CANDIDATE_SOURCE_SHA = "4fa4dd40a89a062735f98bd85d685e0624ff46a8";
const MAX_SOURCE_BYTES = 512 * 1024 * 1024;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const CANDIDATE_ARTIFACT_NAME = "MySpeed-windows-x64-baseline.exe";
/* The probe whose output becomes the guest's own proof of the CPU floor. */
const CPUID_PROBE_ROLE = "cpuid";
const PROBES = Object.freeze([
    ["avx", "avx.exe"], ["avx2", "avx2.exe"], ["cpuid", "cpuid.exe"], ["illegal", "illegal.exe"],
    ["known-bad", "known_bad.exe"], ["known-good", "known_good.exe"], ["popcnt", "popcnt.exe"],
    ["sse42", "sse42.exe"]
]);

const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const exactKeys = (value, expected, label) => {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort()))
        throw new TypeError(`${label} schema differs`);
};
const identity = (value, label) => {
    exactKeys(value, ["bytes", "path", "sha256"], `${label} identity`);
    if (!path.isAbsolute(value.path) || typeof value.bytes !== "string" || !/^[1-9][0-9]*$/u.test(value.bytes) ||
        !/^[0-9a-f]{64}$/u.test(value.sha256) || Number(value.bytes) > MAX_SOURCE_BYTES)
        throw new TypeError(`${label} identity differs`);
    return value;
};
function readIdentity(value, label) {
    identity(value, label);
    const lexical = fs.lstatSync(value.path, {bigint: true});
    const handle = fs.openSync(value.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
        const before = fs.fstatSync(handle, {bigint: true});
        if (!lexical.isFile() || lexical.isSymbolicLink() || lexical.nlink !== 1n || !before.isFile() ||
            before.nlink !== 1n || before.dev !== lexical.dev || before.ino !== lexical.ino ||
            before.size !== BigInt(value.bytes) || fs.realpathSync.native(value.path) !== value.path)
            throw new Error(`${label} physical identity differs`);
        const bytes = Buffer.alloc(Number(before.size));
        let offset = 0;
        while (offset < bytes.length) {
            const count = fs.readSync(handle, bytes, offset, bytes.length - offset, offset);
            if (count < 1) throw new Error(`${label} content was truncated`);
            offset += count;
        }
        const trailingCount = fs.readSync(handle, Buffer.alloc(1), 0, 1, bytes.length);
        const after = fs.fstatSync(handle, {bigint: true});
        const lexicalAfter = fs.lstatSync(value.path, {bigint: true});
        if (bytes.length !== Number(value.bytes) || sha256(bytes) !== value.sha256 || before.dev !== after.dev ||
            before.ino !== after.ino || before.size !== after.size || before.nlink !== after.nlink ||
            before.mtimeNs !== after.mtimeNs || trailingCount !== 0 || after.dev !== lexicalAfter.dev ||
            after.ino !== lexicalAfter.ino || lexicalAfter.isSymbolicLink() || lexicalAfter.nlink !== 1n ||
            fs.realpathSync.native(value.path) !== value.path)
            throw new Error(`${label} content identity differs`);
        return bytes;
    } finally { fs.closeSync(handle); }
}
function writeVerified(root, name, bytes) {
    const target = path.join(root, name);
    fs.writeFileSync(target, bytes, {flag: "wx", mode: FILE_MODE});
    const observed = fs.readFileSync(target);
    if (!observed.equals(bytes)) throw new Error(`prepared ${name} content differs`);
    return Object.freeze({name, path: target, bytes: String(bytes.length), sha256: sha256(bytes)});
}

// Caller obligation: runtimeNode must come from an already authenticated same-run source - the MSI
// preparation for a published release, or the guest bundle artifact for a branch build. This bounded
// module re-observes its physical identity but does not authenticate that upstream document.
export function prepareCpuFloorGuestFiles(input, dependencies = {}) {
    exactKeys(input, ["candidate", "context", "fixture", "imageVersion", "manifestSha256", "outputRoot",
        "probes", "runtimeInstaller", "runtimeNode", "runtimeSources"], "CPU-floor guest preparation input");
    const {context} = input;
    validateHostedContext(context);
    /*
     * A published release is a frozen commit that some later harness tests, so the two source SHAs
     * must differ and the candidate must be the release this module is pinned to. A branch build is
     * produced by the harness commit itself, so the two roles are one commit and the pin does not
     * apply. The discriminant is explicit: an unrecognised one is refused rather than defaulted to
     * whichever branch asks for less.
     */
    const {provenance} = input.candidate;
    if (provenance !== CANDIDATE_PROVENANCE.published && provenance !== CANDIDATE_PROVENANCE.branch)
        throw new TypeError("CPU-floor guest candidate provenance differs");
    const rolesHold = provenance === CANDIDATE_PROVENANCE.published
        ? input.candidate.sourceSha === PUBLISHED_CANDIDATE_SOURCE_SHA
            && input.candidate.sourceSha !== context.sourceSha
        : input.candidate.sourceSha === context.sourceSha;
    if (context.sourceSha !== context.eventSha || !rolesHold)
        throw new TypeError("CPU-floor guest source roles differ");
    exactKeys(input.candidate.file, ["bytes", "name", "sha256"], "candidate file");
    if (input.candidate.file.name !== "MySpeed.exe" || !/^[1-9][0-9]*$/u.test(input.candidate.file.bytes) ||
        !/^[0-9a-f]{64}$/u.test(input.candidate.file.sha256) ||
        input.candidate.artifactName !== CANDIDATE_ARTIFACT_NAME)
        throw new TypeError("CPU-floor guest candidate artifact differs");
    const nodeBytes = readIdentity(input.runtimeNode, "Node runtime");
    const expectedNodeSha256 = dependencies.expectedNodeSha256 ?? NODE_RUNTIME_SHA256;
    if (input.runtimeNode.sha256 !== expectedNodeSha256) throw new Error("Node runtime digest differs");
    const installerBytes = readIdentity(input.runtimeInstaller, "runtime installer");
    if (!Array.isArray(input.runtimeSources) || input.runtimeSources.length !==
        WINDOWS_BASELINE_RUNTIME_BUNDLE_CONSTANTS.RUNTIME_PATHS.length) throw new TypeError("runtime sources differ");
    const runtimeFiles = input.runtimeSources.map((record, index) => {
        exactKeys(record, ["relativePath", "source"], "runtime source");
        if (record.relativePath !== WINDOWS_BASELINE_RUNTIME_BUNDLE_CONSTANTS.RUNTIME_PATHS[index])
            throw new TypeError("runtime source order differs");
        readIdentity(record.source, `runtime source ${index}`);
        return record;
    });
    if (!Array.isArray(input.probes) || input.probes.length !== PROBES.length)
        throw new TypeError("probe inventory differs");
    const probeBytes = input.probes.map((record, index) => {
        exactKeys(record, ["bytes", "name", "path", "role", "sha256"], "probe observation");
        const [role, name] = PROBES[index];
        if (record.role !== role || record.name !== name) throw new TypeError("probe inventory differs");
        return readIdentity({path: record.path, bytes: record.bytes, sha256: record.sha256}, `probe ${role}`);
    });
    const outputParent = path.dirname(input.outputRoot);
    if (!path.isAbsolute(input.outputRoot) || path.resolve(input.outputRoot) !== input.outputRoot ||
        fs.existsSync(input.outputRoot) || path.basename(input.outputRoot) !== "candidate" ||
        path.basename(outputParent) !== `myspeed-stage3-${context.nonce}` ||
        fs.realpathSync.native(outputParent) !== outputParent || fs.lstatSync(outputParent).isSymbolicLink())
        throw new Error("guest preparation output root is not fresh");

    const fixtureBytes = buildWindowsBaselineGuestFixtureBundle({sourceSha: input.candidate.sourceSha,
        manifest: input.fixture.manifest, populatedRoot: input.fixture.populatedRoot,
        resetRoot: input.fixture.resetRoot});
    const runtimeBytes = buildWindowsBaselineGuestRuntimeBundle({sourceSha: context.sourceSha,
        nonce: context.nonce, files: runtimeFiles});
    const sourceByPath = new Map(runtimeFiles.map(record => [record.relativePath, record.source]));
    /*
     * The whole hosted context reaches the guest. Stage 3 compares what the guest publishes against
     * what it seeded, so narrowing this to the five identity fields made that comparison impossible
     * to satisfy - the guest cannot echo an `environment` it was never handed.
     */
    const documents = buildWindowsBaselineGuestSeedDocuments({context: structuredClone(context),
        cpuidProbe: ((probe) => ({bytes: probe.bytes, sha256: probe.sha256}))(
            input.probes[PROBES.findIndex(([role]) => role === CPUID_PROBE_ROLE)]),
    candidate: {artifactName: input.candidate.artifactName, provenance,
        sourceSha: input.candidate.sourceSha,
        bytes: input.candidate.file.bytes, sha256: input.candidate.file.sha256},
    fixtureBundle: {bytes: String(fixtureBytes.length),
        sha256: sha256(fixtureBytes)}, candidateController: ((source) => ({bytes: source.bytes,
            sha256: source.sha256}))(sourceByPath.get(
            "scripts/qualification/windows-native-candidate-controller.ps1")),
    cleanStopController: ((source) => ({bytes: source.bytes, sha256: source.sha256}))(sourceByPath.get(
        "scripts/qualification/windows-clean-stop-controller.ps1")), imageVersion: input.imageVersion,
    manifestSha256: input.manifestSha256});

    fs.mkdirSync(input.outputRoot, {mode: DIRECTORY_MODE});
    const files = [writeVerified(input.outputRoot, "node.exe", nodeBytes),
        writeVerified(input.outputRoot, "request.json", Buffer.from(`${JSON.stringify(documents.request)}\n`)),
        writeVerified(input.outputRoot, "execution.json", Buffer.from(`${JSON.stringify(documents.execution)}\n`)),
        writeVerified(input.outputRoot, "fixture-bundle.json", fixtureBytes),
        writeVerified(input.outputRoot, "guest-runtime.json", runtimeBytes),
        writeVerified(input.outputRoot, "runtime-installer.ps1", installerBytes),
        ...PROBES.map(([, name], index) => writeVerified(input.outputRoot, name, probeBytes[index]))];
    return Object.freeze({schemaVersion: SCHEMA_VERSION, kind: KIND, status: "prepared", qualifying: false,
        releaseGatesCleared: Object.freeze([]), context: structuredClone(context), root: input.outputRoot,
        files: Object.freeze(files)});
}

export const CPU_FLOOR_GUEST_PREPARATION_CONSTANTS = Object.freeze({CPUID_PROBE_ROLE,
    DIRECTORY_MODE, FILE_MODE, KIND, NODE_RUNTIME_SHA256, PROBES, PUBLISHED_CANDIDATE_SOURCE_SHA,
    SCHEMA_VERSION});
