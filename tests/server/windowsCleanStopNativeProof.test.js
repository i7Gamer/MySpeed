import {describe, it} from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "qualification", "windows-clean-stop-native-proof.ps1");
const POWERSHELL = (process.env.SystemRoot || "C:\\Windows")
    + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const TEST_TIMEOUT_MS = 30_000;
const powershellAvailable = process.platform === "win32" && fs.existsSync(POWERSHELL);
const powershellIt = (name, body) => (powershellAvailable ? it : it.skip)(name,
    {timeout: TEST_TIMEOUT_MS}, body);
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const sealJson = value => {
    const bytes = Buffer.from(JSON.stringify(value), "utf8");
    return {bytesBase64: bytes.toString("base64"), sha256: sha(bytes)};
};
const mutateDocument = (document, mutate) => {
    const value = JSON.parse(Buffer.from(document.bytesBase64, "base64").toString("utf8"));
    mutate(value);
    return sealJson(value);
};
const RUN_ID = "12345";
const RUN_ATTEMPT = "2";
const EVENT_SHA = "a".repeat(40);
const SOURCE_SHA = "b".repeat(40);
const NONCE = "c".repeat(32);
const MANIFEST_SHA = "9".repeat(64);
const ABI_SHA = "8".repeat(64);
const REQUEST_SHA = "d".repeat(64);
const READY_SHA = "f".repeat(64);
const READINESS_SHA = "7".repeat(64);
const STOP_SHA = "e".repeat(64);
const STDOUT = Buffer.from("MYSPEED_CLEAN_STOP_FIXTURE_READY_V1\r\n", "utf8");
const STDOUT_SHA = sha(STDOUT);
const TASK_ROOT = "C:\\a\\_temp\\myspeed-clean-stop-" + NONCE;
const CANDIDATE = TASK_ROOT + "\\fixture.exe";
const CASE_IDS = ["handler", "ignore", "extra-participant", "missing-stop"];
const TRANSPORT_NAMES = ["windows-clean-stop-native-proof.yml", "windows-clean-stop-controller.ps1",
    "windows-clean-stop-native-proof.ps1", "media-job-launcher.ps1", "windows-cpu-tool-child.ps1",
    "windows-cpu-file-identity.ps1", "windows-clean-stop-fixture.cs"];
const FILE_ROLES = ["workflow", "controller", "coordinator", "outer-launcher", "tool-child", "file-identity", "fixture-source",
    "inbox-powershell", "compiler", "mscorlib", "system", "system-core", "fixture-binary"];
const OBSERVER_SHA = "60f7438dd70f21f9d11f656eca61cd915392efb6237549fd57f0cfda5f6a0a1c";

const transport = () => ({schemaVersion: 1, kind: "myspeed-windows-clean-stop-transport-closure",
    qualifying: false, repository: "i7Gamer/MySpeed", runId: RUN_ID, runAttempt: RUN_ATTEMPT,
    eventSha: EVENT_SHA, sourceSha: SOURCE_SHA, imageOS: "win25-vs2026", imageVersion: "20260907.229.1",
    architecture: "X64", nonce: NONCE,
    files: TRANSPORT_NAMES.map((name, index) => ({name, bytes: index + 1,
        sha256: name === "windows-cpu-tool-child.ps1"
            ? "51febe43711a3bcf9f2527493496eafc268abc187393f2512bb48c3fab6a6711"
            : name === "windows-cpu-file-identity.ps1"
                ? "4e1f39d98f08606ac53f314d105e918e0b1080c5363ce23e16ae50ab3ac5265f"
                : index.toString(16).repeat(64).slice(0, 64)}))});

const inventoryNames = () => {
    const names = [...TRANSPORT_NAMES, "closure.json"].map(name => `closure/${name}`);
    for (const name of ["compile-clean-stop-fixture.request.json", "compile-clean-stop-fixture.result.json",
        "windows-clean-stop-fixture.exe", "compile-launcher.json", "compiler.stdout", "compiler.stderr"])
        names.push(`compiler/${name}`);
    names.push("evidence/execution-manifest.json", "evidence/summary.json");
    for (const caseId of CASE_IDS) {
        const leaves = ["fixture.exe", "launch.request.json", "abi.json", "ready.json", "stdout-readiness.json",
            "result.json", "outer-launcher.json", "stdout.log", "stderr.log"];
        if (caseId !== "missing-stop") leaves.push("stop.request.json");
        names.push(...leaves.map(leaf => `${caseId}/${leaf}`));
    }
    return names;
};

const inventory = () => ({schemaVersion: 1, kind: "myspeed-windows-clean-stop-evidence-inventory",
    qualifying: false, releaseGatesCleared: [], files: inventoryNames().map((name, index) => ({name,
        path: `C:\\a\\_temp\\proof\\${name.replaceAll("/", "\\")}`, bytes: index % 7,
        sha256: index.toString(16).repeat(64).slice(0, 64)}))});

const compilerOperation = () => {
    const root = `C:\\a\\_temp\\myspeed-cpu-readiness-${NONCE}`;
    const request = {schemaVersion: 1, expectedRunId: RUN_ID, expectedRunAttempt: RUN_ATTEMPT,
        expectedEventSha: EVENT_SHA, expectedSourceSha: SOURCE_SHA, nonce: NONCE,
        operationId: "compile-clean-stop-fixture", toolPath: "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
        toolSha256: "1".repeat(64), arguments: ["/noconfig", "/target:exe"], workingDirectory: root,
        streamLimitBytes: 65_536, maximumDurationMilliseconds: 30_000, isProbe: false,
        resultPath: `${root}\\compile-clean-stop-fixture.result.json`};
    const requestSha256 = "2".repeat(64);
    const bindings = {...request, requestPath: `${root}\\compile-clean-stop-fixture.request.json`, requestSha256,
        toolSha256Before: request.toolSha256, toolSha256After: request.toolSha256};
    delete bindings.schemaVersion;
    return {request, requestSha256,
        launcher: {schemaVersion: 1, authorizesTransfer: false, processId: 12, exitCode: 0,
            timedOut: false, processTreeExitProven: true},
        result: {schemaVersion: 1, status: "completed", classification: "windows-native-host-observation-nonqualifying",
            bindings, parentJobMembershipProven: true, childExitProven: true, handlesClosedProven: true,
            errorMode: {required: false, requiredFlags: 0, before: null, during: null, after: null, restored: true},
            wrapper: {schemaVersion: 1, status: "completed", childProcessId: 13, exitCode: 0, timedOut: false,
                durationMilliseconds: 10, stdoutBytes: 0, stderrBytes: 0, outputDrainProven: true,
                childJobMembershipProven: true, errorModeRestored: true}, stdoutBase64: "", stderrBase64: "", failures: []}};
};

const invoke = (mode, value = null) => {
    const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", SCRIPT, "-Mode", mode];
    const result = childProcess.spawnSync(POWERSHELL, args, {encoding: "utf8", timeout: TEST_TIMEOUT_MS,
        input: value === null ? "" : JSON.stringify(value)});
    assert.equal(result.error, undefined, result.error?.message);
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return JSON.parse(result.stdout);
};

