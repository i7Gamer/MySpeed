import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {describe, it} from "node:test";

import {assertWindowsNativeStandaloneCombinedResult, assertWindowsNativeStandaloneProofRequest,
    assertWindowsNativeStandaloneProofResult, createWindowsNativeStandaloneOperations,
    createWindowsNativeStandaloneRuntime, inspectWindowsNativeStandaloneEvidence,
    runWindowsNativeStandaloneProof} from "../../scripts/qualification/windows-native-standalone-proof.mjs";
import {WINDOWS_NATIVE_ALIASES, WINDOWS_NATIVE_SCENARIOS,
    runWindowsNativeStandaloneAdapter} from "../../scripts/qualification/windows-native-standalone-adapter.mjs";
import {createWindowsNativeStandaloneEvidenceFixture} from
    "../helpers/windows-native-standalone-evidence-fixture.mjs";

const SOURCE_SHA = "a".repeat(40);
const EVENT_SHA = "b".repeat(40);
const NONCE = "c".repeat(32);
const HASH = "d".repeat(64);
const FIXTURE_BYTES = Buffer.from("sealed fixture", "utf8");
const FIXTURE_SHA = createHash("sha256").update(FIXTURE_BYTES).digest("hex");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const retainJson = value => { const bytes = Buffer.from(JSON.stringify(value), "utf8");
    return {sha256: sha(bytes), base64: bytes.toString("base64")}; };
const candidateNonce = (alias, scenario) => createHash("sha256").update(`${alias}\0${scenario}`)
    .digest("hex").slice(0, 32);
const windowsIt = process.platform === "win32" ? it : it.skip;
const OFFLINE_TARGETS = [
    {interfaceGuid: "{11111111-1111-1111-1111-111111111111}", netLuid: "0000000000000001"},
    {interfaceGuid: "{22222222-2222-2222-2222-222222222222}", netLuid: "0000000000000002"}
];
const OFFLINE_EVIDENCE = {schemaVersion: 1,
    providers: {adapters: true, ipInterfaces: true, ipAddresses: true, routes: true},
    adapters: OFFLINE_TARGETS.map((target, index) => ({...target, hidden: false, interfaceType: 6,
        interfaceAdminStatus: 2, status: "Disabled", interfaceIndex: index + 4, loopback: false, enabled: false})),
    ipState: ["address", "interface", "route"].map(kind => ({kind, compartmentId: 1, loopback: false,
        routable: false}))};
const OFFLINE_BYTES = Buffer.from(JSON.stringify(OFFLINE_EVIDENCE), "utf8");
const OFFLINE_SHA = sha(OFFLINE_BYTES);
const OFFLINE_BASE64 = OFFLINE_BYTES.toString("base64");

const request = () => ({
    schemaVersion: 1,
    kind: "myspeed-windows-native-standalone-adapter-request",
    qualifying: false,
    expectedRunId: "12345",
    expectedRunAttempt: "2",
    expectedSourceSha: SOURCE_SHA,
    expectedEventSha: EVENT_SHA,
    expectedImageVersion: "20260913.1",
    nonce: NONCE,
    aliases: WINDOWS_NATIVE_ALIASES.map((alias, index) => ({alias,
        candidateSha256: String(index + 1).repeat(64),
        artifactLogicalName: alias === "default" ? "MySpeed-windows-x64.exe"
            : "MySpeed-windows-x64-baseline.exe"}))
});
const proofRequest = () => ({
    schemaVersion: 1,
    kind: "myspeed-windows-native-standalone-proof-request",
    qualifying: false,
    adapterRequest: request(),
    manifestSha256: "e".repeat(64),
    qualificationManifestArtifactId: "8001",
    qualificationManifestArtifactDigest: `sha256:${"f".repeat(64)}`,
    qualificationSourceSha: SOURCE_SHA,
    qualificationRunId: "98765",
    qualificationRunAttempt: "3",
    taskRoot: `C:\\runner\\myspeed-native-standalone-${NONCE}`,
    resultPath: `C:\\runner\\myspeed-native-standalone-${NONCE}\\proof.result.json`,
    fixtures: WINDOWS_NATIVE_ALIASES.map(alias => ({alias,
        manifestPath: `C:\\runner\\myspeed-native-standalone-${NONCE}\\fixture-${alias}.json`,
        manifestSha256: FIXTURE_SHA,
        populatedWork: `C:\\runner\\myspeed-native-standalone-${NONCE}\\fixture-${alias}-populated`,
        resetWork: `C:\\runner\\myspeed-native-standalone-${NONCE}\\fixture-${alias}-reset`})),
    candidateControllerPath: "C:\\runner\\closure\\windows-native-candidate-controller.ps1",
    candidateControllerSha256: "f".repeat(64),
    cleanStopControllerPath: "C:\\runner\\closure\\windows-clean-stop-controller.ps1",
    cleanStopControllerSha256: "7".repeat(64),
    hostPath: "C:\\runner\\closure\\windows-native-standalone-host.ps1",
    hostSha256: "9".repeat(64),
    canaryPath: "C:\\runner\\closure\\windows-winsw-offline-canary.ps1",
    canarySha256: "6".repeat(64),
    powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    powershellSha256: "8".repeat(64),
    normalDeadlineMs: 600_000,
    hardDeadlineMs: 610_000,
    candidates: WINDOWS_NATIVE_ALIASES.map((alias, index) => ({alias,
        artifactLogicalName: alias === "default" ? "MySpeed-windows-x64.exe"
            : "MySpeed-windows-x64-baseline.exe",
        artifactId: String(7000 + index), artifactDigest: `sha256:${String(index + 7).repeat(64)}`,
        path: `C:\\runner\\closure\\candidate-${alias}.exe`, sha256: String(index + 1).repeat(64),
        volumeSerial: String(index + 3).repeat(8), fileId: String(index + 5).repeat(16),
        controllerRequests: WINDOWS_NATIVE_SCENARIOS.map(scenario => {
            const taskRoot = `C:\\runner\\myspeed-native-candidate-${candidateNonce(alias, scenario)}`;
            return {scenario, path: `${taskRoot}\\candidate.request.json`, sha256: String(index + 6).repeat(64),
                taskRoot, candidatePath: `${taskRoot}\\MySpeed.exe`,
                controllerPath: `${taskRoot}\\windows-clean-stop-controller.ps1`};
        })}))
});

