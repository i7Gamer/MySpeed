/*
 * The concrete host operations for the containment preflight.
 *
 * Nothing here executes anything native: the filesystem, the owned-command runner and the QEMU
 * launcher all arrive injected, and every assertion is about what the factory asked for rather than
 * about anything that ran. Which is also the point of the tests - a preflight that reads its guest's
 * result before the QEMU group is gone, or removes an overlay while a QEMU may still be holding it,
 * is exactly the failure these injected recorders make visible.
 */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {describe, it} from "node:test";

import {buildWindowsMsiContainmentPreflightRequest, runWindowsMsiContainmentPreflight} from
    "../../scripts/qualification/windows-msi-containment-preflight.mjs";
import {buildWindowsMsiContainmentPreflightGuestRequest,
    createWindowsMsiContainmentPreflightOperations, WINDOWS_MSI_CONTAINMENT_PREFLIGHT_HOST} from
    "../../scripts/qualification/windows-msi-containment-preflight-host.mjs";
import {buildWindowsMsiGuestPreflightSeedDocuments} from
    "../../scripts/qualification/windows-msi-guest-seed-documents.mjs";
import {createWindowsMsiContainmentPreflightReservation,
    WindowsMsiContainmentPreflightBudgetError} from
    "../../scripts/qualification/windows-msi-lifecycle-budget.mjs";
import {createWindowsMsiContainmentCalibrationDocument,
    createWindowsMsiContainmentLaunchRecord} from
    "../helpers/windows-msi-prerequisite-evidence-fixture.mjs";

const NONCE = "9".repeat(32);
const PRODUCT_CODE = "{0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0}";
const MSI_SHA = "a".repeat(64);
const HELPER_SHA = "c".repeat(64);
const TASK_ROOT = `/home/runner/work/_temp/myspeed-windows-msi-${NONCE}`;
const OUTPUT_DISK_BYTES = 268_435_456;
const MINUTE = 60_000;
const WALL_START = 1_800_000_000_000;

const BUDGET = Object.freeze({jobBudgetMilliseconds: 300 * MINUTE,
    rowAllowanceMilliseconds: 15 * MINUTE, rowCleanupMarginMilliseconds: 2 * MINUTE,
    finalMarginMilliseconds: 10 * MINUTE});

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

const CONTEXT = Object.freeze({repository: "i7Gamer/MySpeed", sourceSha: "1".repeat(40),
    eventSha: "2".repeat(40), runId: "34900000001", runAttempt: "1", nonce: NONCE});

const tool = (name, digest) => ({path: `/opt/myspeed/tools/usr/bin/${name}`, bytes: "4096",
    sha256: digest, ownership: {uid: "0", gid: "0", mode: "755", ordinaryUserWritable: false}});

const TOOLCHAIN = Object.freeze({portableRoot: "/opt/myspeed/tools",
    runtimeLoader: tool("ld-linux-x86-64.so.2", "1".repeat(64)),
    libraryPath: ["/opt/myspeed/tools/usr/lib"],
    firmware: {searchPath: "/opt/myspeed/tools/usr/share/qemu",
        kvmvapic: tool("kvmvapic.bin", "2".repeat(64)), vga: tool("vgabios.bin", "3".repeat(64))},
    qemu: tool("qemu-system-x86_64", "4".repeat(64)), qemuImg: tool("qemu-img", "5".repeat(64)),
    genisoimage: tool("genisoimage", "6".repeat(64)), mformat: tool("mformat", "7".repeat(64)),
    mcopy: tool("mcopy", "8".repeat(64)), ovmfCode: tool("OVMF_CODE.fd", "9".repeat(64)),
    ovmfVarsTemplate: tool("OVMF_VARS.fd", "b".repeat(64))});

const BASE_IMAGE = Object.freeze({path: `${TASK_ROOT}/base/installed-base.qcow2`, bytes: "1048576",
    sha256: "e".repeat(64),
    ownership: {uid: "1000", gid: "1000", mode: "444", ordinaryUserWritable: false}});

const POWERSHELL = Object.freeze({path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    bytes: "450560", sha256: "d".repeat(64)});

