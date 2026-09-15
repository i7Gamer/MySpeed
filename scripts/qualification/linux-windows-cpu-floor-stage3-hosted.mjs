import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {deriveActualHostedContext} from "./linux-windows-cpu-floor-stage2-controller.mjs";
import {renderGuestBootstrap} from "./linux-windows-cpu-floor-stage2.mjs";
import {
    createHostedStage2Operations,
    runHostedOwnedProcess
} from "./linux-windows-cpu-floor-stage2-hosted.mjs";
import {renderWindowsBaselineGuestBootstrap} from "./windows-baseline-guest-bootstrap.mjs";

const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_CANDIDATE_BYTES = 512 * 1024 * 1024;
const IO_CHUNK_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MILLISECONDS = 25_000;
const COMMAND_STREAM_BYTES = 1024 * 1024;
const GUEST_RUNNER_TIMEOUT_MILLISECONDS = 14_400_000;
const GUEST_RUNNER_CLEANUP_TIMEOUT_MILLISECONDS = 30_000;
const MAX_GUEST_FAILURE_MESSAGE_CHARACTERS = 512;
const BASELINE_RESULT_NAME = "baseline-result.json";
const REQUIRED_GUEST_FILES = Object.freeze(["node.exe", "request.json", "execution.json", "fixture-bundle.json",
    "guest-runtime.json", "runtime-installer.ps1", "avx.exe", "avx2.exe", "cpuid.exe", "illegal.exe",
    "known_bad.exe", "known_good.exe", "popcnt.exe", "sse42.exe"]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

function assertDirectChild(root, target, expectedName) {
    if (target !== `${root}/${expectedName}` || path.posix.dirname(target) !== root)
        throw new TypeError(`${expectedName} path is invalid`);
}

function defaultInspectFile(target, maximumBytes) {
    const descriptor = fs.openSync(target, fs.constants.O_RDONLY);
    let primary = null;
    try {
        const before = fs.fstatSync(descriptor, {bigint: true});
        if (!before.isFile() || before.size < 1n || before.size > BigInt(maximumBytes))
            throw new Error("owned input file size is invalid");
        const digest = crypto.createHash("sha256");
        const chunk = Buffer.alloc(IO_CHUNK_BYTES);
        let total = 0;
        for (;;) {
            const count = fs.readSync(descriptor, chunk, 0, chunk.length, null);
            if (count === 0) break;
            total += count;
            if (total > maximumBytes) throw new Error("owned input file exceeded its bound");
            digest.update(chunk.subarray(0, count));
        }
        const after = fs.fstatSync(descriptor, {bigint: true});
        const canonical = fs.realpathSync(`/proc/self/fd/${descriptor}`);
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
            BigInt(total) !== after.size || canonical !== target)
            throw new Error("owned input file identity changed while hashing");
        const mode = Number(before.mode & 0o777n).toString(8).padStart(3, "0");
        return {path: canonical, bytes: String(total), sha256: digest.digest("hex"), ownership: {
            uid: String(before.uid), gid: String(before.gid), mode,
            ordinaryUserWritable: (before.mode & 0o022n) !== 0n}};
    } catch (error) { primary = error; throw error; }
    finally {
        try { fs.closeSync(descriptor); }
        catch (error) { if (primary === null) throw error; }
    }
}

function defaultReadJson(target, maximumBytes = MAX_JSON_BYTES) {
    const descriptor = fs.openSync(target, fs.constants.O_RDONLY);
    let primary = null;
    try {
        const before = fs.fstatSync(descriptor, {bigint: true});
        if (!before.isFile() || before.size < 1n || before.size > BigInt(maximumBytes))
            throw new Error("JSON input file size is invalid");
        const bytes = Buffer.alloc(Number(before.size));
        let offset = 0;
        while (offset < bytes.length) {
            const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, null);
            if (count === 0) throw new Error("JSON input ended before its observed length");
            offset += count;
        }
        const after = fs.fstatSync(descriptor, {bigint: true});
        const canonical = fs.realpathSync(`/proc/self/fd/${descriptor}`);
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || canonical !== target)
            throw new Error("JSON input identity changed while reading");
        const identity = {path: canonical, bytes: String(bytes.length),
            sha256: crypto.createHash("sha256").update(bytes).digest("hex")};
        return {identity, bytesBase64: bytes.toString("base64"),
            value: JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes))};
    } catch (error) { primary = error; throw error; }
    finally {
        try { fs.closeSync(descriptor); }
        catch (error) { if (primary === null) throw error; }
    }
}

