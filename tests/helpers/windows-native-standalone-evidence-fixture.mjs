import {createHash} from "node:crypto";

import {WINDOWS_NATIVE_ALIASES, WINDOWS_NATIVE_SCENARIOS} from
    "../../scripts/qualification/windows-native-standalone-adapter.mjs";
import {runWindowsNativeStandaloneProof} from "../../scripts/qualification/windows-native-standalone-proof.mjs";

const DEFAULT_SOURCE_SHA = "a".repeat(40);
const DEFAULT_EVENT_SHA = "b".repeat(40);
const DEFAULT_NONCE = "c".repeat(32);
const DEFAULT_MANIFEST_SHA = "e".repeat(64);
const DEFAULT_SUMMARY_SHA = "d".repeat(64);
const DEFAULT_FIXTURE_BYTES = Buffer.from("sealed fixture", "utf8");
const NORMAL_HOST_DEADLINE_MS = 600_000;
const HARD_HOST_DEADLINE_MS = 610_000;
const RESET_EXIT_CODE = 113;
const OFFLINE_TARGETS = [
    {interfaceGuid: "{11111111-1111-1111-1111-111111111111}", netLuid: "0000000000000001"},
    {interfaceGuid: "{22222222-2222-2222-2222-222222222222}", netLuid: "0000000000000002"}
];

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const retained = value => {
    const bytes = Buffer.from(JSON.stringify(value), "utf8");
    return {bytes, sha256: hash(bytes), base64: bytes.toString("base64")};
};
const candidateNonce = (alias, scenario) => createHash("sha256").update(`${alias}\0${scenario}`)
    .digest("hex").slice(0, 32);
const artifactLogicalName = alias => alias === "default" ? "MySpeed-windows-x64.exe"
    : "MySpeed-windows-x64-baseline.exe";

const makeOfflineEvidence = () => ({schemaVersion: 1,
    providers: {adapters: true, ipInterfaces: true, ipAddresses: true, routes: true},
    adapters: OFFLINE_TARGETS.map((target, index) => ({...target, hidden: false, interfaceType: 6,
        interfaceAdminStatus: 2, status: "Disabled", interfaceIndex: index + 4, loopback: false, enabled: false})),
    ipState: ["address", "interface", "route"].map(kind => ({kind, compartmentId: 1, loopback: false,
        routable: false}))});

const makeCandidates = input => WINDOWS_NATIVE_ALIASES.map((alias, index) => {
    const supplied = input?.find(candidate => candidate.alias === alias) ?? {};
    return {alias, artifactLogicalName: supplied.artifactLogicalName ?? artifactLogicalName(alias),
        artifactId: supplied.artifactId ?? String(7000 + index),
        artifactDigest: supplied.artifactDigest ?? `sha256:${String(index + 7).repeat(64)}`,
        sha256: supplied.sha256 ?? String(index + 1).repeat(64),
        volumeSerial: supplied.volumeSerial ?? String(index + 3).repeat(8),
        fileId: supplied.fileId ?? String(index + 5).repeat(16)};
});

