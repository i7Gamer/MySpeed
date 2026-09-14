import {createHash} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {isDeepStrictEqual} from "node:util";

import {assertWindowsNativeStandaloneHostRequest, assertWindowsNativeStandaloneProofRequest,
    inspectWindowsNativeStandaloneEvidence} from
    "../qualification/windows-native-standalone-proof.mjs";
import {buildWindowsNativeStandaloneExecutionPlan, writeWindowsNativeStandaloneExecutionPlan} from
    "../qualification/windows-native-standalone-hosted.mjs";
import {buildV161WindowsExeAcquisitionPlan} from "./post-release-target.mjs";

const SCHEMA_VERSION = 1;
const REPOSITORY = "i7Gamer/MySpeed";
const QUALIFICATION_RUN_ID = "34829932391";
const QUALIFICATION_RUN_ATTEMPT = "1";
const QUALIFICATION_ARCHIVE_ID = "10342345489";
const HOSTED_CONTEXT_KEYS = ["eventSha", "imageVersion", "nonce", "repository", "runAttempt", "runId"];
const INSPECTION_KEYS = ["candidates", "eventSha", "hostRequestSha256", "kind", "manifestSha256",
    "imageVersion", "nonce", "proofRequestSha256", "qualificationManifestArtifactDigest", "qualificationManifestArtifactId",
    "qualificationRunAttempt", "qualificationRunId", "qualificationSourceSha", "qualifying",
    "releaseGatesCleared", "runAttempt", "runId", "schemaVersion", "sourceSha", "status",
    "hostResultSha256"];
const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const NONCE = /^[0-9a-f]{32}$/u;
const POSITIVE_DECIMAL = /^[1-9][0-9]{0,19}$/u;
const RUN_ATTEMPT = /^[1-9][0-9]{0,9}$/u;
const IMAGE_VERSION = /^[0-9A-Za-z._-]{1,64}$/u;
const VALIDATED_BINDING = Symbol("validated-v1.6.1-post-release-standalone-binding");
const VALIDATED_PRODUCER = Symbol("validated-v1.6.1-post-release-standalone-producer");
const RETAINED_REQUEST_KEYS = ["hostRequestBytes", "proofRequestBytes"];
const ACQUIRED_KEYS = ["candidates", "closure", "fixtures", "node", "powershell", "taskRoot"];
const ACQUIRED_CANDIDATE_KEYS = ["alias", "scenarios", "sourceIdentity", "sourcePath"];
const ENVELOPE_KEYS = ["kind", "oracleContext", "qualifying", "releaseGatesCleared", "requests",
    "schemaVersion", "status", "targetHashes"];
const PRODUCER_KEYS = ["authority", "executionPlan", "kind", "nativeExecutionAuthorized", "qualifying",
    "releaseGatesCleared", "retention", "schemaVersion", "status", "targetHashes"];
const RETENTION_OPERATIONS = ["readEnvelope", "writeEnvelope", "writeExecutionPlan"];
const MAXIMUM_ENVELOPE_BYTES = 65_536;
const CANDIDATE_ORDER = [
    {alias: "default", role: "default", name: "MySpeed-windows-x64.exe"},
    {alias: "baseline", role: "baseline", name: "MySpeed-windows-x64-baseline.exe"}
];

const jsonSha256 = value => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const bytesSha256 = value => createHash("sha256").update(value).digest("hex");

function fail(message) {
    throw new Error(`Invalid v1.6.1 post-release standalone binding: ${message}`);
}

function exactKeys(value, expected, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
    const actual = Object.keys(value).sort();
    const keys = [...expected].sort();
    if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
        fail(`${label} keys differ`);
    }
}

function exactString(value, pattern, label) {
    if (typeof value !== "string") fail(`${label} must be a string`);
    const match = pattern.exec(value);
    if (!match || match.index !== 0 || match[0].length !== value.length) fail(`${label} differs`);
    return value;
}

function deepFreeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
}

