import assert from "node:assert/strict";
import crypto from "node:crypto";
import {execFileSync, spawnSync} from "node:child_process";
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {describe, it} from "node:test";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.resolve(import.meta.dirname, "../../scripts/qualification/windows-native-standalone-host.ps1");
const POWERSHELL = process.platform === "win32"
    ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : null;
const TEST_TIMEOUT_MS = 20_000;
const LARGE_TEST_FILE_BYTES = 2_097_153;

const invoke = (mode, input) => JSON.parse(execFileSync(POWERSHELL,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT,
        "-Mode", mode, "-InputJson", JSON.stringify(input)],
    {encoding: "utf8", timeout: TEST_TIMEOUT_MS}));

const request = () => ({
    schemaVersion: 1,
    kind: "myspeed-windows-native-standalone-host-injected",
    phases: ["arm-recovery", "disable-adapters", "launch-coordinator", "wait-coordinator", "prove-job-zero",
        "restore-adapters", "disarm-recovery", "cleanup"],
    failAt: null,
    jobActiveAfterCoordinator: 0,
    coordinatorExitCode: 0
});
const hostedRequest = () => ({
    schemaVersion: 1,
    kind: "myspeed-windows-native-standalone-host-request",
    expectedRunId: "12345",
    expectedRunAttempt: "2",
    expectedEventSha: "a".repeat(40),
    expectedSourceSha: "b".repeat(40),
    expectedImageVersion: "20260913.1",
    nonce: "c".repeat(32),
    manifestSha256: "d".repeat(64),
    taskRoot: "C:\\runner\\myspeed-native-standalone-" + "c".repeat(32),
    hostPath: "C:\\runner\\closure\\windows-native-standalone-host.ps1",
    hostSha256: "1".repeat(64),
    canaryPath: "C:\\runner\\closure\\windows-winsw-offline-canary.ps1",
    canarySha256: "2".repeat(64),
    coordinatorExecutablePath: "C:\\runner\\closure\\node.exe",
    coordinatorExecutableSha256: "3".repeat(64),
    coordinatorModuleSha256: "5".repeat(64),
    proofRequestSha256: "4".repeat(64),
    proofResultPath: "C:\\runner\\myspeed-native-standalone-" + "c".repeat(32) + "\\proof.result.json",
    coordinatorArguments: ["C:\\runner\\closure\\windows-native-standalone-proof.mjs", "--request",
        "C:\\runner\\myspeed-native-standalone-" + "c".repeat(32) + "\\proof.request.json",
        "--sha256", "4".repeat(64)],
    workingDirectory: "C:\\runner\\myspeed-native-standalone-" + "c".repeat(32),
    resultPath: "C:\\runner\\myspeed-native-standalone-" + "c".repeat(32) + "\\host.result.json",
    entryDiagnosticPath: "C:\\runner\\myspeed-native-standalone-" + "c".repeat(32) + "\\host.entry-failure.json",
    recoveryRequestPath: "C:\\runner\\myspeed-native-standalone-" + "c".repeat(32) + "\\recovery.request.json",
    recoveryReadyPath: "C:\\runner\\myspeed-native-standalone-" + "c".repeat(32) + "\\recovery.ready.json",
    recoveryResultPath: "C:\\runner\\myspeed-native-standalone-" + "c".repeat(32) + "\\recovery.result.json",
    cancelPath: "C:\\runner\\myspeed-native-standalone-" + "c".repeat(32) + "\\recovery.cancel",
    lockPath: "C:\\runner\\myspeed-native-standalone-" + "c".repeat(32) + "\\recovery.lock",
    jobName: "Global\\MySpeedStandaloneJob-" + "c".repeat(32),
    taskName: "MySpeedStandaloneRecovery-" + "c".repeat(32),
    normalDeadlineMs: 600_000,
    hardDeadlineMs: 610_000
});

