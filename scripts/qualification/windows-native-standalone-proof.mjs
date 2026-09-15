import {assertWindowsNativeAdapterRequest, assertWindowsNativeAdapterResult,
    assertWindowsNativeBoundaryEvidence} from "./windows-native-standalone-adapter.mjs";
import {createHash} from "node:crypto";
import {execFileSync, spawn} from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {performance} from "node:perf_hooks";
import {pathToFileURL} from "node:url";
import {setTimeout as delay} from "node:timers/promises";
import {checkPopulatedInstance, removeOwnedWork} from "./check-artifact.mjs";
import {loadHandoffFixture} from "./fixture.mjs";
import {checkPopulatedDatabase, checkResetDatabase} from "./sqlite-check.mjs";

const BOUNDARY_KIND = "myspeed-windows-offline-boundary-receipt";
const FIXTURE_KIND = "myspeed-windows-standalone-fixture";
const FIXTURE_CLEANUP_KIND = "myspeed-windows-standalone-fixture-cleanup";
const SESSION_KIND = "myspeed-windows-native-owned-session";
const READY_KIND = "myspeed-windows-native-session-ready";
const CLOSED_KIND = "myspeed-windows-native-session-closed";
const ASSERTIONS_KIND = "myspeed-existing-standalone-assertions";
const RUNTIME_NAMES = Object.freeze(["observeOffline", "prepareFixture", "openSession", "launchSession",
    "runAssertions", "closeSession", "cleanupFixture"]);
const PROOF_REQUEST_KIND = "myspeed-windows-native-standalone-proof-request";
const PROOF_RESULT_KIND = "myspeed-windows-native-standalone-proof-result";
const NORMAL_DEADLINE_MS = 600_000;
const HARD_DEADLINE_MS = 610_000;
const CANDIDATE_REQUEST_KIND = "myspeed-windows-native-candidate-request";
const CANDIDATE_READY_KIND = "myspeed-windows-native-candidate-ready";
const CANDIDATE_RESULT_KIND = "myspeed-windows-native-candidate-result";
const CANDIDATE_STOP_KIND = "myspeed-windows-native-candidate-stop";
const MAXIMUM_JSON_BYTES = 262_144;
const MAXIMUM_JSON_BASE64_CHARACTERS = Math.ceil(MAXIMUM_JSON_BYTES / 3) * 4;
const POLL_MILLISECONDS = 50;
const CONTROLLER_TIMEOUT_MILLISECONDS = 310_000;
const COORDINATOR_HEADROOM_MILLISECONDS = 60_000;
const COORDINATOR_WAIT_BUDGET_MILLISECONDS = NORMAL_DEADLINE_MS - COORDINATOR_HEADROOM_MILLISECONDS;
const DIAGNOSTIC_READ_BUDGET_MILLISECONDS = 1_000;
const CONTROLLER_STDERR_DRAIN_GRACE_MILLISECONDS = 1_000;
const MAXIMUM_FAILURE_MESSAGE_CHARACTERS = 512;
const MAXIMUM_CONTROLLER_STDERR_BYTES = 8 * 1024;
const MAXIMUM_LISTENER_DIAGNOSTIC_OWNERS = 4;
const MAXIMUM_LISTENER_DIAGNOSTIC_BYTES = 2_048;
const MAXIMUM_LISTENER_ROWS = 65_535;
const MAXIMUM_LISTENER_PROCESS_ID = 4_294_967_295;
const LISTENER_PROCESS_STATES = Object.freeze(["present", "exited", "unavailable"]);
const LISTENER_JOB_MEMBERSHIPS = Object.freeze(["in-job", "not-in-job", "unavailable"]);
const LISTENER_CREATION_FILE_TIME = /[0-9a-f]{16}/u;
const CONTROLLER_TIMEOUT_CODE = "ERR_MYSPEED_CONTROLLER_TIMEOUT";
const CONTROLLER_STDERR_TRUNCATED_MARKER = "[stderr truncated]";
const CONTROLLER_STDERR_UNAVAILABLE_MARKER = "[stderr unavailable]";
const HOST_RESULT_KIND = "myspeed-windows-native-standalone-host-result";
const HOST_REQUEST_KIND = "myspeed-windows-native-standalone-host-request";
const RECOVERY_REQUEST_KIND = "myspeed-windows-native-standalone-recovery-request";
const HOST_PHASES = Object.freeze(["arm-recovery", "disable-adapters", "launch-coordinator", "wait-coordinator",
    "prove-job-zero", "restore-adapters", "disarm-recovery", "cleanup"]);
const EXPECTED_HOST_ABI = Object.freeze({SecurityAttributesSize: 24, StartupInfoSize: 104,
    ProcessInformationSize: 24, FileTimeSize: 8, BasicLimitSize: 64, ExtendedLimitSize: 144,
    AccountingSize: 48, StartupInfoFlagsOffset: 60, StartupInfoOutputOffset: 88, SecurityDescriptorOffset: 8});

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

const exactKeys = (value, keys, label) => {
    if (!isObject(value)) throw new Error(`${label} must be an object`);
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
        throw new Error(`${label} keys differ`);
    return value;
};

const sha256 = (value, label) => {
    if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw new Error(`${label} differs`);
    return value;
};

const strictBoolean = (value, label) => {
    if (typeof value !== "boolean") throw new Error(`${label} must be Boolean`);
    return value;
};

const integer = (value, label, minimum, maximum) => {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
        throw new Error(`${label} must be an exact bounded integer`);
    return value;
};

const string = (value, label, pattern) => {
    if (typeof value !== "string" || value.length === 0 || value.length > 32_767)
        throw new Error(`${label} must be a bounded string`);
    if (pattern) {
        const match = pattern.exec(value);
        if (!match || match.index !== 0 || match[0].length !== value.length) throw new Error(`${label} differs`);
    }
    return value;
};

const windowsPath = (value, label) => {
    string(value, label);
    if (!path.win32.isAbsolute(value) || path.win32.normalize(value) !== value || /[\0\r\n]/u.test(value))
        throw new Error(`${label} must be a canonical absolute Windows path`);
    return value;
};

// Failure-only listener evidence. It never relaxes the Boolean acceptance rule; it only renders the bounded
// owner records the observer retained into the one channel a failed run keeps: the failure message, which the
// adapter normalizes and truncates to MAXIMUM_FAILURE_MESSAGE_CHARACTERS. Field labels are abbreviated so the
// actual creation file times of every retained owner fit that budget alongside the expected one; without them
// the real owner start times would not survive into the retained result at all.
const listenerDiagnosticSummary = (value, expectedCreationFileTime, label) => {
    exactKeys(value, ["schemaVersion", "matchingListenerCount", "distinctOwnerCount", "expectedOwnerListenerCount",
        "retainedOwnerCount", "ownersTruncated", "owners"], label);
    if (value.schemaVersion !== 1) throw new Error(`${label} schema differs`);
    integer(value.matchingListenerCount, `${label} listener count`, 0, MAXIMUM_LISTENER_ROWS);
    integer(value.distinctOwnerCount, `${label} owner count`, 0, value.matchingListenerCount);
    integer(value.expectedOwnerListenerCount, `${label} expected owner listener count`, 0,
        value.matchingListenerCount);
    integer(value.retainedOwnerCount, `${label} retained owner count`, 0,
        Math.min(value.distinctOwnerCount, MAXIMUM_LISTENER_DIAGNOSTIC_OWNERS));
    strictBoolean(value.ownersTruncated, `${label} truncation flag`);
    if (value.ownersTruncated !== (value.retainedOwnerCount < value.distinctOwnerCount))
        throw new Error(`${label} truncation flag differs`);
    if (!Array.isArray(value.owners) || value.owners.length !== value.retainedOwnerCount)
        throw new Error(`${label} owner records differ`);
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAXIMUM_LISTENER_DIAGNOSTIC_BYTES)
        throw new Error(`${label} exceeds its retained byte budget`);
    const observed = new Set();
    let retainedListeners = 0;
    let expectedOwnerListeners = 0;
    let expectedOwners = 0;
    const rendered = value.owners.map(owner => {
        exactKeys(owner, ["owningProcessId", "expectedOwner", "listenerCount", "processState", "creationFileTime",
            "creationTimeMatches", "jobMembership"], `${label} owner`);
        // PID 0 is a real Get-NetTCPConnection owner, so it must render as evidence rather than be rejected.
        integer(owner.owningProcessId, `${label} owner PID`, 0, MAXIMUM_LISTENER_PROCESS_ID);
        if (observed.has(owner.owningProcessId)) throw new Error(`${label} owner records repeat`);
        observed.add(owner.owningProcessId);
        strictBoolean(owner.expectedOwner, `${label} owner expectation`);
        integer(owner.listenerCount, `${label} owner listener count`, 1, value.matchingListenerCount);
        retainedListeners += owner.listenerCount;
        if (owner.expectedOwner) { expectedOwners += 1; expectedOwnerListeners += owner.listenerCount; }
        if (!LISTENER_PROCESS_STATES.includes(owner.processState))
            throw new Error(`${label} owner process state differs`);
        if (!LISTENER_JOB_MEMBERSHIPS.includes(owner.jobMembership))
            throw new Error(`${label} owner Job membership differs`);
        let creation = "none";
        if (owner.processState === "present") {
            creation = string(owner.creationFileTime, `${label} owner creation time`, LISTENER_CREATION_FILE_TIME);
            strictBoolean(owner.creationTimeMatches, `${label} owner creation match`);
            // The retained match flag must agree with the retained timestamps it claims to summarize.
            if (owner.creationTimeMatches !== (creation === expectedCreationFileTime))
                throw new Error(`${label} owner creation match differs`);
        } else if (owner.creationFileTime !== null || owner.creationTimeMatches !== null)
            throw new Error(`${label} unavailable owner identity differs`);
        return `pid=${owner.owningProcessId} exp=${owner.expectedOwner} rows=${owner.listenerCount}`
            + ` state=${owner.processState} ct=${creation} job=${owner.jobMembership}`;
    });
    if (expectedOwners > 1) throw new Error(`${label} expected owner records repeat`);
    if (retainedListeners > value.matchingListenerCount) throw new Error(`${label} owner listener counts differ`);
    if (!value.ownersTruncated && (retainedListeners !== value.matchingListenerCount
        || expectedOwnerListeners !== value.expectedOwnerListenerCount))
        throw new Error(`${label} owner listener counts differ`);
    return `rows=${value.matchingListenerCount} owners=${value.distinctOwnerCount}`
        + ` expectedRows=${value.expectedOwnerListenerCount} retained=${value.retainedOwnerCount}`
        + ` trunc=${value.ownersTruncated} expectedCt=${expectedCreationFileTime}`
        + `${rendered.length === 0 ? "" : `; ${rendered.join("; ")}`}`;
};

