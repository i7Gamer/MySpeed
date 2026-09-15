import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {describe, it} from "node:test";

import {renderWindowsBaselineGuestBootstrap} from "../../scripts/qualification/windows-baseline-guest-bootstrap.mjs";
import {buildWindowsBaselineGuestSeedDocuments} from "../../scripts/qualification/windows-baseline-guest-seed-documents.mjs";
import {renderGuestBootstrap} from "../../scripts/qualification/linux-windows-cpu-floor-stage2.mjs";
import {parseGuestOutcome} from "../../scripts/qualification/linux-windows-cpu-floor-stage2-hosted.mjs";

const NONCE = "3".repeat(32);
const SOURCE_SHA = "1".repeat(40);
const SHA = character => character.repeat(64);
const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const HAS_INBOX_POWERSHELL = process.platform === "win32" && fs.existsSync(POWERSHELL);
const TEST_TIMEOUT_MILLISECONDS = 30_000;
const TEST_STREAM_BYTES = 1024 * 1024;
const ASCII_CONTROL_MAX = 31;
const ASCII_DELETE = 127;
const hostedContext = () => ({schemaVersion: 1, repository: "i7Gamer/MySpeed", sourceSha: SOURCE_SHA,
    eventSha: "2".repeat(40), runId: "123", runAttempt: "1", nonce: NONCE,
    environment: {GITHUB_ACTIONS: "true", CI: "true", RUNNER_OS: "Linux", RUNNER_ARCH: "X64",
        RUNNER_ENVIRONMENT: "github-hosted", ImageOS: "ubuntu24", ImageVersion: "20260907.1"}});

const render = () => renderWindowsBaselineGuestBootstrap({nonce: NONCE, sourceSha: SOURCE_SHA,
    requestSha256: SHA("4"), executionSha256: SHA("5"), runtimeBundleSha256: SHA("6")});

const runLibraryHarness = (prefix, body) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const scriptPath = path.join(root, "bootstrap.ps1");
    const harnessPath = path.join(root, "harness.ps1");
    fs.mkdirSync(path.join(root, "Temp"));
    try {
        fs.writeFileSync(scriptPath, render());
        fs.writeFileSync(harnessPath, `$env:MYSPEED_BASELINE_TEST_ROOT='${path.join(root, "executor-root").replaceAll("'", "''")}'\r\n` +
            `. '${scriptPath.replaceAll("'", "''")}' -LibraryMode\r\n${body}`);
        const result = spawnSync(POWERSHELL,
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", harnessPath],
            {encoding: "utf8", timeout: TEST_TIMEOUT_MILLISECONDS, maxBuffer: TEST_STREAM_BYTES});
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, "");
        return JSON.parse(result.stdout);
    } finally { fs.rmSync(root, {recursive: true, force: true}); }
};

