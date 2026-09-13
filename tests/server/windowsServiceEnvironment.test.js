import {describe, it} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";

const SCRIPT = path.resolve("scripts/qualification/windows-service-environment.ps1");
const POWERSHELL_TIMEOUT_MS = 15_000;
const MAX_SCRIPT_BYTES = 262_144;
const MAX_MANIFEST_BYTES = 4_096;
const SOURCE_SHA = "a".repeat(40);
const EVENT_SHA = "b".repeat(40);
const RUN_ID = "123456789";
const RUN_ATTEMPT = "2";
const NONCE = "123e4567-e89b-42d3-a456-426614174000";
const EXPECTED_ENVIRONMENT = {
    SERVER_HOST: "127.0.0.1",
    SERVER_PORT: "43127",
    HTTPS_REDIRECT: "false",
    DB_TYPE: "sqlite",
    RUN_TEST_ON_STARTUP: "false",
    PREVIEW_MODE: "false",
    ALLOW_NO_PASSWORD: "false",
    ALLOW_LOCAL_NODES: "false"
};

const powershell = process.platform === "win32"
    ? ["pwsh.exe", "powershell.exe"].find(command =>
        spawnSync(command, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"],
            {timeout: POWERSHELL_TIMEOUT_MS}).status === 0)
    : ["pwsh"].find(command =>
        spawnSync(command, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"],
            {timeout: POWERSHELL_TIMEOUT_MS}).status === 0);

const quote = value => `'${String(value).replaceAll("'", "''")}'`;

const runPowerShell = body => {
    assert.ok(powershell, "PowerShell is required to test the hosted Windows service canary");
    const command = [
        `$ErrorActionPreference = 'Stop'`,
        `. ${quote(SCRIPT)}`,
        body
    ].join("\n");
    const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
        encoding: "utf8",
        timeout: POWERSHELL_TIMEOUT_MS,
        env: {...process.env}
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
};

const runJson = body => JSON.parse(runPowerShell(`& { ${body} } | ConvertTo-Json -Compress -Depth 12`));
const powershellIt = powershell ? it : it.skip;

