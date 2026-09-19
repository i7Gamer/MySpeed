import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {describe, it} from "node:test";

import {WINDOWS_BASELINE_BOOTSTRAP_CONSTANTS, parseCompletionRecord, renderWindowsBaselineGuestBootstrap} from
    "../../scripts/qualification/windows-baseline-guest-bootstrap.mjs";
import {buildWindowsBaselineGuestSeedDocuments} from "../../scripts/qualification/windows-baseline-guest-seed-documents.mjs";
import {WINDOWS_SYSTEM_TOOL_PATHS, renderGuestBootstrap} from
    "../../scripts/qualification/linux-windows-cpu-floor-stage2.mjs";
import {parseGuestOutcome} from "../../scripts/qualification/linux-windows-cpu-floor-stage2-hosted.mjs";
import {buildWindowsMsiSetupCompleteActivation, getCompletedWindowsMsiActivationEvidence} from
    "../../scripts/qualification/windows-msi-post-setup-activation.mjs";

const NONCE = "3".repeat(32);
const SOURCE_SHA = "1".repeat(40);
const CANDIDATE_SHA = "9".repeat(40);
const SHA = character => character.repeat(64);
const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const HAS_INBOX_POWERSHELL = process.platform === "win32" && fs.existsSync(POWERSHELL);
const TEST_TIMEOUT_MILLISECONDS = 30_000;
const TEST_STREAM_BYTES = 1024 * 1024;
const ASCII_CONTROL_MAX = 31;
const ASCII_DELETE = 127;
const DESCENDANT_DRAIN_MILLISECONDS = WINDOWS_BASELINE_BOOTSTRAP_CONSTANTS.EXECUTOR_DESCENDANT_DRAIN_MILLISECONDS;
const BRIEF_DESCENDANT_MILLISECONDS = 400;
const LEAKED_DESCENDANT_MILLISECONDS = 20_000;
const SHUTDOWN_OUTCOME_NAME = "baseline-shutdown-outcome.json";
const {SHUTDOWN_OUTCOME_SCHEMA_VERSION} = WINDOWS_BASELINE_BOOTSTRAP_CONSTANTS;
/*
 * The real emitter opens a serial port. Every harness that reaches publication stubs it out, so the
 * suite never writes to whatever COM1 happens to exist on the machine running it; the tests that are
 * about the emission itself pass an explicit absent port instead.
 */