function assertIdentity(actual, expected, name) {
    if (actual.path !== expected.path || actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256)
        throw new Error(`${name} identity differs`);
    if (expected.ownership && !same(actual.ownership, expected.ownership))
        throw new Error(`${name} ownership differs`);
}

function assertProcessSucceeded(observation, name) {
    const proc = observation?.process;
    if (!proc || proc.exitCode !== 0 || proc.signal !== null || proc.timedOut !== false ||
        proc.cleanupProven !== true || proc.errorObserved !== false || proc.stdoutOverflow !== false ||
        proc.stderrOverflow !== false) throw new Error(`${name} did not complete safely`);
}

function stage2CompatiblePaths(context, stage3Paths) {
    const portableRoot = `/tmp/myspeed-windows-cpu-floor-tools-${context.nonce}`;
    return {root: stage3Paths.root, packageRoot: `${stage3Paths.root}/unused-packages`, portableRoot,
        windowsIso: `/home/runner/work/_temp/myspeed-windows-cpu-floor-${context.nonce}/windows.iso`,
        installWim: `${stage3Paths.root}/unused-install.wim`, seedIso: stage3Paths.seedIso,
        outputDisk: stage3Paths.outputDisk, systemDisk: stage3Paths.systemDisk, ovmfVars: stage3Paths.ovmfVars,
        serialLog: stage3Paths.serialLog, probeRoot: `${stage3Paths.root}/candidate`, qemuPid: stage3Paths.qemuPid};
}