function parseBytes(bytes, label) {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) fail(`${label} must be nonempty retained bytes`);
    try {
        return JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes));
    } catch {
        fail(`${label} JSON differs`);
    }
}

function requireBinding(binding, label) {
    if (!binding || typeof binding !== "object" || !Object.isFrozen(binding)
            || binding[VALIDATED_BINDING] !== true) {
        fail(`${label} requires an immutable binding returned by this module`);
    }
}

function validateHostedContext(context, harnessSourceSha) {
    exactKeys(context, HOSTED_CONTEXT_KEYS, "hosted context");
    if (context.repository !== REPOSITORY) fail("hosted repository differs");
    exactString(context.runId, POSITIVE_DECIMAL, "hosted run ID");
    exactString(context.runAttempt, RUN_ATTEMPT, "hosted run attempt");
    exactString(context.eventSha, COMMIT_SHA, "hosted event SHA");
    exactString(context.imageVersion, IMAGE_VERSION, "hosted image version");
    exactString(context.nonce, NONCE, "hosted nonce");
    if (context.eventSha !== harnessSourceSha) fail("hosted event SHA is not the harness source");
}

function expectedCandidates(acquisitionPlan) {
    return CANDIDATE_ORDER.map(identity => {
        const asset = acquisitionPlan.assets.find(item => item.role === identity.role);
        if (!asset || asset.name !== identity.name) fail(`acquisition plan lacks ${identity.name}`);
        return {
            alias: identity.alias,
            name: asset.name,
            releaseAssetId: String(asset.id),
            releaseAssetDigest: `sha256:${asset.sha256}`,
            bytes: asset.bytes,
            sha256: asset.sha256,
            url: asset.url,
            provenance: "github-release-asset"
        };
    });
}

// This pure binding does not launch the existing oracle. The hosted workflow must
// retain its own Windows/GitHub-hosted environment and isolation guards.
export function createV161PostReleaseStandaloneBinding(target, hostedContext) {
    const acquisitionPlan = buildV161WindowsExeAcquisitionPlan(target);
    validateHostedContext(hostedContext, target.harness.sourceSha);
    const binding = {
        schemaVersion: SCHEMA_VERSION,
        kind: "myspeed-v1.6.1-post-release-standalone-binding",
        status: "bound",
        authority: "evidence-inspection-only",
        qualifying: false,
        targetHashes: {
            postReleaseTargetSha256: jsonSha256(target),
            acquisitionPlanSha256: jsonSha256(acquisitionPlan)
        },
        oracleContext: {
            sourceSha: target.candidate.sourceSha,
            eventSha: hostedContext.eventSha,
            runId: hostedContext.runId,
            runAttempt: hostedContext.runAttempt,
            imageVersion: hostedContext.imageVersion,
            nonce: hostedContext.nonce
        },
        originalQualification: {
            sourceSha: target.candidate.sourceSha,
            runId: QUALIFICATION_RUN_ID,
            runAttempt: QUALIFICATION_RUN_ATTEMPT,
            manifestSha256: target.originalQualification.manifest.sha256,
            archiveId: QUALIFICATION_ARCHIVE_ID,
            archiveDigest: target.originalQualification.archive.digest,
            provenance: "github-actions-archive"
        },
        candidates: expectedCandidates(acquisitionPlan),
        releaseGatesCleared: []
    };
    Object.defineProperty(binding, VALIDATED_BINDING, {value: true});
    return deepFreeze(binding);
}

