import {afterEach, describe, it} from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRIPT = path.resolve("scripts/qualification/windows-cpu-tool-child.ps1");
const NONCE = "0123456789abcdef0123456789abcdef";
const EVENT_SHA = "1".repeat(40);
const SOURCE_SHA = "2".repeat(40);
const TOOL_STREAM_LIMIT = 65_536;
const TOOL_DURATION_MS = 30_000;
const PROBE_STREAM_LIMIT = 4_096;
const PROBE_DURATION_MS = 10_000;
const RESULT_LIMIT = 262_144;
const POWERSHELL_TIMEOUT_MS = 20_000;
const roots = [];

describe("owned Windows CPU tool child wrapper", {skip: process.platform !== "win32" && "Windows only"}, () => {
    it("is import-safe and rejects local native invocation before Add-Type or a result write", () => {
        const fixture = makeFixture();
        const imported = runPowerShell(`. '${ps(SCRIPT)}'; [Console]::Out.Write('imported')`);
        assert.equal(imported.status, 0, imported.stderr);
        assert.equal(imported.stdout, "imported");

        const invoked = spawnSync(WINDOWS_POWERSHELL, [
            "-NoProfile", "-File", SCRIPT, "-Mode", "InvokeHostedToolChild",
            "-RequestPath", fixture.requestPath,
            "-ExpectedRequestSha256", fixture.requestSha256
        ], {encoding: "utf8", timeout: POWERSHELL_TIMEOUT_MS});
        assert.notEqual(invoked.status, 0);
        assert.match(invoked.stderr, /hosted context/i);
        assert.equal(fs.existsSync(fixture.resultPath), false);
    });

    it("validates the exact hashed request and canonical nonce result boundary", () => {
        const fixture = makeFixture();
        const result = invokeValidation(fixture);
        assert.equal(result.status, 0, result.stderr);
        const record = lastJson(result.stdout);
        assert.equal(record.operationId, "cpuid");
        assert.equal(record.requestSha256, fixture.requestSha256);
        assert.equal(record.toolSha256, fixture.request.toolSha256);
        assert.equal(record.resultPath, fixture.resultPath);

        for (const mutate of [
            value => { value.extra = true; },
            value => { value.maximumDurationMilliseconds = TOOL_DURATION_MS - 1; },
            value => { value.streamLimitBytes = PROBE_STREAM_LIMIT; },
            value => { value.resultPath = path.join(path.dirname(path.dirname(value.resultPath)), "outside.json"); },
            value => { value.arguments = [null]; },
            value => { value.toolSha256 = "f".repeat(64); }
        ]) {
            const invalid = makeFixture();
            mutate(invalid.request);
            rewriteRequest(invalid);
            const rejected = invokeValidation(invalid);
            assert.notEqual(rejected.status, 0, rejected.stdout);
        }

        const staleHash = invokeValidation(fixture, "f".repeat(64));
        assert.notEqual(staleHash.status, 0);
        assert.match(staleHash.stderr, /request hash/i);
    });

    it("hashes the exact bounded request bytes read from one owned handle", () => {
        const fixture = makeFixture();
        const different = Buffer.from(JSON.stringify({...fixture.request, operationId: "different"}));
        const encoded = different.toString("base64");
        const body = `
. '${ps(SCRIPT)}'
$events = New-Object 'System.Collections.Generic.List[string]'
$operations = @{
  Open = { param($path) [void]$events.Add('open'); 'handle' }.GetNewClosure()
  Length = { param($handle) [void]$events.Add('length'); ${different.length} }.GetNewClosure()
  ReadAll = { param($handle,$length) [void]$events.Add('read'); [Convert]::FromBase64String('${encoded}') }.GetNewClosure()
  Close = { param($handle) [void]$events.Add('close') }.GetNewClosure()
}
try { Read-MyspeedToolChildRequest -Path '${ps(fixture.requestPath)}' -ExpectedSha256 '${fixture.requestSha256}' -FileOperations $operations | Out-Null; $errorMessage='accepted swapped bytes' } catch { $errorMessage=$_.Exception.Message }
$oversized = @{
  Open = { param($path) [void]$events.Add('open-large'); 'large' }.GetNewClosure()
  Length = { param($handle) [void]$events.Add('length-large'); 65537 }.GetNewClosure()
  ReadAll = { param($handle,$length) [void]$events.Add('read-large'); [byte[]]@() }.GetNewClosure()
  Close = { param($handle) [void]$events.Add('close-large') }.GetNewClosure()
}
try { Read-MyspeedBoundedRequestBytes '${ps(fixture.requestPath)}' 65536 $oversized | Out-Null; $largeError='accepted oversized request' } catch { $largeError=$_.Exception.Message }
[pscustomobject]@{ error=$errorMessage; largeError=$largeError; events=@($events) } | ConvertTo-Json -Compress
`;
        const result = runPowerShell(body);
        assert.equal(result.status, 0, result.stderr);
        const record = lastJson(result.stdout);
        assert.match(record.error, /request hash/i);
        assert.match(record.largeError, /length|bound|size/i);
        assert.deepEqual(record.events, ["open", "length", "read", "close", "open-large", "length-large", "close-large"]);
    });

    it("requires the full hosted PowerShell and clean compiler environment before native construction", () => {
        const fixture = makeFixture();
        const body = `
. '${ps(SCRIPT)}'
$request = Read-MyspeedToolChildRequest '${ps(fixture.requestPath)}' '${fixture.requestSha256}'
$context = [pscustomobject]@{
  GITHUB_ACTIONS='true'; CI='true'; RUNNER_OS='Windows'; RUNNER_ARCH='X64'; RUNNER_ENVIRONMENT='github-hosted'
  GITHUB_REPOSITORY='i7Gamer/MySpeed'; ImageOS='win25-vs2026'; ImageVersion='20260907.229.1'
  GITHUB_RUN_ID=$request.expectedRunId; GITHUB_RUN_ATTEMPT=$request.expectedRunAttempt; GITHUB_SHA=$request.expectedEventSha
  RUNNER_TEMP='${ps(path.dirname(fixture.root))}'; CL=$null; _CL_=$null; LINK=$null; _LINK_=$null
  Is64BitProcess=$true; PSEdition='Desktop'; PSVersionMajor=5
  PowerShellPath=([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName); SystemRoot=$env:SystemRoot
}
Assert-MyspeedHostedToolChildContext $request $context | Out-Null
$rejected = 0
foreach ($change in @(
  @{name='ImageVersion';value='bad version'}, @{name='Is64BitProcess';value=$false},
  @{name='PSEdition';value='Core'}, @{name='PSVersionMajor';value=7},
  @{name='PowerShellPath';value='C:\\other\\powershell.exe'}, @{name='CL';value='/O0'},
  @{name='GITHUB_ACTIONS';value=$true}
)) {
  $copy = $context | ConvertTo-Json -Depth 4 | ConvertFrom-Json
  $copy.($change.name) = $change.value
  try { Assert-MyspeedHostedToolChildContext $request $copy | Out-Null } catch { $rejected++ }
}
[pscustomobject]@{rejected=$rejected} | ConvertTo-Json -Compress
`;
        const result = runPowerShell(body);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(lastJson(result.stdout).rejected, 7);
    });

    it("returns exact successful bytes and the core-compatible wrapper proof", () => {
        const fixture = makeFixture();
        const invocation = invokeCore(fixture, "success");
        assert.equal(invocation.status, 0, invocation.stderr);
        const record = lastJson(invocation.stdout);
        assert.equal(record.status, "completed");
        assert.equal(record.parentJobMembershipProven, true);
        assert.equal(record.childExitProven, true);
        assert.equal(record.handlesClosedProven, true);
        assert.deepEqual(record.wrapper, {
            schemaVersion: 1,
            status: "completed",
            childProcessId: 42,
            exitCode: 19,
            timedOut: false,
            durationMilliseconds: 7,
            stdoutBytes: 4,
            stderrBytes: 3,
            outputDrainProven: true,
            childJobMembershipProven: true,
            errorModeRestored: true
        });
        assert.deepEqual(Buffer.from(record.stdoutBase64, "base64"), Buffer.from([0, 1, 254, 255]));
        assert.deepEqual(Buffer.from(record.stderrBase64, "base64"), Buffer.from([65, 66, 67]));
        assert.deepEqual(record.failures, []);
        assert.equal(record.errorMode.required, false);
        assert.deepEqual(record.bindings.arguments, fixture.request.arguments);
        assert.equal(record.bindings.requestSha256, fixture.requestSha256);
    });

    it("applies and restores process-local error mode only for probes", () => {
        const fixture = makeFixture({isProbe: true});
        const invocation = invokeCore(fixture, "success");
        assert.equal(invocation.status, 0, invocation.stderr);
        const record = lastJson(invocation.stdout);
        assert.deepEqual(record.errorMode, {
            required: true,
            requiredFlags: 3,
            before: 16,
            during: 19,
            after: 16,
            restored: true
        });
        assert.deepEqual(record.calls, ["parent-job", "set-error:3", "run-child", "restore-error:16"]);

        const failed = invokeCore(makeFixture({isProbe: true}), "restore-failure");
        assert.equal(failed.status, 0, failed.stderr);
        const failedRecord = lastJson(failed.stdout);
        assert.equal(failedRecord.status, "failed");
        assert.equal(failedRecord.wrapper.errorModeRestored, false);
        assert.match(failedRecord.failures.join("\n"), /error-mode restoration/i);

        const creation = invokeCore(makeFixture({isProbe: true}), "creation-failure");
        assert.equal(creation.status, 0, creation.stderr);
        assert.deepEqual(lastJson(creation.stdout).calls,
            ["parent-job", "set-error:3", "run-child", "restore-error:16"]);
    });

    it("fails closed for timeout, overflow, read, creation, membership, and cleanup failures", () => {
        for (const scenario of ["timeout", "overflow", "read-failure", "creation-failure", "membership-failure", "cleanup-failure"]) {
            const fixture = makeFixture();
            const invocation = invokeCore(fixture, scenario);
            assert.equal(invocation.status, 0, `${scenario}: ${invocation.stderr}`);
            const record = lastJson(invocation.stdout);
            assert.equal(record.status, "failed", scenario);
            assert.equal(record.wrapper.status, "failed", scenario);
            assert.ok(record.failures.length > 0, scenario);
            if (scenario === "timeout") assert.equal(record.wrapper.timedOut, true);
            if (scenario === "membership-failure") assert.equal(record.wrapper.childJobMembershipProven, false);
            if (["overflow", "read-failure"].includes(scenario)) assert.equal(record.wrapper.outputDrainProven, false);
            if (scenario === "cleanup-failure") assert.match(record.failures.join("\n"), /cleanup/i);
        }
    });

    it("turns malformed child observations into bounded failure records", () => {
        for (const scenario of ["scalar-observation", "missing-proof", "wrong-proof-type"]) {
            const invocation = invokeCore(makeFixture(), scenario);
            assert.equal(invocation.status, 0, `${scenario}: ${invocation.stderr}`);
            const record = lastJson(invocation.stdout);
            assert.equal(record.status, "failed", scenario);
            assert.equal(record.childExitProven, false, scenario);
            assert.equal(record.handlesClosedProven, false, scenario);
            assert.ok(record.failures.length > 0, scenario);
        }
    });

    it("refuses to run a child when parent Job membership is unproved", () => {
        const fixture = makeFixture();
        const invocation = invokeCore(fixture, "parent-membership-failure");
        assert.equal(invocation.status, 0, invocation.stderr);
        const record = lastJson(invocation.stdout);
        assert.equal(record.status, "failed");
        assert.deepEqual(record.calls, ["parent-job"]);
        assert.match(record.failures.join("\n"), /parent job membership/i);

        const nonBoolean = invokeCore(makeFixture(), "parent-membership-nonboolean");
        assert.equal(nonBoolean.status, 0, nonBoolean.stderr);
        assert.deepEqual(lastJson(nonBoolean.stdout).calls, ["parent-job"]);
        assert.equal(lastJson(nonBoolean.stdout).parentJobMembershipProven, false);
    });

    it("rejects device, UNC, ADS, wildcard, and reserved path forms", () => {
        const body = `
. '${ps(SCRIPT)}'
$paths = @('\\\\server\\share\\tool.exe', '\\\\.\\C:', 'C:\\safe\\tool.exe:stream', 'C:\\safe\\*.exe', 'C:\\safe\\CON.txt')
$rejected = 0
foreach ($path in $paths) { try { Assert-MyspeedCanonicalPath $path 'Test path' | Out-Null } catch { $rejected++ } }
[pscustomobject]@{ rejected=$rejected; total=$paths.Count } | ConvertTo-Json -Compress
`;
        const result = runPowerShell(body);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(lastJson(result.stdout), {rejected: 5, total: 5});
    });

    it("writes one bounded UTF-8 result with create-new semantics", () => {
        const fixture = makeFixture();
        const body = `
. '${ps(SCRIPT)}'
$value = [pscustomobject]@{ schemaVersion=1; status='completed'; payload=('x' * 100) }
Write-MyspeedToolChildResult -Path '${ps(fixture.resultPath)}' -Value $value
try { Write-MyspeedToolChildResult -Path '${ps(fixture.resultPath)}' -Value $value; throw 'duplicate write passed' } catch { $errorMessage=$_.Exception.Message }
[pscustomobject]@{ bytes=([IO.File]::ReadAllBytes('${ps(fixture.resultPath)}').Length); error=$errorMessage } | ConvertTo-Json -Compress
`;
        const result = runPowerShell(body);
        assert.equal(result.status, 0, result.stderr);
        const record = lastJson(result.stdout);
        assert.ok(record.bytes > 0 && record.bytes <= RESULT_LIMIT);
        assert.match(record.error, /already exists|create-new/i);
        assert.equal(fs.readFileSync(fixture.resultPath).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), false);
    });

    it("contains a real guarded adapter with concurrent raw drains and no global mutation mechanisms", () => {
        const source = fs.readFileSync(SCRIPT, "utf8");
        assert.match(source, /IsProcessInJob/);
        assert.match(source, /ReadAsync/);
        assert.match(source, /RedirectStandardOutput/);
        assert.match(source, /RedirectStandardError/);
        assert.match(source, /UseShellExecute\s*=\s*false/i);
        assert.match(source, /SetErrorMode/);
        assert.ok(source.indexOf("CurrentProcessInJob())") < source.indexOf("process.Start()"));
        assert.ok(source.indexOf("Inner deadline expired before Process.Start") < source.indexOf("process.Start()"));
        assert.doesNotMatch(source, /CREATE_DEFAULT_ERROR_MODE|Set-ItemProperty|New-ItemProperty|reg\.exe|New-Service|Set-NetFirewall/i);
    });
});

