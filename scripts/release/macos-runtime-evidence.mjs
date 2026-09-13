import fs from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";
import {buildSandboxProfile, validateProbeResult} from "../qualification/macos-isolation.mjs";
import {buildMacosRuntimeProfile, buildMacosSeedProfile}
    from "../qualification/verify-macos-standalone.mjs";

const SCHEMA_VERSION = 1;
const SINGLE_LINK = 1;
const KIBIBYTE = 1024;
const EVIDENCE_LIMIT_BYTES = 1024 * KIBIBYTE;
const PROFILE_LIMIT_BYTES = 64 * KIBIBYTE;
const SOURCE_SENTINEL_LIMIT_BYTES = 1024 * KIBIBYTE;
const SIDECAR_BYTES = 65;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const CANARY_RUN_ID_PATTERN = /^[a-f0-9]{48}$/;
const DENIAL_CODES = new Set(["EACCES", "EPERM"]);
const DENIAL_KEYS = ["tcp4", "tcp6", "udp4", "udp6"];
const VERIFIER_FILES = ["check-artifact.mjs", "fixture.mjs", "macos-isolation.mjs", "safety.mjs",
    "sqlite-check.mjs"];
const RUNTIME_RECORD_FILE = "macos-runtime-isolation.json";
const RUNTIME_PROFILE_FILE = "macos-runtime-profile.sb";
const CANARY_RECORD_FILE = "macos-canary.json";
const CANARY_PROFILE_FILE = "macos-canary-profile.sb";
const CANARY_SOURCE_PROFILE_FILE = "macos-isolation.sb";
const SOURCE_SENTINEL_FILE = "package.json";
const SANDBOX_EXECUTABLE = "/usr/bin/sandbox-exec";
const QUALIFICATION_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
    "../qualification");
const TRUSTED_SOURCE_SENTINEL = path.resolve(QUALIFICATION_DIRECTORY, "../../package.json");

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

const assertExactKeys = (value, keys, label) => {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort()))
        throw new Error(`${label} has an unexpected shape`);
};

const assertSha256 = (value, label) => {
    if (!SHA256_PATTERN.test(value ?? "")) throw new Error(`${label} is not a lowercase SHA-256 digest`);
};

const checkedEvidenceFile = async (directory, file, limit) => {
    const target = path.join(directory, file);
    let stats;
    let sidecarStats;
    try {
        [stats, sidecarStats] = await Promise.all([
            fs.promises.lstat(target), fs.promises.lstat(`${target}.sha256`)
        ]);
    } catch (error) {
        if (error.code === "ENOENT") throw new Error(`Missing macOS evidence file: ${file}`);
        throw error;
    }
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== SINGLE_LINK
        || stats.size === 0 || stats.size > limit)
        throw new Error(`macOS evidence is not an ordinary bounded file: ${file}`);
    if (!sidecarStats.isFile() || sidecarStats.isSymbolicLink() || sidecarStats.nlink !== SINGLE_LINK
        || sidecarStats.size !== SIDECAR_BYTES)
        throw new Error(`macOS evidence sidecar is not an ordinary bounded file: ${file}.sha256`);
    const [bytes, sidecar] = await Promise.all([
        fs.promises.readFile(target), fs.promises.readFile(`${target}.sha256`, "utf8")
    ]);
    const digest = sha256(bytes);
    if (sidecar !== `${digest}\n`) throw new Error(`macOS evidence SHA-256 mismatch: ${file}`);
    return {bytes, sha256: digest};
};

const checkedJson = async (directory, file) => {
    const checked = await checkedEvidenceFile(directory, file, EVIDENCE_LIMIT_BYTES);
    let value;
    try {
        value = JSON.parse(checked.bytes);
    } catch {
        throw new Error(`Invalid macOS evidence JSON: ${file}`);
    }
    return {...checked, value};
};

const assertMacPath = (value, label) => {
    if (typeof value !== "string" || !value.startsWith("/") || path.posix.normalize(value) !== value
        || value.includes("\0")) throw new Error(`${label} must be a canonical absolute macOS path`);
};

const isStrictChild = (parent, child) => child.startsWith(`${parent}/`);

const validateDenial = (value, label) => {
    assertExactKeys(value, ["denied", "code", "timedOut"], label);
    if (value.denied !== true || value.timedOut !== false || !DENIAL_CODES.has(value.code))
        throw new Error(`${label} did not prove an immediate policy denial`);
};

const validateHelperDenial = (value, label) => {
    assertExactKeys(value, ["inherited", "forbidden"], label);
    if (value.inherited !== true) throw new Error(`${label} did not prove inherited policy`);
    assertExactKeys(value.forbidden, DENIAL_KEYS, `${label} forbidden probes`);
    for (const key of DENIAL_KEYS) validateDenial(value.forbidden[key], `${label} ${key}`);
};

