/*
 * Binds the Windows CPU-floor subject for a branch build.
 *
 * The published v1.6.1 target (post-release-target.mjs) anchors its evidence to release assets and
 * to a qualification manifest sealed at release time. Neither exists before a release, and the
 * archive that manifest lives in expires on a seven-day artifact retention, so that binder can
 * describe exactly one frozen release and only until its retention lapses.
 *
 * This binder asks the same questions of a branch build and answers them from the run that produced
 * the binary. The digest still arrives as GitHub's own metadata about an artifact rather than as a
 * claim from the caller, which is the property that made the published table worth having; what it
 * no longer offers is a prior sealed result to reproduce, because an unreleased commit has none.
 * The run therefore establishes that the CPU-floor build starts and reports on a floor-level CPU,
 * not that it reproduces a promise made earlier.
 */

const SCHEMA_VERSION = 1;
const REPOSITORY = "i7Gamer/MySpeed";
const TARGET_KIND = "myspeed-prerelease-windows-cpu-floor-target";
const ACQUISITION_KIND = "myspeed-prerelease-windows-exe-acquisition-plan";
const BASELINE_ARTIFACT_NAME = "MySpeed-windows-x64-baseline.exe";
const BASELINE_ASSET_ROLE = "baseline";
const DIGEST_PREFIX = "sha256:";
const MINIMUM_RUN_ATTEMPT = 1;
const MINIMUM_IDENTIFIER = 1;
const MINIMUM_ARTIFACT_BYTES = 1;
const MAXIMUM_ARTIFACT_BYTES = 512 * 1024 * 1024;
const INPUT_KEYS = ["buildArtifact", "candidate", "harnessSourceSha", "observedAt"];
const CANDIDATE_KEYS = ["repository", "sourceSha", "version", "windowsStamp"];
const ARTIFACT_KEYS = ["createdAt", "digest", "expired", "expiresAt", "headSha", "id",
    "name", "repository", "runAttempt", "runId", "size", "updatedAt"];
const HEX_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UTC_SECONDS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const WINDOWS_STAMP_PATTERN = /^\d+\.\d+\.\d+\.\d+$/u;
const VALIDATED_TARGET = Symbol("validated-prerelease-cpu-floor-target");

export const PRERELEASE_CPU_FLOOR_TARGET_CONSTANTS = Object.freeze({
    targetKind: TARGET_KIND, acquisitionKind: ACQUISITION_KIND,
    baselineArtifactName: BASELINE_ARTIFACT_NAME, baselineAssetRole: BASELINE_ASSET_ROLE,
    repository: REPOSITORY, schemaVersion: SCHEMA_VERSION
});

function fail(message) {
    throw new Error(`Invalid pre-release CPU-floor target: ${message}`);
}

function requireExactKeys(value, keys, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)
            || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys)) {
        fail(`${label} must use the closed schema`);
    }
}

function requireEqual(actual, expected, label) {
    if (actual !== expected) fail(`${label} does not match the run identity`);
}

function requirePositiveInteger(value, minimum, label) {
    if (!Number.isSafeInteger(value) || value < minimum) fail(`${label} is not a whole run number`);
}

function requireTimestamp(value, label) {
    if (typeof value !== "string" || !UTC_SECONDS_PATTERN.test(value)
            || !Number.isFinite(Date.parse(value))) {
        fail(`${label} must be a UTC second-resolution timestamp`);
    }
}

function deepFreeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
}

function validateCandidate(candidate, harnessSourceSha) {
    requireExactKeys(candidate, CANDIDATE_KEYS, "candidate");
    requireEqual(candidate.repository, REPOSITORY, "candidate repository");
    if (typeof candidate.sourceSha !== "string" || !HEX_SHA_PATTERN.test(candidate.sourceSha)) {
        fail("candidate source must be a full commit SHA");
    }
    /*
     * Inverted from the published binder, which refuses a harness equal to its candidate because
     * there they are two different things. A branch build is produced by the very commit under
     * test, so the pairing to refuse here is the opposite one: an artifact attributed to a commit
     * other than the one this run checked out.
     */
    if (candidate.sourceSha !== harnessSourceSha) {
        fail("candidate source SHA must be the harness commit");
    }
    if (typeof candidate.version !== "string" || !VERSION_PATTERN.test(candidate.version)) {
        fail("candidate version must be a three-part version");
    }
    if (typeof candidate.windowsStamp !== "string"
            || !WINDOWS_STAMP_PATTERN.test(candidate.windowsStamp)) {
        fail("candidate Windows stamp must be a four-part stamp");
    }
}

