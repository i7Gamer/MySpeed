import {describe, it} from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(ROOT, "../../scripts/qualification/windows-native-candidate-controller.ps1");
const CLEAN_SCRIPT = path.resolve(ROOT, "../../scripts/qualification/windows-clean-stop-controller.ps1");
const POWERSHELL = (process.env.SystemRoot || "C:\\Windows")
    + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const TEST_TIMEOUT_MS = 30_000;
const MAXIMUM_CANDIDATE_BYTES = 536_870_912;
const HASH = "a".repeat(64);
const NONCE = "b".repeat(32);
const TASK_ROOT = `C:\\a\\_temp\\myspeed-native-candidate-${NONCE}`;
const powershellAvailable = process.platform === "win32" && fs.existsSync(POWERSHELL);
const powershellIt = (name, body) => (powershellAvailable ? it : it.skip)(name,
    {timeout: TEST_TIMEOUT_MS}, body);

const request = (scenario = "populated-first-boot") => ({
    schemaVersion: 1,
    kind: "myspeed-windows-native-candidate-request",
    expectedRunId: "12345",
    expectedRunAttempt: "2",
    expectedEventSha: "c".repeat(40),
    expectedSourceSha: "d".repeat(40),
    expectedImageVersion: "20260907.229.1",
    nonce: NONCE,
    manifestSha256: HASH,
    alias: "default",
    artifactLogicalName: "MySpeed-windows-x64.exe",
    scenario,
    taskRoot: TASK_ROOT,
    candidatePath: `${TASK_ROOT}\\MySpeed.exe`,
    candidateSha256: HASH,
    candidateVolumeSerial: "89abcdef",
    candidateFileId: "0123456789abcdef",
    workingDirectory: `${TASK_ROOT}\\work`,
    arguments: scenario === "fresh-no-config-reset" ? ["--reset-password"] : [],
    environment: {
        PATH: "C:\\Windows\\System32",
        SystemRoot: "C:\\Windows",
        NODE_ENV: "production",
        DB_TYPE: "sqlite",
        SERVER_HOST: "127.0.0.1",
        SERVER_PORT: "17439",
        RUN_TEST_ON_STARTUP: "false"
    },
    stdoutPath: `${TASK_ROOT}\\candidate.stdout.log`,
    stderrPath: `${TASK_ROOT}\\candidate.stderr.log`,
    readyPath: `${TASK_ROOT}\\candidate.ready.json`,
    stopRequestPath: `${TASK_ROOT}\\candidate.stop.json`,
    resultPath: `${TASK_ROOT}\\candidate.result.json`,
    controllerPath: `${TASK_ROOT}\\windows-clean-stop-controller.ps1`,
    controllerSha256: HASH,
    normalDeadlineMs: 300_000,
    hardDeadlineMs: 310_000,
    stopRequestTimeoutMs: 240_000,
    stopRequestPollMs: 50,
    gracefulExitTimeoutMs: 30_000,
    forcedCleanupTimeoutMs: 10_000
});
const lifecycle = (scenario = "populated-first-boot", overrides = {}) => ({
    request: request(scenario),
    clock: [0, 10, 20, 30, 40, 50, 60],
    stopAvailable: scenario !== "fresh-no-config-reset",
    stopReadNulls: 0,
    launch: {
        candidatePid: 4242,
        candidateCreationTime: "0123456789abcdef",
        candidateImagePath: `${TASK_ROOT}\\MySpeed.exe`,
        candidateSha256: HASH,
        candidateVolumeSerial: "89abcdef",
        candidateFileId: "0123456789abcdef",
        candidateCreatedSuspended: true,
        privateConsoleRequested: true,
        handleListConfigured: true,
        jobAssignedBeforeResume: true,
        initialJobMembership: true,
        candidateIdentityCaptured: true,
        candidateResumed: true,
        threadHandleClosedBeforeReady: true
    },
    stop: scenario === "fresh-no-config-reset" ? null : {
        schemaVersion: 1,
        kind: "myspeed-windows-native-candidate-stop",
        nonce: NONCE,
        manifestSha256: HASH,
        alias: "default",
        scenario,
        candidatePid: 4242,
        candidateCreationTime: "0123456789abcdef"
    },
    nativeResult: {
        forced: false,
        preAttachIdentityMatch: scenario !== "fresh-no-config-reset",
        postAttachHandleUnsignaled: scenario !== "fresh-no-config-reset",
        postAttachIdentityMatch: scenario !== "fresh-no-config-reset",
        postAttachJobMembership: scenario !== "fresh-no-config-reset",
        consoleProcessIdsExact: scenario !== "fresh-no-config-reset",
        ctrlEventGenerated: scenario !== "fresh-no-config-reset",
        candidateExited: true,
        graceExpired: false,
        exitCode: scenario === "fresh-no-config-reset" ? 113 : 0,
        jobZero: true,
        consoleFreeAfter: true,
        handlesClosed: false
    },
    activeProcesses: 0,
    handlesClosed: true,
    ...overrides
});

