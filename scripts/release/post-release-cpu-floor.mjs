import {createHash} from "node:crypto";
import {buildWindowsMsiStage2Request}
    from "../qualification/windows-msi-stage2-request.mjs";
import {buildV161WindowsExeAcquisitionPlan}
    from "./post-release-target.mjs";

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
const DEFAULT_SUMMARY_SHA256 = "042d5f2d2d761680891d3140ca2278f9aa358400c2a00601f8780b6bdfdf98ec";

const STAGE3_PROFILE = "baseline-cpu";
const STAGE3_CONFIRMATION = "RUN-WINDOWS-BASELINE-CPU-FLOOR";
const STAGE3_AUTHORIZATION_SCOPE = "windows-baseline-cpu-floor-full-runtime";
const STAGE3_CLASSIFICATION = "windows-baseline-cpu-floor-full-runtime-stage3-nonqualifying";
const STAGE3_STAGED_CANDIDATE_NAME = "MySpeed.exe";
const SUMMARY_FILE_NAME = "qualification-summary.json";
const MANIFEST_FILE_NAME = "qualification-manifest.json";

const STAGE3_SYSTEM_DISK_NAME = "stage3.qcow2";
const STAGE3_SEED_ISO_NAME = "baseline-seed.iso";
const STAGE3_OUTPUT_DISK_NAME = "baseline-output.img";
const STAGE3_OVMF_VARS_NAME = "OVMF_VARS.fd";
const STAGE3_QEMU_PID_NAME = "baseline-qemu.pid";
const STAGE3_SERIAL_LOG_NAME = "baseline-serial.log";

const RUNNER_TEMP_PREFIX = "/home/runner/work/_temp";
const NONCE_PATTERN = /^[0-9a-f]{32}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;

function fail(message) {
    throw new Error(`Invalid post-release CPU-floor operation: ${message}`);
}

function deepFreeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value) || ArrayBuffer.isView(value)) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
}