const jsonBytes = value => Buffer.from(JSON.stringify(value), "utf8");
const hashBytes = value => createHash("sha256").update(value).digest("hex");
const hashJson = value => hashBytes(jsonBytes(value));

const boundedBase64 = (value, label) => {
    if (typeof value !== "string" || value.length < 4 || value.length > MAXIMUM_JSON_BASE64_CHARACTERS)
        throw new Error(`${label} must be a bounded string`);
    const bytes = Buffer.from(value, "base64");
    if (bytes.length < 2 || bytes.length > MAXIMUM_JSON_BYTES || bytes.toString("base64") !== value)
        throw new Error(`${label} differs`);
    return bytes;
};

const retainedJson = (encoded, expectedSha256, retained, label) => {
    const bytes = boundedBase64(encoded, `${label} bytes`);
    if (sha256(expectedSha256, `${label} SHA`) !== hashBytes(bytes)) throw new Error(`${label} SHA differs`);
    let parsed;
    try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`${label} JSON differs`); }
    if (JSON.stringify(parsed) !== JSON.stringify(retained)) throw new Error(`${label} retained value differs`);
    return parsed;
};

const readBoundJson = (file, expectedSha256, label) => {
    const handle = fs.openSync(file, "r");
    try {
        const before = fs.fstatSync(handle);
        if (!before.isFile() || before.size < 2 || before.size > MAXIMUM_JSON_BYTES)
            throw new Error(`${label} size differs`);
        const bytes = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < bytes.length) {
            const read = fs.readSync(handle, bytes, offset, bytes.length - offset, offset);
            if (read === 0) throw new Error(`${label} read was short`);
            offset += read;
        }
        const after = fs.fstatSync(handle);
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
            throw new Error(`${label} changed while read`);
        const observedSha256 = hashBytes(bytes);
        if (expectedSha256 && observedSha256 !== expectedSha256) throw new Error(`${label} SHA differs`);
        return {value: JSON.parse(bytes.toString("utf8")), sha256: observedSha256};
    } finally {
        fs.closeSync(handle);
    }
};

const writeCreateNewJson = (file, value) => {
    const bytes = jsonBytes(value);
    if (bytes.length < 2 || bytes.length > MAXIMUM_JSON_BYTES) throw new Error("Owned JSON size differs");
    const handle = fs.openSync(file, "wx", 0o600);
    try {
        fs.writeFileSync(handle, bytes);
        fs.fsyncSync(handle);
    } finally {
        fs.closeSync(handle);
    }
    return hashBytes(bytes);
};

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const waitFor = async (operation, timeoutMilliseconds, label) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMilliseconds) {
        const value = await operation();
        if (value !== null) return value;
        await sleep(POLL_MILLISECONDS);
    }
    throw new Error(`${label} exceeded its deadline`);
};

export const assertWindowsNativeStandaloneProofRequest = value => {
    exactKeys(value, ["schemaVersion", "kind", "qualifying", "adapterRequest", "manifestSha256",
        "qualificationManifestArtifactId", "qualificationManifestArtifactDigest", "taskRoot",
        "resultPath", "fixtures", "candidateControllerPath", "candidateControllerSha256",
        "cleanStopControllerPath", "cleanStopControllerSha256", "hostPath", "hostSha256", "canaryPath",
        "canarySha256", "powershellPath", "qualificationSourceSha", "qualificationRunId", "qualificationRunAttempt",
        "powershellSha256", "normalDeadlineMs", "hardDeadlineMs", "candidates"], "Standalone proof request");
    integer(value.schemaVersion, "Standalone proof schema", 1, 1);
    if (string(value.kind, "Standalone proof kind") !== PROOF_REQUEST_KIND)
        throw new Error("Standalone proof kind differs");
    if (strictBoolean(value.qualifying, "Standalone proof qualifying"))
        throw new Error("Standalone proof must remain nonqualifying");
    const adapter = assertWindowsNativeAdapterRequest(value.adapterRequest);
    sha256(value.manifestSha256, "Standalone proof manifest SHA");
    string(value.qualificationManifestArtifactId, "Standalone qualification manifest artifact ID",
        /^[1-9][0-9]{0,19}$/u);
    string(value.qualificationManifestArtifactDigest, "Standalone qualification manifest artifact digest",
        /^sha256:[0-9a-f]{64}$/u);
    if (string(value.qualificationSourceSha, "Standalone qualification source SHA", /^[0-9a-f]{40}$/u)
        !== adapter.expectedSourceSha) throw new Error("Standalone qualification source differs");
    string(value.qualificationRunId, "Standalone qualification run ID", /^[1-9][0-9]{0,19}$/u);
    string(value.qualificationRunAttempt, "Standalone qualification run attempt", /^[1-9][0-9]{0,9}$/u);
    for (const name of ["taskRoot", "resultPath", "candidateControllerPath", "cleanStopControllerPath",
        "hostPath", "canaryPath", "powershellPath"])
        windowsPath(value[name], `Standalone proof ${name}`);
    if (!value.taskRoot.endsWith(`myspeed-native-standalone-${adapter.nonce}`))
        throw new Error("Standalone proof task root identity differs");
    if (value.resultPath !== `${value.taskRoot}\\proof.result.json`)
        throw new Error("Standalone proof result path differs");
    for (const name of ["candidateControllerSha256", "cleanStopControllerSha256", "hostSha256",
        "canarySha256", "powershellSha256"])
        sha256(value[name], `Standalone proof ${name}`);
    integer(value.normalDeadlineMs, "Standalone proof normal deadline", NORMAL_DEADLINE_MS, NORMAL_DEADLINE_MS);
    integer(value.hardDeadlineMs, "Standalone proof hard deadline", HARD_DEADLINE_MS, HARD_DEADLINE_MS);
    if (!Array.isArray(value.fixtures) || value.fixtures.length !== adapter.aliases.length)
        throw new Error("Standalone proof fixtures differ");
    value.fixtures.forEach((fixture, index) => {
        exactKeys(fixture, ["alias", "manifestPath", "manifestSha256", "populatedWork", "resetWork"], "Standalone proof fixture");
        if (string(fixture.alias, "Standalone proof fixture alias") !== adapter.aliases[index].alias)
            throw new Error("Standalone proof fixture alias order differs");
        for (const name of ["manifestPath", "populatedWork", "resetWork"])
            windowsPath(fixture[name], `Standalone proof fixture ${name}`);
        sha256(fixture.manifestSha256, "Standalone proof fixture manifest SHA");
        if (fixture.populatedWork === fixture.resetWork) throw new Error("Standalone proof fixture roots collide");
        for (const name of ["manifestPath", "populatedWork", "resetWork"])
            if (!fixture[name].startsWith(`${value.taskRoot}\\`))
                throw new Error(`Standalone proof fixture ${name} is outside task root`);
    });
    if (!Array.isArray(value.candidates) || value.candidates.length !== adapter.aliases.length)
        throw new Error("Standalone proof candidates differ");
    value.candidates.forEach((candidate, index) => {
        exactKeys(candidate, ["alias", "artifactLogicalName", "artifactId", "artifactDigest", "path", "sha256",
            "volumeSerial", "fileId", "controllerRequests"],
            "Standalone proof candidate");
        const expected = adapter.aliases[index];
        if (string(candidate.alias, "Standalone proof candidate alias") !== expected.alias
            || string(candidate.artifactLogicalName, "Standalone proof artifact identity") !== expected.artifactLogicalName
            || sha256(candidate.sha256, "Standalone proof candidate SHA") !== expected.candidateSha256)
            throw new Error("Standalone proof candidate binding differs");
        windowsPath(candidate.path, "Standalone proof candidate path");
        string(candidate.artifactId, "Standalone proof artifact ID", /^[1-9][0-9]{0,19}$/u);
        string(candidate.artifactDigest, "Standalone proof artifact digest", /^sha256:[0-9a-f]{64}$/u);
        string(candidate.volumeSerial, "Standalone proof candidate volume", /^[0-9a-f]{8}$/u);
        string(candidate.fileId, "Standalone proof candidate file ID", /^[0-9a-f]{16}$/u);
        if (!Array.isArray(candidate.controllerRequests) || candidate.controllerRequests.length !== 3)
            throw new Error("Standalone proof controller requests differ");
        candidate.controllerRequests.forEach((controllerRequest, scenarioIndex) => {
            exactKeys(controllerRequest, ["scenario", "path", "sha256", "taskRoot", "candidatePath",
                "controllerPath"], "Standalone proof controller request");
            const scenarios = ["populated-first-boot", "populated-restart", "fresh-no-config-reset"];
            if (string(controllerRequest.scenario, "Standalone proof controller scenario") !== scenarios[scenarioIndex])
                throw new Error("Standalone proof controller scenario order differs");
            windowsPath(controllerRequest.path, "Standalone proof controller request path");
            sha256(controllerRequest.sha256, "Standalone proof controller request SHA");
            for (const name of ["taskRoot", "candidatePath", "controllerPath"])
                windowsPath(controllerRequest[name], `Standalone proof controller ${name}`);
            if (!controllerRequest.path.startsWith(`${controllerRequest.taskRoot}\\`)
                || !controllerRequest.candidatePath.startsWith(`${controllerRequest.taskRoot}\\`)
                || !controllerRequest.controllerPath.startsWith(`${controllerRequest.taskRoot}\\`))
                throw new Error("Standalone proof controller path escapes its task root");
            if (controllerRequest.path !== `${controllerRequest.taskRoot}\\candidate.request.json`
                || controllerRequest.candidatePath !== `${controllerRequest.taskRoot}\\MySpeed.exe`
                || controllerRequest.controllerPath !== `${controllerRequest.taskRoot}\\windows-clean-stop-controller.ps1`)
                throw new Error("Standalone proof controller owned path differs");
        });
    });
    return value;
};