const expected = (overrides = {}) => ({productCode: PRODUCT_CODE,
    msi: {source: "observed-preparation", path: `${TASK_ROOT}/appassets/files/authentic-old.msi`,
        bytes: "4194304", sha256: MSI_SHA},
    helper: {source: "sealed-closure",
        path: "scripts/qualification/windows-msi-guest-containment.ps1", bytes: "20480",
        sha256: HELPER_SHA}, ...overrides});

const hostRequest = (overrides = {}) => buildWindowsMsiContainmentPreflightRequest({context: CONTEXT,
    taskRoot: TASK_ROOT, guestSerial: overrides.guestSerial
        ?? WINDOWS_MSI_CONTAINMENT_PREFLIGHT_HOST.deriveGuestNonce(NONCE),
    expected: overrides.expected ?? expected()});

const guestRequest = (request, overrides = {}) => buildWindowsMsiContainmentPreflightGuestRequest({
    context: CONTEXT, request, powershell: POWERSHELL,
    qemuLaunchSha256: overrides.qemuLaunchSha256 ?? "f".repeat(64), ...overrides.extra});

const SOURCES = Object.freeze({
    node: {path: `${TASK_ROOT}/appassets/files/node-v22.19.0-win-x64/node.exe`, bytes: "80000000",
        sha256: "1".repeat(64)},
    launcher: {path: `/home/runner/work/_temp/myspeed-msi-closure-${NONCE}/scripts/qualification/media-job-launcher.ps1`,
        bytes: "8000", sha256: "2".repeat(64)},
    preflightRunner: {path: `/home/runner/work/_temp/myspeed-msi-closure-${NONCE}/scripts/qualification/windows-msi-guest-containment-preflight-executor.mjs`,
        bytes: "9000", sha256: "3".repeat(64)},
    containment: {path: `/home/runner/work/_temp/myspeed-msi-closure-${NONCE}/scripts/qualification/windows-msi-guest-containment.ps1`,
        bytes: "20480", sha256: HELPER_SHA},
    msi: {path: `${TASK_ROOT}/appassets/files/authentic-old.msi`, bytes: "4194304", sha256: MSI_SHA}
});

const seedFor = (request, guest) => ({
    documents: buildWindowsMsiGuestPreflightSeedDocuments({preflightRequest: guest,
        preflightRunner: {path: `${guest.guest.seedRoot}\\windows-msi-guest-containment-preflight-executor.mjs`,
            bytes: Number(SOURCES.preflightRunner.bytes), sha256: SOURCES.preflightRunner.sha256},
        launcher: {path: `${guest.guest.seedRoot}\\media-job-launcher.ps1`,
            bytes: Number(SOURCES.launcher.bytes), sha256: SOURCES.launcher.sha256},
        node: {path: `${guest.guest.seedRoot}\\node.exe`, bytes: Number(SOURCES.node.bytes),
            sha256: SOURCES.node.sha256},
        observerSha256: "4".repeat(64), wallDeadlineUnixMilliseconds: 1_789_370_000_000}),
    files: [
        {name: "node.exe", sourcePath: SOURCES.node.path, bytes: SOURCES.node.bytes,
            sha256: SOURCES.node.sha256},
        {name: "media-job-launcher.ps1", sourcePath: SOURCES.launcher.path,
            bytes: SOURCES.launcher.bytes, sha256: SOURCES.launcher.sha256},
        {name: "windows-msi-guest-containment-preflight-executor.mjs",
            sourcePath: SOURCES.preflightRunner.path, bytes: SOURCES.preflightRunner.bytes,
            sha256: SOURCES.preflightRunner.sha256},
        {name: "windows-msi-guest-containment.ps1", sourcePath: SOURCES.containment.path,
            bytes: SOURCES.containment.bytes, sha256: SOURCES.containment.sha256},
        {name: `${guest.bindingId}.msi`, sourcePath: SOURCES.msi.path, bytes: SOURCES.msi.bytes,
            sha256: SOURCES.msi.sha256}],
    request: request
});