export function createV161PostReleaseCpuFloorBinding(target, hostedContext, baselineSummaryArtifact) {
    const acquisitionPlan = buildV161WindowsExeAcquisitionPlan(target);
    const baselineAsset = acquisitionPlan.assets.find(
        asset => asset.name === BASELINE_ARTIFACT_NAME && asset.role === "baseline"
    );
    if (!baselineAsset) {
        fail("missing baseline executable asset in acquisition plan");
    }

    if (!hostedContext || typeof hostedContext !== "object") {
        fail("hosted context must be an object");
    }
    if (hostedContext.repository !== REPOSITORY) {
        fail("hosted context repository differs");
    }
    if (typeof hostedContext.eventSha !== "string" || !COMMIT_SHA_PATTERN.test(hostedContext.eventSha)) {
        fail("hosted context event SHA must be a 40-character hex SHA");
    }
    if (hostedContext.eventSha === target.candidate.sourceSha) {
        fail("harness source SHA must not equal candidate SHA");
    }
    if (hostedContext.eventSha !== target.harness.sourceSha) {
        fail("harness source SHA must match target harness SHA");
    }
    if (typeof hostedContext.nonce !== "string" || !NONCE_PATTERN.test(hostedContext.nonce)) {
        fail("hosted context nonce must be a 32-character hex string");
    }

    if (!baselineSummaryArtifact || typeof baselineSummaryArtifact !== "object") {
        fail("baseline summary artifact must be an object");
    }
    if (String(baselineSummaryArtifact.id) !== String(BASELINE_ARTIFACT_ID)) {
        fail(`baseline summary artifact ID differs: ${baselineSummaryArtifact.id}`);
    }
    if (baselineSummaryArtifact.name !== BASELINE_ARTIFACT_NAME) {
        fail(`baseline summary artifact name differs: ${baselineSummaryArtifact.name}`);
    }
    if (Number(baselineSummaryArtifact.runId) !== QUALIFICATION_RUN_ID) {
        fail(`baseline summary artifact run ID differs: ${baselineSummaryArtifact.runId}`);
    }
    if (Number(baselineSummaryArtifact.runAttempt) !== QUALIFICATION_RUN_ATTEMPT) {
        fail(`baseline summary artifact run attempt differs: ${baselineSummaryArtifact.runAttempt}`);
    }
    if (baselineSummaryArtifact.headSha !== undefined && baselineSummaryArtifact.headSha !== CANDIDATE_SOURCE_SHA) {
        fail(`baseline summary artifact head SHA differs: ${baselineSummaryArtifact.headSha}`);
    }
    if (Number(baselineSummaryArtifact.archiveSize) !== BASELINE_ARCHIVE_SIZE) {
        fail(`baseline summary artifact archive size differs: ${baselineSummaryArtifact.archiveSize}`);
    }
    if (baselineSummaryArtifact.archiveDigest !== BASELINE_ARCHIVE_DIGEST) {
        fail(`baseline summary artifact archive digest differs: ${baselineSummaryArtifact.archiveDigest}`);
    }
    if (baselineSummaryArtifact.summarySha256 === DEFAULT_SUMMARY_SHA256) {
        fail("default summary SHA256 must not be substituted for baseline summary SHA256");
    }
    if (typeof baselineSummaryArtifact.summarySha256 !== "string"
            || !SHA256_PATTERN.test(baselineSummaryArtifact.summarySha256)) {
        fail("baseline summary SHA256 is invalid");
    }
    if (!Buffer.isBuffer(baselineSummaryArtifact.summaryBytes)) {
        fail("baseline summary bytes must be a Buffer");
    }

    const calculatedSummaryHash = createHash("sha256")
        .update(baselineSummaryArtifact.summaryBytes)
        .digest("hex");
    if (calculatedSummaryHash !== baselineSummaryArtifact.summarySha256) {
        fail("summary digest does not match declared summary SHA256 hash");
    }

    const binding = {
        schemaVersion: SCHEMA_VERSION,
        kind: KIND,
        qualifying: false,
        releaseGateCleared: false,
        releaseGatesCleared: Object.freeze([]),
        candidate: Object.freeze({
            sourceSha: target.candidate.sourceSha,
            artifact: Object.freeze({
                id: String(baselineSummaryArtifact.id),
                name: baselineSummaryArtifact.name,
                runId: Number(baselineSummaryArtifact.runId),
                runAttempt: Number(baselineSummaryArtifact.runAttempt),
                headSha: baselineSummaryArtifact.headSha || target.candidate.sourceSha,
                archiveDigest: baselineSummaryArtifact.archiveDigest,
                archiveSize: Number(baselineSummaryArtifact.archiveSize),
                summarySha256: baselineSummaryArtifact.summarySha256
            }),
            exeAsset: Object.freeze({
                id: baselineAsset.id,
                name: baselineAsset.name,
                bytes: baselineAsset.bytes,
                sha256: baselineAsset.sha256,
                url: baselineAsset.url,
                role: baselineAsset.role
            })
        }),
        harness: Object.freeze({
            sourceSha: target.harness.sourceSha
        }),
        hostedContext: deepFreeze(structuredClone(hostedContext)),
        target,
        summaryBytes: Buffer.from(baselineSummaryArtifact.summaryBytes),
        summarySha256: baselineSummaryArtifact.summarySha256
    };

    return deepFreeze(binding);
}

export function buildV161PostReleaseCpuFloorStage2Request(binding, probeArtifact, identity) {
    if (!binding || binding.kind !== KIND) {
        fail("invalid post-release CPU-floor binding");
    }
    const context = {
        schemaVersion: binding.hostedContext.schemaVersion ?? SCHEMA_VERSION,
        repository: binding.hostedContext.repository,
        sourceSha: binding.hostedContext.sourceSha ?? binding.candidate.sourceSha,
        eventSha: binding.hostedContext.eventSha,
        runId: String(binding.hostedContext.runId),
        runAttempt: String(binding.hostedContext.runAttempt),
        nonce: binding.hostedContext.nonce,
        environment: binding.hostedContext.environment ?? {
            GITHUB_ACTIONS: "true",
            CI: "true",
            RUNNER_OS: "Linux",
            RUNNER_ARCH: "X64",
            RUNNER_ENVIRONMENT: "github-hosted",
            ImageOS: "ubuntu24",
            ImageVersion: binding.hostedContext.imageVersion ?? "20260914.1"
        }
    };
    return buildWindowsMsiStage2Request({
        context,
        probe: probeArtifact,
        identity
    });
}

