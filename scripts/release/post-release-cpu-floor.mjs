import {createHash} from "node:crypto";
import {isDeepStrictEqual} from "node:util";

import {validateHostedContext} from "../qualification/linux-kvm-capability.mjs";
import {validateCompletedStage3Result, STAGE3_CONSTANTS}
    from "../qualification/linux-windows-cpu-floor-stage3.mjs";
import {buildWindowsMsiStage2Request} from "../qualification/windows-msi-stage2-request.mjs";
import {buildV161WindowsExeAcquisitionPlan} from "./post-release-target.mjs";

const SCHEMA_VERSION = 1;
const KIND = "myspeed-v1.6.1-post-release-cpu-floor-binding";
const REPOSITORY = "i7Gamer/MySpeed";
const CANDIDATE_SOURCE_SHA = "4fa4dd40a89a062735f98bd85d685e0624ff46a8";
const QUALIFICATION_RUN_ID = 34829932391;
const QUALIFICATION_RUN_ATTEMPT = 1;

const BASELINE_ARTIFACT_ID = 10341896645;
const BASELINE_ARTIFACT_NAME = "MySpeed-windows-x64-baseline.exe";
const BASELINE_ARCHIVE_SIZE = 46649471;
const BASELINE_ARCHIVE_DIGEST = "sha256:280b4a99c8a1f20aca5958c065b12ecb14519125769ee0460840168963db07ed";
const BASELINE_ASSET_ROLE = "baseline";

const SUMMARY_FILE_NAME = "qualification-summary.json";
const MANIFEST_FILE_NAME = "qualification-manifest.json";
const SUMMARY_PLATFORM = "win32";
const SUMMARY_ARCHITECTURE = "x64";

// The historical summary is a small JSON document; the bound matches the Stage 3 core validator's
// embedded-evidence ceiling so no larger member can be presented as the baseline summary.
const MAXIMUM_SUMMARY_BYTES = 4 * 1024 * 1024;

const STAGE3_STAGED_CANDIDATE_NAME = "MySpeed.exe";
const STAGE3_SYSTEM_DISK_NAME = "stage3.qcow2";
const STAGE3_SEED_ISO_NAME = "baseline-seed.iso";
const STAGE3_OUTPUT_DISK_NAME = "baseline-output.img";
const STAGE3_OVMF_VARS_NAME = "OVMF_VARS.fd";
const STAGE3_QEMU_PID_NAME = "baseline-qemu.pid";
const STAGE3_SERIAL_LOG_NAME = "baseline-serial.log";

const RUNNER_TEMP_PREFIX = "/home/runner/work/_temp";
const STAGE3_ROOT_PREFIX = `${RUNNER_TEMP_PREFIX}/myspeed-stage3-`;
const DIGEST_PREFIX = "sha256:";
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UTC_SECONDS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;

const ACQUISITION_KEYS = ["artifact", "observedAt", "summaryBytes"];
const ARTIFACT_KEYS = ["archiveDigest", "archiveSize", "expired", "expiresAt", "headSha", "id",
    "name", "runAttempt", "runId"];
const STAGE2_RECEIPT_KEYS = ["guestResult", "result"];
const IDENTITY_KEYS = ["bytes", "path", "sha256"];
const INSPECTION_KEYS = ["binding", "request", "result", "retainedStage2Bytes"];

// Bindings are trusted by brand, never by their kind string: a literal object carrying the kind is
// not a binding, and neither is a structural clone of one.
const IDENTITY_BRAND = Symbol("v1.6.1-post-release-cpu-floor-identity-binding");
const ACQUIRED_BRAND = Symbol("v1.6.1-post-release-cpu-floor-acquired-binding");

export const POST_RELEASE_CPU_FLOOR_CONSTANTS = Object.freeze({
    BASELINE_ARCHIVE_DIGEST, BASELINE_ARCHIVE_SIZE, BASELINE_ARTIFACT_ID, BASELINE_ARTIFACT_NAME,
    CANDIDATE_SOURCE_SHA, KIND, MANIFEST_FILE_NAME, MAXIMUM_SUMMARY_BYTES,
    QUALIFICATION_RUN_ATTEMPT, QUALIFICATION_RUN_ID, REPOSITORY, SCHEMA_VERSION, SUMMARY_FILE_NAME
});

