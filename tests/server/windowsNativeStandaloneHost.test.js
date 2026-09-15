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
const OBSERVER_PORT = 45_000;
const OBSERVER_EXPECTED_PID = 8552;
const OBSERVER_EXPECTED_CREATION = "01dd44e929976cfd";
const OBSERVER_OTHER_CREATION = "2".repeat(16);
const MAXIMUM_LISTENER_DIAGNOSTIC_OWNERS = 4;
const MAXIMUM_LISTENER_DIAGNOSTIC_BYTES = 2048;

const listening = (port, owningProcess) => ({State: "Listen", LocalAddress: "127.0.0.1", LocalPort: port,
    OwningProcess: owningProcess});

const observerInput = (overrides = {}) => ({
    offlineRequest: {schemaVersion: 1, alias: "default", scenario: null, phase: "before-launch",
        canaryPath: "C:\\runner\\closure\\windows-winsw-offline-canary.ps1", canarySha256: "2".repeat(64)},
    snapshot: {inventory: [{loopback: false, enabled: false}]},
    ipState: [{kind: "interface", loopback: false, routable: false},
        {kind: "address", loopback: false, routable: false},
        {kind: "route", loopback: false, routable: false}],
    listenerRequest: {schemaVersion: 1, mode: "owned", address: "127.0.0.1", port: OBSERVER_PORT,
        candidatePid: OBSERVER_EXPECTED_PID, candidateCreationTime: OBSERVER_EXPECTED_CREATION},
    connections: [listening(OBSERVER_PORT, OBSERVER_EXPECTED_PID)],
    processObservations: {[OBSERVER_EXPECTED_PID]: {processState: "present",
        creationFileTime: OBSERVER_EXPECTED_CREATION, jobMembership: "in-job"}},
    ...overrides
});