const validateFullProbe = (probe, label) => {
    validateProbeResult(probe);
    assertExactKeys(probe, ["schemaVersion", "loopback", "temporaryFile", "sourceRoot",
        "sourceSentinel", "forbidden", "helper"], label);
    assertExactKeys(probe.loopback, ["roundTrip", "host"], `${label} loopback`);
    assertExactKeys(probe.temporaryFile, ["roundTrip"], `${label} temporary file`);
    validateDenial(probe.sourceRoot, `${label} source root`);
    validateDenial(probe.sourceSentinel, `${label} source sentinel`);
    assertExactKeys(probe.forbidden, DENIAL_KEYS, `${label} forbidden probes`);
    for (const key of DENIAL_KEYS) validateDenial(probe.forbidden[key], `${label} ${key}`);
    validateHelperDenial(probe.helper, `${label} helper`);
};

const validateNetworkIsolation = (summary, canary, trustedPackageSha256) => {
    const {networkIsolation} = summary;
    assertExactKeys(networkIsolation, ["kind", "sourceRoot", "sourceSentinel", "workRoot", "probe"],
        "Runtime network-isolation evidence");
    if (networkIsolation.kind !== "macos-seatbelt")
        throw new Error("Runtime network-isolation kind is invalid");
    for (const [label, value] of [["Source root", networkIsolation.sourceRoot],
        ["Source sentinel", networkIsolation.sourceSentinel], ["Work root", networkIsolation.workRoot]])
        assertMacPath(value, label);
    if (networkIsolation.sourceSentinel !== `${networkIsolation.sourceRoot}/${SOURCE_SENTINEL_FILE}`
        || !isStrictChild(networkIsolation.sourceRoot, networkIsolation.sourceSentinel))
        throw new Error("Runtime source sentinel is not the expected strict source child");
    if (isStrictChild(networkIsolation.sourceRoot, networkIsolation.workRoot)
        || isStrictChild(networkIsolation.workRoot, networkIsolation.sourceRoot)
        || networkIsolation.workRoot === networkIsolation.sourceRoot)
        throw new Error("Runtime work root overlaps the source checkout");
    if (canary.sourceRoot !== networkIsolation.sourceRoot
        || canary.sourceSentinel.path !== networkIsolation.sourceSentinel)
        throw new Error("Canary and runtime source context do not match");
    if (summary.originalBuildRoot !== networkIsolation.sourceRoot
        || summary.work !== networkIsolation.workRoot
        || summary.fixtures?.populated?.root !== networkIsolation.workRoot)
        throw new Error("Runtime isolation paths do not match the verified fixture context");
    const expectedResetRoot = `${path.posix.dirname(networkIsolation.workRoot)}/reset`;
    assertMacPath(summary.fixtures?.reset?.root, "Runtime reset root");
    if (summary.fixtures.reset.root !== expectedResetRoot
        || summary.fixtures.reset.root === networkIsolation.workRoot)
        throw new Error("Runtime reset root does not match the distinct owned fixture context");
    if (summary.packageSha256 !== trustedPackageSha256)
        throw new Error("Runtime package digest does not match the trusted checkout");
    if (!SHA256_PATTERN.test(summary.fixtureManifest?.sha256 ?? ""))
        throw new Error("Runtime fixture handoff digest is invalid");
    validateFullProbe(networkIsolation.probe, "Runtime isolation probe");
};

