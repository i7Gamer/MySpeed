import {createHash} from "node:crypto";
import {isDeepStrictEqual} from "node:util";

import {validateHostedContext} from "../qualification/linux-kvm-capability.mjs";
import {CANDIDATE_PROVENANCE, STAGE3_BUDGET_CONSTANTS, STAGE3_CONSTANTS, STAGE3_MEDIA_NAMES}
    from "../qualification/linux-windows-cpu-floor-stage3.mjs";
import {buildWindowsMsiStage2Request} from "../qualification/windows-msi-stage2-request.mjs";
import {INSTALLER_BOOT_CONFIRMATION, INSTALLER_BOOT_CONFIRMATION_AFTER_FIRST_FRAME,
    INSTALLER_BOOT_CONFIRMATION_CADENCE}
    from "../qualification/linux-windows-cpu-floor-stage2-qmp.mjs";
import {buildPrereleaseWindowsExeAcquisitionPlan} from "./prerelease-cpu-floor-target.mjs";

/*
 * Drives the CPU-floor guest against a branch build.
 *
 * The published sibling (post-release-cpu-floor.mjs) proves that the exact bytes a release
 * published behave correctly on a floor-level CPU, and reads the digests it checks them against out
 * of a manifest sealed at release time. Nothing here has been released, so there is no sealed
 * manifest and no prior result to reproduce. What this establishes instead is narrower and stated
 * plainly rather than dressed up: the CPU-floor build produced by this commit, in this run, starts
 * on a floor-level CPU, binds a loopback listener it owns, and stops cleanly.
 *
 * Where trust comes from. The archive digest is GitHub's own record of the artifact this run
 * produced, never a value the caller computed - that is the property that made the published asset
 * table worth having, and it is the one most easily lost here, because hashing the downloaded file
 * locally looks equivalent and proves nothing about which run produced it. The executable's own
 * digest is then derived from that authenticated archive, which is why acquisition is a separate,
 * explicit step rather than a field on the binding.
 */

const SCHEMA_VERSION = 1;
const KIND = "myspeed-prerelease-cpu-floor-binding";
const REPOSITORY = "i7Gamer/MySpeed";
const RUNNER_TEMP_PREFIX = "/home/runner/work/_temp";
const STAGE3_ROOT_PREFIX = `${RUNNER_TEMP_PREFIX}/myspeed-stage3-`;
const STAGE3_STAGED_CANDIDATE_NAME = "MySpeed.exe";
const DIGEST_PREFIX = "sha256:";
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UTC_SECONDS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;
const MINIMUM_CANDIDATE_BYTES = 1;
const MAXIMUM_CANDIDATE_BYTES = 512 * 1024 * 1024;

const STAGE3_NO_INPUT = "no-input";
const STAGE3_INSTALLER_CONFIRMATIONS = Object.freeze([STAGE3_NO_INPUT, INSTALLER_BOOT_CONFIRMATION,
    INSTALLER_BOOT_CONFIRMATION_AFTER_FIRST_FRAME, INSTALLER_BOOT_CONFIRMATION_CADENCE]);
const STAGE3_PLAN_KEYS = ["installerConfirmation", "wallDeadlineUnixMilliseconds"];
const ACQUISITION_KEYS = ["archive", "file", "observedAt"];
const RECORD_KEYS = ["bytes", "sha256"];
const STAGE2_RECEIPT_KEYS = ["guestResult", "result"];
const IDENTITY_KEYS = ["bytes", "path", "sha256"];
const INSPECTION_KEYS = ["binding", "request", "result", "retainedStage2Bytes"];

// Trusted by brand, never by the kind string: a literal carrying the kind is not a binding, and
// neither is a structural clone of one.
const IDENTITY_BRAND = Symbol("prerelease-cpu-floor-identity-binding");
const ACQUIRED_BRAND = Symbol("prerelease-cpu-floor-acquired-binding");