function fail(message) {
    throw new Error(`Invalid post-release CPU-floor operation: ${message}`);
}

function deepFreeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value) || ArrayBuffer.isView(value)) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
}

function brand(value, ...symbols) {
    for (const symbol of symbols) {
        Object.defineProperty(value, symbol, {value: true, enumerable: false, writable: false});
    }
    return value;
}

function exactKeys(value, keys, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)
            || !isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())) {
        fail(`${label} must use the closed schema`);
    }
}

function requireEqual(actual, expected, label) {
    if (actual !== expected) fail(`${label} differs from the sealed identity`);
}

function sha256(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}

function requireIdentityBinding(value, label) {
    if (!value || typeof value !== "object" || value[IDENTITY_BRAND] !== true || value.kind !== KIND) {
        fail(`${label} requires a binding produced by createV161PostReleaseCpuFloorBinding`);
    }
}

function requireAcquiredBinding(value, label) {
    requireIdentityBinding(value, label);
    if (value[ACQUIRED_BRAND] !== true) {
        fail(`${label} requires an acquired baseline summary; call`
            + " acquireV161PostReleaseCpuFloorBaselineSummary first");
    }
}

/**
 * Reads the required baseline summary identity out of the sealed qualification manifest. The digest
 * is never taken from the caller, so arbitrary bytes carrying their own hash cannot be substituted.
 */
function requiredBaselineSummaryFromManifest(manifestBytes, target, baselineAsset) {
    if (!Buffer.isBuffer(manifestBytes)) fail("manifest bytes must be a Buffer");
    const sealed = target.originalQualification.manifest;
    if (manifestBytes.length !== sealed.bytes) fail("manifest byte size differs from the sealed manifest");
    if (sha256(manifestBytes) !== sealed.sha256) fail("manifest digest differs from the sealed manifest");

    let manifest;
    try {
        manifest = JSON.parse(manifestBytes.toString("utf8"));
    } catch {
        fail("manifest bytes are not JSON");
    }
    const entries = manifest?.runtimeVerification?.windows;
    if (!Array.isArray(entries)) fail("manifest does not record Windows runtime verification");
    const matching = entries.filter(entry => entry?.artifact === BASELINE_ARTIFACT_NAME);
    if (matching.length !== 1) fail("manifest does not name exactly one baseline Windows artifact");

    const entry = matching[0];
    requireEqual(entry.summaryPath, SUMMARY_FILE_NAME, "manifest baseline summary path");
    requireEqual(entry.sourceSha, target.candidate.sourceSha, "manifest baseline source SHA");
    requireEqual(entry.platform, SUMMARY_PLATFORM, "manifest baseline platform");
    requireEqual(entry.architecture, SUMMARY_ARCHITECTURE, "manifest baseline architecture");
    requireEqual(entry.artifactSha256, baselineAsset.sha256, "manifest baseline artifact digest");
    if (typeof entry.summarySha256 !== "string" || !SHA256_PATTERN.test(entry.summarySha256)) {
        fail("manifest baseline summary digest is invalid");
    }
    const others = entries.filter(other => other !== entry);
    if (others.some(other => other.summarySha256 === entry.summarySha256)) {
        fail("manifest baseline summary digest is not distinct from another variant");
    }
    return {name: SUMMARY_FILE_NAME, sha256: entry.summarySha256};
}

