import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {describe, it} from "node:test";

import {
    parseGuestOutput,
    receiptRejectionCode
} from "../../scripts/qualification/linux-windows-cpu-floor-stage2-hosted.mjs";
import {
    WINDOWS_SYSTEM_TOOL_PATHS,
    canonicalShutdownMarker,
    renderGuestBootstrap
} from "../../scripts/qualification/linux-windows-cpu-floor-stage2.mjs";
import {
    buildWindowsMsiSetupCompleteActivation,
    getCompletedWindowsMsiActivationEvidence
} from "../../scripts/qualification/windows-msi-post-setup-activation.mjs";

/*
 * Run 35208529749 published `activation-invalid` after every earlier region of parseGuestOutput
 * passed, which means the guest wrote a complete success record and the host refused only the
 * activation region. Every field in that region except the two installed-file paths is echoed back
 * from a host constant the generator interpolated, so the paths were the only value the guest could
 * have derived differently. The guest derived them from %SystemRoot%, which Windows Setup writes as
 * `C:\WINDOWS`, while the host compares them with `!==` against `C:\Windows\...`. These tests pin
 * the producer's reported path to the host-declared path and run the real generated observer
 * through the real host parser, because a handwritten record built from the host's own activation
 * builder is exactly the fixture that could never have caught this.
 */

const NONCE = "5e1c4d9a8b3f42c6a7d0e5b1c9f3a6d2";
const ILLEGAL_INSTRUCTION_EXIT = 3_221_225_501;
const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const POWERSHELL_TEST_TIMEOUT_MILLISECONDS = 30_000;
const SKIP_WITHOUT_POWERSHELL = process.platform !== "win32" || !fs.existsSync(POWERSHELL);
const DECLARED_SETUP_COMPLETE_PATH = "C:\\Windows\\Setup\\Scripts\\SetupComplete.cmd";
const DECLARED_DISPATCHER_PATH = "C:\\Windows\\Setup\\Scripts\\myspeed-msi-setupcomplete.ps1";
const DECLARED_ACTIVATION_ROOT = "C:\\Windows\\Setup\\Scripts";
const UPPERCASE_SYSTEM_ROOT_PREFIX = "C:\\WINDOWS\\Setup\\Scripts\\";
const CONTROL_RESULTS = Object.freeze({"known-good": 42, "known-bad": 13, sse42: 2_276_049_685, popcnt: 32});
const KNOWN_BAD_EXIT = 19;

const encode = value => Buffer.from(`${JSON.stringify(value)}\n`).toString("base64");
const quote = value => value.replaceAll("'", "''");

function context() {
    return {schemaVersion: 1, repository: "i7Gamer/MySpeed", sourceSha: "b".repeat(40),
        eventSha: "c".repeat(40), runId: "123", runAttempt: "1", nonce: NONCE,
        environment: {GITHUB_ACTIONS: "true", CI: "true", RUNNER_OS: "Linux", RUNNER_ARCH: "X64",
            RUNNER_ENVIRONMENT: "github-hosted", ImageOS: "ubuntu24", ImageVersion: "20260907.1"}};
}

const activation = () => buildWindowsMsiSetupCompleteActivation({repository: "i7Gamer/MySpeed",
    sourceSha: "b".repeat(40), eventSha: "c".repeat(40), runId: "123", runAttempt: "1", nonce: NONCE});

function cpuidRecord() {
    return {schemaVersion: 1, kind: "cpuid", maxBasicLeaf: 7,
        leaf1: {eax: "0x00000000", ebx: "0x00000000", ecx: "0x00900000", edx: "0x00000000"},
        leaf7Subleaf0: {eax: "0x00000000", ebx: "0x00000000", ecx: "0x00000000", edx: "0x00000000"},
        xcr0: null, features: {sse42: true, popcnt: true, osxsave: false, avx: false, avx2: false}};
}