export const PRERELEASE_CPU_FLOOR_CONSTANTS = Object.freeze({
    KIND, REPOSITORY, SCHEMA_VERSION, STAGE3_INSTALLER_CONFIRMATIONS, STAGE3_NO_INPUT,
    STAGE3_STAGED_CANDIDATE_NAME, MAXIMUM_CANDIDATE_BYTES
});

function fail(message) {
    throw new Error(`Invalid pre-release CPU-floor operation: ${message}`);
}

function deepFreeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value) || ArrayBuffer.isView(value)) {
        return value;
    }
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
    if (actual !== expected) fail(`${label} differs from the bound identity`);
}

function sha256(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}

function requireIdentityBinding(value, label) {
    if (!value || typeof value !== "object" || value[IDENTITY_BRAND] !== true || value.kind !== KIND) {
        fail(`${label} requires a binding produced by createPrereleaseCpuFloorBinding`);
    }
}

function requireAcquiredBinding(value, label) {
    requireIdentityBinding(value, label);
    if (value[ACQUIRED_BRAND] !== true) {
        fail(`${label} requires an acquired candidate; call acquirePrereleaseCpuFloorCandidate first`);
    }
}

function requireBoundedRecord(value, label) {
    exactKeys(value, RECORD_KEYS, label);
    const bytes = Number(value.bytes);
    if (!Number.isSafeInteger(bytes) || bytes < MINIMUM_CANDIDATE_BYTES
            || bytes > MAXIMUM_CANDIDATE_BYTES) {
        fail(`${label} size is outside the qualified bound`);
    }
    if (typeof value.sha256 !== "string" || !SHA256_PATTERN.test(value.sha256)) {
        fail(`${label} digest must be a sha256 hex digest`);
    }
}

export function createPrereleaseCpuFloorBinding(input) {
    exactKeys(input, ["hostedContext", "target"], "binding input");
    const {target} = input;

    // Brand-checks the target: a structural clone of a bound target is refused here.
    const acquisitionPlan = buildPrereleaseWindowsExeAcquisitionPlan(target);
    const [asset] = acquisitionPlan.assets;

    const hostedContext = validateHostedContext(input.hostedContext);
    requireEqual(hostedContext.repository, REPOSITORY, "hosted context repository");
    if (hostedContext.sourceSha !== target.harness.sourceSha
            || hostedContext.eventSha !== target.harness.sourceSha) {
        fail("hosted context source and event SHA must both be the harness source SHA");
    }
    /*
     * Inverted from the published path, which requires the harness and the candidate to be
     * different commits. A branch build is produced by the commit under test, so they must be the
     * same one, and an artifact from any other commit is what must not be admitted.
     */
    if (hostedContext.sourceSha !== target.candidate.sourceSha) {
        fail("harness source SHA must equal the candidate source SHA");
    }
    /*
     * And the artifact has to be this run's. Without this, an artifact left by any earlier run of
     * the workflow would satisfy the binding and a green result would say nothing about the commit
     * that was dispatched.
     */
    requireEqual(String(hostedContext.runId), String(target.build.runId), "hosted context run ID");
    requireEqual(String(hostedContext.runAttempt), String(target.build.runAttempt),
        "hosted context run attempt");

    const binding = {
        schemaVersion: SCHEMA_VERSION,
        kind: KIND,
        qualifying: false,
        releaseGateCleared: false,
        releaseGatesCleared: [],
        candidate: {
            provenance: CANDIDATE_PROVENANCE.branch,
            sourceSha: target.candidate.sourceSha,
            version: target.candidate.version,
            windowsStamp: target.candidate.windowsStamp,
            artifact: {
                id: String(asset.id),
                name: asset.name,
                runId: target.build.runId,
                runAttempt: target.build.runAttempt,
                headSha: target.build.headSha,
                archiveDigest: target.build.digest,
                archiveSize: target.build.size
            }
        },
        harness: {sourceSha: target.harness.sourceSha},
        hostedContext: structuredClone(hostedContext)
    };
    return deepFreeze(brand(binding, IDENTITY_BRAND));
}

/**
 * Admits the executable's identity, but only once the archive it came out of matches the digest
 * GitHub recorded for this run's artifact. The executable's digest is therefore derived from an
 * authenticated archive rather than asserted by whoever downloaded it.
 */
