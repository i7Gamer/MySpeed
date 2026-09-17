import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {describe, it} from "node:test";
import {fileURLToPath} from "node:url";

import {buildWindowsMsiStage2Request} from "../../scripts/qualification/windows-msi-stage2-request.mjs";
import {runHostedStage2Controller} from "../../scripts/qualification/linux-windows-cpu-floor-stage2-controller.mjs";
import {runWindowsCpuFloorStage2, PREDEADLINE_FRAME_UNAVAILABLE_REASONS} from
    "../../scripts/qualification/linux-windows-cpu-floor-stage2.mjs";
import {createHostedStage2Operations, runMonitoredQemu, collectPredeadlineFrameDiagnostic,
    collectMidWindowFramesDiagnostic} from "../../scripts/qualification/linux-windows-cpu-floor-stage2-hosted.mjs";
import {MID_WINDOW_SAMPLE_OFFSETS_MILLISECONDS, MID_WINDOW_FRAME_FILENAMES, WINPE_DIAGNOSTIC_CONFIRMATION} from
    "../../scripts/qualification/linux-windows-cpu-floor-stage2-qmp.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE_ROOT = path.join(HERE, "..", "fixtures", "linux-kvm-privileged-capability-evidence");
const readCanonical = p => Buffer.from(fs.readFileSync(p, "utf8").replace(/\r\n/gu, "\n"), "utf8");
const ordinaryBytes = readCanonical(path.join(EVIDENCE_ROOT, "result.json"));
const combinedBytes = readCanonical(path.join(EVIDENCE_ROOT, "privileged-result.json"));
const context = JSON.parse(ordinaryBytes).context;
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const identity = (pathValue, bytes) => ({path: pathValue, bytes: bytes.length, sha256: digest(bytes)});

function paths() {
    const root = `/home/runner/work/_temp/myspeed-windows-cpu-floor-${context.nonce}`;
    return {root, packageRoot: `${root}/packages`,
        portableRoot: `/tmp/myspeed-windows-cpu-floor-tools-${context.nonce}`, probeRoot: `${root}/probes`,
        windowsIso: `${root}/windows.iso`, installWim: `${root}/install.wim`, seedIso: `${root}/seed.iso`,
        outputDisk: `${root}/output.img`, systemDisk: `${root}/system.qcow2`, ovmfVars: `${root}/OVMF_VARS.fd`,
        serialLog: `${root}/serial.log`, qemuPid: `${root}/qemu.pid`};
}

function observations() {
    return {taskRoot: {path: paths().root, exists: false, parentWritableByCurrentUser: true},
        filesystem: {taskPath: "/home/runner/work/_temp", mountPoint: "/", type: "ext4",
            mountOptions: "rw,relatime", remote: false, availableBlocks: "19816114",
            fragmentSizeBytes: "4096", availableBytes: "81166802944"},
        memory: {memAvailableBytes: "15474245632", selfCgroupPath:
            "/sys/fs/cgroup/system.slice/hosted-compute-agent.service", cgroupLevels: [
            {path: "/sys/fs/cgroup", mountPoint: "/sys/fs/cgroup", mountRoot: "/",
                limitBytes: null, currentBytes: null},
            {path: "/sys/fs/cgroup/system.slice", mountPoint: "/sys/fs/cgroup", mountRoot: "/",
                limitBytes: null, currentBytes: "3436752896"},
            {path: "/sys/fs/cgroup/system.slice/hosted-compute-agent.service",
                mountPoint: "/sys/fs/cgroup", mountRoot: "/", limitBytes: null, currentBytes: "882683904"}],
            cgroupHeadroomBytes: null, effectiveAvailableBytes: "15474245632"}};
}

