import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "qualification", "media-job-launcher.ps1");
const POWERSHELL = process.platform === "win32"
    ? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : "pwsh";
const PROCESS_TIMEOUT_MS = 30_000;
const HAS_POWERSHELL = spawnSync(POWERSHELL,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"],
    {encoding: "utf8", timeout: PROCESS_TIMEOUT_MS}).status === 0;
const powershellIt = (name, fn) => it(name,
    {timeout: PROCESS_TIMEOUT_MS, skip: !HAS_POWERSHELL && "PowerShell unavailable"}, fn);

describe("observed owned-Job launcher envelope", () => {
    powershellIt("keeps the legacy result unchanged when no observer is supplied", () => {
        const result = invokeScenario("legacy-success");
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(lastJson(result.stdout).result, {
            schemaVersion: 1, authorizesTransfer: false, processId: 42,
            exitCode: 0, timedOut: false, processTreeExitProven: true
        });
    });

    powershellIt("runs the hash-bound observer only after assignment and resume and between wait slices", () => {
        const record = runScenario("observer-success");
        assert.equal(record.status, "completed");
        assert.equal(record.authorizesTransfer, false);
        assert.deepEqual(record.arguments, ["alpha", "with space"]);
        assert.equal(record.executable.beforeSha256, record.executable.expectedSha256);
        assert.equal(record.executable.afterSha256, record.executable.expectedSha256);
        assert.deepEqual(record.process, {
            processId: 42, assignedBeforeResume: true, resumed: true,
            retainedHandleThroughExit: true
        });
        assert.equal(record.timedOut, false);
        assert.equal(record.forced, false);
        assert.equal(record.processTreeExitProven, true);
        assert.deepEqual(record.handles, {job: "closed", process: "closed", thread: "closed"});
        assert.ok(record.timing.postReturnMonotonicMilliseconds >= record.timing.lastMonotonicMilliseconds);
        assert.ok(record.timing.postReturnWallUnixMilliseconds >= record.timing.lastWallUnixMilliseconds);
        assert.equal(record.observer.tickCount, 2);
        assert.equal(record.observer.lastAction, "none");
        assert.equal(record.observer.lastObservation, "pending");
        assert.equal(record.observer.synchronousCancellationProven, false);
        assert.equal(record.observer.sha256.length, 64);
        assert.deepEqual(record.calls.slice(0, 8), [
            "clock", "create-job", "configure-job", "create-suspended", "assign", "clock", "resume", "clock"
        ]);
        assert.ok(record.calls.indexOf("observer:0") > record.calls.indexOf("resume"));
        assert.ok(record.calls.indexOf("observer:0") < record.calls.indexOf("wait:process"));
        assert.ok(record.calls.indexOf("observer:1") > record.calls.indexOf("wait:process"));
    });

    powershellIt("rejects an unbound observer before creating native resources", () => {
        const record = runScenario("observer-hash-mismatch");
        assert.equal(record.status, "failed", JSON.stringify(record));
        assert.match(record.failure.message, /observer SHA-256/i);
        assert.deepEqual(record.calls, []);
        assert.deepEqual(record.handles, {job: "not-created", process: "not-created", thread: "not-created"});
    });

    powershellIt("cleans the assigned Job and preserves a callback failure envelope", () => {
        const record = runScenario("observer-failure");
        assert.equal(record.status, "failed");
        assert.equal(record.process.assignedBeforeResume, true);
        assert.equal(record.process.resumed, true);
        assert.equal(record.forced, true);
        assert.equal(record.processTreeExitProven, true);
        assert.deepEqual(record.handles, {job: "closed", process: "closed", thread: "closed"});
        assert.match(record.failure.message, /observer failed/i);
        assert.ok(record.calls.indexOf("observer:0") < record.calls.indexOf("terminate-job:job"));
    });

    powershellIt("checks the deadline after every callback and forces cleanup on measured overrun", () => {
        const record = runScenario("observer-overrun");
        assert.equal(record.status, "failed", JSON.stringify(record));
        assert.equal(record.timedOut, true);
        assert.equal(record.forced, true);
        assert.equal(record.processTreeExitProven, true);
        assert.match(record.failure.message, /deadline|duration/i);
        assert.equal(record.calls.some(value => value.startsWith("wait:process:")), true);
        assert.equal(record.calls.includes("wait:process"), false,
            "the ordinary wait must not run after the observer consumed the deadline");
    });

    powershellIt("reports truthful partial-launch proofs when assignment fails before resume", () => {
        const record = runScenario("assignment-failure");
        assert.equal(record.status, "failed");
        assert.deepEqual(record.process, {
            processId: 42, assignedBeforeResume: false, resumed: false,
            retainedHandleThroughExit: true
        });
        assert.equal(record.forced, true);
        assert.equal(record.processTreeExitProven, true);
        assert.equal(record.observer.tickCount, 0);
        assert.deepEqual(record.handles, {job: "closed", process: "closed", thread: "closed"});
        assert.doesNotMatch(JSON.stringify(record.calls), /resume|observer/);
    });

    powershellIt("fails when process exit is first observed at its deadline", () => {
        for (const scenario of ["exit-at-deadline", "exit-at-wall-deadline", "exit-after-deadline"]) {
            const record = runScenario(scenario);
            assert.equal(record.status, "failed", scenario);
            assert.equal(record.timedOut, true, scenario);
            assert.equal(record.forced, false, scenario);
            assert.equal(record.processTreeExitProven, true, scenario);
            assert.deepEqual(record.handles, {job: "closed", process: "closed", thread: "closed"});
            assert.match(record.failure.message, /deadline/i);
        }
    });

    powershellIt("fails when either clock moves backward during the final wait", () => {
        for (const scenario of ["exit-wall-backward", "exit-monotonic-backward"]) {
            const record = runScenario(scenario);
            assert.equal(record.status, "failed", scenario);
            assert.match(record.failure.message, /clock moved backward/i);
            assert.equal(record.processTreeExitProven, true, scenario);
            assert.deepEqual(record.handles, {job: "closed", process: "closed", thread: "closed"});
        }
    });

    powershellIt("rejects an observer token ending with a newline", () => {
        const record = runScenario("observer-trailing-newline");
        assert.equal(record.status, "failed");
        assert.match(record.failure.message, /observer result schema/i);
        assert.equal(record.processTreeExitProven, true);
    });

    powershellIt("rejects malformed observer output and exposes no native handle to the callback", () => {
        const record = runScenario("observer-malformed");
        assert.equal(record.status, "failed");
        assert.match(record.failure.message, /observer result schema/i);
        assert.equal(record.observer.receivedNativeHandle, false);
        assert.equal(record.processTreeExitProven, true);
    });

    powershellIt("rejects an unbounded observer token and cleans the owned tree", () => {
        const record = runScenario("observer-invalid-token");
        assert.equal(record.status, "failed");
        assert.match(record.failure.message, /observer result schema/i);
        assert.equal(record.forced, true);
        assert.equal(record.processTreeExitProven, true);
    });

    powershellIt("does not claim resource closure when an owned handle cannot be closed", () => {
        const record = runScenario("handle-close-failure");
        assert.equal(record.status, "failed");
        assert.match(record.failure.message, /close failed/i);
        assert.deepEqual(record.handles, {job: "closed", process: "closed", thread: "open"});
        assert.equal(record.processTreeExitProven, true);
    });
});