export function acquirePrereleaseCpuFloorCandidate(binding, acquisition) {
    requireIdentityBinding(binding, "candidate acquisition");
    exactKeys(acquisition, ACQUISITION_KEYS, "candidate acquisition");
    requireBoundedRecord(acquisition.archive, "candidate archive");
    requireBoundedRecord(acquisition.file, "candidate executable");

    if (typeof acquisition.observedAt !== "string" || !UTC_SECONDS_PATTERN.test(acquisition.observedAt)
            || !Number.isFinite(Date.parse(acquisition.observedAt))) {
        fail("observation time must be a UTC second-resolution timestamp");
    }
    requireEqual(`${DIGEST_PREFIX}${acquisition.archive.sha256}`,
        binding.candidate.artifact.archiveDigest, "candidate archive digest");
    requireEqual(Number(acquisition.archive.bytes), Number(binding.candidate.artifact.archiveSize),
        "candidate archive size");

    const acquired = {
        ...structuredClone(binding),
        candidate: {
            ...structuredClone(binding.candidate),
            file: {
                name: STAGE3_STAGED_CANDIDATE_NAME,
                bytes: String(acquisition.file.bytes),
                sha256: acquisition.file.sha256
            }
        },
        observedAt: acquisition.observedAt
    };
    return deepFreeze(brand(acquired, IDENTITY_BRAND, ACQUIRED_BRAND));
}

export function buildPrereleaseCpuFloorStage2Request(binding, probeArtifact, identity) {
    requireIdentityBinding(binding, "Stage 2 request");
    const request = buildWindowsMsiStage2Request({
        context: structuredClone(binding.hostedContext),
        probe: probeArtifact,
        identity
    });
    /*
     * The same two opt-ins the published path makes, and for the same reasons: the installer
     * preparation needs the confirmation cadence rather than a single keystroke at a fixed offset,
     * and this CPU-specific caller takes the optional mid-window diagnostic frames.
     */
    request.authorization.bootConfirmation = INSTALLER_BOOT_CONFIRMATION_CADENCE;
    request.authorization.midWindowFrames = true;
    return request;
}

function validateStage3ExecutionPlan(value) {
    exactKeys(value, STAGE3_PLAN_KEYS, "Stage 3 execution plan");
    if (!STAGE3_INSTALLER_CONFIRMATIONS.includes(value.installerConfirmation)) {
        fail("Stage 3 installer confirmation is not one of the admitted policies");
    }
    const deadline = value.wallDeadlineUnixMilliseconds;
    if (!Number.isSafeInteger(deadline) || deadline <= 0) {
        fail("Stage 3 wall deadline must be a whole number of milliseconds");
    }
    return Object.freeze({...value});
}

export function buildPrereleaseCpuFloorStage3Template(binding, plan) {
    requireAcquiredBinding(binding, "Stage 3 template");
    const executionPlan = validateStage3ExecutionPlan(plan);
    const root = `${STAGE3_ROOT_PREFIX}${binding.hostedContext.nonce}`;
    return deepFreeze({
        schemaVersion: SCHEMA_VERSION,
        profile: STAGE3_CONSTANTS.PROFILE,
        context: structuredClone(binding.hostedContext),
        authorization: {
            candidate: true,
            confirmation: STAGE3_CONSTANTS.CONFIRMATION,
            qemu: true,
            scope: STAGE3_CONSTANTS.AUTHORIZATION_SCOPE,
            ...(executionPlan.installerConfirmation === STAGE3_NO_INPUT
                ? {} : {bootConfirmation: executionPlan.installerConfirmation})
        },
        budget: {
            label: STAGE3_BUDGET_CONSTANTS.RESERVATION_LABEL,
            wallDeadlineUnixMilliseconds: executionPlan.wallDeadlineUnixMilliseconds
        },
        paths: Object.fromEntries([["root", root], ...Object.entries(STAGE3_MEDIA_NAMES)
            .map(([field, name]) => [field, `${root}/${name}`])]),
        candidate: {
            provenance: binding.candidate.provenance,
            sourceSha: binding.candidate.sourceSha,
            artifactId: binding.candidate.artifact.id,
            artifactName: binding.candidate.artifact.name,
            runId: String(binding.candidate.artifact.runId),
            runAttempt: String(binding.candidate.artifact.runAttempt),
            archive: {
                bytes: String(binding.candidate.artifact.archiveSize),
                sha256: binding.candidate.artifact.archiveDigest.slice(DIGEST_PREFIX.length)
            },
            file: {...structuredClone(binding.candidate.file)}
        }
    });
}

