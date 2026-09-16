import {createHash} from "node:crypto";
import {createWindowsMsiLifecycleCandidateProvenanceFixture} from "./linux-windows-msi-lifecycle-host-fixture.mjs";
import {createWindowsMsiGuestLifecycleEvidenceFixture} from "./windows-msi-guest-lifecycle-evidence-fixture.mjs";
import {buildWindowsMsiGuestSeedDocuments} from "../../scripts/qualification/windows-msi-guest-seed-documents.mjs";
import {composeWindowsMsiHostQemuArguments} from "../../scripts/qualification/linux-windows-msi-lifecycle-host.mjs";
import {installedBaseSeal as createInstalledBaseSeal, hostedContext, HOST_NONCE} from "./post-release-msi-controller-fixture.mjs";
import {
    SCENARIO0_CALIBRATION_REQUEST_KIND,
    SCENARIO0_CALIBRATION_SCENARIO_ID,
    SCENARIO0_CALIBRATION_MAX_JOB_MILLISECONDS,
    SCENARIO0_CALIBRATION_MAX_EXECUTION_MILLISECONDS,
    SCENARIO0_CALIBRATION_MAX_CLEANUP_MILLISECONDS,
    SCENARIO0_CALIBRATION_RETENTION_RESERVE_MILLISECONDS,
    SCENARIO0_CALIBRATION_COMMAND_MILLISECONDS,
    SCENARIO0_CALIBRATION_OUTPUT_DISK_BYTES,
    SCENARIO0_CALIBRATION_RESERVATION_LABEL,
    createWindowsMsiScenario0CalibrationOperations,
    runWindowsMsiScenario0Calibration
} from "../../scripts/qualification/windows-msi-scenario0-calibration.mjs";


const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const HOST_ROOT = "/opt/myspeed/windows-msi";
const PNG_BYTES = Buffer.from("89504e470d0a1a0a", "hex");
const SECOND = 1_000;
const MINUTE = 60_000;
const WALL_CLOCK_ORIGIN = 1_800_000_000_000;
const TOOL_OWNERSHIP = Object.freeze({uid: "0", gid: "0", mode: "444", ordinaryUserWritable: false});
const READ_ONLY_MODE = 0o444;
const PRIVATE_MODE = 0o600;
const SEED_ISO_BYTES = 1_048_576;
const QEMU_PID = 4242;
const QEMU_PROCESS_GROUP = 4242;
const QEMU_START_TICKS = "987654";
const INERT_DEVICE = 1;
const FIRST_INODE = 1;
const SYMLINK_INODE = 0;

const identity = (path, bytes = "4096", hash = "a".repeat(64)) => ({path, bytes, sha256: hash});
const ownedIdentity = (path, bytes = "4096", hash = "a".repeat(64)) => ({...identity(path, bytes, hash),
    ownership: {...TOOL_OWNERSHIP}});
const retainedDocument = (root, name, document) => ({path: `${root}/${name}`, bytes: document.bytes,
    sha256: document.sha256, bytesBase64: document.bytesBase64});

const createToolchain = () => {
    const result = Object.fromEntries(["runtimeLoader", "qemu", "qemuImg", "genisoimage", "mformat", "mcopy",
        "ovmfCode", "ovmfVarsTemplate"].map((name, index) => [name,
        ownedIdentity(`/opt/myspeed/tools/${name}`, String(4096 + index),
            String(index + 1).repeat(64).slice(0, 64))]));
    result.portableRoot = "/opt/myspeed/tools";
    result.libraryPath = ["/opt/myspeed/tools/lib"];
    result.firmware = {searchPath: "/opt/myspeed/tools/usr/share/qemu",
        kvmvapic: ownedIdentity("/opt/myspeed/tools/usr/share/qemu/kvmvapic.bin", "4096", "8".repeat(64)),
        vga: ownedIdentity("/opt/myspeed/tools/usr/share/seabios/vgabios-stdvga.bin", "8192", "9".repeat(64))};
    return result;
};