describe("hosted Windows SCM environment canary", () => {
    powershellIt("is import-safe and defines the exact eight-value projection", () => {
        const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", SCRIPT], {
            encoding: "utf8",
            timeout: POWERSHELL_TIMEOUT_MS,
            env: {...process.env}
        });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.equal(result.stdout.trim(), "");
        assert.deepEqual(runJson("Get-MyspeedExpectedEnvironment"), EXPECTED_ENVIRONMENT);
    });

    powershellIt("rejects an existing target under any casing without exposing its value", () => {
        const output = runPowerShell(`
            $entries = @(
                [pscustomobject]@{ Name = 'Path'; Kind = 'String'; Fingerprint = 'safe' },
                [pscustomobject]@{ Name = 'server_host'; Kind = 'String'; Fingerprint = 'secret-not-for-output' }
            )
            try {
                Assert-MyspeedMachineEnvironmentPrecondition -Entries $entries
                throw 'expected rejection'
            } catch {
                if ($_.Exception.Message -match 'secret-not-for-output') { throw 'leaked value' }
                $_.Exception.Message
            }
        `);
        assert.match(output, /collision|already exists/i);
        assert.doesNotMatch(output, /secret-not-for-output/);
    });

    powershellIt("accepts only the exact hosted repository/run/event/source/nonce identity", () => {
        const context = `@{
            GITHUB_ACTIONS = 'true'; CI = 'true'; RUNNER_OS = 'Windows'; RUNNER_ARCH = 'X64';
            RUNNER_ENVIRONMENT = 'github-hosted'; GITHUB_REPOSITORY = 'i7Gamer/MySpeed';
            GITHUB_RUN_ID = '${RUN_ID}'; GITHUB_RUN_ATTEMPT = '${RUN_ATTEMPT}';
            GITHUB_SHA = '${EVENT_SHA}'; ImageOS = 'win25-vs2026';
            ImageVersion = '20260907.229.1'; RUNNER_TEMP = 'C:\\a\\_temp'
        }`;
        assert.equal(runPowerShell(`Assert-MyspeedHostedContext -Context ${context} -ExpectedRunId ${quote(RUN_ID)} `
            + `-ExpectedRunAttempt ${quote(RUN_ATTEMPT)} `
            + `-ExpectedSourceSha ${quote(SOURCE_SHA)} -ExpectedEventSha ${quote(EVENT_SHA)} `
            + `-Nonce ${quote(NONCE)} | Out-Null; 'accepted'`), "accepted");

        for (const [field, value] of [
            ["GITHUB_REPOSITORY", "other/repository"],
            ["RUNNER_ENVIRONMENT", "self-hosted"],
            ["RUNNER_OS", "Linux"],
            ["GITHUB_RUN_ID", "987654321"],
            ["GITHUB_RUN_ATTEMPT", "3"],
            ["GITHUB_SHA", "c".repeat(40)],
            ["ImageOS", "win22"],
            ["ImageOS", "win25"],
            ["ImageOS", "win25-vs2026-custom"]
        ]) {
            const rejected = runJson(`
                $context = ${context}
                $context[${quote(field)}] = ${quote(value)}
                try {
                    Assert-MyspeedHostedContext -Context $context -ExpectedRunId ${quote(RUN_ID)} `
                        + `-ExpectedRunAttempt ${quote(RUN_ATTEMPT)} `
                        + `-ExpectedSourceSha ${quote(SOURCE_SHA)} -ExpectedEventSha ${quote(EVENT_SHA)} `
                        + `-Nonce ${quote(NONCE)} | Out-Null
                    [pscustomobject]@{ rejected = $false; message = 'accepted unexpectedly' }
                } catch { [pscustomobject]@{ rejected = $true; message = $_.Exception.Message } }
            `);
            assert.equal(rejected.rejected, true, field);
            assert.match(rejected.message, /hosted|identity|context|source|run|repository|image/i, field);
        }
    });

    powershellIt("reports a completed mismatch without clearing the environment gate", () => {
        const actual = {...EXPECTED_ENVIRONMENT, SERVER_HOST: null};
        const result = runJson(`
            Get-MyspeedProbeAssessment -Probe ([pscustomobject]@{
                status = 'completed'; sid = 'S-1-5-18'; processId = 4242;
                projection = (ConvertFrom-Json ${quote(JSON.stringify(actual))});
                forbiddenNames = @('HTTPS_PROXY')
            })
        `);
        assert.equal(result.status, "completed");
        assert.equal(result.environmentPassed, false);
        assert.equal(result.actualProjection.SERVER_HOST, null);
        assert.deepEqual(result.forbiddenNames, ["HTTPS_PROXY"]);
    });

    powershellIt("requires LocalSystem, exact projection keys, and no forbidden names for a pass", () => {
        const projection = `(ConvertFrom-Json ${quote(JSON.stringify(EXPECTED_ENVIRONMENT))})`;
        const passed = runJson(`Get-MyspeedProbeAssessment -Probe ([pscustomobject]@{
            status = 'completed'; sid = 'S-1-5-18'; processId = [long]4242;
            projection = ${projection}; forbiddenNames = @()
        })`);
        assert.equal(passed.environmentPassed, true);
        assert.equal(passed.observedProcessId, 4242);

        for (const mutation of [
            "sid = 'S-1-5-19'",
            "projection = [pscustomobject]@{ SERVER_HOST = '127.0.0.1' }",
            "forbiddenNames = @('DB_PASS')"
        ]) {
            const failed = runJson(`
                $probe = [pscustomobject]@{ status = 'completed'; sid = 'S-1-5-18'; processId = 4242;
                    projection = ${projection}; forbiddenNames = @() }
                $probe.${mutation}
                Get-MyspeedProbeAssessment -Probe $probe
            `);
            assert.equal(failed.environmentPassed, false, mutation);
        }
    });

    powershellIt("generates a listener-free, child-free inert ServiceBase probe", () => {
        const syntheticOutput = path.join(os.tmpdir(), "myspeed-synthetic-probe.json");
        const source = runPowerShell(`Get-MyspeedProbeSource -ServiceName 'MySpeedQualificationEnv123e4567e89b42d3a456426614174000' `
            + `-OutputPath ${quote(syntheticOutput)} -Nonce ${quote(NONCE)}`);
        assert.match(source, /ServiceBase/);
        assert.match(source, /S-1-5-18|WindowsIdentity/);
        assert.doesNotMatch(source, /System\.Net|Socket|Tcp|Udp|Http|Process\.Start|CreateProcess/);
        assert.doesNotMatch(source, /GetEnvironmentVariables\(EnvironmentVariableTarget\.Machine\)/);
    });

    powershellIt("runs the inert probe compiler through its bounded process seam on Windows", {skip: process.platform !== "win32"}, () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-probe-compile-test-"));
        try {
            const sourcePath = path.join(root, "probe.cs");
            const executablePath = path.join(root, "probe.exe");
            const resultPath = path.join(root, "probe-result.json");
            const result = runJson(`
                $serviceName = 'MySpeedQualificationEnv123e4567e89b42d3a456426614174000'
                $probeSource = Get-MyspeedProbeSource -ServiceName $serviceName `
                    + `-OutputPath ${quote(resultPath)} -Nonce ${quote(NONCE)}
                $operations = New-MyspeedNativeOperations -ServiceName $serviceName `
                    + `-SourcePath ${quote(sourcePath)} -ExecutablePath ${quote(executablePath)} `
                    + `-ProbeResultPath ${quote(resultPath)} -ProbeSource $probeSource -Nonce ${quote(NONCE)}
                & $operations.CompileProbe
            `);
            assert.match(result.sourceSha256, /^[a-f0-9]{64}$/);
            assert.match(result.binarySha256, /^[a-f0-9]{64}$/);
            assert.match(result.compilerSha256, /^[a-f0-9]{64}$/);
            assert.ok(fs.statSync(executablePath).size > 0);
            assert.equal(fs.existsSync(resultPath), false, "compile-only test must not run the service probe");
        } finally {
            fs.rmSync(root, {recursive: true, force: true});
        }
    });

    powershellIt("keeps a completed environment mismatch distinct while restoring through injected seams", () => {
        const outcome = runJson(`
            $baseline = @([pscustomobject]@{ Name = 'Path'; Kind = 'String'; Fingerprint = 'baseline' })
            $state = [ordered]@{ current = @($baseline); setCount = 0; removedCount = 0; cleanupCount = 0 }
            $operations = @{
                SnapshotMachineEnvironment = { @($state.current) }.GetNewClosure()
                SetMachineEnvironmentValue = {
                    param($name, $value)
                    $state.current += [pscustomobject]@{ Name = $name; Kind = 'String'; Fingerprint = $value }
                    $state.setCount++
                }.GetNewClosure()
                RemoveMachineEnvironmentValue = {
                    param($name, $value)
                    $entry = @($state.current | Where-Object { $_.Name -ceq $name })
                    if ($entry.Count -ne 1 -or $entry[0].Fingerprint -cne $value) { throw 'owned value drift' }
                    $state.current = @($state.current | Where-Object { $_.Name -cne $name })
                    $state.removedCount++
                }.GetNewClosure()
                ReadMachineProjection = { Get-MyspeedExpectedEnvironment }
                ServiceExists = { $false }
                CompileProbe = { [pscustomobject]@{ sourceSha256 = '${SOURCE_SHA}'; binarySha256 = '${EVENT_SHA}' } }
                CreateService = { }
                StartService = { [pscustomobject]@{ processId = 4242; creationDate = 'owned'; executablePath = 'owned' } }
                ReadProbe = {
                    param($process)
                    $projection = Get-MyspeedExpectedEnvironment
                    $projection.SERVER_HOST = $null
                    [pscustomobject]@{ status = 'completed'; sid = 'S-1-5-18'; processId = [long]$process.processId;
                        projection = $projection; forbiddenNames = @() }
                }
                InspectProbeActivity = { [pscustomobject]@{ childCount = 0; tcpEndpointCount = 0; udpEndpointCount = 0 } }
                CleanupOwnedService = {
                    param($process)
                    if ($process.processId -ne 4242) { throw 'process identity mismatch' }
                    $state.cleanupCount++
                    [pscustomobject]@{ serviceStopped = $true; serviceDeleted = $true; processGone = $true }
                }.GetNewClosure()
            }
            $coreArguments = @{ Operations = $operations
                ServiceName = 'MySpeedQualificationEnv123e4567e89b42d3a456426614174000'
                Nonce = ${quote(NONCE)}; RunId = ${quote(RUN_ID)}; RunAttempt = ${quote(RUN_ATTEMPT)}
                SourceSha = ${quote(SOURCE_SHA)}; EventSha = ${quote(EVENT_SHA)} }
            $result = Invoke-MyspeedServiceEnvironmentCore @coreArguments
            [pscustomobject]@{ result = $result; setCount = $state.setCount; removedCount = $state.removedCount;
                cleanupCount = $state.cleanupCount; remainingNames = @($state.current.Name) }
        `);
        assert.equal(outcome.result.status, "completed");
        assert.equal(outcome.result.environmentPassed, false);
        assert.deepEqual(outcome.result.failures, []);
        assert.deepEqual(outcome.result.cleanup, {
            serviceStopped: true,
            serviceDeleted: true,
            processGone: true,
            machineEnvironmentRestored: true,
            unrelatedStateUnchanged: true
        });
        assert.equal(outcome.setCount, Object.keys(EXPECTED_ENVIRONMENT).length);
        assert.equal(outcome.removedCount, Object.keys(EXPECTED_ENVIRONMENT).length);
        assert.equal(outcome.cleanupCount, 1);
        assert.deepEqual(outcome.remainingNames, ["Path"]);
    });

    powershellIt("never cleans a pre-existing service-name collision", () => {
        const outcome = runJson(`
            $state = [ordered]@{ current = @([pscustomobject]@{
                Name = 'Path'; Kind = 'String'; Fingerprint = 'baseline' }); cleanupCount = 0 }
            $operations = @{
                SnapshotMachineEnvironment = { @($state.current) }.GetNewClosure()
                SetMachineEnvironmentValue = { param($name, $value)
                    $state.current += [pscustomobject]@{ Name = $name; Kind = 'String'; Fingerprint = $value }
                }.GetNewClosure()
                RemoveMachineEnvironmentValue = { param($name, $value)
                    $state.current = @($state.current | Where-Object { $_.Name -cne $name })
                }.GetNewClosure()
                ReadMachineProjection = { Get-MyspeedExpectedEnvironment }
                ServiceExists = { $true }
                CompileProbe = { throw 'must not compile' }
                CreateService = { throw 'must not create' }
                StartService = { throw 'must not start' }
                ReadProbe = { throw 'must not read' }
                InspectProbeActivity = { throw 'must not inspect' }
                CleanupOwnedService = { $state.cleanupCount++ }.GetNewClosure()
            }
            $coreArguments = @{ Operations = $operations
                ServiceName = 'MySpeedQualificationEnv123e4567e89b42d3a456426614174000'
                Nonce = ${quote(NONCE)}; RunId = ${quote(RUN_ID)}; RunAttempt = ${quote(RUN_ATTEMPT)}
                SourceSha = ${quote(SOURCE_SHA)}; EventSha = ${quote(EVENT_SHA)} }
            $result = Invoke-MyspeedServiceEnvironmentCore @coreArguments
            [pscustomobject]@{ result = $result; cleanupCount = $state.cleanupCount; remainingCount = $state.current.Count }
        `);
        assert.equal(outcome.result.status, "failed");
        assert.match(outcome.result.failures.join("\n"), /already exists/);
        assert.equal(outcome.cleanupCount, 0);
        assert.equal(outcome.remainingCount, 1);
        assert.equal(outcome.result.cleanup.machineEnvironmentRestored, true);
    });

    powershellIt("bounds condition waits without invoking native state", () => {
        const outcome = runJson(`
            $timer = [Diagnostics.Stopwatch]::StartNew()
            try {
                Wait-MyspeedCondition -Condition { $false } -DeadlineSeconds 0 -FailureMessage 'bounded sentinel'
                [pscustomobject]@{ rejected = $false; elapsed = $timer.ElapsedMilliseconds }
            } catch {
                [pscustomobject]@{ rejected = ($_.Exception.Message -ceq 'bounded sentinel');
                    elapsed = $timer.ElapsedMilliseconds }
            }
        `);
        assert.equal(outcome.rejected, true);
        assert.ok(outcome.elapsed < POWERSHELL_TIMEOUT_MS);
    });

    powershellIt("emits the exact bounded one-script closure manifest", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-manifest-test-"));
        try {
            const copiedScript = path.join(root, "windows-service-environment.ps1");
            const manifest = path.join(root, "manifest.json");
            fs.copyFileSync(SCRIPT, copiedScript);
            const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", copiedScript,
                "-Mode", "EmitCanaryClosureManifest", "-ExpectedRunId", RUN_ID,
                "-ExpectedRunAttempt", RUN_ATTEMPT,
                "-ExpectedSourceSha", SOURCE_SHA, "-ExpectedEventSha", EVENT_SHA,
                "-Nonce", NONCE, "-ManifestPath", manifest], {
                encoding: "utf8", timeout: POWERSHELL_TIMEOUT_MS, env: {...process.env}
            });
            assert.equal(result.status, 0, result.stderr || result.stdout);
            const parsed = JSON.parse(fs.readFileSync(manifest, "utf8"));
            assert.deepEqual(Object.keys(parsed), [
                "schemaVersion", "expectedRunId", "expectedRunAttempt", "expectedSourceSha",
                "expectedEventSha", "nonce", "script"
            ]);
            assert.equal(parsed.schemaVersion, 1);
            assert.equal(parsed.expectedRunId, RUN_ID);
            assert.equal(parsed.expectedRunAttempt, RUN_ATTEMPT);
            assert.equal(parsed.expectedSourceSha, SOURCE_SHA);
            assert.equal(parsed.expectedEventSha, EVENT_SHA);
            assert.equal(parsed.nonce, NONCE);
            assert.equal(parsed.script.name, "windows-service-environment.ps1");
            assert.equal(parsed.script.bytes, fs.statSync(copiedScript).size);
            assert.match(parsed.script.sha256, /^[a-f0-9]{64}$/);
            assert.ok(fs.statSync(copiedScript).size <= MAX_SCRIPT_BYTES);
            assert.ok(fs.statSync(manifest).size <= MAX_MANIFEST_BYTES);
        } finally {
            fs.rmSync(root, {recursive: true, force: true});
        }
    });

    it("keeps all native mutation behind the hosted-context and closure gates", () => {
        const source = fs.readFileSync(SCRIPT, "utf8");
        const entry = source.indexOf("function Invoke-MyspeedHostedServiceEnvironmentExperiment");
        const gate = source.indexOf("Assert-MyspeedHostedContext", entry);
        const closureGate = source.indexOf("Assert-MyspeedCanaryClosure", entry);
        const native = source.indexOf("New-MyspeedNativeOperations", entry);
        assert.ok(entry >= 0 && gate > entry && closureGate > gate && native > closureGate,
            "native operations must be created only after context and closure gates");
        for (const parameter of [
            "ExpectedRunId", "ExpectedRunAttempt", "ExpectedSourceSha", "ExpectedEventSha", "Nonce",
            "ManifestPath", "EvidencePath"
        ]) assert.match(source, new RegExp(`\\[string\\]\\$${parameter}\\b`));
        assert.match(source, /MAX_SCRIPT_BYTES\s*=\s*262144/);
        assert.match(source, /MAX_MANIFEST_BYTES\s*=\s*4096/);
        assert.match(source, /MACHINE_ENVIRONMENT_RESTORE_DEADLINE_SECONDS/);
        assert.match(source, /SERVICE_START_DEADLINE_SECONDS/);
        assert.match(source, /SERVICE_STOP_DEADLINE_SECONDS/);
        assert.equal(source.match(/\$controller\.Dispose\(\)/g)?.length, 2,
            "start and stop must release their ServiceController handles");
        const removal = source.slice(source.indexOf("function Remove-MyspeedMachineEnvironmentValue"),
            source.indexOf("function Get-MyspeedMachineTargetProjection"));
        assert.ok(removal.indexOf("GetValueKind") < removal.indexOf("DeleteValue"));
        assert.ok(removal.indexOf("DoNotExpandEnvironmentNames") < removal.indexOf("DeleteValue"));
        assert.doesNotMatch(source, /Remove-Service\s+\*|Stop-Process\s+.*-Name|Get-Service\s*\|.*Remove-Service/s);
    });
});
