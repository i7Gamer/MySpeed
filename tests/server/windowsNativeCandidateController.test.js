import {describe, it} from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(ROOT, "../../scripts/qualification/windows-native-candidate-controller.ps1");
const CLEAN_SCRIPT = path.resolve(ROOT, "../../scripts/qualification/windows-clean-stop-controller.ps1");
const POWERSHELL = (process.env.SystemRoot || "C:\\Windows")
    + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const TEST_TIMEOUT_MS = 30_000;
const MAXIMUM_CANDIDATE_BYTES = 536_870_912;
const MAXIMUM_FAILURE_CHARACTERS = 512;
const NATIVE_RESULT_FIELD_COUNT = 13;
const FIRST_PRINTABLE_CHARACTER_CODE = 32;
const DELETE_CHARACTER_CODE = 127;
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

const invokeTrustedRequest = (value, runnerTemp = "C:\\a\\_temp") => {
    const encoded = Buffer.from(JSON.stringify(value), "utf8").toString("base64");
    const command = `. '${SCRIPT.replaceAll("'", "''")}' -Mode Library;`
        + `$json=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));`
        + `$value=ConvertFrom-MyspeedCandidateJson $json 'Candidate fixture';`
        + `[void](Assert-MyspeedCandidateRequest $value '${runnerTemp.replaceAll("'", "''")}');`
        + "$value|ConvertTo-Json -Depth 30 -Compress";
    const result = childProcess.spawnSync(POWERSHELL,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
        {encoding: "utf8", timeout: TEST_TIMEOUT_MS, windowsHide: true});
    assert.equal(result.error, undefined, result.error?.message);
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return JSON.parse(result.stdout);
};

const validateTrustedRequests = (values, runnerTemp = "C:\\a\\_temp") => {
    const encoded = Buffer.from(JSON.stringify({values}), "utf8").toString("base64");
    const command = `. '${SCRIPT.replaceAll("'", "''")}' -Mode Library;`
        + `$json=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));`
        + "$values=@((ConvertFrom-MyspeedCandidateJson $json 'Candidate fixtures').values);$results=@();"
        + "foreach($value in $values){try{[void](Assert-MyspeedCandidateRequest $value "
        + `'${runnerTemp.replaceAll("'", "''")}');$results+=$true}catch{$results+=$false}};`
        + "[pscustomobject]@{results=[object[]]$results}|ConvertTo-Json -Compress";
    const result = childProcess.spawnSync(POWERSHELL,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
        {encoding: "utf8", timeout: TEST_TIMEOUT_MS, windowsHide: true});
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).results;
};

const invokeTrustedLifecycle = (value, runnerTemp = "C:\\a\\_temp") => {
    const encoded = Buffer.from(JSON.stringify(value), "utf8").toString("base64");
    const command = `. '${SCRIPT.replaceAll("'", "''")}' -Mode Library;`
        + `$json=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));`
        + `$value=ConvertFrom-MyspeedCandidateJson $json 'Candidate lifecycle fixture';`
        + `Invoke-MyspeedCandidateInjectedLifecycle $value '${runnerTemp.replaceAll("'", "''")}'|`
        + "ConvertTo-Json -Depth 30 -Compress";
    const result = childProcess.spawnSync(POWERSHELL,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
        {encoding: "utf8", timeout: TEST_TIMEOUT_MS, windowsHide: true});
    assert.equal(result.error, undefined, result.error?.message);
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return JSON.parse(result.stdout);
};

const derivedNonce = (...parts) => crypto.createHash("sha256").update(parts.join("\0"), "utf8")
    .digest("hex").slice(0, 32);