export function buildPrereleaseCpuFloorStage3Request(binding, sameExecutionStage2, plan) {
    const template = buildPrereleaseCpuFloorStage3Template(binding, plan);
    exactKeys(sameExecutionStage2, STAGE2_RECEIPT_KEYS, "same-execution Stage 2 receipts");
    for (const key of STAGE2_RECEIPT_KEYS) {
        exactKeys(sameExecutionStage2[key], IDENTITY_KEYS, `same-execution Stage 2 ${key} identity`);
    }
    return deepFreeze({...template, stage2: structuredClone(sameExecutionStage2)});
}

/** Binds the executed request back to the identity the binding sealed. */
function requireRequestBoundToBinding(request, binding) {
    const {candidate} = request;
    if (!candidate || typeof candidate !== "object") fail("request candidate is missing");
    requireEqual(candidate.provenance, binding.candidate.provenance, "request candidate provenance");
    requireEqual(candidate.sourceSha, binding.candidate.sourceSha, "request candidate source SHA");
    requireEqual(candidate.artifactId, binding.candidate.artifact.id, "request candidate artifact ID");
    requireEqual(candidate.artifactName, binding.candidate.artifact.name,
        "request candidate artifact name");
    requireEqual(candidate.runId, String(binding.candidate.artifact.runId), "request candidate run ID");
    requireEqual(candidate.runAttempt, String(binding.candidate.artifact.runAttempt),
        "request candidate run attempt");
    requireEqual(candidate.archive?.bytes, String(binding.candidate.artifact.archiveSize),
        "request candidate archive size");
    requireEqual(candidate.archive?.sha256,
        binding.candidate.artifact.archiveDigest.slice(DIGEST_PREFIX.length),
        "request candidate archive digest");
    requireEqual(candidate.file?.name, STAGE3_STAGED_CANDIDATE_NAME,
        "request candidate staged file name");
    requireEqual(candidate.file?.bytes, binding.candidate.file.bytes,
        "request candidate staged file size");
    requireEqual(candidate.file?.sha256, binding.candidate.file.sha256,
        "request candidate staged file digest");
}

export function inspectPrereleaseCpuFloorEvidence(input) {
    exactKeys(input, INSPECTION_KEYS, "evidence inspection input");
    const {binding, request, result, retainedStage2Bytes} = input;
    requireAcquiredBinding(binding, "evidence inspection");
    requireRequestBoundToBinding(request, binding);
    if (!Buffer.isBuffer(retainedStage2Bytes) || retainedStage2Bytes.length === 0) {
        fail("retained Stage 2 bytes must be a non-empty Buffer");
    }
    requireEqual(sha256(retainedStage2Bytes), request.stage2?.result?.sha256,
        "retained Stage 2 digest");
    if (result?.status !== "observed") fail("evidence inspection requires an observed Stage 3 result");

    return deepFreeze({
        schemaVersion: SCHEMA_VERSION,
        kind: "myspeed-prerelease-cpu-floor-evidence",
        qualifying: false,
        releaseGateCleared: false,
        releaseGatesCleared: [],
        /*
         * Said in the evidence itself, not only in a comment: a branch run establishes that this
         * commit's build works on a floor-level CPU. It does not reproduce a sealed result, because
         * an unreleased commit has none to reproduce.
         */
        establishes: "branch-build-runs-on-cpu-floor",
        candidate: structuredClone(binding.candidate),
        harness: {sourceSha: binding.harness.sourceSha},
        observedAt: binding.observedAt
    });
}