function fixture() {
    const inputRoot = `/home/runner/work/_temp/myspeed-stage2-input-${context.nonce}`;
    const closureRoot = `/home/runner/work/_temp/myspeed-stage2-closure-${context.nonce}`;
    const closureNames = ["scripts/qualification/linux-windows-cpu-floor-admission.mjs",
        "scripts/qualification/linux-windows-cpu-floor-stage2-controller.mjs",
        "scripts/qualification/linux-windows-cpu-floor-stage2-hosted.mjs",
        "scripts/qualification/linux-windows-cpu-floor-stage2-qmp.mjs",
        "scripts/qualification/linux-windows-cpu-floor-stage2.mjs",
        "scripts/qualification/linux-kvm-capability.mjs",
        "scripts/qualification/linux-kvm-privileged-capability.mjs",
        "scripts/qualification/windows-msi-post-setup-activation.mjs"];
    const contents = new Map([[`${inputRoot}/ordinary.json`, ordinaryBytes],
        [`${inputRoot}/combined.json`, combinedBytes], [`${inputRoot}/artifact.zip`, Buffer.from("archive")],
        [`${inputRoot}/result.json`, Buffer.from("manifest")]]);
    for (const name of closureNames) contents.set(`${closureRoot}/${name}`, Buffer.from(`closure-${name}`));
    const roles = ["avx", "avx2", "cpuid", "illegal", "known-bad", "known-good", "popcnt", "sse42"];
    const files = roles.map((role, index) => {
        const name = `${role.replaceAll("-", "_")}.exe`;
        const bytes = Buffer.from(`probe-${index}`);
        contents.set(`${inputRoot}/${name}`, bytes);
        return {role, name, bytes: String(bytes.length), sha256: digest(bytes)};
    });
    const request = {schemaVersion: 1, context,
        closure: {root: closureRoot, files: closureNames.map(name =>
            identity(`${closureRoot}/${name}`, contents.get(`${closureRoot}/${name}`)))},
        authorization: {confirmation: "RUN-CANDIDATE-NEUTRAL-STAGE2",
        scope: "candidate-neutral-cpu-calibration", media: true, qemu: true}, paths: paths(),
        kvm: {ordinary: identity(`${inputRoot}/ordinary.json`, ordinaryBytes),
            combined: identity(`${inputRoot}/combined.json`, combinedBytes)},
        probeArtifact: {schemaVersion: 1, repository: context.repository, sourceSha: context.sourceSha,
            runId: "34765142461", runAttempt: "1", artifactId: "10300000000",
            artifactName: "windows-cpu-readiness-evidence", archive: {bytes: String(contents.get(`${inputRoot}/artifact.zip`).length),
                sha256: digest(contents.get(`${inputRoot}/artifact.zip`))},
            innerManifest: {name: "result.json", bytes: String(contents.get(`${inputRoot}/result.json`).length),
                sha256: digest(contents.get(`${inputRoot}/result.json`))}, files},
        probeStage: {archive: identity(`${inputRoot}/artifact.zip`, contents.get(`${inputRoot}/artifact.zip`)),
            result: identity(`${inputRoot}/result.json`, contents.get(`${inputRoot}/result.json`)),
            files: files.map(file => identity(`${inputRoot}/${file.name}`, contents.get(`${inputRoot}/${file.name}`)))}};
    return {request, contents};
}

async function runControllerCapturing(request, contents) {
    let forwarded;
    await runHostedStage2Controller(request, {
        readVerified: target => ({bytes: contents.get(target), path: target, sha256: digest(contents.get(target))}),
        collectAdmission: async () => observations(), mkdirExclusive: () => undefined,
        copyExclusive: (source, target) => contents.set(target, contents.get(source)), operations: {},
        runStage2: async input => { forwarded = input; return {status: "observed"}; }
    });
    return forwarded;
}