export const assertWindowsNativeStandaloneProofResult = (value, proofValue) => {
    const proof = assertWindowsNativeStandaloneProofRequest(proofValue);
    exactKeys(value, ["schemaVersion", "kind", "status", "qualifying", "manifestSha256", "sourceSha", "eventSha",
        "runId", "runAttempt", "imageVersion", "nonce", "qualificationSourceSha", "qualificationRunId",
        "qualificationRunAttempt", "qualificationManifestArtifactId", "qualificationManifestArtifactDigest",
        "candidates", "adapter", "releaseGatesCleared"], "Standalone proof result");
    integer(value.schemaVersion, "Standalone proof result schema", 1, 1);
    if (value.kind !== PROOF_RESULT_KIND || value.status !== "completed"
        || strictBoolean(value.qualifying, "Standalone proof result qualifying"))
        throw new Error("Standalone proof result did not complete");
    const adapter = proof.adapterRequest;
    const bindings = {manifestSha256: proof.manifestSha256, sourceSha: adapter.expectedSourceSha,
        eventSha: adapter.expectedEventSha, runId: adapter.expectedRunId, runAttempt: adapter.expectedRunAttempt,
        imageVersion: adapter.expectedImageVersion, nonce: adapter.nonce,
        qualificationSourceSha: proof.qualificationSourceSha, qualificationRunId: proof.qualificationRunId,
        qualificationRunAttempt: proof.qualificationRunAttempt,
        qualificationManifestArtifactId: proof.qualificationManifestArtifactId,
        qualificationManifestArtifactDigest: proof.qualificationManifestArtifactDigest};
    for (const [name, expected] of Object.entries(bindings))
        if (value[name] !== expected) throw new Error(`Standalone proof result binding differs: ${name}`);
    if (!Array.isArray(value.releaseGatesCleared) || value.releaseGatesCleared.length !== 0)
        throw new Error("Standalone proof result cleared a release gate");
    if (!Array.isArray(value.candidates) || value.candidates.length !== proof.candidates.length)
        throw new Error("Standalone proof result candidates differ");
    value.candidates.forEach((candidate, index) => {
        exactKeys(candidate, ["alias", "artifactLogicalName", "artifactId", "artifactDigest", "candidateSha256"],
            "Standalone proof result candidate");
        const expected = proof.candidates[index];
        const candidateBindings = {alias: expected.alias, artifactLogicalName: expected.artifactLogicalName,
            artifactId: expected.artifactId, artifactDigest: expected.artifactDigest, candidateSha256: expected.sha256};
        for (const [name, expectedValue] of Object.entries(candidateBindings))
            if (candidate[name] !== expectedValue) throw new Error(`Standalone proof candidate binding differs: ${name}`);
    });
    const adapterResult = assertWindowsNativeAdapterResult(value.adapter, adapter);
    proof.fixtures.forEach((fixture, index) => {
        if (adapterResult.aliases[index].fixture.manifestSha256 !== fixture.manifestSha256)
            throw new Error("Standalone fixture manifest binding differs");
    });
    return value;
};