function validateProofBinding(proof, binding) {
    const context = binding.oracleContext;
    const qualification = binding.originalQualification;
    const adapter = proof.adapterRequest;
    const expected = {
        expectedSourceSha: context.sourceSha,
        expectedEventSha: context.eventSha,
        expectedRunId: context.runId,
        expectedRunAttempt: context.runAttempt,
        expectedImageVersion: context.imageVersion,
        nonce: context.nonce
    };
    for (const [name, value] of Object.entries(expected)) {
        if (adapter[name] !== value) fail(`proof request differs: ${name}`);
    }
    const expectedQualification = {
        qualificationSourceSha: qualification.sourceSha,
        qualificationRunId: qualification.runId,
        qualificationRunAttempt: qualification.runAttempt,
        qualificationManifestArtifactId: qualification.archiveId,
        qualificationManifestArtifactDigest: qualification.archiveDigest,
        manifestSha256: qualification.manifestSha256
    };
    for (const [name, value] of Object.entries(expectedQualification)) {
        if (proof[name] !== value) fail(`proof qualification differs: ${name}`);
    }
    proof.candidates.forEach((observed, index) => {
        const candidate = binding.candidates[index];
        if (!candidate || observed.alias !== candidate.alias
                || observed.artifactLogicalName !== candidate.name
                || observed.artifactId !== candidate.releaseAssetId
                || observed.artifactDigest !== candidate.releaseAssetDigest
                || observed.sha256 !== candidate.sha256) {
            fail("proof published candidate identity differs");
        }
    });
}

// Created after the legacy proof/host requests are materialized but before native
// execution. The hosted path must retain these exact bytes with the evidence.
export function createV161PostReleaseStandaloneEnvelope(binding, retainedRequests) {
    requireBinding(binding, "envelope creation");
    exactKeys(retainedRequests, RETAINED_REQUEST_KEYS, "retained requests");
    const proofRequestSha256 = bytesSha256(retainedRequests.proofRequestBytes);
    const hostRequestSha256 = bytesSha256(retainedRequests.hostRequestBytes);
    const proof = assertWindowsNativeStandaloneProofRequest(
        parseBytes(retainedRequests.proofRequestBytes, "proof request"));
    const host = assertWindowsNativeStandaloneHostRequest(
        parseBytes(retainedRequests.hostRequestBytes, "host request"), proof);
    validateProofBinding(proof, binding);
    if (host.proofRequestSha256 !== proofRequestSha256) {
        fail("host request does not bind the retained proof request");
    }
    const value = deepFreeze({
        schemaVersion: SCHEMA_VERSION,
        kind: "myspeed-v1.6.1-post-release-standalone-preexecution-envelope",
        status: "sealed",
        qualifying: false,
        targetHashes: {...binding.targetHashes},
        oracleContext: {...binding.oracleContext},
        requests: {hostRequestSha256, proofRequestSha256},
        releaseGatesCleared: []
    });
    const bytes = Buffer.from(JSON.stringify(value), "utf8");
    return Object.freeze({value, bytes, sha256: bytesSha256(bytes)});
}