describe("Positive opt-in: the generic MSI builder stays unaware of the field", () => {
    it("the generic MSI builder never sets midWindowFrames on any authorization it produces", () => {
        const identityFn = target => ({path: target, bytes: 10, sha256: digest(Buffer.from(target))});
        const probe = {sourceSha: "a".repeat(40), runId: "1", runAttempt: "1", artifactId: "1",
            archiveBytes: "10", archiveSha256: digest(Buffer.from("x")),
            files: ["avx", "avx2", "cpuid", "illegal", "known-bad", "known-good", "popcnt", "sse42"]
                .map(role => ({role, name: `${role.replaceAll("-", "_")}.exe`, bytes: "1", sha256: digest(Buffer.from(role))}))};
        const generic = buildWindowsMsiStage2Request({context, probe, identity: identityFn});
        assert.equal(Object.hasOwn(generic.authorization, "midWindowFrames"), false);
    });
    // buildV161PostReleaseCpuFloorStage2Request setting authorization.midWindowFrames === true, through
    // its own real identity-binding machinery, is asserted in tests/server/postReleaseCpuFloor.test.js
    // ("builds a Stage 2 request the real controller admits") rather than duplicated here.
});

describe("Real controller propagation of the positive opt-in", () => {
    it("forwards midWindowFrames: true into the Stage 2 runner input only when the request authorizes it", async () => {
        const {request, contents} = fixture();
        const disabled = await runControllerCapturing(request, contents);
        assert.equal(disabled.midWindowFrames, undefined);

        const enabledFixture = fixture();
        enabledFixture.request.authorization.midWindowFrames = true;
        const enabled = await runControllerCapturing(enabledFixture.request, enabledFixture.contents);
        assert.equal(enabled.midWindowFrames, true);
    });

    it("rejects a malformed midWindowFrames value at the controller boundary", async () => {
        for (const bad of [false, "true", 1, {}, null]) {
            const {request} = fixture();
            request.authorization.midWindowFrames = bad;
            await assert.rejects(runHostedStage2Controller(request), /mid-window/iu);
        }
    });
});

describe("Real Stage 2 runner propagation to the launcher input", () => {
    it("forwards midWindowFrames only on the ordinary diagnostic path, never a malformed value", async () => {
        let captured = null;
        const operations = {
            resolveSignedPackageClosure: async () => { throw new Error("stop before package closure"); }
        };
        // runWindowsCpuFloorStage2 validates midWindowFrames before doing any expensive work, so a
        // malformed value throws before operations are ever touched.
        await assert.rejects(runWindowsCpuFloorStage2({context, admission: {admitted: true}, paths: paths(),
            probeArtifact: {}, midWindowFrames: "true"}, {...operations,
            acquirePackages: async () => ({}), acquireProbeClosure: async () => ({}), acquireWindowsIso: async () => ({}),
            extractInstallWim: async () => ({}), extractPortableTools: async () => ({}), inspectInstallWim: async () => ({}),
            launchOwnedQemu: async input => { captured = input; return {}; }, prepareOfflineMedia: async () => ({})}),
            /mid-window/iu);
        assert.equal(captured, null);
    });

    it("rejects midWindowFrames combined with a WinPE diagnostic authorization before touching any operation", async () => {
        let touched = false;
        await assert.rejects(runWindowsCpuFloorStage2({context, admission: {admitted: true}, paths: paths(),
            probeArtifact: {}, midWindowFrames: true,
            winpeDiagnostic: {confirmation: WINPE_DIAGNOSTIC_CONFIRMATION, nonce: context.nonce},
            admitWinpeDiagnostic: () => ({reservation: {label: "windows-msi-winpe-diagnostic",
                executionMilliseconds: 120_000, cleanupMilliseconds: 30_000}, collectionDeadlineMilliseconds: 1_000})},
            {resolveSignedPackageClosure: async () => { touched = true; throw new Error("must not be reached"); }}),
            /mid-window frames cannot combine/u);
        assert.equal(touched, false);
    });
});