const invokeCommand = source => {
    const encoded = Buffer.from(source, "utf16le").toString("base64");
    const result = childProcess.spawnSync(POWERSHELL,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
        {encoding: "utf8", timeout: TEST_TIMEOUT_MS});
    assert.equal(result.error, undefined, result.error?.message);
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return JSON.parse(result.stdout.trim());
};

const manifest = () => ({
    schemaVersion: 1,
    kind: "myspeed-windows-clean-stop-native-proof-manifest",
    qualifying: false,
    repository: "i7Gamer/MySpeed",
    runId: RUN_ID,
    runAttempt: RUN_ATTEMPT,
    eventSha: EVENT_SHA,
    sourceSha: SOURCE_SHA,
    imageOS: "win25-vs2026",
    imageVersion: "20260907.229.1",
    architecture: "X64",
    nonce: NONCE,
    transportSha256: "6".repeat(64),
    observerSha256: OBSERVER_SHA,
    caseIds: [...CASE_IDS],
    limits: {
        controllerNormalDeadlineMs: 300_000,
        controllerHardDeadlineMs: 310_000,
        stopRequestTimeoutMs: 240_000,
        stopRequestPollMs: 50,
        gracefulExitTimeoutMs: 30_000,
        forcedCleanupTimeoutMs: 10_000
    },
    files: FILE_ROLES.map((role, index) => ({
        role,
        path: `C:\\a\\_temp\\closure\\${role}.bin`,
        bytes: index + 1,
        sha256: role === "fixture-binary" ? "0".repeat(64)
            : index.toString(16).repeat(64).slice(0, 64),
        volumeSerial: "89abcdef",
        fileId: index.toString(16).padStart(16, "0"),
        linkCount: 1,
        fileVersion: role === "compiler" ? "4.8.9221.0 built by: NET481REL1LAST_25H2"
            : role === "inbox-powershell" ? "10.0.26100.1" : null
    })),
    compilerArguments: ["/noconfig", "/nostdlib", "/target:exe", "/platform:x64", "/optimize+",
        "/debug-", "/utf8output", "/out:C:\\a\\_temp\\closure\\fixture-binary.bin",
        "/reference:C:\\a\\_temp\\closure\\mscorlib.bin",
        "/reference:C:\\a\\_temp\\closure\\system.bin",
        "/reference:C:\\a\\_temp\\closure\\system-core.bin",
        "C:\\a\\_temp\\closure\\fixture-source.bin"]
});

const launch = caseId => ({
    schemaVersion: 1, kind: "myspeed-windows-clean-stop-launch", expectedRunId: RUN_ID,
    expectedRunAttempt: RUN_ATTEMPT, expectedEventSha: EVENT_SHA, expectedSourceSha: SOURCE_SHA,
    expectedImageVersion: "20260907.229.1", nonce: NONCE, manifestSha256: MANIFEST_SHA, caseId,
    taskRoot: TASK_ROOT, candidatePath: CANDIDATE, candidateSha256: "0".repeat(64),
    candidateVolumeSerial: "89abcdef", candidateFileId: "0123456789abcdef", workingDirectory: TASK_ROOT,
    arguments: [caseId === "missing-stop" ? "handler" : caseId], environment: {
        MYSPEED_CLEAN_STOP_FIXTURE_MODE: caseId === "missing-stop" ? "handler" : caseId,
        MYSPEED_CLEAN_STOP_NONCE: NONCE
    }, stdoutPath: TASK_ROOT + "\\stdout.log", stderrPath: TASK_ROOT + "\\stderr.log",
    abiPath: TASK_ROOT + "\\abi.json", readyPath: TASK_ROOT + "\\ready.json",
    stdoutReadinessPath: TASK_ROOT + "\\stdout.readiness.json",
    stopRequestPath: TASK_ROOT + "\\stop.request.json", resultPath: TASK_ROOT + "\\result.json",
    controllerNormalDeadlineMs: 300_000, controllerHardDeadlineMs: 310_000,
    stopRequestTimeoutMs: 240_000, stopRequestPollMs: 50, gracefulExitTimeoutMs: 30_000,
    forcedCleanupTimeoutMs: 10_000
});

const abi = expected => ({schemaVersion: 1, kind: "myspeed-windows-clean-stop-abi",
    expected, observed: structuredClone(expected), matched: true});

const ready = caseId => ({schemaVersion: 1, kind: "myspeed-windows-clean-stop-ready",
    manifestSha256: MANIFEST_SHA, caseId, requestSha256: REQUEST_SHA, abiSha256: ABI_SHA,
    candidatePid: 4242, candidateCreationTime: "0123456789abcdef", candidateImagePath: CANDIDATE,
    candidateSha256: "0".repeat(64), candidateVolumeSerial: "89abcdef", candidateFileId: "0123456789abcdef",
    controllerInitiallyConsoleFree: true, candidateCreatedSuspended: true, privateConsoleRequested: true,
    handleListConfigured: true, jobAssignedBeforeResume: true, initialJobMembership: true,
    candidateIdentityCaptured: true, candidateResumed: true, threadHandleClosedBeforeReady: true,
    qualifying: false});

const readiness = caseId => ({schemaVersion: 1, kind: "myspeed-windows-clean-stop-stdout-readiness",
    manifestSha256: MANIFEST_SHA, caseId, launchRequestSha256: REQUEST_SHA, abiSha256: ABI_SHA,
    readySha256: READY_SHA, stdoutSha256: STDOUT_SHA, marker: "MYSPEED_CLEAN_STOP_FIXTURE_READY_V1",
    observedMonotonicMs: 120});

const stop = caseId => ({schemaVersion: 1, kind: "myspeed-windows-clean-stop-request",
    expectedRunId: RUN_ID, expectedRunAttempt: RUN_ATTEMPT, expectedEventSha: EVENT_SHA, nonce: NONCE,
    manifestSha256: MANIFEST_SHA, launchRequestSha256: REQUEST_SHA, abiSha256: ABI_SHA,
    readySha256: READY_SHA, stdoutReadinessSha256: READINESS_SHA, caseId, candidatePid: 4242,
    candidateCreationTime: "0123456789abcdef", candidateImagePath: CANDIDATE,
    candidateSha256: "0".repeat(64), candidateVolumeSerial: "89abcdef", candidateFileId: "0123456789abcdef"});

