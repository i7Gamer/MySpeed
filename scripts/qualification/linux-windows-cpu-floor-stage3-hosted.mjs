import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {deriveActualHostedContext} from "./linux-windows-cpu-floor-stage2-controller.mjs";
import {PROBE_SEED_FILES, WINDOWS_PE_INTERNATIONAL_COMPONENT, probeSeedName, renderGuestBootstrap} from
    "./linux-windows-cpu-floor-stage2.mjs";
import {
    createHostedStage2Operations,
    runHostedOwnedProcess
} from "./linux-windows-cpu-floor-stage2-hosted.mjs";
import {admitStage3Reservation} from "./linux-windows-cpu-floor-stage3.mjs";
import {renderWindowsBaselineGuestBootstrap} from "./windows-baseline-guest-bootstrap.mjs";
import {buildWindowsMsiSetupCompleteActivation, createWindowsBaselineCpuHandoff} from
    "./windows-msi-post-setup-activation.mjs";

const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_CANDIDATE_BYTES = 512 * 1024 * 1024;
const IO_CHUNK_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MILLISECONDS = 25_000;
const COMMAND_STREAM_BYTES = 1024 * 1024;
const BASELINE_RESULT_NAME = "baseline-result.json";
const BASELINE_BOOTSTRAP_NAME = "baseline-bootstrap.ps1";
const BASELINE_HANDOFF_NAME = "myspeed-baseline-cpu-handoff.json";
/*
 * The host downloads the release artifact names; the guest collector opens the seed names. The two
 * differ for the hyphenated roles, so both come from the one shared table rather than from a local
 * copy of either spelling.
 */
const REQUIRED_GUEST_FILES = Object.freeze(["node.exe", "request.json", "execution.json", "fixture-bundle.json",
    "guest-runtime.json", "runtime-installer.ps1", ...PROBE_SEED_FILES.map(entry => entry.artifactName)]);
const PROBE_ARTIFACT_NAMES = new Set(PROBE_SEED_FILES.map(entry => entry.artifactName));
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

/*
 * The identical six-field projection Stage 2 hands the public builder, so the digests the collector
 * bakes in are the digests of the files this seed actually installs.
 */
function baselineActivation(context) {
    return buildWindowsMsiSetupCompleteActivation({repository: context.repository, sourceSha: context.sourceSha,
        eventSha: context.eventSha, runId: context.runId, runAttempt: context.runAttempt, nonce: context.nonce});
}

function inlineSeedFile(name, bytes) {
    return {name, kind: "inline", bytes: String(bytes.length),
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"), bytesBase64: bytes.toString("base64")};
}

export function renderBaselineAutounattend(image, nonce) {
    const password = `Myspeed-Eval-${nonce.slice(0, 16)}!aA1`;
    const xml = `<?xml version="1.0" encoding="utf-8"?>\r\n<unattend xmlns="urn:schemas-microsoft-com:unattend" ` +
        `xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">\r\n` +
        `<settings pass="windowsPE">${WINDOWS_PE_INTERNATIONAL_COMPONENT}` +
        `<component name="Microsoft-Windows-Setup" processorArchitecture="amd64" ` +
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
        `-ErrorAction Stop).DriveLetter; &amp; ($s+':\\install-activation.ps1')&quot;</Path></RunSynchronousCommand>` +
        `</RunSynchronous></component></settings>\r\n<settings pass="oobeSystem"><component ` +
        `name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" ` +
        `language="neutral" versionScope="nonSxS"><UserAccounts><AdministratorPassword><Value>${password}</Value>` +
        `<PlainText>true</PlainText></AdministratorPassword></UserAccounts></component></settings>\r\n</unattend>\r\n`;
    return Buffer.from(xml, "utf8");
}

function seedSpec(candidate, guestFiles, selectedImage, context) {
    const filesByName = new Map(guestFiles.map(record => [record.name, record]));
    const bootstrap = renderWindowsBaselineGuestBootstrap({nonce: context.nonce, sourceSha: context.sourceSha,
        requestSha256: filesByName.get("request.json").sha256,
        executionSha256: filesByName.get("execution.json").sha256,
        runtimeBundleSha256: filesByName.get("guest-runtime.json").sha256});
    const owned = [candidate.stagedFile, candidate.stagedSummary, candidate.stagedManifest, ...guestFiles].map(record => ({
        name: PROBE_ARTIFACT_NAMES.has(record.name) ? probeSeedName(record.name) : record.name,
        kind: "owned-file", bytes: record.bytes, sha256: record.sha256, sourcePath: record.path
    }));
    const activation = baselineActivation(context);
    const handoff = Buffer.from(JSON.stringify(createWindowsBaselineCpuHandoff(activation,
        {name: BASELINE_BOOTSTRAP_NAME, bytes: bootstrap.length,
            sha256: crypto.createHash("sha256").update(bootstrap).digest("hex")})), "utf8");
    const files = [inlineSeedFile("Autounattend.xml", renderBaselineAutounattend(selectedImage, context.nonce)),
        inlineSeedFile("cpu-calibration.ps1", renderGuestBootstrap(context)),
        inlineSeedFile(BASELINE_BOOTSTRAP_NAME, bootstrap),
        {name: activation.seedInstaller.name, kind: "activation-installer",
            bytes: String(activation.seedInstaller.bytes), sha256: activation.seedInstaller.sha256,
            bytesBase64: activation.seedInstaller.bytesBase64},
        {...inlineSeedFile(BASELINE_HANDOFF_NAME, handoff), kind: "activation-handoff"},
        ...Object.values(activation.files).map(file => ({name: path.win32.basename(file.path),
            kind: "activation-inline", bytes: String(file.bytes), sha256: file.sha256,
            bytesBase64: file.bytesBase64})),
        ...owned];
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
        async launchBaselineGuest({argv, bootConfirmation, budget, paths: inputPaths, stage2, toolchain}) {
            launchCleanupProven = false;
            /*
             * Admitted before any guest starts, against the deadline the request declared. A run with
             * no room left for a Windows installation is refused here rather than started and killed
             * later, and the shared launcher never falls through to its generic allowance.
             */
            const reservation = admitStage3Reservation(budget, dependencies.unixMilliseconds ?? Date.now);
            const compatible = stage2CompatiblePaths(context, inputPaths);
            const launch = await getAdapter(stage2).launchOwnedQemu({context, paths: compatible, toolchain, argv,
                privilegeMode: stage2.privilegeMode, reservation: {...reservation},
                ...(bootConfirmation === undefined ? {} : {bootConfirmation})});
            if (!launch.guest || launch.guest.status !== "observed")
                throw new Error("baseline guest did not return the CPU calibration envelope");
            if (launch.earlyBoot === null || launch.earlyBoot === undefined)
                throw new Error("baseline QEMU produced no early-boot observation");
            if (launch.process?.cleanupProven !== true || launch.process.treeGone !== true ||
                launch.process.qemuPidAbsentAfter !== true)
                throw new Error("baseline QEMU cleanup was not proven");
            launchCleanupProven = true;
            return {argv: structuredClone(argv), process: structuredClone(launch.process),
                earlyBoot: structuredClone(launch.earlyBoot), reservation: {...reservation},
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

export const STAGE3_HOSTED_CONSTANTS = Object.freeze({BASELINE_BOOTSTRAP_NAME, BASELINE_HANDOFF_NAME,
    BASELINE_RESULT_NAME, COMMAND_TIMEOUT_MILLISECONDS, MAX_CANDIDATE_BYTES, MAX_JSON_BYTES});