function probeRuns() {
    return [
        {role: "cpuid", exitCode: 0, stdoutBase64: encode(cpuidRecord()), stderrBase64: ""},
        ...Object.keys(CONTROL_RESULTS).map(role => ({role,
            exitCode: role === "known-bad" ? KNOWN_BAD_EXIT : 0,
            stdoutBase64: encode({schemaVersion: 1, kind: role, result: CONTROL_RESULTS[role]}),
            stderrBase64: ""})),
        ...["illegal", "avx", "avx2"].map(role => ({role, exitCode: ILLEGAL_INSTRUCTION_EXIT,
            stdoutBase64: "", stderrBase64: ""}))
    ];
}

const systemToolsRecord = () => WINDOWS_SYSTEM_TOOL_PATHS.map((tool, index) => ({...tool,
    bytes: String(index + 1), sha256: String(index + 1).repeat(64)}));

const networkRecord = () => ({hardwareNics: 0, enabledNonLoopbackInterfaces: 0, nonLoopbackRoutes: 0});

function guestRecord(activationRecord) {
    return {schemaVersion: 1, nonce: NONCE, runs: probeRuns(), network: networkRecord(),
        activation: activationRecord, systemTools: systemToolsRecord()};
}

function rejectionCode(bytes) {
    try {
        parseGuestOutput(bytes, NONCE);
    } catch (error) {
        return receiptRejectionCode(error);
    }
    return null;
}