// Builds the legacy execution request set from already-acquired release payloads.
// The returned authority requires the envelope to be retained before a guarded
// hosted caller may invoke the existing execution path.
export function buildV161PostReleaseStandaloneProducerPlan(binding, acquired) {
    requireBinding(binding, "producer plan");
    exactKeys(acquired, ACQUIRED_KEYS, "acquired execution material");
    if (!Array.isArray(acquired.candidates)
            || acquired.candidates.length !== binding.candidates.length) {
        fail("acquired candidate set differs");
    }
    const candidates = acquired.candidates.map((candidate, index) => {
        exactKeys(candidate, ACQUIRED_CANDIDATE_KEYS, `acquired candidate ${index}`);
        const expected = binding.candidates[index];
        if (candidate.alias !== expected.alias || !candidate.sourceIdentity
                || candidate.sourceIdentity.bytes !== expected.bytes
                || candidate.sourceIdentity.sha256 !== expected.sha256) {
            fail(`acquired release payload differs: ${expected.alias}`);
        }
        return {
            alias: expected.alias,
            artifactLogicalName: expected.name,
            artifactId: expected.releaseAssetId,
            artifactDigest: expected.releaseAssetDigest,
            sourcePath: candidate.sourcePath,
            expectedSha256: expected.sha256,
            sourceIdentity: {...candidate.sourceIdentity},
            scenarios: candidate.scenarios.map(scenario => ({...scenario,
                candidateIdentity: {...scenario.candidateIdentity}}))
        };
    });
    const context = binding.oracleContext;
    const qualification = binding.originalQualification;
    const executionPlan = buildWindowsNativeStandaloneExecutionPlan({
        schemaVersion: SCHEMA_VERSION,
        kind: "myspeed-windows-native-standalone-execution-input",
        qualifying: false,
        expectedRunId: context.runId,
        expectedRunAttempt: context.runAttempt,
        expectedEventSha: context.eventSha,
        expectedSourceSha: context.sourceSha,
        expectedImageVersion: context.imageVersion,
        nonce: context.nonce,
        qualification: {
            sourceSha: qualification.sourceSha,
            runId: qualification.runId,
            runAttempt: qualification.runAttempt,
            manifestSha256: qualification.manifestSha256,
            artifactId: qualification.archiveId,
            artifactDigest: qualification.archiveDigest
        },
        taskRoot: acquired.taskRoot,
        closure: {...acquired.closure},
        node: {...acquired.node},
        powershell: {...acquired.powershell},
        fixtures: acquired.fixtures.map(fixture => ({...fixture})),
        candidates
    });
    const envelope = createV161PostReleaseStandaloneEnvelope(binding, {
        hostRequestBytes: executionPlan.hostRequestBytes,
        proofRequestBytes: executionPlan.proofRequestBytes
    });
    const producer = {
        schemaVersion: SCHEMA_VERSION,
        kind: "myspeed-v1.6.1-post-release-standalone-producer-plan",
        status: "ready-for-envelope-retention",
        authority: "retain-before-hosted-execution",
        qualifying: false,
        nativeExecutionAuthorized: false,
        targetHashes: {...binding.targetHashes},
        retention: {
            requiredBeforeNativeExecution: true,
            path: `${acquired.taskRoot}\\post-release-envelope.json`,
            envelope
        },
        executionPlan,
        releaseGatesCleared: []
    };
    Object.defineProperty(producer, VALIDATED_PRODUCER, {value: true});
    return Object.freeze(producer);
}

function validateProducerForRetention(producer) {
    if (!producer || typeof producer !== "object" || !Object.isFrozen(producer)
            || producer[VALIDATED_PRODUCER] !== true) {
        fail("retention requires a producer plan returned by this module");
    }
    exactKeys(producer, PRODUCER_KEYS, "producer plan");
    if (producer.nativeExecutionAuthorized !== false || producer.qualifying !== false
            || producer.retention?.requiredBeforeNativeExecution !== true) {
        fail("producer retention authority differs");
    }
    const plan = producer.executionPlan;
    const proofDigest = bytesSha256(plan.proofRequestBytes);
    const hostDigest = bytesSha256(plan.hostRequestBytes);
    if (proofDigest !== plan.proofRequestSha256 || hostDigest !== plan.hostRequestSha256) {
        fail("producer request bytes changed");
    }
    for (const request of plan.controllerRequests) {
        if (!Buffer.isBuffer(request.bytes) || bytesSha256(request.bytes) !== request.sha256
                || !isDeepStrictEqual(parseBytes(request.bytes, "producer controller request"), request.value)
                || request.alias !== request.value.alias || request.scenario !== request.value.scenario
                || request.path !== `${request.value.taskRoot}\\candidate.request.json`) {
            fail("producer controller request bytes changed");
        }
    }
    const proof = assertWindowsNativeStandaloneProofRequest(parseBytes(plan.proofRequestBytes, "producer proof request"));
    const host = assertWindowsNativeStandaloneHostRequest(parseBytes(plan.hostRequestBytes, "producer host request"), proof);
    if (!isDeepStrictEqual(plan.proofRequest, proof) || !isDeepStrictEqual(plan.hostRequest, host)
            || host.proofRequestSha256 !== proofDigest) fail("producer host/proof request binding differs");
    const envelope = producer.retention.envelope;
    if (!envelope || !Buffer.isBuffer(envelope.bytes) || bytesSha256(envelope.bytes) !== envelope.sha256
            || !isDeepStrictEqual(parseBytes(envelope.bytes, "producer envelope"), envelope.value)
            || envelope.value.requests.hostRequestSha256 !== hostDigest
            || envelope.value.requests.proofRequestSha256 !== proofDigest
            || !isDeepStrictEqual(envelope.value.targetHashes, producer.targetHashes)
            || producer.retention.path !== `${host.taskRoot}\\post-release-envelope.json`) {
        fail("producer retained envelope differs");
    }
}

