import {afterEach, describe, it} from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRIPT = path.resolve("scripts/qualification/media-job-launcher.ps1");

describe("Windows PowerShell 5.1/C# kill-on-close launcher", {skip: process.platform !== "win32" && "Windows only"}, () => {
    it("is dot-source safe and has no transfer-authorizing CLI", () => {
        const result = runPowerShell(`. '${quotePowerShell(SCRIPT)}'; [Console]::Out.Write('imported')`);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, "imported");
        assert.doesNotMatch(fs.readFileSync(SCRIPT, "utf8"), /curl|https?:\/\//i);
    });

    it("starts the supplied absolute application suspended, assigns it before resume, and preserves Windows argv", () => {
        const root = makeRoot();
        const output = path.join(root, "argv.json");
        const descendantPidFile = path.join(root, "normal-descendant.pid");
        const grandchild = path.join(root, "normal-grandchild.mjs");
        const child = path.join(root, "complete.mjs");
        fs.writeFileSync(grandchild, "setInterval(() => {}, 1000);\n");
        fs.writeFileSync(child, `
import fs from "node:fs";
import {spawn} from "node:child_process";
const descendant = spawn(process.execPath, [process.argv[3]], {stdio: "ignore"});
fs.writeFileSync(process.argv[4], String(descendant.pid));
fs.writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(5)));
process.exit(7);
`);
        const tricky = ["plain", "with space", "quote\\\"inside", "trailing\\\\", ""];
        const invocation = invokeActual({
            executable: process.execPath,
            arguments: [child, output, grandchild, descendantPidFile, ...tricky],
            workingDirectory: root,
            maximumDurationMilliseconds: NORMAL_DURATION_MS
        });
        assert.equal(invocation.status, 0, invocation.stderr);
        const record = lastJson(invocation.stdout);
        assert.deepEqual(record, {
            schemaVersion: 1,
            authorizesTransfer: false,
            processId: record.processId,
            exitCode: 7,
            timedOut: false,
            processTreeExitProven: true
        });
        assert.ok(Number.isSafeInteger(record.processId) && record.processId > 0);
        assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), tricky);
        assert.equal(processExists(Number(fs.readFileSync(descendantPidFile, "utf8"))), false,
            "a descendant survived after the primary exited normally");
    });

    it("terminates the private job and proves child and descendant exit on timeout", () => {
        const root = makeRoot();
        const pidFile = path.join(root, "pids.json");
        const grandchild = path.join(root, "grandchild.mjs");
        const child = path.join(root, "hang.mjs");
        fs.writeFileSync(grandchild, "setInterval(() => {}, 1000);\n");
        fs.writeFileSync(child, `
import fs from "node:fs";
import {spawn} from "node:child_process";
const descendant = spawn(process.execPath, [process.argv[2]], {stdio: "ignore"});
fs.writeFileSync(process.argv[3], JSON.stringify([process.pid, descendant.pid]));
setInterval(() => {}, 1000);
`);
        const invocation = invokeActual({
            executable: process.execPath,
            arguments: [child, grandchild, pidFile],
            workingDirectory: root,
            maximumDurationMilliseconds: TIMEOUT_DURATION_MS
        });
        assert.equal(invocation.status, 0, invocation.stderr);
        const record = lastJson(invocation.stdout);
        assert.equal(record.timedOut, true);
        assert.equal(record.processTreeExitProven, true);
        const pids = JSON.parse(fs.readFileSync(pidFile, "utf8"));
        assert.equal(pids.length, 2);
        for (const pid of pids) assert.equal(processExists(pid), false, `PID ${pid} survived job disposal`);
    });

    it("terminates only the still-suspended child when assignment fails and never resumes it", () => {
        const calls = invokeFake("assignment");
        assert.equal(calls.status, 0, calls.stderr);
        const record = lastJson(calls.stdout);
        assert.match(record.error, /assignment failed/);
        assert.deepEqual(record.calls, [
            "clock", "create-job", "configure-job", "create-suspended", "assign",
            "terminate:process", "wait:process:2000", "close:thread", "close:process", "close:job"
        ]);
        assert.doesNotMatch(JSON.stringify(record.calls), /resume/);
    });

    it("terminates the kill-on-close job and proves exit after resume or clock failures", () => {
        for (const failure of ["resume", "clock", "monotonic", "wall"]) {
            const invocation = invokeFake(failure);
            assert.equal(invocation.status, 0, invocation.stderr);
            const record = lastJson(invocation.stdout);
            const expected = {
                resume: /resume failed/,
                clock: /clock failed/,
                monotonic: /monotonic clock moved backward/i,
                wall: /wall clock moved backward/i
            }[failure];
            assert.match(record.error, expected);
            assert.equal(record.calls.filter(value => value === "close:job").length, 1);
            assert.ok(record.calls.includes("wait:process:2000"));
            assert.equal(record.calls.some(value => value.startsWith("terminate:")), false);
            assert.equal(record.processTreeExitProven, true);
        }
    });

    it("preserves the original failure but refuses tree-exit proof when job accounting fails", () => {
        const invocation = invokeFake("tree-accounting");
        assert.equal(invocation.status, 0, invocation.stderr);
        const record = lastJson(invocation.stdout);
        assert.match(record.error, /resume failed/);
        assert.equal(record.processTreeExitProven, false);
        assert.ok(record.calls.includes("active-processes:job"));
        assert.ok(record.calls.includes("terminate-job:job"));
    });

    it("never resumes a suspended child when either deadline expires during native setup", () => {
        for (const expiry of ["setup-wall", "setup-monotonic"]) {
            const invocation = invokeFake(expiry);
            assert.equal(invocation.status, 0, invocation.stderr);
            const record = lastJson(invocation.stdout);
            assert.equal(record.result.timedOut, true);
            assert.equal(record.result.processTreeExitProven, true);
            assert.equal(record.result.authorizesTransfer, false);
            assert.ok(record.calls.includes("assign"));
            assert.ok(record.calls.includes("terminate-job:job"));
            assert.equal(record.calls.includes("resume"), false,
                "expired setup must terminate the still-suspended child without executing it");
        }
    });

    it("rejects noncanonical launch boundaries before calling the native seam", () => {
        const root = makeRoot();
        const relative = invokeValidation("node.exe", root);
        assert.equal(relative.status, 0, relative.stderr);
        assert.match(lastJson(relative.stdout).error, /absolute ordinary leaf file/);
        assert.deepEqual(lastJson(relative.stdout).calls, []);

        const missingWork = invokeValidation(process.execPath, path.join(root, "missing"));
        assert.equal(missingWork.status, 0, missingWork.stderr);
        assert.match(lastJson(missingWork.stdout).error, /working directory/i);
        assert.deepEqual(lastJson(missingWork.stdout).calls, []);

        const nullArgument = runPowerShell(`
. '${quotePowerShell(SCRIPT)}'
try { ConvertTo-ExactCommandLine '${quotePowerShell(process.execPath)}' @($null) | Out-Null; 'missing failure' } catch { $_.Exception.Message }
`);
        assert.equal(nullArgument.status, 0, nullArgument.stderr);
        assert.match(nullArgument.stdout, /arguments must be strings/i);
    });
});

function makeRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-job-launcher-"));
    roots.push(root);
    return fs.realpathSync.native(root);
}

function invokeActual({executable, arguments: args, workingDirectory, maximumDurationMilliseconds}) {
    const wallDeadline = Date.now() + WALL_DEADLINE_OFFSET_MS;
    return runPowerShell(`
. '${quotePowerShell(SCRIPT)}'
$arguments = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${base64Json(args)}')) | ConvertFrom-Json
Invoke-OwnedJobProcess -Executable '${quotePowerShell(executable)}' -ArgumentList @($arguments) -WorkingDirectory '${quotePowerShell(workingDirectory)}' -WallDeadlineUnixMilliseconds ${wallDeadline} -MaximumDurationMilliseconds ${maximumDurationMilliseconds} | ConvertTo-Json -Compress
`, ACTUAL_TEST_TIMEOUT_MS);
}

function fakeBody(failure, executable = process.execPath, workingDirectory = path.dirname(process.execPath)) {
    return `
. '${quotePowerShell(SCRIPT)}'
$calls = New-Object 'System.Collections.Generic.List[string]'
$clockCount = 0
$native = @{
  CreateJob = { [void]$calls.Add('create-job'); 'job' }.GetNewClosure()
  ConfigureKillOnClose = { param($job) [void]$calls.Add('configure-job') }.GetNewClosure()
  CreateSuspended = { param($exe, $commandLine, $cwd) [void]$calls.Add('create-suspended'); @{ ProcessHandle='process'; ThreadHandle='thread'; ProcessId=42 } }.GetNewClosure()
  Assign = { param($job, $process) [void]$calls.Add('assign'); ${failure === "assignment" ? "throw 'assignment failed'" : "$true"} }.GetNewClosure()
  Resume = { param($thread) [void]$calls.Add('resume'); ${["resume", "tree-accounting"].includes(failure) ? "throw 'resume failed'" : "$true"} }.GetNewClosure()
  Wait = { param($process, $milliseconds) [void]$calls.Add(('wait:' + $process + ':' + $milliseconds)); ${["clock", "monotonic", "wall"].includes(failure) ? "if ($milliseconds -ne 2000) { 'Timeout' } else { 'Exited' }" : "'Exited'"} }.GetNewClosure()
  ExitCode = { param($process) 0 }.GetNewClosure()
  Terminate = { param($process) [void]$calls.Add(('terminate:' + $process)); $true }.GetNewClosure()
  ActiveProcesses = { param($job) [void]$calls.Add(('active-processes:' + $job)); ${failure === "tree-accounting" ? "if (@($calls | Where-Object { $_ -eq 'active-processes:job' }).Count -gt 1) { throw 'accounting failed' }; 1" : "if (@($calls | Where-Object { $_ -eq 'terminate-job:job' }).Count -gt 0) { 0 } else { 1 }"} }.GetNewClosure()
  TerminateJob = { param($job) [void]$calls.Add(('terminate-job:' + $job)); $true }.GetNewClosure()
  Sleep = { param($milliseconds) [void]$calls.Add(('sleep:' + $milliseconds)) }.GetNewClosure()
  Close = { param($handle) [void]$calls.Add(('close:' + $handle)); $true }.GetNewClosure()
}
$clock = {
  [void]$calls.Add('clock')
  $clockCount = @($calls | Where-Object { $_ -eq 'clock' }).Count
  ${failure === "clock" ? "if ($clockCount -gt 1) { throw 'clock failed' }" : ""}
  $wall = ${failure === "setup-wall" ? `if ($clockCount -gt 1) { ${FAKE_LATE_CLOCK_MS} } else { 1000 }` : failure === "wall" ? "if ($clockCount -gt 1) { 999 } else { 1000 }" : "1000"}
  $monotonic = ${failure === "setup-monotonic" ? `if ($clockCount -gt 1) { ${FAKE_LATE_CLOCK_MS} } else { 1000 }` : failure === "monotonic" ? "if ($clockCount -gt 1) { 999 } else { 1000 }" : "(1000 + $clockCount)"}
  @{ WallUnixMilliseconds=$wall; MonotonicMilliseconds=$monotonic }
}.GetNewClosure()
try {
  $result = Invoke-OwnedJobProcess -Executable '${quotePowerShell(executable)}' -ArgumentList @() -WorkingDirectory '${quotePowerShell(workingDirectory)}' -WallDeadlineUnixMilliseconds 5000 -MaximumDurationMilliseconds 1000 -NativeMethods $native -Clock $clock
  $out = @{ error='missing failure'; calls=@($calls); processTreeExitProven=$false; result=$result }
} catch {
  $out = @{ error=$_.Exception.Message; calls=@($calls); processTreeExitProven=($_.Exception.Data['ProcessTreeExitProven'] -eq $true) }
}
$out | ConvertTo-Json -Compress
`;
}