const makeRuntime = () => {
    const events = [];
    const fixtures = new Map();
    const sessions = new Map();
    let pid = 5000;
    const runtime = {
        observeOffline: async value => {
            events.push(`offline:${value.alias}:${value.phase}:${value.scenario ?? "none"}`);
            return {boundarySha256: OFFLINE_SHA, boundaryBase64: OFFLINE_BASE64, offlineBoundaryPassed: true};
        },
        prepareFixture: async value => {
            events.push(`prepare:${value.alias}`);
            const state = {alias: value.alias, populatedWork: `C:\\owned\\${value.alias}\\populated`,
                resetWork: `C:\\owned\\${value.alias}\\reset`, expected: {resultId: "synthetic"}};
            fixtures.set(value.ownership.fixtureId, state);
            return {manifestSha256: FIXTURE_SHA, state};
        },
        openSession: async value => {
            events.push(`open:${value.alias}:${value.scenario}`);
            const state = {id: value.ownership.sessionId, alias: value.alias, scenario: value.scenario};
            sessions.set(state.id, state);
            return {state};
        },
        launchSession: async ({state}) => {
            events.push(`launch:${state.alias}:${state.scenario}`);
            pid += 1;
            return {candidatePid: pid, candidateCreationTime: pid.toString(16).padStart(16, "0"),
                retainedHandleAuthority: true, jobAssignedBeforeResume: true, handleListConfigured: true};
        },
        runAssertions: async ({state, stage}) => {
            events.push(`assert:${state.alias}:${state.scenario}:${stage}`);
            const summary = stage === "running" ? {elapsedMs: 1}
                : state.scenario === "fresh-no-config-reset" ? {integrity: "ok", configTable: false}
                    : {ping: "synthetic", resultId: "synthetic", passwordValueSha256: HASH};
            return {summary, summarySha256: sha(Buffer.from(JSON.stringify(summary), "utf8"))};
        },
        closeSession: async ({state, ownership}) => {
            const observed = state ?? ownership;
            events.push(`close:${observed.alias}:${observed.scenario}`);
            const reset = observed.scenario === "fresh-no-config-reset";
            return {status: "completed", stopKind: reset ? "observed-exit" : "ctrl-c", candidateStarted: true,
                candidateExited: true, exitCode: reset ? 113 : 0, processTreeExitProven: true,
                jobActiveProcesses: 0, handlesClosed: true, listenerGone: true, forced: false};
        },
        cleanupFixture: async ({state, ownership}) => {
            events.push(`cleanup:${state?.alias ?? ownership.alias}`);
            return {cleanupProven: true};
        }
    };
    return {events, fixtures, sessions, runtime};
};