export function buildV161PostReleaseCpuFloorStage3Request(binding, sameExecutionStage2) {
    if (!binding || binding.kind !== KIND) {
        fail("invalid post-release CPU-floor binding");
    }
    if (!sameExecutionStage2 || typeof sameExecutionStage2 !== "object") {
        fail("same-execution Stage 2 receipt is required");
    }
    if (!sameExecutionStage2.result || !sameExecutionStage2.guestResult) {
        fail("same-execution Stage 2 receipts must include result and guestResult");
    }

    const nonce = binding.hostedContext.nonce;
    const stage3Root = `${RUNNER_TEMP_PREFIX}/myspeed-stage3-${nonce}`;

    const candidate = {
        sourceSha: binding.candidate.sourceSha,
        tagName: binding.target.candidate.tagName,
        artifactId: String(binding.candidate.artifact.id),
        artifactName: BASELINE_ARTIFACT_NAME,
        runId: String(binding.candidate.artifact.runId),
        runAttempt: String(binding.candidate.artifact.runAttempt),
        archive: {
            bytes: String(binding.candidate.artifact.archiveSize),
            sha256: binding.candidate.artifact.archiveDigest.replace(/^sha256:/u, "")
        },
        releaseAssetId: String(binding.candidate.exeAsset.id),
        releaseAssetDigest: `sha256:${binding.candidate.exeAsset.sha256}`,
        file: {
            name: STAGE3_STAGED_CANDIDATE_NAME,
            bytes: String(binding.candidate.exeAsset.bytes),
            sha256: binding.candidate.exeAsset.sha256
        },
        qualificationSummary: {
            name: SUMMARY_FILE_NAME,
            bytes: String(binding.summaryBytes.length),
            sha256: binding.summarySha256
        },
        manifest: {
            name: MANIFEST_FILE_NAME,
            bytes: String(binding.target.originalQualification.manifest.bytes),
            sha256: binding.target.originalQualification.manifest.sha256
        }
    };

    const paths = {
        root: stage3Root,
        systemDisk: `${stage3Root}/${STAGE3_SYSTEM_DISK_NAME}`,
        seedIso: `${stage3Root}/${STAGE3_SEED_ISO_NAME}`,
        outputDisk: `${stage3Root}/${STAGE3_OUTPUT_DISK_NAME}`,
        ovmfVars: `${stage3Root}/${STAGE3_OVMF_VARS_NAME}`,
        qemuPid: `${stage3Root}/${STAGE3_QEMU_PID_NAME}`,
        serialLog: `${stage3Root}/${STAGE3_SERIAL_LOG_NAME}`
    };

    return deepFreeze({
        schemaVersion: SCHEMA_VERSION,
        profile: STAGE3_PROFILE,
        context: structuredClone(binding.hostedContext),
        authorization: {
            candidate: true,
            confirmation: STAGE3_CONFIRMATION,
            qemu: true,
            scope: STAGE3_AUTHORIZATION_SCOPE
        },
        paths,
        candidate,
        stage2: structuredClone(sameExecutionStage2)
    });
}