function makeFixture(overrides = {}) {
    const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-tool-child-")));
    roots.push(parent);
    const root = path.join(parent, `myspeed-cpu-readiness-${NONCE}`);
    const tools = path.join(root, "tools");
    const workingDirectory = path.join(root, "work");
    fs.mkdirSync(tools, {recursive: true});
    fs.mkdirSync(workingDirectory);
    const toolPath = path.join(tools, "tool.exe");
    fs.writeFileSync(toolPath, "synthetic tool bytes");
    const isProbe = overrides.isProbe ?? false;
    const requestPath = path.join(root, "cpuid.request.json");
    const resultPath = path.join(root, "cpuid.result.json");
    const request = {
        schemaVersion: 1,
        expectedRunId: "123456789",
        expectedRunAttempt: "2",
        expectedEventSha: EVENT_SHA,
        expectedSourceSha: SOURCE_SHA,
        nonce: NONCE,
        operationId: "cpuid",
        toolPath,
        toolSha256: sha256File(toolPath),
        arguments: ["/d", "/s", "/c", "call build.cmd"],
        workingDirectory,
        streamLimitBytes: isProbe ? PROBE_STREAM_LIMIT : TOOL_STREAM_LIMIT,
        maximumDurationMilliseconds: isProbe ? PROBE_DURATION_MS : TOOL_DURATION_MS,
        isProbe,
        resultPath
    };
    const fixture = {root, requestPath, resultPath, request};
    rewriteRequest(fixture);
    return fixture;
}