/*
 * A filesystem and a command runner that record rather than act. Every path the factory creates,
 * copies or removes is remembered, so "the overlay was removed" and "the output was read" are
 * observations about what was asked for, not about what a real disk did.
 */
const recorder = (settings = {}) => {
    const files = new Map([[BASE_IMAGE.path, {bytes: BASE_IMAGE.bytes, sha256: BASE_IMAGE.sha256,
        mode: 0o444, ownership: BASE_IMAGE.ownership}]]);
    for (const source of [SOURCES.node, SOURCES.launcher, SOURCES.preflightRunner, SOURCES.containment,
        SOURCES.msi])
        files.set(source.path, {bytes: source.bytes, sha256: source.sha256, mode: 0o600});
    /* Every toolchain binary the factory re-inspects before it uses it. */
    for (const item of [TOOLCHAIN.runtimeLoader, TOOLCHAIN.qemu, TOOLCHAIN.qemuImg,
        TOOLCHAIN.genisoimage, TOOLCHAIN.mformat, TOOLCHAIN.mcopy, TOOLCHAIN.ovmfCode,
        TOOLCHAIN.ovmfVarsTemplate, TOOLCHAIN.firmware.vga, TOOLCHAIN.firmware.kvmvapic])
        files.set(item.path, {bytes: item.bytes, sha256: item.sha256, mode: 0o755,
            ownership: item.ownership});
    const directories = new Set();
    const commands = [];
    const commandTimeouts = [];
    const removed = [];
    const written = new Map();
    const staged = new Set();
    const filesystem = {
        constants: {COPYFILE_EXCL: 1},
        existsSync: target => files.has(target) || directories.has(target),
        mkdirSync: (target, options) => {
            if (directories.has(target) && options?.recursive !== true)
                throw new Error(`exists: ${target}`);
            directories.add(target);
        },
        openSync: target => {
            if (files.has(target)) throw new Error(`exists: ${target}`);
            staged.add(target);
            files.set(target, {bytes: "0", sha256: sha256(Buffer.alloc(0)), mode: 0o600, pending: true});
            return target;
        },
        writeFileSync: (handle, bytes) => {
            written.set(handle, bytes);
            files.set(handle, {bytes: String(bytes.length), sha256: sha256(bytes), mode: 0o600,
                content: bytes});
        },
        ftruncateSync: (handle, size) => files.set(handle, {bytes: String(size),
            sha256: "c".repeat(64), mode: 0o600}),
        fsyncSync: () => undefined,
        closeSync: () => undefined,
        copyFileSync: (from, to) => {
            if (files.has(to)) throw new Error(`exists: ${to}`);
            staged.add(to);
            files.set(to, {...files.get(from)});
        },
        readFileSync: target => files.get(target)?.content ?? Buffer.alloc(0),
        rmSync: target => {
            removed.push(target);
            for (const key of [...files.keys()]) if (key.startsWith(`${target}/`)) files.delete(key);
            for (const key of [...directories]) if (key === target || key.startsWith(`${target}/`))
                directories.delete(key);
        }
    };
    const inspectFile = async target => {
        const item = files.get(target);
        if (!item) throw new Error(`MSI preflight inspected file is absent: ${target}`);
        return {path: target, bytes: item.bytes, sha256: item.sha256, mode: item.mode ?? 0o600,
            ownership: item.ownership ?? {uid: "1000", gid: "1000", mode: "600",
                ordinaryUserWritable: false}};
    };
    const completed = (stdout = "") => ({process: {exitCode: 0, signal: null, timedOut: false,
        cleanupProven: true, errorObserved: false, stdoutOverflow: false, stderrOverflow: false},
    stdout: Buffer.from(stdout, "utf8"), stderr: Buffer.alloc(0)});
    const runOwned = async (loaderPath, argv, options) => {
        const toolPath = argv[2];
        const rest = argv.slice(3);
        commands.push([toolPath, ...rest].join(" "));
        commandTimeouts.push(options.timeoutMs);
        if (settings.failCommand?.(toolPath, rest)) return {process: {exitCode: 1, signal: null,
            timedOut: false, cleanupProven: true, errorObserved: false, stdoutOverflow: false,
            stderrOverflow: false}, stdout: Buffer.alloc(0), stderr: Buffer.from("no", "utf8")};
        if (toolPath === TOOLCHAIN.qemuImg.path && rest[0] === "info") {
            const target = rest[rest.length - 1];
            return completed(JSON.stringify(target === BASE_IMAGE.path
                ? {format: "qcow2", "virtual-size": 68_719_476_736}
                : {format: "qcow2", "backing-filename": BASE_IMAGE.path}));
        }
        if (toolPath === TOOLCHAIN.qemuImg.path && rest[0] === "create") {
            files.set(rest[rest.length - 1], {bytes: "262144", sha256: "7".repeat(64), mode: 0o600});
            return completed();
        }
        if (toolPath === TOOLCHAIN.genisoimage.path) {
            files.set(rest[rest.indexOf("-o") + 1], {bytes: "1048576", sha256: "8".repeat(64),
                mode: 0o600});
            return completed();
        }
        if (toolPath === TOOLCHAIN.mcopy.path) {
            const bytes = settings.guestResultBytes
                ?? Buffer.from(JSON.stringify(calibrationFor(settings)), "utf8");
            files.set(rest[rest.length - 1], {bytes: String(bytes.length), sha256: sha256(bytes),
                mode: 0o600, content: bytes});
            return completed();
        }
        return completed();
    };
    const launched = [];
    const runQemu = async input => {
        launched.push(input);
        const treeGone = settings.treeGone ?? true;
        return {executionSucceeded: settings.executionSucceeded ?? true,
            process: {qemuPid: 4242, qemuStartTicks: "900", processGroupId: 4242,
                exitCode: settings.qemuExitCode ?? 0, signal: null,
                timedOut: settings.timedOut ?? false, terminationReason: null,
                cleanupProven: settings.cleanupProven ?? true, treeGone,
                qemuPidAbsentAfter: settings.qemuPidAbsentAfter ?? treeGone}};
    };
    return {filesystem, inspectFile, runOwned, runQemu, commands, commandTimeouts, removed,
        launched, files, directories, written, staged};
};

