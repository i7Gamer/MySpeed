import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {describe, it} from "node:test";

import {
    createHostedStage3Operations,
    renderBaselineAutounattend,
    renderBaselineGuestBootstrap
} from "../../scripts/qualification/linux-windows-cpu-floor-stage3-hosted.mjs";
import {renderGuestBootstrap} from "../../scripts/qualification/linux-windows-cpu-floor-stage2.mjs";

const NONCE = "2".repeat(32);
const SHA = character => character.repeat(64);
const ROOT = `/home/runner/work/_temp/myspeed-stage3-${NONCE}`;
const PORTABLE_ROOT = `/tmp/myspeed-windows-cpu-floor-tools-${NONCE}`;
const context = () => ({schemaVersion: 1, repository: "i7Gamer/MySpeed", sourceSha: "1".repeat(40),
    eventSha: "3".repeat(40), runId: "123", runAttempt: "1", nonce: NONCE, environment: {
        GITHUB_ACTIONS: "true", CI: "true", RUNNER_OS: "Linux", RUNNER_ARCH: "X64",
        RUNNER_ENVIRONMENT: "github-hosted", ImageOS: "ubuntu24", ImageVersion: "20260901.1"}});
const paths = () => ({root: ROOT, systemDisk: `${ROOT}/stage3.qcow2`, seedIso: `${ROOT}/baseline-seed.iso`,
    outputDisk: `${ROOT}/baseline-output.img`, ovmfVars: `${ROOT}/OVMF_VARS.fd`,
    qemuPid: `${ROOT}/baseline-qemu.pid`, serialLog: `${ROOT}/baseline-serial.log`});
const record = (name, character, bytes = "4096") => ({name, path: `${ROOT}/candidate/${name}`, bytes,
    sha256: SHA(character)});
const PROBE_NAMES = ["avx.exe", "avx2.exe", "cpuid.exe", "illegal.exe", "known_bad.exe", "known_good.exe",
    "popcnt.exe", "sse42.exe"];
const guestFiles = () => [record("node.exe", "6", "52428800"), record("request.json", "7"),
    record("execution.json", "8"), record("fixture-bundle.json", "9"), record("guest-runtime.json", "a"),
    record("runtime-installer.ps1", "b"), ...PROBE_NAMES.map((name, index) => record(name, String(index + 1)))];
const candidate = () => ({
    artifactId: "563103679",
    artifactName: "MySpeed-windows-x64-baseline.exe",
    releaseAssetId: "563103679",
    releaseAssetDigest: `sha256:${SHA("2")}`,
    archive: {bytes: "1048576", sha256: SHA("1")},
    sourceSha: "4".repeat(40),
    runId: "34829932391",
    runAttempt: "1",
    tagName: "v1.6.1",
    file: {name: "MySpeed.exe", bytes: "524288", sha256: SHA("2")},
    qualificationSummary: {name: "qualification-summary.json", bytes: "8192", sha256: SHA("3")},
    manifest: {name: "qualification-manifest.json", bytes: "65536", sha256: SHA("4")}});
const rootOwnership = () => ({uid: "0", gid: "0", mode: "555", ordinaryUserWritable: false});
const toolchain = () => ({runtime: {loader: {path: `${PORTABLE_ROOT}/usr/lib/ld-linux.so.2`, bytes: "4096",
    sha256: SHA("c"), ownership: rootOwnership()},
    libraryPath: [`${PORTABLE_ROOT}/usr/lib`]}, qemu: {path: `${PORTABLE_ROOT}/usr/bin/qemu-system-x86_64`,
    invocationPath: `${PORTABLE_ROOT}/usr/bin/qemu-system-x86_64`, bytes: "4096", sha256: SHA("f"),
    ownership: rootOwnership()},
    firmware: {searchPath: `${PORTABLE_ROOT}/usr/share/qemu`,
        kvmvapic: {path: `${PORTABLE_ROOT}/usr/share/qemu/kvmvapic.bin`, bytes: "4096", sha256: SHA("e"), ownership: rootOwnership()},
        vga: {path: `${PORTABLE_ROOT}/usr/share/seabios/vgabios-stdvga.bin`, bytes: "4096", sha256: SHA("e"), ownership: rootOwnership()}},
    mcopy: {path: `${PORTABLE_ROOT}/usr/bin/mtools`, invocationPath: `${PORTABLE_ROOT}/usr/bin/mcopy`, bytes: "4096",
        sha256: SHA("d"), ownership: rootOwnership()}});
