import {describe, it} from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SCRIPT = path.resolve("scripts/qualification/windows-winsw-offline-canary.ps1");
const POWERSHELL = process.platform === "win32"
    ? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : "pwsh";
const PROCESS_TIMEOUT_MS = 10_000;
const TEST_TIMEOUT_MS = 30_000;
const HAS_POWERSHELL = childProcess.spawnSync(POWERSHELL,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"],
    {encoding: "utf8", timeout: PROCESS_TIMEOUT_MS}).status === 0;
const powershellIt = (name, fn) => it(name,
    {timeout: TEST_TIMEOUT_MS, skip: !HAS_POWERSHELL && "PowerShell unavailable"}, fn);
const SOURCE_SHA = "a".repeat(40);
const EVENT_SHA = "b".repeat(40);
const NONCE = "0123456789abcdef0123456789abcdef";
const WIN_SW_SHA = "a2daa6a33a9c2b791ae31d9092e7935c339d1e03e89bfb747618ce2f4e819e20";
const WIN_SW_BYTES = 18_286_774;
const CHILD_SHA = "c".repeat(64);
const OFFLINE_START_100NS = 100_000_000n;
const OFFLINE_END_100NS = 550_000_000n;
const WATCHDOG_DEADLINE_100NS = 700_000_000n;
const EXPECTED_ENVIRONMENT = Object.freeze({
    SERVER_HOST: "127.0.0.1", SERVER_PORT: "43127", HTTPS_REDIRECT: "false", DB_TYPE: "sqlite",
    RUN_TEST_ON_STARTUP: "false", PREVIEW_MODE: "false", ALLOW_NO_PASSWORD: "false",
    ALLOW_LOCAL_NODES: "false"
});
const ENDPOINTS = Object.freeze([
    {transport: "tcp", addressFamily: "ipv4", address: "127.0.0.1", port: 43_128},
    {transport: "tcp", addressFamily: "ipv6", address: "::1", port: 43_129},
    {transport: "udp", addressFamily: "ipv4", address: "127.0.0.1", port: 43_130},
    {transport: "udp", addressFamily: "ipv6", address: "::1", port: 43_131}
]);
const TEST_NET_ENDPOINTS = Object.freeze([
    {transport: "tcp", addressFamily: "ipv4", address: "192.0.2.1", port: 43_132},
    {transport: "tcp", addressFamily: "ipv6", address: "2001:db8::1", port: 43_133},
    {transport: "udp", addressFamily: "ipv4", address: "192.0.2.1", port: 43_134},
    {transport: "udp", addressFamily: "ipv6", address: "2001:db8::1", port: 43_135}
]);

const invoke = (mode, input = {}) => childProcess.spawnSync(POWERSHELL, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", SCRIPT, "-Mode", mode, "-InputJson", JSON.stringify(input)
], {encoding: "utf8", timeout: PROCESS_TIMEOUT_MS});

const run = (mode, input = {}) => {
    const result = invoke(mode, input);
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return result.stdout.trim() === "" ? null : JSON.parse(result.stdout);
};

const reject = (mode, input, pattern) => {
    const result = invoke(mode, input);
    assert.equal(result.error, undefined, result.error?.message);
    assert.notEqual(result.status, 0, "expected rejection");
    assert.match(`${result.stdout}\n${result.stderr}`, pattern);
};