describe("Real hosted launcher: isMidWindowActive gate and QMP scheduling wiring", () => {
    const rootFileIdentity = target => ({path: target, bytes: "100", sha256: "0".repeat(64),
        ownership: {uid: "0", gid: "0", mode: "755", ordinaryUserWritable: false}});
    const commandIdentity = target => ({path: target, invocationPath: target, bytes: "100", sha256: "0".repeat(64),
        ownership: {uid: "0", gid: "0", mode: "755", ordinaryUserWritable: false}});
    const directoryIdentity = target => ({path: target, dev: "1", ino: target === "/tmp" ? "1" : "2", uid: "0",
        gid: "0", mode: target === "/tmp" ? "1777" : "755", ordinaryUserWritable: target === "/tmp",
        sticky: target === "/tmp"});
    const contextObj = {schemaVersion: 1, repository: "i7Gamer/MySpeed", sourceSha: "a".repeat(40),
        eventSha: "b".repeat(40), runId: "123", runAttempt: "1", nonce: context.nonce, environment: {
            GITHUB_ACTIONS: "true", CI: "true", RUNNER_OS: "Linux", RUNNER_ARCH: "X64",
            RUNNER_ENVIRONMENT: "github-hosted", ImageOS: "ubuntu24", ImageVersion: "20260907.1"}};
    const toolchainObj = {
        runtime: {loader: rootFileIdentity("/tmp/tools/ld.so"), libraryPath: ["/tmp/tools"]},
        qemu: commandIdentity("/tmp/tools/qemu-system-x86_64"),
        firmware: {searchPath: "/tmp/tools", kvmvapic: rootFileIdentity("/tmp/tools/kvmvapic.bin"),
            vga: rootFileIdentity("/tmp/tools/vgabios-stdvga.bin")},
        ovmfVarsTemplate: rootFileIdentity("/tmp/tools/OVMF_VARS.fd")
    };
    const pathsObj = {...paths(), portableRoot: "/tmp/tools"};

    function fakeIoFor(capture) {
        return {
            inspectOwned: rootFileIdentity, inspectDirectory: directoryIdentity,
            monotonicMilliseconds: () => 1_000, pathExists: () => false,
            validateOutputDisk: () => null,
            runMonitoredQemu: async req => { capture.request = req; return {
                observation: {process: {exitCode: 0, signal: null, timedOut: false, cleanupProven: true,
                    stdoutOverflow: false, stderrOverflow: false, errorObserved: false},
                    stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)},
                identity: {pid: 12345, startTicks: "100", executablePath: "/tmp/tools/ld.so", processGroupId: 12345},
                absentAfter: true, processGroupGone: true, terminationReason: null};
            }
        };
    }

    it("enables mid-window scheduling only when midWindowFrames is true on the ordinary diagnostic path", async () => {
        const capture = {};
        const ops = createHostedStage2Operations({context: contextObj, paths: pathsObj, dependencies: fakeIoFor(capture)});
        await ops.launchOwnedQemu({toolchain: toolchainObj, paths: pathsObj, argv: ["-m", "4G"],
            privilegeMode: "ordinary-kvm", deadlines: {executionMinutes: 25, cleanupMinutes: 5}, midWindowFrames: true});
        assert.ok(capture.request.qmp.midWindow);
        assert.deepEqual(capture.request.qmp.midWindow.screenshotPaths,
            MID_WINDOW_FRAME_FILENAMES.map(name => `${pathsObj.root}/${name}`));
    });

    it("does not schedule mid-window capture when midWindowFrames is absent, even on the ordinary diagnostic path", async () => {
        const capture = {};
        const ops = createHostedStage2Operations({context: contextObj, paths: pathsObj, dependencies: fakeIoFor(capture)});
        await ops.launchOwnedQemu({toolchain: toolchainObj, paths: pathsObj, argv: ["-m", "4G"],
            privilegeMode: "ordinary-kvm", deadlines: {executionMinutes: 25, cleanupMinutes: 5}});
        assert.equal(Object.hasOwn(capture.request.qmp, "midWindow"), false);
    });

    it("does not schedule mid-window capture on a reserved (Stage 3 preflight) launch even if midWindowFrames is true", async () => {
        const capture = {};
        const ops = createHostedStage2Operations({context: contextObj, paths: pathsObj, dependencies: fakeIoFor(capture)});
        await ops.launchOwnedQemu({toolchain: toolchainObj, paths: pathsObj, argv: ["-m", "4G"],
            privilegeMode: "ordinary-kvm", midWindowFrames: true,
            reservation: {label: "containment-preflight", executionMilliseconds: 120_000, cleanupMilliseconds: 30_000}});
        assert.equal(Object.hasOwn(capture.request.qmp, "midWindow"), false);
    });

    it("rejects a malformed midWindowFrames value at the launcher boundary too", async () => {
        const capture = {};
        const ops = createHostedStage2Operations({context: contextObj, paths: pathsObj, dependencies: fakeIoFor(capture)});
        await assert.rejects(ops.launchOwnedQemu({toolchain: toolchainObj, paths: pathsObj, argv: ["-m", "4G"],
            privilegeMode: "ordinary-kvm", deadlines: {executionMinutes: 25, cleanupMinutes: 5}, midWindowFrames: "yes"}),
            /mid-window/iu);
    });

    it("rejects midWindowFrames combined with a WinPE diagnostic authorization at the launcher boundary too", async () => {
        const capture = {};
        const ops = createHostedStage2Operations({context: contextObj, paths: pathsObj, dependencies: fakeIoFor(capture)});
        await assert.rejects(ops.launchOwnedQemu({toolchain: toolchainObj, paths: pathsObj, argv: ["-m", "4G"],
            privilegeMode: "ordinary-kvm", midWindowFrames: true,
            winpeDiagnostic: {confirmation: WINPE_DIAGNOSTIC_CONFIRMATION, nonce: contextObj.nonce}}),
            /mid-window frames cannot combine/u);
    });
});