export function inspectV161PostReleaseCpuFloorEvidence(binding, evidence) {
    if (!binding || binding.kind !== KIND) {
        fail("invalid post-release CPU-floor binding");
    }
    if (!evidence || typeof evidence !== "object") {
        fail("evidence must be an object");
    }

    if (evidence.qualifying !== false) {
        fail("evidence qualifying status must be false");
    }
    if (evidence.releaseGateCleared !== false) {
        fail("evidence releaseGateCleared must be false");
    }
    if (!Array.isArray(evidence.releaseGatesCleared) || evidence.releaseGatesCleared.length !== 0) {
        fail("evidence releaseGatesCleared must be empty");
    }

    if (evidence.schemaVersion !== SCHEMA_VERSION) {
        fail("evidence schemaVersion differs");
    }
    if (evidence.status !== "observed") {
        fail("evidence status must be observed");
    }
    if (evidence.stage !== "complete") {
        fail("evidence stage must be complete");
    }
    if (evidence.classification !== STAGE3_CLASSIFICATION) {
        fail("evidence classification differs");
    }
    if (evidence.baselineFullRuntimeAccepted !== true) {
        fail("baselineFullRuntimeAccepted must be true");
    }
    if (evidence.cpuFloorAccepted !== true) {
        fail("cpuFloorAccepted must be true");
    }
    if (evidence.cleanupProven !== true) {
        fail("cleanupProven must be true");
    }

    if (!evidence.context || typeof evidence.context !== "object") {
        fail("evidence context must be an object");
    }
    if (evidence.context.repository !== binding.hostedContext.repository) {
        fail("evidence context repository differs");
    }
    if (evidence.context.sourceSha !== binding.candidate.sourceSha) {
        fail("evidence context candidate sourceSha differs");
    }
    if (evidence.context.eventSha !== binding.harness.sourceSha) {
        fail("evidence context harness eventSha differs");
    }
    if (evidence.context.runId !== binding.hostedContext.runId) {
        fail("evidence context runId differs");
    }
    if (evidence.context.runAttempt !== binding.hostedContext.runAttempt) {
        fail("evidence context runAttempt differs");
    }
    if (evidence.context.nonce !== binding.hostedContext.nonce) {
        fail("evidence context nonce differs");
    }

    if (!evidence.candidate || typeof evidence.candidate !== "object") {
        fail("evidence candidate must be an object");
    }
    if (evidence.candidate.sourceSha !== binding.candidate.sourceSha) {
        fail("evidence candidate sourceSha differs");
    }
    if (evidence.candidate.file?.sha256 !== binding.candidate.exeAsset.sha256) {
        fail("evidence candidate file sha256 differs");
    }

    if (!evidence.guest || typeof evidence.guest !== "object") {
        fail("evidence guest must be an object");
    }
    if (!evidence.guest.cpu || typeof evidence.guest.cpu !== "object") {
        fail("evidence guest cpu must be an object");
    }
    if (evidence.guest.cpu.sse42 !== true) {
        fail("evidence guest cpu sse42 must be true");
    }
    if (evidence.guest.cpu.popcnt !== true) {
        fail("evidence guest cpu popcnt must be true");
    }
    if (evidence.guest.cpu.avx !== false) {
        fail("evidence guest cpu avx must be false");
    }
    if (evidence.guest.cpu.avx2 !== false) {
        fail("evidence guest cpu avx2 must be false");
    }
    if (evidence.guest.cpu.osxsave !== false) {
        fail("evidence guest cpu osxsave must be false");
    }
    if (evidence.guest.cpu.xcr0 !== null) {
        fail("evidence guest cpu xcr0 must be null");
    }

    if (!evidence.guest.network || typeof evidence.guest.network !== "object") {
        fail("evidence guest network must be an object");
    }
    if (evidence.guest.network.hardwareNics !== 0) {
        fail("evidence guest network hardwareNics must be 0");
    }
    if (evidence.guest.network.enabledNonLoopbackInterfaces !== 0) {
        fail("evidence guest network enabledNonLoopbackInterfaces must be 0");
    }
    if (evidence.guest.network.nonLoopbackRoutes !== 0) {
        fail("evidence guest network nonLoopbackRoutes must be 0");
    }

    if (!evidence.qemuProcess || typeof evidence.qemuProcess !== "object") {
        fail("evidence qemuProcess must be an object");
    }
    if (evidence.qemuProcess.cleanupProven !== true) {
        fail("evidence qemuProcess cleanupProven must be true");
    }
    if (evidence.qemuProcess.treeGone !== true) {
        fail("evidence qemuProcess treeGone must be true");
    }

    return deepFreeze({
        accepted: true,
        qualifying: false,
        releaseGateCleared: false,
        releaseGatesCleared: Object.freeze([]),
        classification: evidence.classification,
        context: structuredClone(evidence.context),
        candidate: structuredClone(evidence.candidate),
        guest: structuredClone(evidence.guest),
        qemuProcess: structuredClone(evidence.qemuProcess)
    });
}