const makeProofRequest = options => {
    const sourceSha = options.sourceSha ?? DEFAULT_SOURCE_SHA;
    const nonce = options.nonce ?? DEFAULT_NONCE;
    const taskRoot = options.taskRoot ?? `C:\\runner\\myspeed-native-standalone-${nonce}`;
    const candidates = makeCandidates(options.candidates);
    return {schemaVersion: 1, kind: "myspeed-windows-native-standalone-proof-request", qualifying: false,
        adapterRequest: {schemaVersion: 1, kind: "myspeed-windows-native-standalone-adapter-request",
            qualifying: false, expectedRunId: options.runId ?? "12345",
            expectedRunAttempt: options.runAttempt ?? "2", expectedSourceSha: sourceSha,
            expectedEventSha: options.eventSha ?? DEFAULT_EVENT_SHA,
            expectedImageVersion: options.imageVersion ?? "20260913.1", nonce,
            aliases: candidates.map(candidate => ({alias: candidate.alias, candidateSha256: candidate.sha256,
                artifactLogicalName: candidate.artifactLogicalName}))},
        manifestSha256: options.manifestSha256 ?? DEFAULT_MANIFEST_SHA,
        qualificationManifestArtifactId: options.qualificationManifestArtifactId ?? "8001",
        qualificationManifestArtifactDigest: options.qualificationManifestArtifactDigest
            ?? `sha256:${"f".repeat(64)}`,
        qualificationSourceSha: options.qualificationSourceSha ?? sourceSha,
        qualificationRunId: options.qualificationRunId ?? "98765",
        qualificationRunAttempt: options.qualificationRunAttempt ?? "3", taskRoot,
        resultPath: `${taskRoot}\\proof.result.json`,
        fixtures: WINDOWS_NATIVE_ALIASES.map(alias => ({alias,
            manifestPath: `${taskRoot}\\fixture-${alias}.json`, manifestSha256: options.fixtureManifestSha256,
            populatedWork: `${taskRoot}\\fixture-${alias}-populated`, resetWork: `${taskRoot}\\fixture-${alias}-reset`})),
        candidateControllerPath: "C:\\runner\\closure\\windows-native-candidate-controller.ps1",
        candidateControllerSha256: "f".repeat(64),
        cleanStopControllerPath: "C:\\runner\\closure\\windows-clean-stop-controller.ps1",
        cleanStopControllerSha256: "7".repeat(64),
        hostPath: "C:\\runner\\closure\\windows-native-standalone-host.ps1", hostSha256: "9".repeat(64),
        canaryPath: "C:\\runner\\closure\\windows-winsw-offline-canary.ps1", canarySha256: "6".repeat(64),
        powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        powershellSha256: "8".repeat(64), normalDeadlineMs: NORMAL_HOST_DEADLINE_MS,
        hardDeadlineMs: HARD_HOST_DEADLINE_MS,
        candidates: candidates.map(candidate => ({...candidate,
            path: `C:\\runner\\closure\\candidate-${candidate.alias}.exe`,
            controllerRequests: WINDOWS_NATIVE_SCENARIOS.map(scenario => {
                const root = `C:\\runner\\myspeed-native-candidate-${candidateNonce(candidate.alias, scenario)}`;
                return {scenario, path: `${root}\\candidate.request.json`,
                    sha256: String(WINDOWS_NATIVE_ALIASES.indexOf(candidate.alias) + 6).repeat(64), taskRoot: root,
                    candidatePath: `${root}\\MySpeed.exe`,
                    controllerPath: `${root}\\windows-clean-stop-controller.ps1`};
            })}))};
};
const makeRuntime = (offlineSha, offlineBase64, fixtureManifestSha256) => {
    let processId = 5000;
    return {
        observeOffline: async () => ({boundarySha256: offlineSha, boundaryBase64: offlineBase64,
            offlineBoundaryPassed: true}),
        prepareFixture: async ({alias}) => ({manifestSha256: fixtureManifestSha256,
            state: {alias, populatedWork: `C:\\owned\\${alias}\\populated`,
                resetWork: `C:\\owned\\${alias}\\reset`, expected: {resultId: "synthetic"}}}),
        openSession: async ({alias, scenario, ownership}) => ({state: {id: ownership.sessionId, alias, scenario}}),
        launchSession: async () => { processId += 1; return {candidatePid: processId,
            candidateCreationTime: processId.toString(16).padStart(16, "0"), retainedHandleAuthority: true,
            jobAssignedBeforeResume: true, handleListConfigured: true}; },
        runAssertions: async ({state, stage}) => {
            const summary = stage === "running" ? {elapsedMs: 1}
                : state.scenario === "fresh-no-config-reset" ? {integrity: "ok", configTable: false}
                    : {ping: "synthetic", resultId: "synthetic", passwordValueSha256: DEFAULT_SUMMARY_SHA};
            return {summary, summarySha256: hash(Buffer.from(JSON.stringify(summary), "utf8"))};
        },
        closeSession: async ({state}) => ({status: "completed",
            stopKind: state.scenario === "fresh-no-config-reset" ? "observed-exit" : "ctrl-c",
            candidateStarted: true, candidateExited: true,
            exitCode: state.scenario === "fresh-no-config-reset" ? RESET_EXIT_CODE : 0,
            processTreeExitProven: true, jobActiveProcesses: 0, handlesClosed: true, listenerGone: true,
            forced: false}),
        cleanupFixture: async () => ({cleanupProven: true})
    };
};
const makeHostRequest = (proof, proofRequestSha256) => ({schemaVersion: 1,
    kind: "myspeed-windows-native-standalone-host-request",
    expectedRunId: proof.adapterRequest.expectedRunId, expectedRunAttempt: proof.adapterRequest.expectedRunAttempt,
    expectedEventSha: proof.adapterRequest.expectedEventSha, expectedSourceSha: proof.adapterRequest.expectedSourceSha,
    expectedImageVersion: proof.adapterRequest.expectedImageVersion, nonce: proof.adapterRequest.nonce,
    manifestSha256: proof.manifestSha256, taskRoot: proof.taskRoot, hostPath: proof.hostPath,
    hostSha256: proof.hostSha256, canaryPath: proof.canaryPath, canarySha256: proof.canarySha256,
    coordinatorExecutablePath: proof.powershellPath, coordinatorExecutableSha256: proof.powershellSha256,
    coordinatorModuleSha256: proof.hostSha256, proofRequestSha256, proofResultPath: proof.resultPath,
    coordinatorArguments: [`${proof.taskRoot}\\windows-native-standalone-proof.mjs`, "--request",
        `${proof.taskRoot}\\proof.request.json`, "--sha256", proofRequestSha256],
    workingDirectory: proof.taskRoot, resultPath: `${proof.taskRoot}\\host.result.json`,
    entryDiagnosticPath: `${proof.taskRoot}\\host.entry-failure.json`,
    recoveryRequestPath: `${proof.taskRoot}\\recovery.request.json`,
    recoveryReadyPath: `${proof.taskRoot}\\recovery.ready.json`,
    recoveryResultPath: `${proof.taskRoot}\\recovery.result.json`,
    cancelPath: `${proof.taskRoot}\\recovery.cancel`, lockPath: `${proof.taskRoot}\\recovery.lock`,
    jobName: `Global\\MySpeedStandaloneJob-${proof.adapterRequest.nonce}`,
    taskName: `MySpeedStandaloneRecovery-${proof.adapterRequest.nonce}`,
    normalDeadlineMs: NORMAL_HOST_DEADLINE_MS, hardDeadlineMs: HARD_HOST_DEADLINE_MS});