function inlineSeedFile(name, bytes) {
    return {name, kind: "inline", bytes: String(bytes.length),
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"), bytesBase64: bytes.toString("base64")};
}

export function renderBaselineAutounattend(image, nonce) {
    const password = `Myspeed-Eval-${nonce.slice(0, 16)}!aA1`;
    const xml = `<?xml version="1.0" encoding="utf-8"?>\r\n<unattend xmlns="urn:schemas-microsoft-com:unattend" ` +
        `xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">\r\n` +
        `<settings pass="windowsPE"><component name="Microsoft-Windows-Setup" processorArchitecture="amd64" ` +
        `publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS"><DiskConfiguration>` +
        `<Disk wcm:action="add"><DiskID>0</DiskID><WillWipeDisk>true</WillWipeDisk><CreatePartitions>` +
        `<CreatePartition wcm:action="add"><Order>1</Order><Size>100</Size><Type>EFI</Type></CreatePartition>` +
        `<CreatePartition wcm:action="add"><Order>2</Order><Size>16</Size><Type>MSR</Type></CreatePartition>` +
        `<CreatePartition wcm:action="add"><Order>3</Order><Extend>true</Extend><Type>Primary</Type></CreatePartition>` +
        `</CreatePartitions><ModifyPartitions><ModifyPartition wcm:action="add"><Order>1</Order><PartitionID>1</PartitionID>` +
        `<Format>FAT32</Format><Label>System</Label></ModifyPartition><ModifyPartition wcm:action="add"><Order>2</Order>` +
        `<PartitionID>3</PartitionID><Format>NTFS</Format><Label>Windows</Label><Letter>C</Letter></ModifyPartition>` +
        `</ModifyPartitions></Disk></DiskConfiguration><ImageInstall><OSImage><InstallFrom>` +
        `<MetaData wcm:action="add"><Key>/IMAGE/NAME</Key><Value>${image.name}</Value></MetaData></InstallFrom>` +
        `<InstallTo><DiskID>0</DiskID><PartitionID>3</PartitionID></InstallTo></OSImage></ImageInstall>` +
        `<UserData><AcceptEula>true</AcceptEula></UserData></component></settings>\r\n` +
        `<settings pass="specialize"><component name="Microsoft-Windows-Deployment" processorArchitecture="amd64" ` +
        `publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS"><RunSynchronous>` +
        `<RunSynchronousCommand wcm:action="add"><Order>1</Order><Path>powershell.exe -NoLogo -NoProfile ` +
        `-NonInteractive -ExecutionPolicy Bypass -Command &quot;$s=(Get-Volume -FileSystemLabel MYSPEEDSEED ` +
        `-ErrorAction Stop).DriveLetter; &amp; ($s+':\\bootstrap.ps1')&quot;</Path></RunSynchronousCommand>` +
        `</RunSynchronous></component></settings>\r\n<settings pass="oobeSystem"><component ` +
        `name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" ` +
        `language="neutral" versionScope="nonSxS"><UserAccounts><AdministratorPassword><Value>${password}</Value>` +
        `<PlainText>true</PlainText></AdministratorPassword></UserAccounts></component></settings>\r\n</unattend>\r\n`;
    return Buffer.from(xml, "utf8");
}

export function renderBaselineGuestBootstrap(nonce) {
    const script = `param([switch]$LibraryMode)\r\n$ErrorActionPreference='Stop'\r\nSet-StrictMode -Version Latest\r\n` +
        `$EXPECTED_NONCE='${nonce}'\r\n$RUNNER_TIMEOUT_MILLISECONDS=${GUEST_RUNNER_TIMEOUT_MILLISECONDS}\r\n` +
        `$RUNNER_CLEANUP_TIMEOUT_MILLISECONDS=${GUEST_RUNNER_CLEANUP_TIMEOUT_MILLISECONDS}\r\n` +
        `$BASELINE_MAX_RESULT_BYTES=${MAX_JSON_BYTES}\r\n$BASELINE_MAX_STREAM_BYTES=${MAX_JSON_BYTES}\r\n` +
        `$BASELINE_MAX_FAILURE_MESSAGE_CHARACTERS=${MAX_GUEST_FAILURE_MESSAGE_CHARACTERS}\r\n` +
        `function Write-MyspeedExclusive([string]$Path,[byte[]]$Bytes){` +
        `$temporary=$Path+'.tmp';try{$stream=[IO.FileStream]::new($temporary,[IO.FileMode]::CreateNew,` +
        `[IO.FileAccess]::Write,[IO.FileShare]::None);try{$stream.Write($Bytes,0,$Bytes.Length);$stream.Flush($true)}` +
        `finally{$stream.Dispose()};$observed=[IO.File]::ReadAllBytes($temporary);if(-not ` +
        `[Collections.StructuralComparisons]::StructuralEqualityComparer.Equals($observed,$Bytes)){` +
        `throw 'Guest publication verification failed'};[IO.File]::Move($temporary,$Path)}catch{` +
        `if([IO.File]::Exists($temporary)){[IO.File]::Delete($temporary)};throw}}\r\n` +
        `function Invoke-MyspeedBaselineGuest([scriptblock]$Shutdown={Stop-Computer -Force},` +
        `[scriptblock]$LoadCpuOperations={param($Path). $Path -LibraryMode;New-MyspeedGuestNativeOperations}){` +
        `$failure=$null;$outputRoot=$null;$previousMode=[uint32]0;$modeChanged=$false;$cpu=$null;$baselineBytes=$null;` +
        `try{$seed=((Get-Volume -FileSystemLabel MYSPEEDSEED -ErrorAction Stop).DriveLetter+':\\');` +
        `$outputRoot=((Get-Volume -FileSystemLabel MYSPEEDOUT -ErrorAction Stop).DriveLetter+':\\');` +
        `$cpuOperations=& $LoadCpuOperations (Join-Path $seed 'cpu-calibration.ps1');` +
        `$previousMode=& $cpuOperations.SetErrorMode 3;if($previousMode -isnot [uint32]){throw 'Previous error mode is invalid'};` +
        `$modeChanged=$true;$cpu=& $cpuOperations.CollectEvidence $seed;` +
        `$runnerResult=Join-Path $env:SystemRoot 'Temp\\myspeed-baseline-result.json';` +
        `$stdout=Join-Path $env:SystemRoot 'Temp\\myspeed-baseline.stdout';` +
        `$stderr=Join-Path $env:SystemRoot 'Temp\\myspeed-baseline.stderr';` +
        `$process=Start-Process -FilePath (Join-Path $seed 'node.exe') -ArgumentList @(` +
        `(Join-Path $seed 'baseline-guest-runner.mjs'),'--request',(Join-Path $seed 'request.json'),'--result',` +
        `$runnerResult) -NoNewWindow -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr;` +
        `try{$null=$process.Handle;if(-not $process.WaitForExit($RUNNER_TIMEOUT_MILLISECONDS)){` +
        `$process.Kill();if(-not $process.WaitForExit($RUNNER_CLEANUP_TIMEOUT_MILLISECONDS)){` +
        `throw 'Baseline verifier cleanup exceeded its deadline'};throw 'Baseline verifier exceeded its deadline'};` +
        `$exit=$process.ExitCode;if($exit -isnot [int] -or $exit -ne 0){throw 'Baseline verifier exit is invalid'}}` +
        `finally{$process.Dispose()};$stdoutBytes=[IO.File]::ReadAllBytes($stdout);` +
        `$stderrBytes=[IO.File]::ReadAllBytes($stderr);if($stdoutBytes.Length -gt $BASELINE_MAX_STREAM_BYTES -or ` +
        `$stderrBytes.Length -gt $BASELINE_MAX_STREAM_BYTES){throw 'Baseline verifier stream exceeded its bound'};` +
        `$baselineBytes=[IO.File]::ReadAllBytes($runnerResult);if($baselineBytes.Length -lt 2 -or ` +
        `$baselineBytes.Length -gt $BASELINE_MAX_RESULT_BYTES){throw 'Baseline verifier result size is invalid'}}catch{$failure=$_}` +
        `finally{try{if($modeChanged){try{$null=& $cpuOperations.SetErrorMode $previousMode}catch{$failure=$_}};` +
        `if($null -ne $outputRoot){if($null -eq $failure){try{Write-MyspeedExclusive ` +
        `(Join-Path $outputRoot '${BASELINE_RESULT_NAME}') $baselineBytes;` +
        `$cpuBytes=[Text.UTF8Encoding]::new($false).GetBytes(($cpu|ConvertTo-Json -Compress -Depth 8));` +
        `Write-MyspeedExclusive (Join-Path $outputRoot 'result.json') $cpuBytes}catch{$failure=$_}};` +
        `if($null -ne $failure -and -not [IO.File]::Exists((Join-Path $outputRoot 'result.json'))){try{` +
        `$message=[regex]::Replace([string]$failure.Exception.Message,'[\\x00-\\x1f\\x7f]+',' ');` +
        `if($message.Length -gt $BASELINE_MAX_FAILURE_MESSAGE_CHARACTERS){` +
        `$message=$message.Substring(0,$BASELINE_MAX_FAILURE_MESSAGE_CHARACTERS)};` +
        `$failed=[ordered]@{schemaVersion=1;status='failed';nonce=$EXPECTED_NONCE;stage='guest-bootstrap';failure=$message};` +
        `$failedBytes=[Text.UTF8Encoding]::new($false).GetBytes(($failed|ConvertTo-Json -Compress -Depth 4));` +
        `Write-MyspeedExclusive (Join-Path $outputRoot 'result.json') $failedBytes}catch{}}}}finally{& $Shutdown}};` +
        `if($null -ne $failure){throw $failure}}\r\nif(-not $LibraryMode){Invoke-MyspeedBaselineGuest}\r\n`;
    return Buffer.from(script, "utf8");
}

function seedSpec(candidate, guestFiles, selectedImage, context) {
    const filesByName = new Map(guestFiles.map(record => [record.name, record]));
    const bootstrap = renderWindowsBaselineGuestBootstrap({nonce: context.nonce, sourceSha: context.sourceSha,
        requestSha256: filesByName.get("request.json").sha256,
        executionSha256: filesByName.get("execution.json").sha256,
        runtimeBundleSha256: filesByName.get("guest-runtime.json").sha256});
    const owned = [candidate.stagedFile, candidate.stagedSummary, candidate.stagedManifest, ...guestFiles].map(record => ({
        name: record.name, kind: "owned-file", bytes: record.bytes, sha256: record.sha256, sourcePath: record.path
    }));
    const files = [inlineSeedFile("Autounattend.xml", renderBaselineAutounattend(selectedImage, context.nonce)),
        inlineSeedFile("cpu-calibration.ps1", renderGuestBootstrap(context)),
        inlineSeedFile("bootstrap.ps1", bootstrap), ...owned];
    const canonical = Buffer.from(JSON.stringify(files));
    return {schemaVersion: 1, format: "iso9660", volumeLabel: "MYSPEEDSEED", files,
        sha256: crypto.createHash("sha256").update(canonical).digest("hex")};
}

function validateGuestFiles(records, candidateRoot, inspect) {
    if (!Array.isArray(records) || records.length !== REQUIRED_GUEST_FILES.length)
        throw new TypeError("guest closure file set is invalid");
    const names = new Set(["MySpeed.exe", "qualification-summary.json", "qualification-manifest.json"]);
    const checked = records.map(record => {
        if (!record || typeof record !== "object" || Array.isArray(record) ||
            JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(["bytes", "name", "path", "sha256"]))
            throw new TypeError("guest closure file record is invalid");
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(record.name) || names.has(record.name) ||
            !SHA256_PATTERN.test(record.sha256)) throw new TypeError("guest closure file identity is invalid");
        names.add(record.name);
        assertDirectChild(candidateRoot, record.path, record.name);
        const actual = inspect(record.path, MAX_CANDIDATE_BYTES);
        assertIdentity(actual, record, `guest closure ${record.name}`);
        return structuredClone(record);
    });
    if (!REQUIRED_GUEST_FILES.every(name => names.has(name)))
        throw new TypeError("required guest closure file is absent");
    return checked;
}