export function writeV161PostReleaseEnvelopeExclusive({path: target, bytes}) {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAXIMUM_ENVELOPE_BYTES) {
        fail("envelope bytes are outside the retention bound");
    }
    const parent = path.dirname(target);
    const parentStat = fs.lstatSync(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()
            || fs.realpathSync(parent) !== parent) {
        fail("envelope parent is not an ordinary canonical directory");
    }
    const handle = fs.openSync(target, "wx", 0o600);
    try {
        fs.writeFileSync(handle, bytes);
        fs.fsyncSync(handle);
    } finally {
        fs.closeSync(handle);
    }
}

const defaultRetentionOperations = Object.freeze({
    writeEnvelope: async input => writeV161PostReleaseEnvelopeExclusive(input),
    readEnvelope: async path => fs.readFileSync(path),
    writeExecutionPlan: async plan => writeWindowsNativeStandaloneExecutionPlan(plan)
});

// This writes only the envelope and request documents. It never invokes the host;
// the existing guarded hosted execution remains a distinct later operation.
export async function retainV161PostReleaseStandaloneProducerPlan(producer,
        operations = defaultRetentionOperations) {
    validateProducerForRetention(producer);
    exactKeys(operations, RETENTION_OPERATIONS, "retention operations");
    for (const name of RETENTION_OPERATIONS) {
        if (typeof operations[name] !== "function") fail(`retention operation ${name} differs`);
    }
    const envelope = producer.retention.envelope;
    await operations.writeEnvelope({path: producer.retention.path, bytes: envelope.bytes});
    const retainedBytes = await operations.readEnvelope(producer.retention.path);
    if (!Buffer.isBuffer(retainedBytes) || !retainedBytes.equals(envelope.bytes)
            || bytesSha256(retainedBytes) !== envelope.sha256) {
        fail("retained preexecution envelope changed");
    }
    const execution = await operations.writeExecutionPlan(producer.executionPlan);
    return deepFreeze({
        schemaVersion: SCHEMA_VERSION,
        kind: "myspeed-v1.6.1-post-release-standalone-retention-result",
        status: "retained",
        qualifying: false,
        envelopePath: producer.retention.path,
        envelopeSha256: envelope.sha256,
        execution,
        nativeExecutionStarted: false,
        releaseGatesCleared: []
    });
}

function inspectEnvelope(envelopeBytes, binding, inspection) {
    const envelope = parseBytes(envelopeBytes, "preexecution envelope");
    exactKeys(envelope, ENVELOPE_KEYS, "preexecution envelope");
    if (envelope.schemaVersion !== SCHEMA_VERSION
            || envelope.kind !== "myspeed-v1.6.1-post-release-standalone-preexecution-envelope"
            || envelope.status !== "sealed" || envelope.qualifying !== false
            || !Array.isArray(envelope.releaseGatesCleared)
            || envelope.releaseGatesCleared.length !== 0) {
        fail("preexecution envelope state differs");
    }
    if (!isDeepStrictEqual(envelope.targetHashes, binding.targetHashes)
            || !isDeepStrictEqual(envelope.oracleContext, binding.oracleContext)) {
        fail("preexecution envelope target or hosted context differs");
    }
    exactKeys(envelope.requests, ["hostRequestSha256", "proofRequestSha256"], "envelope requests");
    for (const name of ["hostRequestSha256", "proofRequestSha256"]) {
        exactString(envelope.requests[name], SHA256, `envelope ${name}`);
        if (envelope.requests[name] !== inspection[name]) fail(`envelope evidence differs: ${name}`);
    }
    return {value: envelope, sha256: bytesSha256(envelopeBytes)};
}