const makeRecovery = (hostRequest, hostRequestSha256) => {
    const targets = structuredClone(OFFLINE_TARGETS);
    const request = {schemaVersion: 1, kind: "myspeed-windows-native-standalone-recovery-request",
        expectedRunId: hostRequest.expectedRunId, expectedRunAttempt: hostRequest.expectedRunAttempt,
        expectedEventSha: hostRequest.expectedEventSha, expectedSourceSha: hostRequest.expectedSourceSha,
        expectedImageVersion: hostRequest.expectedImageVersion, nonce: hostRequest.nonce,
        hostPath: hostRequest.hostPath, hostSha256: hostRequest.hostSha256, canaryPath: hostRequest.canaryPath,
        canarySha256: hostRequest.canarySha256, requestSha256: hostRequestSha256,
        taskRoot: hostRequest.taskRoot, jobName: hostRequest.jobName, taskName: hostRequest.taskName,
        recoveryRequestPath: hostRequest.recoveryRequestPath, recoveryReadyPath: hostRequest.recoveryReadyPath,
        recoveryResultPath: hostRequest.recoveryResultPath, cancelPath: hostRequest.cancelPath,
        lockPath: hostRequest.lockPath, watchdogDeadline100ns: "7000000", adapters: targets};
    const requestRetained = retained(request);
    const ready = {schemaVersion: 1, kind: "myspeed-windows-native-standalone-recovery-ready",
        requestSha256: requestRetained.sha256, jobName: hostRequest.jobName, pid: 7654,
        creationFileTime: "2".repeat(16), jobOpened: true, limitsProven: true};
    const readyRetained = retained(ready);
    const cancel = {schemaVersion: 1, kind: "myspeed-windows-native-standalone-recovery-cancel",
        requestSha256: requestRetained.sha256};
    return {targets, request, requestRetained, ready, readyRetained, cancel, cancelRetained: retained(cancel)};
};

