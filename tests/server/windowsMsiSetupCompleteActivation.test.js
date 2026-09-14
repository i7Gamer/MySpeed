import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {describe, it} from "node:test";

import {buildWindowsMsiSetupCompleteActivation, createWindowsBaselineCpuHandoff,
    createWindowsBaseCalibrationHandoff, createWindowsMsiSetupCompleteHandoff,
    getCompletedWindowsMsiActivationEvidence} from
    "../../scripts/qualification/windows-msi-post-setup-activation.mjs";

const CONTEXT = Object.freeze({repository: "i7Gamer/MySpeed", sourceSha: "a".repeat(40),
    eventSha: "a".repeat(40), runId: "40000000001", runAttempt: "1", nonce: "b".repeat(32)});
const BOOTSTRAP = Object.freeze({name: "bootstrap.ps1", bytes: 32_000, sha256: "c".repeat(64)});
const text = document => Buffer.from(document.bytesBase64, "base64").toString("utf8");
const POWERSHELL = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
const PROCESS_TIMEOUT_MILLISECONDS = 30_000;
const powershellIt = process.platform === "win32" ? it : it.skip;

const invokeInjectedWorker = body => {
    const source = Buffer.from(text(buildWindowsMsiSetupCompleteActivation(CONTEXT).files.dispatcher), "utf8")
        .toString("base64");
    const program = `$s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${source}'));` +
        `. ([scriptblock]::Create($s)) -LibraryMode;${body}`;
    return spawnSync(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", program],
        {encoding: "utf8", timeout: PROCESS_TIMEOUT_MILLISECONDS});
};