const stage2 = () => ({privilegeMode: "reviewed-sudo-kvm", toolchain: toolchain(),
    selectedImage: {name: "Windows Server 2025 SERVERSTANDARD"}});
const processProof = () => ({exitCode: 0, signal: null, timedOut: false, cleanupProven: true, treeGone: true,
    qemuPid: 100, qemuStartTicks: "10", processGroupId: 100, qemuPidAbsentAfter: true,
    launcherExecutablePath: toolchain().runtime.loader.path, terminationReason: null});
const processObservation = {exitCode: 0, signal: null, timedOut: false, cleanupProven: true,
    errorObserved: false, stdoutOverflow: false, stderrOverflow: false};
const POWERSHELL_TEST_TIMEOUT_MILLISECONDS = 20_000;
const BASELINE_RESULT_FILE_NAME = "baseline-result.json";

function fixture(overrides = {}) {
    const calls = [];
    const files = new Map([
        [`${ROOT}/candidate/MySpeed.exe`, {path: `${ROOT}/candidate/MySpeed.exe`, bytes: "524288", sha256: SHA("2")}],
        [`${ROOT}/candidate/qualification-summary.json`, {path: `${ROOT}/candidate/qualification-summary.json`,
            bytes: "8192", sha256: SHA("3")}],
        [`${ROOT}/candidate/qualification-manifest.json`, {path: `${ROOT}/candidate/qualification-manifest.json`,
            bytes: "65536", sha256: SHA("4")}],
        ...guestFiles().map(({name: _name, path: target, bytes, sha256}) => [target, {path: target, bytes, sha256}]),
        [`${ROOT}/OVMF_VARS.fd`, {path: `${ROOT}/OVMF_VARS.fd`, bytes: "540672", sha256: SHA("6")}],
        [toolchain().runtime.loader.path, toolchain().runtime.loader],
        [toolchain().mcopy.path, toolchain().mcopy]
    ]);
    const stage2ResultIdentity = {path: `/home/runner/work/_temp/myspeed-stage2-transport-${NONCE}/stage2-result.json`,
        bytes: "65536", sha256: SHA("7")};
    const stage2Guest = {schemaVersion: 1, nonce: NONCE, runs: [], network: {hardwareNics: 0,
        enabledNonLoopbackInterfaces: 0, nonLoopbackRoutes: 0}};
    const stage2GuestBytes = Buffer.from(`${JSON.stringify(stage2Guest)}\n`, "utf8");
    const stage2GuestResultIdentity = {
        path: `/home/runner/work/_temp/myspeed-stage2-transport-${NONCE}/guest-result.json`,
        bytes: String(stage2GuestBytes.length), sha256: crypto.createHash("sha256").update(stage2GuestBytes).digest("hex")};
    const baseline = {schemaVersion: 1, status: "observed"};
    const baselineBytes = Buffer.from(`${JSON.stringify(baseline)}\n`, "utf8");
    const baselineIdentity = {path: `${ROOT}/baseline-result.json`, bytes: String(baselineBytes.length),
        sha256: crypto.createHash("sha256").update(baselineBytes).digest("hex")};
    const dependencies = {
        deriveActualContext: () => context(),
        inspectFile: target => {
            calls.push(["inspect", target]);
            if (!files.has(target)) throw new Error(`unexpected inspect ${target}`);
            return files.get(target);
        },
        readJson: target => {
            calls.push(["read", target]);
            if (target === stage2ResultIdentity.path) return {identity: stage2ResultIdentity, value: stage2()};
            if (target === stage2GuestResultIdentity.path) return {identity: stage2GuestResultIdentity,
                bytesBase64: stage2GuestBytes.toString("base64"), value: stage2Guest};
            if (target === `${ROOT}/baseline-result.json`) return {identity: baselineIdentity,
                bytesBase64: baselineBytes.toString("base64"), value: baseline};
            throw new Error(`unexpected read ${target}`);
        },
        pathExists: () => false,
        runOwned: async (command, argv, options) => { calls.push(["run", command, argv, options]);
            return {process: processObservation, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)}; },
        stage2Factory: input => { calls.push(["factory", input]); return {
            async prepareOfflineMedia(request) { calls.push(["media", request]); return {
                seedIso: {path: paths().seedIso, bytes: "8192", sha256: SHA("9")},
                outputDisk: {path: paths().outputDisk, bytes: "67108864", sha256: SHA("a")},
                systemDisk: {path: paths().systemDisk, bytes: "8192", sha256: SHA("b"),
                    virtualBytes: "51539607552"}, ovmfVars: {path: paths().ovmfVars, sha256: SHA("6")}}; },
            async launchOwnedQemu(request) { calls.push(["launch", request]); return {argv: request.argv,
                process: processProof(), guest: {schemaVersion: 1, status: "observed",
                    output: {path: paths().outputDisk, bytes: "67108864", sha256: SHA("a")}}}; }
        }; },
        ...overrides
    };
    const operations = createHostedStage3Operations({context: context(), paths: paths(),
        guestFiles: guestFiles(), dependencies});
    return {operations, calls, stage2ResultIdentity, stage2GuestResultIdentity, stage2GuestBytes, baseline};
}