function invokeFake(failure) {
    return runPowerShell(fakeBody(failure));
}

function invokeValidation(executable, workingDirectory) {
    const body = fakeBody("validation", executable, workingDirectory)
        .replace("$out = @{ error='missing failure'; calls=@($calls); processTreeExitProven=$false }",
            "$out = @{ error='missing validation failure'; calls=@($calls); processTreeExitProven=$false }");
    return runPowerShell(body);
}

function runPowerShell(command, timeout = POWERSHELL_TIMEOUT_MS) {
    const encoded = Buffer.from(command, "utf16le").toString("base64");
    return spawnSync(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
        encoding: "utf8", timeout, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true
    });
}

function processExists(pid) {
    const result = spawnSync("tasklist.exe", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
        encoding: "utf8", windowsHide: true
    });
    return result.status === 0 && result.stdout.includes(`"${pid}"`);
}

function lastJson(output) {
    return JSON.parse(output.trim().split(/\r?\n/).at(-1));
}

function quotePowerShell(value) {
    return value.replaceAll("'", "''");
}

function base64Json(value) {
    return Buffer.from(JSON.stringify(value)).toString("base64");
}

const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const POWERSHELL_TIMEOUT_MS = 10_000;
const ACTUAL_TEST_TIMEOUT_MS = 15_000;
const NORMAL_DURATION_MS = 5_000;
const TIMEOUT_DURATION_MS = 1_000;
const WALL_DEADLINE_OFFSET_MS = 10_000;
const MAX_OUTPUT_BYTES = 1_048_576;
const FAKE_LATE_CLOCK_MS = 10_000;
const roots = [];

afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, {recursive: true, force: true});
});