export const createWindowsMsiScenario0CalibrationEarlyBoot = rowRoot => ({schemaVersion: 1,
    kind: "qemu-early-boot-observation", inputSent: false, version: {major: 9, minor: 2, micro: 1},
    status: "running", running: true,
    screenshots: [1, 2].map(index => ({path: `${rowRoot}/early-boot-${index}.png`,
        bytes: String(PNG_BYTES.length), sha256: sha256(PNG_BYTES), bytesBase64: PNG_BYTES.toString("base64")}))});

/*
 * A filesystem double that records what the real operations write, so the positive control can run the
 * production factory rather than a stand-in for it. Entries are either exact bytes or a sparse
 * descriptor: the output disk is a quarter of a gigabyte and only ever inspected by length and digest,
 * so materialising it would cost that much memory to prove nothing.
 */
export const createInertCalibrationFilesystem = () => {
    const entries = new Map();
    const directories = new Set();
    const symlinks = new Set();
    const directoryIdentities = new Map();
    const mkdirCalls = [];
    const handles = new Map();
    let nextHandle = 3;
    let nextInode = FIRST_INODE;
    const sparse = bytes => ({bytes, sha256: sha256(Buffer.from(`sparse:${bytes}`, "utf8"))});
    const present = target => entries.has(target) || directories.has(target) || symlinks.has(target);
    /*
     * A directory only holds what was created inside it, and a file cannot appear under a parent that
     * does not exist. Without those two rules the double answers questions about ancestor tracking
     * that the real filesystem would answer differently, which is how the untracked ancestor went
     * unnoticed: a path string stored in a flat map has no ancestors to leave behind.
     */
    const requireParent = target => {
        const parent = target.slice(0, target.lastIndexOf("/"));
        if (!directories.has(parent)) throw new Error(`ENOENT: ${parent}`);
    };
    const directoryIdentity = target => {
        if (!directoryIdentities.has(target)) directoryIdentities.set(target, nextInode++);
        return directoryIdentities.get(target);
    };
    const filesystem = {
        constants: {COPYFILE_EXCL: 1},
        existsSync: target => present(target),
        mkdirSync(target, options) {
            mkdirCalls.push({target, options});
            if (present(target)) {
                if (options?.recursive !== true) throw new Error(`EEXIST: ${target}`);
                return;
            }
            if (options?.recursive === true) {
                const parts = target.split("/");
                for (let index = 2; index <= parts.length; index += 1) {
                    const directory = parts.slice(0, index).join("/");
                    directories.add(directory);
                    directoryIdentity(directory);
                }
                return;
            }
            requireParent(target);
            directories.add(target);
            directoryIdentity(target);
        },
        lstatSync(target) {
            if (symlinks.has(target)) return {dev: INERT_DEVICE, ino: SYMLINK_INODE, isDirectory: () => false,
                isSymbolicLink: () => true};
            if (directories.has(target)) return {dev: INERT_DEVICE, ino: directoryIdentity(target),
                isDirectory: () => true, isSymbolicLink: () => false};
            throw new Error(`ENOENT: ${target}`);
        },
        readdirSync(target, options) {
            if (!directories.has(target)) throw new Error(`ENOTDIR: ${target}`);
            if (options?.withFileTypes !== true) throw new Error(`EINVAL: ${target}`);
            const prefix = `${target}/`;
            const children = new Map();
            for (const [kind, names] of [["file", entries.keys()], ["directory", directories],
                ["symlink", symlinks]])
                for (const name of names) {
                    if (!name.startsWith(prefix) || name.slice(prefix.length).includes("/")) continue;
                    children.set(name.slice(prefix.length), kind);
                }
            return [...children].map(([name, kind]) => ({name,
                isFile: () => kind === "file",
                isDirectory: () => kind === "directory",
                isSymbolicLink: () => kind === "symlink"}));
        },
        openSync(target, flags, mode) {
            if (flags === "wx" && present(target)) throw new Error(`EEXIST: ${target}`);
            requireParent(target);
            const handle = nextHandle++;
            handles.set(handle, target);
            entries.set(target, {bytes: 0, sha256: sha256(Buffer.alloc(0)), mode: mode ?? PRIVATE_MODE,
                content: Buffer.alloc(0)});
            return handle;
        },
        writeFileSync(handle, bytes) {
            const target = handles.get(handle);
            entries.set(target, {bytes: bytes.length, sha256: sha256(bytes), mode: PRIVATE_MODE, content: bytes});
        },
        ftruncateSync(handle, size) {
            const target = handles.get(handle);
            entries.set(target, {...sparse(size), mode: PRIVATE_MODE, content: null});
        },
        fsyncSync() {},
        closeSync(handle) { handles.delete(handle); },
        copyFileSync(source, target, flags) {
            if (flags === filesystem.constants.COPYFILE_EXCL && present(target))
                throw new Error(`EEXIST: ${target}`);
            requireParent(target);
            const entry = entries.get(source);
            if (entry === undefined) throw new Error(`ENOENT: ${source}`);
            entries.set(target, {...entry, mode: PRIVATE_MODE});
        },
        readFileSync(target) {
            const entry = entries.get(target);
            if (entry?.content == null) throw new Error(`ENOENT: ${target}`);
            return entry.content;
        },
        rmSync(target, options) {
            const removed = entries.delete(target) || symlinks.delete(target);
            if (!removed && options?.force !== true) throw new Error(`ENOENT: ${target}`);
        },
        rmdirSync(target) {
            const children = [...entries.keys(), ...directories, ...symlinks]
                .filter(name => name.startsWith(`${target}/`));
            if (children.length > 0) throw new Error(`ENOTEMPTY: ${target}`);
            if (!directories.delete(target)) throw new Error(`ENOENT: ${target}`);
        }
    };
    return {
        filesystem, entries, directories, symlinks, mkdirCalls,
        placeSymlink(target) { symlinks.add(target); },
        replaceDirectory(target) {
            directories.delete(target);
            symlinks.delete(target);
            directoryIdentities.delete(target);
            directories.add(target);
            directoryIdentity(target);
        },
        replaceSymlink(target) {
            directories.delete(target);
            directoryIdentities.delete(target);
            symlinks.add(target);
        },
        place(target, bytes, ownership) {
            entries.set(target, {bytes: bytes.length, sha256: sha256(bytes), mode: READ_ONLY_MODE,
                content: bytes, ownership});
        },
        placeIdentity(value, ownership) {
            entries.set(value.path, {bytes: Number(value.bytes), sha256: value.sha256, mode: READ_ONLY_MODE,
                content: null, ownership});
        },
        placeSparse(target, bytes, salt = "") {
            entries.set(target, {bytes, sha256: sha256(Buffer.from(`sparse:${bytes}:${salt}`, "utf8")),
                mode: PRIVATE_MODE, content: null});
        },
        inspectFile: async (target, maximumBytes = Number.MAX_SAFE_INTEGER, minimumBytes = 1) => {
            const entry = entries.get(target);
            if (entry === undefined) throw new Error(`MSI calibration fixture has no file: ${target}`);
            if (entry.bytes < minimumBytes || entry.bytes > maximumBytes)
                throw new Error(`MSI calibration fixture file bound differs: ${target}`);
            return {path: target, bytes: String(entry.bytes), sha256: entry.sha256, mode: entry.mode,
                ownership: entry.ownership ?? {uid: "0", gid: "0", mode: "600", ordinaryUserWritable: false}};
        }
    };
};