describe("hosted Windows CPU-floor Stage 3 operations", () => {
    it("rejects a copied context before inspecting any file", () => {
        let inspected = false;
        assert.throws(() => createHostedStage3Operations({context: context(), paths: paths(),
            guestFiles: guestFiles(), dependencies: {
                deriveActualContext: () => ({...context(), runAttempt: "2"}), inspectFile: () => { inspected = true; }
            }}), /actual hosted context/u);
        assert.equal(inspected, false);
    });

    it("requires the exact closed guest seed inventory before creating native operations", () => {
        let created = false;
        const identities = new Map(guestFiles().map(record => [record.path, record]));
        assert.throws(() => createHostedStage3Operations({context: context(), paths: paths(),
            guestFiles: guestFiles().filter(record => record.name !== "avx2.exe"), dependencies: {
                deriveActualContext: () => context(), inspectFile: target => identities.get(target),
                stage2Factory: () => { created = true; return {}; }
            }}), /guest closure file set/u);
        assert.equal(created, false);
        const extra = record("unexpected.exe", "f");
        identities.set(extra.path, extra);
        assert.throws(() => createHostedStage3Operations({context: context(), paths: paths(),
            guestFiles: [...guestFiles(), extra], dependencies: {
                deriveActualContext: () => context(), inspectFile: target => identities.get(target)
            }}), /guest closure file set/u);
    });

    it("replays exact Stage 2 bytes and stages exact candidate and guest files", async () => {
        const value = fixture();
        const replay = await value.operations.replayStage2({identity: value.stage2ResultIdentity,
            guestIdentity: value.stage2GuestResultIdentity});
        assert.deepEqual(replay, {identity: value.stage2ResultIdentity, result: stage2(), guestEvidence: {
            identity: value.stage2GuestResultIdentity, bytesBase64: value.stage2GuestBytes.toString("base64")}});
        const acquired = await value.operations.acquireCandidate({candidate: candidate()});
        assert.equal(acquired.stagedFile.path, `${ROOT}/candidate/MySpeed.exe`);
        assert.equal(acquired.stagedManifest.sha256, candidate().manifest.sha256);
    });

    it("rejects a raw Stage 2 guest identity that differs from the retained file", async () => {
        const value = fixture();
        await assert.rejects(value.operations.replayStage2({identity: value.stage2ResultIdentity,
            guestIdentity: {...value.stage2GuestResultIdentity, sha256: SHA("8")}}),
        /raw guest result identity differs/u);
    });

    it("reuses reviewed Stage 2 media and QEMU operations then extracts only after launch returns", async () => {
        const value = fixture();
        await value.operations.replayStage2({identity: value.stage2ResultIdentity,
            guestIdentity: value.stage2GuestResultIdentity});
        const acquired = await value.operations.acquireCandidate({candidate: candidate()});
        const media = await value.operations.prepareBaselineMedia({candidate: acquired, paths: paths(), stage2: stage2(),
            toolchain: toolchain()});
        assert.equal(media.systemDisk.virtualBytes, "51539607552");
        const mediaRequest = value.calls.find(call => call[0] === "media")[1];
        const seededNames = mediaRequest.seedSpec.files.map(file => file.name);
        assert.ok(["execution.json", "fixture-bundle.json", "guest-runtime.json", "runtime-installer.ps1"]
            .every(name => seededNames.includes(name)));
        const bootstrapRecord = mediaRequest.seedSpec.files.find(file => file.name === "bootstrap.ps1");
        const bootstrap = Buffer.from(bootstrapRecord.bytesBase64, "base64").toString("utf8");
        assert.match(bootstrap, /Install-MyspeedBaselineRuntimeBundle/u);
        assert.match(bootstrap, /windows-baseline-guest-executor\.mjs/u);
        assert.doesNotMatch(bootstrap, /baseline-guest-runner\.mjs/u);
        const launch = await value.operations.launchBaselineGuest({argv: ["-nic", "none"], paths: paths(),
            stage2: stage2(), toolchain: toolchain()});
        assert.equal(launch.process.treeGone, true);
        const result = await value.operations.collectBaselineGuestResult({outputDisk: launch.outputDisk});
        assert.deepEqual(result, {identity: {path: `${ROOT}/baseline-result.json`,
            bytes: String(Buffer.byteLength(`${JSON.stringify(value.baseline)}\n`)),
            sha256: crypto.createHash("sha256").update(`${JSON.stringify(value.baseline)}\n`).digest("hex")},
        bytesBase64: Buffer.from(`${JSON.stringify(value.baseline)}\n`).toString("base64"), result: value.baseline,
        sourceOutputDisk: launch.outputDisk});
        const names = value.calls.map(call => call[0]);
        assert.ok(names.indexOf("launch") < names.indexOf("run"));
        const extraction = value.calls.find(call => call[0] === "run");
        assert.deepEqual(extraction[2].slice(-5), [toolchain().mcopy.path, "-i", paths().outputDisk,
            "::baseline-result.json", `${ROOT}/baseline-result.json`]);
    });

    it("passes raw QEMU arguments once through the actual Stage 2 factory", async () => {
        const monitored = [];
        const value = fixture({stage2Factory: undefined, native: {
            monotonicMilliseconds: () => 1,
            inspectDirectory: target => ({path: target, uid: "0", gid: "0", mode: target === "/tmp" ? "1777" : "755",
                sticky: target === "/tmp", ordinaryUserWritable: false}),
            inspectOwned: target => {
                if (target === toolchain().runtime.loader.path) return toolchain().runtime.loader;
                if (target === toolchain().qemu.path) return {...toolchain().qemu, bytes: "4096", sha256: SHA("f"),
                    ownership: rootOwnership()};
                return {path: target, bytes: "4096", sha256: SHA("e"), ownership: rootOwnership()};
            },
            runMonitoredQemu: async request => { monitored.push(request); return {observation: {process: {
                ...processObservation}, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)}, identity: {pid: 100, startTicks: "10", processGroupId: 100,
                executablePath: toolchain().runtime.loader.path}, absentAfter: true, processGroupGone: true,
            terminationReason: null}; },
            runOwned: async () => ({process: processObservation, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)}),
            readOwnedVerified: () => ({bytes: Buffer.from(JSON.stringify({schemaVersion: 1, status: "failed",
                nonce: NONCE, stage: "test", failure: "expected"}))}), pathExists: () => false
        }});
        await value.operations.replayStage2({identity: value.stage2ResultIdentity,
            guestIdentity: value.stage2GuestResultIdentity});
        const raw = ["-nodefaults", "-nic", "none"];
        await assert.rejects(value.operations.launchBaselineGuest({argv: raw, paths: paths(), stage2: stage2(),
            toolchain: toolchain()}), /did not return/u);
        assert.equal(monitored.length, 1);
        assert.deepEqual(monitored[0].argv.slice(0, 10), ["-n", "--", "/usr/bin/timeout", "--foreground",
            "--signal=KILL", "16200s", toolchain().runtime.loader.path, "--argv0",
            toolchain().qemu.invocationPath, "--library-path"]);
        assert.deepEqual(monitored[0].argv.slice(-raw.length), raw);
        assert.equal(monitored[0].argv.filter(value => value === "--argv0").length, 1);
    });

    it("seals exact unattended/bootstrap files and emits a Stage 2-compatible failure", () => {
        const unattend = renderBaselineAutounattend({name: "Windows Server 2025 SERVERSTANDARD"}, NONCE)
            .toString("utf8");
        assert.match(unattend, /<Key>\/IMAGE\/NAME<\/Key><Value>Windows Server 2025 SERVERSTANDARD<\/Value>/u);
        assert.doesNotMatch(unattend, /wcm:keyValue|<Key>\/IMAGE\/INDEX<\/Key>/u);
        const bootstrap = renderBaselineGuestBootstrap(NONCE).toString("utf8");
        assert.match(bootstrap, /status='failed';nonce=\$EXPECTED_NONCE;stage='guest-bootstrap'/u);
        assert.match(bootstrap, /\$null=\$process\.Handle;if\(-not \$process\.WaitForExit/u);
        assert.match(bootstrap, /\$BASELINE_MAX_STREAM_BYTES=4194304/u);
        assert.doesNotMatch(bootstrap, /Length -gt \$MAX_STREAM_BYTES/u);
        const baselinePublication = `(Join-Path $outputRoot '${BASELINE_RESULT_FILE_NAME}')`;
        const cpuPublication = "(Join-Path $outputRoot 'result.json')";
        assert.ok(bootstrap.indexOf("SetErrorMode $previousMode") < bootstrap.indexOf(baselinePublication));
        assert.ok(bootstrap.indexOf(baselinePublication) < bootstrap.indexOf(cpuPublication));
        assert.equal((bootstrap.match(/Stop-Computer -Force/gu) ?? []).length, 1);
    });

    it("runs the rendered bootstrap with injected process and CPU operations", {skip: process.platform !== "win32"}, () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-stage3-bootstrap-"));
        const script = path.join(root, "bootstrap.ps1");
        const cpuScript = path.join(root, "cpu-calibration.ps1");
        fs.writeFileSync(script, renderBaselineGuestBootstrap(NONCE));
        fs.writeFileSync(cpuScript, renderGuestBootstrap(context()));
        const escapedRoot = root.replaceAll("'", "''");
        const escapedScript = script.replaceAll("'", "''");
        const harness = `$ErrorActionPreference='Stop';$global:events=[Collections.Generic.List[string]]::new();` +
            `$global:restoreFails=$false;$global:testRoot='${escapedRoot}';` +
            `function global:Get-Volume{param($FileSystemLabel)$global:events.Add('volume:'+$FileSystemLabel);` +
            `[pscustomobject]@{DriveLetter='Z'}};function global:Join-Path{param($Path,$ChildPath)` +
            `[IO.Path]::Combine($global:testRoot,[IO.Path]::GetFileName([string]$ChildPath))};` +
            `function global:Start-Process{param($FilePath,$ArgumentList,[switch]$NoNewWindow,[switch]$PassThru,` +
            `$RedirectStandardOutput,$RedirectStandardError);$global:events.Add('start');` +
            `[IO.File]::WriteAllBytes($RedirectStandardOutput,[byte[]]@());` +
            `[IO.File]::WriteAllBytes($RedirectStandardError,[byte[]]@());` +
            `$resultPath=$ArgumentList[$ArgumentList.Count-1];[IO.File]::WriteAllText($resultPath,` +
            `'${JSON.stringify({schemaVersion: 1, status: "observed"}).replaceAll("'", "''")}');` +
            `$p=[pscustomobject]@{};$p|Add-Member ScriptProperty Handle {$global:events.Add('handle');1};` +
            `$p|Add-Member ScriptMethod WaitForExit {param([int]$Milliseconds)$global:events.Add('wait');$true};` +
            `$p|Add-Member ScriptProperty ExitCode {$global:events.Add('exit');0};` +
            `$p|Add-Member ScriptMethod Kill {};$p|Add-Member ScriptMethod Dispose {$global:events.Add('dispose')};$p};` +
            `. '${escapedScript}' -LibraryMode;$ops=@{SetErrorMode={param([uint32]$Mode)$global:events.Add('mode:'+$Mode);` +
            `if($global:restoreFails -and $Mode -ne 3){throw 'restore failed'};if($Mode -eq 3){return [uint32]77};` +
            `return [uint32]3};CollectEvidence={param($Seed)$global:events.Add('cpu');` +
            `[ordered]@{schemaVersion=1;status='observed'}}};` +
            `$loader={param($Path). $Path -LibraryMode;return $ops}.GetNewClosure();` +
            `function global:Write-MyspeedExclusive{param($Path,[byte[]]$Bytes)` +
            `$global:events.Add('write:'+[IO.Path]::GetFileName($Path));$global:lastBytes=$Bytes};` +
            `Invoke-MyspeedBaselineGuest -Shutdown {$global:events.Add('shutdown')} -LoadCpuOperations $loader;` +
            `$global:restoreFails=$true;try{Invoke-MyspeedBaselineGuest -Shutdown {$global:events.Add('shutdown2')} ` +
            `-LoadCpuOperations $loader}` +
            `catch{$global:events.Add('caught')};$failure=[Text.Encoding]::UTF8.GetString($global:lastBytes)|ConvertFrom-Json;` +
            `[Console]::Out.Write(([ordered]@{events=@($global:events);failure=$failure}|ConvertTo-Json -Compress -Depth 5))`;
        try {
            const result = spawnSync("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
                ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", harness],
                {encoding: "utf8", timeout: POWERSHELL_TEST_TIMEOUT_MILLISECONDS});
            assert.equal(result.status, 0, result.stderr);
            const observed = JSON.parse(result.stdout);
            assert.deepEqual(observed.events.slice(0, 11), ["volume:MYSPEEDSEED", "volume:MYSPEEDOUT", "mode:3", "cpu",
                "start", "handle", "wait", "exit", "dispose", "mode:77", "write:baseline-result.json"]);
            assert.ok(observed.events.indexOf("write:baseline-result.json") < observed.events.indexOf("write:result.json"));
            assert.ok(observed.events.indexOf("mode:77") < observed.events.indexOf("write:baseline-result.json"));
            assert.equal(observed.events.at(-2), "shutdown2");
            assert.equal(observed.events.at(-1), "caught");
            assert.deepEqual(observed.failure, {schemaVersion: 1, status: "failed", nonce: NONCE,
                stage: "guest-bootstrap", failure: "restore failed"});
        } finally { fs.rmSync(root, {recursive: true, force: true}); }
    });

    it("does not extract output before replaying the Stage 2 toolchain", async () => {
        const value = fixture();
        await assert.rejects(value.operations.collectBaselineGuestResult({outputDisk: {path: paths().outputDisk}}),
            /not replayed/u);
        assert.equal(value.calls.some(call => call[0] === "run"), false);
    });

    it("does not extract output until the exact launched QEMU group is gone", async () => {
        const value = fixture();
        await value.operations.replayStage2({identity: value.stage2ResultIdentity,
            guestIdentity: value.stage2GuestResultIdentity});
        await assert.rejects(value.operations.collectBaselineGuestResult({outputDisk: {path: paths().outputDisk}}),
            /QEMU cleanup was not proven/u);
        const failed = fixture({stage2Factory: _input => ({
            async prepareOfflineMedia() { throw new Error("not used"); },
            async launchOwnedQemu(request) { return {argv: request.argv, process: {...processProof(), treeGone: false},
                guest: {status: "observed", output: {path: paths().outputDisk, bytes: "67108864", sha256: SHA("a")}}}; }
        })});
        await failed.operations.replayStage2({identity: failed.stage2ResultIdentity,
            guestIdentity: failed.stage2GuestResultIdentity});
        await assert.rejects(failed.operations.launchBaselineGuest({argv: ["-nic", "none"], paths: paths(),
            stage2: stage2(), toolchain: toolchain()}), /QEMU cleanup was not proven/u);
        assert.equal(value.calls.some(call => call[0] === "run"), false);
    });
});