const assertHostAdapterSet = (value, expected, enabled, label) => {
    if (!Array.isArray(value) || value.length !== expected.length) throw new Error(`${label} differs`);
    value.forEach((adapter, index) => {
        exactKeys(adapter, ["interfaceGuid", "netLuid", "enabled"], label);
        const target = expected[index];
        if (string(adapter.interfaceGuid, `${label} GUID`, /^\{[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\}$/u)
            !== target.interfaceGuid || string(adapter.netLuid, `${label} LUID`, /^[0-9a-f]{16}$/u) !== target.netLuid
            || strictBoolean(adapter.enabled, `${label} enabled`) !== enabled) throw new Error(`${label} binding differs`);
    });
};

export const assertWindowsNativeStandaloneHostRequest = (value, proof) => {
    exactKeys(value, ["schemaVersion", "kind", "expectedRunId", "expectedRunAttempt", "expectedEventSha",
        "expectedSourceSha", "expectedImageVersion", "nonce", "manifestSha256", "taskRoot", "hostPath",
        "hostSha256", "canaryPath", "canarySha256", "coordinatorExecutablePath", "coordinatorExecutableSha256",
        "coordinatorModuleSha256", "proofRequestSha256", "proofResultPath", "coordinatorArguments",
        "workingDirectory", "resultPath", "entryDiagnosticPath", "recoveryRequestPath", "recoveryReadyPath",
        "recoveryResultPath", "cancelPath", "lockPath", "jobName", "taskName", "normalDeadlineMs",
        "hardDeadlineMs"], "Standalone host request");
    integer(value.schemaVersion, "Standalone host request schema", 1, 1);
    if (value.kind !== HOST_REQUEST_KIND) throw new Error("Standalone host request kind differs");
    const adapter = proof.adapterRequest;
    const bindings = {expectedRunId: adapter.expectedRunId, expectedRunAttempt: adapter.expectedRunAttempt,
        expectedEventSha: adapter.expectedEventSha, expectedSourceSha: adapter.expectedSourceSha,
        expectedImageVersion: adapter.expectedImageVersion, nonce: adapter.nonce,
        manifestSha256: proof.manifestSha256, taskRoot: proof.taskRoot, hostPath: proof.hostPath,
        hostSha256: proof.hostSha256, canaryPath: proof.canaryPath, canarySha256: proof.canarySha256,
        proofResultPath: proof.resultPath};
    for (const [name, expected] of Object.entries(bindings))
        if (value[name] !== expected) throw new Error(`Standalone host request binding differs: ${name}`);
    for (const name of ["coordinatorExecutableSha256", "coordinatorModuleSha256", "proofRequestSha256"])
        sha256(value[name], `Standalone host request ${name}`);
    for (const name of ["taskRoot", "hostPath", "canaryPath", "coordinatorExecutablePath", "proofResultPath",
        "workingDirectory", "resultPath", "entryDiagnosticPath", "recoveryRequestPath", "recoveryReadyPath",
        "recoveryResultPath", "cancelPath", "lockPath"])
        windowsPath(value[name], `Standalone host request ${name}`);
    const owned = {resultPath: "host.result.json", entryDiagnosticPath: "host.entry-failure.json",
        recoveryRequestPath: "recovery.request.json", recoveryReadyPath: "recovery.ready.json",
        recoveryResultPath: "recovery.result.json", cancelPath: "recovery.cancel", lockPath: "recovery.lock"};
    for (const [name, file] of Object.entries(owned))
        if (value[name] !== path.win32.join(value.taskRoot, file))
            throw new Error(`Standalone host request ${name} differs`);
    if (value.workingDirectory !== value.taskRoot || new Set(Object.keys(owned).map(name => value[name])).size !== 7)
        throw new Error("Standalone host request owned paths differ");
    if (!Array.isArray(value.coordinatorArguments) || value.coordinatorArguments.length !== 5
        || path.win32.extname(windowsPath(value.coordinatorArguments[0], "Standalone coordinator module")) !== ".mjs"
        || value.coordinatorArguments[1] !== "--request"
        || windowsPath(value.coordinatorArguments[2], "Standalone coordinator request")
            !== path.win32.join(value.taskRoot, "proof.request.json")
        || value.coordinatorArguments[3] !== "--sha256"
        || value.coordinatorArguments[4] !== value.proofRequestSha256)
        throw new Error("Standalone host request coordinator arguments differ");
    if (value.jobName !== `Global\\MySpeedStandaloneJob-${adapter.nonce}`
        || value.taskName !== `MySpeedStandaloneRecovery-${adapter.nonce}`)
        throw new Error("Standalone host request recovery identity differs");
    integer(value.normalDeadlineMs, "Standalone host normal deadline", NORMAL_DEADLINE_MS, NORMAL_DEADLINE_MS);
    integer(value.hardDeadlineMs, "Standalone host hard deadline", HARD_DEADLINE_MS, HARD_DEADLINE_MS);
    return value;
};

const assertStandaloneRecoveryRequest = (value, hostRequest, hostRequestSha256, targets) => {
    exactKeys(value, ["schemaVersion", "kind", "expectedRunId", "expectedRunAttempt", "expectedEventSha",
        "expectedSourceSha", "expectedImageVersion", "nonce", "hostPath", "hostSha256", "canaryPath",
        "canarySha256", "requestSha256", "taskRoot", "jobName", "taskName", "recoveryRequestPath",
        "recoveryReadyPath", "recoveryResultPath", "cancelPath", "lockPath", "watchdogDeadline100ns",
        "adapters"], "Standalone recovery request");
    integer(value.schemaVersion, "Standalone recovery request schema", 1, 1);
    if (value.kind !== RECOVERY_REQUEST_KIND) throw new Error("Standalone recovery request kind differs");
    const bindings = {expectedRunId: hostRequest.expectedRunId, expectedRunAttempt: hostRequest.expectedRunAttempt,
        expectedEventSha: hostRequest.expectedEventSha, expectedSourceSha: hostRequest.expectedSourceSha,
        expectedImageVersion: hostRequest.expectedImageVersion, nonce: hostRequest.nonce,
        hostPath: hostRequest.hostPath, hostSha256: hostRequest.hostSha256, canaryPath: hostRequest.canaryPath,
        canarySha256: hostRequest.canarySha256, requestSha256: hostRequestSha256,
        taskRoot: hostRequest.taskRoot, jobName: hostRequest.jobName, taskName: hostRequest.taskName,
        recoveryRequestPath: hostRequest.recoveryRequestPath, recoveryReadyPath: hostRequest.recoveryReadyPath,
        recoveryResultPath: hostRequest.recoveryResultPath, cancelPath: hostRequest.cancelPath,
        lockPath: hostRequest.lockPath};
    for (const [name, expected] of Object.entries(bindings))
        if (value[name] !== expected) throw new Error(`Standalone recovery request binding differs: ${name}`);
    string(value.watchdogDeadline100ns, "Standalone recovery deadline", /^[1-9][0-9]{0,19}$/u);
    if (JSON.stringify(value.adapters) !== JSON.stringify(targets))
        throw new Error("Standalone recovery request adapters differ");
    return value;
};

export const assertWindowsNativeStandaloneCombinedResult = (value, proofValue, hostRequest, expectedHostRequestSha256) => {
    const proof = assertWindowsNativeStandaloneProofRequest(proofValue);
    exactKeys(value, ["schemaVersion", "kind", "status", "qualifying", "manifestSha256", "sourceSha", "eventSha",
        "runId", "runAttempt", "imageVersion", "nonce", "requestSha256", "requestBase64", "abi", "coordinator", "job", "recovery",
        "restoration", "lifecycle", "proof", "releaseGatesCleared"], "Standalone combined result");
    integer(value.schemaVersion, "Standalone combined result schema", 1, 1);
    if (value.kind !== HOST_RESULT_KIND || value.status !== "completed"
        || strictBoolean(value.qualifying, "Standalone combined result qualifying"))
        throw new Error("Standalone combined result did not complete");
    const adapter = proof.adapterRequest;
    const bindings = {manifestSha256: proof.manifestSha256, sourceSha: adapter.expectedSourceSha,
        eventSha: adapter.expectedEventSha, runId: adapter.expectedRunId, runAttempt: adapter.expectedRunAttempt,
        imageVersion: adapter.expectedImageVersion, nonce: adapter.nonce,
        requestSha256: sha256(expectedHostRequestSha256, "Standalone host request SHA")};
    for (const [name, expected] of Object.entries(bindings))
        if (value[name] !== expected) throw new Error(`Standalone combined result binding differs: ${name}`);
    const retainedHostRequest = retainedJson(value.requestBase64, value.requestSha256, hostRequest,
        "Standalone host request");
    assertWindowsNativeStandaloneHostRequest(retainedHostRequest, proof);
    if (!Array.isArray(value.releaseGatesCleared) || value.releaseGatesCleared.length !== 0)
        throw new Error("Standalone combined result cleared a release gate");

    exactKeys(value.abi, Object.keys(EXPECTED_HOST_ABI), "Standalone host ABI");
    for (const [name, expected] of Object.entries(EXPECTED_HOST_ABI))
        if (integer(value.abi[name], `Standalone host ABI ${name}`, expected, expected) !== expected)
            throw new Error(`Standalone host ABI differs: ${name}`);

    exactKeys(value.coordinator, ["executablePath", "executableSha256", "moduleSha256", "proofRequestSha256",
        "proofRequestBase64",
        "processId", "creationFileTime", "imagePath", "assignedBeforeResume", "resumed", "exitCode",
        "activeProcessesAfterWait", "proofResultSha256", "proofResultBase64"], "Standalone coordinator evidence");
    const retainedProofRequest = retainedJson(value.coordinator.proofRequestBase64,
        value.coordinator.proofRequestSha256, proofValue, "Standalone proof request");
    assertWindowsNativeStandaloneProofRequest(retainedProofRequest);
    if (value.coordinator.executablePath !== hostRequest.coordinatorExecutablePath
        || value.coordinator.imagePath.toLowerCase() !== hostRequest.coordinatorExecutablePath.toLowerCase()
        || value.coordinator.executableSha256 !== hostRequest.coordinatorExecutableSha256
        || value.coordinator.moduleSha256 !== hostRequest.coordinatorModuleSha256
        || value.coordinator.proofRequestSha256 !== hostRequest.proofRequestSha256)
        throw new Error("Standalone coordinator identity differs");
    integer(value.coordinator.processId, "Standalone coordinator PID", 1, 0xffff_ffff);
    string(value.coordinator.creationFileTime, "Standalone coordinator creation time", /^[0-9a-f]{16}$/u);
    if (!strictBoolean(value.coordinator.assignedBeforeResume, "Standalone coordinator Job assignment")
        || !strictBoolean(value.coordinator.resumed, "Standalone coordinator resume")
        || integer(value.coordinator.exitCode, "Standalone coordinator exit", 0, 0) !== 0
        || integer(value.coordinator.activeProcessesAfterWait, "Standalone coordinator active processes", 0, 0) !== 0)
        throw new Error("Standalone coordinator lifecycle proof failed");
    const proofBytes = boundedBase64(value.coordinator.proofResultBase64, "Standalone coordinator proof bytes");
    if (sha256(value.coordinator.proofResultSha256, "Standalone coordinator proof SHA") !== hashBytes(proofBytes))
        throw new Error("Standalone coordinator proof SHA differs");
    let parsedProof;
    try { parsedProof = JSON.parse(proofBytes.toString("utf8")); } catch { throw new Error("Standalone coordinator proof JSON differs"); }
    if (JSON.stringify(parsedProof) !== JSON.stringify(value.proof)) throw new Error("Standalone retained proof bytes differ");
    assertWindowsNativeStandaloneProofResult(value.proof, proof);

    exactKeys(value.job, ["name", "activeProcessesBeforeRestore", "treeExitProven", "handlesClosed"],
        "Standalone outer Job evidence");
    if (value.job.name !== hostRequest.jobName
        || integer(value.job.activeProcessesBeforeRestore, "Standalone outer Job active processes", 0, 0) !== 0
        || !strictBoolean(value.job.treeExitProven, "Standalone outer Job tree exit")
        || !strictBoolean(value.job.handlesClosed, "Standalone outer Job handle closure"))
        throw new Error("Standalone outer Job cleanup proof failed");

    exactKeys(value.recovery, ["request", "requestSha256", "requestBase64", "ready", "readySha256", "readyBase64",
        "cancel", "cancelSha256", "cancelBase64", "emergencyResultPresent",
        "processExitProven", "taskUnregistered"], "Standalone recovery evidence");
    const recoveryRequest = retainedJson(value.recovery.requestBase64, value.recovery.requestSha256,
        value.recovery.request, "Standalone recovery request");
    const recoveryReady = retainedJson(value.recovery.readyBase64, value.recovery.readySha256,
        value.recovery.ready, "Standalone recovery readiness");
    const recoveryCancel = retainedJson(value.recovery.cancelBase64, value.recovery.cancelSha256,
        value.recovery.cancel, "Standalone recovery cancellation");
    if (strictBoolean(value.recovery.emergencyResultPresent, "Standalone emergency recovery presence")
        || !strictBoolean(value.recovery.processExitProven, "Standalone recovery process exit")
        || !strictBoolean(value.recovery.taskUnregistered, "Standalone recovery task removal"))
        throw new Error("Standalone recovery cleanup proof failed");
    exactKeys(recoveryReady, ["schemaVersion", "kind", "requestSha256", "jobName", "pid",
        "creationFileTime", "jobOpened", "limitsProven"], "Standalone recovery readiness");
    if (recoveryReady.schemaVersion !== 1
        || recoveryReady.kind !== "myspeed-windows-native-standalone-recovery-ready"
        || recoveryReady.requestSha256 !== value.recovery.requestSha256
        || recoveryReady.jobName !== hostRequest.jobName
        || !strictBoolean(recoveryReady.jobOpened, "Standalone recovery Job open")
        || !strictBoolean(recoveryReady.limitsProven, "Standalone recovery Job limits"))
        throw new Error("Standalone recovery readiness differs");
    integer(recoveryReady.pid, "Standalone recovery PID", 1, 0xffff_ffff);
    string(recoveryReady.creationFileTime, "Standalone recovery creation time", /^[0-9a-f]{16}$/u);
    exactKeys(recoveryCancel, ["schemaVersion", "kind", "requestSha256"], "Standalone recovery cancellation");
    if (recoveryCancel.schemaVersion !== 1 || recoveryCancel.kind !== "myspeed-windows-native-standalone-recovery-cancel"
        || recoveryCancel.requestSha256 !== value.recovery.requestSha256)
        throw new Error("Standalone recovery cancellation differs");

    exactKeys(value.restoration, ["mode", "watchdogDeadline100ns", "started100ns", "ended100ns",
        "offlineBoundarySha256", "offlineBoundaryBase64", "targets", "before", "after"],
    "Standalone restoration evidence");
    if (value.restoration.mode !== "normal") throw new Error("Standalone restoration mode differs");
    const deadline = BigInt(string(value.restoration.watchdogDeadline100ns, "Standalone watchdog deadline", /^[1-9][0-9]{0,19}$/u));
    const started = BigInt(string(value.restoration.started100ns, "Standalone restoration start", /^[1-9][0-9]{0,19}$/u));
    const ended = BigInt(string(value.restoration.ended100ns, "Standalone restoration end", /^[1-9][0-9]{0,19}$/u));
    if (started >= deadline || ended < started || ended >= deadline) throw new Error("Standalone restoration timing differs");
    const restoredBoundary = assertWindowsNativeBoundaryEvidence(value.restoration.offlineBoundaryBase64,
        value.restoration.offlineBoundarySha256);
    if (!Array.isArray(value.restoration.targets) || value.restoration.targets.length < 1
        || value.restoration.targets.length > 64) throw new Error("Standalone restoration targets differ");
    const guids = new Set();
    const luids = new Set();
    value.restoration.targets.forEach(target => {
        exactKeys(target, ["interfaceGuid", "netLuid"], "Standalone restoration target");
        string(target.interfaceGuid, "Standalone restoration target GUID", /^\{[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\}$/u);
        string(target.netLuid, "Standalone restoration target LUID", /^[0-9a-f]{16}$/u);
        if (guids.has(target.interfaceGuid) || luids.has(target.netLuid))
            throw new Error("Standalone restoration target is duplicated");
        guids.add(target.interfaceGuid);
        luids.add(target.netLuid);
    });
    assertStandaloneRecoveryRequest(recoveryRequest, retainedHostRequest, value.requestSha256,
        value.restoration.targets);
    if (recoveryRequest.watchdogDeadline100ns !== value.restoration.watchdogDeadline100ns)
        throw new Error("Standalone recovery request restoration binding differs");
    assertHostAdapterSet(value.restoration.before, value.restoration.targets, false, "Standalone pre-restore adapter");
    assertHostAdapterSet(value.restoration.after, value.restoration.targets, true, "Standalone restored adapter");

    exactKeys(value.lifecycle, ["schemaVersion", "kind", "status", "qualifying", "releaseGatesCleared",
        "jobZeroBeforeRestore", "adaptersRestored", "events", "failures"], "Standalone host lifecycle");
    if (value.lifecycle.schemaVersion !== 1 || value.lifecycle.kind !== HOST_RESULT_KIND
        || value.lifecycle.status !== "completed" || value.lifecycle.qualifying !== false
        || value.lifecycle.jobZeroBeforeRestore !== true || value.lifecycle.adaptersRestored !== true
        || !Array.isArray(value.lifecycle.releaseGatesCleared) || value.lifecycle.releaseGatesCleared.length !== 0
        || !Array.isArray(value.lifecycle.failures) || value.lifecycle.failures.length !== 0
        || !Array.isArray(value.lifecycle.events) || JSON.stringify(value.lifecycle.events) !== JSON.stringify(HOST_PHASES))
        throw new Error("Standalone host lifecycle differs");
    const boundaries = value.proof.adapter.aliases.flatMap(alias => [alias.beforeFixtureBoundary,
        ...alias.scenarios.flatMap(scenario => [scenario.beforeLaunchBoundary, scenario.afterStopBoundary])]);
    const decodedBoundaries = [restoredBoundary, ...boundaries.map(boundary => assertWindowsNativeBoundaryEvidence(
        boundary.boundaryBase64, boundary.boundarySha256))];
    const restorationTargets = new Map(value.restoration.targets.map(target =>
        [`${target.interfaceGuid}\0${target.netLuid}`, target]));
    for (const boundary of decodedBoundaries)
        for (const target of restorationTargets.values())
            if (boundary.adapters.filter(adapter => adapter.interfaceGuid === target.interfaceGuid
                && adapter.netLuid === target.netLuid && adapter.enabled === false).length !== 1)
                throw new Error("Standalone restoration target is not bound to the offline inventory");
    return value;
};

const parseStandaloneEvidenceBytes = (value, label) => {
    if (!Buffer.isBuffer(value) || value.length < 2 || value.length > MAXIMUM_JSON_BYTES)
        throw new Error(`${label} bytes are outside their bound`);
    let parsed;
    try { parsed = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(value)); }
    catch { throw new Error(`${label} JSON differs`); }
    return {value: parsed, sha256: hashBytes(value)};
};

export const inspectWindowsNativeStandaloneEvidence = input => {
    exactKeys(input, ["hostRequestBytes", "proofRequestBytes", "hostResultBytes"],
        "Standalone evidence inspection input");
    const hostRequest = parseStandaloneEvidenceBytes(input.hostRequestBytes, "Standalone host request");
    const proofRequest = parseStandaloneEvidenceBytes(input.proofRequestBytes, "Standalone proof request");
    const hostResult = parseStandaloneEvidenceBytes(input.hostResultBytes, "Standalone host result");
    const proof = assertWindowsNativeStandaloneProofRequest(proofRequest.value);
    const result = assertWindowsNativeStandaloneCombinedResult(hostResult.value, proof,
        hostRequest.value, hostRequest.sha256);
    if (hostRequest.value.proofRequestSha256 !== proofRequest.sha256)
        throw new Error("Standalone retained proof request SHA differs");
    return {schemaVersion: 1, kind: "myspeed-windows-native-standalone-evidence-inspection",
        status: "accepted", qualifying: false, sourceSha: result.sourceSha, eventSha: result.eventSha,
        runId: result.runId, runAttempt: result.runAttempt, imageVersion: result.imageVersion, nonce: result.nonce,
        qualificationSourceSha: proof.qualificationSourceSha,
        qualificationRunId: proof.qualificationRunId, qualificationRunAttempt: proof.qualificationRunAttempt,
        qualificationManifestArtifactId: proof.qualificationManifestArtifactId,
        qualificationManifestArtifactDigest: proof.qualificationManifestArtifactDigest,
        manifestSha256: proof.manifestSha256, hostRequestSha256: hostRequest.sha256,
        proofRequestSha256: proofRequest.sha256, hostResultSha256: hostResult.sha256,
        candidates: proof.candidates.map(candidate => ({alias: candidate.alias,
            artifactLogicalName: candidate.artifactLogicalName, artifactId: candidate.artifactId,
            artifactDigest: candidate.artifactDigest, candidateSha256: candidate.sha256})), releaseGatesCleared: []};
};

const assertControllerRequestBinding = (value, proof, candidate, scenario, definition) => {
    if (!isObject(value) || value.kind !== CANDIDATE_REQUEST_KIND || value.schemaVersion !== 1)
        throw new Error("Candidate controller request kind differs");
    const adapter = proof.adapterRequest;
    const bindings = {expectedRunId: adapter.expectedRunId, expectedRunAttempt: adapter.expectedRunAttempt,
        expectedSourceSha: adapter.expectedSourceSha, expectedEventSha: adapter.expectedEventSha,
        expectedImageVersion: adapter.expectedImageVersion, alias: candidate.alias,
        artifactLogicalName: candidate.artifactLogicalName, scenario, candidateSha256: candidate.sha256,
        manifestSha256: proof.manifestSha256, taskRoot: definition.taskRoot,
        candidatePath: definition.candidatePath, controllerPath: definition.controllerPath,
        controllerSha256: proof.cleanStopControllerSha256};
    for (const [name, expected] of Object.entries(bindings))
        if (value[name] !== expected) throw new Error(`Candidate controller request binding differs: ${name}`);
    string(value.nonce, "Candidate controller nonce", /^[0-9a-f]{32}$/u);
    windowsPath(value.taskRoot, "Candidate controller task root");
    for (const name of ["candidatePath", "workingDirectory", "stdoutPath", "stderrPath", "readyPath",
        "stopRequestPath", "resultPath", "controllerPath"])
        windowsPath(value[name], `Candidate controller ${name}`);
    if (value.workingDirectory !== (scenario === "fresh-no-config-reset"
        ? proof.fixtures.find(entry => entry.alias === candidate.alias).resetWork
        : proof.fixtures.find(entry => entry.alias === candidate.alias).populatedWork))
        throw new Error("Candidate controller working directory differs from sealed fixture");
    return value;
};

const assertCandidateReady = (value, controllerRequest) => {
    exactKeys(value, ["schemaVersion", "kind", "nonce", "manifestSha256", "alias", "scenario",
        "artifactLogicalName", "candidateSha256", "candidatePid", "candidateCreationTime",
        "retainedHandleAuthority", "jobAssignedBeforeResume", "handleListConfigured"], "Candidate ready");
    if (value.schemaVersion !== 1 || value.kind !== CANDIDATE_READY_KIND
        || value.nonce !== controllerRequest.nonce || value.manifestSha256 !== controllerRequest.manifestSha256
        || value.alias !== controllerRequest.alias || value.scenario !== controllerRequest.scenario
        || value.artifactLogicalName !== controllerRequest.artifactLogicalName
        || value.candidateSha256 !== controllerRequest.candidateSha256)
        throw new Error("Candidate ready binding differs");
    integer(value.candidatePid, "Candidate ready PID", 1, 0xffff_ffff);
    string(value.candidateCreationTime, "Candidate ready creation time", /^[0-9a-f]{16}$/u);
    for (const name of ["retainedHandleAuthority", "jobAssignedBeforeResume", "handleListConfigured"])
        if (!strictBoolean(value[name], `Candidate ready ${name}`)) throw new Error(`Candidate ready proof failed: ${name}`);
    return value;
};

const assertCandidateResult = (value, request, ready) => {
    const keys = ["schemaVersion", "kind", "status", "qualifying", "releaseGatesCleared", "alias",
        "artifactLogicalName", "scenario", "stopKind", "candidatePid", "candidateCreationTime",
        "candidateExited", "exitCode", "forced", "jobActiveProcesses", "handleCleanupAttempted",
        "handlesClosed", "processTreeExitProven", "listenerGone", "elapsedMs", "failures"];
    exactKeys(value, keys, "Candidate result");
    if (value.schemaVersion !== 1 || value.kind !== CANDIDATE_RESULT_KIND || value.status !== "completed"
        || value.qualifying !== false || !Array.isArray(value.releaseGatesCleared) || value.releaseGatesCleared.length !== 0
        || value.alias !== request.alias || value.artifactLogicalName !== request.artifactLogicalName
        || value.scenario !== request.scenario || value.candidatePid !== ready.candidatePid
        || value.candidateCreationTime !== ready.candidateCreationTime)
        throw new Error("Candidate result binding differs");
    for (const name of ["candidateExited", "handleCleanupAttempted", "handlesClosed", "processTreeExitProven"])
        if (value[name] !== true) throw new Error(`Candidate result proof failed: ${name}`);
    if (value.forced !== false || value.jobActiveProcesses !== 0 || !Array.isArray(value.failures)
        || value.failures.length !== 0 || value.listenerGone !== false)
        throw new Error("Candidate result cleanup differs");
    integer(value.schemaVersion, "Candidate result schema", 1, 1);
    integer(value.candidatePid, "Candidate result PID", 1, 0xffff_ffff);
    string(value.candidateCreationTime, "Candidate result creation time", /^[0-9a-f]{16}$/u);
    integer(value.exitCode, "Candidate result exit code", 0, 0xffff_ffff);
    integer(value.jobActiveProcesses, "Candidate result active process count", 0, 0);
    integer(value.elapsedMs, "Candidate result elapsed time", 0, CONTROLLER_TIMEOUT_MILLISECONDS);
    const reset = request.scenario === "fresh-no-config-reset";
    if (value.stopKind !== (reset ? "observed-exit" : "ctrl-c") || value.exitCode !== (reset ? 113 : 0))
        throw new Error("Candidate result exit behavior differs");
    return value;
};

const candidateFailureDiagnostic = (value, request, ready) => {
    const keys = ["schemaVersion", "kind", "status", "qualifying", "releaseGatesCleared", "alias",
        "artifactLogicalName", "scenario", "stopKind", "candidatePid", "candidateCreationTime",
        "candidateExited", "exitCode", "forced", "jobActiveProcesses", "handleCleanupAttempted",
        "handlesClosed", "processTreeExitProven", "listenerGone", "elapsedMs", "failures", "failureDetails"];
    exactKeys(value, keys, "Candidate failed result");
    if (value.schemaVersion !== 1 || value.kind !== CANDIDATE_RESULT_KIND || value.status !== "failed"
        || value.qualifying !== false || value.alias !== request.alias || value.scenario !== request.scenario
        || value.artifactLogicalName !== request.artifactLogicalName || value.candidatePid !== ready.candidatePid
        || value.candidateCreationTime !== ready.candidateCreationTime
        || !Array.isArray(value.releaseGatesCleared) || value.releaseGatesCleared.length !== 0)
        throw new Error("Candidate failed result binding differs");
    for (const name of ["candidateExited", "forced", "handleCleanupAttempted", "handlesClosed",
        "processTreeExitProven", "listenerGone"]) strictBoolean(value[name], `Candidate failed result ${name}`);
    integer(value.elapsedMs, "Candidate failed result elapsed time", 0, CONTROLLER_TIMEOUT_MILLISECONDS);
    if (value.exitCode !== null) integer(value.exitCode, "Candidate failed result exit code", 0, 0xffff_ffff);
    if (value.jobActiveProcesses !== null)
        integer(value.jobActiveProcesses, "Candidate failed result active processes", 0, 0xffff_ffff);
    if (!Array.isArray(value.failures) || value.failures.length < 1 || value.failures.length > 4
        || !Array.isArray(value.failureDetails) || value.failureDetails.length !== value.failures.length)
        throw new Error("Candidate failed result diagnostics differ");
    return value.failureDetails.map(detail => {
        exactKeys(detail, ["phase", "failure"], "Candidate failed result detail");
        string(detail.phase, "Candidate failed result phase", /^(?:lifecycle|cleanup|handle-cleanup|proof)$/u);
        if (typeof detail.failure !== "string" || detail.failure.length < 1
            || detail.failure.length > MAXIMUM_FAILURE_MESSAGE_CHARACTERS)
            throw new Error("Candidate failed result failure must be bounded");
        return detail.failure;
    });
};

const bound = (request, alias, scenario = null) => ({
    expectedRunId: request.expectedRunId,
    expectedRunAttempt: request.expectedRunAttempt,
    expectedSourceSha: request.expectedSourceSha,
    expectedEventSha: request.expectedEventSha,
    nonce: request.nonce,
    alias,
    ...(scenario === null ? {} : {scenario})
});

const assertRuntime = runtime => {
    exactKeys(runtime, RUNTIME_NAMES, "Standalone runtime operations");
    for (const name of RUNTIME_NAMES)
        if (typeof runtime[name] !== "function") throw new Error(`Standalone runtime operation ${name} is absent`);
};

const runtimeRecord = (value, keys, label) => exactKeys(value, keys, label);

export const createWindowsNativeStandaloneOperations = (input, runtime) => {
    const request = assertWindowsNativeAdapterRequest(input);
    assertRuntime(runtime);
    const fixtureStates = new Map();
    const sessionStates = new Map();

    return {
        observeOffline: async ({alias, scenario, phase}) => {
            const observed = runtimeRecord(await runtime.observeOffline({alias, scenario, phase}),
                ["boundarySha256", "boundaryBase64", "offlineBoundaryPassed"], "Native offline observation");
            return {schemaVersion: 1, kind: BOUNDARY_KIND, qualifying: false,
                ...bound(request, alias, scenario), phase,
                boundarySha256: sha256(observed.boundarySha256, "Native boundary SHA"),
                boundaryBase64: observed.boundaryBase64,
                offlineBoundaryPassed: strictBoolean(observed.offlineBoundaryPassed, "Native offline result")};
        },
        prepareFixture: async ({alias, ownership}) => {
            const prepared = runtimeRecord(await runtime.prepareFixture({alias, ownership}),
                ["manifestSha256", "state"], "Native fixture preparation");
            if (!isObject(prepared.state)) throw new Error("Native fixture state is absent");
            fixtureStates.set(ownership.fixtureId, prepared.state);
            return {schemaVersion: 1, kind: FIXTURE_KIND, ...bound(request, alias), fixtureId: ownership.fixtureId,
                manifestSha256: sha256(prepared.manifestSha256, "Native fixture manifest SHA"), prepared: true};
        },
        openOwnedSession: async ({alias, scenario, candidateSha256, artifactLogicalName, fixture, ownership}) => {
            const opened = runtimeRecord(await runtime.openSession({alias, scenario, candidateSha256,
                artifactLogicalName, fixture, fixtureState: fixtureStates.get(fixture.fixtureId), ownership}),
            ["state"], "Native owned session open");
            if (!isObject(opened.state)) throw new Error("Native owned session state is absent");
            sessionStates.set(ownership.sessionId, opened.state);
            return {schemaVersion: 1, kind: SESSION_KIND, ...bound(request, alias, scenario),
                sessionId: ownership.sessionId, candidateSha256, artifactLogicalName, ownershipEstablished: true};
        },
        launchOwnedSession: async ({session, fixture}) => {
            const launched = runtimeRecord(await runtime.launchSession({state: sessionStates.get(session.sessionId),
                session, fixture, fixtureState: fixtureStates.get(fixture.fixtureId)}),
            ["candidatePid", "candidateCreationTime", "retainedHandleAuthority", "jobAssignedBeforeResume",
                "handleListConfigured"], "Native session launch");
            return {schemaVersion: 1, kind: READY_KIND, ...bound(request, session.alias, session.scenario),
                sessionId: session.sessionId, candidateSha256: session.candidateSha256,
                artifactLogicalName: session.artifactLogicalName, ...launched};
        },
        runExistingAssertions: async ({session, fixture, stage}) => {
            const asserted = runtimeRecord(await runtime.runAssertions({state: sessionStates.get(session.sessionId),
                session, fixture, fixtureState: fixtureStates.get(fixture.fixtureId), stage}),
            ["summary", "summarySha256"], "Existing assertion result");
            return {schemaVersion: 1, kind: ASSERTIONS_KIND, ...bound(request, session.alias, session.scenario),
                sessionId: session.sessionId, stage, status: "passed",
                summary: structuredClone(asserted.summary),
                summarySha256: sha256(asserted.summarySha256, "Existing assertion summary SHA")};
        },
        closeOwnedSession: async ({session, fixture, ownership}) => {
            const closed = runtimeRecord(await runtime.closeSession({state: sessionStates.get(ownership.sessionId),
                session, fixture, fixtureState: fixture?.fixtureId ? fixtureStates.get(fixture.fixtureId) : null,
                ownership}), ["status", "stopKind", "candidateStarted", "candidateExited", "exitCode",
                "processTreeExitProven", "jobActiveProcesses", "handlesClosed", "listenerGone", "forced"],
            "Native session close");
            return {schemaVersion: 1, kind: CLOSED_KIND, ...bound(request, ownership.alias, ownership.scenario),
                sessionId: ownership.sessionId, artifactLogicalName: ownership.artifactLogicalName, ...closed};
        },
        cleanupFixture: async ({fixture, ownership}) => {
            const cleaned = runtimeRecord(await runtime.cleanupFixture({state: fixtureStates.get(ownership.fixtureId),
                fixture, ownership}), ["cleanupProven"], "Native fixture cleanup");
            fixtureStates.delete(ownership.fixtureId);
            for (const [sessionId, state] of sessionStates)
                if (state?.alias === ownership.alias) sessionStates.delete(sessionId);
            return {schemaVersion: 1, kind: FIXTURE_CLEANUP_KIND, ...bound(request, ownership.alias),
                fixtureId: ownership.fixtureId,
                cleanupProven: strictBoolean(cleaned.cleanupProven, "Native fixture cleanup proof")};
        }
    };
};

const readWhenPublished = async (file, expectedSha256, label, deadline, clock = Date.now, signal) => {
    for (;;) {
        signal?.throwIfAborted();
        if (clock() >= deadline) throw new Error(`${label} publication timed out`);
        try { return readBoundJson(file, expectedSha256, label); }
        catch (error) {
            if (!["ENOENT", "EBUSY", "EPERM"].includes(error?.code)) throw error;
            await delay(POLL_MILLISECONDS, undefined, {signal});
        }
    }
};

const writeNewJson = (file, value) => {
    const bytes = jsonBytes(value);
    if (bytes.length < 2 || bytes.length > MAXIMUM_JSON_BYTES) throw new Error("Candidate stop bytes differ");
    const handle = fs.openSync(file, "wx", 0o600);
    try { fs.writeFileSync(handle, bytes); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    return hashBytes(bytes);
};

const waitChild = (child, timeoutMilliseconds) => new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve({exitCode: child.exitCode, signal: child.signalCode});
    const timer = setTimeout(() => {
        cleanup();
        const error = new Error("Candidate controller exceeded its deadline");
        error.code = CONTROLLER_TIMEOUT_CODE;
        reject(error);
    }, timeoutMilliseconds);
    const cleanup = () => {
        clearTimeout(timer);
        child.off("error", onError);
        child.off("exit", onExit);
    };
    const onError = error => { cleanup(); reject(error); };
    const onExit = (exitCode, signal) => { cleanup(); resolve({exitCode, signal}); };
    child.once("error", onError);
    child.once("exit", onExit);
});