const result = caseId => {
    const passed = caseId === "handler";
    const extra = caseId === "extra-participant";
    const missing = caseId === "missing-stop";
    return {schemaVersion: 1, kind: "myspeed-windows-clean-stop-result",
        status: passed ? "completed" : "failed", qualifying: false, controllerLifecyclePassed: passed,
        forced: !passed, manifestSha256: MANIFEST_SHA, caseId, requestSha256: REQUEST_SHA,
        abiSha256: ABI_SHA, readySha256: READY_SHA, stdoutReadinessSha256: READINESS_SHA,
        stopRequestSha256: missing ? null : STOP_SHA, runId: RUN_ID, runAttempt: RUN_ATTEMPT,
        stdoutReadinessObserved: true, stopRequestObserved: !missing, stopRequestDeadlineMs: 240_020,
        graceExpired: missing ? null : caseId === "ignore", observedConsoleProcessIds: missing ? null
            : extra ? [4000, 4242, 4243] : [4000, 4242],
        lifecycleEvents: missing ? ["assertConsoleFree", "openCandidateAndJob", "createStandardHandles",
            "queryAttributeList", "initializeAttributeList", "updateHandleList", "launchSuspended", "assignJob",
            "captureIdentity", "resume", "writeReady", "awaitStdoutReadiness", "validateStdoutReadiness",
            "awaitStopRequest", "closeResources"] : extra
            ? ["assertConsoleFree", "openCandidateAndJob", "createStandardHandles", "queryAttributeList",
                "initializeAttributeList", "updateHandleList", "launchSuspended", "assignJob", "captureIdentity",
                "resume", "writeReady", "awaitStdoutReadiness", "validateStdoutReadiness", "awaitStopRequest",
                "validateStopRequest", "attachConsole", "installIgnoreHandler", "revalidateHandle",
                "proveConsoleMembers", "closeResources"]
            : ["assertConsoleFree", "openCandidateAndJob", "createStandardHandles", "queryAttributeList",
                "initializeAttributeList", "updateHandleList", "launchSuspended", "assignJob", "captureIdentity",
                "resume", "writeReady", "awaitStdoutReadiness", "validateStdoutReadiness", "awaitStopRequest",
                "validateStopRequest", "attachConsole", "installIgnoreHandler", "revalidateHandle",
                "proveConsoleMembers", "generateCtrlC", "freeConsole", "proveConsoleFree", "waitCandidateExit",
                "proveJobZero", "closeResources"],
        eventSha: EVENT_SHA, sourceSha: SOURCE_SHA, imageVersion: "20260907.229.1", nonce: NONCE,
        controllerPid: 4000,
        candidatePid: 4242, candidateCreationTime: "0123456789abcdef", candidateImagePath: CANDIDATE,
        candidateSha256: "0".repeat(64), candidateVolumeSerial: "89abcdef", candidateFileId: "0123456789abcdef",
        initialConsoleProcessIds: [4000], initialConsoleError: 0, initialConsoleDetached: true,
        controllerInitiallyConsoleFree: true, candidateCreatedSuspended: true, privateConsoleRequested: true,
        handleListConfigured: true, jobAssignedBeforeResume: true, initialJobMembership: true,
        candidateIdentityCaptured: true, candidateResumed: true, threadHandleClosedBeforeReady: true,
        preAttachIdentityMatch: !missing, postAttachHandleUnsignaled: !missing,
        postAttachIdentityMatch: !missing, postAttachJobMembership: !missing,
        consoleProcessIdsExact: passed || caseId === "ignore", ctrlEventGenerated: !extra && !missing,
        candidateExited: true, exitCode: passed ? 0 : 197, jobActiveProcesses: 0,
        consoleFreeAfter: true, handlesClosed: true, elapsedMs: missing ? 240_100 : 1_000,
        failures: passed ? [] : [caseId + " expected negative control"], releaseGatesCleared: []};
};

const outerLauncher = (caseId, launchValue, manifestValue) => {
    const powershell = manifestValue.files.find(({role}) => role === "inbox-powershell");
    const controller = manifestValue.files.find(({role}) => role === "controller");
    const launchPath = launchValue.taskRoot + "\\launch.request.json";
    const exactArguments = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", controller.path, "-Mode", "InvokeHostedController", "-LaunchRequestPath", launchPath,
        "-ExpectedLaunchRequestSha256", null, "-ExpectedRunId", RUN_ID, "-ExpectedRunAttempt", RUN_ATTEMPT,
        "-ExpectedEventSha", EVENT_SHA, "-ExpectedSourceSha", SOURCE_SHA,
        "-ExpectedImageVersion", "20260907.229.1", "-Nonce", launchValue.nonce];
    return {schemaVersion: 1, kind: "myspeed-owned-job-observed-launch", status: "completed",
        authorizesTransfer: false,
        executable: {path: powershell.path, expectedSha256: powershell.sha256,
            beforeSha256: powershell.sha256, afterSha256: powershell.sha256},
        arguments: exactArguments, workingDirectory: launchValue.taskRoot, creationFlags: 134_217_732,
        process: {processId: 4000, assignedBeforeResume: true, resumed: true, retainedHandleThroughExit: true},
        timing: {initialWallUnixMilliseconds: 1_000, initialMonotonicMilliseconds: 10,
            wallDeadlineUnixMilliseconds: 311_000, monotonicDeadlineMilliseconds: 310_010,
            lastWallUnixMilliseconds: caseId === "missing-stop" ? 241_100 : 2_000,
            lastMonotonicMilliseconds: caseId === "missing-stop" ? 240_110 : 1_010,
            postReturnWallUnixMilliseconds: caseId === "missing-stop" ? 241_101 : 2_001,
            postReturnMonotonicMilliseconds: caseId === "missing-stop" ? 240_111 : 1_011},
        timedOut: false, forced: false, exitCode: caseId === "handler" ? 0 : 1,
        processTreeExitProven: true, handles: {job: "closed", process: "closed", thread: "closed"},
        observer: {sha256: OBSERVER_SHA, tickCount: 2, firstMonotonicMilliseconds: 10,
            lastMonotonicMilliseconds: caseId === "missing-stop" ? 240_100 : 1_000,
            maximumDurationMilliseconds: 1,
            contextKeys: ["schemaVersion", "tick", "processId", "wallUnixMilliseconds",
                "monotonicMilliseconds", "wallDeadlineUnixMilliseconds", "monotonicDeadlineMilliseconds"],
            lastAction: "observe", lastObservation: "result-present", synchronousCancellationProven: false},
        failure: null};
};

const bundle = (caseId, expectedAbi, manifestValue = manifest(), manifestSha256 = sealJson(manifestValue).sha256) => {
    const caseNonce = sha(Buffer.from(`${NONCE}:${caseId}`, "utf8")).slice(0, 32);
    const bindCase = value => JSON.stringify(value).replaceAll(NONCE, caseNonce);
    const launchValue = JSON.parse(bindCase(launch(caseId)));
    launchValue.manifestSha256 = manifestSha256;
    const launchDocument = sealJson(launchValue);
    const outerValue = outerLauncher(caseId, launchValue, manifestValue);
    outerValue.arguments[12] = launchDocument.sha256;
    const abiDocument = sealJson(abi(expectedAbi));
    const readyValue = JSON.parse(bindCase(ready(caseId)));
    Object.assign(readyValue, {manifestSha256, requestSha256: launchDocument.sha256,
        abiSha256: abiDocument.sha256});
    const readyDocument = sealJson(readyValue);
    const readinessValue = JSON.parse(bindCase(readiness(caseId)));
    Object.assign(readinessValue, {manifestSha256, launchRequestSha256: launchDocument.sha256,
        abiSha256: abiDocument.sha256, readySha256: readyDocument.sha256});
    const stdoutReadinessDocument = sealJson(readinessValue);
    let stopDocument = null;
    if (caseId !== "missing-stop") {
        const stopValue = JSON.parse(bindCase(stop(caseId)));
        Object.assign(stopValue, {manifestSha256, launchRequestSha256: launchDocument.sha256,
            abiSha256: abiDocument.sha256, readySha256: readyDocument.sha256,
            stdoutReadinessSha256: stdoutReadinessDocument.sha256});
        stopDocument = sealJson(stopValue);
    }
    const resultValue = JSON.parse(bindCase(result(caseId)));
    Object.assign(resultValue, {manifestSha256, requestSha256: launchDocument.sha256,
        abiSha256: abiDocument.sha256, readySha256: readyDocument.sha256,
        stdoutReadinessSha256: stdoutReadinessDocument.sha256,
        stopRequestSha256: stopDocument?.sha256 ?? null});
    return {manifestSha256, launchDocument, abiDocument, readyDocument,
        stdoutReadinessDocument, stdoutBase64: STDOUT.toString("base64"), stdoutSha256: STDOUT_SHA,
        stopDocument, resultDocument: sealJson(resultValue), outerLauncherDocument: sealJson(outerValue)};
};

