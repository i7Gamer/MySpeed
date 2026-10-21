import fs from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {CANDIDATE_PROVENANCE, STAGE3_CONSTANTS} from "../qualification/linux-windows-cpu-floor-stage3.mjs";
import {PRERELEASE_CPU_FLOOR_CONSTANTS} from "./prerelease-cpu-floor.mjs";

/*
 * Reads the Windows CPU-floor evidence a gated qualification run retains in the
 * `qualified-windows-cpu-floor` artifact, and binds it to the run and to the exact Windows
 * executable the release publishes.
 *
 * The harness that produced it calls itself non-qualifying (`qualifying: false`), because on its
 * own it only establishes that this commit's build ran on a floor-level CPU. The release gate is
 * what this module adds: the run, the attempt, the commit, both Actions artifacts and both Windows
 * release assets have to be the ones the sealed manifest names, or nothing is recorded.
 */

const SCHEMA_VERSION = 1;
const SINGLE_LINK = 1;
const MEBIBYTE = 1024 * 1024;
const EVIDENCE_LIMIT_BYTES = 4 * MEBIBYTE;
const SIDECAR_BYTES = 65;
const REQUIRED_RUN_ATTEMPT = 1;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const NONCE_PATTERN = /^[a-f0-9]{32}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DIGEST_PREFIX = "sha256:";
const ARTIFACT_NAME = "qualified-windows-cpu-floor";
const PROVENANCE_FILE = "windows-cpu-floor-provenance.json";
const INSPECTION_FILE = "windows-cpu-floor-inspection.json";
const PROVENANCE_KIND = "myspeed-qualification-windows-cpu-floor-provenance";
const INSPECTION_KIND = "myspeed-prerelease-cpu-floor-evidence";
const ESTABLISHES = "branch-build-runs-on-cpu-floor";
const CANDIDATE_ARTIFACT_NAME = STAGE3_CONSTANTS.BASELINE_ARTIFACT;
const X64_ASSET_NAME = "MySpeed-windows-x64.exe";
const PROBE_ARTIFACT_NAME = "windows-cpu-readiness-evidence";
const STAGED_FILE_NAME = PRERELEASE_CPU_FLOOR_CONSTANTS.STAGE3_STAGED_CANDIDATE_NAME;
const MEMBERS = [INSPECTION_FILE, `${INSPECTION_FILE}.sha256`, PROVENANCE_FILE, `${PROVENANCE_FILE}.sha256`].sort();
const PROVENANCE_KEYS = ["candidate", "closureManifestSha256", "inspectionSha256", "installerConfirmation",
    "kind", "nonce", "probe", "repository", "runAttempt", "runId", "schemaVersion", "sourceSha", "status"];
const PROVENANCE_CANDIDATE_KEYS = ["archiveBytes", "archiveDigest", "artifactId", "artifactName", "fileBytes",
    "fileName", "fileSha256"];
const PROVENANCE_PROBE_KEYS = ["archiveBytes", "archiveDigest", "artifactId", "artifactName"];

/*
 * Every artifact a gated qualification run uploads besides the base release set: the two from the
 * readiness probe and the five from the CPU-floor candidate workflow. One list, so the workflow,
 * the manifest builder and the promotion preflight cannot disagree about it.
 */
export const CPU_FLOOR_ARTIFACTS = Object.freeze([
    ARTIFACT_NAME,
    "windows-cpu-floor-closure",
    "windows-cpu-floor-diagnostics",
    "windows-cpu-floor-evidence",
    "windows-cpu-floor-guest-bundle",
    "windows-cpu-readiness-closure",
    PROBE_ARTIFACT_NAME
]);

export const WINDOWS_CPU_FLOOR_EVIDENCE_CONSTANTS = Object.freeze({
    ARTIFACT_NAME, CANDIDATE_ARTIFACT_NAME, EVIDENCE_LIMIT_BYTES, INSPECTION_FILE, PROBE_ARTIFACT_NAME,
    PROVENANCE_FILE, PROVENANCE_KIND, REQUIRED_RUN_ATTEMPT
});