const emptyControllerStderr = () => ({text: "", truncated: false, unavailable: false});

const collectChildStderr = (stream, maximumBytes = MAXIMUM_CONTROLLER_STDERR_BYTES) => {
    if (!stream || typeof stream.on !== "function" || stream.destroyed === true || stream.readableEnded === true) {
        const snapshot = emptyControllerStderr();
        return {completion: Promise.resolve(snapshot), finalize: () => snapshot};
    }
    let finalizeCapture;
    const completion = new Promise(resolve => {
        const chunks = [];
        let retainedBytes = 0;
        let truncated = false;
        let unavailable = false;
        let finished = false;
        let snapshot;
        let handlers = [];
        const lateErrorGuard = () => {};
        const cleanup = () => {
            for (const [event, handler] of handlers) stream.removeListener?.(event, handler);
            stream.once?.("error", lateErrorGuard);
        };
        const finish = (forced = false) => {
            if (finished) return snapshot;
            finished = true;
            if (forced) unavailable = true;
            cleanup();
            const bytes = Buffer.concat(chunks, retainedBytes);
            const text = new TextDecoder("utf-8").decode(bytes)
                .replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
            snapshot = {text: text.slice(0, MAXIMUM_FAILURE_MESSAGE_CHARACTERS),
                truncated: truncated || text.length > MAXIMUM_FAILURE_MESSAGE_CHARACTERS, unavailable};
            resolve(snapshot);
            return snapshot;
        };
        const onData = chunk => {
            let bytes;
            try {
                if (Buffer.isBuffer(chunk)) bytes = chunk;
                else if (typeof chunk === "string") bytes = Buffer.from(chunk, "utf8");
                else { unavailable = true; return; }
            } catch { unavailable = true; return; }
            const available = maximumBytes - retainedBytes;
            if (available > 0) {
                const retained = bytes.subarray(0, available);
                chunks.push(Buffer.from(retained));
                retainedBytes += retained.length;
            }
            if (bytes.length > Math.max(available, 0)) truncated = true;
        };
        const onError = () => { unavailable = true; finish(); };
        handlers = [["data", onData], ["end", finish], ["close", finish], ["error", onError]];
        stream.on("data", onData);
        stream.once?.("end", finish);
        stream.once?.("close", finish);
        stream.once?.("error", onError);
        finalizeCapture = () => finish(true);
    });
    return {completion, finalize: () => finalizeCapture()};
};