const matrixValue = expectedAbi => {
    const manifestValue = manifest();
    const manifestDocument = sealJson(manifestValue);
    const cases = CASE_IDS.map(caseId => bundle(caseId, expectedAbi, manifestValue, manifestDocument.sha256));
    const classifications = ["handler-natural-exit-observed", "ignore-forced-cleanup-observed",
        "extra-participant-refusal-observed", "missing-stop-timeout-observed"];
    const summary = {schemaVersion: 1, kind: "myspeed-windows-clean-stop-native-proof-summary",
        status: "completed", qualifying: false, releaseGatesCleared: [],
        manifestSha256: manifestDocument.sha256, caseIds: [...CASE_IDS], classifications,
        cases: cases.map((item, index) => ({caseId: CASE_IDS[index],
            launchSha256: item.launchDocument.sha256, abiSha256: item.abiDocument.sha256,
            readySha256: item.readyDocument.sha256, stdoutReadinessSha256: item.stdoutReadinessDocument.sha256,
            stopSha256: item.stopDocument?.sha256 ?? null, resultSha256: item.resultDocument.sha256,
            outerLauncherSha256: item.outerLauncherDocument.sha256})), allCasesObserved: true};
    return {manifestDocument, cases, summaryDocument: sealJson(summary)};
};

const boundCaseValue = (caseId, expectedAbi) => {
    const value = matrixValue(expectedAbi);
    return {manifestDocument: value.manifestDocument,
        case: value.cases[CASE_IDS.indexOf(caseId)]};
};