function runScenario(scenario) {
    const result = invokeScenario(scenario);
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return lastJson(result.stdout);
}

function invokeScenario(scenario) {
    const executable = path.resolve(process.execPath);
    const workingDirectory = path.dirname(executable);
    const expectedExecutableSha256 = crypto.createHash("sha256").update(fs.readFileSync(executable)).digest("hex");
    const encodedScenario = Buffer.from(scenario).toString("base64");
    const program = `
. '${quotePowerShell(SCRIPT)}'
$scenario=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedScenario}'))
$calls=[Collections.Generic.List[string]]::new();$fake=@{jobTerminated=$false;processExited=$false;clockIndex=0;waitCount=0}
$clockValues=switch($scenario){
  'observer-overrun' {@(@{w=1000;m=1000},@{w=1001;m=1001},@{w=1002;m=1002},@{w=5000;m=5000})}
  'exit-at-deadline' {@(@{w=1000;m=1000},@{w=1001;m=1001},@{w=1002;m=1002},@{w=1003;m=1003},@{w=2000;m=2000})}
  default {@(@{w=1000;m=1000},@{w=1001;m=1001},@{w=1002;m=1002},@{w=1003;m=1003},@{w=1004;m=1004},@{w=1005;m=1005})}
}
$clockOverrides=@{
  'exit-at-wall-deadline'=@{w=5000;m=1004}
  'exit-after-deadline'=@{w=5001;m=2001}
  'exit-wall-backward'=@{w=1002;m=1004}
  'exit-monotonic-backward'=@{w=1004;m=1002}
}
$finalWaitClockIndex=4
if($clockOverrides.ContainsKey($scenario)){$clockValues[$finalWaitClockIndex]=$clockOverrides[$scenario]}
$clock={
  [void]$calls.Add('clock');$selected=$clockValues[[Math]::Min($fake.clockIndex,$clockValues.Count-1)];$fake.clockIndex++
  @{WallUnixMilliseconds=$selected.w;MonotonicMilliseconds=$selected.m}
}.GetNewClosure()
$native=@{
  CreateJob={[void]$calls.Add('create-job');'job'}.GetNewClosure()
  ConfigureKillOnClose={param($job)[void]$calls.Add('configure-job')}.GetNewClosure()
  CreateSuspended={param($exe,$command,$cwd)[void]$calls.Add('create-suspended');@{ProcessHandle='process';ThreadHandle='thread';ProcessId=42}}.GetNewClosure()
  Assign={param($job,$process)[void]$calls.Add('assign');if($scenario -ceq 'assignment-failure'){throw 'assignment failed'}}.GetNewClosure()
  Resume={param($thread)[void]$calls.Add('resume')}.GetNewClosure()
  Wait={param($process,$milliseconds)
    if($milliseconds -eq 2000){[void]$calls.Add(('wait:'+ $process +':2000'));'Exited'}
    elseif($scenario -ceq 'observer-success' -and $fake.waitCount -eq 0){
      $fake.waitCount++;[void]$calls.Add('wait:process');'Timeout'
    }else{[void]$calls.Add('wait:process');$fake.processExited=$true;'Exited'}
  }.GetNewClosure()
  ExitCode={param($process)0}.GetNewClosure()
  Terminate={param($process)[void]$calls.Add('terminate:process')}.GetNewClosure()
  ActiveProcesses={param($job)[void]$calls.Add('active-processes:job');if($fake.jobTerminated -or $fake.processExited){0}else{1}}.GetNewClosure()
  TerminateJob={param($job)[void]$calls.Add('terminate-job:job');$fake.jobTerminated=$true}.GetNewClosure()
  Sleep={param($milliseconds)[void]$calls.Add('sleep')}.GetNewClosure()
  Close={param($handle)[void]$calls.Add(('close:'+$handle));if($scenario -ceq 'handle-close-failure' -and $handle -ceq 'thread'){throw 'close failed'}}.GetNewClosure()
}
$observer={param($context)
  if((@($context.PSObject.Properties.Name|Sort-Object) -join ',') -cne
    ((@('monotonicDeadlineMilliseconds','monotonicMilliseconds','processId','schemaVersion','tick','wallDeadlineUnixMilliseconds','wallUnixMilliseconds')|Sort-Object) -join ',')){
    throw 'Observer received unexpected context'
  }
  [void]$calls.Add(('observer:'+$context.tick))
  if($scenario -ceq 'observer-failure'){throw 'observer failed'}
  if($scenario -ceq 'observer-malformed'){return [pscustomobject]@{schemaVersion=1;status='observed';action='none';observation='pending';extra=$true}}
  if($scenario -ceq 'observer-invalid-token'){return [pscustomobject]@{schemaVersion=1;status='observed';action='none';observation=('x'*65)}}
  if($scenario -ceq 'observer-trailing-newline'){return [pscustomobject]@{schemaVersion=1;status='observed';action='none';observation=('pending'+[char]10)}}
  return [pscustomobject]@{schemaVersion=1;status='observed';action='none';observation='pending'}
}.GetNewClosure()
if($scenario -ceq 'legacy-success'){
  $result=Invoke-OwnedJobProcess -Executable '${quotePowerShell(executable)}' -ArgumentList @() \`
    -WorkingDirectory '${quotePowerShell(workingDirectory)}' -WallDeadlineUnixMilliseconds 5000 \`
    -MaximumDurationMilliseconds 1000 -NativeMethods $native -Clock $clock
  [pscustomobject]@{result=$result;calls=@($calls)}|ConvertTo-Json -Compress -Depth 8
  return
}
$observerSha=Get-MediaJobScriptBlockSha256 $observer
if($scenario -ceq 'observer-hash-mismatch'){$observerSha=('f'*64)}
$record=Invoke-ObservedOwnedJobProcess -Executable '${quotePowerShell(executable)}' \`
  -ExpectedExecutableSha256 '${expectedExecutableSha256}' -ArgumentList @('alpha','with space') \`
  -WorkingDirectory '${quotePowerShell(workingDirectory)}' -WallDeadlineUnixMilliseconds 5000 \`
  -MaximumDurationMilliseconds 1000 -Observer $observer -ExpectedObserverSha256 $observerSha \`
  -NativeMethods $native -Clock $clock
$record|Add-Member -NotePropertyName calls -NotePropertyValue @($calls)
if($scenario -ceq 'observer-malformed'){
  $receivedHandle=@($record.observer.contextKeys|Where-Object {$_ -match 'handle|job|thread'})
  $record.observer|Add-Member -NotePropertyName receivedNativeHandle -NotePropertyValue ($receivedHandle.Count -ne 0)
}
$record|ConvertTo-Json -Compress -Depth 8
`;
    return runPowerShell(program);
}

function runPowerShell(command) {
    const encoded = Buffer.from(command, "utf16le").toString("base64");
    return spawnSync(POWERSHELL,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
        {encoding: "utf8", timeout: PROCESS_TIMEOUT_MS});
}

function lastJson(output) {
    return JSON.parse(output.trim().split(/\r?\n/u).at(-1));
}

function quotePowerShell(value) {
    return value.replaceAll("'", "''");
}