export const createWindowsMsiScenario0CalibrationFixture = async (overrides = {}) => {
    const toolchain = createToolchain();
    const installedBaseSeal = createInstalledBaseSeal();
    const context = hostedContext();
    const buildGuest = extra => createWindowsMsiGuestLifecycleEvidenceFixture({
        ...overrides,
        sourceSha: context.sourceSha,
        eventSha: context.eventSha,
        runId: context.runId,
        runAttempt: context.runAttempt,
        baseImageSha256: installedBaseSeal.image.sha256,
        ...extra
    });

    /*
     * The guest's own row request declares the overlay receipt and the QEMU invocation it expects the
     * host to have produced, and the consumer refuses a result where the two disagree. In production
     * the host request builder resolves both before the guest documents are sealed; the control does
     * the same in two passes rather than letting the fixture assert values the real operations would
     * never compute.
     */
    const provisional = await buildGuest({});
    const provisionalNonce = JSON.parse(
        Buffer.from(provisional.evidence.rows[0].rowRequest.bytesBase64, "base64")).nonce;
    const provisionalRoot = `${HOST_ROOT}/myspeed-windows-msi-${HOST_NONCE}/row-00-${provisionalNonce}`;
    const provisionalOverlay = {path: `${provisionalRoot}/system-overlay.qcow2`, format: "qcow2",
        backingBaseSha256: installedBaseSeal.image.sha256, createNew: true,
        receiptSha256: sha256(Buffer.from(JSON.stringify({path: `${provisionalRoot}/system-overlay.qcow2`,
            format: "qcow2", backingFilename: installedBaseSeal.image.path,
            backingBaseSha256: installedBaseSeal.image.sha256}), "utf8"))};
    const provisionalArgv = composeWindowsMsiHostQemuArguments({toolchain, overlay: provisionalOverlay,
        media: {seed: {path: `${provisionalRoot}/seed.iso`},
            outputBefore: {path: `${provisionalRoot}/output.img`}},
        guestSerial: provisionalNonce,
        paths: {ovmfVarsPath: `${provisionalRoot}/OVMF_VARS.fd`,
            serialLogPath: `${provisionalRoot}/serial.log`, pidPath: `${provisionalRoot}/qemu.pid`}});
    const guest = await buildGuest({
        overlayReceiptSha256ByScenario: provisional.evidence.rows.map((value, index) => index === 0
            ? provisionalOverlay.receiptSha256 : sha256(Buffer.from(`calibration-overlay-${index}`))),
        qemuLaunchSha256ByScenario: provisional.evidence.rows.map((value, index) => index === 0
            ? sha256(Buffer.from(JSON.stringify(provisionalArgv), "utf8"))
            : sha256(Buffer.from(`calibration-launch-${index}`)))
    });

    const guestRow0 = guest.evidence.rows[0];
    const guestResultBytes = Buffer.from(guestRow0.semanticResult.bytesBase64, "base64");
    const rowRequestValue = JSON.parse(Buffer.from(guestRow0.rowRequest.bytesBase64, "base64"));
    const executionValue = JSON.parse(Buffer.from(guestRow0.executionManifest.bytesBase64, "base64"));
    const rowNonce = rowRequestValue.nonce;
    const rowRoot = `${HOST_ROOT}/myspeed-windows-msi-${HOST_NONCE}/row-00-${rowNonce}`;
    const seedRoot = `${rowRoot}/seed`;
    const documents = buildWindowsMsiGuestSeedDocuments({
        rowRequest: rowRequestValue,
        executionManifest: executionValue,
        matrixRunner: {
            path: `${executionValue.seedRoot}\\windows-msi-guest-matrix-executor.mjs`,
            bytes: 14_000, sha256: "d".repeat(64)
        },
        launcher: {
            path: `${executionValue.seedRoot}\\media-job-launcher.ps1`,
            bytes: 32_000, sha256: "e".repeat(64)
        },
        observerSha256: "f".repeat(64),
        wallDeadlineUnixMilliseconds: 2_000_000_000_000
    });

    const row = {
        scenarioIndex: 0,
        scenarioId: SCENARIO0_CALIBRATION_SCENARIO_ID,
        nonce: rowNonce,
        rowRoot,
        overlayPath: `${rowRoot}/system-overlay.qcow2`,
        seedRoot,
        seedIsoPath: `${rowRoot}/seed.iso`,
        outputDiskPath: `${rowRoot}/output.img`,
        guestResultPath: `${rowRoot}/guest-result.json`,
        serialLogPath: `${rowRoot}/serial.log`,
        pidPath: `${rowRoot}/qemu.pid`,
        ovmfVarsPath: `${rowRoot}/OVMF_VARS.fd`,
        rowRequest: retainedDocument(seedRoot, "row-request.json", documents.rowRequest),
        executionManifest: retainedDocument(seedRoot, "execution-manifest.json", documents.executionManifest),
        guestEnvelope: retainedDocument(seedRoot, "matrix-envelope.json", documents.envelope),
        launcherRequest: retainedDocument(seedRoot, "launch-request.json", documents.launcherRequest),
        seedFiles: [
            {name: "node.exe", sourcePath: "/opt/myspeed/closure/node.exe", bytes: "85268464", sha256: "b".repeat(64)},
            {name: "windows-msi-guest-matrix-executor.mjs", sourcePath: "/opt/myspeed/closure/matrix.mjs", bytes: "14000", sha256: "d".repeat(64)},
            {name: "media-job-launcher.ps1", sourcePath: "/opt/myspeed/closure/launcher.ps1", bytes: "32000", sha256: "e".repeat(64)},
            ...(overrides.extraSeedFiles ?? [])
        ]
    };

    const reservation = {
        label: SCENARIO0_CALIBRATION_RESERVATION_LABEL,
        executionMilliseconds: SCENARIO0_CALIBRATION_MAX_EXECUTION_MILLISECONDS,
        cleanupMilliseconds: SCENARIO0_CALIBRATION_MAX_CLEANUP_MILLISECONDS
    };

    const baseImage = ownedIdentity(
        installedBaseSeal.image.path,
        installedBaseSeal.image.bytes,
        installedBaseSeal.image.sha256
    );

    const request = {
        schemaVersion: 1,
        kind: SCENARIO0_CALIBRATION_REQUEST_KIND,
        qualifying: false,
        sourceSha: context.sourceSha,
        eventSha: context.eventSha,
        runId: context.runId,
        runAttempt: context.runAttempt,
        nonce: HOST_NONCE,
        toolchainSha256: sha256(Buffer.from(JSON.stringify(toolchain), "utf8")),
        context,
        limits: {
            jobBudgetMilliseconds: SCENARIO0_CALIBRATION_MAX_JOB_MILLISECONDS,
            maxExecutionMilliseconds: SCENARIO0_CALIBRATION_MAX_EXECUTION_MILLISECONDS,
            maxCleanupMilliseconds: SCENARIO0_CALIBRATION_MAX_CLEANUP_MILLISECONDS,
            retentionReserveMilliseconds: SCENARIO0_CALIBRATION_RETENTION_RESERVE_MILLISECONDS,
            commandMilliseconds: SCENARIO0_CALIBRATION_COMMAND_MILLISECONDS,
            outputDiskBytes: SCENARIO0_CALIBRATION_OUTPUT_DISK_BYTES
        },
        wallDeadlineUnixMilliseconds: WALL_CLOCK_ORIGIN + SCENARIO0_CALIBRATION_MAX_JOB_MILLISECONDS,
        reservation,
        toolchain,
        baseImage,
        candidateProvenance: overrides.publishedProvenance === true
            ? {kind: "myspeed-v1.6.1-published-msi-host-provenance",
                ...createWindowsMsiLifecycleCandidateProvenanceFixture(guest)}
            : createWindowsMsiLifecycleCandidateProvenanceFixture(guest, overrides.candidateProvenance),
        expected: {
            sourceSha: context.sourceSha,
            eventSha: context.eventSha,
            runId: context.runId,
            runAttempt: context.runAttempt,
            candidateManifestSha256: guest.expected.candidateManifestSha256,
            closureSha256: guest.expected.closureSha256,
            fixtureManifestSha256: guest.expected.fixtureManifestSha256,
            baseImageSha256: installedBaseSeal.image.sha256,
            probeArtifact: guest.expected.probeArtifact
        },
        row,
        installedBaseSeal
    };

    /*
     * One clock drives both the budget and the observed duration. It advances by a fixed step per read
     * so a test can predict elapsed time exactly, and `advance` lets a test consume the budget without
     * pretending a native measurement took place.
     */
    const clock = {monotonic: 0, wall: WALL_CLOCK_ORIGIN, step: SECOND};
    const dependencies = {
        deriveActualContext: () => structuredClone(request.context),
        monotonicMilliseconds: () => {
            clock.monotonic += clock.step;
            clock.wall += clock.step;
            return clock.monotonic;
        },
        unixMilliseconds: () => clock.wall,
        ...overrides.dependencies
    };
    const advance = milliseconds => { clock.monotonic += milliseconds; clock.wall += milliseconds; };

    const disk = createInertCalibrationFilesystem();
    disk.directories.add(HOST_ROOT);
    disk.directories.add(`${HOST_ROOT}/myspeed-windows-msi-${HOST_NONCE}`);
    disk.placeIdentity(request.baseImage, {...TOOL_OWNERSHIP});
    for (const name of ["runtimeLoader", "qemu", "qemuImg", "genisoimage", "mformat", "mcopy", "ovmfCode",
        "ovmfVarsTemplate"]) disk.placeIdentity(request.toolchain[name], {...TOOL_OWNERSHIP});
    for (const source of row.seedFiles)
        disk.placeIdentity({path: source.sourcePath, bytes: source.bytes, sha256: source.sha256});

    const invocations = [];
    const runOwned = async (command, argv, options) => {
        invocations.push({command, argv, options});
        const tool = argv[2];
        const rest = argv.slice(3);
        let stdout = Buffer.alloc(0);
        if (tool === request.toolchain.qemuImg.path) {
            if (rest[0] === "create") disk.placeSparse(rest[rest.length - 1], 196_608);
            stdout = Buffer.from(JSON.stringify({format: "qcow2", "virtual-size": 68_719_476_736,
                "backing-filename": request.baseImage.path}), "utf8");
        }
        if (tool === request.toolchain.genisoimage.path)
            disk.placeSparse(rest[rest.indexOf("-o") + 1], SEED_ISO_BYTES);
        if (tool === request.toolchain.mcopy.path)
            disk.place(rest[rest.length - 1], guestResultBytes);
        return {process: {exitCode: 0, signal: null, timedOut: false, cleanupProven: true,
            errorObserved: false, stdoutOverflow: false, stderrOverflow: false}, stdout,
        stderr: Buffer.alloc(0)};
    };

    const launcherCalls = [];
    const monitoredProcess = overrides.monitoredProcess ?? {};
    const runQemu = overrides.runQemu ?? (async launch => {
        launcherCalls.push(launch.reservation);
        invocations.push(launch);
        disk.placeSparse(row.pidPath, 8);
        disk.placeSparse(row.serialLogPath, 2_048);
        disk.placeSparse(row.outputDiskPath, request.limits.outputDiskBytes, "written");
        // Anything that appears in the row root does so while the guest is running, not before.
        overrides.afterLaunch?.(disk, row);
        return {argv: launch.argv, executionSucceeded: true,
            earlyBoot: createWindowsMsiScenario0CalibrationEarlyBoot(row.rowRoot),
            processFlags: {errorObserved: false, stdoutOverflow: false, stderrOverflow: false},
            process: {exitCode: 0, signal: null, timedOut: false, cleanupProven: true, treeGone: true,
                qemuPid: QEMU_PID, qemuStartTicks: QEMU_START_TICKS, processGroupId: QEMU_PROCESS_GROUP,
                qemuPidAbsentAfter: true, terminationReason: null,
                launcherExecutablePath: request.toolchain.runtimeLoader.path, ...monitoredProcess}};
    });

    /*
     * A request the real validator has to refuse cannot reach the operations factory, which validates
     * it as well. The control therefore hands the refused request back untouched, so a test can show
     * both that it is refused and that nothing was written while finding that out.
     */
    if (overrides.compose === false)
        return {request, disk, invocations, guest, guestResultBytes, advance, clock};

    const operations = createWindowsMsiScenario0CalibrationOperations({request, dependencies: {
        ...dependencies, filesystem: disk.filesystem, inspectFile: disk.inspectFile, runOwned, runQemu}});

    if (overrides.run === false)
        return {request, operations, disk, invocations, launcherCalls, guest, guestResultBytes, advance, clock};

    const result = await runWindowsMsiScenario0Calibration(request, operations);
    /*
     * The delivered result is never consumed in the process that produced it: the controller writes it
     * as JSON and a later step reads it back. The control therefore hands on what survives that round
     * trip, so a field that cannot be serialised fails here instead of on the runner.
     */
    const serialized = JSON.parse(JSON.stringify(result));
    return {request, result, serialized, operations, disk, invocations, launcherCalls, guest,
        guestResultBytes, advance, clock, minute: MINUTE};
};