function validateBuildArtifact(artifact, candidateSourceSha) {
    requireExactKeys(artifact, ARTIFACT_KEYS, "build artifact");
    requireEqual(artifact.repository, REPOSITORY, "build artifact repository");
    requireEqual(artifact.name, BASELINE_ARTIFACT_NAME, "build artifact name");
    requirePositiveInteger(artifact.id, MINIMUM_IDENTIFIER, "build artifact ID");
    requirePositiveInteger(artifact.runId, MINIMUM_IDENTIFIER, "build artifact run ID");
    requirePositiveInteger(artifact.runAttempt, MINIMUM_RUN_ATTEMPT, "build artifact run attempt");
    if (!Number.isSafeInteger(artifact.size) || artifact.size < MINIMUM_ARTIFACT_BYTES
            || artifact.size > MAXIMUM_ARTIFACT_BYTES) {
        fail("build artifact size is outside the qualified bound");
    }
    if (typeof artifact.digest !== "string" || !artifact.digest.startsWith(DIGEST_PREFIX)
            || !SHA256_PATTERN.test(artifact.digest.slice(DIGEST_PREFIX.length))) {
        fail("build artifact digest must be a prefixed sha256 hex digest");
    }
    if (typeof artifact.headSha !== "string" || artifact.headSha !== candidateSourceSha) {
        fail("build artifact head SHA must be the candidate commit");
    }
    if (artifact.expired !== false) fail("build artifact is expired");
    for (const [value, label] of [[artifact.createdAt, "build artifact creation time"],
        [artifact.updatedAt, "build artifact update time"],
        [artifact.expiresAt, "build artifact expiry"]]) requireTimestamp(value, label);
}

/*
 * The observation has to fall inside the window in which the artifact both existed and was still
 * retrievable, so that a target cannot be bound against an artifact that had already been collected
 * or one that had not yet been produced.
 */
function validateObservation(observedAt, artifact) {
    requireTimestamp(observedAt, "observedAt");
    const observed = Date.parse(observedAt);
    if (observed < Date.parse(artifact.createdAt) || observed >= Date.parse(artifact.expiresAt)) {
        fail("observedAt is outside the build artifact retention interval");
    }
}

export function bindPrereleaseCpuFloorTarget(input) {
    requireExactKeys(input, INPUT_KEYS, "input");
    if (typeof input.harnessSourceSha !== "string"
            || !HEX_SHA_PATTERN.test(input.harnessSourceSha)) {
        fail("harness source must be a full commit SHA");
    }
    validateCandidate(input.candidate, input.harnessSourceSha);
    validateBuildArtifact(input.buildArtifact, input.candidate.sourceSha);
    validateObservation(input.observedAt, input.buildArtifact);

    const target = {
        schemaVersion: SCHEMA_VERSION,
        kind: TARGET_KIND,
        status: "pending-native-evidence",
        scope: "prerelease-cpu-floor-evidence-only",
        qualifying: false,
        releaseGateCleared: false,
        harness: {sourceSha: input.harnessSourceSha},
        candidate: {...input.candidate},
        build: {...input.buildArtifact, provenance: "github-actions-artifact"},
        observedAt: input.observedAt,
        releaseGatesCleared: []
    };
    Object.defineProperty(target, VALIDATED_TARGET, {value: true});
    deepFreeze(target);
    return target;
}

export function buildPrereleaseWindowsExeAcquisitionPlan(target) {
    if (!target || typeof target !== "object" || !Object.isFrozen(target)
            || target[VALIDATED_TARGET] !== true) {
        fail("acquisition source must be an immutable target returned by the binder");
    }
    return deepFreeze({
        schemaVersion: SCHEMA_VERSION,
        kind: ACQUISITION_KIND,
        authority: "acquisition-only",
        permissions: {networkAcquisition: true, nativeExecution: false, publishing: false},
        binding: {
            repository: target.candidate.repository,
            candidateSourceSha: target.candidate.sourceSha,
            harnessSourceSha: target.harness.sourceSha,
            runId: target.build.runId,
            runAttempt: target.build.runAttempt,
            artifactDigest: target.build.digest
        },
        assets: [{
            role: BASELINE_ASSET_ROLE, id: target.build.id, name: target.build.name,
            bytes: target.build.size, sha256: target.build.digest.slice(DIGEST_PREFIX.length),
            runId: target.build.runId, runAttempt: target.build.runAttempt
        }]
    });
}