describe("post-specialize MSI SetupComplete activation", () => {
    it("builds a closed specialize installer and post-setup dispatcher with no arbitrary command surface", () => {
        const value = buildWindowsMsiSetupCompleteActivation(CONTEXT);
        assert.equal(value.state, "specialize-installer-prepared");
        assert.equal(value.setupCompleted, false);
        assert.equal(value.nativeMsiExecutionStarted, false);
        assert.deepEqual(Object.keys(value.files), ["setupComplete", "dispatcher"]);
        assert.equal(value.seedInstaller.name, "install-activation.ps1");
        assert.equal(value.files.setupComplete.path, "C:\\Windows\\Setup\\Scripts\\SetupComplete.cmd");
        assert.equal(value.files.dispatcher.path,
            "C:\\Windows\\Setup\\Scripts\\myspeed-msi-setupcomplete.ps1");
        const command = text(value.files.setupComplete);
        assert.match(command, /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe/u);
        assert.match(command, /myspeed-msi-setupcomplete\.ps1/u);
        assert.doesNotMatch(command, /MYSPEEDSEED|bootstrap\.ps1|%\*|cmd \/c/iu);
        const installer = text(value.seedInstaller);
        assert.match(installer, /MYSPEEDSEED/u);
        assert.match(installer, /FileMode\]::CreateNew/u);
        assert.match(installer, new RegExp(value.files.setupComplete.sha256, "u"));
        assert.match(installer, new RegExp(value.files.dispatcher.sha256, "u"));
        assert.doesNotMatch(installer, /Stop-Computer|shutdown|CollectEvidence|\.exe'/iu);
        const dispatcher = text(value.files.dispatcher);
        assert.match(dispatcher, /Get-Volume -FileSystemLabel 'MYSPEEDSEED'/u);
        assert.match(dispatcher, /DriveType -cne 'CD-ROM'/u);
        assert.match(dispatcher, /Get-Volume -FileSystemLabel 'MYSPEEDOUT'/u);
        assert.match(dispatcher, /myspeed-msi-handoff\.json/u);
        assert.match(dispatcher, /bootstrap\.ps1/u);
        assert.match(dispatcher, /IMAGE_STATE_COMPLETE/u);
        assert.match(dispatcher, /CurrentVersion\\Setup\\State/u);
        assert.match(dispatcher, /Setup\\State\\State\.ini/u);
        assert.ok(dispatcher.indexOf("Wait-MyspeedWindowsSetupComplete") <
            dispatcher.indexOf("Invoke-MyspeedSetupCompleteDispatch"));
        assert.match(dispatcher, /Invoke-MyspeedMsiGuestBootstrap/u);
        assert.doesNotMatch(dispatcher, /Invoke-MyspeedMsiGuestBootstrap -Shutdown \{\}|shutdown\.exe/u);
        assert.match(dispatcher, /Start-Process[^\r\n]*-WindowStyle Hidden/u);
        assert.match(dispatcher, /New-ScheduledTaskTrigger -AtStartup/u);
        assert.match(dispatcher, /MySpeedQualificationGuestDispatcher/u);
        assert.doesNotMatch(dispatcher, /Invoke-Expression|DownloadString|http:/iu);
        assert.ok(Object.isFrozen(value));
        assert.ok(Object.isFrozen(value.files.dispatcher));
    });

    powershellIt("launches only after both documented setup-state sources report completion", () => {
        const result = invokeInjectedWorker(
            `$states=[Collections.Generic.Queue[object]]::new();` +
            `$states.Enqueue([pscustomobject]@{registry='IMAGE_STATE_SPECIALIZE_RESEAL_TO_OOBE';` +
            `file='IMAGE_STATE_SPECIALIZE_RESEAL_TO_OOBE'});` +
            `$states.Enqueue([pscustomobject]@{registry='IMAGE_STATE_COMPLETE';file='IMAGE_STATE_COMPLETE'});` +
            `$events=[Collections.Generic.List[string]]::new();` +
            `$result=Invoke-MyspeedPostSetupWorker -ReadState {$states.Dequeue()} -Sleep {} ` +
            `-EnsureStartupTask {$events.Add('task');'task-ready'} ` +
            `-Dispatch {param($Activation)$events.Add('dispatch');$Activation} ` +
            `-WriteFailure {throw 'unexpected failure writer'} -MaximumPolls 2;` +
            `[ordered]@{result=$result;remaining=$states.Count;events=@($events)}|ConvertTo-Json -Compress`);
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.deepEqual(JSON.parse(result.stdout.trim()),
            {result: "task-ready", remaining: 0, events: ["task", "dispatch"]});
    });

    powershellIt("fails closed on completion timeout or inconsistent state without launching or shutdown", () => {
        for (const state of [
            "[pscustomobject]@{registry='IMAGE_STATE_SPECIALIZE_RESEAL_TO_OOBE';file='IMAGE_STATE_SPECIALIZE_RESEAL_TO_OOBE'}",
            "[pscustomobject]@{registry='IMAGE_STATE_COMPLETE';file='IMAGE_STATE_SPECIALIZE_RESEAL_TO_OOBE'}"
        ]) {
            const result = invokeInjectedWorker(
                `$script:launched=$false;$script:failure=$null;try{` +
                `Invoke-MyspeedPostSetupWorker -ReadState {${state}} -Sleep {} ` +
                `-EnsureStartupTask {$script:launched=$true} -Dispatch {$script:launched=$true} ` +
                `-WriteFailure {param($Failure)` +
                `$script:failure=$Failure.Exception.Message} -MaximumPolls 2}catch{$thrown=$_.Exception.Message};` +
                `[ordered]@{launched=$script:launched;failure=$script:failure;thrown=$thrown}|` +
                `ConvertTo-Json -Compress`);
            assert.equal(result.status, 0, result.stderr || result.stdout);
            const value = JSON.parse(result.stdout.trim());
            assert.equal(value.launched, false);
            assert.match(value.failure, /did not complete/u);
            assert.equal(value.thrown, value.failure);
        }
    });

    powershellIt("records a pre-bootstrap dispatch failure after setup completion without shutdown", () => {
        const result = invokeInjectedWorker(
            `$script:failure=$null;try{Invoke-MyspeedPostSetupWorker ` +
            `-ReadState {[pscustomobject]@{registry='IMAGE_STATE_COMPLETE';file='IMAGE_STATE_COMPLETE'}} ` +
            `-Sleep {} -EnsureStartupTask {'ready'} -Dispatch {throw 'foreign bootstrap'} ` +
            `-WriteFailure {param($Failure)` +
            `$script:failure=$Failure.Exception.Message} -MaximumPolls 1}catch{$thrown=$_.Exception.Message};` +
            `[ordered]@{failure=$script:failure;thrown=$thrown}|ConvertTo-Json -Compress`);
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.deepEqual(JSON.parse(result.stdout.trim()),
            {failure: "foreign bootstrap", thrown: "foreign bootstrap"});
    });

    powershellIt("passes the actual scheduled-task identity producer through strict dispatch validation", () => {
        const result = invokeInjectedWorker(
            `function Get-ScheduledTask {` +
            `[pscustomobject]@{Actions=@([pscustomobject]@{Execute=` +
            `'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';` +
            `Arguments='-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ` +
            `"C:\\Windows\\Setup\\Scripts\\myspeed-msi-setupcomplete.ps1" -Worker'});` +
            `Principal=[pscustomobject]@{UserId='SYSTEM';RunLevel='Highest'};` +
            `Triggers=@([pscustomobject]@{Enabled=$true;CimClass=[pscustomobject]@{` +
            `CimClassName='MSFT_TaskBootTrigger'}})}};function Get-Volume { @() };` +
            `$identity=Get-MyspeedStartupTaskIdentity;try{` +
            `Invoke-MyspeedSetupCompleteDispatch -Activation $identity}catch{$failure=$_.Exception.Message};` +
            `[ordered]@{type=$identity.GetType().FullName;failure=$failure}|ConvertTo-Json -Compress`);
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.deepEqual(JSON.parse(result.stdout.trim()),
            {type: "System.Management.Automation.PSCustomObject", failure: "MSI SetupComplete volumes differ"});
    });

    powershellIt("passes the startup-task receipt through the real default dispatch", () => {
        const result = invokeInjectedWorker(
            `function Get-Volume {param($FileSystemLabel) throw 'injected-volume-boundary'};` +
            `$activation=[pscustomobject][ordered]@{name='MySpeedQualificationGuestDispatcher';path='\\';` +
            `trigger='boot';principal='SYSTEM';runLevel='Highest';` +
            `executable='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';` +
            `arguments='-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ` +
            `"C:\\Windows\\Setup\\Scripts\\myspeed-msi-setupcomplete.ps1" -Worker'};` +
            `$script:failure=$null;try{Invoke-MyspeedPostSetupWorker ` +
            `-ReadState {[pscustomobject]@{registry='IMAGE_STATE_COMPLETE';file='IMAGE_STATE_COMPLETE'}} ` +
            `-Sleep {} -EnsureStartupTask {$activation} -WriteFailure {param($Failure)` +
            `$script:failure=$Failure.Exception.Message} -MaximumPolls 1}catch{$thrown=$_.Exception.Message};` +
            `[ordered]@{failure=$script:failure;thrown=$thrown}|ConvertTo-Json -Compress`);
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.deepEqual(JSON.parse(result.stdout.trim()),
            {failure: "injected-volume-boundary", thrown: "injected-volume-boundary"});
    });

    it("creates only a row-bound allowed handoff for the branded activation", () => {
        const activation = buildWindowsMsiSetupCompleteActivation(CONTEXT);
        const value = createWindowsMsiSetupCompleteHandoff(activation, {rowNonce: "d".repeat(32),
            scenarioIndex: 4, scenarioId: "repair-executable", bootstrap: BOOTSTRAP});
        assert.deepEqual(value, {schemaVersion: 1, kind: "myspeed-windows-msi-setupcomplete-handoff",
            host: CONTEXT, row: {nonce: "d".repeat(32), scenarioIndex: 4, scenarioId: "repair-executable"},
            bootstrap: BOOTSTRAP});
        assert.ok(Object.isFrozen(value));
        assert.throws(() => createWindowsMsiSetupCompleteHandoff(structuredClone(activation),
            {rowNonce: "d".repeat(32), scenarioIndex: 4, scenarioId: "repair-executable",
                bootstrap: BOOTSTRAP}), /activation/i);
    });

    it("creates only fixed base-calibration and baseline-CPU handoff kinds", () => {
        const activation = buildWindowsMsiSetupCompleteActivation(CONTEXT);
        const calibration = createWindowsBaseCalibrationHandoff(activation, BOOTSTRAP);
        assert.deepEqual(calibration, {schemaVersion: 1, kind: "myspeed-windows-base-calibration-handoff",
            host: CONTEXT, bootstrap: BOOTSTRAP});
        const baselineBootstrap = {...BOOTSTRAP, name: "baseline-bootstrap.ps1"};
        const baseline = createWindowsBaselineCpuHandoff(activation, baselineBootstrap);
        assert.deepEqual(baseline, {schemaVersion: 1, kind: "myspeed-windows-baseline-cpu-handoff",
            host: CONTEXT, bootstrap: baselineBootstrap});
        const complete = getCompletedWindowsMsiActivationEvidence(activation);
        assert.equal(complete.state, "windows-setup-complete-startup-dispatch-ready");
        assert.equal(complete.setupCompleted, true);
        assert.equal(complete.startupTaskInstalled, true);
        assert.equal(complete.nativeMsiExecutionStarted, false);
    });

    it("rejects foreign hosted identity and arbitrary bootstrap names, paths, hashes, or rows", () => {
        for (const mutate of [
            value => { value.sourceSha = "z".repeat(40); }, value => { value.eventSha = `${"f".repeat(40)}\n`; },
            value => { value.runId = 1; }, value => { value.nonce += "\n"; }
        ]) {
            const value = structuredClone(CONTEXT); mutate(value);
            assert.throws(() => buildWindowsMsiSetupCompleteActivation(value));
        }
        const activation = buildWindowsMsiSetupCompleteActivation(CONTEXT);
        for (const mutate of [
            value => { value.bootstrap.name = "other.ps1"; },
            value => { value.bootstrap.name = "..\\bootstrap.ps1"; },
            value => { value.bootstrap.sha256 = "f".repeat(63); },
            value => { value.bootstrap.bytes = 0; },
            value => { value.rowNonce = CONTEXT.nonce; },
            value => { value.scenarioIndex = 14; }, value => { value.scenarioId += "\n"; }
        ]) {
            const input = {rowNonce: "d".repeat(32), scenarioIndex: 4,
                scenarioId: "repair-executable", bootstrap: structuredClone(BOOTSTRAP)};
            mutate(input);
            assert.throws(() => createWindowsMsiSetupCompleteHandoff(activation, input));
        }
    });

    it("binds distinct exact source and event SHAs for reusable same-job Stage 2 bases", () => {
        const context = {...CONTEXT, eventSha: "e".repeat(40)};
        const activation = buildWindowsMsiSetupCompleteActivation(context);
        assert.equal(activation.context.sourceSha, CONTEXT.sourceSha);
        assert.equal(activation.context.eventSha, context.eventSha);
        const dispatcher = text(activation.files.dispatcher);
        assert.match(dispatcher, new RegExp(`EXPECTED_SOURCE_SHA='${CONTEXT.sourceSha}'`, "u"));
        assert.match(dispatcher, new RegExp(`EXPECTED_EVENT_SHA='${context.eventSha}'`, "u"));
    });
});