const observeListenerCore = overrides => invoke("TestObservationCore", observerInput(overrides)).listener;

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
    it("captures native operation limits without invoking native operations", {skip: !POWERSHELL}, () => {
        const command = `. '${SCRIPT.replaceAll("'", "''")}' -Mode Library; `
            + "$operations=New-MyspeedStandaloneNativeOperations @{}; "
            + "$values=@($operations.PSObject.Properties | ForEach-Object { "
            + "$_.Value.Module.SessionState.PSVariable.GetValue('limits') }); "
            + "ConvertTo-Json -InputObject $values -Compress";
        const values = JSON.parse(execFileSync(POWERSHELL,
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
            {encoding: "utf8", timeout: TEST_TIMEOUT_MS, windowsHide: true}));
        assert.equal(values.length, request().phases.length);
        for (const value of values) assert.deepEqual(value, {recoveryTimeoutMilliseconds: 10_000,
            recoveryPollMilliseconds: 50,
            maximumSourceBytes: 2_097_152, maximumCoordinatorBytes: 134_217_728});
    });

    it("uses captured input bounds before any adapter operation", {skip: !POWERSHELL}, () => {
        const input = Buffer.from(JSON.stringify(hostedRequest())).toString("base64");
        const command = `. '${SCRIPT.replaceAll("'", "''")}' -Mode Library; `
            + "$global:ObservedQualificationLimits=[Collections.Generic.List[long]]::new(); "
            + "function Read-MyspeedStandaloneBytes { param($Path,[long]$Maximum,$Hash) "
            + "[void]$global:ObservedQualificationLimits.Add($Maximum) }; "
            + "function Get-MyspeedStandaloneFileIdentity { param($Path,[long]$Maximum,$Hash) "
            + "[void]$global:ObservedQualificationLimits.Add($Maximum) }; "
            + "function Wait-MyspeedStandaloneRecoveryReady { throw 'injected-boundary-stop' }; "
            + `$value=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${input}'))|ConvertFrom-Json; `
            + "$operations=New-MyspeedStandaloneNativeOperations @{request=$value;recoverySha256=('a'*64)}; "
            + "try { & $operations.'disable-adapters'; throw 'injected stop was not reached' } "
            + "catch { if($_.Exception.Message -cne 'injected-boundary-stop'){throw} }; "
            + "ConvertTo-Json -InputObject ([long[]]$global:ObservedQualificationLimits) -Compress";
        const values = JSON.parse(execFileSync(POWERSHELL,
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
            {encoding: "utf8", timeout: TEST_TIMEOUT_MS, windowsHide: true}));
        assert.deepEqual(values, [2_097_152, 2_097_152, 2_097_152, 2_097_152, 134_217_728]);
    });

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
            processObservations: {4321: {processState: "present", creationFileTime: "1".repeat(16),
                jobMembership: "unavailable"}}
        };
        const result = invoke("TestObservationCore", input);
        assert.equal(result.offline.offlineBoundaryPassed, true);
        assert.equal(result.listener.listenerOwned, true);
        for (const mutate of [
            value => { value.connections[0].LocalPort = null; },
            value => { value.connections[0].State = "Established"; },
            value => { value.processObservations[4321].creationFileTime = "2".repeat(16); },
            value => { value.ipState = value.ipState.slice(0, 2); }
        ]) {
            const changed = structuredClone(input); mutate(changed);
            if (changed.connections[0]?.State === "Established") {
                assert.equal(invoke("TestObservationCore", changed).listener.listenerOwned, false);
            } else if (changed.processObservations[4321].creationFileTime === "2".repeat(16)) {
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

    it("retains a bounded failure-only listener diagnostic for every unproven owner", {skip: !POWERSHELL}, () => {
        const owned = observeListenerCore();
        assert.deepEqual(Object.keys(owned), ["listenerOwned"]);
        assert.equal(owned.listenerOwned, true);

        const none = observeListenerCore({connections: [], processObservations: {}});
        assert.equal(none.listenerOwned, false);
        assert.equal(none.diagnostic.schemaVersion, 1);
        assert.equal(none.diagnostic.matchingListenerCount, 0);
        assert.equal(none.diagnostic.distinctOwnerCount, 0);
        assert.equal(none.diagnostic.expectedOwnerListenerCount, 0);
        assert.equal(none.diagnostic.retainedOwnerCount, 0);
        assert.equal(none.diagnostic.ownersTruncated, false);
        assert.deepEqual(none.diagnostic.owners, []);

        const wrong = observeListenerCore({connections: [listening(OBSERVER_PORT, 4711)],
            processObservations: {4711: {processState: "present", creationFileTime: OBSERVER_OTHER_CREATION,
                jobMembership: "not-in-job"}}});
        assert.equal(wrong.listenerOwned, false);
        assert.equal(wrong.diagnostic.matchingListenerCount, 1);
        assert.equal(wrong.diagnostic.expectedOwnerListenerCount, 0);
        assert.deepEqual(wrong.diagnostic.owners.map(owner => owner.owningProcessId), [4711]);
        assert.equal(wrong.diagnostic.owners[0].expectedOwner, false);
        assert.equal(wrong.diagnostic.owners[0].creationTimeMatches, false);
        assert.equal(wrong.diagnostic.owners[0].jobMembership, "not-in-job");

        const many = observeListenerCore({
            connections: [listening(OBSERVER_PORT, 4711), listening(OBSERVER_PORT, OBSERVER_EXPECTED_PID),
                listening(OBSERVER_PORT, 4711), listening(OBSERVER_PORT + 1, 5000)],
            processObservations: {[OBSERVER_EXPECTED_PID]: {processState: "present",
                creationFileTime: OBSERVER_EXPECTED_CREATION, jobMembership: "in-job"},
            4711: {processState: "present", creationFileTime: OBSERVER_OTHER_CREATION,
                jobMembership: "not-in-job"}}});
        assert.equal(many.listenerOwned, false);
        assert.equal(many.diagnostic.matchingListenerCount, 3);
        assert.equal(many.diagnostic.distinctOwnerCount, 2);
        assert.equal(many.diagnostic.expectedOwnerListenerCount, 1);
        assert.deepEqual(many.diagnostic.owners.map(owner => owner.owningProcessId),
            [OBSERVER_EXPECTED_PID, 4711]);
        assert.deepEqual(many.diagnostic.owners.map(owner => owner.listenerCount), [1, 2]);

        const exited = observeListenerCore({processObservations: {[OBSERVER_EXPECTED_PID]:
            {processState: "exited", creationFileTime: null, jobMembership: "unavailable"}}});
        assert.equal(exited.listenerOwned, false);
        assert.equal(exited.diagnostic.owners[0].processState, "exited");
        assert.equal(exited.diagnostic.owners[0].creationFileTime, null);
        assert.equal(exited.diagnostic.owners[0].creationTimeMatches, null);

        const raced = observeListenerCore({processObservations: {[OBSERVER_EXPECTED_PID]:
            {processState: "unavailable", creationFileTime: null, jobMembership: "unavailable"}}});
        assert.equal(raced.listenerOwned, false);
        assert.equal(raced.diagnostic.owners[0].processState, "unavailable");
        assert.equal(raced.diagnostic.owners[0].creationTimeMatches, null);

        const recycled = observeListenerCore({processObservations: {[OBSERVER_EXPECTED_PID]:
            {processState: "present", creationFileTime: OBSERVER_OTHER_CREATION, jobMembership: "in-job"}}});
        assert.equal(recycled.listenerOwned, false);
        assert.equal(recycled.diagnostic.owners[0].expectedOwner, true);
        assert.equal(recycled.diagnostic.owners[0].creationTimeMatches, false);
        assert.equal(recycled.diagnostic.expectedOwnerListenerCount, 1);
    });

    it("caps retained owner records and never truncates away the expected owner",
        {skip: !POWERSHELL}, () => {
            const competingOwners = 12;
            const connections = [listening(OBSERVER_PORT, OBSERVER_EXPECTED_PID)];
            const processObservations = {[OBSERVER_EXPECTED_PID]: {processState: "present",
                creationFileTime: OBSERVER_EXPECTED_CREATION, jobMembership: "in-job"}};
            for (let index = 0; index < competingOwners; index += 1) {
                const owner = 20_000 + index;
                connections.push(listening(OBSERVER_PORT, owner));
                processObservations[owner] = {processState: "present", creationFileTime: "3".repeat(16),
                    jobMembership: "not-in-job"};
            }
            const listener = observeListenerCore({connections, processObservations});
            assert.equal(listener.listenerOwned, false);
            assert.equal(listener.diagnostic.matchingListenerCount, competingOwners + 1);
            assert.equal(listener.diagnostic.distinctOwnerCount, competingOwners + 1);
            assert.equal(listener.diagnostic.expectedOwnerListenerCount, 1);
            assert.equal(listener.diagnostic.ownersTruncated, true);
            assert.equal(listener.diagnostic.retainedOwnerCount, listener.diagnostic.owners.length);
            assert.equal(listener.diagnostic.owners.length, MAXIMUM_LISTENER_DIAGNOSTIC_OWNERS);
            // The expected owner is ordered first, so the cap can never discard the one record that
            // explains whether the candidate itself ever held the port.
            assert.deepEqual(listener.diagnostic.owners.map(owner => owner.owningProcessId),
                [OBSERVER_EXPECTED_PID, 20_000, 20_001, 20_002]);
            assert.equal(listener.diagnostic.owners[0].expectedOwner, true);
        });

    it("keeps the widest retainable diagnostic inside the serialized byte bound",
        {skip: !POWERSHELL}, () => {
            // Widest producible record set: the record cap is the binding constraint and the byte bound is
            // the backstop, so this pins the relationship. Widening the schema fails here rather than
            // silently dropping owner records through the byte-truncation loop in a hosted run.
            const connections = [];
            const processObservations = {};
            for (let index = 0; index < MAXIMUM_LISTENER_DIAGNOSTIC_OWNERS; index += 1) {
                const owner = 4_294_967_295 - index;
                connections.push(listening(OBSERVER_PORT, owner));
                processObservations[owner] = {processState: "unavailable", creationFileTime: null,
                    jobMembership: "unavailable"};
            }
            const listener = observeListenerCore({connections, processObservations});
            assert.equal(listener.diagnostic.retainedOwnerCount, MAXIMUM_LISTENER_DIAGNOSTIC_OWNERS);
            assert.equal(listener.diagnostic.ownersTruncated, false);
            assert.ok(Buffer.byteLength(JSON.stringify(listener.diagnostic), "utf8")
                <= MAXIMUM_LISTENER_DIAGNOSTIC_BYTES,
            `widest retainable diagnostic must fit the byte bound: ${
                Buffer.byteLength(JSON.stringify(listener.diagnostic), "utf8")}`);
        });

    it("refuses malformed listener process observations instead of guessing ownership",
        {skip: !POWERSHELL}, () => {
            for (const observation of [
                {processState: "running", creationFileTime: null, jobMembership: "unavailable"},
                {processState: "present", creationFileTime: null, jobMembership: "unavailable"},
                {processState: "exited", creationFileTime: OBSERVER_EXPECTED_CREATION,
                    jobMembership: "unavailable"},
                {processState: "unavailable", creationFileTime: OBSERVER_EXPECTED_CREATION,
                    jobMembership: "unavailable"},
                {processState: "present", creationFileTime: OBSERVER_EXPECTED_CREATION, jobMembership: "maybe"},
                {processState: "present", creationFileTime: OBSERVER_EXPECTED_CREATION},
                {processState: "present", creationFileTime: "z".repeat(16), jobMembership: "in-job"},
                {processState: "present", creationFileTime: OBSERVER_EXPECTED_CREATION, jobMembership: "in-job",
                    extra: true}
            ])
                assert.throws(() => observeListenerCore({processObservations:
                    {[OBSERVER_EXPECTED_PID]: observation}}),
                /Listener process observation|Listener process state|Listener Job membership|Listener process creation time|Listener absent process observation/u);
            assert.throws(() => observeListenerCore({processObservations: {}}),
                /Injected listener process observation is absent/u);
        });

    it("keeps the absent listener contract free of diagnostics", {skip: !POWERSHELL}, () => {
        const absentRequest = {schemaVersion: 1, mode: "absent", address: "127.0.0.1", port: OBSERVER_PORT,
            candidatePid: OBSERVER_EXPECTED_PID, candidateCreationTime: OBSERVER_EXPECTED_CREATION};
        const gone = observeListenerCore({listenerRequest: absentRequest, connections: [],
            processObservations: {}});
        assert.deepEqual(Object.keys(gone), ["listenerGone"]);
        assert.equal(gone.listenerGone, true);
        const present = observeListenerCore({listenerRequest: absentRequest});
        assert.deepEqual(Object.keys(present), ["listenerGone"]);
        assert.equal(present.listenerGone, false);
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

    it("retries only recovery lock sharing violations within the captured bound", {skip: !POWERSHELL}, () => {
        const command = `. '${SCRIPT.replaceAll("'", "''")}' -Mode Library; `
            + "$global:events=[Collections.Generic.List[string]]::new();$global:attempt=0;$global:clockValue=0; "
            + "$open={ [void]$global:events.Add('open');$global:attempt++;if($global:attempt -lt 3){ "
            + "throw [Runtime.InteropServices.Marshal]::GetExceptionForHR([int]-2147024864)};return 'lock' }; "
            + "$elapsed={[int64]$global:clockValue};$delay={param([int]$Milliseconds) "
            + "[void]$global:events.Add(('delay-'+$Milliseconds));$global:clockValue+=$Milliseconds}; "
            + "$lock=Invoke-MyspeedStandaloneRecoveryLockCore 100 10 $open $elapsed $delay; "
            + "$success=[pscustomobject]@{lock=$lock;events=[string[]]$global:events}; "
            + "$global:events.Clear();$global:clockValue=100; "
            + "$deadline=$null;try{[void](Invoke-MyspeedStandaloneRecoveryLockCore 100 10 "
            + "{throw [Runtime.InteropServices.Marshal]::GetExceptionForHR([int]-2147024864)} $elapsed $delay)} "
            + "catch{$deadline=$_.Exception.Message}; "
            + "$unrelated=$null;try{[void](Invoke-MyspeedStandaloneRecoveryLockCore 100 10 "
            + "{throw [IO.IOException]::new('unrelated I/O')} {0} {param($Milliseconds)})} "
            + "catch{$unrelated=$_.Exception.Message}; "
            + "$invalidBounds=@();foreach($args in @(@(-1,10),@(100,0),@(100,-1))){try{ "
            + "[void](Invoke-MyspeedStandaloneRecoveryLockCore $args[0] $args[1] {'lock'} {0} {})} "
            + "catch{$invalidBounds+=$_.Exception.Message}}; "
            + "$global:events.Clear();function Enter-MyspeedStandaloneRecoveryLock { "
            + "[void]$global:events.Add('lock');throw 'injected lock stop' }; "
            + "function Get-MyspeedStandaloneAdapterSnapshot {[void]$global:events.Add('snapshot')}; "
            + "$beforeLock=$null;try{Restore-MyspeedStandaloneAdapters $null @() 'C:\\fixture\\lock'} "
            + "catch{$beforeLock=$_.Exception.Message}; "
            + "[pscustomobject]@{success=$success;deadline=$deadline;unrelated=$unrelated;invalidBounds=$invalidBounds; "
            + "beforeLock=$beforeLock;beforeLockEvents=[string[]]$global:events}|ConvertTo-Json -Depth 5 -Compress";
        const result = JSON.parse(execFileSync(POWERSHELL,
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
            {encoding: "utf8", timeout: TEST_TIMEOUT_MS, windowsHide: true}));
        assert.deepEqual(result.success, {lock: "lock", events: ["open", "delay-10", "open", "delay-10", "open"]});
        assert.match(result.deadline, /timed out/i);
        assert.equal(result.unrelated, "unrelated I/O");
        assert.deepEqual(result.invalidBounds, ["Standalone recovery lock timeout must be nonnegative",
            "Standalone recovery lock poll must be positive", "Standalone recovery lock poll must be positive"]);
        assert.equal(result.beforeLock, "injected lock stop");
        assert.deepEqual(result.beforeLockEvents, ["lock"]);
    });

    it("rechecks cancellation under the lock before emergency work", {skip: !POWERSHELL}, () => {
        const result = invoke("TestEmergencyRestoration", {cancelObservation: "cancelled", initialFailure: false,
            drainFails: false, restoreFailures: 0, writeFails: false, disposeFails: false, activeProcesses: 0});

        assert.deepEqual(result.outcome, {cancelled: true, emergencyRestore: false});
        assert.deepEqual(result.events, ["lock", "read-cancel", "active-processes", "dispose"]);
        assert.equal(result.failure, null);
    });

    it("restores after a drain failure but publishes no success", {skip: !POWERSHELL}, () => {
        const result = invoke("TestEmergencyRestoration", {cancelObservation: "absent", initialFailure: false,
            drainFails: true, restoreFailures: 0, writeFails: false, disposeFails: false, activeProcesses: 1});

        assert.deepEqual(result.events, ["lock", "read-cancel", "drain", "restore", "dispose"]);
        assert.equal(result.outcome, null);
        assert.equal(result.failure, "Injected emergency drain failed");
    });

    it("retries restoration once while retaining the original failure", {skip: !POWERSHELL}, () => {
        const result = invoke("TestEmergencyRestoration", {cancelObservation: "absent", initialFailure: false,
            drainFails: false, restoreFailures: 1, writeFails: false, disposeFails: false, activeProcesses: 1});

        assert.deepEqual(result.events,
            ["lock", "read-cancel", "drain", "restore", "restore", "dispose"]);
        assert.equal(result.outcome, null);
        assert.equal(result.failure, "Injected emergency restore failed");
    });

    it("keeps the first failure through cleanup and never works before locking", {skip: !POWERSHELL}, () => {
        const result = invoke("TestEmergencyRestoration", {cancelObservation: "absent", initialFailure: false,
            drainFails: true, restoreFailures: 2, writeFails: false, disposeFails: true, activeProcesses: 1});

        assert.equal(result.events[0], "lock");
        assert.ok(!result.events.includes("write-result"));
        assert.equal(result.failure, "Injected emergency drain failed");
    });

    it("requires Job zero on the late cancelled path and surfaces result-write failure", {skip: !POWERSHELL}, () => {
        const unsafeCancel = invoke("TestEmergencyRestoration", {cancelObservation: "cancelled", initialFailure: false,
            drainFails: false, restoreFailures: 0, writeFails: false, disposeFails: false, activeProcesses: 1});
        assert.equal(unsafeCancel.failure, "Standalone recovery cancel observed before Job zero");
        assert.ok(unsafeCancel.events.includes("drain"));
        assert.ok(unsafeCancel.events.includes("restore"));

        const writeFailure = invoke("TestEmergencyRestoration", {cancelObservation: "absent", initialFailure: false,
            drainFails: false, restoreFailures: 0, writeFails: true, disposeFails: false, activeProcesses: 1});
        assert.deepEqual(writeFailure.events,
            ["lock", "read-cancel", "drain", "restore", "write-result", "dispose"]);
        assert.equal(writeFailure.failure, "Injected emergency result write failed");
    });

    it("restores safely when the final cancel read or armed wait cannot be trusted", {skip: !POWERSHELL}, () => {
        for (const [cancelObservation, initialFailure, expected] of [
            ["throw", false, "Injected emergency cancel read failed"],
            ["invalid", false, "Standalone recovery cancellation observation must be Boolean"],
            ["absent", true, "Injected armed recovery wait failed"]
        ]) {
            const result = invoke("TestEmergencyRestoration", {cancelObservation, initialFailure,
                drainFails: false, restoreFailures: 0, writeFails: false, disposeFails: false,
                activeProcesses: 1});
            assert.equal(result.failure, expected);
            assert.ok(result.events.includes("drain"));
            assert.ok(result.events.includes("restore"));
            assert.ok(!result.events.includes("write-result"));
        }
    });

    it("passes captured lock bounds at both host-side acquisition sites", () => {
        const source = readFileSync(SCRIPT, "utf8");
        assert.match(source, /\$restore=\{[\s\S]*?Enter-MyspeedStandaloneRecoveryLock \$State\.request\.lockPath[\s`]+\$limits\.recoveryTimeoutMilliseconds \$limits\.recoveryPollMilliseconds/u);
        assert.match(source, /enterLock=\{return Enter-MyspeedStandaloneRecoveryLock \$req\.lockPath[\s`]+\$limits\.recoveryTimeoutMilliseconds \$limits\.recoveryPollMilliseconds\}/u);
        const restoration = source.slice(source.indexOf("function Invoke-MyspeedStandaloneRestoration"));
        assert.doesNotMatch(restoration, /while\([\s\S]*?return \[pscustomobject\]@\{cancelled=\$true/u,
            "the first cancel observation bypasses the authoritative under-lock reread");
        assert.match(restoration, /Read-MyspeedStandaloneRecoveryCancel[^\n]+\{\s*break\}/u);
        assert.match(restoration, /finally\{[\s\S]*?\$job\.Dispose\(\)[\s\S]*?if\(\$null -ne \$failure\)\{throw \$failure\}/u,
            "outer Job disposal failures must reach the common failure exit");
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