const controllerRequest = (proof, definition) => {
    const candidate = proof.candidates.find(value => value.controllerRequests.includes(definition));
    const fixture = proof.fixtures.find(value => value.alias === candidate.alias);
    const nonce = candidateNonce(candidate.alias, definition.scenario);
    const root = definition.taskRoot;
    return {schemaVersion: 1, kind: "myspeed-windows-native-candidate-request",
        expectedRunId: proof.adapterRequest.expectedRunId, expectedRunAttempt: proof.adapterRequest.expectedRunAttempt,
        expectedEventSha: proof.adapterRequest.expectedEventSha, expectedSourceSha: proof.adapterRequest.expectedSourceSha,
        expectedImageVersion: proof.adapterRequest.expectedImageVersion, nonce, manifestSha256: proof.manifestSha256,
        alias: candidate.alias, artifactLogicalName: candidate.artifactLogicalName, scenario: definition.scenario,
        taskRoot: root, candidatePath: definition.candidatePath, candidateSha256: candidate.sha256,
        candidateVolumeSerial: candidate.volumeSerial, candidateFileId: candidate.fileId,
        workingDirectory: definition.scenario === "fresh-no-config-reset" ? fixture.resetWork : fixture.populatedWork,
        arguments: definition.scenario === "fresh-no-config-reset" ? ["--reset-password"] : [],
        environment: {NODE_ENV: "production", DB_TYPE: "sqlite", SERVER_HOST: "127.0.0.1",
            SERVER_PORT: definition.scenario === "populated-first-boot" ? "65001"
                : definition.scenario === "populated-restart" ? "65002" : "65003", RUN_TEST_ON_STARTUP: "false"},
        stdoutPath: `${root}\\stdout.log`, stderrPath: `${root}\\stderr.log`, readyPath: `${root}\\ready.json`,
        stopRequestPath: `${root}\\stop.json`, resultPath: `${root}\\result.json`,
        controllerPath: definition.controllerPath,
        controllerSha256: proof.cleanStopControllerSha256,
        normalDeadlineMs: 300000, hardDeadlineMs: 310000, stopRequestTimeoutMs: 240000,
        stopRequestPollMs: 50, gracefulExitTimeoutMs: 30000, forcedCleanupTimeoutMs: 10000};
};

const makeActualRuntimeDependencies = proof => {
    const events = [];
    const requests = new Map();
    for (const candidate of proof.candidates)
        for (const definition of candidate.controllerRequests) requests.set(definition.path, controllerRequest(proof, definition));
    return {events, dependencies: {
        loadFixture: async ({work, resetWork}) => ({populated: {root: work, nonce: NONCE},
            reset: {root: resetWork, nonce: NONCE}, expected: {resultId: "synthetic"}}),
        readFixtureManifestBytes: () => FIXTURE_BYTES,
        readControllerRequest: definition => requests.get(definition.path),
        startController: record => { events.push(`start:${record.controllerExecutablePath}:${record.value.controllerPath}`);
            return {completion: Promise.resolve({exitCode: 0, signal: null})}; },
        readReady: async value => ({schemaVersion: 1, kind: "myspeed-windows-native-candidate-ready",
            nonce: value.nonce, manifestSha256: value.manifestSha256, alias: value.alias, scenario: value.scenario,
            artifactLogicalName: value.artifactLogicalName, candidateSha256: value.candidateSha256,
            candidatePid: 9001, candidateCreationTime: "1".repeat(16), retainedHandleAuthority: true,
            jobAssignedBeforeResume: true, handleListConfigured: true}),
        readResult: async value => ({schemaVersion: 1, kind: "myspeed-windows-native-candidate-result",
            status: "completed", qualifying: false, releaseGatesCleared: [], alias: value.alias,
            artifactLogicalName: value.artifactLogicalName, scenario: value.scenario,
            stopKind: value.scenario === "fresh-no-config-reset" ? "observed-exit" : "ctrl-c",
            candidatePid: 9001, candidateCreationTime: "1".repeat(16), candidateExited: true,
            exitCode: value.scenario === "fresh-no-config-reset" ? 113 : 0, forced: false,
            jobActiveProcesses: 0, handleCleanupAttempted: true, handlesClosed: true,
            processTreeExitProven: true, listenerGone: false, elapsedMs: 100, failures: []}),
        writeStop: value => { events.push(`stop:${value.alias}:${value.scenario}`); },
        observeOffline: async value => { events.push(`offline:${value.alias}:${value.phase}`);
            return {boundarySha256: OFFLINE_SHA, boundaryBase64: OFFLINE_BASE64, offlineBoundaryPassed: true}; },
        observeListener: async value => value.mode === "owned" ? {listenerOwned: true} : {listenerGone: true},
        checkPopulated: async origin => { events.push(`http:${origin}`); return {elapsedMs: 1}; },
        checkPopulatedDatabase: async () => ({ping: "synthetic", resultId: "synthetic", passwordValueSha256: HASH}),
        checkResetDatabase: async () => ({integrity: "ok", configTable: false}),
        removeOwnedWork: work => { events.push(`remove:${work}`); },
        clock: () => 1000
    }};
};