/*
 * The one place that knows where the accepted inspection keeps each claim this gate relies on. The
 * paths are derived from `inspectPrereleaseCpuFloorEvidence` (prerelease-cpu-floor.mjs) and the
 * baseline guest result it carries; they have not yet been compared with a real accepted file, so a
 * mismatch found there is fixed here and nowhere else.
 */
const INSPECTION_CLAIM_PATHS = Object.freeze({
    kind: ["kind"],
    accepted: ["accepted"],
    qualifying: ["qualifying"],
    establishes: ["establishes"],
    classification: ["classification"],
    repository: ["context", "repository"],
    sourceSha: ["context", "sourceSha"],
    runId: ["context", "runId"],
    runAttempt: ["context", "runAttempt"],
    nonce: ["context", "nonce"],
    candidateProvenance: ["candidate", "provenance"],
    candidateSourceSha: ["candidate", "sourceSha"],
    candidateArtifactName: ["candidate", "artifactName"],
    candidateArtifactId: ["candidate", "artifactId"],
    candidateArchiveBytes: ["candidate", "archive", "bytes"],
    candidateArchiveSha256: ["candidate", "archive", "sha256"],
    candidateFileSha256: ["candidate", "file", "sha256"],
    stagedFileSha256: ["acquiredCandidate", "stagedFile", "sha256"],
    guestCandidateSha256: ["guest", "candidate", "sha256"],
    guestCandidateSourceSha: ["guest", "candidate", "sourceSha"],
    guestCpuModel: ["guest", "cpu", "model"],
    guestSse42: ["guest", "cpu", "sse42"],
    guestPopcnt: ["guest", "cpu", "popcnt"],
    guestAvx: ["guest", "cpu", "avx"],
    guestAvx2: ["guest", "cpu", "avx2"],
    guestOsxsave: ["guest", "cpu", "osxsave"]
});

export const WINDOWS_CPU_FLOOR_INSPECTION_CLAIM_PATHS = INSPECTION_CLAIM_PATHS;

const fail = (message) => {
    throw new Error(`Windows CPU-floor evidence ${message}`);
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const readClaims = (inspection) => Object.fromEntries(Object.entries(INSPECTION_CLAIM_PATHS).map(([claim, keys]) =>
    [claim, keys.reduce((value, key) => value !== null && typeof value === "object" ? value[key] : undefined,
        inspection)]));

const assertExactKeys = (value, keys, label) => {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort()))
        fail(`${label} has an unexpected shape`);
};

// Plain decimal only: Number() alone also reads " 5", "0x10" and "1e3" as integers.
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/u;

const positiveInteger = (value, label) => {
    const number = typeof value === "number" || POSITIVE_DECIMAL.test(String(value)) ? Number(value) : NaN;
    if (!Number.isSafeInteger(number) || number <= 0) fail(`${label} is invalid`);
    return number;
};

const checkedFile = async (directory, file) => {
    const target = path.join(directory, file);
    let stats;
    let sidecarStats;
    try {
        [stats, sidecarStats] = await Promise.all([
            fs.promises.lstat(target), fs.promises.lstat(`${target}.sha256`)
        ]);
    } catch (error) {
        if (error.code === "ENOENT") fail(`file is missing: ${file}`);
        throw error;
    }
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== SINGLE_LINK
        || stats.size === 0 || stats.size > EVIDENCE_LIMIT_BYTES)
        fail(`is not an ordinary bounded file: ${file}`);
    if (!sidecarStats.isFile() || sidecarStats.isSymbolicLink() || sidecarStats.nlink !== SINGLE_LINK
        || sidecarStats.size !== SIDECAR_BYTES)
        fail(`sidecar is not an ordinary bounded file: ${file}.sha256`);
    const [bytes, sidecar] = await Promise.all([
        fs.promises.readFile(target), fs.promises.readFile(`${target}.sha256`, "utf8")
    ]);
    const digest = sha256(bytes);
    if (sidecar !== `${digest}\n`) fail(`SHA-256 mismatch: ${file}`);
    let value;
    try {
        value = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes));
    } catch {
        fail(`JSON is invalid: ${file}`);
    }
    return {sha256: digest, value};
};