describe("Stage 2 guest activation path contract", () => {
    it("reports the host-declared installed paths instead of a %SystemRoot%-derived path", () => {
        const source = renderGuestBootstrap(context()).toString("utf8");
        assert.match(source, /\$EXPECTED_ACTIVATION_ROOT = 'C:\\Windows\\Setup\\Scripts'/u);
        assert.match(source, /\$EXPECTED_SETUP_COMPLETE_PATH = 'C:\\Windows\\Setup\\Scripts\\SetupComplete\.cmd'/u);
        assert.match(source,
            /\$EXPECTED_DISPATCHER_PATH = 'C:\\Windows\\Setup\\Scripts\\myspeed-msi-setupcomplete\.ps1'/u);
        /* The observed root and the reported path must both come from the declared constants. */
        assert.match(source, /\$root = \$expectedActivationRoot/u);
        assert.match(source, /\$records\[\$expected\.key\] = \[ordered\]@\{path=\$expected\.path;/u);
        assert.doesNotMatch(source, /Join-Path \$env:SystemRoot 'Setup\\\\Scripts'/u);
    });

    it("refuses an otherwise identical record whose only difference is the %SystemRoot% casing", () => {
        const accepted = getCompletedWindowsMsiActivationEvidence(activation());
        assert.equal(rejectionCode(Buffer.from(JSON.stringify(guestRecord(accepted)), "utf8")), null);

        const uppercase = structuredClone(accepted);
        for (const name of ["setupComplete", "dispatcher"])
            uppercase.files[name].path =
                UPPERCASE_SYSTEM_ROOT_PREFIX + path.win32.basename(uppercase.files[name].path);
        assert.notDeepEqual(uppercase.files, accepted.files);
        assert.deepEqual({...uppercase, files: accepted.files}, accepted);
        assert.equal(rejectionCode(Buffer.from(JSON.stringify(guestRecord(uppercase)), "utf8")),
            "activation-invalid");
    });

    it("feeds the generated observer's own bytes through the real host parser and reaches shutdown",
        {skip: SKIP_WITHOUT_POWERSHELL}, () => {
            const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-stage2-activation-path-"));
            const scriptPath = path.join(root, "bootstrap.ps1");
            const observed = path.join(root, "Scripts");
            const declared = getCompletedWindowsMsiActivationEvidence(activation());
            const files = activation().files;
            fs.mkdirSync(observed);
            fs.writeFileSync(scriptPath, renderGuestBootstrap(context()));
            /*
             * Every operation the guest would perform against the real machine is substituted: the
             * installed files are synthetic copies in a temporary directory, the scheduled task is a
             * synthetic observation, the error mode and the output volume are stubs, and shutdown
             * only records that it was invoked. Nothing here touches the host's own Windows install.
             */
            fs.writeFileSync(path.join(observed, "SetupComplete.cmd"),
                Buffer.from(files.setupComplete.bytesBase64, "base64"));
            fs.writeFileSync(path.join(observed, "myspeed-msi-setupcomplete.ps1"),
                Buffer.from(files.dispatcher.bytesBase64, "base64"));
            const task = declared.startupTask;
            const harness = `$ErrorActionPreference='Stop';$global:observed='${quote(observed)}';` +
                `function global:Add-Type{param($TypeDefinition,$Language)}` +
                `function global:Get-Item{param($LiteralPath,[switch]$Force)` +
                `if([string]$LiteralPath -ceq '${quote(DECLARED_ACTIVATION_ROOT)}'){$LiteralPath=$global:observed};` +
                `Microsoft.PowerShell.Management\\Get-Item -LiteralPath $LiteralPath -Force}` +
                `function global:Join-Path{param($Path,$ChildPath)` +
                `if([string]$ChildPath -ceq 'Setup\\Scripts'){return $global:observed};` +
                `if([string]$Path -ceq '${quote(DECLARED_ACTIVATION_ROOT)}'){` +
                `return [IO.Path]::Combine($global:observed,[string]$ChildPath)};` +
                `[IO.Path]::Combine([string]$Path,[string]$ChildPath)}` +
                `function global:Get-ScheduledTask{param($TaskName,$TaskPath)[pscustomobject]@{` +
                `Actions=@([pscustomobject]@{Execute='${quote(task.executable)}';` +
                `Arguments='${quote(task.arguments)}'});` +
                `Triggers=@([pscustomobject]@{Enabled=$true;CimClass=[pscustomobject]@{` +
                `CimClassName='MSFT_TaskBootTrigger'}});Principal=[pscustomobject]@{` +
                `UserId='${quote(task.principal)}';RunLevel='${quote(task.runLevel)}'}}};` +
                `$native=& {. '${quote(scriptPath)}' -LibraryMode;New-MyspeedGuestNativeOperations};` +
                `. '${quote(scriptPath)}' -LibraryMode;` +
                `$events=[Collections.Generic.List[string]]::new();$script:captured=@{};` +
                `function global:New-MyspeedTestList([string]$Json){` +
                `$list=[Collections.Generic.List[object]]::new();` +
                `foreach($item in ($Json|ConvertFrom-Json)){$list.Add($item)};return ,$list}` +
                `$ops=@{SetErrorMode={param([uint32]$Mode)$events.Add('mode:'+$Mode);[uint32]77};` +
                `ResolveVolume={param([string]$Label)$events.Add('resolve:'+$Label);'C:\\Output\\'};` +
                `CollectEvidence={param([string]$Seed)$events.Add('collect');[ordered]@{schemaVersion=1;` +
                `nonce='${NONCE}';runs=(New-MyspeedTestList '${JSON.stringify(probeRuns())}');` +
                `network=('${JSON.stringify(networkRecord())}'|ConvertFrom-Json)}};` +
                `ObserveActivation={$events.Add('activation');& $native.ObserveActivation};` +
                `ObserveSystemTools={$events.Add('system-tools');` +
                `New-MyspeedTestList '${JSON.stringify(systemToolsRecord())}'};` +
                `WriteExclusive={param([string]$Path,[byte[]]$Bytes)$name=[IO.Path]::GetFileName($Path);` +
                `$events.Add('write:'+$name);` +
                `$script:captured[$name]=[Convert]::ToBase64String($Bytes)}};` +
                `$caught=$null;try{Invoke-MyspeedGuestBootstrap -Operations $ops ` +
                `-Shutdown {$events.Add('shutdown')}}catch{$caught=[string]$_.Exception.Message};` +
                `[Console]::Out.Write(([ordered]@{events=($events -join ',');caught=$caught;` +
                `bytes=$script:captured['result.json'];` +
                `marker=$script:captured['shutdown-outcome.json']}|ConvertTo-Json -Compress))`;
            try {
                const result = spawnSync(POWERSHELL,
                    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", harness],
                    {encoding: "utf8", timeout: POWERSHELL_TEST_TIMEOUT_MILLISECONDS});
                assert.equal(result.status, 0, result.stderr);
                const emitted = JSON.parse(result.stdout);
                assert.equal(emitted.caught, null);
                /*
                 * The success path writes the receipt, then always invokes shutdown, then records
                 * the outcome of that invocation - in that order, with nothing new before the call.
                 */
                assert.equal(emitted.events, "mode:3,resolve:MYSPEEDSEED,resolve:MYSPEEDOUT,collect,activation," +
                    "system-tools,mode:77,write:result.json,shutdown,write:shutdown-outcome.json");
                assert.deepEqual(Buffer.from(emitted.marker, "base64"),
                    canonicalShutdownMarker(NONCE, "returned"));
                const bytes = Buffer.from(emitted.bytes, "base64");
                const parsed = parseGuestOutput(bytes, NONCE);
                assert.equal(parsed.activation.files.setupComplete.path, DECLARED_SETUP_COMPLETE_PATH);
                assert.equal(parsed.activation.files.dispatcher.path, DECLARED_DISPATCHER_PATH);
                assert.deepEqual(parsed.activation, declared);
            } finally { fs.rmSync(root, {recursive: true, force: true}); }
        });

    /*
     * Run 35208529749 left a complete result.json and a guest that never powered off. These pin
     * what the guest does when the injected shutdown itself fails. The receipt is already on the
     * output volume before shutdown is reached, so its presence says nothing about the invocation -
     * the ordering guarantee is what makes "QEMU is still running" no evidence at all about whether
     * the shutdown command was invoked. Only the marker written after the call separates the two,
     * and a shutdown that threw and one that was invoked and never completed stay distinguishable
     * from the host solely by whether that marker is there and which outcome it carries.
     */
    it("writes the receipt before shutdown and invokes shutdown even when shutdown itself fails",
        {skip: SKIP_WITHOUT_POWERSHELL}, () => {
            const cases = [
                ["success", "[ordered]@{ok=$true}", "synthetic shutdown failure",
                    "mode:3,resolve:MYSPEEDSEED,resolve:MYSPEEDOUT,collect,activation,system-tools,mode:77," +
                    "write:result.json,shutdown,write:shutdown-outcome.json"],
                ["observation failure", "throw 'synthetic activation failure'", "synthetic shutdown failure",
                    "mode:3,resolve:MYSPEEDSEED,resolve:MYSPEEDOUT,collect,activation,mode:77," +
                    "write:result.json,shutdown,write:shutdown-outcome.json"]
            ];
            const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-stage2-shutdown-"));
            const scriptPath = path.join(root, "bootstrap.ps1");
            fs.writeFileSync(scriptPath, renderGuestBootstrap(context()));
            try {
                for (const [label, activationBody, shutdownFailure, expectedEvents] of cases) {
                    const harness = `$ErrorActionPreference='Stop';. '${quote(scriptPath)}' -LibraryMode;` +
                        `$events=[Collections.Generic.List[string]]::new();$script:written=@{};` +
                        `$ops=@{SetErrorMode={param([uint32]$Mode)$events.Add('mode:'+$Mode);[uint32]77};` +
                        `ResolveVolume={param([string]$Label)$events.Add('resolve:'+$Label);'C:\\Output\\'};` +
                        `CollectEvidence={param([string]$Seed)$events.Add('collect');[ordered]@{ok=$true}};` +
                        `ObserveActivation={$events.Add('activation');${activationBody}};` +
                        `ObserveSystemTools={$events.Add('system-tools');@()};` +
                        `WriteExclusive={param([string]$Path,[byte[]]$Bytes)$name=[IO.Path]::GetFileName($Path);` +
                        `$events.Add('write:'+$name);` +
                        `$script:written[$name]=[Text.Encoding]::UTF8.GetString($Bytes)}};` +
                        `$caught=$null;try{Invoke-MyspeedGuestBootstrap -Operations $ops -Shutdown {` +
                        `$events.Add('shutdown');throw '${shutdownFailure}'}}` +
                        `catch{$caught=[string]$_.Exception.Message};` +
                        `[Console]::Out.Write(([ordered]@{events=($events -join ',');caught=$caught;` +
                        `written=$script:written['result.json'];` +
                        `marker=$script:written['shutdown-outcome.json']}|ConvertTo-Json -Compress))`;
                    const result = spawnSync(POWERSHELL,
                        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", harness],
                        {encoding: "utf8", timeout: POWERSHELL_TEST_TIMEOUT_MILLISECONDS});
                    assert.equal(result.status, 0, result.stderr);
                    const observed = JSON.parse(result.stdout);
                    assert.equal(observed.events, expectedEvents, label);
                    /* The receipt is on the volume before shutdown is reached, on both paths. */
                    assert.ok(observed.written !== null, label);
                    /* The shutdown failure is all the caller sees, exactly as before the marker. */
                    assert.equal(observed.caught, shutdownFailure, label);
                    /* The failed marker is the one record that says the call itself threw. */
                    assert.equal(observed.marker, canonicalShutdownMarker(NONCE, "failed").toString("utf8"), label);
                }
            } finally { fs.rmSync(root, {recursive: true, force: true}); }
        });

    it("still verifies the installed bytes it reports", {skip: SKIP_WITHOUT_POWERSHELL}, () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-stage2-activation-tamper-"));
        const scriptPath = path.join(root, "bootstrap.ps1");
        const observed = path.join(root, "Scripts");
        const files = activation().files;
        fs.mkdirSync(observed);
        fs.writeFileSync(scriptPath, renderGuestBootstrap(context()));
        const tampered = Buffer.from(files.setupComplete.bytesBase64, "base64");
        tampered[0] ^= 0xff;
        fs.writeFileSync(path.join(observed, "SetupComplete.cmd"), tampered);
        fs.writeFileSync(path.join(observed, "myspeed-msi-setupcomplete.ps1"),
            Buffer.from(files.dispatcher.bytesBase64, "base64"));
        const harness = `$ErrorActionPreference='Stop';$global:observed='${quote(observed)}';` +
            `function global:Add-Type{param($TypeDefinition,$Language)}` +
            `function global:Get-Item{param($LiteralPath,[switch]$Force)` +
            `if([string]$LiteralPath -ceq '${quote(DECLARED_ACTIVATION_ROOT)}'){$LiteralPath=$global:observed};` +
            `Microsoft.PowerShell.Management\\Get-Item -LiteralPath $LiteralPath -Force}` +
            `function global:Join-Path{param($Path,$ChildPath)` +
            `if([string]$ChildPath -ceq 'Setup\\Scripts'){return $global:observed};` +
            `if([string]$Path -ceq '${quote(DECLARED_ACTIVATION_ROOT)}'){` +
            `return [IO.Path]::Combine($global:observed,[string]$ChildPath)};` +
            `[IO.Path]::Combine([string]$Path,[string]$ChildPath)}` +
            `$native=& {. '${quote(scriptPath)}' -LibraryMode;New-MyspeedGuestNativeOperations};` +
            `$rejected=$null;try{$null=& $native.ObserveActivation}catch{$rejected=[string]$_.Exception.Message};` +
            `[Console]::Out.Write($rejected)`;
        try {
            const result = spawnSync(POWERSHELL,
                ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", harness],
                {encoding: "utf8", timeout: POWERSHELL_TEST_TIMEOUT_MILLISECONDS});
            assert.equal(result.status, 0, result.stderr);
            assert.equal(result.stdout, "MSI activation installed identity differs");
        } finally { fs.rmSync(root, {recursive: true, force: true}); }
    });
});