describe("Windows baseline guest bootstrap", () => {
    it("seals exact bindings and orders guest guard, runtime cleanup, error-mode restore, publication, and shutdown", () => {
        const source = render().toString("utf8");
        assert.match(source, /\$EXPECTED_REQUEST_SHA='4{64}'/u);
        assert.match(source, /\$EXPECTED_EXECUTION_SHA='5{64}'/u);
        assert.match(source, /\$EXPECTED_RUNTIME_SHA='6{64}'/u);
        assert.ok(source.indexOf("$boundary=& $ObserveGuard") < source.indexOf("$runtime=& $InstallRuntime"));
        assert.ok(source.indexOf("$cleanup=& $RemoveRuntime") < source.indexOf("SetErrorMode $previousMode"));
        assert.ok(source.indexOf("SetErrorMode $previousMode") < source.indexOf(`'baseline-result.json'`));
        assert.ok(source.indexOf(`'baseline-result.json'`) < source.indexOf("& $Shutdown"));
        assert.equal((source.match(/Stop-Computer -Force/gu) ?? []).length, 1);
    });

    it("uses suspended Job-contained executor launch and bounded nonce-scoped diagnostics", () => {
        const source = render().toString("utf8");
        for (const token of ["CREATE_SUSPENDED", "PROC_THREAD_ATTRIBUTE_HANDLE_LIST", "AssignProcessToJobObject",
            "IsProcessInJob", "ResumeThread", "TerminateJobObject", "QueryInformationJobObject"])
            assert.match(source, new RegExp(token, "u"));
        assert.doesNotMatch(source, /Start-Process/u);
        assert.doesNotMatch(source, /\.Kill\(\)/u);
        assert.match(source, /myspeed-baseline-executor-'\+\$EXPECTED_NONCE/u);
        assert.match(source, /baseline-result\.raw\.json/u);
        assert.match(source, /baseline-executor\.stderr/u);
        assert.match(source, /Get-MyspeedBaselineOutputAuthority/u);
    });

    it("records each primary bootstrap stage before invoking its operation", () => {
        const source = render().toString("utf8");
        for (const [stage, operation] of [["guard", "$ObserveGuard"], ["input-staging", "$StageInputs"],
            ["runtime-installation", "$InstallRuntime"], ["cpu-loading", "$LoadCpu"],
            ["error-mode-change", "$cpuOperations.SetErrorMode"],
            ["evidence-collection", "$cpuOperations.CollectEvidence"],
            ["executor-invocation", "$StartExecutor"]]) {
            assert.notEqual(source.indexOf(`$failureStage='${stage}'`), -1, stage);
            assert.ok(source.indexOf(`$failureStage='${stage}'`) < source.indexOf(`& ${operation}`), stage);
        }
    });

    it("compiles the private Job launcher without starting a process", {skip: !HAS_INBOX_POWERSHELL}, () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-baseline-job-compile-"));
        const scriptPath = path.join(root, "bootstrap.ps1");
        const harnessPath = path.join(root, "harness.ps1");
        try {
            fs.writeFileSync(scriptPath, render());
            fs.writeFileSync(harnessPath, `. '${scriptPath.replaceAll("'", "''")}' -LibraryMode\r\n` +
                `Initialize-MyspeedBaselineJobType\r\n[MySpeed.Qualification.BaselineJob].FullName\r\n`);
            const result = spawnSync(POWERSHELL,
                ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", harnessPath],
                {encoding: "utf8", timeout: TEST_TIMEOUT_MILLISECONDS, maxBuffer: TEST_STREAM_BYTES});
            assert.equal(result.status, 0, result.stderr);
            assert.equal(result.stderr, "");
            assert.equal(result.stdout.trim(), "MySpeed.Qualification.BaselineJob");
        } finally { fs.rmSync(root, {recursive: true, force: true}); }
    });

    it("retains the exact primary stage across injected operation failures", {skip: !HAS_INBOX_POWERSHELL}, () => {
        const expected = ["guard", "input-staging", "runtime-installation", "cpu-loading", "error-mode-change",
            "evidence-collection", "executor-invocation"];
        const body = `$observed=@()\r\nfunction Invoke-Case([string]$Target){$script:casePublished=@();try{` +
            `Invoke-MyspeedBaselineBootstrap ` +
            `-ObserveGuard {if($Target-ceq'guard'){throw 'injected'};[pscustomobject]@{seed='D:\\';output='E:\\'}} ` +
            `-ObserveOutputAuthority {'E:\\'} -ResolveInputRoot {'C:\\owned'} ` +
            `-StageInputs {param($Seed,$Root)if($Target-ceq'input-staging'){throw 'injected'};[pscustomobject]@{installed=$true;root=$Root}} ` +
            `-InstallRuntime {param($Seed,$Root)if($Target-ceq'runtime-installation'){throw 'injected'};[pscustomobject]@{installed=$true;root=$Root}} ` +
            `-LoadCpu {param($Seed)if($Target-ceq'cpu-loading'){throw 'injected'};[pscustomobject]@{` +
            `SetErrorMode={param($Value)if($Target-ceq'error-mode-change'){throw 'injected'};[uint32]0}.GetNewClosure();` +
            `CollectEvidence={param($Seed)if($Target-ceq'evidence-collection'){throw 'injected'};[pscustomobject]@{status='observed'}}.GetNewClosure()}} ` +
            `-StartExecutor {param($Root,$Seed)if($Target-ceq'executor-invocation'){throw 'injected'};` +
            `[pscustomobject]@{bytes=[byte[]](1,2);status='observed';diagnostics=@()}} ` +
            `-RemoveRuntime {param($Root,$Seed)if($Target-ceq'executor-invocation'){throw 'cleanup injected'};` +
            `[pscustomobject]@{cleanupProven=$true}} ` +
            `-RemoveInputs {param($Seed,$Root)[pscustomobject]@{cleanupProven=$true}} ` +
            `-Publish {param($Path,$Bytes)if([IO.Path]::GetFileName($Path)-ceq'result.json'){$script:casePublished+=([Text.Encoding]::UTF8.GetString($Bytes))}} ` +
            `-Shutdown {}}catch{};return (ConvertFrom-Json ($script:casePublished|Select-Object -Last 1))}\r\n` +
            `foreach($target in @('${expected.join("','")}')){$observed+=(Invoke-Case $target)}\r\n` +
            `$observed|ConvertTo-Json -Compress\r\n`;
        const records = runLibraryHarness("myspeed-baseline-stages-", body);
        assert.deepEqual(records.map(record => record.stage), expected.map(() => "guest-bootstrap"));
        assert.deepEqual(records.map(record => record.failure.split(":", 1)[0]), expected);
    });

    it("uses separately proven output authority for a guard failure and never writes without it",
        {skip: !HAS_INBOX_POWERSHELL}, () => {
            const body = `$events=@();try{Invoke-MyspeedBaselineBootstrap -ObserveGuard {throw 'guard failed'} ` +
                `-ObserveOutputAuthority {throw 'no output authority'} ` +
                `-Publish {param($Path,$Bytes)$script:events+='publish'} -Shutdown {$script:events+='shutdown'}}catch{}\r\n` +
                `$events|ConvertTo-Json -Compress\r\n`;
            assert.equal(runLibraryHarness("myspeed-baseline-no-authority-", body), "shutdown");
        });

    it("falls back to a fixed failure receipt after primary publication collisions and then shuts down",
        {skip: !HAS_INBOX_POWERSHELL}, () => {
            const body = `$events=@();try{Invoke-MyspeedBaselineBootstrap ` +
                `-ObserveGuard {[pscustomobject]@{seed='D:\\';output='E:\\'}} -ResolveInputRoot {'C:\\owned'} ` +
                `-StageInputs {param($Seed,$Root)[pscustomobject]@{installed=$true;root=$Root}} ` +
                `-InstallRuntime {param($Seed,$Root)[pscustomobject]@{installed=$true;root=$Root}} ` +
                `-LoadCpu {param($Seed)[pscustomobject]@{SetErrorMode={param($Value)[uint32]0};` +
                `CollectEvidence={param($Seed)[pscustomobject]@{schemaVersion=1;status='observed'}}}} ` +
                `-StartExecutor {param($Root,$Seed)[pscustomobject]@{bytes=[byte[]](1,2);status='observed';diagnostics=@()}} ` +
                `-RemoveRuntime {param($Root,$Seed)[pscustomobject]@{cleanupProven=$true}} ` +
                `-RemoveInputs {param($Seed,$Root)[pscustomobject]@{cleanupProven=$true}} ` +
                `-Publish {param($Path,$Bytes)$name=[IO.Path]::GetFileName($Path);$script:events+=([pscustomobject]@{name=$name;text=[Text.Encoding]::UTF8.GetString($Bytes)});` +
                `if($name-in@('baseline-result.json','result.json')){throw 'collision'}} ` +
                `-Shutdown {$script:events+=([pscustomobject]@{name='shutdown';text=''})}}catch{}\r\n` +
                `$events|ConvertTo-Json -Compress\r\n`;
            const events = runLibraryHarness("myspeed-baseline-publication-fallback-", body);
            assert.deepEqual(events.map(event => event.name),
                ["baseline-result.json", "result.json", "bootstrap-failure.json", "shutdown"]);
            const fallback = JSON.parse(events[2].text);
            assert.equal(fallback.status, "failed");
            assert.equal(fallback.stage, "guest-bootstrap");
            assert.match(fallback.failure, /^publication:/u);
        });

    it("surfaces a failed semantic executor as overall failure while retaining its baseline bytes",
        {skip: !HAS_INBOX_POWERSHELL}, () => {
            const baseline = JSON.stringify({schemaVersion: 1, profile: "baseline-cpu", status: "failed",
                cleanupProven: true, failure: "candidate failed"});
            const body = `$published=@();try{Invoke-MyspeedBaselineBootstrap ` +
                `-ObserveGuard {[pscustomobject]@{seed='D:\\';output='E:\\'}} -ResolveInputRoot {'C:\\owned'} ` +
                `-StageInputs {param($Seed,$Root)[pscustomobject]@{installed=$true;root=$Root}} ` +
                `-InstallRuntime {param($Seed,$Root)[pscustomobject]@{installed=$true;root=$Root}} ` +
                `-LoadCpu {param($Seed)[pscustomobject]@{SetErrorMode={param($Value)[uint32]0};` +
                `CollectEvidence={param($Seed)[pscustomobject]@{schemaVersion=1;status='observed'}}}} ` +
                `-StartExecutor {param($Root,$Seed)[pscustomobject]@{bytes=[Text.UTF8Encoding]::new($false).GetBytes('${baseline}');status='failed';diagnostics=@()}} ` +
                `-RemoveRuntime {param($Root,$Seed)[pscustomobject]@{cleanupProven=$true}} ` +
                `-RemoveInputs {param($Seed,$Root)[pscustomobject]@{cleanupProven=$true}} ` +
                `-Publish {param($Path,$Bytes)$script:published+=([pscustomobject]@{name=[IO.Path]::GetFileName($Path);text=[Text.Encoding]::UTF8.GetString($Bytes)})} ` +
                `-Shutdown {}}catch{}\r\n$published|ConvertTo-Json -Compress\r\n`;
            const records = runLibraryHarness("myspeed-baseline-semantic-failure-", body);
            assert.deepEqual(records.map(record => record.name), ["baseline-result.json", "result.json"]);
            assert.deepEqual(JSON.parse(records[0].text), JSON.parse(baseline));
            const overall = JSON.parse(records[1].text);
            assert.equal(overall.status, "failed");
            assert.equal(overall.stage, "guest-bootstrap");
            assert.match(overall.failure, /executor-invocation: Baseline executor reported failure: candidate failed/u);
            assert.deepEqual(parseGuestOutcome(Buffer.from(records[1].text), NONCE), overall);
        });

    it("publishes bounded executor diagnostics under nonqualifying fixed names before the failure receipt",
        {skip: !HAS_INBOX_POWERSHELL}, () => {
            const body = `$events=@();try{Invoke-MyspeedBaselineBootstrap ` +
                `-ObserveGuard {[pscustomobject]@{seed='D:\\';output='E:\\'}} -ResolveInputRoot {'C:\\owned'} ` +
                `-StageInputs {param($Seed,$Root)[pscustomobject]@{installed=$true;root=$Root}} ` +
                `-InstallRuntime {param($Seed,$Root)[pscustomobject]@{installed=$true;root=$Root}} ` +
                `-LoadCpu {param($Seed)[pscustomobject]@{SetErrorMode={param($Value)[uint32]0};` +
                `CollectEvidence={param($Seed)[pscustomobject]@{schemaVersion=1;status='observed'}}}} ` +
                `-StartExecutor {param($Root,$Seed)$errorValue=[InvalidOperationException]::new('executor failed');` +
                `$errorValue.Data['MyspeedDiagnostics']=@([pscustomobject]@{name='baseline-result.raw.json';bytes=[byte[]](1,2)},` +
                `[pscustomobject]@{name='baseline-executor.stdout';bytes=[byte[]](3)},` +
                `[pscustomobject]@{name='baseline-executor.stderr';bytes=[byte[]](4)});throw $errorValue} ` +
                `-RemoveRuntime {param($Root,$Seed)[pscustomobject]@{cleanupProven=$true}} ` +
                `-RemoveInputs {param($Seed,$Root)[pscustomobject]@{cleanupProven=$true}} ` +
                `-Publish {param($Path,$Bytes)$script:events+=[IO.Path]::GetFileName($Path)} -Shutdown {$script:events+='shutdown'}}catch{}\r\n` +
                `$events|ConvertTo-Json -Compress\r\n`;
            assert.deepEqual(runLibraryHarness("myspeed-baseline-diagnostic-publish-", body),
                ["baseline-result.raw.json", "baseline-executor.stdout", "baseline-executor.stderr",
                    "result.json", "shutdown"]);
        });

    it("rejects forced descendant cleanup and retains only bounded task-owned result diagnostics",
        {skip: !HAS_INBOX_POWERSHELL}, () => {
            const body = `try{$null=Invoke-MyspeedBaselineExecutor 'C:\\runtime' 'D:\\' -ResolveTaskRoot {$env:MYSPEED_BASELINE_TEST_ROOT} -Launch {` +
                `param($Node,$Arguments,$Working,$Stdout,$Stderr)[IO.File]::WriteAllBytes($Stdout,[byte[]]@());` +
                `[IO.File]::WriteAllBytes($Stderr,[byte[]]@());$result=Join-Path ([IO.Path]::GetDirectoryName($Stdout)) 'result.json';` +
                `[IO.File]::WriteAllText($result,'{"schemaVersion":1,"profile":"baseline-cpu","status":"observed","cleanupProven":true}');` +
                `[pscustomobject]@{ExitCode=[int]0;TimedOut=$false;Forced=$true;AssignedBeforeResume=$true;` +
                `Resumed=$true;ProcessTreeExitProven=$true;HandlesClosed=$true}}}catch{` +
                `[pscustomobject]@{message=$_.Exception.Message;names=@($_.Exception.Data['MyspeedDiagnostics']|` +
                `ForEach-Object{$_.name})}|ConvertTo-Json -Compress}\r\n`;
            const failure = runLibraryHarness("myspeed-baseline-forced-", body);
            assert.match(failure.message, /left an owned descendant/u);
            assert.deepEqual(failure.names, ["baseline-result.raw.json"]);
        });

    it("sanitizes stderr context without accepting malformed result bytes",
        {skip: !HAS_INBOX_POWERSHELL}, () => {
            const body = `try{$null=Invoke-MyspeedBaselineExecutor 'C:\\runtime' 'D:\\' -ResolveTaskRoot {$env:MYSPEED_BASELINE_TEST_ROOT} -Launch {` +
                `param($Node,$Arguments,$Working,$Stdout,$Stderr)[IO.File]::WriteAllBytes($Stdout,[byte[]]@());` +
                `[IO.File]::WriteAllBytes($Stderr,[Text.Encoding]::UTF8.GetBytes('warning'+[char]13+[char]10+'with'+[char]0+'controls'));` +
                `$result=Join-Path ([IO.Path]::GetDirectoryName($Stdout)) 'result.json';[IO.File]::WriteAllText($result,'{bad');` +
                `[pscustomobject]@{ExitCode=[int]1;TimedOut=$false;Forced=$false;AssignedBeforeResume=$true;` +
                `Resumed=$true;ProcessTreeExitProven=$true;HandlesClosed=$true}}}catch{` +
                `[pscustomobject]@{message=$_.Exception.Message;names=@($_.Exception.Data['MyspeedDiagnostics']|` +
                `ForEach-Object{$_.name})}|ConvertTo-Json -Compress}\r\n`;
            const failure = runLibraryHarness("myspeed-baseline-malformed-", body);
            assert.match(failure.message, /streams differ; warning with controls/u);
            assert.equal([...failure.message].some(character => character.codePointAt(0) <= ASCII_CONTROL_MAX ||
                character.codePointAt(0) === ASCII_DELETE), false);
            assert.deepEqual(failure.names, ["baseline-executor.stderr", "baseline-result.raw.json"]);
        });

    it("bounds diagnostics before allocation and never claims an oversized result",
        {skip: !HAS_INBOX_POWERSHELL}, () => {
            const body = `try{$null=Invoke-MyspeedBaselineExecutor 'C:\\runtime' 'D:\\' -ResolveTaskRoot {$env:MYSPEED_BASELINE_TEST_ROOT} -Launch {` +
                `param($Node,$Arguments,$Working,$Stdout,$Stderr)[IO.File]::WriteAllBytes($Stdout,[byte[]]@());` +
                `[IO.File]::WriteAllBytes($Stderr,[byte[]]@());$result=Join-Path ([IO.Path]::GetDirectoryName($Stdout)) 'result.json';` +
                `$stream=[IO.File]::Open($result,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);` +
                `try{$stream.SetLength($BASELINE_MAX_RESULT_BYTES+1)}finally{$stream.Dispose()};` +
                `[pscustomobject]@{ExitCode=[int]1;TimedOut=$false;Forced=$false;AssignedBeforeResume=$true;` +
                `Resumed=$true;ProcessTreeExitProven=$true;HandlesClosed=$true}}}catch{` +
                `[pscustomobject]@{message=$_.Exception.Message;count=@($_.Exception.Data['MyspeedDiagnostics']).Count}|` +
                `ConvertTo-Json -Compress}\r\n`;
            const failure = runLibraryHarness("myspeed-baseline-oversized-", body);
            assert.equal(failure.message, "Baseline executor result diagnostic differs");
            assert.equal(failure.count, 0);
        });

    it("retains invalid UTF-8 stderr bytes without copying them into the failure message",
        {skip: !HAS_INBOX_POWERSHELL}, () => {
            const body = `try{$null=Invoke-MyspeedBaselineExecutor 'C:\\runtime' 'D:\\' ` +
                `-ResolveTaskRoot {$env:MYSPEED_BASELINE_TEST_ROOT} -Launch {` +
                `param($Node,$Arguments,$Working,$Stdout,$Stderr)[IO.File]::WriteAllBytes($Stdout,[byte[]]@());` +
                `[IO.File]::WriteAllBytes($Stderr,[byte[]](255,254));$result=Join-Path ([IO.Path]::GetDirectoryName($Stdout)) 'result.json';` +
                `[IO.File]::WriteAllText($result,'{bad');[pscustomobject]@{ExitCode=[int]1;TimedOut=$false;` +
                `Forced=$false;AssignedBeforeResume=$true;Resumed=$true;ProcessTreeExitProven=$true;HandlesClosed=$true}}}catch{` +
                `[pscustomobject]@{message=$_.Exception.Message;names=@($_.Exception.Data['MyspeedDiagnostics']|` +
                `ForEach-Object{$_.name})}|ConvertTo-Json -Compress}\r\n`;
            const failure = runLibraryHarness("myspeed-baseline-invalid-utf8-", body);
            assert.equal(failure.message, "Baseline executor streams differ");
            assert.deepEqual(failure.names, ["baseline-executor.stderr", "baseline-result.raw.json"]);
        });

    it("refuses a pre-existing executor root before launch and claims no diagnostics",
        {skip: !HAS_INBOX_POWERSHELL}, () => {
            const body = `[IO.Directory]::CreateDirectory($env:MYSPEED_BASELINE_TEST_ROOT)|Out-Null;$called=$false;` +
                `try{$null=Invoke-MyspeedBaselineExecutor 'C:\\runtime' 'D:\\' ` +
                `-ResolveTaskRoot {$env:MYSPEED_BASELINE_TEST_ROOT} -Launch {$script:called=$true}}catch{` +
                `[pscustomobject]@{message=$_.Exception.Message;called=$called;hasDiagnostics=$_.Exception.Data.Contains('MyspeedDiagnostics')}|` +
                `ConvertTo-Json -Compress}\r\n`;
            assert.deepEqual(runLibraryHarness("myspeed-baseline-root-collision-", body),
                {message: "Baseline executor root is not fresh", called: false, hasDiagnostics: false});
        });

    it("runs the returned pure orchestration and publishes only after cleanup and restoration", {skip: !HAS_INBOX_POWERSHELL}, () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-baseline-bootstrap-"));
        const scriptPath = path.join(root, "bootstrap.ps1");
        const cpuPath = path.join(root, "cpu-calibration.ps1");
        const harnessPath = path.join(root, "harness.ps1");
        try {
            fs.writeFileSync(scriptPath, render());
            fs.writeFileSync(cpuPath, renderGuestBootstrap(hostedContext()));
            const harness = `$events=@();. '${scriptPath.replaceAll("'", "''")}' -LibraryMode\r\n` +
                `Invoke-MyspeedBaselineBootstrap -ObserveGuard {$script:events+='guard';[pscustomobject]@{seed='D:\\';output='E:\\'}} ` +
                `-StageInputs {param($Seed,$Root)$script:events+='stage-inputs';[pscustomobject]@{installed=$true;root=$Root}} ` +
                `-InstallRuntime {param($Seed,$Root)$script:events+='install';[pscustomobject]@{installed=$true;root=$Root}} ` +
                `-LoadCpu {param($Seed). '${cpuPath.replaceAll("'", "''")}' -LibraryMode;` +
                `$script:events+=("load-cpu:"+$BASELINE_MAX_STREAM_BYTES);[pscustomobject]@{` +
                `SetErrorMode={param($Value)$script:events+="mode:$Value";[uint32]7};` +
                `CollectEvidence={param($Value)$script:events+='cpu';[pscustomobject]@{schemaVersion=1;status='observed'}}}} ` +
                `-StartExecutor {param($Root,$Seed)$script:events+='executor';[pscustomobject]@{bytes=[Text.UTF8Encoding]::new($false).GetBytes('{"schemaVersion":1,"status":"observed","profile":"baseline-cpu","cleanupProven":true,"summary":{}}');status='observed';diagnostics=@()}} ` +
                `-RemoveRuntime {param($Root)$script:events+='cleanup';[pscustomobject]@{cleanupProven=$true}} ` +
                `-RemoveInputs {param($Seed,$Root)$script:events+='cleanup-inputs';[pscustomobject]@{cleanupProven=$true}} ` +
                `-Publish {param($Path,$Bytes)$script:events+=("publish:"+[IO.Path]::GetFileName($Path))} ` +
                `-Shutdown {$script:events+='shutdown'}\r\n$events|ConvertTo-Json -Compress\r\n`;
            fs.writeFileSync(harnessPath, harness);
            const result = spawnSync(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", harnessPath],
                {encoding: "utf8", timeout: TEST_TIMEOUT_MILLISECONDS, maxBuffer: TEST_STREAM_BYTES});
            assert.equal(result.status, 0, result.stderr);
            assert.equal(result.stderr, "");
            assert.notEqual(result.stdout.trim(), "", result.stderr);
            assert.deepEqual(JSON.parse(result.stdout), ["guard", "stage-inputs", "install", "load-cpu:4194304", "mode:3",
                "cpu", "executor", "cleanup", "cleanup-inputs", "mode:7", "publish:baseline-result.json",
                "publish:result.json", "shutdown"]);
        } finally { fs.rmSync(root, {recursive: true, force: true}); }
    });

    it("publishes only a failed CPU envelope and still shuts down when restoration fails", {skip: !HAS_INBOX_POWERSHELL}, () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-baseline-bootstrap-failure-"));
        const scriptPath = path.join(root, "bootstrap.ps1"); const harnessPath = path.join(root, "harness.ps1");
        try {
            fs.writeFileSync(scriptPath, render());
            const harness = `$events=@();. '${scriptPath.replaceAll("'", "''")}' -LibraryMode\r\n` +
                `$calls=0\r\n` +
                `try{Invoke-MyspeedBaselineBootstrap -ObserveGuard {[pscustomobject]@{seed='D:\\';output='E:\\'}} ` +
                `-StageInputs {param($Seed,$Root)[pscustomobject]@{installed=$true;root=$Root}} ` +
                `-InstallRuntime {param($Seed,$Root)[pscustomobject]@{installed=$true;root=$Root}} ` +
                `-LoadCpu {param($Seed)[pscustomobject]@{SetErrorMode={param($Value)$script:calls++;if($script:calls -eq 1){[uint32]7}else{throw 'restore failed'}};CollectEvidence={param($Value)[pscustomobject]@{status='observed'}}}} ` +
                `-StartExecutor {param($Root,$Seed)[pscustomobject]@{bytes=[Text.UTF8Encoding]::new($false).GetBytes('{}');status='observed';diagnostics=@()}} ` +
                `-RemoveRuntime {param($Root)[pscustomobject]@{cleanupProven=$true}} ` +
                `-RemoveInputs {param($Seed,$Root)[pscustomobject]@{cleanupProven=$true}} ` +
                `-Publish {param($Path,$Bytes)$script:events+=([pscustomobject]@{name=[IO.Path]::GetFileName($Path);text=[Text.Encoding]::UTF8.GetString($Bytes)})} ` +
                `-Shutdown {$script:events+=([pscustomobject]@{name='shutdown';text=''})}}catch{}\r\n$events|ConvertTo-Json -Compress\r\n`;
            fs.writeFileSync(harnessPath, harness);
            const result = spawnSync(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", harnessPath],
                {encoding: "utf8", timeout: TEST_TIMEOUT_MILLISECONDS, maxBuffer: TEST_STREAM_BYTES});
            assert.equal(result.status, 0, result.stderr);
            assert.equal(result.stderr, "");
            assert.notEqual(result.stdout.trim(), "", result.stderr);
            const events = JSON.parse(result.stdout);
            assert.deepEqual(events.map(value => value.name), ["result.json", "shutdown"]);
            const failure = JSON.parse(events[0].text);
            assert.equal(failure.status, "failed"); assert.equal(failure.stage, "guest-bootstrap");
            assert.match(failure.failure, /^error-mode-restore:/u);
        } finally { fs.rmSync(root, {recursive: true, force: true}); }
    });

    it("reloads the sealed runtime installer for cleanup after the install callback scope exits",
        {skip: !HAS_INBOX_POWERSHELL}, () => {
            const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-baseline-installer-scope-"));
            const scriptPath = path.join(root, "bootstrap.ps1");
            const installerPath = path.join(root, "runtime-installer.ps1");
            const removedPath = path.join(root, "removed.txt");
            const harnessPath = path.join(root, "harness.ps1");
            try {
                fs.writeFileSync(scriptPath, render());
                fs.writeFileSync(installerPath, `param([switch]$Mode)\r\n` +
                    `function Install-MyspeedBaselineRuntimeBundle { param($Bundle,$Sha,$Source,$Nonce,$Root,$Temp) ` +
                    `[pscustomobject]@{installed=$true;root=$Root} }\r\n` +
                    `function Remove-MyspeedBaselineRuntimeBundle { param($Source,$Nonce,$Root,$Temp) ` +
                    `[IO.File]::WriteAllText('${removedPath.replaceAll("'", "''")}','removed');` +
                    `[pscustomobject]@{cleanupProven=$true} }\r\n`);
                const escapedRoot = root.replaceAll("'", "''");
                const harness = `. '${scriptPath.replaceAll("'", "''")}' -LibraryMode\r\n` +
                    `Invoke-MyspeedBaselineBootstrap -ObserveGuard {[pscustomobject]@{seed='${escapedRoot}';output='${escapedRoot}'}} ` +
                    `-StageInputs {param($Seed,$Root)[pscustomobject]@{installed=$true;root=$Root}} ` +
                    `-LoadCpu {param($Seed)[pscustomobject]@{SetErrorMode={param($Value)[uint32]0};` +
                    `CollectEvidence={param($Value)[pscustomobject]@{status='observed'}}}} ` +
                    `-StartExecutor {param($Root,$Seed)[pscustomobject]@{bytes=[Text.UTF8Encoding]::new($false).GetBytes('{}');status='observed';diagnostics=@()}} ` +
                    `-RemoveInputs {param($Seed,$Root)[pscustomobject]@{cleanupProven=$true}} ` +
                    `-Publish {param($Path,$Bytes)} -Shutdown {}\r\n` +
                    `[pscustomobject]@{removed=[IO.File]::Exists('${removedPath.replaceAll("'", "''")}')}|` +
                    `ConvertTo-Json -Compress\r\n`;
                fs.writeFileSync(harnessPath, harness);
                const result = spawnSync(POWERSHELL,
                    ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", harnessPath],
                    {encoding: "utf8", timeout: TEST_TIMEOUT_MILLISECONDS, maxBuffer: TEST_STREAM_BYTES});
                assert.equal(result.status, 0, result.stderr);
                assert.equal(result.stderr, "");
                assert.deepEqual(JSON.parse(result.stdout), {removed: true});
            } finally { fs.rmSync(root, {recursive: true, force: true}); }
        });

    it("stages label-discovered seed inputs to the fixed owned root and removes them before publication",
        {skip: !HAS_INBOX_POWERSHELL}, () => {
            const nonce = "4".repeat(32);
            const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-baseline-input-stage-"));
            const candidateBytes = Buffer.from("candidate-bytes\n");
            const fixtureBytes = Buffer.from("fixture-bytes\n");
            const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
            const documents = buildWindowsBaselineGuestSeedDocuments({context: {sourceSha: SOURCE_SHA,
                eventSha: "2".repeat(40), runId: "123", runAttempt: "2", nonce},
            imageVersion: "windows-server-2025-standard-eval", manifestSha256: SHA("4"),
            candidate: {artifactName: "MySpeed-windows-x64-baseline.exe", bytes: String(candidateBytes.length),
                sha256: digest(candidateBytes)}, fixtureBundle: {bytes: String(fixtureBytes.length),
                sha256: digest(fixtureBytes)}, candidateController: {bytes: "65536", sha256: SHA("7")},
            cleanStopController: {bytes: "131072", sha256: SHA("8")}});
            const scriptPath = path.join(root, "bootstrap.ps1");
            const harnessPath = path.join(root, "harness.ps1");
            const ownedInputRoot = path.join(root, "owned-input");
            const execution = structuredClone(documents.execution);
            execution.candidateSource.path = path.join(ownedInputRoot, "MySpeed.exe");
            execution.fixtureBundle.path = path.join(ownedInputRoot, "fixture-bundle.json");
            const executionBytes = Buffer.from(`${JSON.stringify(execution)}\n`, "utf8");
            const executionSha256 = digest(executionBytes);
            try {
                fs.writeFileSync(path.join(root, "execution.json"), executionBytes);
                fs.writeFileSync(path.join(root, "MySpeed.exe"), candidateBytes);
                fs.writeFileSync(path.join(root, "fixture-bundle.json"), fixtureBytes);
                fs.writeFileSync(scriptPath, renderWindowsBaselineGuestBootstrap({nonce, sourceSha: SOURCE_SHA,
                    requestSha256: documents.requestRecord.sha256,
                    executionSha256, runtimeBundleSha256: SHA("6")}));
                const escapedRoot = root.replaceAll("'", "''");
                const harness = `. '${scriptPath.replaceAll("'", "''")}' -LibraryMode\r\n` +
                    `Invoke-MyspeedBaselineBootstrap -ObserveGuard {[pscustomobject]@{seed='${escapedRoot}';output='${escapedRoot}'}} ` +
                    `-ResolveInputRoot {'${ownedInputRoot.replaceAll("'", "''")}'} ` +
                    `-InstallRuntime {param($Seed,$Root)[pscustomobject]@{installed=$true;root=$Root}} ` +
                    `-LoadCpu {param($Seed)[pscustomobject]@{SetErrorMode={param($Value)[uint32]0};` +
                    `CollectEvidence={param($Value)[pscustomobject]@{status='observed'}}}} ` +
                    `-StartExecutor {param($Root,$Seed)[pscustomobject]@{bytes=[Text.UTF8Encoding]::new($false).GetBytes('{}');status='observed';diagnostics=@()}} ` +
                    `-RemoveRuntime {param($Root,$Seed)[pscustomobject]@{cleanupProven=$true}} ` +
                    `-Publish {param($Path,$Bytes)} -Shutdown {}\r\n` +
                    `[pscustomobject]@{inputGone=(-not [IO.Directory]::Exists('${ownedInputRoot.replaceAll("'", "''")}'))}|` +
                    `ConvertTo-Json -Compress\r\n`;
                fs.writeFileSync(harnessPath, harness);
                const result = spawnSync(POWERSHELL,
                    ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", harnessPath],
                    {encoding: "utf8", timeout: TEST_TIMEOUT_MILLISECONDS, maxBuffer: TEST_STREAM_BYTES});
                assert.equal(result.status, 0, result.stderr);
                assert.equal(result.stderr, "");
                assert.deepEqual(JSON.parse(result.stdout), {inputGone: true});
            } finally {
                if (fs.existsSync(ownedInputRoot)) fs.rmSync(ownedInputRoot, {recursive: true, force: true});
                fs.rmSync(root, {recursive: true, force: true});
            }
        });

    it("does not claim or remove an input root that existed before staging",
        {skip: !HAS_INBOX_POWERSHELL}, () => {
            const nonce = "5".repeat(32);
            const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-baseline-input-stale-"));
            const ownedInputRoot = path.join(root, "owned-input");
            const candidateBytes = Buffer.from("stale-candidate\n");
            const fixtureBytes = Buffer.from("stale-fixture\n");
            const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
            const documents = buildWindowsBaselineGuestSeedDocuments({context: {sourceSha: SOURCE_SHA,
                eventSha: "2".repeat(40), runId: "123", runAttempt: "2", nonce},
            imageVersion: "windows-server-2025-standard-eval", manifestSha256: SHA("4"),
            candidate: {artifactName: "MySpeed-windows-x64-baseline.exe", bytes: String(candidateBytes.length),
                sha256: digest(candidateBytes)}, fixtureBundle: {bytes: String(fixtureBytes.length),
                sha256: digest(fixtureBytes)}, candidateController: {bytes: "65536", sha256: SHA("7")},
            cleanStopController: {bytes: "131072", sha256: SHA("8")}});
            const execution = structuredClone(documents.execution);
            execution.candidateSource.path = path.join(ownedInputRoot, "MySpeed.exe");
            execution.fixtureBundle.path = path.join(ownedInputRoot, "fixture-bundle.json");
            const executionBytes = Buffer.from(`${JSON.stringify(execution)}\n`, "utf8");
            const scriptPath = path.join(root, "bootstrap.ps1");
            const harnessPath = path.join(root, "harness.ps1");
            try {
                fs.mkdirSync(ownedInputRoot);
                fs.writeFileSync(path.join(ownedInputRoot, "MySpeed.exe"), candidateBytes);
                fs.writeFileSync(path.join(ownedInputRoot, "fixture-bundle.json"), fixtureBytes);
                fs.writeFileSync(path.join(root, "execution.json"), executionBytes);
                fs.writeFileSync(scriptPath, renderWindowsBaselineGuestBootstrap({nonce, sourceSha: SOURCE_SHA,
                    requestSha256: documents.requestRecord.sha256,
                    executionSha256: digest(executionBytes), runtimeBundleSha256: SHA("6")}));
                const escapedRoot = root.replaceAll("'", "''");
                const escapedInput = ownedInputRoot.replaceAll("'", "''");
                const harness = `$events=@();. '${scriptPath.replaceAll("'", "''")}' -LibraryMode\r\n` +
                    `try{Invoke-MyspeedBaselineBootstrap ` +
                    `-ObserveGuard {[pscustomobject]@{seed='${escapedRoot}';output='${escapedRoot}'}} ` +
                    `-ResolveInputRoot {'${escapedInput}'} ` +
                    `-Publish {param($Path,$Bytes)$script:events+=([Text.Encoding]::UTF8.GetString($Bytes))} ` +
                    `-Shutdown {}}catch{}\r\n` +
                    `[pscustomobject]@{rootExists=[IO.Directory]::Exists('${escapedInput}');` +
                    `candidateExists=[IO.File]::Exists((Join-Path '${escapedInput}' 'MySpeed.exe'));` +
                    `fixtureExists=[IO.File]::Exists((Join-Path '${escapedInput}' 'fixture-bundle.json'));` +
                    `failure=($events|Select-Object -First 1)}|ConvertTo-Json -Compress\r\n`;
                fs.writeFileSync(harnessPath, harness);
                const result = spawnSync(POWERSHELL,
                    ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", harnessPath],
                    {encoding: "utf8", timeout: TEST_TIMEOUT_MILLISECONDS, maxBuffer: TEST_STREAM_BYTES});
                assert.equal(result.status, 0, result.stderr);
                assert.equal(result.stderr, "");
                const observed = JSON.parse(result.stdout);
                assert.equal(observed.rootExists, true);
                assert.equal(observed.candidateExists, true);
                assert.equal(observed.fixtureExists, true);
                assert.equal(JSON.parse(observed.failure).status, "failed");
            } finally { fs.rmSync(root, {recursive: true, force: true}); }
        });

    it("verifies every staged input before deleting any input",
        {skip: !HAS_INBOX_POWERSHELL}, () => {
            const nonce = "6".repeat(32);
            const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-baseline-input-drift-"));
            const ownedInputRoot = path.join(root, "owned-input");
            const candidateBytes = Buffer.from("candidate-before-drift\n");
            const fixtureBytes = Buffer.from("fixture-before-drift\n");
            const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
            const documents = buildWindowsBaselineGuestSeedDocuments({context: {sourceSha: SOURCE_SHA,
                eventSha: "2".repeat(40), runId: "123", runAttempt: "2", nonce},
            imageVersion: "windows-server-2025-standard-eval", manifestSha256: SHA("4"),
            candidate: {artifactName: "MySpeed-windows-x64-baseline.exe", bytes: String(candidateBytes.length),
                sha256: digest(candidateBytes)}, fixtureBundle: {bytes: String(fixtureBytes.length),
                sha256: digest(fixtureBytes)}, candidateController: {bytes: "65536", sha256: SHA("7")},
            cleanStopController: {bytes: "131072", sha256: SHA("8")}});
            const execution = structuredClone(documents.execution);
            execution.candidateSource.path = path.join(ownedInputRoot, "MySpeed.exe");
            execution.fixtureBundle.path = path.join(ownedInputRoot, "fixture-bundle.json");
            const executionBytes = Buffer.from(`${JSON.stringify(execution)}\n`, "utf8");
            const scriptPath = path.join(root, "bootstrap.ps1");
            const harnessPath = path.join(root, "harness.ps1");
            try {
                fs.writeFileSync(path.join(root, "execution.json"), executionBytes);
                fs.writeFileSync(path.join(root, "MySpeed.exe"), candidateBytes);
                fs.writeFileSync(path.join(root, "fixture-bundle.json"), fixtureBytes);
                fs.writeFileSync(scriptPath, renderWindowsBaselineGuestBootstrap({nonce, sourceSha: SOURCE_SHA,
                    requestSha256: documents.requestRecord.sha256,
                    executionSha256: digest(executionBytes), runtimeBundleSha256: SHA("6")}));
                const escapedRoot = root.replaceAll("'", "''");
                const escapedInput = ownedInputRoot.replaceAll("'", "''");
                const harness = `. '${scriptPath.replaceAll("'", "''")}' -LibraryMode\r\n` +
                    `$null=Install-MyspeedBaselineInputs '${escapedRoot}' '${escapedInput}'\r\n` +
                    `[IO.File]::AppendAllText((Join-Path '${escapedInput}' 'fixture-bundle.json'),'drift')\r\n` +
                    `try{$null=Remove-MyspeedBaselineInputs '${escapedRoot}' '${escapedInput}'}catch{}\r\n` +
                    `[pscustomobject]@{rootExists=[IO.Directory]::Exists('${escapedInput}');` +
                    `candidateExists=[IO.File]::Exists((Join-Path '${escapedInput}' 'MySpeed.exe'));` +
                    `fixtureExists=[IO.File]::Exists((Join-Path '${escapedInput}' 'fixture-bundle.json'))}|` +
                    `ConvertTo-Json -Compress\r\n`;
                fs.writeFileSync(harnessPath, harness);
                const result = spawnSync(POWERSHELL,
                    ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", harnessPath],
                    {encoding: "utf8", timeout: TEST_TIMEOUT_MILLISECONDS, maxBuffer: TEST_STREAM_BYTES});
                assert.equal(result.status, 0, result.stderr);
                assert.equal(result.stderr, "");
                assert.deepEqual(JSON.parse(result.stdout), {rootExists: true, candidateExists: true,
                    fixtureExists: true});
            } finally { fs.rmSync(root, {recursive: true, force: true}); }
        });
});