const calibrationFor = (settings = {}) => createWindowsMsiContainmentCalibrationDocument({
    guestSerial: settings.guestSerial ?? WINDOWS_MSI_CONTAINMENT_PREFLIGHT_HOST.deriveGuestNonce(NONCE),
    nonce: NONCE, productCode: PRODUCT_CODE, msiSha256: MSI_SHA, helperSha256: HELPER_SHA,
    launchRecords: settings.launchRecords
        ?? [createWindowsMsiContainmentLaunchRecord(2140, {}, NONCE)]});

const prepared = (settings = {}) => {
    const request = hostRequest();
    const guest = guestRequest(request);
    const recorded = recorder(settings);
    const time = {now: 0};
    const reservation = createWindowsMsiContainmentPreflightReservation({
        limits: {...BUDGET, ...settings.budget}, monotonicMilliseconds: () => time.now,
        unixMilliseconds: () => WALL_START + time.now,
        wallDeadlineUnixMilliseconds: WALL_START
            + (settings.wallRemainingMilliseconds ?? 300 * MINUTE)});
    const operations = createWindowsMsiContainmentPreflightOperations({request,
        host: {context: CONTEXT, privilegeMode: "reviewed-sudo-kvm", toolchain: TOOLCHAIN,
            baseImage: BASE_IMAGE, limits: {outputDiskBytes: OUTPUT_DISK_BYTES}},
        seed: seedFor(request, guest), reservation,
        dependencies: {filesystem: recorded.filesystem, inspectFile: recorded.inspectFile,
            runOwned: recorded.runOwned, runQemu: recorded.runQemu}});
    return {request, guest, operations, recorded, reservation, time};
};