describe("Windows clean-stop native proof coordinator", () => {
    it("is a pure nonqualifying four-case slice", () => {
        const source = fs.readFileSync(SCRIPT, "utf8");
        assert.match(source, /qualifying=\$false/u);
        assert.match(source, /releaseGatesCleared=@\(\)/u);
        assert.doesNotMatch(source, /MySpeed\.exe|msiexec|Disable-NetAdapter|Invoke-WebRequest/u);
        assert.match(source, /ExpectedRunId -cnotmatch '\\A\[1-9\]/u);
        assert.match(source, /PSVersionTable\.PSVersion\.Minor -ne 1/u);
        assert.match(source, /ReadBytes=\{param\(\$path\)Read-MyspeedProofActiveLogBytes/u);
        assert.match(source, /Read-MyspeedProofNativeBytes "\$caseId-\$\(\$entry\.Key\)"/u);
        assert.match(source, /\$Mode -cne \$script:NativeMode[\s\S]*?ReadToEnd/u);
        const outerFailureGate = source.indexOf("if($outer.status -ceq 'failed')");
        const outerValidation = source.indexOf("Assert-MyspeedProofOuterLauncher $manifest $launch $launchSha $outer", outerFailureGate);
        const failedStreamRead = source.indexOf("Get-MyspeedProofFailedProcessStreams $launch", outerFailureGate);
        const evidenceGate = source.indexOf("Assert-MyspeedProofCaseCollectionGate", outerValidation);
        assert.ok(outerFailureGate >= 0 && outerFailureGate < failedStreamRead && failedStreamRead < outerValidation
            && outerValidation < evidenceGate,
            "outer failure and exit proofs must precede evidence-file collection");
    });

    powershellIt("returns the exact observer contract", () => {
        assert.equal(invoke("GetContract").observerSha256, OBSERVER_SHA);
    });

    powershellIt("passes integral-valued Double clocks through the actual launcher and returned observer", () => {
        const result = invoke("TestLauncherBridge", {});
        assert.equal(result.status, "completed");
        assert.equal(result.exitCode, 0);
        assert.equal(result.observer.tickCount, 1);
        assert.equal(result.observer.lastObservation, "abi-absent");
        assert.equal(result.processTreeExitProven, true);
    });

    powershellIt("accepts decimal clocks and rejects every non-finite or out-of-domain clock value", () => {
        const escaped = SCRIPT.replaceAll("'", "''");
        const result = invokeCommand(`
. '${escaped}' -Mode Library
$invalid=@(
  [pscustomobject]@{value=[double]::NaN},[pscustomobject]@{value=[double]::PositiveInfinity},
  [pscustomobject]@{value=[double]::NegativeInfinity},[pscustomobject]@{value=$null},
  [pscustomobject]@{value=(,@(1))},[pscustomobject]@{value=[double]-1},[pscustomobject]@{value=[double]1e20}
)
$rejected=0
foreach($case in $invalid){try{[void](Assert-MyspeedProofClockNumber $case.value 'clock' 0 9223372036854775807)}catch{$rejected++}}
$valid=Assert-MyspeedProofClockNumber ([decimal]1.25) 'clock' 0 10
[pscustomobject]@{rejected=$rejected;total=$invalid.Count;valid=$valid}|ConvertTo-Json -Compress
`);
        assert.deepEqual(result, {rejected: 7, total: 7, valid: 1.25});
    });

    powershellIt("reports the outer failure before inspecting unpublished case files", () => {
        const files = {abi: false, ready: false, readiness: false, result: false, stdout: false, stderr: false};
        assert.throws(() => invoke("TestCollectionGate", {status: "failed",
            failure: {stage: "observer", message: "controller failed before ABI publication"}, files}),
        /controller failed before ABI publication/u);
        for (const mutate of [
            value => { value.failure = null; },
            value => { value.failure.stage = "Observer"; },
            value => { value.failure.message = "x".repeat(1_025); },
            value => { value.failure.message = "line\nbreak"; },
            value => { value.extra = true; }
        ]) {
            const invalid = {status: "failed", failure: {stage: "observer", message: "bounded"},
                files: {...files}};
            mutate(invalid);
            assert.throws(() => invoke("TestCollectionGate", invalid));
        }
        for (const mutate of [
            value => { value.files.abi = "false"; },
            value => { delete value.files.stderr; }
        ]) {
            const invalid = {status: "completed", failure: null,
                files: Object.fromEntries(Object.keys(files).map(name => [name, true]))};
            mutate(invalid);
            assert.throws(() => invoke("TestCollectionGate", invalid), /Boolean|keys differ/u);
        }
        assert.throws(() => invoke("TestCollectionGate", {status: "completed", failure: null, files}),
            /incomplete.*abi/u);
        assert.throws(() => invoke("TestCollectionGate", {status: "completed",
            failure: {stage: "observer", message: "stale"}, files}), /retained a failure/u);
        assert.equal(invoke("TestCollectionGate", {status: "completed", failure: null,
            files: Object.fromEntries(Object.keys(files).map(name => [name, true]))}).ready, true);
    });

    powershellIt("prioritizes bounded controller failure fields before exact failed-process stream metadata", () => {
        const tempResult = childProcess.spawnSync(POWERSHELL,
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
                "[Console]::Out.Write([IO.Path]::GetFullPath([IO.Path]::GetTempPath()))"],
            {encoding: "utf8", timeout: TEST_TIMEOUT_MS});
        assert.equal(tempResult.status, 0, tempResult.stderr);
        const directory = fs.mkdtempSync(path.join(tempResult.stdout, "myspeed-clean-stop-failure-"));
        const stdoutPath = path.join(directory, "stdout.log");
        const stderrPath = path.join(directory, "stderr.log");
        const resultPath = path.join(directory, "result.json");
        const stdout = Buffer.from("x".repeat(400), "utf8");
        const stderr = Buffer.from("controller failed before ABI", "utf8");
        const lifecycleFailure = "Owned Job cleanup failed after retained process exit";
        const entryFailure = "Add-Type rejected the generated native controller source";
        const resultBytes = Buffer.from(JSON.stringify({
            schemaVersion: 1,
            kind: "myspeed-windows-clean-stop-result",
            status: "failed",
            controllerLifecyclePassed: false,
            forced: false,
            graceExpired: false,
            controllerInitiallyConsoleFree: true,
            candidateCreatedSuspended: true,
            privateConsoleRequested: true,
            handleListConfigured: true,
            jobAssignedBeforeResume: true,
            initialJobMembership: true,
            candidateIdentityCaptured: true,
            candidateResumed: true,
            threadHandleClosedBeforeReady: true,
            preAttachIdentityMatch: false,
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
            elapsedMs: 7000,
            padding: "z".repeat(1800),
            failures: [lifecycleFailure]
        }), "utf8");
        const entryBytes = Buffer.from(JSON.stringify({
            schemaVersion: 1,
            kind: "myspeed-windows-clean-stop-controller-entry-failure",
            stage: "controller-entry",
            messageBytes: Buffer.byteLength(entryFailure),
            messagePrefixBase64: Buffer.from(entryFailure).toString("base64")
        }), "utf8");
        fs.writeFileSync(stdoutPath, stdout);
        fs.writeFileSync(stderrPath, stderr);
        fs.writeFileSync(resultPath, resultBytes);
        fs.writeFileSync(`${resultPath}.entry-failure.json`, entryBytes);
        try {
            const summary = invoke("TestFailureStreams", {resultPath, stdoutPath, stderrPath});
            assert.ok(summary.length < 900, summary);
            assert.ok(summary.indexOf("resultFailurePrefixBase64=") < summary.indexOf("resultBytes="), summary);
            assert.ok(summary.indexOf("entryFailurePrefixBase64=") < summary.indexOf("resultBytes="), summary);
            assert.match(summary, new RegExp(`resultFailurePrefixBase64=${Buffer.from(lifecycleFailure).toString("base64")}`, "u"));
            assert.match(summary, new RegExp(`entryFailurePrefixBase64=${Buffer.from(entryFailure).toString("base64")}`, "u"));
            assert.match(summary, /resultProof=pass:0,forced:0,grace:0,false:preAttachIdentityMatch,exit:0,job:0,elapsed:7000/u);
            assert.match(summary, new RegExp(`resultBytes=${resultBytes.length},resultSha256=${sha(resultBytes)}`, "u"));
            assert.match(summary, new RegExp(`entryDiagnosticBytes=${entryBytes.length},entryDiagnosticSha256=${sha(entryBytes)}`, "u"));
            assert.match(summary, new RegExp(`stdoutBytes=400,stdoutSha256=${sha(stdout)}`, "u"));
            assert.match(summary, new RegExp(`stderrBytes=${stderr.length},stderrSha256=${sha(stderr)}`, "u"));
            const prefix = summary.match(/stdoutPrefixBase64=([^;]*)/u)?.[1];
            assert.equal(Buffer.from(prefix, "base64").length, 64);
            const retained = `Outer exit code differs: actual=1; expected=0; ${summary}`.slice(0, 1024);
            assert.match(retained, new RegExp(Buffer.from(lifecycleFailure).toString("base64"), "u"));
            assert.match(retained, new RegExp(Buffer.from(entryFailure).toString("base64"), "u"));

            const cappedProofNames = ["controllerInitiallyConsoleFree", "candidateCreatedSuspended",
                "privateConsoleRequested", "handleListConfigured", "jobAssignedBeforeResume",
                "initialJobMembership", "candidateIdentityCaptured", "candidateResumed"];
            const remainingProofNames = ["threadHandleClosedBeforeReady", "preAttachIdentityMatch",
                "postAttachHandleUnsignaled", "postAttachIdentityMatch", "postAttachJobMembership",
                "consoleProcessIdsExact", "ctrlEventGenerated", "candidateExited", "consoleFreeAfter",
                "handlesClosed"];
            const allFalseProofs = Object.fromEntries([...cappedProofNames, ...remainingProofNames]
                .map(name => [name, false]));
            fs.writeFileSync(resultPath, JSON.stringify({...allFalseProofs, controllerLifecyclePassed: false,
                forced: false, graceExpired: false, exitCode: 0, jobActiveProcesses: 0, elapsedMs: 1,
                failures: []}));
            const cappedSummary = invoke("TestFailureStreams", {resultPath, stdoutPath, stderrPath});
            assert.match(cappedSummary, new RegExp(`resultProof=pass:0,forced:0,grace:0,false:${
                cappedProofNames.join(",")},exit:0,job:0,elapsed:1`, "u"));
            assert.doesNotMatch(cappedSummary, /false:[^;]*threadHandleClosedBeforeReady/u);

            fs.writeFileSync(resultPath, JSON.stringify({controllerLifecyclePassed: "false", forced: null,
                graceExpired: [], exitCode: "0", jobActiveProcesses: 1.5, elapsedMs: true}));
            const malformedSummary = invoke("TestFailureStreams", {resultPath, stdoutPath, stderrPath});
            assert.match(malformedSummary, new RegExp(`resultProof=pass:x,forced:x,grace:x,false:${
                cappedProofNames.join(",")},exit:invalid,job:invalid,elapsed:invalid`, "u"));
            fs.rmSync(stderrPath);
            assert.match(invoke("TestFailureStreams", {resultPath, stdoutPath, stderrPath}), /stderr=absent/u);
        } finally { fs.rmSync(directory, {recursive: true, force: true}); }
    });

    powershellIt("strictly validates the sealed manifest", () => {
        assert.equal(invoke("ValidateManifest", manifest()).accepted, true);
        for (const mutate of [
            value => { value.qualifying = true; },
            value => { value.caseIds.reverse(); },
            value => { value.files[0].bytes = 1.5; },
            value => { value.files[1].role = value.files[0].role; },
            value => { value.files[1].path = value.files[0].path.toUpperCase(); },
            value => { value.files.find(({role}) => role === "controller").linkCount = 2; },
            value => { value.observerSha256 = "1".repeat(64); },
            value => { value.compilerArguments[0] = "/noconfigx"; }
        ]) {
            const value = manifest(); mutate(value);
            assert.throws(() => invoke("ValidateManifest", value), /manifest|file|case|compiler|integer/i);
        }
        const systemHardLink = manifest();
        systemHardLink.files.find(({role}) => role === "inbox-powershell").linkCount = 2;
        systemHardLink.files.find(({role}) => role === "fixture-binary").fileVersion = "0.0.0.0";
        assert.equal(invoke("ValidateManifest", systemHardLink).accepted, true);
        systemHardLink.files.find(({role}) => role === "fixture-binary").fileVersion = "0.0.0.0\n";
        assert.throws(() => invoke("ValidateManifest", systemHardLink), /file version/i);
    });

    powershellIt("strictly validates transport and the exact produced evidence inventory", () => {
        assert.equal(invoke("ValidateTransport", transport()).accepted, true);
        for (const mutate of [value => value.files.reverse(), value => { value.runAttempt = "0"; },
            value => { value.files[0].bytes = 0; }, value => { value.files[0].extra = true; }]) {
            const value = transport(); mutate(value);
            assert.throws(() => invoke("ValidateTransport", value), /transport|file|integer/i);
        }
        const wrongHelper = transport();
        wrongHelper.files.find(({name}) => name === "windows-cpu-tool-child.ps1").sha256 = "f".repeat(64);
        assert.throws(() => invoke("ValidateTransport", wrongHelper), /reviewed helper hash/i);
        const value = inventory();
        assert.equal(invoke("ValidateInventory", value).accepted, true);
        for (const mutate of [item => item.files.reverse(), item => { item.files[0].name += "x"; },
            item => { item.files[1].path = item.files[0].path.toUpperCase(); },
            item => { item.files[2].bytes = 1.5; }, item => { item.files[3].sha256 += "0"; }]) {
            const changed = structuredClone(value); mutate(changed);
            assert.throws(() => invoke("ValidateInventory", changed), /inventory|file|path|integer/i);
        }
    });

    powershellIt("strictly validates the reused compiler wrapper evidence", () => {
        const value = compilerOperation();
        assert.equal(invoke("ValidateCompilerOperation", value).accepted, true);
        for (const mutate of [item => { item.requestSha256 = [item.requestSha256]; },
            item => { item.result.bindings.arguments = ["/noconfig\n/target:exe"]; },
            item => { item.result.wrapper.stdoutBytes = 1; },
            item => { item.result.wrapper.durationMilliseconds = 10.5; },
            item => { item.result.parentJobMembershipProven = 1; }]) {
            const changed = structuredClone(value); mutate(changed);
            assert.throws(() => invoke("ValidateCompilerOperation", changed), /compiler|array|string|integer|boolean/i);
        }
    });

    powershellIt("rejects the native proof entry before closure or helper access", () => {
        const result = childProcess.spawnSync(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive",
            "-File", SCRIPT, "-Mode", "InvokeHostedProof"], {encoding: "utf8", timeout: TEST_TIMEOUT_MS});
        assert.equal(result.error, undefined, result.error?.message);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Hosted proof identity input is invalid/u);
        assert.doesNotMatch(result.stderr, /closure|file-identity|Add-Type/u);

        const newlineIdentity = childProcess.spawnSync(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive",
            "-File", SCRIPT, "-Mode", "InvokeHostedProof", "-ExpectedRunId", "1\n"],
        {encoding: "utf8", timeout: TEST_TIMEOUT_MS});
        assert.equal(newlineIdentity.error, undefined, newlineIdentity.error?.message);
        assert.notEqual(newlineIdentity.status, 0);
        assert.match(newlineIdentity.stderr, /Hosted proof identity input is invalid/u);
        assert.doesNotMatch(newlineIdentity.stderr, /closure|file-identity|Add-Type/u);
    });

    powershellIt("reads an active append log through the writer's restrictive share mode", () => {
        const tempResult = childProcess.spawnSync(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive",
            "-Command", "[Console]::Out.Write([IO.Path]::GetFullPath([IO.Path]::GetTempPath()))"],
        {encoding: "utf8", timeout: TEST_TIMEOUT_MS});
        assert.equal(tempResult.status, 0, tempResult.stderr);
        const root = fs.mkdtempSync(path.join(tempResult.stdout, "myspeed-clean-stop-active-"));
        const file = path.join(root, "stdout.log");
        fs.writeFileSync(file, "");
        try {
            const result = invoke("TestActiveLogReader", {path: file});
            assert.equal(result.detachedFactory, true);
            assert.equal(result.stableWhileExclusive, false);
            assert.equal(result.stableAfterExclusive, true);
            assert.equal(result.emptyBytesBase64, "");
            assert.deepEqual(Buffer.from(result.bytesBase64, "base64"), STDOUT);
        } finally {
            assert.match(path.basename(root), /^myspeed-clean-stop-active-/u);
            fs.rmSync(root, {recursive: true});
        }
    });

    powershellIt("uses the returned trusted observer to bind ready, marker, and stop ordering", () => {
        const expectedAbi = invoke("GetContract").abiExpected;
        const value = bundle("handler", expectedAbi);
        const observed = invoke("TestObserver", {case: value, abiPresentAtTick: 0, resultPresentAtTick: 2, contexts: [
            {schemaVersion: 1, tick: 0, processId: 4000, wallUnixMilliseconds: 1_000,
                monotonicMilliseconds: 10, wallDeadlineUnixMilliseconds: 311_000,
                monotonicDeadlineMilliseconds: 310_010},
            {schemaVersion: 1, tick: 1, processId: 4000, wallUnixMilliseconds: 1_001,
                monotonicMilliseconds: 11, wallDeadlineUnixMilliseconds: 311_000,
                monotonicDeadlineMilliseconds: 310_010},
            {schemaVersion: 1, tick: 2, processId: 4000, wallUnixMilliseconds: 1_002,
                monotonicMilliseconds: 12, wallDeadlineUnixMilliseconds: 311_000,
                monotonicDeadlineMilliseconds: 310_010}
        ]});
        assert.deepEqual(observed.events, ["read-abi", "read-ready", "read-stdout", "write-readiness", "write-stop"]);
        assert.deepEqual(observed.responses.map(({action, observation}) => [action, observation]), [
            ["write-stop", "stop-created"], ["await", "result-absent"], ["observe", "result-present"]]);
        assert.equal(observed.stop.caseId, "handler");
        assert.equal(observed.stop.readySha256, value.readyDocument.sha256);
        const partial = invoke("TestObserver", {case: value, abiPresentAtTick: 0, resultPresentAtTick: null,
            emptyStdoutUntilTick: 0, partialStdoutUntilTick: 1, contexts: [
                {schemaVersion: 1, tick: 0, processId: 4000, wallUnixMilliseconds: 1_000,
                    monotonicMilliseconds: 10, wallDeadlineUnixMilliseconds: 311_000,
                    monotonicDeadlineMilliseconds: 310_010},
                {schemaVersion: 1, tick: 1, processId: 4000, wallUnixMilliseconds: 1_001,
                    monotonicMilliseconds: 11, wallDeadlineUnixMilliseconds: 311_000,
                    monotonicDeadlineMilliseconds: 310_010},
                {schemaVersion: 1, tick: 2, processId: 4000, wallUnixMilliseconds: 1_002,
                    monotonicMilliseconds: 12, wallDeadlineUnixMilliseconds: 311_000,
                    monotonicDeadlineMilliseconds: 310_010}
            ]});
        assert.deepEqual(partial.responses.map(({action, observation}) => [action, observation]), [
            ["await", "stdout-incomplete"], ["await", "stdout-incomplete"], ["write-stop", "stop-created"]]);
        assert.equal(partial.events.filter(event => event === "write-stop").length, 1);
        for (const mutate of [
            item => { item.case.stdoutBase64 = Buffer.from("wrong\r\n").toString("base64"); },
            item => { item.contexts[0].monotonicMilliseconds = item.contexts[0].monotonicDeadlineMilliseconds; }
        ]) {
            const changed = {case: structuredClone(value), abiPresentAtTick: 0, resultPresentAtTick: 2, contexts: [{schemaVersion: 1, tick: 0,
                processId: 4000, wallUnixMilliseconds: 1_000, monotonicMilliseconds: 10,
                wallDeadlineUnixMilliseconds: 311_000, monotonicDeadlineMilliseconds: 310_010}]};
            mutate(changed);
            assert.throws(() => invoke("TestObserver", changed), /stdout|deadline|observer/i);
        }

        const missing = invoke("TestObserver", {case: bundle("missing-stop", expectedAbi), abiPresentAtTick: 0,
            resultPresentAtTick: 2, contexts: [
                {schemaVersion: 1, tick: 0, processId: 4000, wallUnixMilliseconds: 1_000,
                    monotonicMilliseconds: 10, wallDeadlineUnixMilliseconds: 311_000,
                    monotonicDeadlineMilliseconds: 310_010},
                {schemaVersion: 1, tick: 1, processId: 4000, wallUnixMilliseconds: 1_001,
                    monotonicMilliseconds: 11, wallDeadlineUnixMilliseconds: 311_000,
                    monotonicDeadlineMilliseconds: 310_010}
            ]});
        assert.equal(missing.stop, null);
        assert.deepEqual(missing.responses.map(({action, observation}) => [action, observation]), [
            ["withhold-stop", "missing-stop"], ["await", "result-absent"]]);

        const detached = invoke("TestDetachedObserver", {case: value, abiPresentAtTick: 0, resultPresentAtTick: null, contexts: [
            {schemaVersion: 1, tick: 0, processId: 4000, wallUnixMilliseconds: 1_000,
                monotonicMilliseconds: 10, wallDeadlineUnixMilliseconds: 311_000,
                monotonicDeadlineMilliseconds: 310_010}
        ]});
        assert.equal(detached.responses[0].observation, "stop-created");

        const fractionalClock = invoke("TestDetachedObserver", {case: value, abiPresentAtTick: 0,
            resultPresentAtTick: null, contexts: [{schemaVersion: 1, tick: 0, processId: 4000,
                wallUnixMilliseconds: 1_000.25, monotonicMilliseconds: 10.5,
                wallDeadlineUnixMilliseconds: 311_000.75, monotonicDeadlineMilliseconds: 310_010.5}]});
        assert.equal(fractionalClock.responses[0].observation, "stop-created");
        for (const invalidClock of ["10", true]) {
            const changed = {case: structuredClone(value), abiPresentAtTick: 0, resultPresentAtTick: null,
                contexts: [{schemaVersion: 1, tick: 0, processId: 4000, wallUnixMilliseconds: 1_000,
                    monotonicMilliseconds: invalidClock, wallDeadlineUnixMilliseconds: 311_000,
                    monotonicDeadlineMilliseconds: 310_010}]};
            assert.throws(() => invoke("TestDetachedObserver", changed), /finite number/i);
        }

        const lateAbi = invoke("TestObserver", {case: value, abiPresentAtTick: 1, resultPresentAtTick: null, contexts: [
            {schemaVersion: 1, tick: 0, processId: 4000, wallUnixMilliseconds: 1_000,
                monotonicMilliseconds: 10, wallDeadlineUnixMilliseconds: 311_000,
                monotonicDeadlineMilliseconds: 310_010},
            {schemaVersion: 1, tick: 1, processId: 4000, wallUnixMilliseconds: 1_001,
                monotonicMilliseconds: 11, wallDeadlineUnixMilliseconds: 311_000,
                monotonicDeadlineMilliseconds: 310_010}
        ]});
        assert.deepEqual(lateAbi.responses.map(({observation}) => observation), ["abi-absent", "stop-created"]);
        const publishing = invoke("TestObserver", {case: value, abiPresentAtTick: 0, resultPresentAtTick: null,
            unstableAbiUntilTick: 0, unstableReadyUntilTick: 1, contexts: [
                {schemaVersion: 1, tick: 0, processId: 4000, wallUnixMilliseconds: 1_000,
                    monotonicMilliseconds: 10, wallDeadlineUnixMilliseconds: 311_000,
                    monotonicDeadlineMilliseconds: 310_010},
                {schemaVersion: 1, tick: 1, processId: 4000, wallUnixMilliseconds: 1_001,
                    monotonicMilliseconds: 11, wallDeadlineUnixMilliseconds: 311_000,
                    monotonicDeadlineMilliseconds: 310_010},
                {schemaVersion: 1, tick: 2, processId: 4000, wallUnixMilliseconds: 1_002,
                    monotonicMilliseconds: 12, wallDeadlineUnixMilliseconds: 311_000,
                    monotonicDeadlineMilliseconds: 310_010}
            ]});
        assert.deepEqual(publishing.responses.map(({observation}) => observation),
            ["abi-in-progress", "ready-in-progress", "stop-created"]);
        const malformedAbi = structuredClone(value);
        malformedAbi.abiDocument = mutateDocument(malformedAbi.abiDocument,
            record => { record.observed.pointerBytes = 4; });
        assert.throws(() => invoke("TestObserver", {case: malformedAbi, abiPresentAtTick: 0,
            resultPresentAtTick: null, contexts: [{schemaVersion: 1, tick: 0, processId: 4000,
                wallUnixMilliseconds: 1_000, monotonicMilliseconds: 10,
                wallDeadlineUnixMilliseconds: 311_000, monotonicDeadlineMilliseconds: 310_010}]}), /ABI/i);
    });

    powershellIt("binds ABI, ready, stdout marker, stop, and result evidence", () => {
        const expectedAbi = invoke("GetContract").abiExpected;
        const value = boundCaseValue("handler", expectedAbi);
        assert.equal(invoke("ValidateCase", value).classification, "handler-natural-exit-observed");
        for (const mutate of [
            item => { item.readyDocument = mutateDocument(item.readyDocument,
                record => { record.requestSha256 = "1".repeat(64); }); },
            item => { item.readyDocument = mutateDocument(item.readyDocument,
                record => { record.candidatePid += 1; }); },
            item => { item.resultDocument = mutateDocument(item.resultDocument,
                record => { record.candidateCreationTime = "1".repeat(16); }); },
            item => {
                item.stopDocument = mutateDocument(item.stopDocument, record => { record.candidatePid += 1; });
                item.resultDocument = mutateDocument(item.resultDocument,
                    record => { record.stopRequestSha256 = item.stopDocument.sha256; });
            },
            item => { item.abiDocument = mutateDocument(item.abiDocument,
                record => { record.observed.pointerBytes = 4; }); },
            item => { item.stdoutBase64 = Buffer.from("wrong\r\n").toString("base64"); },
            item => { item.stdoutReadinessDocument = mutateDocument(item.stdoutReadinessDocument,
                record => { record.marker += "x"; }); },
            item => { item.stopDocument = mutateDocument(item.stopDocument,
                record => { record.stdoutReadinessSha256 = "1".repeat(64); }); },
            item => { item.resultDocument = mutateDocument(item.resultDocument,
                record => { record.readySha256 = "1".repeat(64); }); }
        ]) {
            const changed = structuredClone(value); mutate(changed.case);
            assert.throws(() => invoke("ValidateCase", changed), /ABI|ready|stdout|binding|hash|result/i);
        }
    });

    powershellIt("recomputes all four fixed outcomes without clearing a gate", () => {
        const expectedAbi = invoke("GetContract").abiExpected;
        const value = matrixValue(expectedAbi);
        const assessment = invoke("AssessMatrix", value);
        assert.deepEqual(assessment.caseIds, CASE_IDS);
        assert.deepEqual(assessment.classifications, ["handler-natural-exit-observed",
            "ignore-forced-cleanup-observed", "extra-participant-refusal-observed",
            "missing-stop-timeout-observed"]);
        assert.equal(assessment.allCasesObserved, true);
        assert.equal(assessment.qualifying, false);
        assert.deepEqual(assessment.releaseGatesCleared, []);
        const changed = structuredClone(value);
        changed.cases.reverse();
        assert.throws(() => invoke("AssessMatrix", changed), /case|order|matrix/i);

        for (const [caseIndex, mutate] of [
            [1, value => { value.handlesClosed = false; }],
            [1, value => { value.candidateExited = false; }],
            [1, value => { value.exitCode = null; }],
            [1, value => { value.graceExpired = false; }],
            [2, value => { value.observedConsoleProcessIds = [4000, 4242]; }],
            [2, value => { value.observedConsoleProcessIds = [4000, 4242, 4242]; }],
            [2, value => { value.observedConsoleProcessIds = [4242, 4243, 4244]; }],
            [3, value => { value.elapsedMs = value.stopRequestDeadlineMs - 1; }],
            [3, value => { value.lifecycleEvents.push("attachConsole"); }]
        ]) {
            const invalid = structuredClone(value);
            invalid.cases[caseIndex].resultDocument = mutateDocument(
                invalid.cases[caseIndex].resultDocument, mutate);
            assert.throws(() => invoke("AssessMatrix", invalid), /case|result|cleanup|timeout|differ/i);
        }

        const diagnosedIgnore = structuredClone(value);
        diagnosedIgnore.cases[1].resultDocument = mutateDocument(
            diagnosedIgnore.cases[1].resultDocument, record => { record.candidateExited = false; });
        assert.throws(() => invoke("AssessMatrix", diagnosedIgnore),
            /Ignore case result differs: status=failed,pass=0,forced=1,grace=1,ctrl=1,pair=1,job=0,consoleFree=1,handles=1,exited=0,exit=197,close=1/u);

        const rawDrift = {manifestDocument: structuredClone(value.manifestDocument),
            case: structuredClone(value.cases[0])};
        rawDrift.case.readyDocument.bytesBase64 = rawDrift.case.readyDocument.bytesBase64.slice(0, -4) + "AAAA";
        assert.throws(() => invoke("ValidateCase", rawDrift), /ready|hash|bytes|JSON/i);
    });

    powershellIt("recomputes outer-launcher and producer-summary evidence", () => {
        const expectedAbi = invoke("GetContract").abiExpected;
        const value = matrixValue(expectedAbi);
        assert.equal(invoke("AssessMatrix", value).allCasesObserved, true);

        const fractional = boundCaseValue("handler", expectedAbi);
        fractional.case.outerLauncherDocument = mutateDocument(fractional.case.outerLauncherDocument, record => {
            for (const name of Object.keys(record.timing)) record.timing[name] += 0.25;
            record.observer.firstMonotonicMilliseconds += 0.25;
            record.observer.lastMonotonicMilliseconds += 0.25;
        });
        assert.equal(invoke("ValidateCase", fractional).classification, "handler-natural-exit-observed");
        for (const invalidClock of ["1000", true]) {
            const invalid = boundCaseValue("handler", expectedAbi);
            invalid.case.outerLauncherDocument = mutateDocument(invalid.case.outerLauncherDocument,
                record => { record.timing.initialMonotonicMilliseconds = invalidClock; });
            assert.throws(() => invoke("ValidateCase", invalid), /finite number/i);
        }
        const wrongExit = boundCaseValue("handler", expectedAbi);
        wrongExit.case.outerLauncherDocument = mutateDocument(wrongExit.case.outerLauncherDocument,
            record => { record.exitCode = 1; });
        assert.throws(() => invoke("ValidateCase", wrongExit), /actual=1; expected=0/u);
        for (const mutate of [
            item => { item.cases[0].outerLauncherDocument = mutateDocument(
                item.cases[0].outerLauncherDocument, record => { record.process.retainedHandleThroughExit = false; }); },
            item => { item.cases[1].outerLauncherDocument = mutateDocument(
                item.cases[1].outerLauncherDocument, record => { record.exitCode = 0; }); },
            item => { item.cases[0].outerLauncherDocument = mutateDocument(
                item.cases[0].outerLauncherDocument, record => {
                    record.observer.firstMonotonicMilliseconds = record.timing.lastMonotonicMilliseconds + 1;
                }); },
            item => { item.cases[0].outerLauncherDocument = mutateDocument(
                item.cases[0].outerLauncherDocument, record => {
                    record.timing.postReturnMonotonicMilliseconds = record.timing.monotonicDeadlineMilliseconds;
                }); },
            item => { item.summaryDocument = mutateDocument(item.summaryDocument,
                record => { record.cases[0].resultSha256 = "1".repeat(64); }); }
        ]) {
            const changed = structuredClone(value); mutate(changed);
            assert.throws(() => invoke("AssessMatrix", changed), /outer|launcher|summary|binding|exit/i);
        }
    });

});