const invoke = (mode, value = null) => {
    const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", SCRIPT, "-Mode", mode];
    if (value !== null) args.push("-InputJson", JSON.stringify(value));
    const result = childProcess.spawnSync(POWERSHELL, args, {encoding: "utf8", timeout: TEST_TIMEOUT_MS});
    assert.equal(result.error, undefined, result.error?.message);
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return JSON.parse(result.stdout);
};

describe("Windows native candidate controller", () => {
    it("is source-inert and fixed to the two aliases and three scenarios", () => {
        const source = fs.readFileSync(SCRIPT, "utf8");
        assert.match(source, /InvokeHostedCandidate/u);
        assert.match(source, /Assert-MyspeedCandidateHostedContext[^]*before request I\/O/u);
        assert.match(source, /MySpeed\.Qualification\.CleanStop\.Session/u);
        assert.match(source, /launch=\{[\s\S]*?\$environment=\[Collections\.Generic\.Dictionary\[string,string\]\]::new\(\[StringComparer\]::Ordinal\)[\s\S]*?\$environment\.Add\(\$property\.Name,\[string\]\$property\.Value\)[\s\S]*?Session\]::Launch\([^\r\n]+\$environment,/u,
            "the candidate callback must pass the exact generic IDictionary expected by Session.Launch");
        assert.doesNotMatch(source, /Start-Process|Stop-Process|netstat/u);
    });

    it("uses the trusted clean-stop retained-handle candidate identity seam", () => {
        const controller = fs.readFileSync(SCRIPT, "utf8");
        const cleanStop = fs.readFileSync(CLEAN_SCRIPT, "utf8");
        assert.match(controller,
            /function Get-MyspeedCandidateFileIdentity[\s\S]*Session\]::InspectCandidate\(\$canonical,\$sha,\$maximum\)/u);
        assert.match(cleanStop, /public static CandidateFileIdentity InspectCandidate/u);
        assert.match(cleanStop, /new FileStream\(canonical,FileMode\.Open,FileAccess\.Read,FileShare\.Read\)/u);
        assert.match(cleanStop, /GetFileInformationByHandle\(stream\.SafeFileHandle\.DangerousGetHandle\(\),out info\)/u);
        assert.match(cleanStop, /GetFinalPathNameByHandle\(h,b,\(uint\)b\.Capacity,0\)/u);
        assert.match(cleanStop, /algorithm\.ComputeHash\(stream\)/u);
        assert.match(cleanStop, /stream\.Length!=before\|\|stream\.Position!=before/u);
    });

    powershellIt("strictly validates the candidate identity returned by the retained native handle", () => {
        const identity = {path: "C:\\owned\\MySpeed.exe", finalPath: "C:\\owned\\MySpeed.exe", bytes: 85_000_000,
            sha256: HASH, volumeSerial: "89abcdef", fileId: "0123456789abcdef", linkCount: 1,
            isRegular: true, reparsePoint: false};
        const fixture = {path: identity.path, expectedSha256: HASH, maximumBytes: MAXIMUM_CANDIDATE_BYTES,
            observation: identity};
        assert.equal(invoke("ValidateFileIdentity", fixture).sha256, HASH);
        for (const mutate of [
            value => { value.observation.path += ".stale"; },
            value => { value.observation.finalPath += ".stale"; },
            value => { value.observation.bytes = value.maximumBytes + 1; },
            value => { value.observation.sha256 = "0".repeat(64); },
            value => { value.observation.volumeSerial = "0"; },
            value => { value.observation.fileId = "0"; },
            value => { value.observation.linkCount = 2; },
            value => { value.observation.isRegular = false; },
            value => { value.observation.reparsePoint = true; },
            value => { value.observation.extra = true; },
            value => { value.maximumBytes = MAXIMUM_CANDIDATE_BYTES + 1; }
        ]) {
            const changed = structuredClone(fixture);
            mutate(changed);
            assert.throws(() => invoke("ValidateFileIdentity", changed));
        }
    });

    powershellIt("binds empty and nonempty environment values to generic IDictionary", () => {
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

    powershellIt("exports one inert native-operation factory shared by hosted and guest wrappers", () => {
        const source = fs.readFileSync(SCRIPT, "utf8");
        assert.match(source, /function New-MyspeedCandidateNativeOperations/u);
        assert.match(source, /\$operations=New-MyspeedCandidateNativeOperations \$request \$watch/u);
        const command = `. '${SCRIPT.replaceAll("'", "''")}' -Mode Library;` +
            `$operations=New-MyspeedCandidateNativeOperations ([pscustomobject]@{scenario='populated-first-boot';` +
            `candidatePath='C:\\candidate.exe';candidateSha256='${HASH}';candidateVolumeSerial='89abcdef';` +
            `candidateFileId='0123456789abcdef';arguments=@();workingDirectory='C:\\work';environment=[pscustomobject]@{};` +
            `stdoutPath='C:\\stdout';stderrPath='C:\\stderr';readyPath='C:\\ready';stopRequestPath='C:\\stop'}) ` +
            `([Diagnostics.Stopwatch]::StartNew());` +
            `[Console]::Out.Write((@($operations.PSObject.Properties.Name) -join ','))`;
        const result = childProcess.spawnSync(POWERSHELL,
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
            {encoding: "utf8", timeout: TEST_TIMEOUT_MS});
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout,
            "elapsed,assertConsoleFree,launch,writeReady,stopExists,readStop,sleep,stop,lastResult,active,force,close");
    });

    powershellIt("captures cleanup limits and retries only sharing violations in native callbacks", () => {
        const command = `. '${SCRIPT.replaceAll("'", "''")}' -Mode Library; `
            + "function Read-MyspeedCandidateJson { throw [IO.IOException]::new('injected-io', $global:QualificationHResult) }; "
            + "$operations=New-MyspeedCandidateNativeOperations ([pscustomobject]@{stopRequestPath='C:\\unused'}) "
            + "([Diagnostics.Stopwatch]::StartNew()); $global:QualificationHResult=-2147024864; "
            + "$sharingIsNull=$null -eq (& $operations.readStop); $global:QualificationHResult=-2147024894; "
            + "$otherRaised=$false; try { & $operations.readStop } catch { "
            + "if($_.Exception.Message -cne 'injected-io'){throw}; $otherRaised=$true }; "
            + "[pscustomobject]@{limits=$operations.launch.Module.SessionState.PSVariable.GetValue('limits'); "
            + "sharingIsNull=$sharingIsNull;otherRaised=$otherRaised}|ConvertTo-Json -Compress";
        const result = childProcess.spawnSync(POWERSHELL,
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
            {encoding: "utf8", timeout: TEST_TIMEOUT_MS, windowsHide: true});
        assert.equal(result.status, 0, result.stderr);
        const observed = JSON.parse(result.stdout);
        assert.deepEqual(observed, {limits: {hardDeadlineMs: 310_000, cleanupMs: 10_000,
            win32CodeMask: 65_535, sharingViolationCode: 32}, sharingIsNull: true, otherRaised: true});
    });

    powershellIt("validates exact request identity and sanitized environment", () => {
        const accepted = invoke("ValidateRequest", request());
        assert.equal(accepted.artifactLogicalName, "MySpeed-windows-x64.exe");
        for (const mutate of [
            value => { value.artifactLogicalName = "myspeed-windows-x64.exe"; },
            value => { value.alias = "baseline"; },
            value => { value.environment.HTTP_PROXY = "http://proxy"; },
            value => { value.environment.SERVER_HOST = "0.0.0.0"; },
            value => { value.arguments = ["--reset-password"]; },
            value => { value.arguments = ["--port", "17439"]; },
            value => { value.readyPath = value.resultPath; }
        ]) {
            const changed = structuredClone(request());
            mutate(changed);
            assert.throws(() => invoke("ValidateRequest", changed));
        }
        const baseline = request();
        baseline.alias = "baseline";
        baseline.artifactLogicalName = "MySpeed-windows-x64-baseline.exe";
        assert.equal(invoke("ValidateRequest", baseline).alias, "baseline");
        const highPort = request();
        highPort.environment.SERVER_PORT = "65499";
        assert.equal(invoke("ValidateRequest", highPort).environment.SERVER_PORT, "65499");
        highPort.environment.SERVER_PORT = "65536";
        assert.throws(() => invoke("ValidateRequest", highPort));
    });

    powershellIt("uses one lifecycle for Ctrl+C and natural reset exit", () => {
        for (const scenario of ["populated-first-boot", "populated-restart", "fresh-no-config-reset"]) {
            const result = invoke("TestLifecycle", lifecycle(scenario));
            assert.equal(result.status, "completed");
            assert.equal(result.qualifying, false);
            assert.deepEqual(result.releaseGatesCleared, []);
            assert.equal(result.scenario, scenario);
            assert.equal(result.stopKind, scenario === "fresh-no-config-reset" ? "observed-exit" : "ctrl-c");
            assert.equal(result.exitCode, scenario === "fresh-no-config-reset" ? 113 : 0);
        }
    });

    powershellIt("fails every lifecycle proof and retains bounded cleanup truth", () => {
        const mutations = [
            value => { value.nativeResult.forced = true; },
            value => { value.nativeResult.candidateExited = false; },
            value => { value.nativeResult.exitCode = 1; },
            value => { value.nativeResult.jobZero = false; },
            value => { value.nativeResult.consoleFreeAfter = false; },
            value => { value.launch.threadHandleClosedBeforeReady = false; },
            value => { value.activeProcesses = 1; },
            value => { value.handlesClosed = false; },
            value => { value.clock[6] = 300_001; }
        ];
        for (const mutate of mutations) {
            const value = lifecycle();
            mutate(value);
            const result = invoke("TestLifecycle", value);
            assert.equal(result.status, "failed");
            assert.equal(result.qualifying, false);
            if (value.launch.threadHandleClosedBeforeReady === false) {
                assert.equal(result.handleCleanupAttempted, true);
                assert.equal(result.handlesClosed, true);
                assert.equal(result.processTreeExitProven, true);
            }
        }
    });

    powershellIt("rejects stop identity drift and stop files in natural-exit mode", () => {
        const drift = lifecycle();
        drift.stop.candidatePid += 1;
        assert.equal(invoke("TestLifecycle", drift).status, "failed");
        assert.equal(invoke("TestLifecycle", lifecycle("fresh-no-config-reset", {stopAvailable: true})).status, "failed");
        const forgedCtrl = lifecycle("fresh-no-config-reset");
        forgedCtrl.nativeResult.preAttachIdentityMatch = true;
        assert.equal(invoke("TestLifecycle", forgedCtrl).status, "failed");
        assert.equal(invoke("TestLifecycle", lifecycle("populated-first-boot", {stopReadNulls: 1})).status,
            "completed");
        const lateStopRead = lifecycle("populated-first-boot", {stopReadNulls: 1});
        lateStopRead.clock = [0, 10, 20, 60_000, 60_001, 299_999, 300_000];
        assert.equal(invoke("TestLifecycle", lateStopRead).status, "failed");
        const setupExpired = lifecycle();
        setupExpired.clock = setupExpired.clock.map(() => 300_000);
        const setupResult = invoke("TestLifecycle", setupExpired);
        assert.equal(setupResult.status, "failed");
        assert.equal(setupResult.handleCleanupAttempted, false);
    });

    powershellIt("rejects the native entry locally before request I/O or native setup", () => {
        const missing = path.join(ROOT, "must-not-be-read.json");
        const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", SCRIPT,
            "-Mode", "InvokeHostedCandidate", "-RequestPath", missing];
        const result = childProcess.spawnSync(POWERSHELL, args, {encoding: "utf8", timeout: TEST_TIMEOUT_MS});
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Hosted context/u);
        assert.doesNotMatch(result.stderr, /must-not-be-read|Add-Type/u);
    });
});