const standaloneRequest = (alias, scenario) => {
    const value = request(scenario);
    value.alias = alias;
    value.artifactLogicalName = alias === "default" ? "MySpeed-windows-x64.exe" : "MySpeed-windows-x64-baseline.exe";
    const executionNonce = derivedNonce(value.expectedRunId, value.expectedRunAttempt, value.expectedEventSha);
    value.nonce = derivedNonce(executionNonce, alias, scenario);
    value.taskRoot = `C:\\a\\_temp\\myspeed-native-candidate-${value.nonce}`;
    const suffix = scenario === "fresh-no-config-reset" ? "reset" : "populated";
    value.workingDirectory = `C:\\a\\_temp\\myspeed-native-standalone-${executionNonce}\\fixture-${alias}-${suffix}`;
    for (const [name, leaf] of [["candidatePath", "MySpeed.exe"], ["stdoutPath", "candidate.stdout.log"],
        ["stderrPath", "candidate.stderr.log"], ["readyPath", "candidate.ready.json"],
        ["stopRequestPath", "candidate.stop.json"], ["resultPath", "candidate.result.json"],
        ["controllerPath", "windows-clean-stop-controller.ps1"]]) value[name] = `${value.taskRoot}\\${leaf}`;
    return value;
};

const standaloneLifecycle = (alias, scenario) => {
    const value = lifecycle(scenario);
    value.request = standaloneRequest(alias, scenario);
    if (value.stop) {
        value.stop.nonce = value.request.nonce;
        value.stop.alias = alias;
    }
    value.launch.candidateImagePath = value.request.candidatePath;
    return value;
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

    powershellIt("shapes native stop and lastResult results into psobject evidence in Windows PowerShell 5.1", () => {
        // In Windows PowerShell 5.1 a CLR object returned via a method call or property getter does NOT
        // satisfy `-is [psobject]`, so the raw NativeResult from Session.Stop()/LastResult is rejected by
        // Assert-MyspeedCandidateNativeShape ("must be an object"). The stop/lastResult operations must
        // rebuild the shape as a [pscustomobject], mirroring the launch operation.
        const nativeSource = [
            "namespace MySpeedNativeResultProof {",
            "  public sealed class Result {",
            "    public bool forced,preAttachIdentityMatch,postAttachHandleUnsignaled,postAttachIdentityMatch,postAttachJobMembership;",
            "    public bool consoleProcessIdsExact,ctrlEventGenerated,candidateExited,graceExpired,jobZero,consoleFreeAfter,handlesClosed;",
            "    public int exitCode; public uint[] consoleProcessIds; public uint candidatePid;",
            "    public static Result Make(){",
            "      Result r=new Result();",
            "      r.candidateExited=true; r.jobZero=true; r.consoleFreeAfter=true; r.exitCode=0;",
            "      r.preAttachIdentityMatch=r.postAttachHandleUnsignaled=r.postAttachIdentityMatch=true;",
            "      r.postAttachJobMembership=r.consoleProcessIdsExact=r.ctrlEventGenerated=true;",
            "      r.consoleProcessIds=new uint[0]; r.candidatePid=4321; return r;",
            "    }",
            "  }",
            "  public sealed class Session {",
            "    public Result Stop(uint a,uint b,uint c){return Result.Make();}",
            "    public Result LastResult{get{return Result.Make();}}",
            "  }",
            "}"
        ].join("\n");
        const command = [
            `$source=@'`,
            nativeSource,
            `'@`,
            "Add-Type -TypeDefinition $source -Language CSharp",
            `. '${SCRIPT.replaceAll("'", "''")}' -Mode Library`,
            "$request=[pscustomobject]@{scenario='populated-first-boot';stopRequestPath='C:\\unused'}",
            "$operations=New-MyspeedCandidateNativeOperations $request ([Diagnostics.Stopwatch]::StartNew())",
            "$state=$operations.stop.Module.SessionState.PSVariable.GetValue('nativeState')",
            "$state.session=[MySpeedNativeResultProof.Session]::new()",
            "$stopResult=& $operations.stop $null 100 100",
            "$lastResult=& $operations.lastResult $null",
            "function Test-Shape($value){try{[void](Assert-MyspeedCandidateNativeShape $value);return $null}"
                + "catch{return $_.Exception.Message}}",
            "[pscustomobject]@{",
            "  rawIsPsObject=([MySpeedNativeResultProof.Session]::new().Stop(1,1,1) -is [psobject]);",
            "  stopIsPsObject=($stopResult -is [psobject]);stopKeys=@($stopResult.PSObject.Properties.Name).Count;",
            "  stopShapeError=(Test-Shape $stopResult);",
            "  lastIsPsObject=($lastResult -is [psobject]);lastKeys=@($lastResult.PSObject.Properties.Name).Count;",
            "  lastShapeError=(Test-Shape $lastResult)",
            "}|ConvertTo-Json -Compress"
        ].join("\n");
        const result = childProcess.spawnSync(POWERSHELL,
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
            {encoding: "utf8", timeout: TEST_TIMEOUT_MS, windowsHide: true});
        assert.equal(result.status, 0, result.stderr);
        const observed = JSON.parse(result.stdout);
        assert.equal(observed.rawIsPsObject, false);
        assert.equal(observed.stopIsPsObject, true);
        assert.equal(observed.stopKeys, NATIVE_RESULT_FIELD_COUNT);
        assert.equal(observed.stopShapeError, null);
        assert.equal(observed.lastIsPsObject, true);
        assert.equal(observed.lastKeys, NATIVE_RESULT_FIELD_COUNT);
        assert.equal(observed.lastShapeError, null);
    });

    it("routes native stop and lastResult through one shared native-result shaper", () => {
        const source = fs.readFileSync(SCRIPT, "utf8");
        assert.match(source, /function ConvertTo-MyspeedCandidateNativeResult/u);
        assert.match(source, /\$toNativeResult=\$\{function:ConvertTo-MyspeedCandidateNativeResult\}/u);
        assert.match(source, /stop=\{[\s\S]*?& \$toNativeResult/u);
        assert.match(source, /lastResult=\{[\s\S]*?& \$toNativeResult/u);
    });

    powershellIt("keeps JSON callbacks bound in script and dynamic-module callers", () => {
        const escapedScript = SCRIPT.replaceAll("'", "''");
        const command = `$scriptPath='${escapedScript}';`
            + "$root=Join-Path ([IO.Path]::GetTempPath()) ('myspeed-candidate-callbacks-'+[guid]::NewGuid().ToString('N'));"
            + "[void](New-Item -ItemType Directory -Path $root);try{"
            + "$candidate=[scriptblock]::Create([IO.File]::ReadAllText($scriptPath));"
            + "$module=New-Module -ScriptBlock {param($trusted). $trusted -Mode Library;"
            + "Export-ModuleMember -Function New-MyspeedCandidateNativeOperations} -ArgumentList $candidate;"
            + "$moduleRequest=[pscustomobject]@{readyPath=(Join-Path $root 'module-ready.json');"
            + "stopRequestPath=(Join-Path $root 'module-stop.json');scenario='populated-first-boot'};"
            + "$moduleResult=& $module {param($req)Write-MyspeedCandidateJson $req.stopRequestPath "
            + "([ordered]@{source='module-stop'});$operations=New-MyspeedCandidateNativeOperations $req "
            + "([Diagnostics.Stopwatch]::StartNew());& $operations.writeReady ([ordered]@{source='module-ready'});"
            + "return (& $operations.readStop)} $moduleRequest;"
            + "Remove-Module $module -Force;$module=$null;. $scriptPath -Mode Library;"
            + "$directRequest=[pscustomobject]@{readyPath=(Join-Path $root 'direct-ready.json');"
            + "stopRequestPath=(Join-Path $root 'direct-stop.json');scenario='populated-first-boot'};"
            + "Write-MyspeedCandidateJson $directRequest.stopRequestPath ([ordered]@{source='direct-stop'});"
            + "$direct=New-MyspeedCandidateNativeOperations $directRequest ([Diagnostics.Stopwatch]::StartNew());"
            + "& $direct.writeReady ([ordered]@{source='direct-ready'});$directStop=& $direct.readStop;"
            + "[pscustomobject]@{directReady=(Get-Content -LiteralPath $directRequest.readyPath -Raw|ConvertFrom-Json).source;"
            + "directStop=$directStop.source;moduleReady=(Get-Content -LiteralPath $moduleRequest.readyPath -Raw|ConvertFrom-Json).source;"
            + "moduleStop=$moduleResult.source}|ConvertTo-Json -Compress"
            + "}finally{if($null -ne $module){Remove-Module $module -Force -ErrorAction SilentlyContinue};"
            + "Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue}";
        const result = childProcess.spawnSync(POWERSHELL,
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
            {encoding: "utf8", timeout: TEST_TIMEOUT_MS, windowsHide: true});
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), {directReady: "direct-ready", directStop: "direct-stop",
            moduleReady: "module-ready", moduleStop: "module-stop"});
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

    powershellIt("authorizes only the context-derived shared standalone fixture", () => {
        const accepted = ["default", "baseline"].flatMap(alias =>
            ["populated-first-boot", "populated-restart", "fresh-no-config-reset"]
                .map(scenario => standaloneRequest(alias, scenario)));
        assert.throws(() => invoke("ValidateRequest", accepted[0]), /outside task root/u,
            "the public validation mode must not grant hosted sibling authority");
        assert.deepEqual(validateTrustedRequests(accepted), accepted.map(() => true));
        assert.equal(accepted[0].workingDirectory, accepted[1].workingDirectory,
            "first boot and restart must share one populated database");
        assert.equal(accepted[3].workingDirectory, accepted[4].workingDirectory,
            "each alias must share its own populated database");
        assert.equal(invokeTrustedLifecycle(standaloneLifecycle("default", "populated-first-boot")).status,
            "completed", "the lifecycle's second validation pass must retain trusted runner authority");

        const rejected = [
            value => { value.workingDirectory += "-escape"; },
            value => { value.workingDirectory = value.workingDirectory.replace("fixture-default", "fixture-baseline"); },
            value => { value.workingDirectory = value.workingDirectory.replace("-populated", "-reset"); },
            value => { value.workingDirectory = value.workingDirectory.replace("myspeed-native-standalone-", "other-"); },
            value => { value.workingDirectory += "\\..\\fixture-default-populated"; },
            value => { value.expectedRunId = "54321"; },
            value => { value.expectedRunAttempt = "3"; },
            value => { value.expectedEventSha = "e".repeat(40); },
            value => { value.nonce = "f".repeat(32); },
            value => {
                const original = value.taskRoot;
                value.taskRoot = value.taskRoot.replace("myspeed-native-candidate-", "other-");
                for (const name of ["candidatePath", "stdoutPath", "stderrPath", "readyPath", "stopRequestPath",
                    "resultPath", "controllerPath"]) value[name] = value[name].replace(original, value.taskRoot);
            }
        ];
        const rejectedValues = rejected.map(mutate => {
            const value = standaloneRequest("default", "populated-first-boot");
            mutate(value);
            return value;
        });
        assert.deepEqual(validateTrustedRequests(rejectedValues), rejectedValues.map(() => false));
        assert.throws(() => invokeTrustedRequest(standaloneRequest("default", "populated-first-boot"),
            "C:\\a\\other"), /nonce differs/u, "stale runner authority must not grant a sibling path");
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
            assert.equal(Object.hasOwn(result, "failureDetails"), false);
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

    powershellIt("retains bounded lifecycle and cleanup failure details without changing passing results", () => {
        const lifecycleFailure = lifecycle();
        lifecycleFailure.launch.threadHandleClosedBeforeReady = false;
        const failedLifecycle = invoke("TestLifecycle", lifecycleFailure);
        assert.deepEqual(failedLifecycle.failureDetails, [{phase: "lifecycle",
            failure: "Candidate launch proof failed"}]);

        const cleanupFailure = lifecycle("populated-first-boot", {activeProcesses: 1});
        cleanupFailure.clock = [0, 10, 20, 30, 40, 50, 60, 310_001, 310_001];
        const failedCleanup = invoke("TestLifecycle", cleanupFailure);
        assert.equal(failedCleanup.failureDetails.some(detail => detail.phase === "cleanup"
            && detail.failure === "Candidate cleanup deadline expired"), true);

        const command = `. '${SCRIPT.replaceAll("'", "''")}' -Mode Library; `
            + "$raw='line'+[char]0+\"one`r`n\"+('x'*700); "
            + "$value=Get-MyspeedCandidateFailureMessage $raw; "
            + "$value|ConvertTo-Json -Compress";
        const bounded = childProcess.spawnSync(POWERSHELL,
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
            {encoding: "utf8", timeout: TEST_TIMEOUT_MS});
        assert.equal(bounded.status, 0, bounded.stderr);
        const message = JSON.parse(bounded.stdout);
        assert.equal(message.length, MAXIMUM_FAILURE_CHARACTERS);
        assert.equal([...message].some(character => character.charCodeAt(0) < FIRST_PRINTABLE_CHARACTER_CODE
            || character.charCodeAt(0) === DELETE_CHARACTER_CODE), false);
    });

    powershellIt("reports the bounded primary lifecycle failure only after durable result publication", () => {
        const source = fs.readFileSync(SCRIPT, "utf8");
        assert.match(source,
            /Write-MyspeedCandidateJson \$request\.resultPath \$result[\s\S]*throw \(Get-MyspeedCandidateLifecycleFailure/u);
        const command = `. '${SCRIPT.replaceAll("'", "''")}' -Mode Library; `
            + "$primary='first'+[char]0+[char]0x00fc+" + '"`r`n"' + "+('x'*700);"
            + "$failed=[pscustomobject]@{status='failed';failureDetails=[object[]]@("
            + "[pscustomobject]@{phase='lifecycle';failure=$primary},"
            + "[pscustomobject]@{phase='cleanup';failure='secondary-cleanup'})};"
            + "$message=Get-MyspeedCandidateLifecycleFailure $failed;"
            + "$malformed=[object[]]@($null,[pscustomobject]@{status='completed'},"
            + "[pscustomobject]@{status='failed';failureDetails=@()},"
            + "[pscustomobject]@{status='failed';failureDetails=[object[]]@([pscustomobject]@{phase='lifecycle'})},"
            + "[pscustomobject]@{status='failed';failureDetails=[object[]]@([pscustomobject]@{phase='';failure='x'})},"
            + "[pscustomobject]@{status='failed';failureDetails=[object[]]@([pscustomobject]@{phase='lifecycle';failure=''})});"
            + "$rejected=0;foreach($value in $malformed){try{Get-MyspeedCandidateLifecycleFailure $value|Out-Null}"
            + "catch{$rejected++}};[pscustomobject]@{messageBase64=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($message));"
            + "rejected=$rejected}|ConvertTo-Json -Compress";
        const result = childProcess.spawnSync(POWERSHELL,
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
            {encoding: "utf8", timeout: TEST_TIMEOUT_MS, windowsHide: true});
        assert.equal(result.status, 0, result.stderr);
        const observed = JSON.parse(result.stdout);
        const message = Buffer.from(observed.messageBase64, "base64").toString("utf8");
        assert.equal(message.length, MAXIMUM_FAILURE_CHARACTERS);
        assert.match(message, /^Hosted candidate lifecycle did not pass: lifecycle: first ü /u);
        assert.doesNotMatch(message, /secondary-cleanup/u);
        assert.equal([...message].some(character => character.charCodeAt(0) < FIRST_PRINTABLE_CHARACTER_CODE
            || character.charCodeAt(0) === DELETE_CHARACTER_CODE), false);
        assert.equal(observed.rejected, 6);
        assert.equal(Object.hasOwn(invoke("TestLifecycle", lifecycle()), "failureDetails"), false,
            "successful lifecycle output must remain unchanged");
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

    powershellIt("normalizes initial console via trusted dynamic module preserving scope and state rules", () => {
        const invokeInjectedConsole = fixture => {
            const encoded = Buffer.from(JSON.stringify(fixture), "utf8").toString("base64");
            const command = `. '${SCRIPT.replaceAll("'", "''")}' -Mode Library; `
                + `. '${CLEAN_SCRIPT.replaceAll("'", "''")}' -Mode Library; `
                + `$cleanText=[IO.File]::ReadAllText('${CLEAN_SCRIPT.replaceAll("'", "''")}'); `
                + "$cleanScript=[scriptblock]::Create($cleanText); "
                + "$mod=New-Module -ScriptBlock {param($s);. $s -Mode Library;Export-ModuleMember -Function Get-MyspeedCleanNativeSource,Invoke-MyspeedCleanInitialConsoleCore} -ArgumentList $cleanScript; "
                + `$json=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); `
                + "$inputVal=ConvertFrom-MyspeedCandidateJson $json 'Initial console fixture'; "
                + "$res=Invoke-MyspeedCandidateInjectedInitialConsole $mod $inputVal; "
                + "$res|ConvertTo-Json -Depth 5 -Compress";
            const result = childProcess.spawnSync(POWERSHELL,
                ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
                {encoding: "utf8", timeout: TEST_TIMEOUT_MS, windowsHide: true});
            if (result.status !== 0) throw new Error(result.stderr || result.stdout);
            return JSON.parse(result.stdout);
        };

        const input = (currentPid, expectedPid, processIds, error, detachResult = null, consoleFreeAfter = null) => ({
            currentPid,
            expectedPid,
            observation: {processIds, error},
            observeFailure: false,
            detachResult,
            consoleFreeAfter
        });

        // 1. Already free: zero processes and error 6 (ERROR_INVALID_HANDLE)
        assert.deepEqual(invokeInjectedConsole(input(4000, 4000, [], 6)), {
            initialConsoleProcessIds: [], initialConsoleError: 6,
            initialConsoleDetached: false, consoleFreeAfter: true
        });

        // 2. Sole self: one process matching currentPid and error 0
        assert.deepEqual(invokeInjectedConsole(input(4000, 4000, [4000], 0, true, true)), {
            initialConsoleProcessIds: [4000], initialConsoleError: 0,
            initialConsoleDetached: true, consoleFreeAfter: true
        });

        // 3. Foreign PID, multiple PIDs, wrong sole PID, error != 0
        for (const invalid of [
            input(4000, 4000, [], 0),
            input(4000, 4000, [4242], 0, true, true),
            input(4000, 4000, [4000, 4242], 0, true, true),
            input(4000, 4000, [4000, 4000], 0, true, true),
            input(4000, 4000, [4000], 5, true, true),
            input(4000, 4000, [4000], 0, false, true),
            input(4000, 4000, [4000], 0, true, false)
        ]) {
            assert.throws(() => invokeInjectedConsole(invalid), /console|detach|process|solely owned/i);
        }

        // 4. PID mismatch between nativeCurrentPid and expectedPid
        assert.throws(() => invokeInjectedConsole(input(4001, 4000, [4001], 0, true, true)),
            /Native controller PID differs/i);

        // 5. Dynamic-module callback lifetime: after module removal, calls fail
        const lifetimeCommand = `. '${SCRIPT.replaceAll("'", "''")}' -Mode Library; `
            + `$cleanText=[IO.File]::ReadAllText('${CLEAN_SCRIPT.replaceAll("'", "''")}'); `
            + "$cleanScript=[scriptblock]::Create($cleanText); "
            + "$mod=New-Module -ScriptBlock {param($s);. $s -Mode Library;Export-ModuleMember -Function Get-MyspeedCleanNativeSource,Invoke-MyspeedCleanInitialConsoleCore} -ArgumentList $cleanScript; "
            + "Remove-Module $mod -Force; "
            + "$inputVal=@{currentPid=4000;expectedPid=4000;observation=@{processIds=@();error=6};observeFailure=$false;detachResult=$null;consoleFreeAfter=$null}; "
            + "Invoke-MyspeedCandidateInjectedInitialConsole $mod ([pscustomobject]$inputVal)";
        const lifetimeResult = childProcess.spawnSync(POWERSHELL,
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", lifetimeCommand],
            {encoding: "utf8", timeout: TEST_TIMEOUT_MS, windowsHide: true});
        assert.notEqual(lifetimeResult.status, 0);
    });

    powershellIt("integrates initial console normalization into hosted candidate entry before lifecycle entry", t => {
        const systemTemp = fs.realpathSync.native(os.tmpdir());
        const runnerTemp = fs.mkdtempSync(path.join(systemTemp, "myspeed-candidate-entry-"));
        t.after(() => fs.rmSync(runnerTemp, {recursive: true}));
        const testNonce = crypto.randomBytes(16).toString("hex");
        const expectedTaskRoot = path.join(runnerTemp, `myspeed-native-candidate-${testNonce}`);
        fs.mkdirSync(expectedTaskRoot);
        {
            const req = request("fresh-no-config-reset");
            req.nonce = testNonce;
            req.taskRoot = expectedTaskRoot;
            req.candidatePath = path.join(expectedTaskRoot, "MySpeed.exe");
            req.workingDirectory = path.join(expectedTaskRoot, "work");
            req.controllerPath = path.join(expectedTaskRoot, "windows-clean-stop-controller.ps1");
            req.stdoutPath = path.join(expectedTaskRoot, "candidate.stdout.log");
            req.stderrPath = path.join(expectedTaskRoot, "candidate.stderr.log");
            req.readyPath = path.join(expectedTaskRoot, "candidate.ready.json");
            req.stopRequestPath = path.join(expectedTaskRoot, "candidate.stop.json");
            req.resultPath = path.join(expectedTaskRoot, "candidate.result.json");

            fs.mkdirSync(req.workingDirectory, {recursive: true});
            fs.writeFileSync(req.candidatePath, "fake-exe");
            const cleanContent = fs.readFileSync(CLEAN_SCRIPT);
            fs.writeFileSync(req.controllerPath, cleanContent);
            req.controllerSha256 = crypto.createHash("sha256").update(cleanContent).digest("hex");

            const alignedJson = JSON.stringify(req);
            const alignedSha = crypto.createHash("sha256").update(alignedJson, "utf8").digest("hex");
            const alignedReqPath = path.join(expectedTaskRoot, "candidate.request.json");
            fs.writeFileSync(alignedReqPath, alignedJson, "utf8");

            const testSeam = (initialConsoleOps, shouldSucceed) => {
                const env = {
                    ...process.env,
                    GITHUB_ACTIONS: "true",
                    CI: "true",
                    GITHUB_REPOSITORY: "i7Gamer/MySpeed",
                    RUNNER_OS: "Windows",
                    RUNNER_ARCH: "X64",
                    RUNNER_ENVIRONMENT: "github-hosted",
                    ImageOS: "win25-vs2026",
                    GITHUB_RUN_ID: req.expectedRunId,
                    GITHUB_RUN_ATTEMPT: req.expectedRunAttempt,
                    GITHUB_SHA: req.expectedEventSha,
                    ImageVersion: req.expectedImageVersion,
                    RUNNER_TEMP: runnerTemp
                };
                const opsJson = Buffer.from(JSON.stringify(initialConsoleOps), "utf8").toString("base64");
                const harness = `. '${SCRIPT.replaceAll("'", "''")}' -Mode Library; `
                    + `$opsData=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${opsJson}')); `
                    + "$opsJsonObj=ConvertFrom-Json $opsData; "
                    + "$pids=if($opsJsonObj.useSelfPid){@([int64]$PID)}else{@($opsJsonObj.processIds)}; "
                    + "$initialOps=[pscustomobject]@{ "
                    + "  observe={return [pscustomobject]@{processIds=,$pids;error=[int64]$opsJsonObj.error}}.GetNewClosure(); "
                    + "  detach={return [bool]$opsJsonObj.detachResult}.GetNewClosure(); "
                    + "  proveFree={return [bool]$opsJsonObj.consoleFreeAfter}.GetNewClosure() "
                    + "}; "
                    + "$mockLifecycleOps=[pscustomobject]@{ "
                    + "  elapsed={return 0L}; "
                    + "  assertConsoleFree={}; "
                    + "  launch={param($r,$n,$h)return [pscustomobject]@{candidatePid=100;candidateCreationTime='0123456789abcdef';candidateImagePath=$r.candidatePath;candidateSha256=$r.candidateSha256;candidateVolumeSerial=$r.candidateVolumeSerial;candidateFileId=$r.candidateFileId;candidateCreatedSuspended=$true;privateConsoleRequested=$true;handleListConfigured=$true;jobAssignedBeforeResume=$true;initialJobMembership=$true;candidateIdentityCaptured=$true;candidateResumed=$true;threadHandleClosedBeforeReady=$true}}; "
                    + "  writeReady={param($ready)}; "
                    + "  stopExists={return $false}; "
                    + "  readStop={return $null}; "
                    + "  sleep={param($ms)}; "
                    + "  stop={param($s,$g,$c)return $null}; "
                    + "  lastResult={param($s)return [pscustomobject]@{forced=$false;preAttachIdentityMatch=$false;postAttachHandleUnsignaled=$false;postAttachIdentityMatch=$false;postAttachJobMembership=$false;consoleProcessIdsExact=$false;ctrlEventGenerated=$false;candidateExited=$true;graceExpired=$false;exitCode=113;jobZero=$true;consoleFreeAfter=$true;handlesClosed=$true}}; "
                    + "  active={param($s)return 0L}; "
                    + "  force={param($s,$t)}; "
                    + "  close={param($s)return $true} "
                    + "}; "
                    + `Invoke-MyspeedHostedCandidate '${alignedReqPath.replaceAll("'", "''")}' '${alignedSha}' `
                    + `'${req.expectedRunId}' '${req.expectedRunAttempt}' '${req.expectedEventSha}' '${req.expectedSourceSha}' `
                    + `'${req.expectedImageVersion}' '${testNonce}' $initialOps {return [int64]$PID} $mockLifecycleOps; `
                    + "[Console]::Out.Write('entry-completed')";

                const res = childProcess.spawnSync(POWERSHELL,
                    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", harness],
                    {encoding: "utf8", timeout: TEST_TIMEOUT_MS, env, windowsHide: true});
                if (shouldSucceed) {
                    assert.equal(res.status, 0, res.stderr);
                    assert.match(res.stdout, /entry-completed/u);
                } else {
                    assert.notEqual(res.status, 0);
                    assert.doesNotMatch(res.stdout, /entry-completed/u);
                }
            };

            // Case 1: Sole-self console -> detaches and proceeds to lifecycle
            testSeam({useSelfPid: true, error: 0, detachResult: true, consoleFreeAfter: true}, true);

            // Case 2: Foreign PID console -> rejected before lifecycle
            testSeam({processIds: [999999], error: 0, detachResult: true, consoleFreeAfter: true}, false);

            // Case 3: Failed detach -> rejected before lifecycle
            testSeam({useSelfPid: true, error: 0, detachResult: false, consoleFreeAfter: true}, false);
        }
    });

    it("verifies source ordering: context -> request -> paths -> Add-Type -> native PID -> initial console -> lifecycle", () => {
        const source = fs.readFileSync(SCRIPT, "utf8");
        // 1. Context validation before request/paths
        assert.match(source,
            /Assert-MyspeedCandidateHostedContext[\s\S]*?Read-MyspeedCandidateJson[\s\S]*?Assert-MyspeedCandidateRequest/u);
        // 2. Physical path validation via dynamic module before Add-Type
        assert.match(source,
            /Assert-MyspeedCleanPhysicalPath[\s\S]*?Add-Type -TypeDefinition \$nativeSource -Language CSharp/u);
        // 3. Add-Type before native PID and initial console
        assert.match(source,
            /Add-Type -TypeDefinition \$nativeSource -Language CSharp[\s\S]*?CurrentProcessId\(\)[\s\S]*?Invoke-MyspeedCandidateInitialConsole/u);
        // 4. Initial console normalization before New-MyspeedCandidateNativeOperations and lifecycle
        assert.match(source,
            /Invoke-MyspeedCandidateInitialConsole[\s\S]*?New-MyspeedCandidateNativeOperations[\s\S]*?Invoke-MyspeedCandidateLifecycleCore/u);
        // 5. AssertConsoleFree remains in operations
        assert.match(source,
            /assertConsoleFree=\{\[MySpeed\.Qualification\.CleanStop\.Session\]::AssertConsoleFree\(\)\}/u);
        // 6. CREATE_NEW_CONSOLE preserved without detached/no-window/new-process-group
        assert.match(source, /privateConsoleRequested=\$session\.PrivateConsoleRequested/u);
        assert.doesNotMatch(source, /CREATE_NO_WINDOW|CREATE_NEW_PROCESS_GROUP|detached:\s*true/u);
    });
});