describe("Enabled-state finalization: session-unavailable fallback when the callback never arrives", () => {
    it("finalizes both slots as unavailable/session-unavailable when mid-window is requested but QMP never reports it", async () => {
        const monitored = await runMonitoredQemu({
            monotonicMilliseconds: () => 0,
            createOwnedPidFile: () => null,
            runOwned: async () => ({process: {exitCode: 1, signal: null, timedOut: true, stdoutOverflow: false,
                stderrOverflow: false, cleanupProven: true, errorObserved: false},
                stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)}),
            isProcessGroupAlive: () => false,
            readQemuProcessIdentity: async () => ({state: "absent"}),
            wait: async () => undefined
        }, {
            command: "/bin/true", argv: [], timeoutMs: 1_000, pidPath: "/tmp/does-not-exist.pid",
            expectedExecutable: "/tmp/tools/ld.so", maxStreamBytes: 1_024,
            // request.qmp.midWindow present (feature requested) but the fake runOwned never calls
            // onMidWindowObservation - simulating early QMP failure before the optional phase starts.
            qmp: {screenshotPaths: ["a", "b"], midWindow: {screenshotPaths: MID_WINDOW_FRAME_FILENAMES,
                executionDeadline: 1_500_000}}
        });
        assert.equal(Array.isArray(monitored.midWindowFrames), true);
        assert.equal(monitored.midWindowFrames.length, 2);
        for (const [index, entry] of monitored.midWindowFrames.entries()) {
            assert.deepEqual(entry, {schemaVersion: 1, status: "unavailable",
                nominalOffsetMs: MID_WINDOW_SAMPLE_OFFSETS_MILLISECONDS[index], reason: "session-unavailable"});
        }
        assert.equal(Object.isFrozen(monitored.midWindowFrames), true);
        for (const entry of monitored.midWindowFrames) assert.equal(Object.isFrozen(entry), true);
    });

    it("retains a slot already captured when the process settles before the other slot reports, and " +
        "closes only the unresolved slot as session-unavailable", async () => {
        let lateArrival = null;
        const monitored = await runMonitoredQemu({
            monotonicMilliseconds: () => 0,
            createOwnedPidFile: () => null,
            runOwned: async (command, argv, options) => {
                lateArrival = options.onMidWindowFrame;
                // Slot 1 reports before the process settles; slot 2 never gets the chance to.
                options.onMidWindowFrame(0, {schemaVersion: 1, status: "captured", nominalOffsetMs: 600_000,
                    offsetMs: 600_000, screenshotPath: "mid-window-frame-1.png"});
                return {process: {exitCode: 0, signal: null, timedOut: false, stdoutOverflow: false,
                    stderrOverflow: false, cleanupProven: true, errorObserved: false},
                    stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)};
            },
            isProcessGroupAlive: () => false,
            readQemuProcessIdentity: async () => ({state: "absent"}),
            wait: async () => undefined
        }, {
            command: "/bin/true", argv: [], timeoutMs: 1_000, pidPath: "/tmp/does-not-exist.pid",
            expectedExecutable: "/tmp/tools/ld.so", maxStreamBytes: 1_024,
            qmp: {screenshotPaths: ["a", "b"], midWindow: {screenshotPaths: MID_WINDOW_FRAME_FILENAMES,
                executionDeadline: 1_500_000}}
        });

        assert.deepEqual(monitored.midWindowFrames[0], {schemaVersion: 1, status: "captured",
            nominalOffsetMs: 600_000, offsetMs: 600_000, screenshotPath: "mid-window-frame-1.png"});
        assert.deepEqual(monitored.midWindowFrames[1], {schemaVersion: 1, status: "unavailable",
            nominalOffsetMs: 900_000, reason: "session-unavailable"});

        // A late callback for the already-closed slot, arriving after finalization, must be dropped:
        // nothing about the returned snapshot may change.
        lateArrival(1, {schemaVersion: 1, status: "captured", nominalOffsetMs: 900_000,
            offsetMs: 900_000, screenshotPath: "mid-window-frame-2.png"});
        assert.deepEqual(monitored.midWindowFrames[1], {schemaVersion: 1, status: "unavailable",
            nominalOffsetMs: 900_000, reason: "session-unavailable"});
    });

    it("returns null (not a fallback array) when mid-window was never requested at all", async () => {
        const monitored = await runMonitoredQemu({
            monotonicMilliseconds: () => 0,
            createOwnedPidFile: () => null,
            runOwned: async () => ({process: {exitCode: 0, signal: null, timedOut: false, stdoutOverflow: false,
                stderrOverflow: false, cleanupProven: true, errorObserved: false},
                stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)}),
            isProcessGroupAlive: () => false,
            readQemuProcessIdentity: async () => ({state: "absent"}),
            wait: async () => undefined
        }, {command: "/bin/true", argv: [], timeoutMs: 1_000, pidPath: "/tmp/does-not-exist.pid",
            expectedExecutable: "/tmp/tools/ld.so", maxStreamBytes: 1_024});
        assert.equal(monitored.midWindowFrames, null);
    });
});