describe("Windows native standalone proof operation factory", () => {
    it("builds reusable fully bound raw evidence for final-seal tests", async () => {
        const sourceSha = "1".repeat(40);
        const eventSha = "2".repeat(40);
        const manifestSha256 = "3".repeat(64);
        const candidates = WINDOWS_NATIVE_ALIASES.map((alias, index) => ({alias,
            artifactLogicalName: alias === "default" ? "MySpeed-windows-x64.exe"
                : "MySpeed-windows-x64-baseline.exe",
            artifactId: String(9100 + index), artifactDigest: `sha256:${String(index + 4).repeat(64)}`,
            sha256: String(index + 6).repeat(64)}));
        const fixture = await createWindowsNativeStandaloneEvidenceFixture({sourceSha, eventSha,
            runId: "24680", runAttempt: "4", qualificationSourceSha: sourceSha,
            qualificationRunId: "13579", qualificationRunAttempt: "5", manifestSha256, candidates});
        for (const name of ["hostRequestBytes", "proofRequestBytes", "hostResultBytes"])
            assert.ok(Buffer.isBuffer(fixture[name]) && fixture[name].length > 1, `${name} must contain raw evidence`);
        const inspection = inspectWindowsNativeStandaloneEvidence(fixture);
        assert.equal(inspection.sourceSha, sourceSha);
        assert.equal(inspection.eventSha, eventSha);
        assert.equal(inspection.runId, "24680");
        assert.equal(inspection.runAttempt, "4");
        assert.equal(inspection.qualificationRunId, "13579");
        assert.equal(inspection.manifestSha256, manifestSha256);
        assert.deepEqual(inspection.candidates, candidates.map(candidate => ({alias: candidate.alias,
            artifactLogicalName: candidate.artifactLogicalName, artifactId: candidate.artifactId,
            artifactDigest: candidate.artifactDigest, candidateSha256: candidate.sha256})));
    });

    it("strictly binds the exact two candidates, closure paths, and reviewed host deadlines", () => {
        assert.doesNotThrow(() => assertWindowsNativeStandaloneProofRequest(proofRequest()));
        for (const mutate of [
            value => { value.qualifying = true; },
            value => { value.normalDeadlineMs -= 1; },
            value => { value.qualificationSourceSha = "0".repeat(40); },
            value => { value.manifestSha256 += "\n"; },
            value => { value.qualificationRunId = "0"; },
            value => { value.candidates.reverse(); },
            value => { value.candidates[0].sha256 = "0".repeat(64); },
            value => { value.candidates[0].artifactId = "0"; },
            value => { value.candidates[0].artifactDigest = `sha256:${"0".repeat(63)}`; },
            value => { value.candidates[0].artifactLogicalName = value.candidates[1].artifactLogicalName; },
            value => { value.fixtures[0].resetWork = value.fixtures[0].populatedWork; },
            value => { value.candidates[0].controllerRequests.reverse(); },
            value => { value.extra = true; }
        ]) {
            const value = structuredClone(proofRequest());
            mutate(value);
            assert.throws(() => assertWindowsNativeStandaloneProofRequest(value));
        }
    });

    it("keeps the candidate controller executable distinct from its clean-stop native dependency", async () => {
        const input = proofRequest();
        const harness = makeActualRuntimeDependencies(input);
        await runWindowsNativeStandaloneProof(input, createWindowsNativeStandaloneRuntime(input, harness.dependencies));
        assert.ok(harness.events.some(event => event ===
            `start:${input.candidateControllerPath}:C:\\runner\\myspeed-native-candidate-${
                createHash("sha256").update(`default\0populated-first-boot`).digest("hex").slice(0, 32)
            }\\windows-clean-stop-controller.ps1`));
        assert.notEqual(input.candidateControllerSha256, input.cleanStopControllerSha256);
        const drifted = proofRequest();
        drifted.candidates[0].controllerRequests[0].candidatePath += ".stale";
        const driftHarness = makeActualRuntimeDependencies(drifted);
        assert.throws(() => createWindowsNativeStandaloneRuntime(drifted, driftHarness.dependencies),
            /owned path differs/u);

        const pathDrift = proofRequest();
        const pathHarness = makeActualRuntimeDependencies(pathDrift);
        const readPathRequest = pathHarness.dependencies.readControllerRequest;
        pathHarness.dependencies.readControllerRequest = definition => ({...readPathRequest(definition),
            candidatePath: `${definition.candidatePath}.stale`});
        const pathResult = await runWindowsNativeStandaloneProof(pathDrift,
            createWindowsNativeStandaloneRuntime(pathDrift, pathHarness.dependencies));
        assert.equal(pathResult.status, "failed");
        assert.deepEqual(pathResult.adapter.failures[0],
            {stage: "open-owned-session", classification: "failed"});

        const manifestDrift = proofRequest();
        const manifestHarness = makeActualRuntimeDependencies(manifestDrift);
        const readControllerRequest = manifestHarness.dependencies.readControllerRequest;
        manifestHarness.dependencies.readControllerRequest = definition => ({...readControllerRequest(definition),
            manifestSha256: "0".repeat(64)});
        const manifestResult = await runWindowsNativeStandaloneProof(manifestDrift,
            createWindowsNativeStandaloneRuntime(manifestDrift, manifestHarness.dependencies));
        assert.equal(manifestResult.status, "failed");
        assert.deepEqual(manifestResult.adapter.failures[0],
            {stage: "open-owned-session", classification: "failed"});
    });

    it("runs the proof through the accepted adapter and never upgrades its nonqualifying result", async () => {
        const input = proofRequest();
        const harness = makeRuntime();
        const result = await runWindowsNativeStandaloneProof(input, harness.runtime);
        assert.equal(result.status, "completed", JSON.stringify(result));
        assert.equal(result.qualifying, false);
        assert.deepEqual(result.releaseGatesCleared, []);
        assert.equal(result.manifestSha256, input.manifestSha256);
        assert.equal(result.qualificationRunId, input.qualificationRunId);
        assert.equal(result.adapter.kind, "myspeed-windows-native-standalone-adapter-result");
        assert.equal(result.adapter.aliases[0].scenarios[0].ready.kind,
            "myspeed-windows-native-session-ready");
        assert.equal(result.adapter.aliases[0].scenarios[0].closed.processTreeExitProven, true);
        assert.doesNotThrow(() => assertWindowsNativeStandaloneProofResult(result, input));
        for (const mutate of [
            value => { value.qualificationRunAttempt = "4"; },
            value => { value.candidates[0].artifactDigest = `sha256:${"0".repeat(64)}`; },
            value => { value.adapter.aliases[0].scenarios[0].closed.jobActiveProcesses = 1; },
            value => { value.adapter.aliases[0].scenarios[0].afterStopBoundary.offlineBoundaryPassed = false; },
            value => { value.adapter.aliases[0].scenarios[0].assertions[0].summarySha256 = "0".repeat(64); },
            value => { value.adapter.aliases[0].fixture.manifestSha256 = "0".repeat(64); },
            value => { value.adapter.aliases[0].fixtureCleanup.cleanupProven = false; },
            value => { value.adapter.aliases.reverse(); }
        ]) {
            const changedResult = structuredClone(result);
            const changedRequest = structuredClone(input);
            if (String(mutate).includes("candidates")) mutate(changedRequest); else mutate(changedResult);
            assert.throws(() => assertWindowsNativeStandaloneProofResult(changedResult, changedRequest));
        }
    });

    it("recomputes the full coordinator proof and exact outer Job and normal recovery evidence", async () => {
        const rawFixture = await createWindowsNativeStandaloneEvidenceFixture();
        const input = JSON.parse(rawFixture.proofRequestBytes.toString("utf8"));
        const hostRequest = JSON.parse(rawFixture.hostRequestBytes.toString("utf8"));
        const combined = JSON.parse(rawFixture.hostResultBytes.toString("utf8"));
        const proofRequestSha256 = sha(rawFixture.proofRequestBytes);
        const hostRequestSha256 = sha(rawFixture.hostRequestBytes);
        assert.doesNotThrow(() => assertWindowsNativeStandaloneCombinedResult(combined, input, hostRequest,
            hostRequestSha256));
        const inspection = inspectWindowsNativeStandaloneEvidence(rawFixture);
        assert.deepEqual(inspection, {schemaVersion: 1,
            kind: "myspeed-windows-native-standalone-evidence-inspection", status: "accepted", qualifying: false,
            sourceSha: SOURCE_SHA, eventSha: EVENT_SHA, runId: input.adapterRequest.expectedRunId,
            runAttempt: input.adapterRequest.expectedRunAttempt,
            imageVersion: input.adapterRequest.expectedImageVersion, nonce: input.adapterRequest.nonce,
            qualificationSourceSha: input.qualificationSourceSha,
            qualificationRunId: input.qualificationRunId, qualificationRunAttempt: input.qualificationRunAttempt,
            qualificationManifestArtifactId: input.qualificationManifestArtifactId,
            qualificationManifestArtifactDigest: input.qualificationManifestArtifactDigest,
            manifestSha256: input.manifestSha256, hostRequestSha256,
            proofRequestSha256, hostResultSha256: sha(rawFixture.hostResultBytes),
            candidates: input.candidates.map(candidate => ({alias: candidate.alias,
                artifactLogicalName: candidate.artifactLogicalName, artifactId: candidate.artifactId,
                artifactDigest: candidate.artifactDigest, candidateSha256: candidate.sha256})),
            releaseGatesCleared: []});
        assert.throws(() => inspectWindowsNativeStandaloneEvidence({
            hostRequestBytes: rawFixture.hostRequestBytes,
            proofRequestBytes: Buffer.concat([Buffer.from(JSON.stringify(input), "utf8"), Buffer.from(" ")]),
            hostResultBytes: rawFixture.hostResultBytes
        }));
        for (const mutate of [
            value => { value.job.activeProcessesBeforeRestore = 1; },
            value => { value.job.handlesClosed = false; },
            value => { value.recovery.emergencyResultPresent = true; },
            value => { value.recovery.ready.creationFileTime = "3".repeat(16); },
            value => { value.restoration.before[0].enabled = true; },
            value => { value.restoration.after[0].enabled = false; },
            value => { value.restoration.ended100ns = value.restoration.watchdogDeadline100ns; },
            value => { value.restoration.offlineBoundarySha256 = "a".repeat(64); },
            value => { const evidence = structuredClone(OFFLINE_EVIDENCE); evidence.adapters[0].enabled = true;
                const retainedBoundary = retainJson(evidence); value.restoration.offlineBoundarySha256 = retainedBoundary.sha256;
                value.restoration.offlineBoundaryBase64 = retainedBoundary.base64; },
            value => { value.restoration.targets[1].interfaceGuid = value.restoration.targets[0].interfaceGuid; },
            value => { value.restoration.targets[1].netLuid = value.restoration.targets[0].netLuid; },
            value => { value.recovery.request.expectedRunAttempt = "9"; },
            value => { value.requestBase64 = Buffer.from(JSON.stringify({...hostRequest, expectedRunAttempt: "9"}))
                .toString("base64"); },
            value => { value.coordinator.proofRequestBase64 = Buffer.from(JSON.stringify({...input,
                qualificationRunAttempt: "9"})).toString("base64"); },
            value => { value.coordinator.proofResultBase64 = Buffer.from("{}").toString("base64"); },
            value => { value.proof.adapter.aliases[0].scenarios[0].closed.processTreeExitProven = false; }
        ]) {
            const changed = structuredClone(combined);
            mutate(changed);
            assert.throws(() => assertWindowsNativeStandaloneCombinedResult(changed, input, hostRequest,
                hostRequestSha256));
        }
        const fixtureDrift = structuredClone(combined);
        fixtureDrift.proof.adapter.aliases[0].fixture.manifestSha256 = "0".repeat(64);
        const fixtureDriftBytes = Buffer.from(JSON.stringify(fixtureDrift.proof), "utf8");
        fixtureDrift.coordinator.proofResultSha256 = sha(fixtureDriftBytes);
        fixtureDrift.coordinator.proofResultBase64 = fixtureDriftBytes.toString("base64");
        assert.throws(() => assertWindowsNativeStandaloneCombinedResult(fixtureDrift, input, hostRequest,
            hostRequestSha256), /fixture manifest binding differs/u);
        const modifiedHostRequest = structuredClone(hostRequest);
        modifiedHostRequest.expectedRunAttempt = "9";
        assert.throws(() => assertWindowsNativeStandaloneCombinedResult(combined, input, modifiedHostRequest,
            hostRequestSha256));
        const modifiedProofRequest = structuredClone(input);
        modifiedProofRequest.qualificationRunAttempt = "9";
        assert.throws(() => assertWindowsNativeStandaloneCombinedResult(combined, modifiedProofRequest, hostRequest,
            hostRequestSha256));

        const reorderedProofBoundary = structuredClone(combined);
        const equivalentEvidence = structuredClone(OFFLINE_EVIDENCE);
        equivalentEvidence.adapters.reverse();
        equivalentEvidence.ipState.reverse();
        const equivalentRetained = retainJson(equivalentEvidence);
        const proofBoundary = reorderedProofBoundary.proof.adapter.aliases[0].scenarios[0].afterStopBoundary;
        proofBoundary.boundarySha256 = equivalentRetained.sha256;
        proofBoundary.boundaryBase64 = equivalentRetained.base64;
        const reorderedProofRetained = retainJson(reorderedProofBoundary.proof);
        reorderedProofBoundary.coordinator.proofResultSha256 = reorderedProofRetained.sha256;
        reorderedProofBoundary.coordinator.proofResultBase64 = reorderedProofRetained.base64;
        assert.doesNotThrow(() => assertWindowsNativeStandaloneCombinedResult(reorderedProofBoundary, input,
            hostRequest, hostRequestSha256), "semantic offline replay must not depend on provider row order");

        const resealedRecovery = structuredClone(combined);
        resealedRecovery.recovery.request.expectedRunAttempt = "9";
        const changedRequestRetained = retainJson(resealedRecovery.recovery.request);
        resealedRecovery.recovery.requestSha256 = changedRequestRetained.sha256;
        resealedRecovery.recovery.requestBase64 = changedRequestRetained.base64;
        for (const name of ["ready", "cancel"]) {
            resealedRecovery.recovery[name].requestSha256 = changedRequestRetained.sha256;
            const changedRetained = retainJson(resealedRecovery.recovery[name]);
            resealedRecovery.recovery[`${name}Sha256`] = changedRetained.sha256;
            resealedRecovery.recovery[`${name}Base64`] = changedRetained.base64;
        }
        assert.throws(() => assertWindowsNativeStandaloneCombinedResult(resealedRecovery, input, hostRequest,
            hostRequestSha256), /recovery request binding differs: expectedRunAttempt/u);
    });

    it("maps the exact adapter lifecycle to stateful native and existing-assertion operations", async () => {
        const input = request();
        const harness = makeRuntime();
        const operations = createWindowsNativeStandaloneOperations(input, harness.runtime);
        const result = await runWindowsNativeStandaloneAdapter(input, operations);
        assert.equal(result.status, "completed", JSON.stringify(result));
        assert.equal(result.qualifying, false);
        assert.deepEqual(result.releaseGatesCleared, []);
        assert.equal(harness.fixtures.size, 2);
        assert.equal(harness.sessions.size, WINDOWS_NATIVE_ALIASES.length * WINDOWS_NATIVE_SCENARIOS.length);
        assert.equal(harness.events.filter(value => value.startsWith("close:")).length, 6);
        assert.equal(harness.events.at(-1), "cleanup:baseline");
    });

    it("executes the concrete controller, listener, existing HTTP, SQLite, stop, and cleanup bindings", async () => {
        const input = proofRequest();
        const harness = makeActualRuntimeDependencies(input);
        const result = await runWindowsNativeStandaloneProof(input,
            createWindowsNativeStandaloneRuntime(input, harness.dependencies));
        assert.equal(result.status, "completed");
        assert.equal(result.qualifying, false);
        assert.equal(harness.events.filter(value => value.startsWith("start:")).length, 6);
        assert.equal(harness.events.filter(value => value.startsWith("stop:")).length, 4);
        assert.equal(harness.events.filter(value => value.startsWith("http:")).length, 4);
        assert.equal(harness.events.filter(value => value.startsWith("remove:")).length, 4);
    });

    it("retains request-owned cleanup authority when prepare and open throw after allocation", async () => {
        for (const failing of ["prepareFixture", "openSession"]) {
            const input = request();
            const harness = makeRuntime();
            const original = harness.runtime[failing];
            harness.runtime[failing] = async value => {
                await original(value);
                throw new Error(`injected ${failing}`);
            };
            const result = await runWindowsNativeStandaloneAdapter(input,
                createWindowsNativeStandaloneOperations(input, harness.runtime));
            assert.equal(result.status, "failed");
            if (failing === "prepareFixture") assert.ok(harness.events.includes("cleanup:default"));
            else assert.ok(harness.events.includes("close:default:populated-first-boot"));
        }
    });

    it("does not accept fabricated low-level offline, listener, or teardown proofs", async () => {
        const mutations = [
            ["observeOffline", value => ({...value, offlineBoundaryPassed: false})],
            ["launchSession", value => ({...value, retainedHandleAuthority: false})],
            ["closeSession", value => ({...value, listenerGone: false})]
        ];
        for (const [name, mutate] of mutations) {
            const input = request();
            const harness = makeRuntime();
            const original = harness.runtime[name];
            harness.runtime[name] = async value => mutate(await original(value));
            const result = await runWindowsNativeStandaloneAdapter(input,
                createWindowsNativeStandaloneOperations(input, harness.runtime));
            assert.equal(result.status, "failed");
            assert.equal(result.qualifying, false);
        }
    });

    it("rejects missing or extra runtime operations before any lifecycle call", () => {
        const input = request();
        const harness = makeRuntime();
        delete harness.runtime.closeSession;
        assert.throws(() => createWindowsNativeStandaloneOperations(input, harness.runtime), /runtime operations/i);
        const extra = {...makeRuntime().runtime, other: async () => null};
        assert.throws(() => createWindowsNativeStandaloneOperations(input, extra), /runtime operations/i);
    });

    windowsIt("uses the real bounded-file bridges for controller request, ready, and result JSON", async () => {
        const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-native-proof-")));
        const root = path.join(parent, `myspeed-native-standalone-${NONCE}`);
        fs.mkdirSync(root);
        const proof = proofRequest();
        proof.taskRoot = root;
        proof.resultPath = path.join(root, "proof.result.json");
        proof.fixtures.forEach(fixture => {
            fixture.manifestPath = path.join(root, `fixture-${fixture.alias}.json`);
            fixture.populatedWork = path.join(root, `fixture-${fixture.alias}-populated`);
            fixture.resetWork = path.join(root, `fixture-${fixture.alias}-reset`);
        });
        proof.candidates.forEach(candidate => candidate.controllerRequests.forEach(definition => {
            definition.taskRoot = path.join(root, `myspeed-native-candidate-${candidateNonce(candidate.alias,
                definition.scenario)}`);
            fs.mkdirSync(definition.taskRoot);
            definition.path = path.join(definition.taskRoot, "candidate.request.json");
            definition.candidatePath = path.join(definition.taskRoot, "MySpeed.exe");
            definition.controllerPath = path.join(definition.taskRoot, "windows-clean-stop-controller.ps1");
            const value = controllerRequest(proof, definition);
            fs.writeFileSync(definition.path, JSON.stringify(value));
            definition.sha256 = sha(fs.readFileSync(definition.path));
        }));
        const candidate = proof.candidates[0];
        const definition = candidate.controllerRequests[0];
        const value = controllerRequest(proof, definition);
        value.workingDirectory = proof.fixtures[0].populatedWork;
        value.stdoutPath = path.join(value.taskRoot, "stdout.log");
        value.stderrPath = path.join(value.taskRoot, "stderr.log");
        value.readyPath = path.join(value.taskRoot, "ready.json");
        value.stopRequestPath = path.join(value.taskRoot, "stop.json");
        value.resultPath = path.join(value.taskRoot, "result.json");
        fs.writeFileSync(definition.path, JSON.stringify(value));
        definition.sha256 = sha(fs.readFileSync(definition.path));
        const ready = {schemaVersion: 1, kind: "myspeed-windows-native-candidate-ready", nonce: value.nonce,
            manifestSha256: value.manifestSha256, alias: value.alias, scenario: value.scenario,
            artifactLogicalName: value.artifactLogicalName, candidateSha256: value.candidateSha256,
            candidatePid: 9001, candidateCreationTime: "1".repeat(16), retainedHandleAuthority: true,
            jobAssignedBeforeResume: true, handleListConfigured: true};
        const result = {schemaVersion: 1, kind: "myspeed-windows-native-candidate-result", status: "completed",
            qualifying: false, releaseGatesCleared: [], alias: value.alias,
            artifactLogicalName: value.artifactLogicalName, scenario: value.scenario, stopKind: "ctrl-c",
            candidatePid: 9001, candidateCreationTime: "1".repeat(16), candidateExited: true, exitCode: 0,
            forced: false, jobActiveProcesses: 0, handleCleanupAttempted: true, handlesClosed: true,
            processTreeExitProven: true, listenerGone: false, elapsedMs: 100, failures: []};
        try {
            const runtime = createWindowsNativeStandaloneRuntime(proof, {
                startController: () => {
                    fs.writeFileSync(value.readyPath, JSON.stringify(ready));
                    fs.writeFileSync(value.resultPath, JSON.stringify(result));
                    return {completion: Promise.resolve({exitCode: 0, signal: null})};
                },
                observeListener: async input => input.mode === "absent" ? {listenerGone: true} : {listenerOwned: true}
            });
            const ownership = {sessionId: "session", alias: candidate.alias, scenario: definition.scenario};
            const opened = await runtime.openSession({alias: candidate.alias, scenario: definition.scenario,
                artifactLogicalName: candidate.artifactLogicalName, ownership, fixtureState: {expected: {}}});
            await runtime.launchSession(opened);
            assert.equal((await runtime.closeSession({state: opened.state, ownership})).candidateExited, true);
        } finally { fs.rmSync(parent, {recursive: true, force: true}); }
    });

    it("blocks fixture deletion and later work when a launched controller never publishes ready", async () => {
        const proof = proofRequest();
        const harness = makeActualRuntimeDependencies(proof);
        let removed = false;
        harness.dependencies.readReady = async () => { throw new Error("ready absent"); };
        harness.dependencies.removeOwnedWork = () => { removed = true; };
        const runtime = createWindowsNativeStandaloneRuntime(proof, harness.dependencies);
        const candidate = proof.candidates[0];
        const ownership = {sessionId: "uncertain", alias: candidate.alias, scenario: "populated-first-boot"};
        const fixtureState = {populated: {root: proof.fixtures[0].populatedWork, nonce: NONCE},
            reset: {root: proof.fixtures[0].resetWork, nonce: NONCE}, expected: {}};
        const opened = await runtime.openSession({alias: candidate.alias, scenario: ownership.scenario,
            artifactLogicalName: candidate.artifactLogicalName, ownership, fixtureState});
        await assert.rejects(runtime.launchSession(opened), /ready absent/u);
        await assert.rejects(runtime.closeSession({state: opened.state, ownership}), /outer Job cleanup/iu);
        await assert.rejects(runtime.cleanupFixture({state: fixtureState, ownership: {alias: candidate.alias}}),
            /outer Job cleanup/iu);
        await assert.rejects(runtime.observeOffline({alias: candidate.alias, scenario: ownership.scenario,
            phase: "after-stop"}), /outer Job cleanup/iu);
        assert.equal(removed, false);
    });
});