const drainControllerStderr = async (capture, timeoutMilliseconds) => {
    let timer;
    const maximumWait = Math.min(timeoutMilliseconds, CONTROLLER_STDERR_DRAIN_GRACE_MILLISECONDS);
    const deadline = new Promise(resolve => {
        timer = setTimeout(() => resolve(capture.finalize()), maximumWait);
    });
    try { return await Promise.race([capture.completion, deadline]); }
    finally { clearTimeout(timer); }
};

const controllerStderrDetail = stderr => {
    if (!stderr || typeof stderr !== "object") return "";
    const parts = [];
    if (typeof stderr.text === "string" && stderr.text.length > 0) parts.push(stderr.text);
    if (stderr.truncated === true) parts.push(CONTROLLER_STDERR_TRUNCATED_MARKER);
    if (stderr.unavailable === true) parts.push(CONTROLLER_STDERR_UNAVAILABLE_MARKER);
    return parts.length === 0 ? "" : `: controller stderr: ${parts.join(" ")}`;
};

const withControllerStderr = (error, stderr) => {
    const detail = controllerStderrDetail(stderr);
    if (!detail) return error;
    const enriched = new Error(`${error instanceof Error ? error.message : String(error)}${detail}`, {cause: error});
    enriched.controllerStderr = stderr;
    return enriched;
};