const runFactoryFixture = (removeClosure = false, inspectAdapters = false) => {
    const program = `
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$sourceFile='${SCRIPT.replaceAll("'", "''")}'
. $sourceFile -Mode Library
$actualOfflineBoundary=(Get-Command Get-MyspeedNativeOfflineBoundary).ScriptBlock
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($sourceFile,[ref]$tokens,[ref]$errors)
if($errors.Count -ne 0){throw 'Source parse error'}
$definitions=@($ast.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -ceq 'New-MyspeedNativeCanaryOperations'})
if($definitions.Count -ne 1){throw 'Factory definition is not unique'}
$definition=$definitions[0]
$statements=@($definition.Body.EndBlock.Statements)
$expectedHeader=@('Import-Module','Import-Module','Import-Module','Add-Type')
for($index=0;$index -lt $expectedHeader.Count;$index++){
  if($statements[$index] -isnot [Management.Automation.Language.PipelineAst] -or
     $statements[$index].PipelineElements.Count -ne 1 -or
     $statements[$index].PipelineElements[0].GetCommandName() -cne $expectedHeader[$index]){
    throw 'Native factory header changed; no fixture evaluation allowed'
  }
}
$safeBody=($statements|Select-Object -Skip $expectedHeader.Count|ForEach-Object {$_.Extent.Text}) -join [Environment]::NewLine
if([regex]::Matches($safeBody,'return @\\{').Count -ne 1){throw 'Factory return instrumentation shape differs'}
$safeBody=$safeBody.Replace('return @{','return @{ __reviewGetAdapters=$getNativeAdapters;')
if(${removeClosure ? "$true" : "$false"}){
  $callbackStart=$safeBody.IndexOf('verifyOffline={',[StringComparison]::Ordinal)
  $closureEnd=$safeBody.IndexOf('}.GetNewClosure()',$callbackStart,[StringComparison]::Ordinal)
  if($callbackStart -lt 0 -or $closureEnd -lt 0){throw 'Fixture callback shape changed'}
  $safeBody=$safeBody.Remove($closureEnd+1,'.GetNewClosure()'.Length)
}
$safeDefinition='function New-MyspeedNativeCanaryOperations {'+[Environment]::NewLine+
  $definition.Body.ParamBlock.Extent.Text+[Environment]::NewLine+$safeBody+[Environment]::NewLine+'}'
function Add-Type {throw 'Native compilation forbidden in fixture'}
function Import-Module {throw 'Native module import forbidden in fixture'}
function Get-NetAdapter {
  [pscustomobject]@{InterfaceGuid=[guid]'11111111-1111-1111-1111-111111111111';PnPDeviceID='ROOT\\NET\\0000'
    Hidden=$false;InterfaceType=[uint32]6;InterfaceAdminStatus=[uint32]1;Status='Up';ifIndex=[uint32]7}
  [pscustomobject]@{InterfaceGuid=[guid]'22222222-2222-2222-2222-222222222222';PnPDeviceID='ROOT\\NET\\0001'
    Hidden=$false;InterfaceType=[uint32]6;InterfaceAdminStatus=[uint32]2;Status='Disabled';ifIndex=[uint32]8}
}
function Get-NetTCPConnection {throw 'Native endpoint query forbidden in fixture'}
function Get-NetUDPEndpoint {throw 'Native endpoint query forbidden in fixture'}
function Get-NetIPInterface {
  [pscustomobject]@{InterfaceIndex=[uint32]7;CompartmentId=[uint32]1;ConnectionState=[byte]1}
  [pscustomobject]@{InterfaceIndex=[uint32]8;CompartmentId=[uint32]1;ConnectionState=[byte]0}
}
function Get-NetIPAddress {
  [pscustomobject]@{InterfaceIndex=[uint32]7;CompartmentId=[uint32]1;IPAddress='10.0.0.5'}
  [pscustomobject]@{InterfaceIndex=[uint32]8;CompartmentId=[uint32]1;IPAddress='10.0.0.6'}
}
function Get-NetRoute {
  [pscustomobject]@{InterfaceIndex=[uint32]7;CompartmentId=[uint32]1;State=[byte]0}
  [pscustomobject]@{InterfaceIndex=[uint32]8;CompartmentId=[uint32]1;State=[byte]1}
}
function Invoke-MyspeedCanaryTestNet { @() }
function Get-CimInstance {throw 'Native CIM query forbidden in fixture'}
function Get-ScheduledTask {throw 'Native task query forbidden in fixture'}
function Disable-NetAdapter {throw 'Native mutation forbidden in fixture'}
function Enable-NetAdapter {throw 'Native mutation forbidden in fixture'}
function Register-ScheduledTask {throw 'Native mutation forbidden in fixture'}
function Unregister-ScheduledTask {throw 'Native mutation forbidden in fixture'}
function Stop-Process {throw 'Process mutation forbidden in fixture'}
function Get-MyspeedNativeOfflineBoundary {
  param([hashtable]$State)
  [void](Assert-MyspeedCanaryString $State.marker 'Factory marker' '^fixture-owned$')
  $State.boundaryCalled=$true
  return [pscustomobject]@{testNet=@()}
}
function Get-MyspeedNativeProbeEvidence {
  param([hashtable]$State)
  [void](Assert-MyspeedCanaryString $State.marker 'Factory marker' '^fixture-owned$')
  $State.probeCalled=$true
  return [pscustomobject]@{marker=$State.marker}
}
function Assert-MyspeedWinswProbe {
  param([object]$Probe)
  [void](Assert-MyspeedCanaryString $Probe.marker 'Probe marker' '^fixture-owned$')
  return [pscustomobject]@{accepted=$true}
}
. ([scriptblock]::Create($safeDefinition))
function New-Fixture {
  $privateState=@{marker='fixture-owned';boundary=$null;probe=$null;boundaryCalled=$false;probeCalled=$false
    childRecord=[pscustomobject]@{testNet=@()};serviceOwnershipEligible=$false;taskOwnershipEligible=$false
    insertedEnvironment=[Collections.Generic.List[string]]::new()}
  $callbacks=New-MyspeedNativeCanaryOperations $privateState
  return [pscustomobject]@{callbacks=$callbacks;state=$privateState}
}
$fixture=New-Fixture
if(${inspectAdapters ? "$true" : "$false"}){
  $observed=& $fixture.callbacks.__reviewGetAdapters
  if($observed.raw.Count -ne 2 -or $observed.inventory.Count -ne 2 -or $observed.inventory[0] -is [array]){
    throw 'Actual native factory nested the normalized adapter inventory'
  }
  if($observed.inventory[0].pnpDeviceId -cne $observed.raw[0].PnPDeviceID -or
     $observed.inventory[1].pnpDeviceId -cne $observed.raw[1].PnPDeviceID -or
     -not $observed.inventory[0].enabled -or $observed.inventory[1].enabled){throw 'Native ordinal/state mapping differs'}
  $projection=New-MyspeedCanaryProviderProjectionOperations
  $boundary=& $actualOfflineBoundary -State @{request=[pscustomobject]@{offlineStart100ns='100';watchdogDeadline100ns='600000100'}} -Clock {'200'} -NormalizeProviderAdapters $projection.normalizeAdapters -NormalizeAdapters (Get-Command ConvertTo-MyspeedCanaryAdapterInventory).ScriptBlock -GetAdapterSnapshot (Get-Command Get-MyspeedCanaryAdapterProviderSnapshot).ScriptBlock -ProjectIpState $projection.projectIpState -GetElapsed (Get-Command Get-MyspeedCanaryElapsedMilliseconds).ScriptBlock -LoopbackType 24 -EnabledAdminStatus 1 -DisabledAdminStatus 2 -KnownStatuses $script:KnownAdapterStatuses
  if($boundary.adapters.Count -ne 2 -or $boundary.adapters[0] -is [array] -or $boundary.ipState.Count -ne 6){
    throw "Actual offline boundary shape differs: adapters=$($boundary.adapters.Count); first=$($boundary.adapters[0].GetType().FullName); ip=$($boundary.ipState.Count)"
  }
}
& $fixture.callbacks.verifyOffline
& $fixture.callbacks.probe
& $fixture.callbacks.restoreEnvironment
if(-not $fixture.state.boundaryCalled -or -not $fixture.state.probeCalled){throw 'Returned callback lost its factory state'}
[pscustomobject]@{passed=$true;nativeOperations=0}|ConvertTo-Json -Compress
`;
    const result = childProcess.spawnSync(POWERSHELL,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
            Buffer.from(program, "utf16le").toString("base64")],
        {encoding: "utf8", timeout: TEST_TIMEOUT_MS});
    assert.equal(result.error, undefined, result.error?.message);
    return result;
};

const manifest = () => ({
    schemaVersion: 1,
    kind: "myspeed-winsw-offline-canary-closure",
    expectedRunId: "12345",
    expectedRunAttempt: "2",
    expectedSourceSha: SOURCE_SHA,
    expectedEventSha: EVENT_SHA,
    nonce: NONCE,
    files: [
        {name: "windows-winsw-offline-canary.ps1", bytes: 100, sha256: "d".repeat(64)},
        {name: "WinSW-x64.exe", bytes: WIN_SW_BYTES, sha256: WIN_SW_SHA}
    ]
});

const boundary = () => ({
    schemaVersion: 1,
    offlineTiming: {
        clock: "QueryUnbiasedInterruptTime100ns",
        start100ns: OFFLINE_START_100NS.toString(),
        end100ns: OFFLINE_END_100NS.toString(),
        watchdogDeadline100ns: WATCHDOG_DEADLINE_100NS.toString(),
        elapsedMilliseconds: 45_000
    },
    providers: {adapters: true, ipInterfaces: true, ipAddresses: true, routes: true},
    adapters: [
        {interfaceGuid: "{11111111-1111-1111-1111-111111111111}", pnpDeviceId: "ROOT\\NET\\0000",
            hidden: false, loopback: false, enabled: false, status: "Disabled"},
        {interfaceGuid: "{22222222-2222-2222-2222-222222222222}", pnpDeviceId: "ROOT\\LOOPBACK\\0000",
            hidden: true, loopback: true, enabled: true, status: "Up"}
    ],
    ipState: [
        {kind: "interface", compartmentId: 1, loopback: true, routable: false},
        {kind: "address", compartmentId: 1, loopback: true, routable: false},
        {kind: "route", compartmentId: 1, loopback: true, routable: false}
    ],
    loopback: ENDPOINTS.map(endpoint => ({...endpoint, passed: true, ownerPid: 101})),
    testNet: ["controller", "child"].flatMap(actor => TEST_NET_ENDPOINTS.map(endpoint =>
        ({actor, ...endpoint, outcome: "denied"})))
});