describe("Predeadline's collected/replay reason contract preserves reader-unavailable", () => {
    it("collectPredeadlineFrameDiagnostic returns the disclosed reader-unavailable reason unchanged", () => {
        const result = collectPredeadlineFrameDiagnostic({}, {paths: paths()},
            {status: "unavailable", reason: "reader-unavailable"}, true);
        assert.deepEqual(result, {schemaVersion: 1, status: "unavailable", reason: "reader-unavailable"});
    });

    it("the replay-accepted reason enum includes reader-unavailable", () => {
        assert.equal(PREDEADLINE_FRAME_UNAVAILABLE_REASONS.includes("reader-unavailable"), true);
    });
});

describe("Mid-window collector fails closed on a byte-count/identity mismatch", () => {
    it("reports malformed/read-cap-exceeded when the reported byte identity does not match what was read", () => {
        const targetPath = `${paths().root}/${MID_WINDOW_FRAME_FILENAMES[0]}`;
        const io = {
            pathExists: () => true,
            readOwnedVerified: () => ({bytes: Buffer.from("hello"),
                identity: {path: targetPath, bytes: "999", sha256: "0".repeat(64)}})
        };
        const midWindowState = [
            {status: "captured", screenshotPath: targetPath, offsetMs: 600_000},
            {status: "skipped", reason: "insufficient-time"}
        ];
        const result = collectMidWindowFramesDiagnostic(io, {paths: paths()}, midWindowState, true);
        assert.equal(result[0].status, "malformed");
        assert.equal(result[0].reason, "read-cap-exceeded");
        assert.equal(result[0].bytes, "5");
    });
});