export const createWindowsNativeStandaloneEvidenceFixture = async (options = {}) => {
    const fixtureBytes = options.fixtureManifestBytes ?? DEFAULT_FIXTURE_BYTES;
    if (!Buffer.isBuffer(fixtureBytes)) throw new Error("Fixture manifest bytes must be a Buffer");
    const offline = retained(makeOfflineEvidence());
    const proofRequest = makeProofRequest({...options, fixtureManifestSha256: hash(fixtureBytes)});
    const proofRequestRetained = retained(proofRequest);
    const proofResult = await runWindowsNativeStandaloneProof(proofRequest,
        makeRuntime(offline.sha256, offline.base64, hash(fixtureBytes)));
    const proofResultRetained = retained(proofResult);
    const hostRequest = makeHostRequest(proofRequest, proofRequestRetained.sha256);
    const hostRequestRetained = retained(hostRequest);
    const recovery = makeRecovery(hostRequest, hostRequestRetained.sha256);
    const hostResult = {schemaVersion: 1, kind: "myspeed-windows-native-standalone-host-result",
        status: "completed", qualifying: false, manifestSha256: proofRequest.manifestSha256,
        sourceSha: proofRequest.adapterRequest.expectedSourceSha, eventSha: proofRequest.adapterRequest.expectedEventSha,
        runId: proofRequest.adapterRequest.expectedRunId, runAttempt: proofRequest.adapterRequest.expectedRunAttempt,
        imageVersion: proofRequest.adapterRequest.expectedImageVersion, nonce: proofRequest.adapterRequest.nonce,
        requestSha256: hostRequestRetained.sha256, requestBase64: hostRequestRetained.base64,
        abi: {SecurityAttributesSize: 24, StartupInfoSize: 104, ProcessInformationSize: 24, FileTimeSize: 8,
            BasicLimitSize: 64, ExtendedLimitSize: 144, AccountingSize: 48, StartupInfoFlagsOffset: 60,
            StartupInfoOutputOffset: 88, SecurityDescriptorOffset: 8},
        coordinator: {executablePath: proofRequest.powershellPath,
            executableSha256: proofRequest.powershellSha256, moduleSha256: proofRequest.hostSha256,
            proofRequestSha256: proofRequestRetained.sha256, proofRequestBase64: proofRequestRetained.base64,
            processId: 4321, creationFileTime: "1".repeat(16), imagePath: proofRequest.powershellPath,
            assignedBeforeResume: true, resumed: true, exitCode: 0, activeProcessesAfterWait: 0,
            proofResultSha256: proofResultRetained.sha256, proofResultBase64: proofResultRetained.base64},
        job: {name: hostRequest.jobName, activeProcessesBeforeRestore: 0, treeExitProven: true,
            handlesClosed: true},
        recovery: {request: recovery.request, requestSha256: recovery.requestRetained.sha256,
            requestBase64: recovery.requestRetained.base64, ready: recovery.ready,
            readySha256: recovery.readyRetained.sha256, readyBase64: recovery.readyRetained.base64,
            cancel: recovery.cancel, cancelSha256: recovery.cancelRetained.sha256,
            cancelBase64: recovery.cancelRetained.base64, emergencyResultPresent: false,
            processExitProven: true, taskUnregistered: true},
        restoration: {mode: "normal", watchdogDeadline100ns: "7000000", started100ns: "6000000",
            ended100ns: "6500000", offlineBoundarySha256: offline.sha256,
            offlineBoundaryBase64: offline.base64, targets: recovery.targets,
            before: recovery.targets.map(target => ({...target, enabled: false})),
            after: recovery.targets.map(target => ({...target, enabled: true}))},
        lifecycle: {schemaVersion: 1, kind: "myspeed-windows-native-standalone-host-result",
            status: "completed", qualifying: false, releaseGatesCleared: [], jobZeroBeforeRestore: true,
            adaptersRestored: true, events: ["arm-recovery", "disable-adapters", "launch-coordinator",
                "wait-coordinator", "prove-job-zero", "restore-adapters", "disarm-recovery", "cleanup"],
            failures: []}, proof: proofResult, releaseGatesCleared: []};
    return {hostRequestBytes: hostRequestRetained.bytes, proofRequestBytes: proofRequestRetained.bytes,
        hostResultBytes: Buffer.from(JSON.stringify(hostResult), "utf8")};
};