function rewriteRequest(fixture) {
    fs.writeFileSync(fixture.requestPath, JSON.stringify(fixture.request));
    fixture.requestSha256 = sha256File(fixture.requestPath);
}

function invokeValidation(fixture, expectedHash = fixture.requestSha256) {
    return spawnSync(WINDOWS_POWERSHELL, [
        "-NoProfile", "-File", SCRIPT, "-Mode", "ValidateRequest",
        "-RequestPath", fixture.requestPath, "-ExpectedRequestSha256", expectedHash
    ], {encoding: "utf8", timeout: POWERSHELL_TIMEOUT_MS});
}

function invokeCore(fixture, scenario) {
    const body = `
. '${ps(SCRIPT)}'
$validated = Read-MyspeedToolChildRequest -Path '${ps(fixture.requestPath)}' -ExpectedSha256 '${fixture.requestSha256}'
$calls = New-Object 'System.Collections.Generic.List[string]'
$operations = @{
  ParentInJob = { [void]$calls.Add('parent-job'); ${scenario === "parent-membership-failure" ? "$false" : scenario === "parent-membership-nonboolean" ? "1" : "$true"} }.GetNewClosure()
  SetErrorMode = { param($flags) [void]$calls.Add(('set-error:' + $flags)); [pscustomobject]@{ before=16; during=(16 -bor $flags); applied=$true } }.GetNewClosure()
  RestoreErrorMode = { param($before) [void]$calls.Add(('restore-error:' + $before)); [pscustomobject]@{ after=${scenario === "restore-failure" ? "17" : "$before"}; restored=${scenario === "restore-failure" ? "$false" : "$true"} } }.GetNewClosure()
  RunChild = {
    param($request)
    [void]$calls.Add('run-child')
    ${scenario === "creation-failure" ? "throw 'child creation failed'" : ""}
    ${scenario === "scalar-observation" ? "return 'invalid observation'" : ""}
    [pscustomobject]@{
      childProcessId=42
      exitCode=19
      timedOut=${scenario === "timeout" ? "$true" : "$false"}
      durationMilliseconds=7
      stdout=[byte[]]@(0,1,254,255)
      stderr=[byte[]]@(65,66,67)
      outputDrainProven=${["overflow", "read-failure"].includes(scenario) ? "$false" : "$true"}
      childJobMembershipProven=${scenario === "membership-failure" ? "$false" : "$true"}
      childExitProven=${scenario === "cleanup-failure" ? "$false" : "$true"}
      ${scenario === "missing-proof" ? "" : `handlesClosedProven=${scenario === "cleanup-failure" ? "$false" : scenario === "wrong-proof-type" ? "'true'" : "$true"}`}
      failures=@(${scenario === "timeout" ? "'deadline exceeded'" : scenario === "overflow" ? "'stdout limit exceeded'" : scenario === "read-failure" ? "'stdout read failure'" : scenario === "membership-failure" ? "'child job membership unproved'" : scenario === "cleanup-failure" ? "'cleanup unproved'" : ""})
    }
  }.GetNewClosure()
}
$result = Invoke-MyspeedToolChildCore -Request $validated -Operations $operations
$result | Add-Member -NotePropertyName calls -NotePropertyValue @($calls)
$result | ConvertTo-Json -Compress -Depth 12
`;
    return runPowerShell(body);
}

function runPowerShell(body) {
    return spawnSync(WINDOWS_POWERSHELL, ["-NoProfile", "-Command", body], {
        encoding: "utf8", timeout: POWERSHELL_TIMEOUT_MS, maxBuffer: 1_048_576
    });
}

function sha256File(file) {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function lastJson(value) {
    return JSON.parse(value.trim().split(/\r?\n/).at(-1));
}

function ps(value) {
    return value.replaceAll("'", "''");
}

afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, {recursive: true, force: true});
});

const WINDOWS_POWERSHELL = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