describe("Windows MSI containment preflight host operations", () => {
    it("runs one disposable overlay of the sealed base and reads its result only after group zero",
        async () => {
            const {request, operations, recorded} = prepared();
            const observed = await runWindowsMsiContainmentPreflight({request}, operations);
            assert.equal(observed.record.prerequisiteId, "authentic-old-ifeo-containment");
            assert.equal(observed.record.producer, "in-guest-calibration");
            assert.equal(observed.semantics.oldPayloadExecutionCount, 0);
            assert.equal(observed.semantics.interceptedLaunchCount, 1);
            /* The overlay is created from the sealed base and is never the base itself. */
            assert.equal(observed.overlay.path, request.overlayPath);
            assert.equal(observed.overlay.backingBaseSha256, BASE_IMAGE.sha256);
            assert.notEqual(observed.overlay.path, BASE_IMAGE.path);
            assert.ok(recorded.commands.some(value =>
                value.includes(`create -f qcow2 -F qcow2 -b ${BASE_IMAGE.path} ${request.overlayPath}`)));
            /* The output is only ever read after the launcher reported the whole group gone. */
            const extraction = recorded.commands.findIndex(value => value.includes("mcopy"));
            assert.notEqual(extraction, -1);
            assert.equal(recorded.launched.length, 1);
            assert.equal(observed.launch.groupZero, true);
            /* The disposable root is removed, and the reusable base is untouched either side. */
            assert.deepEqual(recorded.removed, [request.root]);
            assert.deepEqual(observed.baseAfter, observed.baseBefore);
            assert.equal(observed.baseBefore.sealedReadOnly, true);
        });

    it("stamps the preflight guest serial into the vector the guest is checked against", async () => {
        const {guest, operations, recorded} = prepared();
        await runWindowsMsiContainmentPreflight({request: hostRequest()}, operations);
        const [{argv}] = recorded.launched;
        const index = argv.indexOf("-smbios");
        assert.notEqual(index, -1);
        assert.equal(argv[index + 1], `type=1,serial=${guest.guest.serial}`);
        /* Its own guest, never the host's own nonce. */
        assert.notEqual(guest.guest.serial, NONCE);
        assert.equal(argv.includes("-net"), false);
        assert.equal(argv.includes("-netdev"), false);
        assert.equal(argv.includes("-nic"), true);
    });

    it("seeds the preflight documents and its own bootstrap, never a matrix row seed", async () => {
        const {request, operations, recorded} = prepared();
        await runWindowsMsiContainmentPreflight({request}, operations);
        const seedRoot = `${request.root}/seed`;
        const manifest = JSON.parse(recorded.written.get(`${seedRoot}/seed-manifest.json`)
            .toString("utf8"));
        assert.equal(manifest.kind, "myspeed-windows-msi-containment-preflight-seed");
        assert.equal(manifest.guestNonce, WINDOWS_MSI_CONTAINMENT_PREFLIGHT_HOST.deriveGuestNonce(NONCE));
        assert.equal(Object.hasOwn(manifest, "scenarioIndex"), false);
        assert.equal(Object.hasOwn(manifest, "rowNonce"), false);
        const bootstrap = recorded.written.get(`${seedRoot}/bootstrap.ps1`).toString("utf8");
        assert.ok(bootstrap.includes("myspeed-windows-msi-containment-preflight-seed"));
        assert.equal(bootstrap.includes("myspeed-windows-msi-lifecycle-row-seed"), false);
        /* Every file the manifest names was staged and re-inspected at its bound identity. */
        for (const file of manifest.files)
            assert.ok(recorded.staged.has(`${seedRoot}/${file.name}`), file.name);
        assert.ok(manifest.files.some(file => file.name === "windows-msi-guest-containment.ps1"));
        assert.ok(manifest.files.some(file => file.name === "preflight-request.json"));
    });

    /*
     * The two ways a preflight can quietly become worthless: reading the guest's answer while the
     * QEMU that wrote it may still be running, and removing the overlay out from under a process
     * that still holds it. Both are refused, and the primary failure is what survives.
     */
    const causes = error => (error instanceof AggregateError ? error.errors : [error])
        .map(item => item.message).join(" | ");

    it("refuses to read the guest result before QEMU group zero", async () => {
        const {request, operations, recorded} = prepared({treeGone: false});
        await assert.rejects(runWindowsMsiContainmentPreflight({request}, operations), error => {
            assert.match(causes(error), /process tree exit|group zero/iu);
            return true;
        });
        /* The extraction never happened, so nothing read an output disk QEMU might still hold. */
        assert.equal(recorded.commands.some(value => value.includes("mcopy")), false);
    });

    it("leaves an overlay in place when the process group was never proven gone", async () => {
        const {request, operations, recorded} = prepared({executionSucceeded: false, treeGone: false});
        await assert.rejects(runWindowsMsiContainmentPreflight({request}, operations), error => {
            assert.match(causes(error), /process tree exit|group zero/iu);
            assert.match(causes(error), /cleanup differs/iu);
            return true;
        });
        assert.deepEqual(recorded.removed, []);
    });

    it("still removes its disposable root when nothing was ever launched", async () => {
        const {request, operations, recorded} = prepared({
            failCommand: toolPath => toolPath === TOOLCHAIN.genisoimage.path});
        await assert.rejects(runWindowsMsiContainmentPreflight({request}, operations), /seed ISO/iu);
        assert.deepEqual(recorded.removed, [request.root]);
        assert.deepEqual(recorded.launched, []);
    });

    it("fails closed on a guest result the bound identities do not match", async () => {
        for (const [name, overrides] of Object.entries({
            "another guest's serial": {guestSerial: "6".repeat(32)},
            "an old payload that ran": {launchRecords:
                [createWindowsMsiContainmentLaunchRecord(11, {intercepted: false}, NONCE)]}
        })) {
            const {request, operations} = prepared(overrides);
            await assert.rejects(runWindowsMsiContainmentPreflight({request}, operations),
                /containment/iu, name);
        }
        const empty = prepared({guestResultBytes: Buffer.from("{}", "utf8")});
        await assert.rejects(runWindowsMsiContainmentPreflight({request: empty.request},
            empty.operations), /guest result/iu);
    });

    it("binds the guest request to identities the guest never chose", () => {
        const request = hostRequest();
        const guest = guestRequest(request);
        assert.equal(guest.msi.sha256, MSI_SHA);
        assert.equal(guest.helper.sha256, HELPER_SHA);
        assert.equal(guest.msi.productCode, PRODUCT_CODE);
        assert.equal(guest.bindingId, "authentic-1.6.0-default-msi");
        assert.equal(guest.qualifying, false);
        assert.deepEqual(guest.releaseGatesCleared, []);
        assert.equal(guest.nonce, NONCE);
        assert.equal(guest.guest.serial, WINDOWS_MSI_CONTAINMENT_PREFLIGHT_HOST.deriveGuestNonce(NONCE));
        /* Both executables are read from the seed tree the guest stages, not from the host's paths. */
        assert.ok(guest.msi.path.startsWith(guest.guest.seedRoot));
        assert.ok(guest.helper.path.startsWith(guest.guest.seedRoot));
        assert.notEqual(guest.guest.seedRoot, guest.guest.outputRoot);
        assert.throws(() => buildWindowsMsiContainmentPreflightGuestRequest({context: CONTEXT, request,
            powershell: POWERSHELL, qemuLaunchSha256: "not-a-digest"}), /launch/iu);
    });

    it("publishes the derived guest nonce as a function of this run's nonce alone", () => {
        const derived = WINDOWS_MSI_CONTAINMENT_PREFLIGHT_HOST.deriveGuestNonce(NONCE);
        assert.match(derived, /^[0-9a-f]{32}$/u);
        assert.notEqual(derived, NONCE);
        assert.equal(derived, WINDOWS_MSI_CONTAINMENT_PREFLIGHT_HOST.deriveGuestNonce(NONCE));
        assert.notEqual(derived, WINDOWS_MSI_CONTAINMENT_PREFLIGHT_HOST.deriveGuestNonce("8".repeat(32)));
    });

    /*
     * The preflight boots before the matrix budget exists, so its cost is reserved against the same
     * allowances rather than falling through to the launcher's generic 270-minute maximum - which a
     * six-hour job could be spent on entirely before a single row was constructed.
     */
    it("bounds its owned commands and its QEMU by the reservation it holds", async () => {
        const {request, operations, recorded, time} = prepared();
        const originalCommandMilliseconds = recorded.runOwned;
        void originalCommandMilliseconds;
        /* Fourteen minutes gone by the time the seed ISO is written. */
        const observed = await runWindowsMsiContainmentPreflight({request}, {...operations,
            async prepareMedia(value) { time.now = 14 * MINUTE; return operations.prepareMedia(value); }});
        assert.equal(observed.launch.groupZero, true);
        const [launch] = recorded.launched;
        assert.deepEqual(launch.reservation, {label: "containment-preflight",
            executionMilliseconds: MINUTE, cleanupMilliseconds: 2 * MINUTE});
        /* Never the generic default the shared launcher would otherwise apply. */
        assert.notEqual(launch.reservation.executionMilliseconds, 16_200_000);
        /* Commands before the launch got the full two minutes; the one after it, the margin. */
        assert.equal(recorded.commandTimeouts[0], 120_000);
        assert.ok(recorded.commandTimeouts.every(value => value <= 120_000 && value >= 1));
        assert.equal(recorded.commands.findIndex(value => value.includes("mcopy")),
            recorded.commands.length - 2);
    });

    it("never writes media or launches QEMU when the matrix could not follow the preflight", async () => {
        const {request, operations, recorded} = prepared({budget: {jobBudgetMilliseconds: 30 * MINUTE}});
        await assert.rejects(runWindowsMsiContainmentPreflight({request}, operations),
            WindowsMsiContainmentPreflightBudgetError);
        /*
         * The reservation is checked on the very first owned command, so a budget the matrix could
         * not follow costs nothing at all: no overlay, no media, no guest, nothing to clean up.
         */
        assert.deepEqual(recorded.commands, []);
        assert.equal(recorded.launched.length, 0);
        assert.equal(recorded.directories.has(request.root), false);
        assert.deepEqual(recorded.removed, []);
    });

    it("stops before the media it has already begun when the allowance runs out mid-preparation", async () => {
        const {request, operations, recorded, time} = prepared();
        await assert.rejects(runWindowsMsiContainmentPreflight({request}, {...operations,
            async createOverlay(value) {
                const overlay = await operations.createOverlay(value);
                time.now = 15 * MINUTE;
                return overlay;
            }}), WindowsMsiContainmentPreflightBudgetError);
        assert.equal(recorded.commands.some(value => value.includes("genisoimage")), false);
        assert.equal(recorded.launched.length, 0);
        /* It owns an overlay by now, and a preflight that never launched may remove it. */
        assert.deepEqual(recorded.removed, [request.root]);
    });

    it("refuses the launch when the wall clock cannot hold the matrix that must follow", async () => {
        const {request, operations, recorded} = prepared({wallRemainingMilliseconds: 40 * MINUTE});
        await assert.rejects(runWindowsMsiContainmentPreflight({request}, operations),
            WindowsMsiContainmentPreflightBudgetError);
        assert.equal(recorded.launched.length, 0);
    });

    it("refuses to launch once its own allowance is gone", async () => {
        const {request, operations, recorded, time} = prepared();
        await assert.rejects(runWindowsMsiContainmentPreflight({request}, {...operations,
            async prepareMedia(value) {
                const media = await operations.prepareMedia(value);
                time.now = 15 * MINUTE;
                return media;
            }}), WindowsMsiContainmentPreflightBudgetError);
        assert.equal(recorded.launched.length, 0);
    });

    it("requires a reservation it can actually charge", () => {
        const request = hostRequest();
        const guest = guestRequest(request);
        for (const reservation of [undefined, {}, {reserve: () => undefined},
            {reserve: () => undefined, commandMilliseconds: () => 1,
                cleanupCommandMilliseconds: () => 1}])
            assert.throws(() => createWindowsMsiContainmentPreflightOperations({request,
                host: {context: CONTEXT, privilegeMode: "reviewed-sudo-kvm", toolchain: TOOLCHAIN,
                    baseImage: BASE_IMAGE, limits: {outputDiskBytes: OUTPUT_DISK_BYTES}},
                seed: seedFor(request, guest), reservation, dependencies: {}}),
            /reservation differs/u, JSON.stringify(Object.keys(reservation ?? {})));
    });
});