export function createHostedStage3Operations({context, paths, guestFiles, dependencies = {}}) {
    const actual = (dependencies.deriveActualContext ?? deriveActualHostedContext)(context.nonce);
    if (!same(actual, context)) throw new Error("actual hosted context differs from Stage 3 request");
    const inspect = dependencies.inspectFile ?? defaultInspectFile;
    const readJson = dependencies.readJson ?? defaultReadJson;
    const runOwned = dependencies.runOwned ?? runHostedOwnedProcess;
    const stage2Factory = dependencies.stage2Factory ?? createHostedStage2Operations;
    const candidateRoot = `${paths.root}/candidate`;
    const checkedGuestFiles = validateGuestFiles(guestFiles, candidateRoot, inspect);
    let adapter = null;
    let replayedStage2 = null;
    let launchCleanupProven = false;
    const getAdapter = (stage2, nativeDependencies = dependencies.native) => {
        if (adapter === null) adapter = stage2Factory({context,
            paths: stage2CompatiblePaths(context, paths),
            dependencies: nativeDependencies});
        return adapter;
    };
    return Object.freeze({
        async replayStage2({identity, guestIdentity}) {
            const observed = readJson(identity.path, MAX_JSON_BYTES);
            assertIdentity(observed.identity, identity, "Stage 2 result");
            const guest = readJson(guestIdentity.path, MAX_JSON_BYTES);
            assertIdentity(guest.identity, guestIdentity, "Stage 2 raw guest result");
            replayedStage2 = structuredClone(observed.value);
            return {identity: structuredClone(identity), result: observed.value,
                guestEvidence: {identity: structuredClone(guest.identity), bytesBase64: guest.bytesBase64}};
        },
        async acquireCandidate({candidate}) {
            const expected = [[candidate.file, "MySpeed.exe"], [candidate.qualificationSummary,
                "qualification-summary.json"], [candidate.manifest, "qualification-manifest.json"]];
            const staged = expected.map(([record, name]) => {
                const target = `${candidateRoot}/${name}`;
                const actualIdentity = inspect(target, MAX_CANDIDATE_BYTES);
                assertIdentity(actualIdentity, {...record, path: target}, `candidate ${name}`);
                return {...record, path: target};
            });
            return {candidate: structuredClone(candidate), stagedFile: staged[0], stagedSummary: staged[1],
                stagedManifest: staged[2]};
        },
        async prepareBaselineMedia({candidate, paths: inputPaths, stage2, toolchain}) {
            const compatible = stage2CompatiblePaths(context, inputPaths);
            const prepared = await getAdapter(stage2).prepareOfflineMedia({context, paths: compatible, toolchain,
                seedSpec: seedSpec(candidate, checkedGuestFiles, stage2.selectedImage, context)});
            return {seedIso: {path: prepared.seedIso.path, bytes: prepared.seedIso.bytes,
                sha256: prepared.seedIso.sha256}, outputDisk: {path: prepared.outputDisk.path,
                bytes: prepared.outputDisk.bytes, sha256: prepared.outputDisk.sha256},
            systemDisk: {path: prepared.systemDisk.path, bytes: prepared.systemDisk.bytes,
                sha256: prepared.systemDisk.sha256, virtualBytes: prepared.systemDisk.virtualBytes},
            ovmfVars: {path: prepared.ovmfVars.path, bytes: inspect(prepared.ovmfVars.path,
                MAX_CANDIDATE_BYTES).bytes, sha256: prepared.ovmfVars.sha256}};
        },
        async launchBaselineGuest({argv, paths: inputPaths, stage2, toolchain}) {
            launchCleanupProven = false;
            const compatible = stage2CompatiblePaths(context, inputPaths);
            const launch = await getAdapter(stage2).launchOwnedQemu({context, paths: compatible, toolchain, argv,
                privilegeMode: stage2.privilegeMode});
            if (!launch.guest || launch.guest.status !== "observed")
                throw new Error("baseline guest did not return the CPU calibration envelope");
            if (launch.process?.cleanupProven !== true || launch.process.treeGone !== true ||
                launch.process.qemuPidAbsentAfter !== true)
                throw new Error("baseline QEMU cleanup was not proven");
            launchCleanupProven = true;
            return {argv: structuredClone(argv), process: structuredClone(launch.process),
                outputDisk: structuredClone(launch.guest.output)};
        },
        async collectBaselineGuestResult({outputDisk}) {
            const target = `${paths.root}/${BASELINE_RESULT_NAME}`;
            assertDirectChild(paths.root, target, BASELINE_RESULT_NAME);
            if ((dependencies.pathExists ?? fs.existsSync)(target)) throw new Error("baseline result already exists");
            if (replayedStage2 === null) throw new Error("Stage 2 result was not replayed");
            if (!launchCleanupProven) throw new Error("baseline QEMU cleanup was not proven");
            const toolchain = replayedStage2.toolchain;
            assertIdentity(inspect(toolchain.runtime.loader.path, MAX_CANDIDATE_BYTES), toolchain.runtime.loader,
                "portable runtime loader");
            assertIdentity(inspect(toolchain.mcopy.path, MAX_CANDIDATE_BYTES), toolchain.mcopy, "portable mcopy");
            const invocation = {command: toolchain.runtime.loader.path, argv: ["--argv0", toolchain.mcopy.invocationPath,
                "--library-path", toolchain.runtime.libraryPath.join(":"), toolchain.mcopy.path,
                "-i", outputDisk.path, `::${BASELINE_RESULT_NAME}`, target]};
            const observation = await runOwned(invocation.command, invocation.argv,
                {timeoutMs: COMMAND_TIMEOUT_MILLISECONDS, maxStreamBytes: COMMAND_STREAM_BYTES});
            assertProcessSucceeded(observation, "baseline guest result extraction");
            const observed = readJson(target, MAX_JSON_BYTES);
            return {identity: structuredClone(observed.identity), bytesBase64: observed.bytesBase64,
                result: observed.value, sourceOutputDisk: structuredClone(outputDisk)};
        }
    });
}

export const STAGE3_HOSTED_CONSTANTS = Object.freeze({BASELINE_RESULT_NAME, COMMAND_TIMEOUT_MILLISECONDS,
    MAX_CANDIDATE_BYTES, MAX_JSON_BYTES});