export function createV161PostReleaseCpuFloorBinding(input) {
    exactKeys(input, ["hostedContext", "manifestBytes", "target"], "binding input");
    const {target} = input;

    // Brand-checks the target: a structural clone of a bound target is refused here.
    const acquisitionPlan = buildV161WindowsExeAcquisitionPlan(target);
    const baselineAsset = acquisitionPlan.assets.find(
        asset => asset.name === BASELINE_ARTIFACT_NAME && asset.role === BASELINE_ASSET_ROLE
    );
    if (!baselineAsset) fail("missing baseline executable asset in acquisition plan");

    const requiredBaselineSummary = requiredBaselineSummaryFromManifest(
        input.manifestBytes, target, baselineAsset
    );

    // The complete closed hosted-context schema, with nothing defaulted or invented.
    const hostedContext = validateHostedContext(input.hostedContext);
    requireEqual(hostedContext.repository, REPOSITORY, "hosted context repository");
    if (hostedContext.sourceSha !== target.harness.sourceSha
            || hostedContext.eventSha !== target.harness.sourceSha) {
        fail("hosted context source and event SHA must both be the harness source SHA");
    }
    if (hostedContext.sourceSha === target.candidate.sourceSha) {
        fail("harness source SHA must not equal the candidate source SHA");
    }

    const binding = {
        schemaVersion: SCHEMA_VERSION,
        kind: KIND,
        qualifying: false,
        releaseGateCleared: false,
        releaseGatesCleared: [],
        candidate: {
            sourceSha: target.candidate.sourceSha,
            tagName: target.candidate.tagName,
            artifact: {
                id: String(BASELINE_ARTIFACT_ID),
                name: BASELINE_ARTIFACT_NAME,
                runId: QUALIFICATION_RUN_ID,
                runAttempt: QUALIFICATION_RUN_ATTEMPT,
                headSha: target.candidate.sourceSha,
                archiveDigest: BASELINE_ARCHIVE_DIGEST,
                archiveSize: BASELINE_ARCHIVE_SIZE
            },
            exeAsset: {
                id: baselineAsset.id,
                name: baselineAsset.name,
                bytes: baselineAsset.bytes,
                sha256: baselineAsset.sha256,
                url: baselineAsset.url,
                role: baselineAsset.role
            }
        },
        harness: {sourceSha: target.harness.sourceSha},
        hostedContext: structuredClone(hostedContext),
        requiredBaselineSummary,
        originalQualification: {manifest: {...target.originalQualification.manifest}}
    };
    return deepFreeze(brand(binding, IDENTITY_BRAND));
}

export function acquireV161PostReleaseCpuFloorBaselineSummary(binding, acquisition) {
    requireIdentityBinding(binding, "baseline summary acquisition");
    exactKeys(acquisition, ACQUISITION_KEYS, "baseline summary acquisition");
    exactKeys(acquisition.artifact, ARTIFACT_KEYS, "baseline summary artifact");

    const {artifact} = acquisition;
    requireEqual(String(artifact.id), String(BASELINE_ARTIFACT_ID), "baseline artifact ID");
    requireEqual(artifact.name, BASELINE_ARTIFACT_NAME, "baseline artifact name");
    requireEqual(Number(artifact.runId), QUALIFICATION_RUN_ID, "baseline artifact run ID");
    requireEqual(Number(artifact.runAttempt), QUALIFICATION_RUN_ATTEMPT, "baseline artifact run attempt");
    requireEqual(artifact.headSha, binding.candidate.sourceSha, "baseline artifact head SHA");
    requireEqual(Number(artifact.archiveSize), BASELINE_ARCHIVE_SIZE, "baseline artifact archive size");
    requireEqual(artifact.archiveDigest, BASELINE_ARCHIVE_DIGEST, "baseline artifact archive digest");
    if (artifact.expired !== false) fail("baseline artifact is expired");

    for (const [value, label] of [[acquisition.observedAt, "observation time"],
        [artifact.expiresAt, "baseline artifact expiry"]]) {
        if (typeof value !== "string" || !UTC_SECONDS_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) {
            fail(`${label} must be a UTC second-resolution timestamp`);
        }
    }
    if (Date.parse(acquisition.observedAt) >= Date.parse(artifact.expiresAt)) {
        fail("baseline artifact retention had already lapsed at the observation time");
    }

    const {summaryBytes} = acquisition;
    if (!Buffer.isBuffer(summaryBytes) || summaryBytes.length === 0) {
        fail("baseline summary bytes must be a non-empty Buffer");
    }
    if (summaryBytes.length > MAXIMUM_SUMMARY_BYTES) fail("baseline summary bytes exceed the qualified bound");
    if (sha256(summaryBytes) !== binding.requiredBaselineSummary.sha256) {
        fail("baseline summary bytes do not match the digest the sealed manifest declares");
    }

    const acquired = {
        ...structuredClone(binding),
        summary: {
            name: binding.requiredBaselineSummary.name,
            bytes: String(summaryBytes.length),
            sha256: binding.requiredBaselineSummary.sha256
        }
    };
    return deepFreeze(brand(acquired, IDENTITY_BRAND, ACQUIRED_BRAND));
}