const winswConfiguration = nonce => {
    const text = [
        "<service>",
        `  <id>MySpeedOfflineCanary-${nonce}</id>`,
        `  <name>MySpeed Offline Canary ${nonce}</name>`,
        "  <description>Candidate-neutral WinSW inheritance canary</description>",
        "  <executable>inert-child.exe</executable>",
        "  <startmode>Manual</startmode>",
        "  <stoptimeout>5 sec</stoptimeout>",
        "</service>",
        ""
    ].join("\r\n");
    const bytes = Buffer.from(text, "utf8");
    return {bytesBase64: bytes.toString("base64"), sha256: crypto.createHash("sha256").update(bytes).digest("hex")};
};

const probe = () => ({
    schemaVersion: 1,
    nonce: NONCE,
    serviceName: `MySpeedOfflineCanary-${NONCE}`,
    wrapperPid: 100,
    childPid: 101,
    parentPid: 100,
    wrapperCreationFileTime: "0000000000000001",
    childCreationFileTime: "0000000000000002",
    sid: "S-1-5-18",
    environment: {...EXPECTED_ENVIRONMENT},
    forbiddenNames: [],
    configuration: winswConfiguration(NONCE),
    endpoints: ENDPOINTS.map(endpoint => ({...endpoint, ownerPid: 101})),
    winswSha256: WIN_SW_SHA,
    childSha256: CHILD_SHA
});

const recovery = emergency => ({
    schemaVersion: 1,
    classification: emergency ? "inconclusive" : "completed",
    emergencyRestore: emergency,
    serviceTeardownProven: !emergency,
    adapterRestoreProven: true,
    recoveryTaskGoneProven: true,
    environmentRestoredProven: true,
    continuationObserved: true,
    cleanupAfterReconnectProven: true,
    phaseOrder: emergency
        ? ["emergencyRestore", "postReconnectCleanup"]
        : ["teardownService", "restoreAdapters", "disarmRecovery", "restoreEnvironment"]
});

const hostedContext = () => ({
    environment: {
        GITHUB_ACTIONS: "true", CI: "true", GITHUB_REPOSITORY: "i7Gamer/MySpeed", RUNNER_OS: "Windows",
        RUNNER_ARCH: "X64", RUNNER_ENVIRONMENT: "github-hosted", ImageOS: "win25-vs2026",
        ImageVersion: "20260907.229.1", GITHUB_RUN_ID: "12345", GITHUB_RUN_ATTEMPT: "2", GITHUB_SHA: EVENT_SHA
    },
    expectedRunId: "12345",
    expectedRunAttempt: "2",
    expectedEventSha: EVENT_SHA,
    expectedSourceSha: SOURCE_SHA,
    expectedImageVersion: "20260907.229.1",
    nonce: NONCE,
    manifest: manifest()
});

const recoveryRequest = () => ({
    schemaVersion: 1,
    kind: "myspeed-winsw-offline-recovery-request",
    expectedRunId: "12345",
    expectedRunAttempt: "2",
    expectedEventSha: EVENT_SHA,
    expectedSourceSha: SOURCE_SHA,
    expectedImageVersion: "20260907.229.1",
    nonce: NONCE,
    scriptPath: "C:\\runner\\temp\\closure\\windows-winsw-offline-canary.ps1",
    scriptSha256: "d".repeat(64),
    taskRoot: `C:\\runner\\temp\\myspeed-winsw-offline-${NONCE}`,
    lockPath: `C:\\runner\\temp\\myspeed-winsw-offline-${NONCE}\\recovery.lock`,
    cancelPath: `C:\\runner\\temp\\myspeed-winsw-offline-${NONCE}\\recovery.cancel`,
    readyPath: `C:\\runner\\temp\\myspeed-winsw-offline-${NONCE}\\recovery.ready.json`,
    recoveryResultPath: `C:\\runner\\temp\\myspeed-winsw-offline-${NONCE}\\recovery.result.json`,
    cleanupResultPath: `C:\\runner\\temp\\myspeed-winsw-offline-${NONCE}\\cleanup.result.json`,
    ownershipPath: `C:\\runner\\temp\\myspeed-winsw-offline-${NONCE}\\service.ownership.json`,
    taskName: `MySpeedOfflineRecovery-${NONCE}`,
    serviceName: `MySpeedOfflineCanary-${NONCE}`,
    serviceExecutablePath: `C:\\runner\\temp\\myspeed-winsw-offline-${NONCE}\\MySpeedOfflineCanary-${NONCE}.exe`,
    serviceXmlPath: `C:\\runner\\temp\\myspeed-winsw-offline-${NONCE}\\MySpeedOfflineCanary-${NONCE}.xml`,
    childPath: `C:\\runner\\temp\\myspeed-winsw-offline-${NONCE}\\inert-child.exe`,
    environment: {...EXPECTED_ENVIRONMENT},
    adapters: [
        {interfaceGuid: "{11111111-1111-1111-1111-111111111111}", pnpDeviceId: "PCI\\VEN_1234&DEV_5678"}
    ],
    offlineStart100ns: OFFLINE_START_100NS.toString(),
    watchdogDeadline100ns: WATCHDOG_DEADLINE_100NS.toString()
});