const assertMembers = async (directory) => {
    let names;
    try {
        names = (await fs.promises.readdir(directory)).sort();
    } catch (error) {
        if (error.code === "ENOENT") fail(`artifact is missing: ${ARTIFACT_NAME}`);
        throw error;
    }
    // Checked after the files themselves so a missing file is reported by name.
    return () => {
        if (JSON.stringify(names) !== JSON.stringify(MEMBERS)) fail(`artifact holds unexpected members: ${names.join(", ")}`);
    };
};

const actionsArtifact = (artifacts, name) => {
    const matching = artifacts.filter((artifact) => artifact?.name === name);
    if (matching.length !== 1) fail(`has no single Actions artifact record for ${name}`);
    return matching[0];
};

const assertOptions = (options) => {
    if (!COMMIT_PATTERN.test(options.sourceSha ?? "")) fail("source SHA option is invalid");
    if (!REPOSITORY_PATTERN.test(options.repository ?? "")) fail("repository option is invalid");
    const runId = positiveInteger(options.runId, "run ID option");
    const runAttempt = positiveInteger(options.runAttempt, "run attempt option");
    for (const [asset, name] of [[options.baselineAsset, CANDIDATE_ARTIFACT_NAME], [options.x64Asset, X64_ASSET_NAME]])
        if (asset?.name !== name || !SHA256_PATTERN.test(asset.sha256 ?? "") || !Number.isSafeInteger(asset.size))
            fail(`release asset option is invalid: ${name}`);
    if (!Array.isArray(options.actionsArtifacts)) fail("Actions artifact metadata is missing");
    return {runId, runAttempt};
};

const assertProvenance = (provenance, options, run, candidateArtifact, probeArtifact, inspectionSha256) => {
    assertExactKeys(provenance, PROVENANCE_KEYS, "provenance");
    assertExactKeys(provenance.candidate, PROVENANCE_CANDIDATE_KEYS, "provenance candidate");
    assertExactKeys(provenance.probe, PROVENANCE_PROBE_KEYS, "provenance probe");
    if (provenance.schemaVersion !== SCHEMA_VERSION || provenance.kind !== PROVENANCE_KIND
        || provenance.status !== "passed") fail("provenance did not record a passed check");
    if (provenance.repository !== options.repository || provenance.sourceSha !== options.sourceSha
        || provenance.runId !== run.runId || provenance.runAttempt !== run.runAttempt)
        fail("provenance is not bound to this qualification run");
    if (!NONCE_PATTERN.test(provenance.nonce ?? "")) fail("provenance nonce is invalid");
    const {candidate, probe} = provenance;
    if (candidate.artifactName !== CANDIDATE_ARTIFACT_NAME || candidate.artifactId !== candidateArtifact.id
        || candidate.archiveDigest !== candidateArtifact.archiveDigest
        || candidate.archiveBytes !== candidateArtifact.archiveSize)
        fail("provenance candidate is not this run's Actions artifact");
    if (candidate.fileName !== STAGED_FILE_NAME || candidate.fileSha256 !== options.baselineAsset.sha256
        || candidate.fileBytes !== options.baselineAsset.size)
        fail("provenance tested executable is not the published baseline asset");
    if (probe.artifactName !== PROBE_ARTIFACT_NAME || probe.artifactId !== probeArtifact.id
        || probe.archiveDigest !== probeArtifact.archiveDigest || probe.archiveBytes !== probeArtifact.archiveSize)
        fail("provenance probe is not this run's readiness artifact");
    if (!PRERELEASE_CPU_FLOOR_CONSTANTS.STAGE3_INSTALLER_CONFIRMATIONS.includes(provenance.installerConfirmation))
        fail("provenance installer confirmation is not an admitted policy");
    if (!SHA256_PATTERN.test(provenance.closureManifestSha256 ?? ""))
        fail("provenance closure manifest digest is invalid");
    if (provenance.inspectionSha256 !== inspectionSha256)
        fail("provenance does not bind the retained inspection");
};