function validateInspection(inspection, binding) {
    exactKeys(inspection, INSPECTION_KEYS, "oracle inspection");
    if (inspection.schemaVersion !== SCHEMA_VERSION
            || inspection.kind !== "myspeed-windows-native-standalone-evidence-inspection"
            || inspection.status !== "accepted") {
        fail("oracle inspection did not report accepted standalone evidence");
    }
    const context = binding.oracleContext;
    const qualification = binding.originalQualification;
    const expected = {
        sourceSha: context.sourceSha,
        eventSha: context.eventSha,
        runId: context.runId,
        runAttempt: context.runAttempt,
        imageVersion: context.imageVersion,
        nonce: context.nonce,
        qualificationSourceSha: qualification.sourceSha,
        qualificationRunId: qualification.runId,
        qualificationRunAttempt: qualification.runAttempt,
        qualificationManifestArtifactId: qualification.archiveId,
        qualificationManifestArtifactDigest: qualification.archiveDigest,
        manifestSha256: qualification.manifestSha256
    };
    for (const [name, value] of Object.entries(expected)) {
        if (inspection[name] !== value) fail(`oracle evidence differs: ${name}`);
    }
    if (inspection.qualifying !== false || inspection.releaseGatesCleared.length !== 0) {
        fail("oracle evidence asserted qualification or a release gate");
    }
    if (inspection.candidates.length !== binding.candidates.length) fail("oracle candidate count differs");
    inspection.candidates.forEach((observed, index) => {
        const expectedCandidate = binding.candidates[index];
        const expectedIdentity = {
            alias: expectedCandidate.alias,
            artifactLogicalName: expectedCandidate.name,
            artifactId: expectedCandidate.releaseAssetId,
            artifactDigest: expectedCandidate.releaseAssetDigest,
            candidateSha256: expectedCandidate.sha256
        };
        for (const [name, value] of Object.entries(expectedIdentity)) {
            if (observed[name] !== value) fail(`oracle published candidate differs: ${name}`);
        }
    });
}

// Raw retained evidence is semantically replayed by the existing full standalone
// oracle before this adapter can construct an addendum-review request.
export function inspectV161PostReleaseStandaloneEvidence(binding, evidence, envelopeBytes) {
    requireBinding(binding, "inspection");
    const inspection = inspectWindowsNativeStandaloneEvidence(evidence);
    validateInspection(inspection, binding);
    const envelope = inspectEnvelope(envelopeBytes, binding, inspection);
    return deepFreeze({
        schemaVersion: SCHEMA_VERSION,
        kind: "myspeed-v1.6.1-post-release-windows-native-addendum-request",
        status: "ready-for-addendum-review",
        authority: "addendum-review-only",
        qualifying: false,
        targetHashes: {...binding.targetHashes},
        candidateSourceSha: binding.oracleContext.sourceSha,
        harnessSourceSha: binding.oracleContext.eventSha,
        hostedRun: {
            repository: REPOSITORY,
            id: binding.oracleContext.runId,
            attempt: binding.oracleContext.runAttempt,
            imageVersion: binding.oracleContext.imageVersion,
            nonce: binding.oracleContext.nonce
        },
        originalQualification: {...binding.originalQualification},
        publishedCandidates: binding.candidates.map(candidate => ({...candidate})),
        envelope: {sha256: envelope.sha256, kind: envelope.value.kind},
        evidence: {
            oracle: "existing-full-windows-native-standalone",
            inspectionSha256: jsonSha256(inspection),
            hostRequestSha256: exactString(inspection.hostRequestSha256, SHA256, "host request SHA"),
            proofRequestSha256: exactString(inspection.proofRequestSha256, SHA256, "proof request SHA"),
            hostResultSha256: exactString(inspection.hostResultSha256, SHA256, "host result SHA")
        },
        proposedEvidence: {
            windowsNative: {status: "oracle-accepted", inspectionSha256: jsonSha256(inspection)},
            windowsCpuFloor: null,
            msiLifecycle: null
        },
        releaseGatesCleared: []
    });
}