const SILENT_EMIT_STUB = "-EmitCompletion {param([string]$Line)$null} ";
const psString = value => `'${String(value).replaceAll("'", "''")}'`;
const lingeringDescendant = milliseconds => "require('child_process').spawn(process.execPath,['-e'," +
    `'setTimeout(()=>{},${milliseconds})'],{detached:true,stdio:'ignore'}).unref();process.exitCode=0`;
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

    // Platform-independent guard: the executor-launch test that asserts the suppression flag through
    // a mocked -Launch is skipped on the Linux CI shards, so this static check is what enforces on
    // every runner that the executor node process receives --disable-warning=ExperimentalWarning
    // ahead of the executor script. The launch is held to exactly-empty stdout and stderr, so node's
    // node:sqlite ExperimentalWarning here would read as a leak and fail a full ~72-minute guest run.
    it("keeps the experimental-warning suppression flag ahead of the executor script in the render", () => {
        const source = render().toString("utf8");
        assert.match(source, /\$arguments=@\('--disable-warning=ExperimentalWarning',\$executor,'--request',/u);
    });

    it("renders the self-describing message for a Node runtime warning on the executor stream", () => {
        const source = render().toString("utf8");
        assert.match(source, /Baseline executor emitted a Node runtime warning on stderr/u);
        assert.match(source, /\$streamContext-match '\^\\\(node:\\d\+\\\)\\s\+\\w\+Warning:'/u);
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
            "evidence-collection", "activation-observation", "system-tool-observation", "executor-invocation"];
        const body = `$observed=@()\r\nfunction Invoke-Case([string]$Target){$script:casePublished=@();try{` +
            `Invoke-MyspeedBaselineBootstrap ` +
            `-ObserveGuard {if($Target-ceq'guard'){throw 'injected'};[pscustomobject]@{seed='D:\\';output='E:\\'}} ` +
            `-ObserveOutputAuthority {'E:\\'} -ResolveInputRoot {'C:\\owned'} ` +
            `-StageInputs {param($Seed,$Root)if($Target-ceq'input-staging'){throw 'injected'};[pscustomobject]@{installed=$true;root=$Root}} ` +
            `-InstallRuntime {param($Seed,$Root)if($Target-ceq'runtime-installation'){throw 'injected'};[pscustomobject]@{installed=$true;root=$Root}} ` +
            `-LoadCpu {param($Seed)if($Target-ceq'cpu-loading'){throw 'injected'};[pscustomobject]@{` +
            `SetErrorMode={param($Value)if($Target-ceq'error-mode-change'){throw 'injected'};[uint32]0}.GetNewClosure();` +
            `CollectEvidence={param($Seed)if($Target-ceq'evidence-collection'){throw 'injected'};[ordered]@{status='observed'}}.GetNewClosure();` +
            `ObserveActivation={if($Target-ceq'activation-observation'){throw 'injected'};[ordered]@{state='ready'}}.GetNewClosure();` +
            `ObserveSystemTools={if($Target-ceq'system-tool-observation'){throw 'injected'};@()}.GetNewClosure()}} ` +
            `-StartExecutor {param($Root,$Seed)if($Target-ceq'executor-invocation'){throw 'injected'};` +
            `[pscustomobject]@{bytes=[byte[]](1,2);status='observed';diagnostics=@()}} ` +
            `-RemoveRuntime {param($Root,$Seed)if($Target-ceq'executor-invocation'){throw 'cleanup injected'};` +
            `[pscustomobject]@{cleanupProven=$true}} ` +
            `-RemoveInputs {param($Seed,$Root)[pscustomobject]@{cleanupProven=$true}} ` +
            `-Publish {param($Path,$Bytes)if([IO.Path]::GetFileName($Path)-ceq'result.json'){$script:casePublished+=([Text.Encoding]::UTF8.GetString($Bytes))}} ` +
            `${SILENT_EMIT_STUB}-Shutdown {}}catch{};return (ConvertFrom-Json ($script:casePublished|Select-Object -Last 1))}\r\n` +
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
                `-Publish {param($Path,$Bytes)$script:events+='publish'} ${SILENT_EMIT_STUB}-Shutdown {$script:events+='shutdown'}}catch{}\r\n` +
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
                `CollectEvidence={param($Seed)[ordered]@{schemaVersion=1;status='observed'}};` +
                `ObserveActivation={[ordered]@{state='ready'}};ObserveSystemTools={@()}}} ` +
                `-StartExecutor {param($Root,$Seed)[pscustomobject]@{bytes=[byte[]](1,2);status='observed';diagnostics=@()}} ` +
                `-RemoveRuntime {param($Root,$Seed)[pscustomobject]@{cleanupProven=$true}} ` +
                `-RemoveInputs {param($Seed,$Root)[pscustomobject]@{cleanupProven=$true}} ` +
                `-Publish {param($Path,$Bytes)$name=[IO.Path]::GetFileName($Path);$script:events+=([pscustomobject]@{name=$name;text=[Text.Encoding]::UTF8.GetString($Bytes)});` +
                `if($name-in@('baseline-result.json','result.json')){throw 'collision'}} ` +
                `${SILENT_EMIT_STUB}-Shutdown {$script:events+=([pscustomobject]@{name='shutdown';text=''})}}catch{}\r\n` +
                `$events|ConvertTo-Json -Compress\r\n`;
            const events = runLibraryHarness("myspeed-baseline-publication-fallback-", body);
            assert.deepEqual(events.map(event => event.name),
                ["baseline-result.json", "result.json", "bootstrap-failure.json", "shutdown", SHUTDOWN_OUTCOME_NAME]);
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
                `CollectEvidence={param($Seed)[ordered]@{schemaVersion=1;status='observed'}};` +
                `ObserveActivation={[ordered]@{state='ready'}};ObserveSystemTools={@()}}} ` +
                `-StartExecutor {param($Root,$Seed)[pscustomobject]@{bytes=[Text.UTF8Encoding]::new($false).GetBytes('${baseline}');status='failed';diagnostics=@()}} ` +
                `-RemoveRuntime {param($Root,$Seed)[pscustomobject]@{cleanupProven=$true}} ` +
                `-RemoveInputs {param($Seed,$Root)[pscustomobject]@{cleanupProven=$true}} ` +
                `-Publish {param($Path,$Bytes)$script:published+=([pscustomobject]@{name=[IO.Path]::GetFileName($Path);text=[Text.Encoding]::UTF8.GetString($Bytes)})} ` +
                `${SILENT_EMIT_STUB}-Shutdown {}}catch{}\r\n$published|ConvertTo-Json -Compress\r\n`;
            const records = runLibraryHarness("myspeed-baseline-semantic-failure-", body);
            assert.deepEqual(records.map(record => record.name), ["baseline-result.json", "result.json", SHUTDOWN_OUTCOME_NAME]);
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
                `CollectEvidence={param($Seed)[ordered]@{schemaVersion=1;status='observed'}};` +
                `ObserveActivation={[ordered]@{state='ready'}};ObserveSystemTools={@()}}} ` +
                `-StartExecutor {param($Root,$Seed)$errorValue=[InvalidOperationException]::new('executor failed');` +
                `$errorValue.Data['MyspeedDiagnostics']=@([pscustomobject]@{name='baseline-result.raw.json';bytes=[byte[]](1,2)},` +
                `[pscustomobject]@{name='baseline-executor.stdout';bytes=[byte[]](3)},` +
                `[pscustomobject]@{name='baseline-executor.stderr';bytes=[byte[]](4)});throw $errorValue} ` +
                `-RemoveRuntime {param($Root,$Seed)[pscustomobject]@{cleanupProven=$true}} ` +
                `-RemoveInputs {param($Seed,$Root)[pscustomobject]@{cleanupProven=$true}} ` +
                `-Publish {param($Path,$Bytes)$script:events+=[IO.Path]::GetFileName($Path)} ${SILENT_EMIT_STUB}-Shutdown {$script:events+='shutdown'}}catch{}\r\n` +
                `$events|ConvertTo-Json -Compress\r\n`;
            assert.deepEqual(runLibraryHarness("myspeed-baseline-diagnostic-publish-", body),
                ["baseline-result.raw.json", "baseline-executor.stdout", "baseline-executor.stderr",
                    "result.json", "shutdown", SHUTDOWN_OUTCOME_NAME]);
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
                `ForEach-Object{$_.name});typed=@($_.Exception.Data['MyspeedDiagnostics']|` +
                `ForEach-Object{$_.bytes -is [byte[]]})}|ConvertTo-Json -Compress}\r\n`;
            const failure = runLibraryHarness("myspeed-baseline-forced-", body);
            assert.match(failure.message, /left an owned descendant/u);
            assert.deepEqual(failure.names, ["baseline-result.raw.json"]);
            assert.deepEqual(failure.typed, [true]);
        });

    it("returns an observed executor result as typed bytes the bootstrap accepts",
        {skip: !HAS_INBOX_POWERSHELL}, () => {
            const observed = '{"schemaVersion":1,"profile":"baseline-cpu","status":"observed","cleanupProven":true}';
            const body = `$value=Invoke-MyspeedBaselineExecutor 'C:\\runtime' 'D:\\' -ResolveTaskRoot {$env:MYSPEED_BASELINE_TEST_ROOT} -Launch {` +
                `param($Node,$Arguments,$Working,$Stdout,$Stderr)[IO.File]::WriteAllBytes($Stdout,[byte[]]@());` +
                `[IO.File]::WriteAllBytes($Stderr,[byte[]]@());$result=Join-Path ([IO.Path]::GetDirectoryName($Stdout)) 'result.json';` +
                `[IO.File]::WriteAllText($result,'${observed}');` +
                `[pscustomobject]@{ExitCode=[int]0;TimedOut=$false;Forced=$false;AssignedBeforeResume=$true;` +
                `Resumed=$true;ProcessTreeExitProven=$true;HandlesClosed=$true}}\r\n` +
                `[pscustomobject]@{status=$value.status;typed=($value.bytes -is [byte[]]);length=$value.bytes.Length;` +
                `text=[Text.Encoding]::UTF8.GetString($value.bytes);diagnostics=@($value.diagnostics).Count}|ConvertTo-Json -Compress\r\n`;
            assert.deepEqual(runLibraryHarness("myspeed-baseline-observed-", body),
                {status: "observed", typed: true, length: observed.length, text: observed, diagnostics: 0});
        });

    it("launches the executor node process with the experimental-warning suppression flag before the script",
        {skip: !HAS_INBOX_POWERSHELL}, () => {
            const observed = '{"schemaVersion":1,"profile":"baseline-cpu","status":"observed","cleanupProven":true}';
            const body = `$value=Invoke-MyspeedBaselineExecutor 'C:\\runtime' 'D:\\' -ResolveTaskRoot {$env:MYSPEED_BASELINE_TEST_ROOT} -Launch {` +
                `param($Node,$Arguments,$Working,$Stdout,$Stderr)$script:captured=@($Arguments);[IO.File]::WriteAllBytes($Stdout,[byte[]]@());` +
                `[IO.File]::WriteAllBytes($Stderr,[byte[]]@());$result=Join-Path ([IO.Path]::GetDirectoryName($Stdout)) 'result.json';` +
                `[IO.File]::WriteAllText($result,'${observed}');` +
                `[pscustomobject]@{ExitCode=[int]0;TimedOut=$false;Forced=$false;AssignedBeforeResume=$true;` +
                `Resumed=$true;ProcessTreeExitProven=$true;HandlesClosed=$true}}\r\n` +
                `[pscustomobject]@{first=$script:captured[0];second=$script:captured[1];` +
                `count=($script:captured -contains '--disable-warning=ExperimentalWarning')}|ConvertTo-Json -Compress\r\n`;
            const captured = runLibraryHarness("myspeed-baseline-warnflag-", body);
            assert.equal(captured.first, "--disable-warning=ExperimentalWarning");
            assert.equal(captured.count, true);
            assert.match(captured.second, /windows-baseline-guest-executor\.mjs$/u);
        });

    it("lets asynchronous descendant teardown drain before judging the Job and still forces a real leak",
        {skip: !HAS_INBOX_POWERSHELL}, () => {
            const source = render().toString("utf8");
            assert.match(source, /\[uint32\]\$BASELINE_EXECUTOR_CLEANUP_TIMEOUT,\[uint32\]\$BASELINE_EXECUTOR_DRAIN_TIMEOUT\)/u);
            assert.equal(DESCENDANT_DRAIN_MILLISECONDS, 5_000);
            const body = `Initialize-MyspeedBaselineJobType\r\n$root=$env:MYSPEED_BASELINE_TEST_ROOT;$null=[IO.Directory]::CreateDirectory($root)\r\n` +
                `function Invoke-Run([string]$Name,[string]$Script){$dir=Join-Path $root $Name;$null=[IO.Directory]::CreateDirectory($dir);` +
                `$watch=[Diagnostics.Stopwatch]::StartNew();$run=[MySpeed.Qualification.BaselineJob]::Run(${psString(process.execPath)},` +
                `[string[]]@('-e',$Script),$dir,(Join-Path $dir 'stdout'),(Join-Path $dir 'stderr'),[uint32]60000,[uint32]30000,` +
                `[uint32]$BASELINE_EXECUTOR_DRAIN_TIMEOUT);[pscustomobject]@{name=$Name;forced=$run.Forced;timedOut=$run.TimedOut;` +
                `exitCode=$run.ExitCode;tree=$run.ProcessTreeExitProven;elapsedMs=$watch.ElapsedMilliseconds}}\r\n` +
                `@((Invoke-Run 'plain-1' 'process.exitCode=0'),(Invoke-Run 'plain-2' 'process.exitCode=0'),` +
                `(Invoke-Run 'plain-3' 'process.exitCode=0'),` +
                `(Invoke-Run 'brief-descendant' ${psString(lingeringDescendant(BRIEF_DESCENDANT_MILLISECONDS))}),` +
                `(Invoke-Run 'leaked-descendant' ${psString(lingeringDescendant(LEAKED_DESCENDANT_MILLISECONDS))}))|` +
                `ConvertTo-Json -Compress\r\n`;
            const runs = runLibraryHarness("myspeed-baseline-drain-", body);
            assert.deepEqual(runs.map(run => run.name),
                ["plain-1", "plain-2", "plain-3", "brief-descendant", "leaked-descendant"]);
            for (const run of runs) {
                assert.equal(run.timedOut, false, run.name);
                assert.equal(run.exitCode, 0, run.name);
                assert.equal(run.tree, true, run.name);
            }
            for (const run of runs.slice(0, 4)) assert.equal(run.forced, false, run.name);
            const leaked = runs[4];
            assert.equal(leaked.forced, true);
            assert.ok(leaked.elapsedMs >= DESCENDANT_DRAIN_MILLISECONDS, String(leaked.elapsedMs));
            assert.ok(leaked.elapsedMs < LEAKED_DESCENDANT_MILLISECONDS, String(leaked.elapsedMs));
        });

    it("publishes a bounded shutdown outcome marker after the shutdown call returns or throws",
        {skip: !HAS_INBOX_POWERSHELL}, () => {
            const run = shutdown => {
                const body = `$events=@();try{Invoke-MyspeedBaselineBootstrap ` +
                    `-ObserveGuard {[pscustomobject]@{seed='D:\\';output='E:\\'}} -ResolveInputRoot {'C:\\owned'} ` +
                    `-StageInputs {param($Seed,$Root)[pscustomobject]@{installed=$true;root=$Root}} ` +
                    `-InstallRuntime {param($Seed,$Root)[pscustomobject]@{installed=$true;root=$Root}} ` +
                    `-LoadCpu {param($Seed)[pscustomobject]@{SetErrorMode={param($Value)[uint32]0};` +
                    `CollectEvidence={param($Seed)[ordered]@{schemaVersion=1;status='observed'}};` +
                    `ObserveActivation={[ordered]@{state='ready'}};ObserveSystemTools={@()}}} ` +
                    `-StartExecutor {param($Root,$Seed)[pscustomobject]@{bytes=[byte[]](1,2);status='observed';diagnostics=@()}} ` +
                    `-RemoveRuntime {param($Root,$Seed)[pscustomobject]@{cleanupProven=$true}} ` +
                    `-RemoveInputs {param($Seed,$Root)[pscustomobject]@{cleanupProven=$true}} ` +
                    `-Publish {param($Path,$Bytes)$script:events+=([pscustomobject]@{name=[IO.Path]::GetFileName($Path);text=[Text.Encoding]::UTF8.GetString($Bytes)})} ` +
                    `${SILENT_EMIT_STUB}-Shutdown {$script:events+=([pscustomobject]@{name='shutdown';text=''});${shutdown}}}catch{` +
                    `$script:events+=([pscustomobject]@{name='thrown';text=$_.Exception.Message})}\r\n` +
                    `$events|ConvertTo-Json -Compress\r\n`;
                return runLibraryHarness("myspeed-baseline-shutdown-marker-", body);
            };
            const returned = run("");
            assert.deepEqual(returned.map(event => event.name),
                ["baseline-result.json", "result.json", "shutdown", SHUTDOWN_OUTCOME_NAME]);
            assert.deepEqual(JSON.parse(returned[3].text), {schemaVersion: SHUTDOWN_OUTCOME_SCHEMA_VERSION,
                nonce: NONCE, stage: "guest-shutdown", outcome: "returned", failure: null,
                /* The stub returns nothing, which is exactly what "the emitter said nothing" looks like. */
                completionEmission: null});
            const refused = run(`throw ('shutdown refused'+[char]10+('x'*600))`);
            assert.deepEqual(refused.map(event => event.name),
                ["baseline-result.json", "result.json", "shutdown", SHUTDOWN_OUTCOME_NAME, "thrown"]);
            const marker = JSON.parse(refused[3].text);
            assert.equal(marker.outcome, "failed");
            assert.match(marker.failure, /^shutdown refused x+$/u);
            assert.equal(marker.failure.length, WINDOWS_BASELINE_BOOTSTRAP_CONSTANTS.MAX_FAILURE_CHARACTERS);
            assert.match(refused[4].text, /^shutdown refused/u);
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

    it("names a Node runtime warning on stderr instead of the generic streams-differ message",
        {skip: !HAS_INBOX_POWERSHELL}, () => {
            const body = `try{$null=Invoke-MyspeedBaselineExecutor 'C:\\runtime' 'D:\\' ` +
                `-ResolveTaskRoot {$env:MYSPEED_BASELINE_TEST_ROOT} -Launch {` +
                `param($Node,$Arguments,$Working,$Stdout,$Stderr)[IO.File]::WriteAllBytes($Stdout,[byte[]]@());` +
                `[IO.File]::WriteAllText($Stderr,'(node:4242) ExperimentalWarning: SQLite is an experimental feature');` +
                `$result=Join-Path ([IO.Path]::GetDirectoryName($Stdout)) 'result.json';[IO.File]::WriteAllText($result,'{bad');` +
                `[pscustomobject]@{ExitCode=[int]1;TimedOut=$false;Forced=$false;AssignedBeforeResume=$true;` +
                `Resumed=$true;ProcessTreeExitProven=$true;HandlesClosed=$true}}}catch{` +
                `[pscustomobject]@{message=$_.Exception.Message;names=@($_.Exception.Data['MyspeedDiagnostics']|` +
                `ForEach-Object{$_.name})}|ConvertTo-Json -Compress}\r\n`;
            const failure = runLibraryHarness("myspeed-baseline-nodewarn-", body);
            assert.match(failure.message,
                /^Baseline executor emitted a Node runtime warning on stderr; \(node:4242\) ExperimentalWarning: SQLite/u);
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
                `CollectEvidence={param($Value)$script:events+='cpu';[ordered]@{schemaVersion=1;status='observed'}};` +
                `ObserveActivation={$script:events+='activation';[ordered]@{state='ready'}};` +
                `ObserveSystemTools={$script:events+='system-tools';@()}}} ` +
                `-StartExecutor {param($Root,$Seed)$script:events+='executor';[pscustomobject]@{bytes=[Text.UTF8Encoding]::new($false).GetBytes('{"schemaVersion":1,"status":"observed","profile":"baseline-cpu","cleanupProven":true,"summary":{}}');status='observed';diagnostics=@()}} ` +
                `-RemoveRuntime {param($Root)$script:events+='cleanup';[pscustomobject]@{cleanupProven=$true}} ` +
                `-RemoveInputs {param($Seed,$Root)$script:events+='cleanup-inputs';[pscustomobject]@{cleanupProven=$true}} ` +
                `-Publish {param($Path,$Bytes)$script:events+=("publish:"+[IO.Path]::GetFileName($Path))} ` +
                `${SILENT_EMIT_STUB}-Shutdown {$script:events+='shutdown'}\r\n$events|ConvertTo-Json -Compress\r\n`;
            fs.writeFileSync(harnessPath, harness);
            const result = spawnSync(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", harnessPath],
                {encoding: "utf8", timeout: TEST_TIMEOUT_MILLISECONDS, maxBuffer: TEST_STREAM_BYTES});
            assert.equal(result.status, 0, result.stderr);
            assert.equal(result.stderr, "");
            assert.notEqual(result.stdout.trim(), "", result.stderr);
            assert.deepEqual(JSON.parse(result.stdout), ["guard", "stage-inputs", "install", "load-cpu:4194304", "mode:3",
                "cpu", "activation", "system-tools", "executor", "cleanup", "cleanup-inputs", "mode:7",
                "publish:baseline-result.json", "publish:result.json", "shutdown", `publish:${SHUTDOWN_OUTCOME_NAME}`]);
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
                `-LoadCpu {param($Seed)[pscustomobject]@{SetErrorMode={param($Value)$script:calls++;if($script:calls -eq 1){[uint32]7}else{throw 'restore failed'}};` +
                `CollectEvidence={param($Value)[ordered]@{status='observed'}};` +
                `ObserveActivation={[ordered]@{state='ready'}};ObserveSystemTools={@()}}} ` +
                `-StartExecutor {param($Root,$Seed)[pscustomobject]@{bytes=[Text.UTF8Encoding]::new($false).GetBytes('{}');status='observed';diagnostics=@()}} ` +
                `-RemoveRuntime {param($Root)[pscustomobject]@{cleanupProven=$true}} ` +
                `-RemoveInputs {param($Seed,$Root)[pscustomobject]@{cleanupProven=$true}} ` +
                `-Publish {param($Path,$Bytes)$script:events+=([pscustomobject]@{name=[IO.Path]::GetFileName($Path);text=[Text.Encoding]::UTF8.GetString($Bytes)})} ` +
                `${SILENT_EMIT_STUB}-Shutdown {$script:events+=([pscustomobject]@{name='shutdown';text=''})}}catch{}\r\n$events|ConvertTo-Json -Compress\r\n`;
            fs.writeFileSync(harnessPath, harness);
            const result = spawnSync(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", harnessPath],
                {encoding: "utf8", timeout: TEST_TIMEOUT_MILLISECONDS, maxBuffer: TEST_STREAM_BYTES});
            assert.equal(result.status, 0, result.stderr);
            assert.equal(result.stderr, "");
            assert.notEqual(result.stdout.trim(), "", result.stderr);
            const events = JSON.parse(result.stdout);
            assert.deepEqual(events.map(value => value.name), ["result.json", "shutdown", SHUTDOWN_OUTCOME_NAME]);
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
                    `CollectEvidence={param($Value)[ordered]@{status='observed'}};` +
                    `ObserveActivation={[ordered]@{state='ready'}};ObserveSystemTools={@()}}} ` +
                    `-StartExecutor {param($Root,$Seed)[pscustomobject]@{bytes=[Text.UTF8Encoding]::new($false).GetBytes('{}');status='observed';diagnostics=@()}} ` +
                    `-RemoveInputs {param($Seed,$Root)[pscustomobject]@{cleanupProven=$true}} ` +
                    `-Publish {param($Path,$Bytes)} ${SILENT_EMIT_STUB}-Shutdown {}\r\n` +
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
            const documents = buildWindowsBaselineGuestSeedDocuments({context: {...hostedContext(), nonce},
            imageVersion: "windows-server-2025-standard-eval", manifestSha256: SHA("4"),
            candidate: {artifactName: "MySpeed-windows-x64-baseline.exe", sourceSha: CANDIDATE_SHA,
                bytes: String(candidateBytes.length),
                sha256: digest(candidateBytes)}, fixtureBundle: {bytes: String(fixtureBytes.length),
                sha256: digest(fixtureBytes)}, candidateController: {bytes: "65536", sha256: SHA("7")},
            cleanStopController: {bytes: "131072", sha256: SHA("8")},
            cpuidProbe: {bytes: "16384", sha256: SHA("9")}});
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
                    `CollectEvidence={param($Value)[ordered]@{status='observed'}};` +
                    `ObserveActivation={[ordered]@{state='ready'}};ObserveSystemTools={@()}}} ` +
                    `-StartExecutor {param($Root,$Seed)[pscustomobject]@{bytes=[Text.UTF8Encoding]::new($false).GetBytes('{}');status='observed';diagnostics=@()}} ` +
                    `-RemoveRuntime {param($Root,$Seed)[pscustomobject]@{cleanupProven=$true}} ` +
                    `-Publish {param($Path,$Bytes)} ${SILENT_EMIT_STUB}-Shutdown {}\r\n` +
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
            const documents = buildWindowsBaselineGuestSeedDocuments({context: {...hostedContext(), nonce},
            imageVersion: "windows-server-2025-standard-eval", manifestSha256: SHA("4"),
            candidate: {artifactName: "MySpeed-windows-x64-baseline.exe", sourceSha: CANDIDATE_SHA,
                bytes: String(candidateBytes.length),
                sha256: digest(candidateBytes)}, fixtureBundle: {bytes: String(fixtureBytes.length),
                sha256: digest(fixtureBytes)}, candidateController: {bytes: "65536", sha256: SHA("7")},
            cleanStopController: {bytes: "131072", sha256: SHA("8")},
            cpuidProbe: {bytes: "16384", sha256: SHA("9")}});
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
                    `${SILENT_EMIT_STUB}-Shutdown {}}catch{}\r\n` +
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
            const documents = buildWindowsBaselineGuestSeedDocuments({context: {...hostedContext(), nonce},
            imageVersion: "windows-server-2025-standard-eval", manifestSha256: SHA("4"),
            candidate: {artifactName: "MySpeed-windows-x64-baseline.exe", sourceSha: CANDIDATE_SHA,
                bytes: String(candidateBytes.length),
                sha256: digest(candidateBytes)}, fixtureBundle: {bytes: String(fixtureBytes.length),
                sha256: digest(fixtureBytes)}, candidateController: {bytes: "65536", sha256: SHA("7")},
            cleanStopController: {bytes: "131072", sha256: SHA("8")},
            cpuidProbe: {bytes: "16384", sha256: SHA("9")}});
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

const psLiteral = value => {
    if (value === null) return "$null";
    if (typeof value === "boolean") return value ? "$true" : "$false";
    if (typeof value === "number") return String(value);
    if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
    if (Array.isArray(value)) return `@(${value.map(psLiteral).join(",")})`;
    return `([ordered]@{${Object.entries(value).map(([key, item]) =>
        `'${key}'=${psLiteral(item)}`).join(";")}})`;
};

const CPUID_EVIDENCE = {schemaVersion: 1, kind: "cpuid", maxBasicLeaf: 7,
    leaf1: {eax: "0x00000000", ebx: "0x00000000", ecx: "0x00900000", edx: "0x00000000"},
    leaf7Subleaf0: {eax: "0x00000000", ebx: "0x00000000", ecx: "0x00000000", edx: "0x00000000"},
    xcr0: null, features: {sse42: true, popcnt: true, osxsave: false, avx: false, avx2: false}};
const CONTROL_RESULTS = {"known-good": 42, "known-bad": 13, sse42: 2_276_049_685, popcnt: 32};
const ILLEGAL_INSTRUCTION_EXIT = 3_221_225_501;
const KNOWN_BAD_EXIT = 19;

// Exactly what the reused Stage 2 collector returns from CollectEvidence, and nothing more.
const collectedCpuEvidence = () => ({schemaVersion: 1, nonce: NONCE, runs: [
    {role: "cpuid", exitCode: 0,
        stdoutBase64: Buffer.from(`${JSON.stringify(CPUID_EVIDENCE)}\n`).toString("base64"), stderrBase64: ""},
    ...Object.entries(CONTROL_RESULTS).map(([role, result]) => ({role,
        exitCode: role === "known-bad" ? KNOWN_BAD_EXIT : 0,
        stdoutBase64: Buffer.from(`${JSON.stringify({schemaVersion: 1, kind: role, result})}\n`).toString("base64"),
        stderrBase64: ""})),
    ...["illegal", "avx", "avx2"].map(role => ({role, exitCode: ILLEGAL_INSTRUCTION_EXIT,
        stdoutBase64: "", stderrBase64: ""}))],
network: {hardwareNics: 0, enabledNonLoopbackInterfaces: 0, nonLoopbackRoutes: 0}});

const observedActivation = () => getCompletedWindowsMsiActivationEvidence(buildWindowsMsiSetupCompleteActivation({
    repository: "i7Gamer/MySpeed", sourceSha: SOURCE_SHA, eventSha: "2".repeat(40), runId: "123",
    runAttempt: "1", nonce: NONCE}));
const observedSystemTools = () => WINDOWS_SYSTEM_TOOL_PATHS.map((tool, index) =>
    ({role: tool.role, path: tool.path, bytes: String(index + 1), sha256: String(index + 1).repeat(64)}));

/*
 * Runs the real generated orchestration with every native side effect replaced by an inert script
 * block, and returns the bytes the script itself published as result.json.
 */
const runProducer = ({script = render(), activation = psLiteral(observedActivation()),
    systemTools = psLiteral(observedSystemTools()), cpu = psLiteral(collectedCpuEvidence())} = {}) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-baseline-producer-"));
    const scriptPath = path.join(root, "bootstrap.ps1");
    const harnessPath = path.join(root, "harness.ps1");
    const publishedRoot = path.join(root, "published");
    fs.mkdirSync(publishedRoot);
    const escape = value => value.replaceAll("'", "''");
    try {
        fs.writeFileSync(scriptPath, script);
        fs.writeFileSync(harnessPath, `$ErrorActionPreference='Stop'\r\n` +
            `. '${escape(scriptPath)}' -LibraryMode\r\n` +
            `try{Invoke-MyspeedBaselineBootstrap ` +
            `-ObserveGuard {[pscustomobject]@{seed='D:\\';output='E:\\'}} ` +
            `-StageInputs {param($Seed,$Root)[pscustomobject]@{installed=$true;root=$Root}} ` +
            `-InstallRuntime {param($Seed,$Root)[pscustomobject]@{installed=$true;root=$Root}} ` +
            `-LoadCpu {param($Seed)[pscustomobject]@{SetErrorMode={param($Value)[uint32]7};` +
            `CollectEvidence={param($Value)${cpu}};` +
            `ObserveActivation={${activation}};` +
            `ObserveSystemTools={${systemTools}}}} ` +
            `-StartExecutor {param($Root,$Seed)[pscustomobject]@{bytes=[Text.UTF8Encoding]::new($false).GetBytes(` +
            `'{"schemaVersion":1,"status":"observed","profile":"baseline-cpu","cleanupProven":true}');` +
            `status='observed';diagnostics=@()}} ` +
            `-RemoveRuntime {param($Root,$Seed)[pscustomobject]@{cleanupProven=$true}} ` +
            `-RemoveInputs {param($Seed,$Root)[pscustomobject]@{cleanupProven=$true}} ` +
            `-Publish {param($Path,$Bytes)[IO.File]::WriteAllBytes(` +
            `[IO.Path]::Combine('${escape(publishedRoot)}',[IO.Path]::GetFileName($Path)),$Bytes)} ` +
            `${SILENT_EMIT_STUB}-Shutdown {}}catch{}\r\n` +
            `[Console]::Out.Write((@(Get-ChildItem -LiteralPath '${escape(publishedRoot)}'|` +
            `ForEach-Object{$_.Name})|ConvertTo-Json -Compress))\r\n`);
        const result = spawnSync(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", harnessPath],
            {encoding: "utf8", timeout: TEST_TIMEOUT_MILLISECONDS, maxBuffer: TEST_STREAM_BYTES});
        assert.equal(result.status, 0, result.stderr);
        const target = path.join(publishedRoot, "result.json");
        // ConvertTo-Json unwraps a one-element array, so normalise before comparing.
        return {published: fs.existsSync(target) ? fs.readFileSync(target) : null,
            names: [JSON.parse(result.stdout || "[]")].flat()};
    } finally { fs.rmSync(root, {recursive: true, force: true}); }
};

describe("Windows baseline guest producer-to-parser contract", () => {
    it("records the activation and system-tool stages before invoking their observations", () => {
        const source = render().toString("utf8");
        for (const [stage, operation] of [["activation-observation", "$cpuOperations.ObserveActivation"],
            ["system-tool-observation", "$cpuOperations.ObserveSystemTools"]]) {
            assert.notEqual(source.indexOf(`$failureStage='${stage}'`), -1, stage);
            assert.ok(source.indexOf(`$failureStage='${stage}'`) < source.indexOf(`& ${operation}`), stage);
        }
        assert.ok(source.indexOf("$cpuOperations.CollectEvidence") <
            source.indexOf("$cpuOperations.ObserveActivation"));
        assert.ok(source.indexOf("$cpuOperations.ObserveSystemTools") < source.indexOf("& $StartExecutor"));
    });

    it("publishes bytes the real Stage 2 parser accepts", {skip: !HAS_INBOX_POWERSHELL}, () => {
        const produced = runProducer();
        assert.deepEqual(produced.names.sort(), ["baseline-result.json", SHUTDOWN_OUTCOME_NAME, "result.json"]);
        const parsed = parseGuestOutcome(produced.published, NONCE);
        assert.deepEqual(parsed.cpu, {sse42: true, popcnt: true, osxsave: false, avx: false, avx2: false});
        assert.deepEqual(parsed.instructions, {sse42: "completed", popcnt: "completed",
            avx: "illegal-instruction", avx2: "illegal-instruction"});
        assert.deepEqual(parsed.activation, observedActivation());
        assert.deepEqual(parsed.systemTools, observedSystemTools());
    });

    it("cannot satisfy the parser once either published assignment is removed",
        {skip: !HAS_INBOX_POWERSHELL}, () => {
            const source = render().toString("utf8");
            for (const assignment of [
                `$failureStage='activation-observation';$cpu.activation=& $cpuOperations.ObserveActivation;`,
                `$failureStage='system-tool-observation';$cpu.systemTools=& $cpuOperations.ObserveSystemTools;`
            ]) {
                assert.ok(source.includes(assignment), assignment);
                const mutated = runProducer({script: Buffer.from(source.replace(assignment, ""), "utf8")});
                assert.notEqual(mutated.published, null);
                assert.throws(() => parseGuestOutcome(mutated.published, NONCE), /guest result schema is invalid/u);
            }
        });

    it("publishes a stage-named failure instead of a success envelope when either observation fails",
        {skip: !HAS_INBOX_POWERSHELL}, () => {
            for (const [stage, overrides] of [
                ["activation-observation", {activation: "throw 'activation unavailable'"}],
                ["system-tool-observation", {systemTools: "throw 'system tool unavailable'"}]
            ]) {
                const produced = runProducer(overrides);
                assert.deepEqual(produced.names, [SHUTDOWN_OUTCOME_NAME, "result.json"]);
                const parsed = parseGuestOutcome(produced.published, NONCE);
                assert.equal(parsed.status, "failed");
                assert.equal(parsed.stage, "guest-bootstrap");
                assert.match(parsed.failure, new RegExp(`^${stage}: `, "u"));
            }
        });

    it("keeps a cleanup or publication failure from producing an accepted envelope",
        {skip: !HAS_INBOX_POWERSHELL}, () => {
            const source = render().toString("utf8");
            const mutated = source.replace("$cleanup=& $RemoveRuntime $runtimeRoot $boundary.seed;",
                "$cleanup=[pscustomobject]@{cleanupProven=$false};");
            assert.notEqual(mutated, source);
            const produced = runProducer({script: Buffer.from(mutated, "utf8")});
            assert.deepEqual(produced.names, [SHUTDOWN_OUTCOME_NAME, "result.json"]);
            const parsed = parseGuestOutcome(produced.published, NONCE);
            assert.equal(parsed.status, "failed");
            assert.match(parsed.failure, /^runtime-cleanup: /u);
        });

    const {COMPLETION_RECORD_KIND, COMPLETION_RECORD_PREFIX, MAX_COMPLETION_RECORD_BYTES,
        COMPLETION_EMISSION_FUNCTION, COMPLETION_EMISSION_METHOD_HANDLE, COMPLETION_EMISSION_METHOD_PORT,
        COMPLETION_SERIAL_DEVICE, COMPLETION_SERIAL_PORT_NAME, MAX_COMPLETION_EMISSION_FAILURE_CHARACTERS,
        SHUTDOWN_STAGE} = WINDOWS_BASELINE_BOOTSTRAP_CONSTANTS;
    const OBSERVED_BASELINE = JSON.stringify({schemaVersion: 1, profile: "baseline-cpu", status: "observed",
        cleanupProven: true, failure: null});
    /* The identity the guest must declare for a published receipt: exact byte count and digest. */
    const identify = text => {
        const bytes = Buffer.from(text, "utf8");
        return {bytes: String(bytes.length), sha256: crypto.createHash("sha256").update(bytes).digest("hex")};
    };
    const recordingEmitStub = `-EmitCompletion {param([string]$Line)` +
        `$script:events+=([pscustomobject]@{name='completion';text=$Line})} `;
    const completionBody = (publishGuard, emitStub = recordingEmitStub) => `$events=@();try{Invoke-MyspeedBaselineBootstrap ` +
        `-ObserveGuard {[pscustomobject]@{seed='D:\\';output='E:\\'}} -ResolveInputRoot {'C:\\owned'} ` +
        `-StageInputs {param($Seed,$Root)[pscustomobject]@{installed=$true;root=$Root}} ` +
        `-InstallRuntime {param($Seed,$Root)[pscustomobject]@{installed=$true;root=$Root}} ` +
        `-LoadCpu {param($Seed)[pscustomobject]@{SetErrorMode={param($Value)[uint32]0};` +
        `CollectEvidence={param($Seed)[ordered]@{schemaVersion=1;status='observed'}};` +
        `ObserveActivation={[ordered]@{state='ready'}};ObserveSystemTools={@()}}} ` +
        `-StartExecutor {param($Root,$Seed)[pscustomobject]@{` +
        `bytes=[Text.UTF8Encoding]::new($false).GetBytes('${OBSERVED_BASELINE}');status='observed';diagnostics=@()}} ` +
        `-RemoveRuntime {param($Root,$Seed)[pscustomobject]@{cleanupProven=$true}} ` +
        `-RemoveInputs {param($Seed,$Root)[pscustomobject]@{cleanupProven=$true}} ` +
        `-Publish {param($Path,$Bytes);${publishGuard};$script:events+=([pscustomobject]@{` +
        `name=[IO.Path]::GetFileName($Path);text=[Text.Encoding]::UTF8.GetString($Bytes)})} ` +
        emitStub +
        `-Shutdown {$script:events+=([pscustomobject]@{name='shutdown';text=''})}}catch{}\r\n` +
        `$events|ConvertTo-Json -Compress\r\n`;

    it("binds the publication-complete serial record and orders it after publication, before shutdown", () => {
        const source = render().toString("utf8");
        assert.equal(COMPLETION_RECORD_PREFIX, "MYSPEED-STAGE3-COMPLETE-V1");
        assert.equal(COMPLETION_RECORD_KIND, "myspeed-stage3-publication-complete");
        assert.ok(source.includes(COMPLETION_RECORD_PREFIX));
        assert.ok(source.includes(COMPLETION_RECORD_KIND));
        /*
         * The record may only claim a publication that already returned, so it is rendered after the
         * second exclusive write and before the shutdown call it exists to precede. `'result.json'`
         * carries its quote so it cannot match inside `'baseline-result.json'`.
         */
        /*
         * Anchor on the publication call itself. A bare 'result.json' also matches the executor's
         * own scratch path far earlier in the script, which made an earlier version of this
         * assertion true no matter where the emission sat. The behavioural ordering test below is
         * Windows-gated, so this is the only check of this property on PR CI.
         */
        const publishBaseline = source.indexOf("& $Publish (Join-Path $publicationOutput 'baseline-result.json')");
        const publishCpu = source.indexOf("& $Publish (Join-Path $publicationOutput 'result.json')");
        const emit = source.indexOf("& $EmitCompletion");
        assert.ok(publishBaseline > 0 && publishCpu > publishBaseline);
        assert.ok(publishCpu < emit);
        assert.ok(emit < source.indexOf("& $Shutdown"));
    });

    it("emits exactly one nonce-bound completion record naming both published receipts",
        {skip: !HAS_INBOX_POWERSHELL}, () => {
            const events = runLibraryHarness("myspeed-baseline-completion-", completionBody(""));
            assert.deepEqual(events.map(event => event.name),
                ["baseline-result.json", "result.json", "completion", "shutdown", SHUTDOWN_OUTCOME_NAME]);

            const line = events[2].text;
            assert.ok(line.length <= MAX_COMPLETION_RECORD_BYTES, `record is ${line.length} bytes`);
            assert.ok(line.startsWith(`${COMPLETION_RECORD_PREFIX} `));
            const record = JSON.parse(line.slice(COMPLETION_RECORD_PREFIX.length + 1));
            assert.deepEqual(Object.keys(record), ["schemaVersion", "kind", "nonce", "baseline", "cpu"]);
            assert.equal(record.schemaVersion, 1);
            assert.equal(record.kind, COMPLETION_RECORD_KIND);
            assert.equal(record.nonce, NONCE);
            assert.deepEqual(record.baseline, identify(events[0].text));
            assert.deepEqual(record.cpu, identify(events[1].text));
        });

    it("emits no completion record when a publication fails", {skip: !HAS_INBOX_POWERSHELL}, () => {
        const events = runLibraryHarness("myspeed-baseline-completion-refused-",
            completionBody(`if([IO.Path]::GetFileName($Path)-ceq'result.json'){throw 'publication refused'}`));
        assert.equal(events.filter(event => event.name === "completion").length, 0);
        assert.ok(events.some(event => event.name === "shutdown"));
    });

    /*
     * A port number no rig assigns, so the managed mechanism fails the same way everywhere instead of
     * writing to whatever COM1 happens to be on the machine running the suite.
     */
    const ABSENT_PORT_NAME = "COM253";
    const ABSENT_DEVICE_PATH = `\\\\.\\${ABSENT_PORT_NAME}`;

    it("keeps the completion emission outcome instead of discarding it", () => {
        const source = render().toString("utf8");
        /*
         * Run 35390872740 published both receipts, returned from `Stop-Computer` and left the serial
         * log at the firmware's own 1196 bytes. `try{...}catch{}` around the emission is what made
         * that undiagnosable, so its absence is the property, not an implementation detail.
         */
        assert.equal(source.includes("try{& $EmitCompletion $completionLine}catch{}"), false);
        assert.ok(source.includes("try{$completionEmission=& $EmitCompletion $completionLine}catch{"));
        assert.ok(source.includes(`function ${COMPLETION_EMISSION_FUNCTION}(`));
        /* Two mechanisms, and the second is only reached because the first did not emit. */
        assert.ok(source.includes(`foreach($method in @('${COMPLETION_EMISSION_METHOD_PORT}',` +
            `'${COMPLETION_EMISSION_METHOD_HANDLE}')){if($emitted){continue}`));
        assert.ok(source.includes("[IO.Ports.SerialPort]::new($PortName,"));
        assert.ok(source.includes("[IO.File]::Open($DevicePath,"));
        /* An empty enumeration is the one observation that would settle whether a port exists at all. */
        assert.ok(source.includes("[IO.Ports.SerialPort]::GetPortNames()"));
        assert.ok(source.includes(`[string]$PortName='${COMPLETION_SERIAL_PORT_NAME}'`));
        assert.ok(source.includes(`[string]$DevicePath='${COMPLETION_SERIAL_DEVICE}'`));
        /*
         * Only the raw-handle transport can be exercised without a serial port, so the managed one
         * is pinned the only way that does not need hardware: both mechanisms write the same
         * `$payload`, encoded once before the loop. The fallback case below proves those bytes are
         * exactly the record line plus CRLF, which makes it the content check for both.
         */
        assert.ok(source.includes("$payload=[Text.ASCIIEncoding]::new().GetBytes($Line+\"`r`n\");"));
        assert.equal(source.split("$payload,0,$payload.Length").length - 1, 2,
            "each mechanism writes the one payload, and nothing else writes at all");
        /* An oversized line never reaches a port, and that is a different report from a refusal. */
        assert.ok(source.includes(`else{$completionEmission=[ordered]@{attempted=$false;emitted=$false;`));
    });

    it("publishes the emission report inside the shutdown outcome the guest already writes", () => {
        const source = render().toString("utf8");
        assert.ok(source.includes(`schemaVersion=${SHUTDOWN_OUTCOME_SCHEMA_VERSION};nonce=$EXPECTED_NONCE;` +
            `stage='${SHUTDOWN_STAGE}'`));
        assert.ok(source.includes("completionEmission=$completionEmission}"));
        assert.ok(source.indexOf("$completionEmission=& $EmitCompletion") <
            source.indexOf("completionEmission=$completionEmission}"));
    });

    /*
     * Copilot found this on #82 and it is right: sanitizing collapses a run of control characters
     * to one space, so a message made only of them passed the emptiness check and reached the
     * record as " ". The behavioural case is Windows-gated, so the rendered source is pinned too.
     */
    it("trims the sanitized reason on both sides of the bound", () => {
        const source = render().toString("utf8");
        assert.ok(source.includes("'[\\x00-\\x1f\\x7f]+',' ').Trim();"));
        assert.ok(source.includes("$bounded=$bounded.Substring(0,$Maximum).Trim()"));
    });

    it("never lets a whitespace-only reason reach the record", {skip: !HAS_INBOX_POWERSHELL}, () => {
        const bound = MAX_COMPLETION_EMISSION_FAILURE_CHARACTERS;
        /*
         * Control-only, space-only, empty, mixed, ordinary, and one that only goes blank at the cut.
         * Each element is parenthesised and string-seeded: bare `[char]13+[char]10` adds as numbers,
         * and an unparenthesised element lets the comma bind into the neighbouring expression.
         */
        const cases = [`(''+[char]13+[char]10)`, `('  ')`, `('')`, `(''+[char]9+' '+[char]7)`,
            `('real failure')`, `(''+[char]13+'real'+[char]10)`, `(('x'*${bound - 2})+'  y')`];
        const observed = runLibraryHarness("myspeed-baseline-bounded-text-",
            `@(${cases.join(",")})|ForEach-Object{Get-MyspeedBoundedFailureText $_ ${bound}}|` +
            "ConvertTo-Json -Compress\r\n");
        assert.deepEqual(observed, ["unspecified failure", "unspecified failure", "unspecified failure",
            "unspecified failure", "real failure", "real", "x".repeat(bound - 2)]);
        for (const reason of observed) assert.equal(reason, reason.trim());
    });

    it("reports both mechanisms' bounded failures without throwing when no port answers",
        {skip: !HAS_INBOX_POWERSHELL}, () => {
            const report = runLibraryHarness("myspeed-baseline-emission-absent-",
                `${COMPLETION_EMISSION_FUNCTION} 'LINE' ${psLiteral(ABSENT_PORT_NAME)} ` +
                `${psLiteral(ABSENT_DEVICE_PATH)}|ConvertTo-Json -Compress -Depth 4\r\n`);
            assert.equal(report.attempted, true);
            assert.equal(report.emitted, false);
            assert.deepEqual(report.attempts.map(attempt => attempt.method),
                [COMPLETION_EMISSION_METHOD_PORT, COMPLETION_EMISSION_METHOD_HANDLE]);
            for (const attempt of report.attempts) {
                assert.equal(attempt.emitted, false);
                assert.ok(attempt.failure.length > 0, "a refused mechanism must name its reason");
                assert.ok(attempt.failure.length <= MAX_COMPLETION_EMISSION_FAILURE_CHARACTERS);
                assert.equal([...attempt.failure].some(character =>
                    character.codePointAt(0) <= ASCII_CONTROL_MAX || character.codePointAt(0) === ASCII_DELETE),
                false, "a reported reason must stay printable");
            }
        });

    it("falls back to the raw handle and writes the exact record line when the managed port fails",
        {skip: !HAS_INBOX_POWERSHELL}, () => {
            const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-baseline-emission-fallback-"));
            const sink = path.join(root, "sink.bin");
            try {
                /* `FileMode::Open` never creates, so the stand-in device has to exist beforehand. */
                fs.writeFileSync(sink, "");
                const report = runLibraryHarness("myspeed-baseline-emission-sink-",
                    `${COMPLETION_EMISSION_FUNCTION} 'LINE' ${psLiteral(ABSENT_PORT_NAME)} ` +
                    `${psLiteral(sink)}|ConvertTo-Json -Compress -Depth 4\r\n`);
                assert.equal(report.emitted, true);
                assert.deepEqual(report.attempts.map(attempt => attempt.emitted), [false, true]);
                assert.equal(report.attempts[1].failure, null);
                assert.equal(fs.readFileSync(sink, "ascii"), "LINE\r\n");
            } finally { fs.rmSync(root, {recursive: true, force: true}); }
        });

    it("carries the emission report into the published shutdown outcome record",
        {skip: !HAS_INBOX_POWERSHELL}, () => {
            const events = runLibraryHarness("myspeed-baseline-emission-record-",
                completionBody("", `-EmitCompletion {param([string]$Line)[ordered]@{attempted=$true;emitted=$false;` +
                    `ports=@();attempts=@([ordered]@{method='${COMPLETION_EMISSION_METHOD_PORT}';emitted=$false;` +
                    `failure='port refused'})}} `));
            const outcome = JSON.parse(events.find(event => event.name === SHUTDOWN_OUTCOME_NAME).text);
            assert.equal(outcome.schemaVersion, SHUTDOWN_OUTCOME_SCHEMA_VERSION);
            assert.equal(outcome.outcome, "returned");
            assert.equal(outcome.completionEmission.emitted, false);
            assert.deepEqual([outcome.completionEmission.attempts].flat(),
                [{method: COMPLETION_EMISSION_METHOD_PORT, emitted: false, failure: "port refused"}]);
        });


    const VALID_COMPLETION = {schemaVersion: 1, kind: "myspeed-stage3-publication-complete", nonce: NONCE,
        baseline: {bytes: "1985", sha256: SHA("a")}, cpu: {bytes: "2809", sha256: SHA("b")}};
    const completionLine = record => `${COMPLETION_RECORD_PREFIX} ${JSON.stringify(record)}`;
    /* A copy of the valid record with one member replaced, so each case differs in exactly one way. */
    const mutate = (route, value) => {
        const record = structuredClone(VALID_COMPLETION);
        const keys = route.split(".");
        let cursor = record;
        while (keys.length > 1) cursor = cursor[keys.shift()];
        if (value === undefined) delete cursor[keys[0]]; else cursor[keys[0]] = value;
        return record;
    };

    it("accepts one well-formed completion record and returns both declared identities", () => {
        const parsed = parseCompletionRecord(completionLine(VALID_COMPLETION), NONCE);
        assert.equal(parsed.status, "valid");
        assert.deepEqual(parsed.record.baseline, {bytes: "1985", sha256: SHA("a")});
        assert.deepEqual(parsed.record.cpu, {bytes: "2809", sha256: SHA("b")});
    });

    it("ignores a line that is not completion-record shaped", () => {
        for (const line of ["", "BdsDxe: starting Boot0004", `${COMPLETION_RECORD_PREFIX}X {}`,
            COMPLETION_RECORD_PREFIX, "MYSPEED-STAGE3-COMPLETE-V2 {}"])
            assert.equal(parseCompletionRecord(line, NONCE), null, line);
    });

    it("rejects every marker-shaped line that does not meet the contract", () => {
        const oversized = structuredClone(VALID_COMPLETION);
        oversized.padding = "p".repeat(MAX_COMPLETION_RECORD_BYTES);
        const cases = [
            ["payload-oversized", completionLine(oversized)],
            ["payload-malformed", `${COMPLETION_RECORD_PREFIX} {"schemaVersion":1,`],
            ["payload-malformed", `${COMPLETION_RECORD_PREFIX} []`],
            ["payload-malformed", `${COMPLETION_RECORD_PREFIX} null`],
            ["schema-differs", completionLine(mutate("schemaVersion", 2))],
            ["kind-differs", completionLine(mutate("kind", "myspeed-stage3-guest-shutdown"))],
            ["nonce-differs", completionLine(mutate("nonce", "4".repeat(32)))],
            ["keys-differ", completionLine({...VALID_COMPLETION, extra: 1})],
            ["keys-differ", completionLine(mutate("cpu", undefined))],
            ["keys-differ", completionLine(mutate("baseline", {bytes: "1985", sha256: SHA("a"), extra: 1}))],
            ["identity-differs", completionLine(mutate("cpu.bytes", "02809"))],
            ["identity-differs", completionLine(mutate("cpu.bytes", "0"))],
            ["identity-differs", completionLine(mutate("cpu.bytes", "-1"))],
            ["identity-differs", completionLine(mutate("cpu.bytes", 2809))],
            ["identity-differs", completionLine(mutate("cpu.bytes", "2809 "))],
            ["identity-differs", completionLine(mutate("cpu.sha256", SHA("b").toUpperCase()))],
            ["identity-differs", completionLine(mutate("cpu.sha256", "b".repeat(63)))],
            ["identity-differs", completionLine(mutate("baseline.sha256", `${"a".repeat(63)}g`))]
        ];
        for (const [reason, line] of cases) {
            const parsed = parseCompletionRecord(line, NONCE);
            assert.equal(parsed?.status, "invalid", line.slice(0, 90));
            assert.equal(parsed.reason, reason, line.slice(0, 90));
        }
    });

    it("rejects a record carrying control or non-ASCII bytes", () => {
        for (const code of [7, ASCII_DELETE, 233, 0]) {
            const nonce = `${NONCE.slice(1)}${String.fromCharCode(code)}`;
            assert.equal(parseCompletionRecord(completionLine(mutate("nonce", nonce)), NONCE).status, "invalid");
        }
    });

});