const assertInspection = (claims, provenance) => {
    if (claims.kind !== INSPECTION_KIND || claims.accepted !== true || claims.qualifying !== false
        || claims.establishes !== ESTABLISHES || claims.classification !== STAGE3_CONSTANTS.CLASSIFICATION)
        fail("inspection is not an accepted CPU-floor harness result");
    if (claims.repository !== provenance.repository || claims.sourceSha !== provenance.sourceSha
        || claims.runId !== String(provenance.runId) || claims.runAttempt !== String(provenance.runAttempt)
        || claims.nonce !== provenance.nonce)
        fail("inspection context is not this qualification run");
    const {candidate} = provenance;
    if (claims.candidateProvenance !== CANDIDATE_PROVENANCE.branch || claims.candidateSourceSha !== provenance.sourceSha
        || claims.candidateArtifactName !== CANDIDATE_ARTIFACT_NAME
        || claims.candidateArtifactId !== String(candidate.artifactId)
        || claims.candidateArchiveBytes !== String(candidate.archiveBytes)
        || claims.candidateArchiveSha256 !== candidate.archiveDigest.slice(DIGEST_PREFIX.length))
        fail("inspection candidate is not the recorded Actions artifact");
    if (claims.candidateFileSha256 !== candidate.fileSha256 || claims.stagedFileSha256 !== candidate.fileSha256
        || claims.guestCandidateSha256 !== candidate.fileSha256
        || claims.guestCandidateSourceSha !== provenance.sourceSha)
        fail("inspection guest did not run the recorded executable");
    if (claims.guestCpuModel !== STAGE3_CONSTANTS.CPU_MODEL || claims.guestSse42 !== true
        || claims.guestPopcnt !== true || claims.guestAvx !== false || claims.guestAvx2 !== false
        || claims.guestOsxsave !== false)
        fail("inspection guest CPU does not prove the AVX-disabled floor");
};

export const inspectWindowsCpuFloorEvidence = async (options) => {
    const run = assertOptions(options);
    if (run.runAttempt !== REQUIRED_RUN_ATTEMPT)
        fail(`is only bound on run attempt ${REQUIRED_RUN_ATTEMPT}; dispatch a fresh qualification`);
    if (options.baselineAsset.sha256 !== options.x64Asset.sha256)
        fail("cannot cover both Windows assets because their bytes differ");
    const candidateArtifact = actionsArtifact(options.actionsArtifacts, CANDIDATE_ARTIFACT_NAME);
    const probeArtifact = actionsArtifact(options.actionsArtifacts, PROBE_ARTIFACT_NAME);

    const checkMembers = await assertMembers(options.directory);
    const inspectionFile = await checkedFile(options.directory, INSPECTION_FILE);
    const provenanceFile = await checkedFile(options.directory, PROVENANCE_FILE);
    checkMembers();
    const provenance = provenanceFile.value;
    assertProvenance(provenance, options, run, candidateArtifact, probeArtifact, inspectionFile.sha256);
    const claims = readClaims(inspectionFile.value);
    assertInspection(claims, provenance);

    return {
        status: "passed",
        verifiedAssets: [CANDIDATE_ARTIFACT_NAME, X64_ASSET_NAME],
        executableSha256: provenance.candidate.fileSha256,
        candidateArtifact: {name: CANDIDATE_ARTIFACT_NAME, id: candidateArtifact.id,
            archiveDigest: candidateArtifact.archiveDigest},
        probeArtifact: {name: PROBE_ARTIFACT_NAME, id: probeArtifact.id, archiveDigest: probeArtifact.archiveDigest},
        guestCpu: {model: claims.guestCpuModel, vector: STAGE3_CONSTANTS.CPU_VECTOR, sse42: claims.guestSse42,
            popcnt: claims.guestPopcnt, avx: claims.guestAvx, avx2: claims.guestAvx2, osxsave: claims.guestOsxsave},
        harnessClassification: claims.classification,
        installerConfirmation: provenance.installerConfirmation,
        sourceSha: options.sourceSha,
        runId: run.runId,
        runAttempt: run.runAttempt,
        repository: options.repository,
        provenancePath: PROVENANCE_FILE,
        provenanceSha256: provenanceFile.sha256,
        inspectionPath: INSPECTION_FILE,
        inspectionSha256: inspectionFile.sha256
    };
};
