import {describe, it} from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "qualification", "windows-clean-stop-controller.ps1");
const POWERSHELL = (process.env.SystemRoot || "C:\\Windows")
    + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const TEST_TIMEOUT_MS = 15_000;
const TEST_CASE_TIMEOUT_MS = 30_000;
const EXCLUSIVE_PUBLICATION_DEADLINE_MS = 2_000;
const RUN_ID = "12345";
const RUN_ATTEMPT = "2";
const EVENT_SHA = "a".repeat(40);
const SOURCE_SHA = "b".repeat(40);
const NONCE = "c".repeat(32);
const TASK_ROOT = "C:\\a\\_temp\\myspeed-clean-stop-" + NONCE;
const CANDIDATE = TASK_ROOT + "\\fixture-handler.exe";
const SHA256 = "d".repeat(64);
const MANIFEST_SHA256 = "9".repeat(64);
const ABI_SHA256 = "8".repeat(64);
const READY_SHA256 = "f".repeat(64);
const STDOUT_READINESS_SHA256 = "7".repeat(64);
const LIFECYCLE_PHASES = [
    "assertConsoleFree", "openCandidateAndJob", "createStandardHandles", "queryAttributeList",
    "initializeAttributeList", "updateHandleList", "launchSuspended", "assignJob", "captureIdentity",
    "resume", "writeReady", "awaitStdoutReadiness", "validateStdoutReadiness", "awaitStopRequest", "validateStopRequest", "attachConsole",
    "installIgnoreHandler", "revalidateHandle", "proveConsoleMembers", "generateCtrlC",
    "freeConsole", "proveConsoleFree", "waitCandidateExit", "proveJobZero", "closeResources"
];
const powershellAvailable = process.platform === "win32" && fs.existsSync(POWERSHELL);
const powershellIt = (name, body) => (powershellAvailable ? it : it.skip)(name,
    {timeout: TEST_CASE_TIMEOUT_MS}, body);
const cryptoSha256 = value => crypto.createHash("sha256").update(value).digest("hex");

const invoke = (mode, value = null) => {
    const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", SCRIPT, "-Mode", mode];
    if (value !== null) args.push("-InputJson", JSON.stringify(value));
    const result = childProcess.spawnSync(POWERSHELL, args, {encoding: "utf8", timeout: TEST_TIMEOUT_MS});
    assert.equal(result.error, undefined, result.error?.message);
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return JSON.parse(result.stdout);
};

const request = () => ({
    schemaVersion: 1,
    kind: "myspeed-windows-clean-stop-launch",
    expectedRunId: RUN_ID,
    expectedRunAttempt: RUN_ATTEMPT,
    expectedEventSha: EVENT_SHA,
    expectedSourceSha: SOURCE_SHA,
    expectedImageVersion: "20260907.229.1",
    nonce: NONCE,
    manifestSha256: MANIFEST_SHA256,
    caseId: "handler",
    taskRoot: TASK_ROOT,
    candidatePath: CANDIDATE,
    candidateSha256: SHA256,
    candidateVolumeSerial: "89abcdef",
    candidateFileId: "0123456789abcdef",
    workingDirectory: TASK_ROOT,
    arguments: ["handler"],
    environment: {
        MYSPEED_CLEAN_STOP_FIXTURE_MODE: "handler",
        MYSPEED_CLEAN_STOP_NONCE: NONCE
    },
    stdoutPath: TASK_ROOT + "\\stdout.log",
    stderrPath: TASK_ROOT + "\\stderr.log",
    abiPath: TASK_ROOT + "\\abi.json",
    readyPath: TASK_ROOT + "\\ready.json",
    stdoutReadinessPath: TASK_ROOT + "\\stdout.readiness.json",
    stopRequestPath: TASK_ROOT + "\\stop.request.json",
    resultPath: TASK_ROOT + "\\result.json",
    controllerNormalDeadlineMs: 300_000,
    controllerHardDeadlineMs: 310_000,
    stopRequestTimeoutMs: 240_000,
    stopRequestPollMs: 50,
    gracefulExitTimeoutMs: 30_000,
    forcedCleanupTimeoutMs: 10_000
});

const stopRequest = () => ({
    schemaVersion: 1,
    kind: "myspeed-windows-clean-stop-request",
    expectedRunId: RUN_ID,
    expectedRunAttempt: RUN_ATTEMPT,
    expectedEventSha: EVENT_SHA,
    nonce: NONCE,
    manifestSha256: MANIFEST_SHA256,
    launchRequestSha256: SHA256,
    abiSha256: ABI_SHA256,
    readySha256: READY_SHA256,
    stdoutReadinessSha256: STDOUT_READINESS_SHA256,
    caseId: "handler",
    candidatePid: 4242,
    candidateCreationTime: "0123456789abcdef",
    candidateImagePath: CANDIDATE,
    candidateSha256: SHA256,
    candidateVolumeSerial: "89abcdef",
    candidateFileId: "0123456789abcdef"
});

const stdoutReadiness = () => ({
    schemaVersion: 1,
    kind: "myspeed-windows-clean-stop-stdout-readiness",
    manifestSha256: MANIFEST_SHA256,
    caseId: "handler",
    launchRequestSha256: SHA256,
    abiSha256: ABI_SHA256,
    readySha256: READY_SHA256,
    stdoutSha256: "6".repeat(64),
    marker: "MYSPEED_CLEAN_STOP_FIXTURE_READY_V1",
    observedMonotonicMs: 20
});