const invokeHostObserver = (proof, mode, input, timeoutMilliseconds = CONTROLLER_TIMEOUT_MILLISECONDS) => JSON.parse(execFileSync(proof.powershellPath,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", proof.hostPath,
        "-Mode", mode, "-InputJson", JSON.stringify(mode === "ObserveOffline"
            ? {...input, canaryPath: proof.canaryPath, canarySha256: proof.canarySha256} : input),
        "-ExpectedRunId", proof.adapterRequest.expectedRunId,
        "-ExpectedRunAttempt", proof.adapterRequest.expectedRunAttempt,
        "-ExpectedEventSha", proof.adapterRequest.expectedEventSha,
        "-ExpectedSourceSha", proof.adapterRequest.expectedSourceSha,
        "-ExpectedImageVersion", proof.adapterRequest.expectedImageVersion,
        "-Nonce", proof.adapterRequest.nonce],
    {encoding: "utf8", timeout: timeoutMilliseconds, windowsHide: true}));

const defaultRuntimeDependencies = proof => {
    const dependencies = {
        loadFixture: value => loadHandoffFixture(value),
        startController(requestRecord, timeoutMilliseconds = CONTROLLER_TIMEOUT_MILLISECONDS) {
            const adapter = proof.adapterRequest;
            const startedAt = this.monotonicClock();
            const child = this.spawnController(proof.powershellPath,
                ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
                    proof.candidateControllerPath, "-Mode", "InvokeHostedCandidate", "-RequestPath", requestRecord.path,
                    "-ExpectedRequestSha256", requestRecord.sha256, "-ExpectedRunId", adapter.expectedRunId,
                    "-ExpectedRunAttempt", adapter.expectedRunAttempt, "-ExpectedEventSha", adapter.expectedEventSha,
                    "-ExpectedSourceSha", adapter.expectedSourceSha, "-ExpectedImageVersion", adapter.expectedImageVersion,
                    "-Nonce", requestRecord.value.nonce],
                {cwd: requestRecord.value.workingDirectory, windowsHide: true, stdio: ["ignore", "ignore", "pipe"]});
            const stderr = collectChildStderr(child.stderr);
            const remainingTimeout = () => Math.max(timeoutMilliseconds - (this.monotonicClock() - startedAt), 0);
            const completion = waitChild(child, timeoutMilliseconds).then(async outcome =>
                ({...outcome, stderr: await drainControllerStderr(stderr, remainingTimeout())}), async error => {
                    if (error?.code === CONTROLLER_TIMEOUT_CODE) {
                        error.controllerStderr = stderr.finalize();
                        throw error;
                    }
                    throw withControllerStderr(error, await drainControllerStderr(stderr, remainingTimeout()));
                });
            return {child, completion};
        },
        spawnController: (executable, argumentsList, options) => spawn(executable, argumentsList, options),
        observeOffline: (value, timeout) => invokeHostObserver(proof, "ObserveOffline", value, timeout),
        observeListener: (value, timeout) => invokeHostObserver(proof, "ObserveListener", value, timeout),
        checkPopulated: origin => checkPopulatedInstance(origin),
        checkPopulatedDatabase: (file, expected) => checkPopulatedDatabase(file, expected),
        checkResetDatabase: file => checkResetDatabase(file),
        removeOwnedWork: (work, nonce) => removeOwnedWork(work, nonce),
        readControllerRequest: definition => readBoundJson(definition.path, definition.sha256,
            "Candidate controller request").value,
        readFixtureManifestBytes: definition => fs.readFileSync(definition.manifestPath),
        readReady: async (request, deadline, clock, signal) => (await readWhenPublished(request.readyPath, "", "Candidate ready",
            deadline, clock, signal)).value,
        readReadyNow: request => readBoundJson(request.readyPath, "", "Candidate ready").value,
        readResult: async (request, deadline, clock) => (await readWhenPublished(request.resultPath, "", "Candidate result",
            deadline, clock)).value,
        writeStop: (request, value) => writeNewJson(request.stopRequestPath, value),
        clock: Date.now,
        monotonicClock: () => performance.now()
    };
    return dependencies;
};

export const createWindowsNativeStandaloneRuntimeDependencies = input =>
    defaultRuntimeDependencies(assertWindowsNativeStandaloneProofRequest(input));