const validateCanary = ({canary, architecture, profileSha256, trustedProbeSha256, trustedSentinel}) => {
    assertExactKeys(canary, ["schemaVersion", "status", "runId", "architecture", "platform", "os",
        "runnerImage", "sourceRoot", "sourceRootPreSandboxReadable", "sourceSentinel",
        "sandboxExecutable", "profile", "probeScriptSha256", "sandbox", "probe", "cleanup"],
    "macOS canary record");
    if (canary.schemaVersion !== SCHEMA_VERSION || canary.status !== "passed"
        || canary.architecture !== architecture || canary.platform !== "darwin"
        || !CANARY_RUN_ID_PATTERN.test(canary.runId ?? ""))
        throw new Error("macOS canary identity is invalid");
    assertMacPath(canary.sourceRoot, "Canary source root");
    if (canary.sourceRoot === "/") throw new Error("Canary source root cannot be the filesystem root");
    assertExactKeys(canary.os, ["version", "release"], "Canary operating-system identity");
    assertExactKeys(canary.runnerImage, ["os", "version"], "Canary runner-image identity");
    for (const [label, value] of [["Canary OS version", canary.os.version],
        ["Canary OS release", canary.os.release], ["Canary runner image", canary.runnerImage.os],
        ["Canary runner image version", canary.runnerImage.version]])
        if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is missing`);
    assertExactKeys(canary.sourceSentinel, ["path", "byteLength", "sha256", "preSandboxReadable"],
        "Canary source sentinel");
    assertMacPath(canary.sourceSentinel.path, "Canary source sentinel path");
    if (canary.sourceRootPreSandboxReadable !== true || canary.sourceSentinel.preSandboxReadable !== true
        || !Number.isSafeInteger(canary.sourceSentinel.byteLength) || canary.sourceSentinel.byteLength <= 0
        || canary.sourceSentinel.byteLength > SOURCE_SENTINEL_LIMIT_BYTES)
        throw new Error("Canary did not prove bounded source reads before sandboxing");
    assertSha256(canary.sourceSentinel.sha256, "Canary source sentinel digest");
    if (canary.sourceSentinel.byteLength !== trustedSentinel.byteLength
        || canary.sourceSentinel.sha256 !== trustedSentinel.sha256)
        throw new Error("Canary source sentinel does not match the trusted checkout");
    assertExactKeys(canary.profile, ["path", "sha256"], "Canary profile");
    if (canary.profile.path !== CANARY_SOURCE_PROFILE_FILE || canary.profile.sha256 !== profileSha256)
        throw new Error("Canary profile binding is invalid");
    assertExactKeys(canary.sandboxExecutable, ["path", "sha256"], "Canary sandbox executable");
    if (canary.sandboxExecutable.path !== SANDBOX_EXECUTABLE)
        throw new Error("Canary sandbox executable path is invalid");
    assertSha256(canary.sandboxExecutable.sha256, "Canary sandbox executable digest");
    if (canary.probeScriptSha256 !== trustedProbeSha256)
        throw new Error("Canary probe code does not match the trusted verifier");
    assertExactKeys(canary.sandbox, ["status", "signal", "stdout", "stderr", "error"], "Canary sandbox result");
    if (canary.sandbox.status !== 0 || canary.sandbox.signal !== null || canary.sandbox.error !== null)
        throw new Error("Canary sandbox did not exit cleanly");
    if (typeof canary.sandbox.stdout !== "string" || typeof canary.sandbox.stderr !== "string")
        throw new Error("Canary sandbox output is malformed");
    assertExactKeys(canary.cleanup, ["temporaryFilesRemoved", "processTreeExitProven"], "Canary cleanup");
    if (canary.cleanup.temporaryFilesRemoved !== true || canary.cleanup.processTreeExitProven !== true)
        throw new Error("Canary cleanup is incomplete");
    validateFullProbe(canary.probe, "Canary isolation probe");
    let emittedProbe;
    try {
        emittedProbe = JSON.parse(canary.sandbox.stdout.trim().split(/\r?\n/).at(-1));
    } catch {
        throw new Error("Canary sandbox output did not retain its probe JSON");
    }
    if (JSON.stringify(emittedProbe) !== JSON.stringify(canary.probe))
        throw new Error("Canary retained probe differs from the sandbox output");
};

const trustedVerifierDigests = async () => Object.fromEntries(await Promise.all(VERIFIER_FILES.map(async file =>
    [file, sha256(await fs.promises.readFile(path.join(QUALIFICATION_DIRECTORY, file)))])));

export const inspectMacosRuntimeEvidence = async (options) => {
    if (!COMMIT_PATTERN.test(options.sourceSha ?? "")) throw new Error("macOS source SHA is invalid");
    if (!SHA256_PATTERN.test(options.artifactSha256 ?? "")
        || !SHA256_PATTERN.test(options.summarySha256 ?? ""))
        throw new Error("macOS artifact or summary digest is invalid");
    if (!["x64", "arm64"].includes(options.architecture))
        throw new Error("macOS architecture is invalid");
    if (!Number.isSafeInteger(Number(options.runId)) || Number(options.runId) <= 0
        || !Number.isSafeInteger(Number(options.runAttempt)) || Number(options.runAttempt) <= 0)
        throw new Error("macOS run identity is invalid");
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository ?? ""))
        throw new Error("macOS repository identity is invalid");

    const [recordFile, runtimeProfile, canaryFile, canaryProfile, summaryFile, verifierFiles,
        trustedSentinelBytes] =
        await Promise.all([
            checkedJson(options.directory, RUNTIME_RECORD_FILE),
            checkedEvidenceFile(options.directory, RUNTIME_PROFILE_FILE, PROFILE_LIMIT_BYTES),
            checkedJson(options.directory, CANARY_RECORD_FILE),
            checkedEvidenceFile(options.directory, CANARY_PROFILE_FILE, PROFILE_LIMIT_BYTES),
            checkedJson(options.directory, "qualification-summary.json"),
            trustedVerifierDigests(),
            fs.promises.readFile(TRUSTED_SOURCE_SENTINEL)
        ]);
    if (summaryFile.sha256 !== options.summarySha256)
        throw new Error("macOS summary digest binding is invalid");
    const expectedRuntimeProfile = Buffer.from(buildMacosRuntimeProfile());
    const expectedCanaryProfile = Buffer.from(buildSandboxProfile());
    if (!runtimeProfile.bytes.equals(expectedRuntimeProfile)
        || runtimeProfile.sha256 !== sha256(expectedRuntimeProfile))
        throw new Error("macOS runtime profile does not match trusted policy code");
    if (!canaryProfile.bytes.equals(expectedCanaryProfile)
        || canaryProfile.sha256 !== sha256(expectedCanaryProfile))
        throw new Error("macOS canary profile does not match trusted policy code");

    const canary = canaryFile.value;
    const trustedPackageSha256 = sha256(trustedSentinelBytes);
    validateCanary({canary, architecture: options.architecture,
        profileSha256: canaryProfile.sha256,
        trustedProbeSha256: verifierFiles["macos-isolation.mjs"],
        trustedSentinel: {byteLength: trustedSentinelBytes.length, sha256: trustedPackageSha256}});
    validateNetworkIsolation(summaryFile.value, canary, trustedPackageSha256);

    const record = recordFile.value;
    assertExactKeys(record, ["schemaVersion", "status", "sourceSha", "artifactSha256", "architecture",
        "platform", "runId", "runAttempt", "repository", "summarySha256", "profileSha256",
        "canarySha256", "canaryProfileSha256", "handoffSha256", "seed", "canaryHelper",
        "candidateFile", "verifierFiles"], "macOS runtime isolation record");
    if (record.schemaVersion !== SCHEMA_VERSION || record.status !== "passed" || record.platform !== "darwin"
        || record.sourceSha !== options.sourceSha || record.artifactSha256 !== options.artifactSha256
        || record.architecture !== options.architecture || record.runId !== Number(options.runId)
        || record.runAttempt !== Number(options.runAttempt) || record.repository !== options.repository
        || record.summarySha256 !== summaryFile.sha256 || record.profileSha256 !== runtimeProfile.sha256
        || record.canarySha256 !== canaryFile.sha256
        || record.canaryProfileSha256 !== canaryProfile.sha256)
        throw new Error("macOS runtime isolation record is not bound to the candidate context");
    if (record.handoffSha256 !== summaryFile.value.fixtureManifest.sha256)
        throw new Error("macOS fixture handoff digest does not match the verified summary");
    assertExactKeys(record.seed, ["profileSha256", "sandboxStatus", "sandboxSignal", "probe"],
        "macOS seed evidence");
    if (record.seed.profileSha256 !== sha256(Buffer.from(buildMacosSeedProfile()))
        || record.seed.sandboxStatus !== 0 || record.seed.sandboxSignal !== null)
        throw new Error("macOS seed sandbox evidence is invalid");
    validateHelperDenial(record.seed.probe, "macOS seed denial probe");
    validateHelperDenial(record.canaryHelper, "macOS retained canary helper probe");
    if (JSON.stringify(record.canaryHelper) !== JSON.stringify(canary.probe.helper))
        throw new Error("macOS retained canary helper was substituted");
    assertExactKeys(record.candidateFile, ["name", "sha256"], "macOS candidate identity");
    const expectedCandidate = `MySpeed-macos-${options.architecture}`;
    if (record.candidateFile.name !== expectedCandidate
        || record.candidateFile.sha256 !== options.artifactSha256)
        throw new Error("macOS candidate identity does not match the release artifact");
    assertExactKeys(record.verifierFiles, VERIFIER_FILES, "macOS verifier closure");
    for (const file of VERIFIER_FILES) {
        assertSha256(record.verifierFiles[file], `macOS verifier ${file}`);
        if (record.verifierFiles[file] !== verifierFiles[file])
            throw new Error(`macOS verifier ${file} does not match the trusted checkout`);
    }

    return {
        architecture: options.architecture,
        artifactSha256: options.artifactSha256,
        sourceSha: options.sourceSha,
        runId: Number(options.runId),
        runAttempt: Number(options.runAttempt),
        repository: options.repository,
        summarySha256: summaryFile.sha256,
        isolationRecordSha256: recordFile.sha256,
        runtimeProfileSha256: runtimeProfile.sha256,
        canarySha256: canaryFile.sha256,
        canaryProfileSha256: canaryProfile.sha256,
        seedProfileSha256: record.seed.profileSha256,
        verifierFiles
    };
};