describe("candidate-neutral WinSW offline canary contract", () => {
    it("keeps native mutations behind the hosted guard and exposes all three cleanup entries", () => {
        const source = fs.readFileSync(SCRIPT, "utf8");
        for (const term of ["Disable-NetAdapter", "Enable-NetAdapter", "Register-ScheduledTask",
            "Invoke-MyspeedHostedNativeCanary", "Invoke-MyspeedRestorationOnly", "Invoke-MyspeedPostReconnectCleanup"])
            assert.match(source, new RegExp(term));
        assert.ok(source.indexOf("Assert-MyspeedCanaryHostedContext") < source.indexOf("New-MyspeedNativeCanaryOperations"));
        assert.match(source, /Native mutations are reached only after Assert-MyspeedCanaryHostedContext/u);
        assert.equal(source.match(/Assert-MyspeedCanaryInboxPowerShellHost/gu)?.length, 4);
        assert.match(source, /QueryUnbiasedInterruptTime/u);
        assert.match(source, /FileMode\]::CreateNew/u);
        assert.match(source, /dwX,dwY,dwXSize,dwYSize,dwXCountChars,dwYCountChars,dwFillAttribute,dwFlags/u);
        assert.match(source, /TotalPageFaultCount,TotalProcesses,ActiveProcesses,TotalTerminatedProcesses/u);
        assert.match(source, /AssignProcessToJobObject/u);
        assert.match(source, /CREATE_SUSPENDED\|CREATE_NO_WINDOW/u);
        assert.match(source, /\$\{function:New-MyspeedCanaryWinswConfiguration\}/u);
        assert.ok(source.match(/ServiceType -cne 'Own Process'/gu)?.length >= 2);
        assert.doesNotMatch(source, /ReadToEndAsync|RedirectStandard(Output|Error)/u);
        const restore = source.slice(source.indexOf("$restore={"), source.indexOf("}.GetNewClosure()", source.indexOf("$restore={")));
        assert.ok(restore.indexOf("request.cancelPath") < restore.indexOf("$lock.Dispose()"));
        assert.ok(restore.lastIndexOf("recoveryResultPath") < restore.indexOf("$lock.Dispose()"));
        for (const phase of ["verifyOffline", "probe"])
            assert.match(source, new RegExp(`${phase}=\\{[^}]+\\}\\.GetNewClosure\\(\\)`, "su"));
    });

    powershellIt("retains returned native-factory state without executing native operations", () => {
        const result = runFactoryFixture();
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        assert.deepEqual(JSON.parse(result.stdout.trim()), {passed: true, nativeOperations: 0});
    });

    powershellIt("reproduces a missing factory callback closure without native execution", () => {
        const result = runFactoryFixture(true);
        assert.notEqual(result.status, 0);
        assert.match(`${result.stdout}\n${result.stderr}`, /State.*cannot be retrieved|cannot be retrieved.*State/s);
    });

    powershellIt("preserves two ordered synthetic adapters through the actual native factory capture", () => {
        const result = runFactoryFixture(false, true);
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    });

    powershellIt("is import-safe and reports a fixed nonqualifying contract", () => {
        const imported = childProcess.spawnSync(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
            `. '${SCRIPT.replaceAll("'", "''")}' -Mode Library`],
        {encoding: "utf8", timeout: PROCESS_TIMEOUT_MS});
        assert.equal(imported.status, 0, imported.stderr);
        assert.equal(imported.stdout.trim(), "");
        const contract = run("GetContract");
        assert.equal(contract.offlineMaximumSeconds, 60);
        assert.equal(contract.qualifying, false);
        assert.deepEqual(contract.releaseGatesCleared, []);
        assert.equal(contract.winswSha256, WIN_SW_SHA);
        assert.equal(contract.winswBytes, WIN_SW_BYTES);
        assert.deepEqual(contract.expectedEnvironment, EXPECTED_ENVIRONMENT);
    });

    powershellIt("validates the exact two-file, run-bound closure", () => {
        assert.equal(run("ValidateManifest", manifest()).accepted, true);
        for (const mutate of [
            value => { value.extra = true; },
            value => { value.expectedRunId = 12345; },
            value => { value.expectedRunAttempt = "0"; },
            value => { value.files[0].bytes = 1.5; },
            value => { value.files[0].bytes = true; },
            value => { value.files.reverse(); },
            value => { value.files[1].sha256 = "e".repeat(64); },
            value => { value.files[1].bytes = WIN_SW_BYTES - 1; }
        ]) {
            const value = manifest(); mutate(value);
            reject("ValidateManifest", value, /manifest|closure|file|bytes|sha/i);
        }
    });

    powershellIt("cross-binds exact hosted run identity, image, nonce, and closure", () => {
        assert.equal(run("AssertContext", hostedContext()).accepted, true);
        for (const mutate of [
            value => { value.environment.CI = "false"; },
            value => { value.environment.GITHUB_RUN_ATTEMPT = "3"; },
            value => { value.environment.GITHUB_SHA = SOURCE_SHA; },
            value => { value.expectedSourceSha = "f".repeat(40); },
            value => { value.expectedImageVersion = "stale"; },
            value => { value.nonce = "f".repeat(32); },
            value => { value.manifest.expectedRunId = "999"; }
        ]) {
            const value = hostedContext(); mutate(value);
            reject("AssertContext", value, /hosted context|manifest|nonce|image|differ/i);
        }
        const result = invoke("InvokeHostedCanary", hostedContext());
        assert.notEqual(result.status, 0);
        assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /not implemented/i);
    });

    powershellIt("validates the immutable restoration request and exact owned path derivation", () => {
        assert.equal(run("ValidateRecoveryRequest", recoveryRequest()).accepted, true);
        for (const mutate of [
            value => { value.extra = true; },
            value => { value.adapters[0].interfaceGuid = "bad"; },
            value => { value.adapters.push({...value.adapters[0]}); },
            value => { value.lockPath = "C:\\unowned\\recovery.lock"; },
            value => { value.serviceName = "OtherService"; },
            value => { value.offlineStart100ns = "0"; value.watchdogDeadline100ns = "600000000"; },
            value => { value.watchdogDeadline100ns = "700000001"; },
            value => { value.environment.SERVER_PORT = "80"; }
        ]) {
            const value = recoveryRequest(); mutate(value);
            reject("ValidateRecoveryRequest", value, /recovery|adapter|owned|service|deadline|environment|schema/i);
        }
    });

    powershellIt("binds machine cleanup to a create-new exact ownership record", () => {
        const ownership = {schemaVersion: 1, names: Object.keys(EXPECTED_ENVIRONMENT)};
        assert.equal(run("ValidateEnvironmentOwnership", ownership).accepted, true);
        for (const mutate of [
            value => { value.extra = true; },
            value => { value.schemaVersion = true; },
            value => { value.names.reverse(); },
            value => { value.names[0] = "PATH"; }
        ]) {
            const value = structuredClone(ownership); mutate(value);
            reject("ValidateEnvironmentOwnership", value, /environment|ownership|schema|order/i);
        }
        const source = fs.readFileSync(SCRIPT, "utf8");
        const prepare = source.slice(source.indexOf("prepare={"), source.indexOf("}.GetNewClosure()", source.indexOf("prepare={")));
        assert.ok(prepare.indexOf("Machine environment collision") < prepare.indexOf("environmentOwnershipPath"));
        assert.ok(prepare.indexOf("environmentOwnershipPath") < prepare.indexOf("SetValue"));
        assert.doesNotMatch(source, /foreach\(\$name in \$script:ExpectedEnvironment\.Keys\)/u);
        const arm = source.slice(source.indexOf("armRecovery={"), source.indexOf("}.GetNewClosure()", source.indexOf("armRecovery={")));
        assert.ok(arm.indexOf("Recovery task collision") < arm.indexOf("taskOwnershipPath"));
        assert.ok(arm.indexOf("taskOwnershipPath") < arm.indexOf("Register-ScheduledTask"));
        assert.doesNotMatch(source, /taskOwnershipEligible=\$true;probe=\$null/u);
    });

    powershellIt("strictly binds the SYSTEM watchdog readiness used by every exit proof", () => {
        const request = recoveryRequest();
        const ready = {schemaVersion: 1, sid: "S-1-5-18", pid: 321,
            creationFileTime: "0000000000000001", requestSha256: "e".repeat(64),
            scriptSha256: request.scriptSha256, taskName: request.taskName};
        assert.equal(run("ValidateRecoveryReadiness", {ready, request, requestSha256: ready.requestSha256}).accepted, true);
        for (const mutate of [
            value => { value.ready.sid = "S-1-5-20"; },
            value => { value.ready.pid = "321"; },
            value => { value.ready.creationFileTime = "0000000000000000"; },
            value => { value.ready.requestSha256 = "f".repeat(64); },
            value => { value.ready.taskName = "Other"; }
        ]) {
            const value = {ready: structuredClone(ready), request: structuredClone(request), requestSha256: ready.requestSha256};
            mutate(value);
            reject("ValidateRecoveryReadiness", value, /readiness|PID|creation|identity/i);
        }
        const source = fs.readFileSync(SCRIPT, "utf8");
        assert.match(source, /Owned recovery process remained after task stop/u);
        assert.match(source, /StartTime\.ToUniversalTime\(\)\.ToFileTimeUtc/u);
        assert.match(source, /cancelRecoveryWhenAdaptersEnabled/u);
        assert.match(source, /\$_\.pnpDeviceId -ieq \$target\.pnpDeviceId -and \$_\.enabled/u);
        assert.doesNotMatch(source, /Stop-ScheduledTask/u);
    });

    powershellIt("keeps task cancellation, PID exit proof, and unregister ordered and fail closed", () => {
        const input = () => ({taskPresent: true, taskRunning: true, readyPresent: true, failAt: null});
        assert.deepEqual(run("TestRecoveryTaskCleanup", input()).events,
            ["cancel", "taskStopped", "processGone", "unregister"]);
        assert.deepEqual(run("TestRecoveryTaskCleanup",
            {taskPresent: false, taskRunning: false, readyPresent: true, failAt: null}).events, ["processGone"]);
        reject("TestRecoveryTaskCleanup",
            {taskPresent: true, taskRunning: true, readyPresent: false, failAt: null}, /readiness/i);
        for (const failAt of ["cancel", "waitTask", "waitProcess", "unregister"]) {
            const failure = input(); failure.failAt = failAt;
            reject("TestRecoveryTaskCleanup", failure, new RegExp(failAt, "i"));
        }
        const source = fs.readFileSync(SCRIPT, "utf8");
        assert.match(source, /\$disposeRecoveryTask[\s\S]+if\(\$State\.insertedEnvironment/u);
        assert.doesNotMatch(source, /Stop-ScheduledTask/u);
    });

    powershellIt("requires the whole owned WinSW executable path set gone before normal adapter restore", () => {
        const ownedPaths = [
            `${recoveryRequest().taskRoot}\\MySpeedOfflineCanary-${NONCE}.exe`,
            `${recoveryRequest().taskRoot}\\inert-child.exe`
        ];
        const replacement = {processes: [
            {ProcessId: 101, ExecutablePath: ownedPaths[0]},
            {ProcessId: 999, ExecutablePath: ownedPaths[1]},
            {ProcessId: 4, ExecutablePath: null},
            {ProcessId: 202, ExecutablePath: "C:\\Windows\\System32\\other.exe"}
        ], ownedPaths};
        const observed = run("ProjectOwnedProcesses", replacement).processes;
        assert.deepEqual(observed.map(value => value.processId), [101, 999]);
        assert.deepEqual(run("ProjectOwnedProcesses", {processes: [], ownedPaths}).processes, []);
        const malformedPid = structuredClone(replacement);
        malformedPid.processes[0].ProcessId = "101";
        reject("ProjectOwnedProcesses", malformedPid, /process PID|integer/i);
        const malformedPath = structuredClone(replacement);
        malformedPath.processes[2].ExecutablePath = false;
        reject("ProjectOwnedProcesses", malformedPath, /executable path|string/i);
        const source = fs.readFileSync(SCRIPT, "utf8");
        const teardown = source.slice(source.indexOf("teardownService={"), source.indexOf("restoreAdapters=$restore"));
        assert.match(teardown, /Get-CimInstance Win32_Process -ErrorAction Stop/u);
        assert.match(teardown, /\$ownedPaths\.Count -ne 0/u);
        assert.doesNotMatch(source, /Stop-Process/u);
        assert.match(source, /Owned lingering service tree exit is unproven; PID-based forced cleanup is forbidden/u);
    });

    powershellIt("rejects malformed native adapter DTOs before deriving mutation state", () => {
        const adapters = () => ({adapters: [
            {InterfaceGuid: "{11111111-1111-1111-1111-111111111111}", PnPDeviceID: "PCI\\VEN_1234&DEV_5678",
                Hidden: false, InterfaceType: 6, InterfaceAdminStatus: 1, Status: "Up", ifIndex: 4},
            {InterfaceGuid: "{22222222-2222-2222-2222-222222222222}", PnPDeviceID: "ROOT\\LOOPBACK\\0000",
                Hidden: true, InterfaceType: 24, InterfaceAdminStatus: 1, Status: "Up", ifIndex: 1},
            {InterfaceGuid: "{33333333-3333-3333-3333-333333333333}", PnPDeviceID: "PCI\\VEN_1234&DEV_9999",
                Hidden: false, InterfaceType: 6, InterfaceAdminStatus: 2, Status: "Disabled", ifIndex: 5}
        ]});
        const accepted = run("NormalizeAdapters", adapters());
        assert.equal(accepted.length, 3);
        assert.equal(accepted[0].enabled, true);
        assert.equal(accepted[1].loopback, true);
        assert.equal(accepted[2].enabled, false);

        for (const mutate of [
            value => { value.adapters[0].Hidden = "false"; },
            value => { value.adapters[0].Hidden = null; },
            value => { value.adapters[0].InterfaceType = "6"; },
            value => { value.adapters[0].InterfaceAdminStatus = "1"; },
            value => { value.adapters[0].InterfaceAdminStatus = 3; },
            value => { value.adapters[0].Status = null; },
            value => { value.adapters[0].Status = "Unexpected"; },
            value => { value.adapters[0].ifIndex = 0; },
            value => { value.adapters[0].ifIndex = 4.5; },
            value => { value.adapters[0].PnPDeviceID = ""; },
            value => { value.adapters[1].InterfaceGuid = value.adapters[0].InterfaceGuid; },
            value => { value.adapters[1].PnPDeviceID = value.adapters[0].PnPDeviceID; },
            value => { value.adapters[1].ifIndex = value.adapters[0].ifIndex; }
        ]) {
            const value = adapters(); mutate(value);
            reject("NormalizeAdapters", value, /adapter|Boolean|integer|status|identity|index/i);
        }
        const source = fs.readFileSync(SCRIPT, "utf8");
        assert.doesNotMatch(source, /pnpDeviceId=\[string\]\$_\.PnPDeviceID|hidden=\[bool\]\$_\.Hidden/u);
        assert.ok(source.match(/ConvertFrom-MyspeedCanaryNetAdapterProviderInventory/gu)?.length >= 3);
        assert.match(source, /function Get-MyspeedCanaryAdapterProviderSnapshot/u);
        assert.match(source, /\$snapshot=Get-MyspeedCanaryAdapterProviderSnapshot \$all/u);
        assert.match(source, /\$afterInventory=\(Get-MyspeedCanaryAdapterProviderSnapshot \$after\)\.inventory/u);
    });

    powershellIt("rejects a one-record nested adapter normalization result", () => {
        const program = `
. '${SCRIPT.replaceAll("'", "''")}' -Mode Library
$raw=[object[]]@([pscustomobject]@{InterfaceGuid=[guid]'11111111-1111-1111-1111-111111111111';PnPDeviceID='ROOT\\NET\\0000';Hidden=$false;InterfaceType=[uint32]6;InterfaceAdminStatus=[uint32]1;Status='Up';ifIndex=[uint32]7})
$badNormalizer={param([object]$Value)
  $inner=[object[]]@([pscustomobject]@{interfaceGuid='{11111111-1111-1111-1111-111111111111}';pnpDeviceId='ROOT\\NET\\0000';hidden=$false;interfaceType=6;interfaceAdminStatus=1;status='Up';interfaceIndex=7;loopback=$false;enabled=$true})
  $nested=New-Object object[] 1;$nested[0]=$inner;Write-Output -NoEnumerate $nested
}
$rejected=$false
try{[void](Get-MyspeedCanaryAdapterProviderSnapshot $raw $badNormalizer)}catch{
  if($_.Exception.Message -cne 'Normalized adapter snapshot shape differs'){throw};$rejected=$true
}
if(-not $rejected){throw 'Nested one-record adapter snapshot was accepted'}
`;
        const result = childProcess.spawnSync(POWERSHELL,
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
                Buffer.from(program, "utf16le").toString("base64")],
            {encoding: "utf8", timeout: TEST_TIMEOUT_MS});
        assert.equal(result.error, undefined, result.error?.message);
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    });

    powershellIt("rejects reordered normalized adapters before raw provider selection", () => {
        const program = `
. '${SCRIPT.replaceAll("'", "''")}' -Mode Library
$raw=[object[]]@(
  [pscustomobject]@{InterfaceGuid=[guid]'11111111-1111-1111-1111-111111111111';PnPDeviceID='ROOT\\NET\\0000';Hidden=$false;InterfaceType=[uint32]6;InterfaceAdminStatus=[uint32]1;Status='Up';ifIndex=[uint32]7},
  [pscustomobject]@{InterfaceGuid=[guid]'22222222-2222-2222-2222-222222222222';PnPDeviceID='ROOT\\NET\\0001';Hidden=$false;InterfaceType=[uint32]6;InterfaceAdminStatus=[uint32]2;Status='Disabled';ifIndex=[uint32]8}
)
$reordered={param([object]$Value,[int64]$LoopbackType,[int64]$Enabled,[int64]$Disabled,[string[]]$Statuses)
  $normalized=ConvertTo-MyspeedCanaryAdapterInventory $Value $LoopbackType $Enabled $Disabled $Statuses
  $result=[object[]]@($normalized[1],$normalized[0]);Write-Output -NoEnumerate $result
}
$rejected=$false
try{[void](Get-MyspeedCanaryAdapterProviderSnapshot $raw $null 24 1 2 @('Up','Disabled') $reordered)}catch{
  if($_.Exception.Message -cne 'Normalized adapter snapshot order differs'){throw};$rejected=$true
}
if(-not $rejected){throw 'Reordered normalized adapter snapshot was accepted'}
`;
        const result = childProcess.spawnSync(POWERSHELL,
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
                Buffer.from(program, "utf16le").toString("base64")],
            {encoding: "utf8", timeout: TEST_TIMEOUT_MS});
        assert.equal(result.error, undefined, result.error?.message);
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    });

    powershellIt("projects the same strict all-compartment IP state before and after adapter disable", () => {
        const value = () => ({
            adapters: [{InterfaceGuid: "{11111111-1111-1111-1111-111111111111}",
                PnPDeviceID: "PCI\\VEN_1234&DEV_5678", Hidden: false, InterfaceType: 6,
                InterfaceAdminStatus: 1, Status: "Up", ifIndex: 4}],
            interfaces: [
                {InterfaceIndex: 4, CompartmentId: 1, ConnectionState: 1},
                {InterfaceIndex: 1, CompartmentId: 1, ConnectionState: "Connected"}
            ],
            addresses: [
                {InterfaceIndex: 4, CompartmentId: 1, IPAddress: "10.0.0.5"},
                {InterfaceIndex: 1, CompartmentId: 1, IPAddress: "127.0.0.1"}
            ],
            routes: [
                {InterfaceIndex: 4, CompartmentId: 1, State: 0},
                {InterfaceIndex: 1, CompartmentId: 1, State: "Alive"}
            ]
        });
        const accepted = run("ProjectIpState", value());
        assert.deepEqual(accepted.map(entry => entry.kind), ["interface", "interface", "address", "address", "route", "route"]);
        assert.equal(accepted[0].routable, true);
        assert.equal(accepted[1].loopback, true);
        assert.equal(accepted[1].routable, false);

        const multiple = value();
        multiple.adapters.push({InterfaceGuid: "{33333333-3333-3333-3333-333333333333}",
            PnPDeviceID: "PCI\\VEN_1234&DEV_9999", Hidden: false, InterfaceType: 6,
            InterfaceAdminStatus: 2, Status: "Disabled", ifIndex: 5});
        multiple.interfaces.push({InterfaceIndex: 5, CompartmentId: 1, ConnectionState: 0});
        multiple.addresses.push({InterfaceIndex: 5, CompartmentId: 1, IPAddress: "10.0.0.6"});
        multiple.routes.push({InterfaceIndex: 5, CompartmentId: 1, State: 1});
        const projectedMultiple = run("ProjectIpState", multiple);
        assert.equal(projectedMultiple.length, 9);
        assert.equal(projectedMultiple.filter(entry => entry.routable).length, 3);

        for (const mutate of [
            item => { item.interfaces[0].ConnectionState = 2; },
            item => { item.interfaces[0].ConnectionState = "1"; },
            item => { item.interfaces[0].ConnectionState = null; },
            item => { item.routes[0].State = 3; },
            item => { item.routes[0].State = "0"; },
            item => { item.routes[0].State = null; },
            item => { item.interfaces[0].InterfaceIndex = "4"; },
            item => { item.interfaces[0].InterfaceIndex = 99; },
            item => { item.addresses[0].InterfaceIndex = 99; },
            item => { item.routes[0].InterfaceIndex = 99; },
            item => { item.interfaces[0].CompartmentId = "1"; }
        ]) {
            const item = value(); mutate(item);
            reject("ProjectIpState", item, /IP|route|interface|integer|unknown|mapped/i);
        }
        const source = fs.readFileSync(SCRIPT, "utf8");
        assert.ok(source.match(/New-MyspeedCanaryProviderProjectionOperations/gu)?.length >= 3);
        assert.match(source, /\$State\.preDisable=/u);
        assert.match(source, /-ProjectIpState \$projectIpState/u);
        assert.doesNotMatch(source, /\$inventory=@\(& \$(?:NormalizeProviderAdapters|normalizeProviderAdapters|providerProjection\.normalizeAdapters)/u);
        assert.doesNotMatch(source, /\$(?:inventory|afterInventory)=@\(ConvertFrom-MyspeedCanaryNetAdapterProviderInventory/u);
        assert.doesNotMatch(source, /\$(?:ip|preIp)=@\(& \$(?:ProjectIpState|projectIpState)/u);
    });

    powershellIt("generates an inert no-spawn child bound to exact loopback and TEST-NET literals", () => {
        const generated = run("GetInertChildSource", {nonce: NONCE, resultPath: `${recoveryRequest().taskRoot}\\probe.json`});
        assert.equal(generated.sha256.length, 64);
        assert.match(generated.source, /127\.0\.0\.1/);
        assert.match(generated.source, /2001:db8::1/);
        assert.match(generated.source, /S-1-5-18|WindowsIdentity/);
        assert.match(generated.source, /SetErrorMode\(ChildErrorMode\)/);
        assert.match(generated.source, /CharSet = CharSet\.Unicode/);
        assert.match(generated.source, /Process32FirstW/);
        assert.match(generated.source, /try \{ IAsyncResult pending=client\.BeginConnect/u);
        assert.match(generated.source, /using\(WaitHandle wait=pending\.AsyncWaitHandle\)/u);
        assert.doesNotMatch(generated.source, /Process\.Start|Dns\.|HttpClient|WebRequest/);
        for (const [name, value] of Object.entries(EXPECTED_ENVIRONMENT)) {
            assert.match(generated.source, new RegExp(name));
            assert.match(generated.source, new RegExp(value.replaceAll(".", "\\.")));
        }
    });

    powershellIt("rejects any TCP or UDP listener collision on every fixed canary port", () => {
        assert.equal(run("TestPortPreflight", {tcpEndpoints: [], udpEndpoints: []}).accepted, true);
        for (const mutate of [
            value => { value.tcpEndpoints.push({LocalPort: ENDPOINTS[0].port}); },
            value => { value.udpEndpoints.push({LocalPort: ENDPOINTS[3].port}); },
            value => { value.tcpEndpoints.push({LocalPort: String(ENDPOINTS[1].port)}); }
        ]) {
            const value = {tcpEndpoints: [], udpEndpoints: []}; mutate(value);
            reject("TestPortPreflight", value, /port|endpoint|collision|integer/i);
        }
        const source = fs.readFileSync(SCRIPT, "utf8");
        assert.match(source, /Get-NetTCPConnection -ErrorAction Stop/u);
        assert.match(source, /Get-NetUDPEndpoint -ErrorAction Stop/u);
        assert.match(source, /Get-AuthenticodeSignature -LiteralPath/u);
        assert.match(source, /winswAuthenticodeStatus/u);
    });

    powershellIt("accepts only exhaustive offline state and four owned loopback controls", () => {
        assert.equal(run("ClassifyBoundary", boundary()).accepted, true);
        for (const mutate of [
            value => { value.providers.routes = false; },
            value => { value.offlineTiming.elapsedMilliseconds = 60_001; value.offlineTiming.end100ns = "700010000"; },
            value => { value.offlineTiming.watchdogDeadline100ns = "700000001"; },
            value => { value.offlineTiming.clock = "DateTimeUtc"; },
            value => { value.adapters[0].enabled = true; value.adapters[0].status = "Up"; },
            value => { value.adapters[1].interfaceGuid = value.adapters[0].interfaceGuid; },
            value => { value.adapters[1].pnpDeviceId = value.adapters[0].pnpDeviceId; },
            value => { value.ipState[2].loopback = false; value.ipState[2].routable = true; },
            value => { value.loopback[0].ownerPid = 0; },
            value => { value.loopback[0].address = "0.0.0.0"; },
            value => { value.loopback[0].port = 80; },
            value => { value.loopback.pop(); },
            value => { value.testNet[0].address = "8.8.8.8"; },
            value => { value.testNet.pop(); },
            value => { value.testNet[0].extra = true; }
        ]) {
            const value = boundary(); mutate(value);
            reject("ClassifyBoundary", value, /boundary|provider|adapter|route|loopback|TEST-NET|schema/i);
        }
        const udpAccepted = boundary();
        udpAccepted.testNet.filter(value => value.transport === "udp")
            .forEach(value => { value.outcome = "sendAccepted"; });
        const assessment = run("ClassifyBoundary", udpAccepted);
        assert.equal(assessment.accepted, true);
        assert.equal(assessment.udpSendAccepted, true);
        const fractionalMillisecond = boundary();
        fractionalMillisecond.offlineTiming.end100ns = (OFFLINE_START_100NS + 6_001n).toString();
        fractionalMillisecond.offlineTiming.elapsedMilliseconds = 0;
        assert.equal(run("ClassifyBoundary", fractionalMillisecond).accepted, true);
        const source = fs.readFileSync(SCRIPT, "utf8");
        assert.match(source, /elapsedMilliseconds=& \$GetElapsed/u);
        assert.match(source, /elapsedMilliseconds=& \$getElapsed/u);
    });

    powershellIt("binds the LocalSystem WinSW child, environment, parent, and endpoint owners", () => {
        assert.equal(run("ValidateProbe", probe()).accepted, true);
        assert.match(fs.readFileSync(SCRIPT, "utf8"), /endpoints=\$probeEndpoints/u);
        for (const mutate of [
            value => { value.sid = "S-1-5-20"; },
            value => { value.parentPid = 999; },
            value => { value.nonce = "f".repeat(32); },
            value => { value.wrapperCreationFileTime = "0000000000000000"; },
            value => { value.childCreationFileTime = "2"; },
            value => { value.environment.SERVER_HOST = "0.0.0.0"; },
            value => { value.forbiddenNames.push("HTTP_PROXY"); },
            value => {
                const xml = Buffer.from(value.configuration.bytesBase64, "base64").toString("utf8")
                    .replace("</service>", "  <env name=\"SERVER_HOST\" value=\"127.0.0.1\"/>\r\n</service>");
                const bytes = Buffer.from(xml, "utf8");
                value.configuration.bytesBase64 = bytes.toString("base64");
                value.configuration.sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
            },
            value => { value.configuration.sha256 = "e".repeat(64); },
            value => { value.endpoints[3].ownerPid = 100; },
            value => { value.endpoints[0].address = "0.0.0.0"; },
            value => { value.winswSha256 = "f".repeat(64); }
        ]) {
            const value = probe(); mutate(value);
            reject("ValidateProbe", value, /probe|LocalSystem|parent|environment|forbidden|endpoint|WinSW/i);
        }
    });

    powershellIt("accepts normal teardown only when it precedes adapter restoration", () => {
        const assessment = run("AssessRecovery", recovery(false));
        assert.equal(assessment.accepted, true);
        assert.equal(assessment.qualifying, false);
        assert.equal(assessment.emergencyRestore, false);
        const reversed = recovery(false);
        reversed.phaseOrder = ["restoreAdapters", "teardownService", "disarmRecovery", "restoreEnvironment"];
        reject("AssessRecovery", reversed, /teardown|order|recovery/i);
    });

    powershellIt("always classifies deadline restoration as inconclusive", () => {
        const assessment = run("AssessRecovery", recovery(true));
        assert.equal(assessment.accepted, false);
        assert.equal(assessment.classification, "inconclusive");
        assert.equal(assessment.serviceTeardownProven, false);
        const forged = recovery(true);
        forged.classification = "completed";
        reject("AssessRecovery", forged, /emergency|inconclusive|recovery/i);

        const missingCleanup = recovery(false);
        missingCleanup.cleanupAfterReconnectProven = false;
        reject("AssessRecovery", missingCleanup, /cleanup|recovery/i);
    });

    powershellIt("forbids normal restoration at the watchdog deadline and requires emergency evidence persistence", () => {
        assert.equal(run("TestRecoveryRace", {
            current100ns: "699999999", deadline100ns: "700000000",
            emergencyResultPresent: false, adapterRestored: true, resultWritten: true
        }).accepted, true);
        for (const mutate of [
            value => { value.current100ns = value.deadline100ns; },
            value => { value.emergencyResultPresent = true; },
            value => { value.resultWritten = false; }
        ]) {
            const value = {current100ns: "699999999", deadline100ns: "700000000",
                emergencyResultPresent: false, adapterRestored: true, resultWritten: true};
            mutate(value);
            reject("TestRecoveryRace", value, /deadline|emergency|record|restoration/i);
        }
        const source = fs.readFileSync(SCRIPT, "utf8");
        const restore = source.slice(source.indexOf("$restore={"), source.indexOf("}.GetNewClosure()", source.indexOf("$restore={")));
        assert.ok(restore.lastIndexOf("& $getClock") > restore.indexOf("Enable-NetAdapter"));
        assert.ok(restore.lastIndexOf("& $assertRestoreWindow") < restore.indexOf("request.cancelPath"));
    });

    powershellIt("injected normal lifecycle tears down before restoring adapters", () => {
        const result = run("TestLifecycle",
            {failAt: null, emergencyRestoreSucceeded: true, emergencyCleanupSucceeded: true});
        assert.equal(result.status, "completed");
        assert.equal(result.canaryPassed, true);
        assert.ok(result.events.indexOf("teardownService") < result.events.indexOf("restoreAdapters"));
        assert.equal(result.recovery.emergencyRestore, false);
    });

    powershellIt("injected failures after disable use emergency restore and never pass", () => {
        for (const failAt of [
            "disableAdapters", "verifyOffline", "startService", "probe", "teardownService", "restoreAdapters"
        ]) {
            const result = run("TestLifecycle",
                {failAt, emergencyRestoreSucceeded: true, emergencyCleanupSucceeded: true});
            assert.equal(result.status, "failed");
            assert.equal(result.canaryPassed, false);
            assert.equal(result.recovery.classification, "inconclusive");
            assert.equal(result.recovery.emergencyRestore, true);
            assert.equal(result.recovery.serviceTeardownProven, false);
            assert.ok(result.events.includes("postReconnectCleanup"));
        }
    });

    powershellIt("injected failures at every phase always run exact-owned post-reconnect cleanup", () => {
        const beforeDisable = run("TestLifecycle",
            {failAt: "prepare", emergencyRestoreSucceeded: true, emergencyCleanupSucceeded: true});
        assert.equal(beforeDisable.status, "failed");
        assert.equal(beforeDisable.recovery.classification, "inconclusive");
        assert.equal(beforeDisable.events.includes("emergencyRestore"), false);
        assert.equal(beforeDisable.events.at(-1), "postReconnectCleanup");

        for (const failAt of ["snapshot", "armRecovery", "disarmRecovery", "restoreEnvironment"]) {
            const result = run("TestLifecycle",
                {failAt, emergencyRestoreSucceeded: true, emergencyCleanupSucceeded: true});
            assert.equal(result.status, "failed");
            assert.equal(result.events.at(-1), "postReconnectCleanup");
            assert.equal(result.canaryPassed, false);
        }

        const cleanupFailure = run("TestLifecycle",
            {failAt: "probe", emergencyRestoreSucceeded: true, emergencyCleanupSucceeded: false});
        assert.equal(cleanupFailure.canaryPassed, false);
        assert.equal(cleanupFailure.recovery.cleanupAfterReconnectProven, false);
        assert.equal(cleanupFailure.recovery.recoveryTaskGoneProven, false);
        assert.ok(cleanupFailure.failures.some(value => value.includes("post-reconnect cleanup")));

        const restoreFailure = run("TestLifecycle",
            {failAt: "probe", emergencyRestoreSucceeded: false, emergencyCleanupSucceeded: true});
        assert.equal(restoreFailure.recovery.adapterRestoreProven, false);
        assert.equal(restoreFailure.recovery.classification, "inconclusive");
        assert.ok(restoreFailure.failures.some(value => value.includes("emergency restoration")));
    });

    powershellIt("exercises the actual controller phase contract through injected operations", () => {
        const result = run("TestNativeController", {failAt: null, cleanupFails: false});
        assert.equal(result.status, "completed");
        assert.equal(result.qualifying, false);
        assert.deepEqual(result.events, [
            "prepare", "armRecovery", "disableAdapters", "verifyOffline", "startService", "probe",
            "teardownService", "restoreAdapters", "disarmRecovery", "restoreEnvironment"
        ]);
        const failed = run("TestNativeController", {failAt: "disableAdapters", cleanupFails: false});
        assert.equal(failed.status, "failed");
        assert.equal(failed.qualifying, false);
        assert.deepEqual(failed.events.slice(-2), ["emergencyRestore", "postReconnectCleanup"]);
        assert.equal(failed.recovery.emergencyRestore, true);

        const cleanupFailed = run("TestNativeController", {failAt: "probe", cleanupFails: true});
        assert.equal(cleanupFailed.status, "failed");
        assert.equal(cleanupFailed.recovery.cleanupAfterReconnectProven, false);
        assert.ok(cleanupFailed.failures.some(value => value.includes("postReconnectCleanup")));

        for (const failAt of ["prepare", "armRecovery", "startService"]) {
            const early = run("TestNativeController", {failAt, cleanupFails: false});
            assert.equal(early.status, "failed");
            assert.equal(early.boundary, null);
            assert.equal(early.probe, null);
            assert.equal(early.build.sourceSha256, null);
            assert.equal(early.qualifying, false);
        }
    });

    powershellIt("rejects every local native entry before any native adapter", () => {
        const local = hostedContext();
        local.environment = {...process.env};
        reject("InvokeHostedCanary", local, /hosted context/i);
        reject("InvokePostReconnect", local, /hosted context/i);
        const restoration = invoke("InvokeRestorationOnly", {});
        assert.notEqual(restoration.status, 0);
        assert.match(`${restoration.stdout}\n${restoration.stderr}`, /request|path|SHA/i);
    });
});