export function buildV161PostReleaseCpuFloorStage2Request(binding, probeArtifact, identity) {
    requireIdentityBinding(binding, "Stage 2 request");
    return buildWindowsMsiStage2Request({
        context: structuredClone(binding.hostedContext),
        probe: probeArtifact,
        identity
    });
}

export function buildV161PostReleaseCpuFloorStage3Template(binding) {
    requireAcquiredBinding(binding, "Stage 3 template");
    const root = `${STAGE3_ROOT_PREFIX}${binding.hostedContext.nonce}`;
    return deepFreeze({
        schemaVersion: SCHEMA_VERSION,
        profile: STAGE3_CONSTANTS.PROFILE,
        context: structuredClone(binding.hostedContext),
        authorization: {
            candidate: true,
            confirmation: STAGE3_CONSTANTS.CONFIRMATION,
            qemu: true,
            scope: STAGE3_CONSTANTS.AUTHORIZATION_SCOPE
        },
        paths: {
            root,
            systemDisk: `${root}/${STAGE3_SYSTEM_DISK_NAME}`,
            seedIso: `${root}/${STAGE3_SEED_ISO_NAME}`,
            outputDisk: `${root}/${STAGE3_OUTPUT_DISK_NAME}`,
            ovmfVars: `${root}/${STAGE3_OVMF_VARS_NAME}`,
            qemuPid: `${root}/${STAGE3_QEMU_PID_NAME}`,
            serialLog: `${root}/${STAGE3_SERIAL_LOG_NAME}`
        },
        candidate: {
            sourceSha: binding.candidate.sourceSha,
            tagName: binding.candidate.tagName,
            artifactId: binding.candidate.artifact.id,
            artifactName: binding.candidate.artifact.name,
            runId: String(binding.candidate.artifact.runId),
            runAttempt: String(binding.candidate.artifact.runAttempt),
            archive: {
                bytes: String(binding.candidate.artifact.archiveSize),
                sha256: binding.candidate.artifact.archiveDigest.slice(DIGEST_PREFIX.length)
            },
            releaseAssetId: String(binding.candidate.exeAsset.id),
            releaseAssetDigest: `${DIGEST_PREFIX}${binding.candidate.exeAsset.sha256}`,
            file: {
                name: STAGE3_STAGED_CANDIDATE_NAME,
                bytes: String(binding.candidate.exeAsset.bytes),
                sha256: binding.candidate.exeAsset.sha256
            },
            qualificationSummary: {
                name: binding.summary.name,
                bytes: binding.summary.bytes,
                sha256: binding.summary.sha256
            },
            manifest: {
                name: MANIFEST_FILE_NAME,
                bytes: String(binding.originalQualification.manifest.bytes),
                sha256: binding.originalQualification.manifest.sha256
            }
        }
    });
}

export function buildV161PostReleaseCpuFloorStage3Request(binding, sameExecutionStage2) {
    const template = buildV161PostReleaseCpuFloorStage3Template(binding);
    exactKeys(sameExecutionStage2, STAGE2_RECEIPT_KEYS, "same-execution Stage 2 receipts");
    for (const key of STAGE2_RECEIPT_KEYS) {
        exactKeys(sameExecutionStage2[key], IDENTITY_KEYS, `same-execution Stage 2 ${key} identity`);
    }
    return deepFreeze({...template, stage2: structuredClone(sameExecutionStage2)});
}