export const createWindowsNativeStandaloneRuntime = (input, overrides = {}) => {
    const proof = assertWindowsNativeStandaloneProofRequest(input);
    const dependencies = {...defaultRuntimeDependencies(proof), ...overrides};
    const fixtures = new Map(proof.fixtures.map(value => [value.alias, value]));
    const candidates = new Map(proof.candidates.map(value => [value.alias, value]));
    const sessions = new Map();
    let outerJobCleanupRequired = false;
    // The host's 600-second watch starts before this coordinator. Reserve a
    // fixed setup/cleanup margin and bound only waits this process owns; the
    // outer Job remains the backstop for synchronous OS calls that cannot be
    // preempted by JavaScript.
    const coordinatorDeadline = dependencies.clock() + COORDINATOR_WAIT_BUDGET_MILLISECONDS;
    const remaining = (label, maximum = CONTROLLER_TIMEOUT_MILLISECONDS) => {
        const value = coordinatorDeadline - dependencies.clock();
        if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Standalone coordinator deadline expired before ${label}`);
        return Math.min(value, maximum);
    };
    const runtime = {
        observeOffline: async ({alias, scenario, phase}) => {
            if (outerJobCleanupRequired) throw new Error("Outer Job cleanup is required before offline proof");
            const result = await dependencies.observeOffline({schemaVersion: 1, alias, scenario, phase},
                remaining("offline observation"));
            exactKeys(result, ["boundarySha256", "boundaryBase64", "offlineBoundaryPassed"], "Hosted offline observation");
            return result;
        },
        prepareFixture: async ({alias, ownership}) => {
            const definition = fixtures.get(alias);
            const state = await dependencies.loadFixture({file: definition.manifestPath,
                work: definition.populatedWork, resetWork: definition.resetWork, requireReadOnly: true});
            if (!isObject(state) || state.populated?.root !== definition.populatedWork
                || state.reset?.root !== definition.resetWork) throw new Error("Loaded fixture binding differs");
            state.alias = alias;
            if (hashBytes(dependencies.readFixtureManifestBytes(definition)) !== definition.manifestSha256)
                throw new Error("Standalone fixture manifest SHA differs");
            return {manifestSha256: definition.manifestSha256, state};
        },
        openSession: async ({alias, scenario, artifactLogicalName, ownership, fixtureState}) => {
            const candidate = candidates.get(alias);
            const definition = candidate.controllerRequests.find(value => value.scenario === scenario);
            const controller = dependencies.readControllerRequest(definition);
            assertControllerRequestBinding(controller, proof, candidate, scenario, definition);
            const state = {alias, scenario, ownership, fixtureState, candidate, definition,
                request: controller, launched: null, ready: null};
            sessions.set(ownership.sessionId, state);
            return {state};
        },
        launchSession: async ({state}) => {
            state.launched = dependencies.startController({path: state.definition.path,
                sha256: state.definition.sha256, value: state.request,
                controllerExecutablePath: proof.candidateControllerPath,
                controllerExecutableSha256: proof.candidateControllerSha256}, remaining("controller launch"));
            const completion = Promise.resolve(state.launched.completion);
            // Attach rejection handling at creation; readiness may remain pending.
            completion.catch(() => {});
            const readyAbort = new AbortController();
            try {
                const readyOutcome = dependencies.readReady(state.request, coordinatorDeadline, dependencies.clock,
                    readyAbort.signal)
                    .then(value => ({ready: true, value}), error => ({ready: false, error}));
                const completionOutcome = completion.then(
                    value => ({completed: true, value}), error => ({completed: false, error}));
                state.launched.completionOutcome = completionOutcome;
                const first = await Promise.race([readyOutcome, completionOutcome]);
                if (first.completed === true) {
                    try { state.ready = assertCandidateReady(dependencies.readReadyNow(state.request), state.request); }
                    catch {
                        throw withControllerStderr(new Error("Candidate controller exited before ready publication"),
                            first.value.stderr);
                    }
                } else if (!first.ready) throw first.error;
                if (!state.ready) state.ready = assertCandidateReady(first.value, state.request);
            } catch (error) {
                outerJobCleanupRequired = true;
                try { state.launched.child?.kill(); } catch {}
                throw error;
            } finally { readyAbort.abort(); }
            return {candidatePid: state.ready.candidatePid, candidateCreationTime: state.ready.candidateCreationTime,
                retainedHandleAuthority: state.ready.retainedHandleAuthority,
                jobAssignedBeforeResume: state.ready.jobAssignedBeforeResume,
                handleListConfigured: state.ready.handleListConfigured};
        },
        runAssertions: async ({state, stage}) => {
            let summary;
            if (stage === "running") {
                const port = Number(state.request.environment.SERVER_PORT);
                const listener = await dependencies.observeListener({schemaVersion: 1, mode: "owned",
                    address: "127.0.0.1", port, candidatePid: state.ready.candidatePid,
                    candidateCreationTime: state.ready.candidateCreationTime}, remaining("owned listener observation"));
                if (listener?.listenerOwned !== true) {
                    exactKeys(listener, ["listenerOwned", "diagnostic"], "Owned listener observation");
                    strictBoolean(listener.listenerOwned, "Owned listener proof");
                    throw new Error("Owned candidate listener was not proven ["
                        + `${listenerDiagnosticSummary(listener.diagnostic,
                            state.ready.candidateCreationTime, "Owned candidate listener diagnostic")}]`);
                }
                exactKeys(listener, ["listenerOwned"], "Owned listener observation");
                summary = await dependencies.checkPopulated(`http://127.0.0.1:${port}`);
            } else if (state.scenario === "fresh-no-config-reset") {
                summary = await dependencies.checkResetDatabase(path.join(state.request.workingDirectory,
                    "data", "storage.db"));
            } else {
                summary = await dependencies.checkPopulatedDatabase(path.join(state.request.workingDirectory,
                    "data", "storage.db"), state.fixtureState.expected);
            }
            return {summary: structuredClone(summary), summarySha256: hashJson(summary)};
        },
        closeSession: async ({state, ownership}) => {
            if (state?.launched && !state.ready) {
                outerJobCleanupRequired = true;
                throw new Error("Outer Job cleanup is required for a launched session without ready proof");
            }
            if (!state?.launched)
                return {status: "completed", stopKind: "cleanup", candidateStarted: false,
                    candidateExited: false, exitCode: null, processTreeExitProven: true, jobActiveProcesses: 0,
                    handlesClosed: true, listenerGone: true, forced: false};
            try {
                if (state.scenario !== "fresh-no-config-reset") dependencies.writeStop(state.request,
                    {schemaVersion: 1, kind: CANDIDATE_STOP_KIND, nonce: state.request.nonce,
                        manifestSha256: state.request.manifestSha256, alias: state.alias, scenario: state.scenario,
                        candidatePid: state.ready.candidatePid, candidateCreationTime: state.ready.candidateCreationTime});
                const completion = await state.launched.completionOutcome;
                if (!completion.completed) throw completion.error;
                const completed = completion.value;
                if (completed.signal !== null || completed.exitCode !== 0) {
                    let detail = "";
                    try {
                        const failed = await dependencies.readResult(state.request,
                            dependencies.clock() + remaining("candidate failure diagnostic",
                                DIAGNOSTIC_READ_BUDGET_MILLISECONDS), dependencies.clock);
                        const messages = candidateFailureDiagnostic(failed, state.request, state.ready);
                        detail = `: ${messages.join("; ").slice(0, MAXIMUM_FAILURE_MESSAGE_CHARACTERS)}`;
                    } catch {}
                    throw new Error(`Candidate controller process failed${detail}`
                        + controllerStderrDetail(completed.stderr));
                }
                const result = assertCandidateResult(await dependencies.readResult(state.request,
                    coordinatorDeadline, dependencies.clock),
                state.request, state.ready);
                const listener = await dependencies.observeListener({schemaVersion: 1, mode: "absent",
                    address: "127.0.0.1", port: Number(state.request.environment.SERVER_PORT),
                    candidatePid: state.ready.candidatePid, candidateCreationTime: state.ready.candidateCreationTime},
                remaining("absent listener observation"));
                exactKeys(listener, ["listenerGone"], "Absent listener observation");
                const closed = {status: result.status, stopKind: result.stopKind, candidateStarted: true,
                    candidateExited: result.candidateExited, exitCode: result.exitCode,
                    processTreeExitProven: result.processTreeExitProven,
                    jobActiveProcesses: result.jobActiveProcesses, handlesClosed: result.handlesClosed,
                    listenerGone: listener.listenerGone === true, forced: result.forced};
                state.closed = true;
                return closed;
            } catch (error) { outerJobCleanupRequired = true; throw error; }
        },
        cleanupFixture: async ({state, ownership}) => {
            if (outerJobCleanupRequired) throw new Error("Outer Job cleanup is required before fixture deletion");
            if (state) {
                dependencies.removeOwnedWork(state.populated.root, state.populated.nonce);
                dependencies.removeOwnedWork(state.reset.root, state.reset.nonce);
            }
            for (const [sessionId, session] of sessions)
                if (session.alias === ownership.alias) sessions.delete(sessionId);
            return {cleanupProven: isObject(state)};
        }
    };
    return runtime;
};

export const runWindowsNativeStandaloneProof = async (input, runtime) => {
    const proof = assertWindowsNativeStandaloneProofRequest(input);
    const {runWindowsNativeStandaloneAdapter} = await import("./windows-native-standalone-adapter.mjs");
    const adapter = await runWindowsNativeStandaloneAdapter(proof.adapterRequest,
        createWindowsNativeStandaloneOperations(proof.adapterRequest, runtime));
    const result = {schemaVersion: 1, kind: PROOF_RESULT_KIND, status: adapter.status, qualifying: false,
        manifestSha256: proof.manifestSha256, sourceSha: proof.adapterRequest.expectedSourceSha,
        eventSha: proof.adapterRequest.expectedEventSha, runId: proof.adapterRequest.expectedRunId,
        runAttempt: proof.adapterRequest.expectedRunAttempt, imageVersion: proof.adapterRequest.expectedImageVersion,
        nonce: proof.adapterRequest.nonce, qualificationSourceSha: proof.qualificationSourceSha,
        qualificationRunId: proof.qualificationRunId, qualificationRunAttempt: proof.qualificationRunAttempt,
        qualificationManifestArtifactId: proof.qualificationManifestArtifactId,
        qualificationManifestArtifactDigest: proof.qualificationManifestArtifactDigest,
        candidates: proof.candidates.map(candidate => ({alias: candidate.alias,
            artifactLogicalName: candidate.artifactLogicalName, artifactId: candidate.artifactId,
            artifactDigest: candidate.artifactDigest, candidateSha256: candidate.sha256})),
        adapter, releaseGatesCleared: []};
    if (result.status === "completed") {
        try { assertWindowsNativeStandaloneProofResult(result, proof); }
        catch (error) {
            const message = String(error?.message ?? error).replace(/[\x00-\x1f\x7f]+/gu, " ")
                .slice(0, MAXIMUM_FAILURE_MESSAGE_CHARACTERS);
            const failed = {...result, status: "failed",
                failureDetails: [{phase: "self-validation", failure: message}]};
            exactKeys(failed, ["schemaVersion", "kind", "status", "qualifying", "manifestSha256", "sourceSha",
                "eventSha", "runId", "runAttempt", "imageVersion", "nonce", "qualificationSourceSha",
                "qualificationRunId", "qualificationRunAttempt", "qualificationManifestArtifactId",
                "qualificationManifestArtifactDigest", "candidates", "adapter", "releaseGatesCleared",
                "failureDetails"], "Failed standalone proof result");
            if (failed.status !== "failed" || failed.qualifying !== false || message.length < 1
                || !Array.isArray(failed.releaseGatesCleared) || failed.releaseGatesCleared.length !== 0)
                throw new Error("Failed standalone proof result differs");
            return failed;
        }
    }
    return result;
};

const assertHostedEnvironment = proof => {
    const adapter = proof.adapterRequest;
    const expected = {GITHUB_ACTIONS: "true", CI: "true", GITHUB_REPOSITORY: "i7Gamer/MySpeed",
        RUNNER_OS: "Windows", RUNNER_ARCH: "X64", RUNNER_ENVIRONMENT: "github-hosted",
        ImageOS: "win25-vs2026", ImageVersion: adapter.expectedImageVersion,
        GITHUB_RUN_ID: adapter.expectedRunId, GITHUB_RUN_ATTEMPT: adapter.expectedRunAttempt,
        GITHUB_SHA: adapter.expectedEventSha};
    if (process.platform !== "win32") throw new Error("Standalone proof requires Windows");
    for (const [name, value] of Object.entries(expected))
        if (process.env[name] !== value) throw new Error(`Standalone hosted context ${name} differs`);
};

const main = async () => {
    if (process.argv.length !== 6 || process.argv[2] !== "--request" || process.argv[4] !== "--sha256")
        throw new Error("Standalone proof arguments differ");
    const requestPath = windowsPath(process.argv[3], "Standalone proof request path");
    const expectedSha256 = sha256(process.argv[5], "Standalone proof request SHA");
    const proof = assertWindowsNativeStandaloneProofRequest(readBoundJson(requestPath, expectedSha256,
        "Standalone proof request").value);
    assertHostedEnvironment(proof);
    const result = await runWindowsNativeStandaloneProof(proof, createWindowsNativeStandaloneRuntime(proof));
    writeNewJson(proof.resultPath, result);
    if (result.status !== "completed") process.exitCode = 1;
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
    main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