const lifecycle = (failAt = null) => ({
    failAt,
    clock: Array.from({length: LIFECYCLE_PHASES.length}, (_, index) => index * 10),
    launch: {
        candidatePid: 4242,
        candidateCreationTime: "0123456789abcdef",
        candidateImagePath: CANDIDATE,
        candidateSha256: SHA256,
        candidateVolumeSerial: "89abcdef",
        candidateFileId: "0123456789abcdef"
    },
    stopRequest: stopRequest(),
    stopAvailable: true,
    candidateExitCode: 0,
    consoleProcessIds: [4000, 4242]
});

describe("Windows clean-stop controller prototype", () => {
    it("keeps the initial slice candidate-neutral and nonqualifying", () => {
        const source = fs.readFileSync(SCRIPT, "utf8");
        assert.match(source, /qualifying=\$false/u);
        assert.match(source, /CONTROLLER_NORMAL_DEADLINE_MS[^\r\n]+300000/u);
        assert.match(source, /CONTROLLER_HARD_DEADLINE_MS[^\r\n]+310000/u);
        assert.match(source, /STOP_REQUEST_TIMEOUT_MS[^\r\n]+240000/u);
        assert.match(source, /STOP_REQUEST_POLL_MS[^\r\n]+50/u);
        assert.doesNotMatch(source, /listenerGone|databasePassed/u);
    });

    powershellIt("is import-safe and returns fixed deadlines", () => {
        assert.deepEqual(invoke("GetContract"), {
            schemaVersion: 1,
            kind: "myspeed-windows-clean-stop-controller",
            qualifying: false,
            nativeExecuted: false,
            controllerNormalDeadlineMs: 300_000,
            controllerHardDeadlineMs: 310_000,
            stopRequestTimeoutMs: 240_000,
            stopRequestPollMs: 50,
            gracefulExitTimeoutMs: 30_000,
            forcedCleanupTimeoutMs: 10_000
        });
    });

    powershellIt("validates exact expected and observed x64 ABI measurements without native execution", () => {
        const contract = invoke("GetAbiContract");
        assert.equal(contract.schemaVersion, 1);
        assert.equal(contract.kind, "myspeed-windows-clean-stop-abi");
        assert.equal(contract.expected.pointerBytes, 8);
        assert.equal(contract.expected.startupInfoBytes, 104);
        assert.equal(contract.expected.startupInfoExBytes, 112);
        assert.equal(contract.expected.handleListCount, 3);
        assert.equal(contract.expected.handleListBytes, 24);
        assert.equal(contract.expected.processCreationFlags, 525_332);
        const good = {schemaVersion: 1, kind: contract.kind, expected: contract.expected,
            observed: structuredClone(contract.expected), matched: true};
        assert.equal(invoke("ValidateAbi", good).accepted, true);
        const mismatch = structuredClone(good);
        mismatch.observed.startupInfoBytes++;
        mismatch.matched = false;
        assert.equal(invoke("ValidateAbi", mismatch).accepted, true);
        mismatch.matched = true;
        assert.throws(() => invoke("ValidateAbi", mismatch), /ABI|matched/i);
        const malformed = structuredClone(good);
        malformed.observed.fileTimeBytes = "8";
        assert.throws(() => invoke("ValidateAbi", malformed), /ABI|integer/i);
    });

    powershellIt("strictly validates launch and stop contracts", () => {
        assert.equal(invoke("ValidateLaunchRequest", request()).accepted, true);
        assert.equal(invoke("ValidateStdoutReadiness", {launch: request(), launchRequestSha256: SHA256,
            abiSha256: ABI_SHA256, readySha256: READY_SHA256, readiness: stdoutReadiness()}).accepted, true);
        assert.equal(invoke("ValidateStopRequest", {launch: request(), launchRequestSha256: SHA256,
            abiSha256: ABI_SHA256, readySha256: READY_SHA256, stop: stopRequest()}).accepted, true);
        for (const mutate of [
            value => { value.extra = true; },
            value => { value.expectedRunId = 1; },
            value => { value.expectedEventSha += "\n"; },
            value => { value.nonce = ["c".repeat(32)]; },
            value => { value.caseId = "unknown"; },
            value => { value.arguments = ["ignore"]; },
            value => { value.taskRoot += "\\."; },
            value => { value.candidatePath = value.taskRoot + ":stream"; },
            value => { value.stdoutPath = value.stderrPath.toUpperCase(); },
            value => { value.arguments = "handler"; },
            value => { value.environment.EXTRA = "forbidden"; },
            value => { value.controllerNormalDeadlineMs = 299_999; },
            value => { value.controllerHardDeadlineMs = 310_001; },
            value => { value.stopRequestTimeoutMs = 240_001; },
            value => { value.stopRequestPollMs = 51; }
        ]) {
            const value = request();
            mutate(value);
            assert.throws(() => invoke("ValidateLaunchRequest", value),
                /request|path|deadline|environment|argument|integer/i);
        }
        for (const mutate of [
            value => { value.readiness.marker += "extra"; },
            value => { value.readiness.readySha256 = "0".repeat(64); },
            value => { value.readiness.observedMonotonicMs = 300_001; }
        ]) {
            const value = {launch: request(), launchRequestSha256: SHA256,
                abiSha256: ABI_SHA256, readySha256: READY_SHA256, readiness: stdoutReadiness()};
            mutate(value);
            assert.throws(() => invoke("ValidateStdoutReadiness", value), /stdout|readiness|binding|bound/i);
        }
        for (const mutate of [
            value => { value.stop.candidatePid = 0; },
            value => { value.stop.candidateCreationTime = "1"; },
            value => { value.stop.candidateImagePath = value.launch.stdoutPath; },
            value => { value.stop.candidateSha256 = "e".repeat(64); },
            value => { value.stop.expectedRunAttempt = "3"; }
        ]) {
            const value = {launch: request(), launchRequestSha256: SHA256,
                abiSha256: ABI_SHA256, readySha256: READY_SHA256, stop: stopRequest()};
            mutate(value);
            assert.throws(() => invoke("ValidateStopRequest", value), /stop|candidate|identity|binding/i);
        }
    });

    powershellIt("runs the injected retained-handle lifecycle in exact order", () => {
        const result = invoke("TestLifecycle", lifecycle());
        assert.equal(result.status, "completed");
        assert.equal(result.qualifying, false);
        assert.equal(result.controllerLifecyclePassed, true);
        assert.equal(result.controllerInitiallyConsoleFree, true);
        assert.equal(result.handlesClosed, true);
        assert.equal(result.forced, false);
        assert.deepEqual(result.events, LIFECYCLE_PHASES);
    });

    powershellIt("never signals after an injected pre-signal failure", () => {
        for (const phase of [
            "assertConsoleFree", "openCandidateAndJob", "createStandardHandles", "queryAttributeList",
            "initializeAttributeList", "updateHandleList", "launchSuspended", "assignJob", "captureIdentity", "resume",
            "writeReady", "awaitStopRequest", "validateStopRequest", "attachConsole",
            "awaitStdoutReadiness", "validateStdoutReadiness",
            "installIgnoreHandler", "revalidateHandle", "proveConsoleMembers"
        ]) {
            const result = invoke("TestLifecycle", lifecycle(phase));
            assert.equal(result.status, "failed", phase);
            assert.equal(result.controllerLifecyclePassed, false, phase);
            assert.equal(result.events.includes("generateCtrlC"), false, phase);
            if (phase === "assertConsoleFree") {
                assert.equal(result.controllerInitiallyConsoleFree, false);
                assert.equal(result.handlesClosed, false);
            }
        }
    });

    powershellIt("fails closed for every post-signal proof and malformed injected observation", () => {
        for (const phase of [
            "generateCtrlC", "freeConsole", "proveConsoleFree", "waitCandidateExit",
            "proveJobZero", "closeResources"
        ]) {
            const result = invoke("TestLifecycle", lifecycle(phase));
            assert.equal(result.status, "failed", phase);
            assert.equal(result.controllerLifecyclePassed, false, phase);
            assert.equal(result.forced, phase !== "closeResources", phase);
            assert.equal(result.jobActiveProcesses, 0, phase);
            if (phase === "closeResources") assert.equal(result.handlesClosed, false);
        }
        for (const mutate of [
            value => { value.clock[5] = value.clock[4] - 1; },
            value => { value.candidateExitCode = "0"; },
            value => { value.launch.candidatePid = "4242"; }
        ]) {
            const value = lifecycle();
            mutate(value);
            assert.throws(() => invoke("TestLifecycle", value), /injected|clock|integer|console|deadline/i);
        }
        for (const mutate of [
            value => { value.clock.fill(300_001, 4); },
            value => { value.consoleProcessIds = [4000, 4999]; },
            value => { value.consoleProcessIds = ["4000", 4242]; }
        ]) {
            const value = lifecycle();
            mutate(value);
            const result = invoke("TestLifecycle", value);
            assert.equal(result.status, "failed");
            assert.equal(result.controllerLifecyclePassed, false);
        }
    });

    powershellIt("classifies deadline cleanup truthfully", () => {
        const value = lifecycle("awaitStopRequest");
        value.clock.fill(300_000, 2);
        const result = invoke("TestLifecycle", value);
        assert.equal(result.status, "failed");
        assert.equal(result.qualifying, false);
        assert.equal(result.forced, true);
        assert.equal(result.candidateExited, true);
        assert.equal(result.exitCode, 197);
        assert.equal(result.jobActiveProcesses, 0);
        assert.match(result.failures[0], /stop request|deadline/i);

        const missing = lifecycle();
        missing.stopAvailable = false;
        missing.clock[3] = 240_020;
        missing.clock.fill(240_020, 3);
        const missingResult = invoke("TestLifecycle", missing);
        assert.equal(missingResult.status, "failed");
        assert.match(missingResult.failures[0], /stop request deadline/i);

        const lateStop = lifecycle();
        lateStop.clock[3] = 240_020;
        lateStop.clock.fill(240_020, 3);
        const lateStopResult = invoke("TestLifecycle", lateStop);
        assert.equal(lateStopResult.status, "failed");
        assert.equal(lateStopResult.events.includes("validateStopRequest"), false);
        assert.match(lateStopResult.failures[0], /stop request deadline/i);

        const validationCrossedDeadline = lifecycle();
        validationCrossedDeadline.clock[5] = 240_020;
        validationCrossedDeadline.clock.fill(240_020, 5);
        const validationDeadlineResult = invoke("TestLifecycle", validationCrossedDeadline);
        assert.equal(validationDeadlineResult.status, "failed");
        assert.equal(validationDeadlineResult.events.includes("attachConsole"), false);
        assert.equal(validationDeadlineResult.events.includes("generateCtrlC"), false);
        assert.match(validationDeadlineResult.failures.join(" "), /deadline expired during validation/i);

        const normalExpiredBeforeLaunch = lifecycle();
        normalExpiredBeforeLaunch.clock.fill(300_000);
        const preLaunchResult = invoke("TestLifecycle", normalExpiredBeforeLaunch);
        assert.equal(preLaunchResult.status, "failed");
        assert.equal(preLaunchResult.events.includes("openCandidateAndJob"), false);
        assert.equal(preLaunchResult.forced, false);
        assert.match(preLaunchResult.failures[0], /normal deadline expired before launch/i);

        const hardExpired = lifecycle();
        hardExpired.stopAvailable = false;
        hardExpired.clock.fill(310_001, 2);
        const hardResult = invoke("TestLifecycle", hardExpired);
        assert.equal(hardResult.status, "failed");
        assert.equal(hardResult.forced, false);
        assert.equal(hardResult.jobActiveProcesses, 1);
        assert.match(hardResult.failures.join(" "), /hard deadline|cleanup/i);

        const launchCrossedNormalDeadline = lifecycle();
        launchCrossedNormalDeadline.clock.fill(300_000, 1);
        const launchDeadlineResult = invoke("TestLifecycle", launchCrossedNormalDeadline);
        assert.equal(launchDeadlineResult.status, "failed");
        assert.equal(launchDeadlineResult.events.includes("writeReady"), false);
        assert.equal(launchDeadlineResult.forced, true);
        assert.match(launchDeadlineResult.failures.join(" "), /normal deadline expired after launch/i);

        const assignedFailure = invoke("TestLifecycle", lifecycle("captureIdentity"));
        assert.equal(assignedFailure.events.includes("terminateOwnedJob"), true);
        assert.equal(assignedFailure.events.includes("terminateRetainedProcess"), false);
        const unassignedFailure = invoke("TestLifecycle", lifecycle("assignJob"));
        assert.equal(unassignedFailure.events.includes("terminateRetainedProcess"), true);
        assert.equal(unassignedFailure.events.includes("waitRetainedProcess"), true);
        assert.equal(unassignedFailure.events.includes("terminateOwnedJob"), false);
        assert.equal(invoke("TestLifecycle", lifecycle("assertConsoleFree")).forced, false);
    });

    powershellIt("recomputes the exact nonqualifying result contract", () => {
        const result = {
            schemaVersion: 1,
            kind: "myspeed-windows-clean-stop-result",
            status: "completed",
            qualifying: false,
            controllerLifecyclePassed: true,
            forced: false,
            manifestSha256: MANIFEST_SHA256,
            caseId: "handler",
            requestSha256: SHA256,
            abiSha256: ABI_SHA256,
            readySha256: READY_SHA256,
            stdoutReadinessSha256: STDOUT_READINESS_SHA256,
            stopRequestSha256: "e".repeat(64),
            stdoutReadinessObserved: true,
            stopRequestObserved: true,
            stopRequestDeadlineMs: 240_020,
            graceExpired: false,
            observedConsoleProcessIds: [4000, 4242],
            lifecycleEvents: LIFECYCLE_PHASES,
            runId: RUN_ID,
            runAttempt: RUN_ATTEMPT,
            eventSha: EVENT_SHA,
            sourceSha: SOURCE_SHA,
            imageVersion: "20260907.229.1",
            nonce: NONCE,
            controllerPid: 4000,
            candidatePid: 4242,
            candidateCreationTime: "0123456789abcdef",
            candidateImagePath: CANDIDATE,
            candidateSha256: SHA256,
            candidateVolumeSerial: "89abcdef",
            candidateFileId: "0123456789abcdef",
            initialConsoleProcessIds: [4000],
            initialConsoleError: 0,
            initialConsoleDetached: true,
            controllerInitiallyConsoleFree: true,
            candidateCreatedSuspended: true,
            privateConsoleRequested: true,
            handleListConfigured: true,
            jobAssignedBeforeResume: true,
            initialJobMembership: true,
            candidateIdentityCaptured: true,
            candidateResumed: true,
            threadHandleClosedBeforeReady: true,
            preAttachIdentityMatch: true,
            postAttachHandleUnsignaled: true,
            postAttachIdentityMatch: true,
            postAttachJobMembership: true,
            consoleProcessIdsExact: true,
            ctrlEventGenerated: true,
            candidateExited: true,
            exitCode: 0,
            jobActiveProcesses: 0,
            consoleFreeAfter: true,
            handlesClosed: true,
            elapsedMs: 12_345,
            failures: [],
            releaseGatesCleared: []
        };
        assert.equal(invoke("ValidateResult", result).accepted, true);
        for (const mutate of [
            value => { value.qualifying = true; },
            value => { value.forced = true; },
            value => { value.exitCode = 197; },
            value => { value.observedConsoleProcessIds = [4000, 4242, 4242]; },
            value => { value.postAttachIdentityMatch = false; },
            value => { value.jobActiveProcesses = 1; },
            value => { value.elapsedMs = 300_001; },
            value => { value.elapsedMs = 310_001; },
            value => { value.failures = ["synthetic"]; },
            value => { value.controllerLifecyclePassed = false; },
            value => { value.initialConsoleProcessIds = [4242]; },
            value => { value.initialConsoleDetached = false; },
            value => { value.initialConsoleError = 6; }
        ]) {
            const value = structuredClone(result);
            mutate(value);
            assert.throws(() => invoke("ValidateResult", value), /result|lifecycle|qualifying|elapsed|console/i);
        }

        const failed = structuredClone(result);
        Object.assign(failed, {
            status: "failed",
            controllerLifecyclePassed: false,
            forced: true,
            handlesClosed: false,
            stopRequestSha256: null,
            stopRequestObserved: false,
            readySha256: null,
            candidatePid: null,
            candidateCreationTime: null,
            candidateImagePath: null,
            candidateVolumeSerial: null,
            candidateFileId: null,
            graceExpired: null,
            observedConsoleProcessIds: null,
            controllerInitiallyConsoleFree: true,
            candidateCreatedSuspended: false,
            privateConsoleRequested: false,
            handleListConfigured: false,
            jobAssignedBeforeResume: false,
            initialJobMembership: false,
            candidateIdentityCaptured: false,
            candidateResumed: false,
            threadHandleClosedBeforeReady: false,
            preAttachIdentityMatch: false,
            postAttachHandleUnsignaled: false,
            postAttachIdentityMatch: false,
            postAttachJobMembership: false,
            consoleProcessIdsExact: false,
            ctrlEventGenerated: false,
            candidateExited: false,
            exitCode: null,
            jobActiveProcesses: null,
            consoleFreeAfter: false,
            failures: ["stop request deadline expired"]
        });
        assert.equal(invoke("ValidateResult", failed).accepted, true);
        const malformedFailed = structuredClone(failed);
        malformedFailed.postAttachIdentityMatch = "false";
        assert.throws(() => invoke("ValidateResult", malformedFailed), /Boolean|result/i);

        const boundary = structuredClone(result);
        boundary.elapsedMs = 300_000;
        assert.equal(invoke("ValidateResult", boundary).accepted, true);
        const alreadyConsoleFree = structuredClone(result);
        Object.assign(alreadyConsoleFree, {
            initialConsoleProcessIds: [], initialConsoleError: 6, initialConsoleDetached: false
        });
        assert.equal(invoke("ValidateResult", alreadyConsoleFree).accepted, true);
    });

    powershellIt("allows only already-free or exact sole-self console initialization", () => {
        const input = (processIds, error, detachResult = null, consoleFreeAfter = null) => ({
            currentPid: 4000,
            observation: {processIds, error},
            observeFailure: false,
            detachResult,
            consoleFreeAfter
        });
        assert.deepEqual(invoke("TestInitialConsole", input([], 6)), {
            initialConsoleProcessIds: [], initialConsoleError: 6,
            initialConsoleDetached: false, consoleFreeAfter: true
        });
        assert.deepEqual(invoke("TestInitialConsole", input([4000], 0, true, true)), {
            initialConsoleProcessIds: [4000], initialConsoleError: 0,
            initialConsoleDetached: true, consoleFreeAfter: true
        });
        for (const invalid of [
            input([], 0), input([4000], 5, true, true), input([4242], 0, true, true),
            input([4000, 4000], 0, true, true), input([4000, 4242], 0, true, true),
            input(Array.from({length: 65}, () => 4000), 0, true, true),
            input([[4000]], 0, true, true), input(["4000"], 0, true, true), input([4000], 0, false, true),
            input([4000], 0, true, false), {...input([4000], 0, true, true), observeFailure: true}
        ]) assert.throws(() => invoke("TestInitialConsole", invalid), /console|detach|process/i);
    });

    powershellIt("emits deterministic inert fixture source", () => {
        const fixture = invoke("GetFixtureSource");
        assert.deepEqual(fixture.modes, ["handler", "ignore", "extra-participant"]);
        assert.equal(fixture.readyMarker, "MYSPEED_CLEAN_STOP_FIXTURE_READY_V1");
        assert.match(fixture.source, /Console\.CancelKeyPress/u);
        assert.match(fixture.source, /Process\.Start/u);
        assert.match(fixture.source, /participant==null\|\|participant\.HasExited/u);
        assert.match(fixture.source, /Console\.Out\.WriteLine\("MYSPEED_CLEAN_STOP_FIXTURE_READY_V1"\)/u);
        assert.match(fixture.source, /Console\.Out\.Flush\(\)/u);
        assert.match(fixture.source, /Environment\.Exit\(0\)/u);
        assert.doesNotMatch(fixture.source, /Socket|Http|WebRequest|TcpClient|UdpClient/u);
    });

    it("pins x64 ABI, handle-list, Job, and Ctrl+C mechanics", () => {
        const source = fs.readFileSync(SCRIPT, "utf8");
        assert.match(source, /launch=\{[\s\S]*?\$environment=\[Collections\.Generic\.Dictionary\[string,string\]\]::new\(\[StringComparer\]::Ordinal\)[\s\S]*?\$environment\.Add\(\$property\.Name,\[string\]\$property\.Value\)[\s\S]*?Session\]::Launch\([^\r\n]+\$environment,/u,
            "the native Launch IDictionary parameter must receive the exact generic dictionary type");
        for (const token of [
            "STARTUPINFOEXW", "PROC_THREAD_ATTRIBUTE_HANDLE_LIST", "UpdateProcThreadAttribute",
            "CREATE_SUSPENDED", "CREATE_NEW_CONSOLE", "CREATE_UNICODE_ENVIRONMENT",
            "EXTENDED_STARTUPINFO_PRESENT", "STARTF_USESTDHANDLES", "STARTF_USESHOWWINDOW",
            "AssignProcessToJobObject", "IsProcessInJob", "GetProcessTimes",
            "QueryFullProcessImageNameW", "GetConsoleProcessList", "AttachConsole",
            "GetCurrentProcessId", "SetConsoleCtrlHandler", "GenerateConsoleCtrlEvent", "CTRL_C_EVENT", "FreeConsole",
            "TerminateJobObject", "QueryInformationJobObject"
        ]) assert.match(source, new RegExp(token), token);
        assert.match(source, /SetLastError\(0\);uint n=GetConsoleProcessList[\s\S]*int error=Marshal\.GetLastWin32Error\(\)/,
            "console-free observation must not consume stale thread last-error state");
        assert.match(source, /Controller must be console-free: count="\+n\+"; error="\+error/,
            "a hosted failure must retain the exact console observation");
        assert.match(source, /MAX_INITIAL_CONSOLE_PROCESSES\s*=\s*64/u);
        assert.match(source, /public static ConsoleObservation ObserveInitialConsole/u);
        assert.match(source, /public static bool DetachInitialConsole\(\)[\s\S]*FreeConsole/u);
        assert.match(source, /CurrentProcessId\(\)[\s\S]*nativeCurrentPid -ne \[int64\]\$PID[\s\S]*Invoke-MyspeedCleanInitialConsoleCore/u);
        assert.match(source, /Marshal\.SizeOf\(typeof\(STARTUPINFOW\)\)\s*!=\s*104/u);
        assert.match(source, /Marshal\.SizeOf\(typeof\(STARTUPINFOEXW\)\)\s*!=\s*112/u);
        for (const [type, bytes] of [
            ["PROCESS_INFORMATION", 24], ["SECURITY_ATTRIBUTES", 24], ["FILETIME", 8],
            ["IO_COUNTERS", 48], ["BASIC_LIMIT", 64], ["EXTENDED_LIMIT", 144],
            ["ACCOUNTING", 48], ["BY_HANDLE_FILE_INFORMATION", 52]
        ]) assert.match(source, new RegExp(`Marshal\\.SizeOf\\(typeof\\(${type}\\)\\)\\s*!=\\s*${bytes}`), type);
        for (const [type, field, offset] of [
            ["STARTUPINFOW", "cb", 0], ["STARTUPINFOW", "lpReserved", 8],
            ["STARTUPINFOW", "lpDesktop", 16], ["STARTUPINFOW", "lpTitle", 24],
            ["STARTUPINFOW", "dwX", 32], ["STARTUPINFOW", "dwY", 36],
            ["STARTUPINFOW", "dwXSize", 40], ["STARTUPINFOW", "dwYSize", 44],
            ["STARTUPINFOW", "dwXCountChars", 48], ["STARTUPINFOW", "dwYCountChars", 52],
            ["STARTUPINFOW", "dwFillAttribute", 56], ["STARTUPINFOW", "dwFlags", 60],
            ["STARTUPINFOW", "wShowWindow", 64], ["STARTUPINFOW", "cbReserved2", 66],
            ["STARTUPINFOW", "lpReserved2", 72],
            ["STARTUPINFOW", "hStdInput", 80], ["STARTUPINFOW", "hStdOutput", 88],
            ["STARTUPINFOW", "hStdError", 96], ["STARTUPINFOEXW", "lpAttributeList", 104],
            ["FILETIME", "Low", 0], ["FILETIME", "High", 4],
            ["ACCOUNTING", "active", 40], ["BASIC_LIMIT", "flags", 16],
            ["BASIC_LIMIT", "min", 24], ["BASIC_LIMIT", "active", 40],
            ["BASIC_LIMIT", "affinity", 48], ["EXTENDED_LIMIT", "io", 64],
            ["EXTENDED_LIMIT", "processMemory", 112]
        ]) assert.match(source, new RegExp(`Marshal\\.OffsetOf\\(typeof\\(${type}\\),"${field}"\\)\\.ToInt32\\(\\)!=${offset}`), `${type}.${field}`);
        assert.match(source, /IntPtr\.Size\*3!=24/u);
        assert.doesNotMatch(source, /CREATE_NO_WINDOW|CREATE_NEW_PROCESS_GROUP/u);
        assert.match(source, /ERROR_INSUFFICIENT_BUFFER\s*=\s*122/u);
        assert.match(source, /CREATE_NEW\s*=\s*1/u);
        assert.doesNotMatch(source, /OPEN_ALWAYS/u);
        assert.match(source, /attributeListInitialized/u);
        assert.match(source, /if\s*\(attributeListInitialized\)\s*DeleteProcThreadAttributeList/u);
        assert.match(source, /ReleaseLaunchLocals\(ref pi\.hThread[\s\S]*s\.ThreadHandleClosedBeforeReady=true/u);
        assert.match(source, /public void Dispose\(\)\{if\(!CloseAndProve\(\)\)throw/u);
        assert.match(source, /if\s*\(!assigned\)[\s\S]*TerminateProcess\(pi\.hProcess/u);
        assert.match(source, /else[\s\S]*TerminateJobObject\(s\.job/u);
        assert.match(source, /WaitForSingleObject\(pi\.hProcess,cleanupTimeout\)/u);
        assert.match(source, /ObserveExitedResult\(true\)/u);
        assert.match(source, /GetExitCodeProcess\(process,out code\)/u);
        assert.match(source, /AssertLaunchBudget\(launchWatch,normalRemaining,hardRemaining\)[\s\S]*ResumeThread/u);
        assert.match(source, /WaitForSingleObject\(process,RemainingBudget\(grace,stopWatch\)\)/u);
        assert.match(source, /r\.jobZero=r\.candidateExited&&WaitForJobZero\(grace,stopWatch\)/u);
        assert.match(source,
            /WaitForJobZero\(uint budget,Stopwatch watch\)\{while\(true\)\{uint active=Active\(job\);long elapsed=watch\.ElapsedMilliseconds;if\(elapsed>=budget\)return false;if\(active==0\)return true;long remaining=\(long\)budget-elapsed;[\s\S]*NATIVE_CLEANUP_POLL_MS/u,
            "Job-zero proof must sample the shared grace clock after every accounting observation");
        assert.match(source, /ReleaseLaunchLocals\(ref pi\.hThread[\s\S]*ThreadHandleClosedBeforeReady=true/u);
        assert.match(source, /controllerInitiallyConsoleFree=\$state\.controllerInitiallyConsoleFree/u);
        assert.match(source, /FileAttributes\]::ReparsePoint/u);
        assert.match(source, /Invoke-MyspeedCleanInitialConsoleCore[\s\S]*\[MySpeed\.Qualification\.CleanStop\.Session\]::ObserveAbi\(\)/u);
        assert.match(source, /assertConsoleFree=\{\[MySpeed\.Qualification\.CleanStop\.Session\]::AssertConsoleFree\(\)\}/u,
            "post-initialization lifecycle checks remain strict and do not auto-detach");
        assert.match(source, /\$state=Invoke-MyspeedCleanLifecycleCore \$request \$loaded\.sha256 \$abiSha \$operations/u);
        assert.match(source, /\$state=Invoke-MyspeedCleanLifecycleCore \$launchRequest \('d'\*64\) \('8'\*64\) \$operations/u);
        assert.match(source, /Assert-MyspeedCleanPhysicalLaunchPaths \$request[\s\S]*?entryDiagnosticPath[\s\S]*?try\{[\s\S]*?Add-Type[\s\S]*?Write-MyspeedCleanEntryFailure/u);
        assert.match(source, /SharingViolationWin32Code\s*=\s*32/u);
        assert.match(source, /Read-MyspeedCleanBoundedJsonUntilStable[\s\S]*Test-MyspeedCleanSharingViolation/u);
        assert.match(source, /if\(\$Mode -ceq 'InvokeHostedController'\)\{\[void\]\$output\}else\{\$output\|ConvertTo-Json/u,
            "the console-free hosted process must not publish its successful result to an absent stdout handle");
        assert.match(source, /readStdoutReadiness=\{param\(\$deadline\)[\s\S]*?\$readStable/u);
        assert.match(source, /readStop=\{param\(\$deadline\)[\s\S]*?\$readStable/u);
        assert.match(source, /public static CandidateFileIdentity InspectCandidate/u);
        assert.match(source, /new FileStream\(canonical,FileMode\.Open,FileAccess\.Read,FileShare\.Read\)/u);
        assert.match(source, /GetFileInformationByHandle\(stream\.SafeFileHandle\.DangerousGetHandle\(\),out info\)/u);
        assert.match(source, /GetFinalPathNameByHandle\(h,b,\(uint\)b\.Capacity,0\)/u);
        assert.match(source, /algorithm\.ComputeHash\(stream\)/u);
        assert.match(source, /stream\.Length!=before\|\|stream\.Position!=before/u);
    });

    powershellIt("binds the exact launch environment to generic IDictionary", () => {
        const command = "$value=[pscustomobject]@{A='';B='two'};" +
            "$environment=[Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal);" +
            "foreach($property in $value.PSObject.Properties){$environment.Add($property.Name,[string]$property.Value)};" +
            "function Read-Environment([Collections.Generic.IDictionary[string,string]]$env){$env['A'].Length.ToString()+'|'+$env['B']};" +
            "[Console]::Out.Write((Read-Environment $environment))";
        const result = childProcess.spawnSync(POWERSHELL,
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
            {encoding: "utf8", timeout: TEST_TIMEOUT_MS});
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, "0|two");
    });

    powershellIt("does not write the successful hosted result to an absent outer stdout handle", () => {
        const command = String.raw`
$ErrorActionPreference='Stop'
$PSModuleAutoloadingPreference='None'
. $env:MYSPEED_CONTROLLER_SCRIPT -Mode Library
function Invoke-MyspeedHostedCleanStopController {
  param($RequestPath,$RequestSha,$RunId,$RunAttempt,$EventSha,$SourceSha,$ImageVersion,$ExpectedNonce)
  [pscustomobject]@{status='completed';controllerLifecyclePassed=$true}
}
$tokens=$null;$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:MYSPEED_CONTROLLER_SCRIPT,[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count -ne 0){throw 'Controller parse failed'}
$dispatcher=@($ast.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.TryStatementAst]})[-1]
if($null -eq $dispatcher){throw 'Controller dispatcher was not found'}
$Mode='InvokeHostedController';$LaunchRequestPath='x';$ExpectedLaunchRequestSha256='a';$ExpectedRunId='1'
$ExpectedRunAttempt='1';$ExpectedEventSha='b';$ExpectedSourceSha='c';$ExpectedImageVersion='d';$Nonce='e'
$captured=@(& ([scriptblock]::Create($dispatcher.Extent.Text)))
if($captured.Count -ne 0){throw 'Hosted dispatcher wrote pipeline output'}
[Console]::Out.Write('PASS')`;
        const result = childProcess.spawnSync(POWERSHELL,
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
            {encoding: "utf8", timeout: TEST_TIMEOUT_MS, env: {...process.env, MYSPEED_CONTROLLER_SCRIPT: SCRIPT}});
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.equal(result.stdout, "PASS");
    });

    powershellIt("writes a bounded create-new diagnostic for failures after physical request validation", () => {
        const tempResult = childProcess.spawnSync(POWERSHELL,
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
                "[Console]::Out.Write([IO.Path]::GetFullPath([IO.Path]::GetTempPath()))"],
            {encoding: "utf8", timeout: TEST_TIMEOUT_MS});
        assert.equal(tempResult.status, 0, tempResult.stderr);
        const directory = fs.mkdtempSync(path.join(tempResult.stdout, "myspeed-clean-entry-"));
        const diagnosticPath = path.join(directory, "entry.json");
        try {
            const message = "x".repeat(700);
            const result = invoke("TestEntryFailure", {path: diagnosticPath, message});
            assert.equal(result.kind, "myspeed-windows-clean-stop-controller-entry-failure");
            assert.equal(result.messageBytes, 700);
            assert.equal(Buffer.from(result.messagePrefixBase64, "base64").length, 512);
            assert.deepEqual(JSON.parse(fs.readFileSync(diagnosticPath, "utf8")), result);
            assert.throws(() => invoke("TestEntryFailure", {path: diagnosticPath, message}));
        } finally { fs.rmSync(directory, {recursive: true, force: true}); }
    });

    powershellIt("waits only for an in-progress exclusive JSON publication", () => {
        const command = [
            ". $env:MYSPEED_SCRIPT -Mode Library;",
            "function New-ReadFixture { param($reader,$path,$sha,$deadline,$stream,$elapsed,$release);",
            "$state=[pscustomobject]@{elapsed=[int64]$elapsed;sleepCalls=0;stream=$stream;release=[bool]$release};",
            "$operations=[pscustomobject]@{elapsed={return $state.elapsed}.GetNewClosure();",
            "sleep={param($milliseconds)$state.sleepCalls++;if($state.release -and $null -ne $state.stream){$state.stream.Dispose();$state.stream=$null};$state.elapsed+=$milliseconds}.GetNewClosure()};",
            "$callback={return & $reader $path $sha $deadline $operations}.GetNewClosure();",
            "return [pscustomobject]@{callback=$callback;state=$state}};",
            "$directory=[IO.Directory]::CreateDirectory($env:MYSPEED_JSON_DIRECTORY).FullName;",
            "$json='{" + '"schemaVersion":1,"status":"ready"' + "}';$bytes=[Text.UTF8Encoding]::new($false).GetBytes($json);",
            "$sha=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($bytes)).Replace('-','').ToLowerInvariant();",
            "$reader=${function:Read-MyspeedCleanBoundedJsonUntilStable};",
            "$positivePath=[IO.Path]::Combine($directory,'positive.json');",
            "$positiveStream=[IO.File]::Open($positivePath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);",
            "$positiveStream.Write($bytes,0,$bytes.Length);$positiveStream.Flush($true);",
            "$positive=New-ReadFixture $reader $positivePath $sha $env:MYSPEED_JSON_DEADLINE $positiveStream 0 $true;",
            "$loaded=& $positive.callback;",
            "$deadlinePath=[IO.Path]::Combine($directory,'deadline.json');",
            "$deadlineStream=[IO.File]::Open($deadlinePath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);",
            "$deadlineStream.Write($bytes,0,$bytes.Length);$deadlineStream.Flush($true);",
            "$deadline=New-ReadFixture $reader $deadlinePath $sha $env:MYSPEED_JSON_DEADLINE $deadlineStream $env:MYSPEED_JSON_DEADLINE $false;",
            "$deadlineRejected=$false;try{& $deadline.callback}catch{$deadlineRejected=$_.Exception.Message -match 'deadline'}finally{$deadlineStream.Dispose()};",
            "$hashPath=[IO.Path]::Combine($directory,'hash.json');[IO.File]::WriteAllBytes($hashPath,$bytes);",
            "$hash=New-ReadFixture $reader $hashPath ('0'*64) $env:MYSPEED_JSON_DEADLINE $null 0 $false;",
            "$hashRejected=$false;try{& $hash.callback}catch{$hashRejected=$_.Exception.Message -match 'SHA differs'};",
            "$malformedPath=[IO.Path]::Combine($directory,'malformed.json');[IO.File]::WriteAllText($malformedPath,'{]',[Text.UTF8Encoding]::new($false));",
            "$malformed=New-ReadFixture $reader $malformedPath '' $env:MYSPEED_JSON_DEADLINE $null 0 $false;",
            "$malformedRejected=$false;try{& $malformed.callback}catch{$malformedRejected=$true};",
            "$crossed=New-ReadFixture $reader $hashPath $sha $env:MYSPEED_JSON_DEADLINE $null $env:MYSPEED_JSON_DEADLINE $false;",
            "$crossedRejected=$false;try{$null=& $crossed.callback}catch{$crossedRejected=$_.Exception.Message -match 'deadline'};",
            "[pscustomobject]@{status=$loaded.value.status;sha256=$loaded.sha256;positiveSleeps=$positive.state.sleepCalls;",
            "deadlineRejected=$deadlineRejected;deadlineSleeps=$deadline.state.sleepCalls;hashRejected=$hashRejected;hashSleeps=$hash.state.sleepCalls;",
            "malformedRejected=$malformedRejected;malformedSleeps=$malformed.state.sleepCalls;crossedRejected=$crossedRejected;crossedSleeps=$crossed.state.sleepCalls}|ConvertTo-Json -Compress"
        ].join("");
        const directory = fs.mkdtempSync(path.join(process.env.TEMP, "myspeed-clean-json-"));
        try {
            const result = childProcess.spawnSync(POWERSHELL,
                ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
                    encoding: "utf8", timeout: TEST_TIMEOUT_MS,
                    env: {...process.env, MYSPEED_SCRIPT: SCRIPT, MYSPEED_JSON_DIRECTORY: directory,
                        MYSPEED_JSON_DEADLINE: String(EXCLUSIVE_PUBLICATION_DEADLINE_MS)}
                });
            assert.equal(result.status, 0, result.stderr);
            assert.deepEqual(JSON.parse(result.stdout), {
                status: "ready", sha256: cryptoSha256('{"schemaVersion":1,"status":"ready"}'), positiveSleeps: 1,
                deadlineRejected: true, deadlineSleeps: 0, hashRejected: true, hashSleeps: 0,
                malformedRejected: true, malformedSleeps: 0, crossedRejected: true, crossedSleeps: 0
            });
        } finally {
            fs.rmSync(directory, {recursive: true, force: true});
        }
    });

    powershellIt("rejects the native entry locally before native code", () => {
        const result = childProcess.spawnSync(POWERSHELL, [
            "-NoLogo", "-NoProfile", "-NonInteractive", "-File", SCRIPT,
            "-Mode", "InvokeHostedController",
            "-LaunchRequestPath", path.join(process.env.TEMP, "missing-clean-stop-request.json"),
            "-ExpectedLaunchRequestSha256", SHA256,
            "-ExpectedRunId", RUN_ID,
            "-ExpectedRunAttempt", RUN_ATTEMPT,
            "-ExpectedEventSha", EVENT_SHA,
            "-ExpectedSourceSha", SOURCE_SHA,
            "-ExpectedImageVersion", "20260907.229.1",
            "-Nonce", NONCE
        ], {encoding: "utf8", timeout: TEST_TIMEOUT_MS});
        assert.equal(result.error, undefined, result.error?.message);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /hosted context/i);
        assert.doesNotMatch(result.stderr, /Launch request path|Add-Type/i);
    });
});