describe("Windows native standalone host", () => {
    it("compiles its native declarations without invoking native methods", {skip: !POWERSHELL}, () => {
        const command = `. '${SCRIPT.replaceAll("'", "''")}' -Mode Library; `
            + "Add-Type -TypeDefinition (Get-MyspeedStandaloneNativeSource) -Language CSharp -ErrorAction Stop; "
            + "'compiled'";
        const result = execFileSync(POWERSHELL,
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
            {encoding: "utf8", timeout: TEST_TIMEOUT_MS, windowsHide: true});
        assert.equal(result.trim(), "compiled");
    });

    it("is import-inert and keeps every native entry behind the real hosted guard", () => {
        const source = readFileSync(SCRIPT, "utf8");
        assert.match(source, /if\(\$Mode -ceq 'Library'\)\{return\}/u);
        assert.match(source, /Assert-MyspeedStandaloneHostedContext/u);
        const hostedEntry = source.indexOf("function Invoke-MyspeedStandaloneHostedProof");
        const hostedGuard = source.indexOf("Assert-MyspeedStandaloneHostedContext", hostedEntry);
        assert.ok(hostedGuard < source.indexOf("Import-Module NetAdapter", hostedEntry));
        assert.ok(hostedGuard < source.indexOf("Add-Type -TypeDefinition", hostedEntry));
        assert.match(source, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/u);
        assert.match(source, /CREATE_SUSPENDED/u);
        assert.match(source, /AssignProcessToJobObject/u);
        assert.match(source, /GetProcessTimes/u);
        assert.match(source, /GetFileInformationByHandle/u);
        assert.match(source, /GetFinalPathNameByHandleW/u);
        assert.match(source, /public static MySpeedStandaloneFileIdentity InspectFile/u);
        assert.match(source, /QueryFullProcessImageNameW/u);
        assert.match(source, /Coordinator image path differs/u);
        assert.match(source, /ObserveAbi/u);
        assert.match(source, /StartupInfoOutputOffset=Offset\(typeof\(STARTUPINFO\),"hStdOutput"\)/u);
        assert.match(source, /OpenJobObjectW/u);
        assert.match(source, /TerminateJobObject/u);
        assert.match(source, /ActiveProcesses/u);
        assert.doesNotMatch(source, /Stop-Process/u);
        assert.doesNotMatch(source, /TickCount64/u);
        assert.match(source, /QueryUnbiasedInterruptTime/u);
        assert.match(source, /JOB_SDDL="D:P\(A;;GA;;;SY\)/u);
        assert.match(source, /ConvertStringSecurityDescriptorToSecurityDescriptorW/u);
        assert.match(source, /ERROR_ALREADY_EXISTS/u);
        assert.doesNotMatch(source, /finally\{if\(descriptor!=IntPtr\.Zero&&LocalFree\(descriptor\)!=IntPtr\.Zero\)throw/u);
        assert.match(source, /LocalFree security descriptor[\s\S]*?AggregateException/u);
        assert.match(source, /sharingViolationWin32Code=32/u);
        assert.match(source, /Test-MyspeedStandaloneStableReadable \$Request\.recoveryReadyPath/u);
        assert.match(source, /Read-MyspeedStandaloneRecoveryCancel \$request \$loaded\.sha256/u);
        assert.match(source, /Write-MyspeedStandaloneCreateNewJson \$State\.request\.recoveryRequestPath[\s\S]*?MySpeedStandaloneNamedJob\]::new[\s\S]*?Register-ScheduledTask[\s\S]*?Disable-NetAdapter/u);
        assert.match(source, /\$prove=\{[\s\S]*?activeProcessesBeforeRestore -ne 0\)\{throw 'Standalone owned Job retained processes after coordinator exit'\}[\s\S]*?\$State\.jobZero=\$true/u);
        assert.match(source, /ActiveProcesses -ne 0[\s\S]*?Enable-NetAdapter/u);
        assert.match(source, /Write-MyspeedStandaloneCreateNewJson \$State\.request\.cancelPath[\s\S]*?finally\{\$lock\.Dispose/u,
            "normal cancellation must be committed under the restoration lock");
        assert.match(source, /\$State\.adapterRestoreProven=\$true[\s\S]*?restoreEnded100ns[\s\S]*?cancelSha256[\s\S]*?\$State\.restoreRequired=\$false/u,
            "restoration ownership must remain live until cancellation is durably rebound");
        assert.match(source, /Invoke-MyspeedStandaloneRecoveryCancellationCore/u);
        assert.equal(source.match(/function Invoke-MyspeedStandaloneModuleCommand/gu)?.length, 1);
        assert.doesNotMatch(source, /function Get-MyspeedStandalone(?:Offline|Listener)Observation \{\s*param\(\[object\]\$Input\)/u);
        assert.match(source, /proofResultBase64/u);
        assert.match(source, /offlineBoundaryBase64=\$State\.offlineBase64/u);
        assert.match(source, /\$State\.offlineBase64=\$offline\.boundaryBase64/u);
        assert.match(source, /activeProcessesBeforeRestore/u);
        assert.match(source, /processExitProven/u);
        assert.match(source, /taskUnregistered/u);
        assert.match(source, /host\.entry-failure\.json/u);
    });

    it("hashes a coordinator binary above the source cap without buffering it as source", {skip: !POWERSHELL}, () => {
        const root = mkdtempSync(path.join(os.tmpdir(), "myspeed-standalone-binary-"));
        try {
            const file = path.join(root, "node.exe");
            const bytes = Buffer.alloc(LARGE_TEST_FILE_BYTES, 0x5a);
            writeFileSync(file, bytes, {flag: "wx"});
            const result = invoke("TestBinaryIdentity", {path: file, sha256: crypto.createHash("sha256")
                .update(bytes).digest("hex")});
            assert.equal(result.bytes, String(LARGE_TEST_FILE_BYTES));
            const changed = {path: file, sha256: "0".repeat(64)};
            assert.throws(() => invoke("TestBinaryIdentity", changed));
        } finally {
            rmSync(root, {recursive: true, force: true});
        }
    });

    it("strictly validates the exact candidate-copy identity used to seal launch requests", {skip: !POWERSHELL}, () => {
        const requestValue = {path: "C:\\runner\\candidate\\MySpeed.exe",
            allowedRoot: "C:\\runner\\candidate", expectedSha256: "1".repeat(64)};
        const observation = {path: requestValue.path, bytes: 85_000_000, sha256: requestValue.expectedSha256,
            volumeSerial: "2".repeat(8), fileId: "3".repeat(16), linkCount: 1, reparsePoint: false};
        assert.equal(invoke("ValidateCandidateIdentity", {request: requestValue, observation}).fileId,
            observation.fileId);
        for (const mutate of [
            value => { value.observation.sha256 = "0".repeat(64); },
            value => { value.observation.path += ".stale"; },
            value => { value.observation.linkCount = 2; },
            value => { value.observation.reparsePoint = true; },
            value => { value.request.path = "C:\\other\\MySpeed.exe"; },
            value => { value.observation.extra = true; }
        ]) {
            const input = {request: structuredClone(requestValue), observation: structuredClone(observation)};
            mutate(input);
            assert.throws(() => invoke("ValidateCandidateIdentity", input));
        }
    });

    it("executes the shared observer projections with injected provider records", {skip: !POWERSHELL}, () => {
        const input = {
            offlineRequest: {schemaVersion: 1, alias: "default", scenario: null, phase: "before-launch",
                canaryPath: "C:\\runner\\closure\\windows-winsw-offline-canary.ps1", canarySha256: "2".repeat(64)},
            snapshot: {inventory: [{loopback: false, enabled: false}]},
            ipState: [{kind: "interface", loopback: false, routable: false},
                {kind: "address", loopback: false, routable: false},
                {kind: "route", loopback: false, routable: false}],
            listenerRequest: {schemaVersion: 1, mode: "owned", address: "127.0.0.1", port: 65000,
                candidatePid: 4321, candidateCreationTime: "1".repeat(16)},
            connections: [{State: "Listen", LocalAddress: "127.0.0.1", LocalPort: 65000, OwningProcess: 4321}],
            processIdentity: {exists: true, creationFileTime: "1".repeat(16)}
        };
        const result = invoke("TestObservationCore", input);
        assert.equal(result.offline.offlineBoundaryPassed, true);
        assert.equal(result.listener.listenerOwned, true);
        for (const mutate of [
            value => { value.connections[0].LocalPort = null; },
            value => { value.connections[0].State = "Established"; },
            value => { value.processIdentity.creationFileTime = "2".repeat(16); },
            value => { value.ipState = value.ipState.slice(0, 2); }
        ]) {
            const changed = structuredClone(input); mutate(changed);
            if (changed.connections[0]?.State === "Established") {
                assert.equal(invoke("TestObservationCore", changed).listener.listenerOwned, false);
            } else if (changed.processIdentity.creationFileTime === "2".repeat(16)) {
                assert.equal(invoke("TestObservationCore", changed).listener.listenerOwned, false);
            } else {
                assert.throws(() => invoke("TestObservationCore", changed));
            }
        }
        const absent = structuredClone(input);
        absent.listenerRequest.mode = "absent";
        absent.connections = [];
        assert.equal(invoke("TestObservationCore", absent).listener.listenerGone, true);
    });

    it("runs one common injected lifecycle and restores only after the exact Job is empty", {skip: !POWERSHELL}, () => {
        const result = invoke("TestLifecycle", request());
        assert.equal(result.status, "completed");
        assert.equal("failureDetails" in result, false);
        assert.equal(result.qualifying, false);
        assert.deepEqual(result.releaseGatesCleared, []);
        assert.deepEqual(result.events, request().phases);
        assert.equal(result.jobZeroBeforeRestore, true);
        assert.equal(result.adaptersRestored, true);
    });

    it("strictly validates the native host request and all owned path/deadline bindings", {skip: !POWERSHELL}, () => {
        assert.equal(invoke("ValidateRequest", hostedRequest()).kind,
            "myspeed-windows-native-standalone-host-request");
        for (const mutate of [
            value => { value.normalDeadlineMs -= 1; },
            value => { value.coordinatorArguments = "not-an-array"; },
            value => { value.resultPath = value.cancelPath; },
            value => { value.entryDiagnosticPath = value.resultPath; },
            value => { value.jobName += "\n"; },
            value => { value.hostSha256 = [value.hostSha256]; },
            value => { value.extra = true; }
        ]) {
            const changed = structuredClone(hostedRequest());
            mutate(changed);
            assert.throws(() => invoke("ValidateRequest", changed));
        }
    });

    it("fails closed and still cleans every injected phase failure", {skip: !POWERSHELL}, () => {
        for (const phase of request().phases) {
            const value = request();
            value.failAt = phase;
            const result = invoke("TestLifecycle", value);
            assert.equal(result.status, "failed", phase);
            assert.equal(result.qualifying, false, phase);
            assert.ok(result.events.includes("cleanup"), phase);
            assert.equal(result.failureDetails[0].phase, phase);
            assert.match(result.failureDetails[0].failure, /Injected failure/u);
            assert.ok(result.failureDetails[0].failure.length <= 512);
            if (phase === "restore-adapters")
                assert.equal(result.adaptersRestored, false, phase);
        }
    });

    it("will not restore networking while any owned Job process remains", {skip: !POWERSHELL}, () => {
        const value = request();
        value.jobActiveAfterCoordinator = 1;
        const result = invoke("TestLifecycle", value);
        assert.equal(result.status, "failed");
        assert.equal(result.jobZeroBeforeRestore, false);
        assert.equal(result.failureDetails[0].phase, "prove-job-zero");
        assert.match(result.failureDetails[0].failure, /Job/u);
        assert.equal(result.adaptersRestored, false);
        assert.ok(result.events.includes("cleanup"));
    });

    it("rejects local native invocation before request I/O or native initialization", {skip: !POWERSHELL}, () => {
        for (const mode of ["ObserveOffline", "ObserveListener", "ObserveCandidateIdentity", "InvokeHostedProof",
            "InvokeRestoration"]) {
            const result = spawnSync(POWERSHELL,
                ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT,
                    "-Mode", mode, "-RequestPath", path.join(ROOT, "absent.json")],
                {encoding: "utf8", timeout: TEST_TIMEOUT_MS});
            assert.notEqual(result.status, 0);
            assert.match(result.stderr, /hosted context|restoration run ID/i);
            assert.doesNotMatch(result.stderr, /absent\.json|cannot find path/i);
        }
    });

    it("strictly binds the LocalSystem recovery request without inherited GitHub state", {skip: !POWERSHELL}, () => {
        const host = hostedRequest();
        const recovery = {schemaVersion: 1, kind: "myspeed-windows-native-standalone-recovery-request",
            expectedRunId: host.expectedRunId, expectedRunAttempt: host.expectedRunAttempt,
            expectedEventSha: host.expectedEventSha, expectedSourceSha: host.expectedSourceSha,
            expectedImageVersion: host.expectedImageVersion, nonce: host.nonce, hostPath: host.hostPath,
            hostSha256: host.hostSha256, canaryPath: host.canaryPath, canarySha256: host.canarySha256,
            requestSha256: "6".repeat(64), taskRoot: host.taskRoot, jobName: host.jobName, taskName: host.taskName,
            recoveryRequestPath: host.recoveryRequestPath, recoveryReadyPath: host.recoveryReadyPath,
            recoveryResultPath: host.recoveryResultPath, cancelPath: host.cancelPath, lockPath: host.lockPath,
            watchdogDeadline100ns: "123456789", adapters: [{interfaceGuid: "{11111111-1111-1111-1111-111111111111}",
                netLuid: "0000000000000001"}]};
        assert.equal(invoke("ValidateRecoveryRequest", recovery).kind, recovery.kind);
        for (const mutate of [
            value => { value.expectedRunId = "0"; },
            value => { value.requestSha256 += "0"; },
            value => { value.taskRoot += "-stale"; },
            value => { value.jobName = "Local\\other"; },
            value => { value.recoveryReadyPath = `${value.taskRoot}\\other.json`; },
            value => { value.adapters[0].interfaceGuid = "{not-a-guid}"; },
            value => { value.adapters.push({...value.adapters[0]}); }
        ]) {
            const changed = structuredClone(recovery); mutate(changed);
            assert.throws(() => invoke("ValidateRecoveryRequest", changed));
        }
        const source = readFileSync(SCRIPT, "utf8");
        const restoration = source.indexOf("function Invoke-MyspeedStandaloneRestoration");
        assert.ok(source.indexOf("Assert-MyspeedStandaloneRestorationContext", restoration)
            < source.indexOf("Read-MyspeedStandaloneJsonFile", restoration));
        assert.ok(source.indexOf("Read-MyspeedStandaloneJsonFile", restoration)
            < source.indexOf("Import-Module NetAdapter", restoration));
    });

    it("requires an exact request-bound recovery cancellation record", {skip: !POWERSHELL}, () => {
        const expectedRequestSha256 = "6".repeat(64);
        const value = {schemaVersion: 1, kind: "myspeed-windows-native-standalone-recovery-cancel",
            requestSha256: expectedRequestSha256};
        assert.equal(invoke("ValidateRecoveryCancel", {value, expectedRequestSha256}).requestSha256,
            expectedRequestSha256);
        for (const mutate of [
            input => { input.value.requestSha256 = "7".repeat(64); },
            input => { input.value.kind += "-stale"; },
            input => { input.value.extra = true; },
            input => { input.expectedRequestSha256 = [expectedRequestSha256]; }
        ]) {
            const input = {value: structuredClone(value), expectedRequestSha256};
            mutate(input);
            assert.throws(() => invoke("ValidateRecoveryCancel", input));
        }
    });

    it("cancels recovery under one lock only after restoration is safe", {skip: !POWERSHELL}, () => {
        const restored = invoke("TestRecoveryCancellation", {disableAttempted: true,
            adapterRestoreProven: true, recoveryResultPresent: false, cancelPresent: false, writeFails: false});
        assert.equal(restored.cancelCommitted, true);
        assert.deepEqual(restored.events, ["lock", "result", "read", "write", "read", "dispose"]);

        const neverDisabled = invoke("TestRecoveryCancellation", {disableAttempted: false,
            adapterRestoreProven: false, recoveryResultPresent: false, cancelPresent: true, writeFails: false});
        assert.equal(neverDisabled.cancelCommitted, true);
        assert.deepEqual(neverDisabled.events, ["lock", "result", "read", "dispose"]);

        for (const unsafe of [
            {disableAttempted: true, adapterRestoreProven: false, recoveryResultPresent: false,
                cancelPresent: false, writeFails: false},
            {disableAttempted: true, adapterRestoreProven: true, recoveryResultPresent: true,
                cancelPresent: false, writeFails: false},
            {disableAttempted: true, adapterRestoreProven: true, recoveryResultPresent: false,
                cancelPresent: false, writeFails: true}
        ]) assert.throws(() => invoke("TestRecoveryCancellation", unsafe));
    });

    it("strictly binds the completed coordinator proof result to the hosted request", {skip: !POWERSHELL}, () => {
        const host = hostedRequest();
        const proofRequest = {qualificationSourceSha: host.expectedSourceSha, qualificationRunId: "98765",
            qualificationRunAttempt: "3", qualificationManifestArtifactId: "8001",
            qualificationManifestArtifactDigest: `sha256:${"f".repeat(64)}`};
        const value = {schemaVersion: 1, kind: "myspeed-windows-native-standalone-proof-result", status: "completed",
            qualifying: false, manifestSha256: host.manifestSha256, sourceSha: host.expectedSourceSha,
            eventSha: host.expectedEventSha, runId: host.expectedRunId, runAttempt: host.expectedRunAttempt,
            imageVersion: host.expectedImageVersion, nonce: host.nonce,
            qualificationSourceSha: proofRequest.qualificationSourceSha, qualificationRunId: proofRequest.qualificationRunId,
            qualificationRunAttempt: proofRequest.qualificationRunAttempt,
            qualificationManifestArtifactId: proofRequest.qualificationManifestArtifactId,
            qualificationManifestArtifactDigest: proofRequest.qualificationManifestArtifactDigest,
            candidates: [{alias: "default"}],
            adapter: {status: "completed"},
            releaseGatesCleared: []};
        assert.equal(invoke("ValidateProofResult", {value, request: host, proofRequest}).status, "completed");
        for (const mutate of [
            input => { input.value.sourceSha = "f".repeat(40); },
            input => { input.value.releaseGatesCleared = ["standalone"]; },
            input => { input.value.qualifying = true; },
            input => { input.value.adapter = null; },
            input => { input.value.extra = true; }
        ]) {
            const changed = {value: structuredClone(value), request: structuredClone(host),
                proofRequest: structuredClone(proofRequest)};
            mutate(changed);
            assert.throws(() => invoke("ValidateProofResult", changed));
        }
    });

    it("writes only a bounded owned entry diagnostic after validated request setup", {skip: !POWERSHELL}, () => {
        const root = mkdtempSync(path.join(os.tmpdir(), "myspeed-standalone-entry-"));
        const diagnosticPath = path.join(root, "host.entry-failure.json");
        try {
            const value = invoke("TestEntryDiagnostic", {path: diagnosticPath, stage: "native-initialization",
                message: `failure\n${"x".repeat(700)}`});
            assert.equal(value.kind, "myspeed-windows-native-standalone-entry-failure");
            assert.equal(value.status, "failed");
            assert.equal(value.stage, "native-initialization");
            assert.ok(value.failure.length <= 512);
            assert.doesNotMatch(value.failure, /[\r\n]/u);
            assert.throws(() => invoke("TestEntryDiagnostic", {path: diagnosticPath, stage: "native-initialization",
                message: "second"}));
        } finally { rmSync(root, {recursive: true, force: true}); }
    });
});