/** Binds the executed request back to the post-release identity the binding sealed. */
function requireRequestBoundToBinding(request, binding) {
    if (!request || typeof request !== "object") fail("Stage 3 request must be an object");
    if (!isDeepStrictEqual(structuredClone(request.context), structuredClone(binding.hostedContext))) {
        fail("Stage 3 request context differs from the bound hosted context");
    }
    const candidate = request.candidate;
    if (!candidate || typeof candidate !== "object") fail("Stage 3 request candidate must be an object");
    requireEqual(candidate.sourceSha, binding.candidate.sourceSha, "request candidate source SHA");
    requireEqual(candidate.tagName, binding.candidate.tagName, "request candidate tag name");
    requireEqual(candidate.artifactId, binding.candidate.artifact.id, "request candidate artifact ID");
    requireEqual(candidate.artifactName, binding.candidate.artifact.name, "request candidate artifact name");
    requireEqual(candidate.runId, String(binding.candidate.artifact.runId), "request candidate run ID");
    requireEqual(candidate.runAttempt, String(binding.candidate.artifact.runAttempt),
        "request candidate run attempt");
    requireEqual(candidate.archive?.bytes, String(binding.candidate.artifact.archiveSize),
        "request candidate archive size");
    requireEqual(candidate.archive?.sha256,
        binding.candidate.artifact.archiveDigest.slice(DIGEST_PREFIX.length), "request candidate archive digest");
    requireEqual(candidate.releaseAssetId, String(binding.candidate.exeAsset.id),
        "request candidate release asset ID");
    requireEqual(candidate.releaseAssetDigest, `${DIGEST_PREFIX}${binding.candidate.exeAsset.sha256}`,
        "request candidate release asset digest");
    requireEqual(candidate.file?.name, STAGE3_STAGED_CANDIDATE_NAME, "request candidate staged file name");
    requireEqual(candidate.file?.bytes, String(binding.candidate.exeAsset.bytes),
        "request candidate staged file size");
    requireEqual(candidate.file?.sha256, binding.candidate.exeAsset.sha256,
        "request candidate staged file digest");
    requireEqual(candidate.qualificationSummary?.name, binding.requiredBaselineSummary.name,
        "request candidate summary name");
    requireEqual(candidate.qualificationSummary?.sha256, binding.requiredBaselineSummary.sha256,
        "request candidate summary digest");
    requireEqual(candidate.manifest?.name, MANIFEST_FILE_NAME, "request candidate manifest name");
    requireEqual(candidate.manifest?.bytes, String(binding.originalQualification.manifest.bytes),
        "request candidate manifest size");
    requireEqual(candidate.manifest?.sha256, binding.originalQualification.manifest.sha256,
        "request candidate manifest digest");
}

export function inspectV161PostReleaseCpuFloorEvidence(input) {
    exactKeys(input, INSPECTION_KEYS, "evidence inspection input");
    const {binding, request, result, retainedStage2Bytes} = input;
    requireIdentityBinding(binding, "evidence inspection");
    requireRequestBoundToBinding(request, binding);

    // The whole result is re-derived from the raw retained evidence by the Stage 3 core validator:
    // guest CPUID bytes, the full verifier summary bytes, the Stage 2 replay bytes, the QEMU vector,
    // the process record and the output disk. Nothing is trusted as a status projection.
    const validated = validateCompletedStage3Result(result, request, retainedStage2Bytes);

    if (result.qualifying !== false || result.releaseGateCleared !== false) {
        fail("evidence must remain non-qualifying");
    }
    if (result.classification !== STAGE3_CONSTANTS.CLASSIFICATION) fail("evidence classification differs");

    return deepFreeze({
        accepted: true,
        qualifying: false,
        releaseGateCleared: false,
        releaseGatesCleared: [],
        classification: result.classification,
        context: structuredClone(result.context),
        candidate: structuredClone(request.candidate),
        acquiredCandidate: structuredClone(validated.candidate),
        guest: structuredClone(result.guest),
        qemuProcess: structuredClone(result.qemuProcess),
        media: structuredClone(validated.media),
        stage2: structuredClone(validated.stage2)
    });
}
