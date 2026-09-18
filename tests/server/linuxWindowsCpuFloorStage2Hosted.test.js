import assert from "node:assert/strict";
import crypto from "node:crypto";
import {EventEmitter} from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {describe, it} from "node:test";
import {PassThrough} from "node:stream";

import {
    DIAGNOSTIC_CLEANUP_HEADROOM_SECONDS,
    DIAGNOSTIC_CLEANUP_MINUTES,
    DIAGNOSTIC_EXECUTION_MINUTES,
    DIAGNOSTIC_OUTER_TIMEOUT_MILLISECONDS,
    DIAGNOSTIC_TIMEOUT_SECONDS,
    buildIsolatedAptVectors,
    collectHostedAdmissionObservations,
    createHostedQemuProcessLauncher,
    createHostedCpuFloorCleanupOperations,
    createHostedStage2Operations,
    cpuFloorCleanupAuthorityPath,
    defaultReadOwnedPrefixVerified,
    defaultValidateOutputDisk,
    parseInReleaseIndexes,
    parseGuestFailure,
    parseGuestOutcome,
    parseGuestOutput,
    parseProbeArtifactEvidence,
    parseWimInfo,
    measureOwnedTreeBytes,
    observeHostedRuntimeResources,
    resolveSelectedDependencies,
    runHostedOwnedProcess,
    runMonitoredQemu,
    MAX_SERIAL_OBSERVATION_BYTES,
    createSerialCompletionObserver,
    defaultReadOwnedRangeVerified,
} from "../../scripts/qualification/linux-windows-cpu-floor-stage2-hosted.mjs";
import {COMPLETION_RECORD_PREFIX, MAX_COMPLETION_RECORD_BYTES} from
    "../../scripts/qualification/windows-baseline-guest-bootstrap.mjs";
import {STAGE2_PROVENANCE, TOP_LEVEL_PACKAGE_PINS, WINDOWS_SYSTEM_TOOL_PATHS,
    WINPE_DIAGNOSTIC_OUTPUT_MARKER_NAME, winpeDiagnosticOutputMarker} from
    "../../scripts/qualification/linux-windows-cpu-floor-stage2.mjs";
import {WINPE_DIAGNOSTIC_CONFIRMATION} from
    "../../scripts/qualification/linux-windows-cpu-floor-stage2-qmp.mjs";
import {buildWindowsMsiSetupCompleteActivation, getCompletedWindowsMsiActivationEvidence} from
    "../../scripts/qualification/windows-msi-post-setup-activation.mjs";

const NONCE = "0123456789abcdef0123456789abcdef";
const PIDFILE_IDENTITY = {path: paths().qemuPid, dev: "11", ino: "22", uid: "1001", gid: "1001", mode: "600"};
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const SERIAL_CAPTURE_BYTES = 65_536;
const INVALID_SERIAL_CAPTURE_BYTES = 0;
const BOOT_CONFIRMATION = "single-enter-before-setup-v1";
const bootInput = () => ({kind: "installer-boot-confirmation", qcode: "ret", holdMilliseconds: 100,
    requestedOffsetMilliseconds: 2000, sentOffsetMilliseconds: 2001, acknowledged: true});
const SERIAL_AT_CAP_BYTE = 0x61;
const SERIAL_OVER_CAP_BYTE = 0x62;
const CAPTURED_PROBE_BUILD = JSON.parse(fs.readFileSync(new URL(
    "../fixtures/linux-windows-cpu-floor-stage2/probe-build-34834310907.json", import.meta.url), "utf8"));

function context() {
    return {schemaVersion: 1, repository: "i7Gamer/MySpeed", sourceSha: "a".repeat(40), eventSha: "b".repeat(40),
        runId: "123", runAttempt: "1", nonce: NONCE, environment: {GITHUB_ACTIONS: "true", CI: "true",
            RUNNER_OS: "Linux", RUNNER_ARCH: "X64", RUNNER_ENVIRONMENT: "github-hosted", ImageOS: "ubuntu24",
            ImageVersion: "20260907.1"}};
}

function paths() {
    const root = `/home/runner/work/_temp/myspeed-windows-cpu-floor-${NONCE}`;
    return {root, packageRoot: `${root}/packages`, portableRoot: `/tmp/myspeed-windows-cpu-floor-tools-${NONCE}`,
        probeRoot: `${root}/probes`,
        windowsIso: `${root}/windows.iso`, installWim: `${root}/install.wim`, seedIso: `${root}/seed.iso`,
        outputDisk: `${root}/output.img`, systemDisk: `${root}/system.qcow2`, ovmfVars: `${root}/OVMF_VARS.fd`,
        serialLog: `${root}/serial.log`, qemuPid: `${root}/qemu.pid`};
}

const activationEvidence = () => { const value = context(); return getCompletedWindowsMsiActivationEvidence(
    buildWindowsMsiSetupCompleteActivation({repository: value.repository, sourceSha: value.sourceSha,
        eventSha: value.eventSha, runId: value.runId, runAttempt: value.runAttempt, nonce: value.nonce})); };
const systemTools = () => WINDOWS_SYSTEM_TOOL_PATHS.map((tool, index) => ({...tool, bytes: String(index + 1),
    sha256: String(index + 1).repeat(64)}));

function successfulGuestOutput() {
    const cpuid = {schemaVersion: 1, kind: "cpuid", maxBasicLeaf: 7,
        leaf1: {eax: "0x00000000", ebx: "0x00000000", ecx: "0x00900000", edx: "0x00000000"},
        leaf7Subleaf0: {eax: "0x00000000", ebx: "0x00000000", ecx: "0x00000000", edx: "0x00000000"},
        xcr0: null, features: {sse42: true, popcnt: true, osxsave: false, avx: false, avx2: false}};
    const output = role => Buffer.from(JSON.stringify({schemaVersion: 1, kind: role,
        result: {"known-good": 42, "known-bad": 13, sse42: 2_276_049_685, popcnt: 32}[role]}) + "\n")
        .toString("base64");
    const runs = [{role: "cpuid", exitCode: 0,
        stdoutBase64: Buffer.from(JSON.stringify(cpuid) + "\n").toString("base64"), stderrBase64: ""},
    ...["known-good", "known-bad", "sse42", "popcnt"].map(role => ({role,
        exitCode: role === "known-bad" ? 19 : 0, stdoutBase64: output(role), stderrBase64: ""})),
    ...["illegal", "avx", "avx2"].map(role => ({role, exitCode: 3_221_225_501,
        stdoutBase64: "", stderrBase64: ""}))];
    return {schemaVersion: 1, nonce: NONCE, runs,
        network: {hardwareNics: 0, enabledNonLoopbackInterfaces: 0, nonLoopbackRoutes: 0},
        activation: activationEvidence(), systemTools: systemTools()};
}

function qmpObservation() {
    return {version: {major: 8, minor: 2, micro: 2}, status: "running", running: true,
        screenshotPaths: [`${paths().root}/early-boot-1.png`, `${paths().root}/early-boot-2.png`], inputSent: false};
}

const screenshotRead = target => ({bytes: PNG, identity: {path: target, bytes: String(PNG.length),
    sha256: crypto.createHash("sha256").update(PNG).digest("hex")}});
const qemuFirmware = () => ({searchPath: `${paths().portableRoot}/usr/share/qemu`,
    kvmvapic: rootFileIdentity(`${paths().portableRoot}/usr/share/qemu/kvmvapic.bin`),
    vga: rootFileIdentity(`${paths().portableRoot}/usr/share/seabios/vgabios-stdvga.bin`)});

const okProcess = {exitCode: 0, signal: null, timedOut: false, stdoutOverflow: false, stderrOverflow: false,
    cleanupProven: true, errorObserved: false};
const directoryIdentity = target => ({path: target, dev: "1", ino: target === "/tmp" ? "1" : "2", uid: "0",
    gid: "0", mode: target === "/tmp" ? "1777" : "755", ordinaryUserWritable: target === "/tmp",
    sticky: target === "/tmp"});
const rootFileIdentity = target => ({path: target, bytes: "4096", sha256: "f".repeat(64),
    ownership: {uid: "0", gid: "0", mode: "555", ordinaryUserWritable: false}});
const commandIdentity = target => ({...rootFileIdentity(target), invocationPath: target});

describe("hosted Stage 2 native adapter preparation", () => {
    it("reads a verified bounded serial prefix and reports unavailable files without leaking errors", t => {
        const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-stage2-serial-"));
        t.after(() => fs.rmSync(temporaryRoot, {recursive: true, force: true}));
        const serialPath = path.join(temporaryRoot, "serial.log");

        fs.writeFileSync(serialPath, Buffer.alloc(SERIAL_CAPTURE_BYTES, SERIAL_AT_CAP_BYTE));
        const atCap = defaultReadOwnedPrefixVerified(serialPath, SERIAL_CAPTURE_BYTES, {allowEmpty: true});
        assert.equal(atCap.bytes.length, SERIAL_CAPTURE_BYTES);
        assert.equal(atCap.identity.observedBytes, String(SERIAL_CAPTURE_BYTES));
        assert.equal(atCap.identity.truncated, false);

        fs.writeFileSync(serialPath, Buffer.alloc(SERIAL_CAPTURE_BYTES + 1, SERIAL_OVER_CAP_BYTE));
        const overCap = defaultReadOwnedPrefixVerified(serialPath, SERIAL_CAPTURE_BYTES, {allowEmpty: true});
        assert.equal(overCap.bytes.length, SERIAL_CAPTURE_BYTES);
        assert.equal(overCap.identity.observedBytes, String(SERIAL_CAPTURE_BYTES + 1));
        assert.equal(overCap.identity.truncated, true);

        fs.writeFileSync(serialPath, Buffer.alloc(0));
        const empty = defaultReadOwnedPrefixVerified(serialPath, SERIAL_CAPTURE_BYTES, {allowEmpty: true});
        assert.equal(empty.bytes.length, 0);
        assert.equal(empty.identity.observedBytes, "0");
        assert.equal(empty.identity.truncated, false);
        assert.throws(() => defaultReadOwnedPrefixVerified(path.join(temporaryRoot, "missing.log"),
            SERIAL_CAPTURE_BYTES, {allowEmpty: true}));
        assert.throws(() => defaultReadOwnedPrefixVerified(temporaryRoot, SERIAL_CAPTURE_BYTES, {allowEmpty: true}));
        assert.throws(() => defaultReadOwnedPrefixVerified(serialPath, INVALID_SERIAL_CAPTURE_BYTES,
            {allowEmpty: true}));
        const hardLinkPath = path.join(temporaryRoot, "serial-hard-link.log");
        fs.writeFileSync(serialPath, Buffer.from("serial"));
        fs.linkSync(serialPath, hardLinkPath);
        assert.throws(() => defaultReadOwnedPrefixVerified(serialPath, SERIAL_CAPTURE_BYTES, {allowEmpty: true}));
    });

    it("uses the bounded reviewed-sudo adapter for root-owned cleanup groups", async () => {
        const calls = [];
        const cleanup = createHostedCpuFloorCleanupOperations({
            inspectOwned: target => ({path: target, ownership: {uid: "0", ordinaryUserWritable: false}}),
            readProcessIdentity: pid => ({state: "present", pid, processGroupId: pid, startTicks: "66",
                executablePath: "/owned/timeout"}),
            runOwned: async (command, argv, options) => { calls.push({command, argv, options});
                return {process: okProcess, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)}; }
        });
        assert.equal((await cleanup.readProcessIdentity(2300)).startTicks, "66");
        await cleanup.signalProcessGroup(2300, "SIGTERM");
        assert.equal(calls[0].command, "/usr/bin/sudo");
        assert.deepEqual(calls[0].argv.slice(-4), ["/usr/bin/kill", "-TERM", "--", "-2300"]);
    });

    it("accepts only bounded fail-closed guest bootstrap diagnostics", () => {
        const value = {schemaVersion: 1, status: "failed", nonce: NONCE, stage: "guest-bootstrap",
            failure: "probe execution failed"};
        assert.deepEqual(parseGuestFailure(Buffer.from(JSON.stringify(value)), NONCE), value);
        assert.deepEqual(parseGuestOutcome(Buffer.from(JSON.stringify(value)), NONCE), value);
        for (const mutate of [
            record => { record.status = "observed"; },
            record => { record.nonce = "f".repeat(32); },
            record => { record.failure = "bad\nmessage"; },
            record => { record.extra = true; }
        ]) {
            const changed = structuredClone(value);
            mutate(changed);
            assert.throws(() => parseGuestFailure(Buffer.from(JSON.stringify(changed)), NONCE), /failure evidence/i);
        }
    });

    it("drains outputs larger than the Stage 1 cap under a fixed Stage 2 bound", async () => {
        const output = Buffer.alloc(20_000, 0x61);
        const child = new EventEmitter();
        child.pid = 123;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        const observation = await runHostedOwnedProcess("/owned/tool", [], {timeoutMs: 1_000}, {
            spawnImpl: () => {
                queueMicrotask(() => { child.stdout.write(output); child.emit("close", 0, null); });
                return child;
            }, isGroupAlive: () => false
        });
        assert.equal(observation.process.stdoutOverflow, false);
        assert.deepEqual(observation.stdout, output);
    });

    it("hands a lingering owned group to the external privileged cleanup owner without hanging", async () => {
        const child = new EventEmitter();
        child.pid = 321;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        const pending = runHostedOwnedProcess("/owned/tool", [], {timeoutMs: 1_000,
            onTerminationRequested: reason => { assert.equal(reason, "lingering-process-group"); return true; }}, {
            spawnImpl: () => { queueMicrotask(() => child.emit("close", 0, null)); return child; },
            isGroupAlive: () => true
        });
        const observation = await pending;
        assert.equal(observation.process.cleanupProven, false);
    });

    it("settles an unsuccessful external cleanup handoff at the cleanup deadline", async () => {
        const child = new EventEmitter();
        child.pid = 322; child.stdout = new PassThrough(); child.stderr = new PassThrough();
        const timers = [];
        const pending = runHostedOwnedProcess("/owned/tool", [], {timeoutMs: 1_000,
            onTerminationRequested: reason => { assert.equal(reason, "deadline"); return true; }}, {
            spawnImpl: () => child, setTimer: callback => { timers.push(callback); return timers.length; },
            clearTimer: () => undefined, isGroupAlive: () => true
        });
        timers[0]();
        assert.equal(timers.length, 2);
        timers[1]();
        assert.equal((await pending).process.cleanupProven, false);
    });

    it("exposes a bounded settlement request for an independently detected monitor failure", async () => {
        const child = new EventEmitter();
        child.pid = 323; child.stdout = new PassThrough(); child.stderr = new PassThrough();
        const timers = [];
        let requestSettlement = null;
        const pending = runHostedOwnedProcess("/owned/tool", [], {timeoutMs: 1_000,
            onTerminationRequested: reason => { assert.equal(reason, "monitor-low-memory"); return true; },
            onTerminationReady: request => { requestSettlement = request; }}, {
            spawnImpl: () => child, setTimer: callback => { timers.push(callback); return timers.length; },
            clearTimer: () => undefined, isGroupAlive: () => true
        });
        assert.equal(typeof requestSettlement, "function");
        requestSettlement("monitor-low-memory");
        assert.equal(timers.length, 2);
        timers[1]();
        assert.equal((await pending).process.cleanupProven, false);
    });

    it("settles after a monitor-triggered privileged teardown failure", async () => {
        let finish;
        const operation = new Promise(resolve => { finish = resolve; });
        let settlementReason = null;
        let clock = 0;
        const result = await runMonitoredQemu({
            runOwned: (command, argv, options) => {
                options.onSpawn(2300);
                options.onTerminationReady(reason => {
                    settlementReason = reason;
                    finish({process: {...okProcess, exitCode: null, cleanupProven: false}, stdout: Buffer.alloc(0),
                        stderr: Buffer.alloc(0)});
                });
                return operation;
            },
            pathExists: () => true,
            readOwnedVerified: () => ({bytes: Buffer.from("2345\n")}),
            readQemuProcessIdentity: () => ({state: "present", pid: 2345, processGroupId: 2300,
                startTicks: "77", executablePath: "/owned/loader"}),
            observeRuntimeResources: () => ({taskBytes: "1", freeBytes: "90000000000",
                effectiveMemoryBytes: "4294967295"}),
            monotonicMilliseconds: () => clock,
            wait: async milliseconds => { clock += milliseconds; },
            isProcessGroupAlive: () => true,
            terminateQemuGroup: async () => false
        }, {command: "/usr/bin/sudo", argv: [], timeoutMs: 1_000, maxStreamBytes: 1_024,
            pidPath: "/owned/qemu.pid", expectedExecutable: "/owned/loader", executionDeadline: 100_000,
            resources: {taskPath: "/owned", roots: ["/owned"]}});
        assert.equal(settlementReason, "monitor-low-memory");
        assert.equal(result.terminationReason, "low-memory");
        assert.equal(result.observation.process.cleanupProven, false);
    });

    it("terminates fast when the guest serial console shows a drop to the UEFI shell", async () => {
        let finish;
        const operation = new Promise(resolve => { finish = resolve; });
        let settlementReason = null;
        let clock = 0;
        const serial = Buffer.from('BdsDxe: loading Boot0003 "EFI Internal Shell"\r\nUEFI Interactive Shell v2.2\r\nShell> ');
        const result = await runMonitoredQemu({
            runOwned: (command, argv, options) => {
                options.onSpawn(2300);
                options.onTerminationReady(reason => {
                    settlementReason = reason;
                    finish({process: {...okProcess, exitCode: 137, cleanupProven: false}, stdout: Buffer.alloc(0),
                        stderr: Buffer.alloc(0)});
                });
                return operation;
            },
            pathExists: () => true,
            readOwnedVerified: () => ({bytes: Buffer.from("2345\n")}),
            readOwnedPrefixVerified: () => ({bytes: serial, identity: {bytes: String(serial.length),
                sha256: "a".repeat(64), observedBytes: String(serial.length), truncated: false}}),
            readQemuProcessIdentity: () => ({state: "present", pid: 2345, processGroupId: 2300,
                startTicks: "77", executablePath: "/owned/loader"}),
            observeRuntimeResources: () => ({taskBytes: "1", freeBytes: "90000000000",
                effectiveMemoryBytes: "8589934592"}),
            monotonicMilliseconds: () => clock,
            wait: async milliseconds => { clock += milliseconds; },
            isProcessGroupAlive: () => true,
            terminateQemuGroup: async () => false
        }, {command: "/usr/bin/sudo", argv: [], timeoutMs: 1_000, maxStreamBytes: 1_024,
            pidPath: "/owned/qemu.pid", expectedExecutable: "/owned/loader", executionDeadline: 100_000,
            serialLogPath: "/owned/serial.log", resources: {taskPath: "/owned", roots: ["/owned"]}});
        assert.equal(result.terminationReason, "efi-shell-fallback");
        assert.equal(settlementReason, "monitor-efi-shell-fallback");
        // Fired on the first poll tick, before any wait advanced the clock toward the deadline.
        assert.equal(clock, 0);
    });

    it("keeps monitoring when the serial console shows an ordinary boot line", async () => {
        let finish;
        const operation = new Promise(resolve => { finish = resolve; });
        let clock = 0;
        const serial = Buffer.from("BdsDxe: loading Boot0001 UEFI QEMU DVD-ROM\r\n");
        const result = await runMonitoredQemu({
            runOwned: (command, argv, options) => {
                options.onSpawn(2300);
                options.onTerminationReady(() => {
                    finish({process: {...okProcess, exitCode: 137, cleanupProven: false}, stdout: Buffer.alloc(0),
                        stderr: Buffer.alloc(0)});
                });
                return operation;
            },
            pathExists: () => true,
            readOwnedVerified: () => ({bytes: Buffer.from("2345\n")}),
            readOwnedPrefixVerified: () => ({bytes: serial, identity: {bytes: String(serial.length),
                sha256: "a".repeat(64), observedBytes: String(serial.length), truncated: false}}),
            readQemuProcessIdentity: () => ({state: "present", pid: 2345, processGroupId: 2300,
                startTicks: "77", executablePath: "/owned/loader"}),
            observeRuntimeResources: () => ({taskBytes: "1", freeBytes: "90000000000",
                effectiveMemoryBytes: "8589934592"}),
            monotonicMilliseconds: () => clock,
            wait: async milliseconds => { clock += milliseconds; },
            isProcessGroupAlive: () => true,
            terminateQemuGroup: async () => false
        }, {command: "/usr/bin/sudo", argv: [], timeoutMs: 1_000, maxStreamBytes: 1_024,
            pidPath: "/owned/qemu.pid", expectedExecutable: "/owned/loader", executionDeadline: 100_000,
            serialLogPath: "/owned/serial.log", resources: {taskPath: "/owned", roots: ["/owned"]}});
        assert.equal(result.terminationReason, "deadline");
    });

    it("terminates and settles when the process-group observer throws", async () => {
        let finish;
        const operation = new Promise(resolve => { finish = resolve; });
        let clock = 0;
        let terminationCalls = 0;
        let settlementReason = null;
        const result = await runMonitoredQemu({
            runOwned: (command, argv, options) => {
                options.onSpawn(2300);
                options.onTerminationReady(reason => {
                    settlementReason = reason;
                    finish({process: {...okProcess, exitCode: 137, cleanupProven: false}, stdout: Buffer.alloc(0),
                        stderr: Buffer.alloc(0)});
                });
                return operation;
            },
            pathExists: () => false,
            monotonicMilliseconds: () => { clock += 31_000; return clock; },
            wait: async () => undefined,
            isProcessGroupAlive: () => { throw new Error("process-group observation failed"); },
            terminateQemuGroup: async request => { assert.equal(request.processGroupId, 2300);
                terminationCalls += 1; return false; }
        }, {command: "/usr/bin/sudo", argv: [], timeoutMs: 1_000, maxStreamBytes: 1_024,
            pidPath: "/owned/qemu.pid", expectedExecutable: "/owned/loader", executionDeadline: 100_000,
            resources: {taskPath: "/owned", roots: ["/owned"]}});
        assert.equal(terminationCalls, 1);
        assert.equal(settlementReason, "monitor-identity-timeout");
        assert.equal(result.terminationReason, "identity-timeout");
        assert.equal(result.observation.process.cleanupProven, false);
    });

    it("retains a bounded sanitized identity-observer failure for launch diagnosis", async () => {
        let finish;
        const operation = new Promise(resolve => { finish = resolve; });
        const result = await runMonitoredQemu({
            runOwned: (_command, _argv, options) => { options.onSpawn(2300);
                options.onTerminationReady(() => finish({process: {...okProcess, exitCode: 137, cleanupProven: false},
                    stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)})); return operation; },
            pathExists: () => true,
            readOwnedVerified: () => ({bytes: Buffer.from("2345\n")}),
            readQemuProcessIdentity: () => { throw new Error(`synthetic identity failure\n${"x".repeat(600)}`); },
            monotonicMilliseconds: () => 1,
            wait: async () => undefined,
            isProcessGroupAlive: () => false
        }, {command: "/usr/bin/sudo", argv: [], timeoutMs: 1_000, maxStreamBytes: 1_024,
            pidPath: "/owned/qemu.pid", expectedExecutable: "/owned/loader", executionDeadline: 100_000,
            resources: {taskPath: "/owned", roots: ["/owned"]}});
        assert.equal(result.terminationReason, "identity-observation-failed");
        assert.equal(result.monitorFailure.phase, "identity-observation");
        assert.match(result.monitorFailure.message, /^synthetic identity failure x+$/u);
        assert.ok(result.monitorFailure.message.length <= 512);
    });

    it("retries an empty pidfile and retains the actual mismatched identity", async () => {
        let finish, reads = 0;
        const operation = new Promise(resolve => { finish = resolve; });
        const observed = {state: "present", pid: 2345, processGroupId: 999, startTicks: "77",
            executablePath: "/unexpected/qemu"};
        const result = await runMonitoredQemu({
            runOwned: (_command, _argv, options) => { options.onSpawn(2300);
                options.onTerminationReady(() => finish({process: {...okProcess, exitCode: 137, cleanupProven: false},
                    stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)})); return operation; },
            pathExists: () => true,
            readOwnedVerified: (_target, _maximumBytes, options) => { assert.equal(options.allowEmpty, true);
                reads += 1; return {bytes: reads === 1 ? Buffer.alloc(0) : Buffer.from("2345\n")}; },
            readQemuProcessIdentity: () => observed,
            monotonicMilliseconds: () => reads,
            wait: async () => undefined,
            isProcessGroupAlive: () => false
        }, {command: "/usr/bin/sudo", argv: [], timeoutMs: 1_000, maxStreamBytes: 1_024,
            pidPath: "/owned/qemu.pid", expectedExecutable: "/owned/loader", executionDeadline: 100_000,
            resources: {taskPath: "/owned", roots: ["/owned"]}});
        assert.equal(reads, 2);
        assert.deepEqual(result.monitorFailure.identity, {pid: 2345,
            expected: {processGroupId: 2300, executablePath: "/owned/loader"}, observed});
    });

    it("fails before launch when a reviewed-sudo pidfile already exists", async () => {
        let launched = false;
        await assert.rejects(runMonitoredQemu({
            createOwnedPidFile: () => { throw new Error("QEMU pidfile already exists"); },
            runOwned: () => { launched = true; throw new Error("unexpected launch"); }
        }, {command: "/usr/bin/sudo", argv: [], timeoutMs: 1_000, maxStreamBytes: 1_024,
            pidPath: "/owned/qemu.pid", expectedExecutable: "/owned/loader", executionDeadline: 100_000,
            precreatePidFile: true, resources: {taskPath: "/owned", roots: ["/owned"]}}), /already exists/u);
        assert.equal(launched, false);
    });

    it("derives separate Stage 2 and Stage 3 cleanup authority receipts beside their pidfiles", () => {
        assert.equal(cpuFloorCleanupAuthorityPath("/owned/stage2/qemu.pid"),
            "/owned/stage2/cleanup-authority.json");
        assert.equal(cpuFloorCleanupAuthorityPath("/owned/stage3/baseline-qemu.pid"),
            "/owned/stage3/cleanup-authority.json");
    });

    it("persists the exact observed live identity rather than trusting pidfile fields", async () => {
        let finish; let written;
        const operation = new Promise(resolve => { finish = resolve; });
        const observedIdentity = {state: "present", pid: 2345, processGroupId: 2300, startTicks: "77",
            executablePath: "/owned/loader"};
        let identityReads = 0;
        const result = await runMonitoredQemu({
            runOwned: (_command, _argv, options) => { options.onSpawn(2300); return operation; },
            pathExists: () => true,
            readOwnedVerified: () => ({bytes: Buffer.from("2345\n")}),
            readQemuProcessIdentity: async pid => pid === 2300 ? {state: "present", pid: 2300,
                processGroupId: 2300, startTicks: "66", executablePath: "/owned/timeout"} :
                (identityReads++ === 0 ? observedIdentity : {state: "absent"}),
            writeCleanupAuthority: (pidPath, identity) => { written = {pidPath, identity};
                finish({process: okProcess, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)}); },
            observeRuntimeResources: async () => ({taskBytes: "1", freeBytes: "90000000000",
                effectiveMemoryBytes: "4294967295"}),
            monotonicMilliseconds: () => 1,
            wait: async () => undefined,
            isProcessGroupAlive: () => false,
            terminateQemuGroup: async () => true
        }, {command: "/usr/bin/sudo", argv: [], timeoutMs: 1_000, maxStreamBytes: 1_024,
            pidPath: "/owned/stage2/qemu.pid", expectedExecutable: "/owned/loader", executionDeadline: 100_000,
            resources: {taskPath: "/owned", roots: ["/owned"]}});
        assert.deepEqual(written, {pidPath: "/owned/stage2/qemu.pid", identity: {
            pid: 2300, processGroupId: 2300, startTicks: "66", executablePath: "/owned/timeout"}});
        assert.equal(result.identity.pid, 2345);
    });

    it("routes cleanup authority receipt collisions and write failures through owned teardown", async () => {
        for (const message of ["already exists", "write failed"]) {
            let finish; let teardown;
            const operation = new Promise(resolve => { finish = resolve; });
            const result = await runMonitoredQemu({
                runOwned: (_command, _argv, options) => { options.onSpawn(2300);
                    options.onTerminationReady(() => finish({process: {...okProcess, exitCode: 137},
                        stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)})); return operation; },
                pathExists: () => true,
                readOwnedVerified: () => ({bytes: Buffer.from("2345\n")}),
                readQemuProcessIdentity: async pid => ({state: "present", pid, processGroupId: 2300,
                    startTicks: pid === 2300 ? "66" : "77",
                    executablePath: pid === 2300 ? "/owned/timeout" : "/owned/loader"}),
                writeCleanupAuthority: () => { throw new Error(message); },
                monotonicMilliseconds: () => 1,
                wait: async () => undefined,
                isProcessGroupAlive: () => true,
                terminateQemuGroup: async request => { teardown = request; return true; }
            }, {command: "/usr/bin/sudo", argv: [], timeoutMs: 1_000, maxStreamBytes: 1_024,
                pidPath: "/owned/qemu.pid", expectedExecutable: "/owned/loader", executionDeadline: 100_000,
                resources: {taskPath: "/owned", roots: ["/owned"]}});
            assert.equal(teardown.processGroupId, 2300);
            assert.equal(result.terminationReason, "identity-observation-failed");
            assert.equal(result.monitorFailure.phase, "identity-observation");
        }
    });

    it("refuses to publish authority when the observed group leader has already transitioned", async () => {
        let finish; let wrote = false; let teardown = false;
        const operation = new Promise(resolve => { finish = resolve; });
        const result = await runMonitoredQemu({
            runOwned: (_command, _argv, options) => { options.onSpawn(2300);
                options.onTerminationReady(() => finish({process: {...okProcess, exitCode: 137},
                    stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)})); return operation; },
            pathExists: () => true, readOwnedVerified: () => ({bytes: Buffer.from("2345\n")}),
            readQemuProcessIdentity: async pid => pid === 2345 ? {state: "present", pid, processGroupId: 2300,
                startTicks: "77", executablePath: "/owned/loader"} : {state: "absent"},
            writeCleanupAuthority: () => { wrote = true; }, monotonicMilliseconds: () => 1,
            wait: async () => undefined, isProcessGroupAlive: () => true,
            terminateQemuGroup: async () => { teardown = true; return true; }
        }, {command: "/usr/bin/sudo", argv: [], timeoutMs: 1_000, maxStreamBytes: 1_024,
            pidPath: "/owned/qemu.pid", expectedExecutable: "/owned/loader", executionDeadline: 100_000,
            resources: {taskPath: "/owned", roots: ["/owned"]}});
        assert.equal(wrote, false);
        assert.equal(teardown, true);
        assert.equal(result.terminationReason, "identity-observation-failed");
    });

    it("fails closed when reviewed-sudo QEMU replaces the precreated pidfile", async () => {
        let finish;
        const operation = new Promise(resolve => { finish = resolve; });
        let removed = false;
        const result = await runMonitoredQemu({
            createOwnedPidFile: target => { assert.equal(target, "/owned/qemu.pid"); return PIDFILE_IDENTITY; },
            runOwned: (_command, _argv, options) => { options.onSpawn(2300);
                options.onTerminationReady(() => finish({process: {...okProcess, exitCode: 137, cleanupProven: false},
                    stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)})); return operation; },
            pathExists: () => true,
            readOwnedPidFile: (_target, maximumBytes, expected) => { assert.equal(maximumBytes, 32);
                assert.equal(expected, PIDFILE_IDENTITY); throw new Error("QEMU pidfile identity changed"); },
            removeOwnedPidFile: () => { removed = true; },
            monotonicMilliseconds: () => 1,
            wait: async () => undefined,
            isProcessGroupAlive: () => false
        }, {command: "/usr/bin/sudo", argv: [], timeoutMs: 1_000, maxStreamBytes: 1_024,
            pidPath: "/owned/qemu.pid", expectedExecutable: "/owned/loader", executionDeadline: 100_000,
            precreatePidFile: true, resources: {taskPath: "/owned", roots: ["/owned"]}});
        assert.equal(result.terminationReason, "identity-observation-failed");
        assert.match(result.monitorFailure.message, /pidfile identity changed/u);
        assert.equal(removed, false);
    });

    it("counts a symbolic-link inode without traversing its target", () => {
        const children = new Map([["/root", ["link"]]]);
        const facts = new Map([["/root", {isSymbolicLink: () => false, isFile: () => false,
            isDirectory: () => true, size: 0n}], ["/root/link", {isSymbolicLink: () => true,
            isFile: () => false, isDirectory: () => false, size: 21n}]]);
        const observed = [];
        assert.equal(measureOwnedTreeBytes(["/root"], {lstatSync: target => { observed.push(target); return facts.get(target); },
            readdirSync: target => children.get(target)}), 21n);
        assert.deepEqual(observed, ["/root", "/root/link"]);
    });

    it("builds an isolated empty-status apt snapshot update and resolver", () => {
        const vectors = buildIsolatedAptVectors(paths());
        assert.equal(vectors.sourcesBytes.toString("utf8"),
            `deb [arch=amd64 signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] ${STAGE2_PROVENANCE.ubuntuSnapshot.baseUrl} noble main universe\n` +
            `deb [arch=amd64 signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] ${STAGE2_PROVENANCE.ubuntuSnapshot.baseUrl} noble-updates main universe\n`);
        assert.equal(vectors.emptyStatusBytes.length, 0);
        assert.equal(vectors.update.command, "/usr/bin/apt-get");
        assert.equal(vectors.update.argv.includes("update"), true);
        assert.equal(vectors.resolve.argv.includes("--no-install-recommends"), true);
        assert.equal(vectors.aptEnvironment.APT_CONFIG, vectors.aptConfig);
        assert.equal(vectors.common.includes("DPkg::Pre-Invoke::="), true);
        assert.equal(vectors.common.includes("APT::Update::Post-Invoke-Success::="), true);
        assert.deepEqual(vectors.resolve.argv.slice(-TOP_LEVEL_PACKAGE_PINS.length),
            TOP_LEVEL_PACKAGE_PINS.map(value => `${value.name}:${value.architecture}=${value.version}`));
    });

    it("selects the complete signed package index set across valid zero-byte checksum rows", () => {
        const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        const observed = [{suite: "noble", main: {bytes: "1401160",
            sha256: "2a6a199e1031a5c279cb346646d594993f35b1c03dd4a82aaa0323980dd92451"},
        universe: {bytes: "15037908",
            sha256: "ba9057fa1b91438cc8a1d26808d00c85389fe101d0c1496254df97236405599a"}},
        {suite: "noble-updates", main: {bytes: "1262968",
            sha256: "4963d0592fb3c977ec0b7593ec8e202b4906b048f625760742c063965da7b175"},
        universe: {bytes: "1690332",
            sha256: "cf06d0b20daa7eea4d4a4f4abc0fd8b29aed8389367681c6f6653c5068155265"}}];
        const releaseFor = value => Buffer.from("-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA512\n\n" +
            "Origin: Ubuntu\nSHA256:\n" +
            ` ${value.main.sha256} ${value.main.bytes} main/binary-amd64/Packages.xz\n` +
            ` ${emptyHash} 0 main/debian-installer/binary-amd64/Packages\n` +
            ` ${value.universe.sha256} ${value.universe.bytes} universe/binary-amd64/Packages.xz\n` +
            "Acquire-By-Hash: yes\n-----BEGIN PGP SIGNATURE-----\n");

        for (const value of observed) assert.deepEqual(parseInReleaseIndexes(releaseFor(value), value.suite),
            [{suite: value.suite, component: "main", architecture: "amd64",
                path: `dists/${value.suite}/main/binary-amd64/Packages.xz`, bytes: value.main.bytes,
                sha256: value.main.sha256, listedSha256: value.main.sha256},
            {suite: value.suite, component: "universe", architecture: "amd64",
                path: `dists/${value.suite}/universe/binary-amd64/Packages.xz`, bytes: value.universe.bytes,
                sha256: value.universe.sha256, listedSha256: value.universe.sha256}]);

        const release = releaseFor(observed[0]);
        const mainHash = observed[0].main.sha256;

        const duplicate = Buffer.from(release.toString("utf8").replace("Acquire-By-Hash: yes",
            ` ${mainHash} ${observed[0].main.bytes} main/binary-amd64/Packages.xz\nAcquire-By-Hash: yes`));
        assert.throws(() => parseInReleaseIndexes(duplicate, "noble"), /duplicated/u);
        const zeroSelected = Buffer.from(release.toString("utf8").replace(
            `${mainHash} ${observed[0].main.bytes} main/binary-amd64/Packages.xz`,
            `${emptyHash} 0 main/binary-amd64/Packages.xz`));
        assert.throws(() => parseInReleaseIndexes(zeroSelected, "noble"), /size/u);
        const missing = Buffer.from(release.toString("utf8").replace(
            "universe/binary-amd64/Packages.xz", "restricted/binary-amd64/Packages.xz"));
        assert.throws(() => parseInReleaseIndexes(missing, "noble"), /incomplete/u);
        const malformed = Buffer.from(release.toString("utf8").replace(emptyHash, "not-a-sha256"));
        assert.throws(() => parseInReleaseIndexes(malformed, "noble"), /malformed/u);
    });

    it("resolves a selected virtual provider and rejects ambiguous providers", () => {
        const records = [{name: "consumer", architecture: "amd64", version: "1", dependsOn: []},
            {name: "provider", architecture: "amd64", version: "1", dependsOn: []}];
        const expressions = new Map([["consumer", ["virtual-abi"]]]);
        resolveSelectedDependencies(records, expressions, new Map([["provider", "virtual-abi (= 1)"]]));
        assert.deepEqual(records[0].dependsOn, ["provider:amd64=1"]);
        const ambiguous = structuredClone(records);
        ambiguous.push({name: "provider-two", architecture: "amd64", version: "1", dependsOn: []});
        assert.throws(() => resolveSelectedDependencies(ambiguous, expressions,
            new Map([["provider", "virtual-abi"], ["provider-two", "virtual-abi"]])), /ambiguous/u);
    });

    it("rejects non-hosted context before filesystem, process or network activity", async () => {
        const calls = [];
        const altered = context(); altered.environment.GITHUB_ACTIONS = "false";
        assert.throws(() => createHostedStage2Operations({context: altered, paths: paths(), dependencies: {
            mkdirExclusive: () => calls.push("mkdir"), runOwned: () => calls.push("run"),
            downloadPinned: () => calls.push("network")
        }}), /hosted|context|environment/u);
        assert.deepEqual(calls, []);
    });

    it("collects actual statvfs units and complete self-cgroup ancestry before acquisition", async () => {
        const taskPath = "/home/runner/work/_temp";
        const levels = [{path: "/sys/fs/cgroup", limitBytes: null, currentBytes: null},
            {path: "/sys/fs/cgroup/actions_job", limitBytes: "16000000000", currentBytes: "1000000000"}];
        const observations = await collectHostedAdmissionObservations({context: context(), paths: paths(), dependencies: {
            readResources: target => ({filesystem: {taskPath: target, type: "ext4", mountOptions: "rw,relatime"},
                memory: {memAvailableBytes: "15226159104", cgroupLevels: levels,
                    cgroupHeadroomBytes: "15000000000", effectiveAvailableBytes: "15000000000"}}),
            readCgroupLayout: () => ({root: "/", mountPoint: "/sys/fs/cgroup",
                processDirectory: "/sys/fs/cgroup/actions_job", ancestorDirectories: levels.map(level => level.path)}),
            inspectOwned: target => ({path: target, bytes: "1", sha256: "a".repeat(64),
                ownership: {uid: "0", gid: "0", mode: "555", ordinaryUserWritable: false}}),
            runOwned: async (command, argv) => { assert.equal(command, "/usr/bin/stat");
                if (argv[0] === "--printf=%m\\n") {
                    assert.deepEqual(argv, ["--printf=%m\\n", "--", taskPath]);
                    return {process: okProcess, stdout: Buffer.from("/\n"), stderr: Buffer.alloc(0)};
                }
                assert.deepEqual(argv, ["--file-system", "--printf=%a\\n%S\\n", "--", taskPath]);
                return {process: okProcess, stdout: Buffer.from("19816114\n4096\n"), stderr: Buffer.alloc(0)}; },
            pathExists: () => false, assertWritable: target => assert.equal(target, taskPath)
        }});
        assert.equal(observations.filesystem.mountPoint, "/");
        assert.equal(observations.filesystem.availableBytes, "81166802944");
        assert.equal(observations.memory.selfCgroupPath, "/sys/fs/cgroup/actions_job");
        assert.deepEqual(observations.memory.cgroupLevels.map(level => level.path), levels.map(level => level.path));
    });

    it("uses literal statvfs newlines and a separately bounded owned-tree observation at runtime", async () => {
        const taskPath = "/home/runner/work/_temp";
        const observed = await observeHostedRuntimeResources({
            readResources: () => ({memory: {effectiveAvailableBytes: "15000000000"}}),
            runOwned: async (command, argv) => { assert.equal(command, "/usr/bin/stat");
                assert.deepEqual(argv, ["--file-system", "--printf=%a\\n%S\\n", "--", taskPath]);
                return {process: okProcess, stdout: Buffer.from("20000000\n4096\n"), stderr: Buffer.alloc(0)}; },
            treeBytes: roots => { assert.deepEqual(roots, ["/owned", "/portable"]); return 21n; }
        }, {taskPath, roots: ["/owned", "/portable"]});
        assert.deepEqual(observed, {taskBytes: "21", freeBytes: "81920000000",
            effectiveMemoryBytes: "15000000000"});
    });

    it("parses bounded WIM metadata and removes the duplicate WIM before guest disk creation", async () => {
        const text = "WIM Information:\n----------------\nPath: /owned/install.wim\nGUID: 00000000\n\n" +
            "Available Images:\n-----------------\n" +
            "Index: 1\nName: Windows Server 2025 Standard Evaluation\nArchitecture: x86_64\n" +
            "Edition ID: ServerStandardEval\nInstallation Type: Server Core\nTotal Bytes: 15000000000\n\n" +
            "Index: 2\nName: Windows Server 2025 SERVERSTANDARD\nArchitecture: x86_64\n" +
            "Edition ID: ServerStandardEval\nInstallation Type: Server\nTotal Bytes: 24699866265\n";
        assert.equal(parseWimInfo(Buffer.from(text)).length, 2);
        assert.deepEqual(parseWimInfo(Buffer.from(text))[0], {index: 1,
            name: "Windows Server 2025 Standard Evaluation", architecture: "x64", editionId: "ServerStandardEval",
            installationType: "Server Core", totalBytes: "15000000000"});
        assert.throws(() => parseWimInfo(Buffer.alloc(1_048_577)), /bound/u);
        let removed = false;
        const adapter = createHostedStage2Operations({context: context(), paths: paths(), dependencies: {
            runOwned: async (command, argv, options) => {
                assert.equal(command.endsWith("ld-linux-x86-64.so.2"), true);
                assert.deepEqual(argv.slice(0, 5), ["--argv0", `${paths().portableRoot}/usr/bin/wiminfo`,
                    "--library-path", `${paths().portableRoot}/lib/x86_64-linux-gnu`,
                    `${paths().portableRoot}/usr/bin/wimlib-imagex`]);
                assert.equal(argv.at(-1), paths().installWim);
                assert.equal(options.maxStreamBytes, 1_048_576);
                return {process: okProcess, stdout: Buffer.from(text), stderr: Buffer.alloc(0)};
            }, removeOwned: target => { assert.equal(target, paths().installWim); removed = true; },
            pathExists: target => target === paths().installWim && !removed
        }});
        const installWim = {path: paths().installWim, sha256: "5".repeat(64)};
        const inventory = await adapter.inspectInstallWim({paths: paths(), installWim, toolchain: {runtime: {
            loader: {path: `${paths().portableRoot}/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`},
            libraryPath: [`${paths().portableRoot}/lib/x86_64-linux-gnu`]},
        wiminfo: {path: `${paths().portableRoot}/usr/bin/wimlib-imagex`,
            invocationPath: `${paths().portableRoot}/usr/bin/wiminfo`}}});
        assert.equal(inventory.images.length, 2);
        assert.deepEqual(inventory.removal, {path: installWim.path, sha256: installWim.sha256, removed: true});
        assert.equal(removed, true);
    });

    it("recomputes guest CPU bits, exception exits and zero-network state from raw output", () => {
        const produced = successfulGuestOutput();
        const parsed = parseGuestOutput(Buffer.from(JSON.stringify(produced)), NONCE);
        const cpuid = JSON.parse(Buffer.from(produced.runs.find(run => run.role === "cpuid").stdoutBase64, "base64"));
        assert.deepEqual(parsed.cpu, cpuid.features);
        assert.deepEqual(parsed.instructions, {sse42: "completed", popcnt: "completed",
            avx: "illegal-instruction", avx2: "illegal-instruction"});
        assert.deepEqual(parsed.activation, activationEvidence());
        assert.deepEqual(parsed.systemTools, systemTools());
        const altered = structuredClone(produced);
        altered.runs.find(run => run.role === "avx").exitCode = 0;
        assert.throws(() => parseGuestOutput(Buffer.from(JSON.stringify(altered)), NONCE), /AVX|illegal/u);
        const lowLeaf = structuredClone(produced);
        const lowCpuid = structuredClone(cpuid); lowCpuid.maxBasicLeaf = 1;
        lowLeaf.runs.find(run => run.role === "cpuid").stdoutBase64 = Buffer.from(JSON.stringify(lowCpuid)).toString("base64");
        assert.throws(() => parseGuestOutput(Buffer.from(JSON.stringify(lowLeaf)), NONCE), /maximum basic leaf/u);
        for (const mutate of [value => { value.activation.files.dispatcher.bytes = 0; },
            value => { value.systemTools[0].bytes = "0"; }, value => { value.systemTools.reverse(); }]) {
            const changed = structuredClone(produced); mutate(changed);
            assert.throws(() => parseGuestOutput(Buffer.from(JSON.stringify(changed)), NONCE));
        }
    });

    it("uses exact package URLs/hashes, root extraction vectors and reviewed sudo QEMU launcher", async () => {
        const calls = [];
        const closure = {packages: TOP_LEVEL_PACKAGE_PINS.map(value => ({...value, dependsOn: []}))};
        const packageIdentities = new Map();
        for (const value of closure.packages) {
            packageIdentities.set(`${paths().packageRoot}/${value.name}.deb`, value);
            packageIdentities.set(`${paths().portableRoot}/.packages/${sha256ForTest(Buffer.from(
                `${value.name}:${value.architecture}=${value.version}`)).slice(0, 16)}.deb`, value);
        }
        const dependencies = {
            mkdirExclusive: target => calls.push(["mkdir", target]),
            writeExclusive: (target, bytes) => calls.push(["write", target, bytes.length]),
            downloadPinned: async request => { calls.push(["download", request.url, request.path, request.sha256]);
                return {path: request.path, bytes: request.bytes, sha256: request.sha256}; },
            runOwned: async (command, argv, options) => { calls.push(["run", command, argv, options]);
                const stdout = argv.includes(`${paths().portableRoot}/usr/lib/7zip/7z`) && argv.includes("i") ?
                    Buffer.from(`Libs:\n 0 : 23.01 : ${paths().portableRoot}/usr/lib/7zip/7z.so\n\n` +
                        "Formats:\n 0  ED       m  Iso      iso img        CD001\n") : Buffer.alloc(0);
                return {process: okProcess, stdout, stderr: Buffer.alloc(0)}; },
            inspectOwned: target => ({path: target.endsWith("/usr/bin/wiminfo") ?
                `${paths().portableRoot}/usr/bin/wimlib-imagex` :
                target.endsWith("/usr/bin/mformat") || target.endsWith("/usr/bin/mcopy") ?
                    `${paths().portableRoot}/usr/bin/mtools` : target,
                sha256: packageIdentities.get(target)?.sha256 ?? "f".repeat(64),
                ownership: {uid: "0", gid: "0", mode: packageIdentities.has(target) ? "444" : "555",
                    ordinaryUserWritable: false}, bytes: packageIdentities.get(target)?.bytes ?? "4096"}),
            inspectDirectory: directoryIdentity,
            pathExists: () => false,
            inventoryOwnedTree: (target, selector) => ({bytes: selector ? "128" : "512",
                sha256: (selector ? "d" : "e").repeat(64), root: target}),
            readOwned: () => Buffer.alloc(0),
            readOwnedVerified: target => ({bytes: Buffer.from("{}"), identity: {
                path: target, bytes: "2", sha256: "2".repeat(64)}}),
            runMonitoredQemu: async request => { calls.push(["monitored", request]); return {
                observation: {process: okProcess, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)},
                identity: {pid: 2345, processGroupId: 2300, startTicks: "77",
                    executablePath: `${paths().portableRoot}/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`},
                absentAfter: true, processGroupGone: true, terminationReason: null}; },
            copyExclusive: () => undefined
        };
        const adapter = createHostedStage2Operations({context: context(), paths: paths(), dependencies});
        await adapter.acquirePackages({packageClosure: closure, paths: paths()});
        assert.equal(calls.filter(call => call[0] === "download").length, TOP_LEVEL_PACKAGE_PINS.length);
        assert.equal(calls.find(call => call[0] === "download")[1],
            `${STAGE2_PROVENANCE.ubuntuSnapshot.baseUrl}${TOP_LEVEL_PACKAGE_PINS[0].filename}`);
        const toolchain = await adapter.extractPortableTools({packageClosure: closure,
            acquisition: {packages: closure.packages.map(value => ({reference: `${value.name}:${value.architecture}=${value.version}`,
                path: `${paths().packageRoot}/${value.name}.deb`, bytes: value.bytes, sha256: value.sha256}))},
            paths: paths(), privilegeMode: "reviewed-sudo-kvm"});
        assert.equal(toolchain.wiminfo.path, `${paths().portableRoot}/usr/bin/wimlib-imagex`);
        assert.equal(toolchain.wiminfo.invocationPath, `${paths().portableRoot}/usr/bin/wiminfo`);
        assert.equal(toolchain.mformat.path, `${paths().portableRoot}/usr/bin/mtools`);
        assert.equal(toolchain.mformat.invocationPath, `${paths().portableRoot}/usr/bin/mformat`);
        assert.equal(toolchain.sevenZip.path, `${paths().portableRoot}/usr/lib/7zip/7z`);
        assert.equal(toolchain.sevenZip.invocationPath, `${paths().portableRoot}/usr/lib/7zip/7z`);
        const extract = calls.find(call => call[0] === "run" && call[2].some(value => value.endsWith("/dpkg-deb")));
        assert.deepEqual(extract[2].slice(0, 8), ["-n", "--", "/usr/bin/timeout", "--foreground", "--signal=KILL",
            "25s", "/usr/bin/dpkg-deb", "-x"]);
        const loader = `${paths().portableRoot}/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`;
        const version = calls.find(call => call[0] === "run" && call[2].includes("--version"));
        assert.equal(version[1], loader);
        assert.deepEqual(version[2].slice(0, 5), ["--argv0", `${paths().portableRoot}/usr/bin/qemu-system-x86_64`,
            "--library-path",
            `${paths().portableRoot}/usr/lib/x86_64-linux-gnu:${paths().portableRoot}/usr/lib/7zip`,
            `${paths().portableRoot}/usr/bin/qemu-system-x86_64`]);
        const sevenZipInfo = calls.find(call => call[0] === "run" && call[2].includes(toolchain.sevenZip.path) &&
            call[2].includes("i"));
        assert.equal(sevenZipInfo[1], loader);
        assert.deepEqual(sevenZipInfo[2], ["--argv0", toolchain.sevenZip.invocationPath, "--library-path",
            `${paths().portableRoot}/usr/lib/x86_64-linux-gnu:${paths().portableRoot}/usr/lib/7zip`,
            toolchain.sevenZip.path, "i"]);

        const sevenZipExtractionInput = {packageClosure: closure,
            acquisition: {packages: closure.packages.map(value => ({
                reference: `${value.name}:${value.architecture}=${value.version}`,
                path: `${paths().packageRoot}/${value.name}.deb`, bytes: value.bytes, sha256: value.sha256}))},
            paths: paths(), privilegeMode: "reviewed-sudo-kvm"};
        const withoutModule = createHostedStage2Operations({context: context(), paths: paths(), dependencies: {
            ...dependencies,
            runOwned: async (command, argv) => ({process: okProcess,
                stdout: argv.includes(`${paths().portableRoot}/usr/lib/7zip/7z`) && argv.includes("i") ?
                    Buffer.from("Formats:\n 0  ED       m  Iso      iso img        CD001\n") : Buffer.alloc(0),
                stderr: Buffer.alloc(0)})
        }});
        await assert.rejects(withoutModule.extractPortableTools(sevenZipExtractionInput), /7-Zip module/u);
        const withoutIso = createHostedStage2Operations({context: context(), paths: paths(), dependencies: {
            ...dependencies,
            runOwned: async (command, argv) => ({process: okProcess,
                stdout: argv.includes(`${paths().portableRoot}/usr/lib/7zip/7z`) && argv.includes("i") ?
                    Buffer.from(`Libs:\n 0 : 23.01 : ${paths().portableRoot}/usr/lib/7zip/7z.so\n`) : Buffer.alloc(0),
                stderr: Buffer.alloc(0)})
        }});
        await assert.rejects(withoutIso.extractPortableTools(sevenZipExtractionInput), /7-Zip ISO support/u);
        const launch = await adapter.launchOwnedQemu({paths: paths(), toolchain,
            privilegeMode: "reviewed-sudo-kvm", argv: ["-nic", "none"]});
        assert.equal(launch.guest, null);
        assert.equal(launch.process.cleanupProven, true);
        assert.equal(launch.process.qemuPid, 2345);
        assert.equal(launch.process.qemuStartTicks, "77");
        assert.equal(launch.process.launcherExecutablePath, toolchain.runtime.loader.path);
        assert.equal(launch.process.processGroupId, 2300);
        assert.equal(launch.process.qemuPidAbsentAfter, true);
        const qemu = calls.find(call => call[0] === "monitored")[1];
        assert.equal(qemu.command, "/usr/bin/sudo");
        assert.equal(qemu.precreatePidFile, true);
        assert.deepEqual(qemu.argv.slice(0, 9), ["-n", "--", "/usr/bin/timeout", "--foreground", "--signal=KILL",
            "16200s", toolchain.runtime.loader.path, "--argv0", toolchain.qemu.invocationPath]);
    });

    it("captures the live QEMU PID/start/executable identity before accepting its cleanup", async () => {
        let identityReads = 0;
        const pidfileCalls = [];
        const qemuPath = `${paths().portableRoot}/usr/bin/qemu-system-x86_64`;
        const adapter = createHostedStage2Operations({context: context(), paths: paths(), dependencies: {
            inspectOwned: rootFileIdentity,
            inspectDirectory: directoryIdentity,
            runOwned: async (command, argv, options) => { pidfileCalls.push(["launch", command]);
                options?.onSpawn?.(2300); return {
                process: okProcess, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)}; },
            pathExists: target => target === paths().qemuPid,
            createOwnedPidFile: target => { pidfileCalls.push(["create", target]); return PIDFILE_IDENTITY; },
            readOwnedPidFile: (target, maximumBytes, expected) => { pidfileCalls.push(["read", target]);
                assert.equal(maximumBytes, 32); assert.equal(expected, PIDFILE_IDENTITY);
                return {bytes: Buffer.from("2345\n")}; },
            removeOwnedPidFile: (target, expected) => { pidfileCalls.push(["remove", target]);
                assert.equal(expected, PIDFILE_IDENTITY); },
            writeCleanupAuthority: (target, identity) => pidfileCalls.push(["authority", target, identity.pid]),
            readOwnedVerified: target => target === paths().qemuPid ?
                {bytes: Buffer.from("2345\n"), identity: {path: target, bytes: "5", sha256: "1".repeat(64)}} :
                {bytes: Buffer.from("{}"), identity: {path: target, bytes: "2", sha256: "2".repeat(64)}},
            readProcessIdentity: pid => {
                if (pid === 2300) return {state: "present", pid, processGroupId: 2300, startTicks: "66",
                    executablePath: "/owned/timeout"};
                assert.equal(pid, 2345);
                identityReads += 1;
                return identityReads === 1 ? {state: "present", processGroupId: 2300, startTicks: "77",
                    executablePath: `${paths().portableRoot}/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`} :
                    {state: "absent"};
            }, isProcessGroupAlive: () => false, observeRuntimeResources: () => ({taskBytes: "1",
                freeBytes: "90000000000", effectiveMemoryBytes: "15000000000"}),
            monotonicMilliseconds: () => identityReads, wait: async () => undefined
        }});
        const toolchain = {firmware: qemuFirmware(), runtime: {loader: rootFileIdentity(
            `${paths().portableRoot}/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`),
        libraryPath: [`${paths().portableRoot}/lib/x86_64-linux-gnu`]}, qemu: commandIdentity(qemuPath),
        mcopy: commandIdentity(`${paths().portableRoot}/usr/bin/mcopy`)};
        const launch = await adapter.launchOwnedQemu({paths: paths(), toolchain,
            privilegeMode: "reviewed-sudo-kvm", argv: ["-nic", "none"]});
        assert.equal(launch.process.cleanupProven, true);
        assert.deepEqual({pid: launch.process.qemuPid, startTicks: launch.process.qemuStartTicks,
            executablePath: launch.process.launcherExecutablePath, absent: launch.process.qemuPidAbsentAfter},
        {pid: 2345, startTicks: "77",
            executablePath: `${paths().portableRoot}/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`, absent: true});
        assert.deepEqual(pidfileCalls, [["create", paths().qemuPid], ["launch", "/usr/bin/sudo"],
            ["read", paths().qemuPid], ["authority", paths().qemuPid, 2300], ["remove", paths().qemuPid]]);
    });

    it("exposes the normalized monitored QEMU process proof without parsing guest output", async () => {
        const calls = [];
        const loader = `${paths().portableRoot}/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`;
        const toolchain = {firmware: qemuFirmware(), runtime: {loader: rootFileIdentity(loader),
            libraryPath: [`${paths().portableRoot}/lib/x86_64-linux-gnu`]},
        qemu: commandIdentity(`${paths().portableRoot}/usr/bin/qemu-system-x86_64`)};
        const launcher = createHostedQemuProcessLauncher({context: context(), paths: paths(), dependencies: {
            inspectOwned: rootFileIdentity,
            inspectDirectory: directoryIdentity,
            runMonitoredQemu: async request => { calls.push(request); return {
                observation: {process: okProcess, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)},
                identity: {pid: 2345, processGroupId: 2300, startTicks: "77", executablePath: loader},
                qmp: qmpObservation(), absentAfter: true, processGroupGone: true, terminationReason: null}; },
            pathExists: () => false, readOwnedVerified: screenshotRead
        }});
        const result = await launcher({paths: paths(), toolchain,
            privilegeMode: "reviewed-sudo-kvm", argv: ["-nic", "none"]});
        assert.deepEqual(Object.keys(result).sort(), ["argv", "earlyBoot", "executionSucceeded", "process",
            "processFlags"]);
        assert.equal(result.executionSucceeded, true);
        assert.equal(result.earlyBoot.inputSent, false);
        assert.equal(result.earlyBoot.screenshots.length, 2);
        assert.deepEqual(result.processFlags, {errorObserved: false, stdoutOverflow: false, stderrOverflow: false});
        assert.equal(result.process.cleanupProven, true);
        assert.equal(result.process.treeGone, true);
        assert.equal(result.process.qemuPidAbsentAfter, true);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].command, "/usr/bin/sudo");
        assert.equal(calls.some(call => call.argv?.some(value => value === "::result.json")), false);
    });

    it("revalidates signed-closure firmware identities immediately before QEMU launch", async () => {
        const loader = `${paths().portableRoot}/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`;
        const toolchain = {firmware: qemuFirmware(), runtime: {loader: rootFileIdentity(loader),
            libraryPath: [`${paths().portableRoot}/lib/x86_64-linux-gnu`]},
        qemu: commandIdentity(`${paths().portableRoot}/usr/bin/qemu-system-x86_64`)};
        let launched = false;
        const launcher = createHostedQemuProcessLauncher({context: context(), dependencies: {
            inspectOwned: target => target.endsWith("kvmvapic.bin") ?
                {...rootFileIdentity(target), sha256: "0".repeat(64)} : rootFileIdentity(target),
            inspectDirectory: directoryIdentity,
            runMonitoredQemu: async () => { launched = true; throw new Error("unexpected launch"); }
        }});
        await assert.rejects(() => launcher({paths: paths(), toolchain,
            privilegeMode: "reviewed-sudo-kvm", argv: ["-nic", "none"]}), /kvmvapic firmware identity changed/u);
        assert.equal(launched, false);
    });

    it("binds installer input to the requested policy rather than trusting a QMP action record", async () => {
        const loader = `${paths().portableRoot}/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`;
        const toolchain = {firmware: qemuFirmware(), runtime: {loader: rootFileIdentity(loader),
            libraryPath: [`${paths().portableRoot}/lib/x86_64-linux-gnu`]},
        qemu: commandIdentity(`${paths().portableRoot}/usr/bin/qemu-system-x86_64`)};
        for (const [policy, observed, expected] of [[undefined, false, true],
            [undefined, bootInput(), false], [BOOT_CONFIRMATION, false, false],
            [BOOT_CONFIRMATION, bootInput(), true],
            [BOOT_CONFIRMATION, {...bootInput(), qcode: "esc"}, false]]) {
            let qmpRequest;
            const launcher = createHostedQemuProcessLauncher({context: context(), dependencies: {
                inspectOwned: rootFileIdentity, inspectDirectory: directoryIdentity,
                pathExists: () => false, readOwnedVerified: screenshotRead,
                runMonitoredQemu: async request => {
                    qmpRequest = request.qmp;
                    return {observation: {process: okProcess, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)},
                        identity: {pid: 2345, processGroupId: 2300, startTicks: "77", executablePath: loader},
                        qmp: {...qmpObservation(), inputSent: observed}, absentAfter: true,
                        processGroupGone: true, terminationReason: null};
                }
            }});
            const result = await launcher({paths: paths(), toolchain, privilegeMode: "reviewed-sudo-kvm",
                argv: ["-nic", "none"], ...(policy === undefined ? {} : {bootConfirmation: policy})});
            assert.equal(qmpRequest.bootConfirmation, policy);
            assert.equal(result.executionSucceeded, expected);
            assert.deepEqual(result.earlyBoot?.inputSent ?? null, expected ? observed : null);
        }
    });

    it("keeps stream, process, cleanup, and privilege failures out of both parser and generic success", async () => {
        const loader = `${paths().portableRoot}/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`;
        const toolchain = {firmware: qemuFirmware(), runtime: {loader: rootFileIdentity(loader),
            libraryPath: [`${paths().portableRoot}/lib/x86_64-linux-gnu`]},
        qemu: commandIdentity(`${paths().portableRoot}/usr/bin/qemu-system-x86_64`),
        mcopy: commandIdentity(`${paths().portableRoot}/usr/bin/mcopy`)};
        for (const changedProcess of [
            {...okProcess, errorObserved: true},
            {...okProcess, stdoutOverflow: true},
            {...okProcess, stderrOverflow: true},
            {...okProcess, cleanupProven: false}
        ]) {
            let extractionAttempted = false;
            const dependencies = {inspectOwned: rootFileIdentity, inspectDirectory: directoryIdentity,
                runOwned: async () => { extractionAttempted = true; return {process: okProcess,
                    stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)}; },
                runMonitoredQemu: async () => ({observation: {process: changedProcess,
                    stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)},
                identity: {pid: 2345, processGroupId: 2300, startTicks: "77", executablePath: loader},
                absentAfter: true, processGroupGone: true, terminationReason: null})};
            const launcher = createHostedQemuProcessLauncher({context: context(), paths: paths(), dependencies});
            const processOnly = await launcher({paths: paths(), toolchain,
                privilegeMode: "reviewed-sudo-kvm", argv: ["-nic", "none"]});
            assert.equal(processOnly.executionSucceeded, false);
            assert.deepEqual(processOnly.failureDiagnostic, {schemaVersion: 1,
                kind: "qemu-launch-failure-diagnostic", process: processOnly.process,
                processFlags: {errorObserved: changedProcess.errorObserved,
                    stdoutOverflow: changedProcess.stdoutOverflow, stderrOverflow: changedProcess.stderrOverflow},
                monitorFailure: null,
                stderr: {bytes: "0", sha256: crypto.createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
                    bytesBase64: ""}, serialLog: {status: "unavailable"}});
            assert.deepEqual(processOnly.processFlags, {errorObserved: changedProcess.errorObserved,
                stdoutOverflow: changedProcess.stdoutOverflow, stderrOverflow: changedProcess.stderrOverflow});
            const adapter = createHostedStage2Operations({context: context(), paths: paths(), dependencies});
            const stage2 = await adapter.launchOwnedQemu({paths: paths(), toolchain,
                privilegeMode: "reviewed-sudo-kvm", argv: ["-nic", "none"]});
            assert.equal(stage2.guest, null);
            assert.equal(extractionAttempted, false);
        }
        const launcher = createHostedQemuProcessLauncher({context: context(), paths: paths(), dependencies: {
            inspectOwned: rootFileIdentity, inspectDirectory: directoryIdentity}});
        await assert.rejects(() => launcher({paths: paths(), toolchain,
            privilegeMode: "unreviewed", argv: ["-nic", "none"]}), /privilege mode/i);
    });

    for (const source of ["primary", "secondary", "invalid-secondary"])
        it(`extracts only valid bounded ${source} failure evidence after clean QEMU teardown`, async () => {
        const secondary = source !== "primary";
        const failure = {schemaVersion: 1, status: "failed", nonce: NONCE, stage: "guest-bootstrap",
            failure: "synthetic provider failure"};
        if (source === "invalid-secondary") failure.status = "observed";
        const extracted = [];
        const adapter = createHostedStage2Operations({context: context(), paths: paths(), dependencies: {
            inspectOwned: rootFileIdentity,
            inspectDirectory: directoryIdentity,
            runOwned: async (_command, argv) => { extracted.push(argv.find(value => value.startsWith("::")));
                if (secondary && argv.includes("::result.json")) throw new Error("primary publication unavailable");
                return {process: okProcess, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)}; },
            runMonitoredQemu: async () => ({observation: {process: okProcess, stdout: Buffer.alloc(0),
                stderr: Buffer.alloc(0)}, identity: {pid: 2345, processGroupId: 2300, startTicks: "77",
                executablePath: `${paths().portableRoot}/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`},
            qmp: qmpObservation(), absentAfter: true, processGroupGone: true, terminationReason: null}),
            pathExists: () => false,
            readOwnedVerified: target => target.endsWith(".png") ? screenshotRead(target) :
                ({bytes: Buffer.from(JSON.stringify(failure)), identity: {
                    path: target, bytes: String(Buffer.byteLength(JSON.stringify(failure))), sha256: "1".repeat(64)}})
        }});
        const toolchain = {firmware: qemuFirmware(), runtime: {loader: rootFileIdentity(
            `${paths().portableRoot}/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`),
        libraryPath: [`${paths().portableRoot}/lib/x86_64-linux-gnu`]},
        qemu: commandIdentity(`${paths().portableRoot}/usr/bin/qemu-system-x86_64`),
        mcopy: commandIdentity(`${paths().portableRoot}/usr/bin/mcopy`)};
        const result = await adapter.launchOwnedQemu({paths: paths(), toolchain,
            privilegeMode: "reviewed-sudo-kvm", argv: ["-nic", "none"]});
        assert.deepEqual(result.guest, source === "invalid-secondary" ? null : failure);
        assert.deepEqual(extracted, secondary ? ["::result.json", "::bootstrap-failure.json"] : ["::result.json"]);
        assert.equal(result.process.cleanupProven, true);
        assert.equal(result.process.treeGone, true);
    });

    it("retains activation and system-tool records from parsed guest output through the hosted launch", async () => {
        const produced = successfulGuestOutput();
        const adapter = createHostedStage2Operations({context: context(), paths: paths(), dependencies: {
            inspectOwned: rootFileIdentity, inspectDirectory: directoryIdentity,
            runOwned: async () => ({process: okProcess, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)}),
            runMonitoredQemu: async () => ({observation: {process: okProcess, stdout: Buffer.alloc(0),
                stderr: Buffer.alloc(0)}, identity: {pid: 2345, processGroupId: 2300, startTicks: "77",
                executablePath: `${paths().portableRoot}/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`},
            qmp: qmpObservation(), absentAfter: true, processGroupGone: true, terminationReason: null}),
            pathExists: () => false,
            readOwnedVerified: target => target.endsWith(".png") ? screenshotRead(target) :
                ({bytes: Buffer.from(JSON.stringify(produced)), identity: {path: target,
                    bytes: String(Buffer.byteLength(JSON.stringify(produced))), sha256: "1".repeat(64)}})
        }});
        const toolchain = {firmware: qemuFirmware(), runtime: {loader: rootFileIdentity(
            `${paths().portableRoot}/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`),
        libraryPath: [`${paths().portableRoot}/lib/x86_64-linux-gnu`]},
        qemu: commandIdentity(`${paths().portableRoot}/usr/bin/qemu-system-x86_64`),
        mcopy: commandIdentity(`${paths().portableRoot}/usr/bin/mcopy`)};
        const result = await adapter.launchOwnedQemu({paths: paths(), toolchain,
            privilegeMode: "reviewed-sudo-kvm", argv: ["-nic", "none"]});
        assert.deepEqual(result.guest.activation, activationEvidence());
        assert.deepEqual(result.guest.systemTools, systemTools());
    });

    it("aborts when no QEMU identity appears within the bounded startup window", async () => {
        let clock = 0, finish, groupAlive = true;
        const adapter = createHostedStage2Operations({context: context(), paths: paths(), dependencies: {
            inspectOwned: rootFileIdentity, inspectDirectory: directoryIdentity,
            runOwned: (command, argv, options) => {
                if (argv.includes("/usr/bin/kill")) { groupAlive = false;
                    finish({process: {...okProcess, exitCode: 137}, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)});
                    return Promise.resolve({process: okProcess, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)}); }
                options.onSpawn(2300); return new Promise(resolve => { finish = resolve; });
            }, createOwnedPidFile: () => PIDFILE_IDENTITY,
            writeCleanupAuthority: () => undefined,
            pathExists: target => target === paths().qemuPid,
            readOwnedPidFile: () => ({bytes: Buffer.alloc(0)}),
            removeOwnedPidFile: () => { throw new Error("unclean launch must retain pidfile identity"); },
            monotonicMilliseconds: () => clock,
            wait: async milliseconds => { clock += milliseconds; },
            isProcessGroupAlive: () => groupAlive
        }});
        const toolchain = {firmware: qemuFirmware(), runtime: {loader: rootFileIdentity(
            `${paths().portableRoot}/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`),
        libraryPath: [`${paths().portableRoot}/lib/x86_64-linux-gnu`]},
        qemu: commandIdentity(`${paths().portableRoot}/usr/bin/qemu-system-x86_64`),
        mcopy: commandIdentity(`${paths().portableRoot}/usr/bin/mcopy`)};
        const result = await adapter.launchOwnedQemu({paths: paths(), toolchain,
            privilegeMode: "reviewed-sudo-kvm", argv: ["-nic", "none"]});
        assert.equal(result.process.terminationReason, "identity-timeout");
        assert.equal(result.process.cleanupProven, false);
    });

    it("aborts a retained root QEMU group after sustained low memory and proves it gone", async () => {
        let clock = 0, identityReads = 0, finish, groupAlive = true;
        const processCalls = [];
        const adapter = createHostedStage2Operations({context: context(), paths: paths(), dependencies: {
            inspectOwned: rootFileIdentity, inspectDirectory: directoryIdentity,
            runOwned: (command, argv, options) => {
                processCalls.push([command, argv]);
                if (argv.includes("/usr/bin/kill")) {
                    groupAlive = false;
                    finish({process: {...okProcess, exitCode: 137}, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)});
                    return Promise.resolve({process: okProcess, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)});
                }
                if (argv.includes("/usr/bin/readlink")) return Promise.resolve({process: okProcess,
                    stdout: Buffer.from(`${paths().portableRoot}/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2\n`),
                    stderr: Buffer.alloc(0)});
                options.onSpawn(2300);
                options.onTerminationReady(reason => assert.equal(reason, "monitor-low-memory"));
                options.onQmpSession(Promise.resolve(qmpObservation()));
                return new Promise(resolve => { finish = resolve; });
            }, createOwnedPidFile: () => PIDFILE_IDENTITY,
            writeCleanupAuthority: () => undefined,
            pathExists: target => target === paths().qemuPid,
            readOwnedPidFile: (_target, _maximumBytes, expected) => { assert.equal(expected, PIDFILE_IDENTITY);
                return {bytes: Buffer.from("2345\n")}; },
            removeOwnedPidFile: (_target, expected) => assert.equal(expected, PIDFILE_IDENTITY),
            readOwnedVerified: target => ({bytes: Buffer.from("2345\n"), identity: {path: target, bytes: "5",
                sha256: "1".repeat(64)}}),
            readProcessIdentity: pid => pid === 2300 ? {state: "present", pid, processGroupId: 2300,
                startTicks: "66", executablePath: "/owned/timeout"} :
                (++identityReads <= 2 ? {state: "present", pid, processGroupId: 2300,
                    startTicks: "77", executablePath: null} : {state: "absent"}),
            observeRuntimeResources: () => ({taskBytes: "1", freeBytes: "90000000000",
                effectiveMemoryBytes: "4294967295"}),
            monotonicMilliseconds: () => clock,
            wait: async milliseconds => { clock += milliseconds; },
            isProcessGroupAlive: group => { assert.equal(group, 2300); return groupAlive; }
        }});
        const toolchain = {firmware: qemuFirmware(), runtime: {loader: rootFileIdentity(
            `${paths().portableRoot}/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`),
        libraryPath: [`${paths().portableRoot}/lib/x86_64-linux-gnu`]},
        qemu: commandIdentity(`${paths().portableRoot}/usr/bin/qemu-system-x86_64`),
        mcopy: commandIdentity(`${paths().portableRoot}/usr/bin/mcopy`)};
        const result = await adapter.launchOwnedQemu({paths: paths(), toolchain,
            privilegeMode: "reviewed-sudo-kvm", argv: ["-nic", "none"]});
        assert.equal(result.process.terminationReason, "low-memory");
        assert.equal(result.process.cleanupProven, true);
        assert.equal(result.process.treeGone, true);
        assert.deepEqual(processCalls.find(([, argv]) => argv.includes("/usr/bin/kill"))[1].slice(-4),
            ["/usr/bin/kill", "-KILL", "--", "-2300"]);
    });

    it("binds the official ISO redirect, strong ETag, exact length and twin local digests", async () => {
        const calls = [];
        const digest = "a".repeat(64);
        const adapter = createHostedStage2Operations({context: context(), paths: paths(), dependencies: {
            downloadPinned: async request => {
                calls.push(request);
                return {path: request.path, bytes: request.bytes, sha256: digest,
                    finalUrl: request.finalUrl, etag: request.expectedEtag};
            },
            inspectOwned: target => ({path: target, bytes: STAGE2_PROVENANCE.windowsIso.bytes,
                sha256: digest, ownership: {uid: "1001", gid: "127", mode: "600", ordinaryUserWritable: false}})
        }});
        const result = await adapter.acquireWindowsIso({paths: paths(), provenance: STAGE2_PROVENANCE.windowsIso});
        assert.deepEqual(calls, [{url: STAGE2_PROVENANCE.windowsIso.aliasUrl,
            finalUrl: STAGE2_PROVENANCE.windowsIso.finalUrl, path: paths().windowsIso,
            bytes: STAGE2_PROVENANCE.windowsIso.bytes, sha256: null,
            expectedEtag: STAGE2_PROVENANCE.windowsIso.strongEtag}]);
        assert.equal(result.finalUrl, STAGE2_PROVENANCE.windowsIso.finalUrl);
        assert.equal(result.etag, STAGE2_PROVENANCE.windowsIso.strongEtag);
        assert.equal(result.observerA.sha256, digest);
        assert.equal(result.observerB.sha256, digest);
    });

    it("replays producer result identity before accepting probe executable bytes", () => {
        assert.deepEqual(CAPTURED_PROBE_BUILD.source, {runId: "34834310907", runAttempt: "1",
            sourceSha: "dce629fd50ea007221b3a9f2698c32a573bca160"});
        const files = CAPTURED_PROBE_BUILD.build.map(({mode, executable}) => ({role: mode,
            name: `${mode.replaceAll("-", "_")}.exe`, bytes: String(executable.bytes), sha256: executable.sha256}));
        const artifact = {sourceSha: context().sourceSha, runId: context().runId, runAttempt: context().runAttempt, files};
        const evidence = {schemaVersion: 1, kind: "myspeed-windows-cpu-readiness", status: "completed",
            qualifying: false, calibrationPassed: true, classification: "windows-native-host-observation-nonqualifying",
            sourceSha: artifact.sourceSha, eventSha: "b".repeat(40), runId: artifact.runId,
            runAttempt: artifact.runAttempt, nonce: "c".repeat(32), imageVersion: "20260907.1", failures: [],
            observations: {closureFiles: [], discovery: {}, preflight: {}, build: CAPTURED_PROBE_BUILD.build.map(record => ({mode: record.mode,
                macro: "PROBE", architecture: "/arch:SSE2", compileArguments: [], linkArguments: [], object: {},
                executable: structuredClone(record.executable)})), disassembly: [], calibration: {calibrationPassed: true,
                assessment: {calibrationPassed: true}, runs: []}, operations: [], cleanup: {}}};
        const bytes = Buffer.from(JSON.stringify(evidence));
        assert.deepEqual(parseProbeArtifactEvidence(bytes, artifact), {sourceSha: artifact.sourceSha,
            runId: artifact.runId, runAttempt: artifact.runAttempt, eventSha: evidence.eventSha,
            nonce: evidence.nonce, imageVersion: evidence.imageVersion});
        const changed = structuredClone(evidence);
        changed.observations.build[5].executable.sha256 = "f".repeat(64);
        assert.throws(() => parseProbeArtifactEvidence(Buffer.from(JSON.stringify(changed)), artifact),
            /executable evidence/u);
        const wrongRole = structuredClone(evidence);
        wrongRole.observations.build[0].executable.role = "executable";
        assert.throws(() => parseProbeArtifactEvidence(Buffer.from(JSON.stringify(wrongRole)), artifact),
            /executable evidence/u);
        for (const invalidBytes of [files[0].bytes, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
            const invalid = structuredClone(evidence);
            invalid.observations.build[0].executable.bytes = invalidBytes;
            assert.throws(() => parseProbeArtifactEvidence(Buffer.from(JSON.stringify(invalid)), artifact),
                /executable evidence/u);
        }
    });

    it("verifies generated disk geometry and returns computed package-tree manifests", async () => {
        const calls = [];
        const packageIdentities = new Map(TOP_LEVEL_PACKAGE_PINS.flatMap(value => [
            [`${paths().packageRoot}/${value.name}.deb`, value],
            [`${paths().portableRoot}/.packages/${sha256ForTest(Buffer.from(
                `${value.name}:${value.architecture}=${value.version}`)).slice(0, 16)}.deb`, value]]));
        const identity = target => ({path: target.endsWith("/usr/bin/mcopy") || target.endsWith("/usr/bin/mformat") ?
            `${paths().portableRoot}/usr/bin/mtools` : target,
            bytes: packageIdentities.get(target)?.bytes ?? (target.endsWith("output.img") ? "67108864" :
                target.endsWith("bootstrap.ps1") ? "1" : "4096"),
            sha256: packageIdentities.get(target)?.sha256 ?? (target.endsWith("bootstrap.ps1") ?
                sha256ForTest(Buffer.from("x")) : "a".repeat(64)),
            ownership: {uid: "0", gid: "0", mode: packageIdentities.has(target) ? "444" : "555",
                ordinaryUserWritable: false}});
        const adapter = createHostedStage2Operations({context: context(), paths: paths(), dependencies: {
            runOwned: async (command, argv, options) => {
                calls.push([command, argv, options]);
                const stdout = argv.includes(`${paths().portableRoot}/usr/lib/7zip/7z`) && argv.includes("i") ?
                    Buffer.from(`Libs:\n 0 : 23.01 : ${paths().portableRoot}/usr/lib/7zip/7z.so\n\n` +
                        "Formats:\n 0  ED       m  Iso      iso img        CD001\n") :
                    argv.includes("info") && argv.includes(`${paths().portableRoot}/usr/bin/qemu-img`) ?
                        Buffer.from(JSON.stringify({format: "qcow2",
                        "virtual-size": 51_539_607_552})) : Buffer.alloc(0);
                return {process: okProcess, stdout, stderr: Buffer.alloc(0)};
            },
            inspectOwned: identity,
            inspectDirectory: directoryIdentity,
            pathExists: () => false,
            inventoryOwnedTree: (target, selector) => ({root: target, bytes: selector ? "128" : "512",
                sha256: (selector ? "d" : "e").repeat(64)}),
            mkdirExclusive: () => undefined, writeExclusive: () => undefined, copyExclusive: () => undefined,
            makeSizedFile: () => undefined
        }});
        const closure = {packages: TOP_LEVEL_PACKAGE_PINS.map(value => ({...value, dependsOn: []}))};
        const toolchain = await adapter.extractPortableTools({packageClosure: closure,
            acquisition: {packages: closure.packages.map(value => ({reference: `${value.name}:${value.architecture}=${value.version}`,
                path: `${paths().packageRoot}/${value.name}.deb`, bytes: value.bytes, sha256: value.sha256}))},
            paths: paths(), privilegeMode: "reviewed-sudo-kvm"});
        assert.deepEqual(toolchain.installedFilesManifest, {bytes: "512", sha256: "e".repeat(64)});
        assert.deepEqual(toolchain.licensesManifest, {bytes: "128", sha256: "d".repeat(64)});
        assert.deepEqual(toolchain.firmware, {searchPath: `${paths().portableRoot}/usr/share/qemu`,
            kvmvapic: identity(`${paths().portableRoot}/usr/share/qemu/kvmvapic.bin`),
            vga: identity(`${paths().portableRoot}/usr/share/seabios/vgabios-stdvga.bin`)});
        const inline = Buffer.from("x");
        await adapter.prepareOfflineMedia({paths: paths(), toolchain, seedSpec: {sha256: "b".repeat(64), files: [{
            name: "bootstrap.ps1", kind: "activation-installer", bytes: "1", sha256: sha256ForTest(inline),
            bytesBase64: inline.toString("base64")}]}});
        assert.ok(calls.some(([command, argv]) => command === toolchain.runtime.loader.path &&
            JSON.stringify(argv.slice(-4)) === JSON.stringify([toolchain.qemuImg.path, "info", "--output=json",
                paths().systemDisk])));
        assert.ok(calls.some(([, argv]) => argv.includes(toolchain.sevenZip.path) && argv.includes(paths().seedIso) &&
            argv.some(value => value.endsWith("/seed-verify"))));
        for (const role of ["mformat"]) {
            assert.equal(toolchain[role].path, `${paths().portableRoot}/usr/bin/mtools`);
            assert.ok(calls.some(([, argv]) => argv[0] === "--argv0" &&
                argv[1] === `${paths().portableRoot}/usr/bin/${role}` && argv.includes(toolchain[role].path)));
        }
        assert.equal(calls.some(([, argv]) => argv.includes(`::${WINPE_DIAGNOSTIC_OUTPUT_MARKER_NAME}`)), false,
            "ordinary media creation must not write the diagnostic-only output marker");
    });

    it("places and verifies the nonce-bound WinPE output marker on the production FAT disk", async () => {
        const marker = Buffer.from(`${winpeDiagnosticOutputMarker(NONCE)}\r\n`, "ascii");
        const calls = [], writes = new Map();
        const tool = name => commandIdentity(`${paths().portableRoot}/usr/bin/${name}`);
        const toolchain = {runtime: {loader: rootFileIdentity(
            `${paths().portableRoot}/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`),
        libraryPath: [`${paths().portableRoot}/lib/x86_64-linux-gnu`]}, genisoimage: tool("genisoimage"),
        sevenZip: commandIdentity(`${paths().portableRoot}/usr/lib/7zip/7z`), mformat: tool("mformat"),
        mcopy: tool("mcopy"), qemuImg: tool("qemu-img"),
        ovmfVarsTemplate: rootFileIdentity(`${paths().portableRoot}/usr/share/OVMF/OVMF_VARS_4M.fd`)};
        const identity = target => ({path: target, bytes: target.endsWith("output.img") ? "67108864" :
            target.endsWith("bootstrap.ps1") ? "1" : "4096", sha256: target.endsWith("bootstrap.ps1") ?
            crypto.createHash("sha256").update("x").digest("hex") : "a".repeat(64),
            ownership: {uid: "0", gid: "0", mode: "555",
                ordinaryUserWritable: false}});
        const adapter = createHostedStage2Operations({context: context(), paths: paths(), dependencies: {
            mkdirExclusive: () => undefined, makeSizedFile: () => undefined, copyExclusive: () => undefined,
            writeExclusive: (target, bytes) => { writes.set(target, Buffer.from(bytes)); },
            inspectOwned: identity, inspectDirectory: directoryIdentity, pathExists: () => false,
            runOwned: async (command, argv, options) => {
                calls.push({command, argv, options});
                const stdout = argv.includes("info") ? Buffer.from(JSON.stringify({format: "qcow2",
                    "virtual-size": 51_539_607_552})) :
                    argv.includes(`::${WINPE_DIAGNOSTIC_OUTPUT_MARKER_NAME}`) && argv.at(-1) === "-" ?
                        marker : Buffer.alloc(0);
                return {process: okProcess, stdout, stderr: Buffer.alloc(0)};
            }
        }});
        const inline = Buffer.from("x");
        await adapter.prepareOfflineMedia({paths: paths(), toolchain, winpeDiagnostic: {
            confirmation: WINPE_DIAGNOSTIC_CONFIRMATION, nonce: NONCE}, seedSpec: {sha256: "b".repeat(64), files: [{
            name: "bootstrap.ps1", kind: "activation-installer", bytes: "1",
            sha256: crypto.createHash("sha256").update(inline).digest("hex"),
            bytesBase64: inline.toString("base64")}]}});
        const markerFile = [...writes.entries()].find(([, bytes]) => bytes.equals(marker));
        assert.ok(markerFile, "the exact marker must be staged before mcopy");
        const markerWrites = calls.filter(call => call.argv.includes(`::${WINPE_DIAGNOSTIC_OUTPUT_MARKER_NAME}`));
        assert.equal(markerWrites.length, 2, "mcopy must write and then read back the sole allowed marker");
        assert.deepEqual(markerWrites[0].argv.slice(-2), [markerFile[0], `::${WINPE_DIAGNOSTIC_OUTPUT_MARKER_NAME}`]);
        assert.deepEqual(markerWrites[1].argv.slice(-2), [`::${WINPE_DIAGNOSTIC_OUTPUT_MARKER_NAME}`, "-"]);
        assert.equal(markerWrites[1].options.maxStreamBytes, marker.length);
    });

    it("rejects unbound, unwritable, and mismatched diagnostic output markers before QEMU media exists", async () => {
        const marker = Buffer.from(`${winpeDiagnosticOutputMarker(NONCE)}\r\n`, "ascii");
        const tool = name => commandIdentity(`${paths().portableRoot}/usr/bin/${name}`);
        const toolchain = {runtime: {loader: rootFileIdentity(
            `${paths().portableRoot}/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`),
        libraryPath: [`${paths().portableRoot}/lib/x86_64-linux-gnu`]}, genisoimage: tool("genisoimage"),
        sevenZip: commandIdentity(`${paths().portableRoot}/usr/lib/7zip/7z`), mformat: tool("mformat"),
        mcopy: tool("mcopy"), qemuImg: tool("qemu-img"),
        ovmfVarsTemplate: rootFileIdentity(`${paths().portableRoot}/usr/share/OVMF/OVMF_VARS_4M.fd`)};
        const inline = Buffer.from("x");
        const seedSpec = {sha256: "b".repeat(64), files: [{name: "bootstrap.ps1",
            kind: "activation-installer", bytes: "1", sha256: crypto.createHash("sha256").update(inline).digest("hex"),
            bytesBase64: inline.toString("base64")}]};
        const run = async ({authorization = {confirmation: WINPE_DIAGNOSTIC_CONFIRMATION, nonce: NONCE},
            readback = marker, writeProcess = okProcess} = {}) => {
            const calls = [];
            const identity = target => ({path: target, bytes: target.endsWith("output.img") ? "67108864" :
                target.endsWith("bootstrap.ps1") ? "1" : "4096", sha256: target.endsWith("bootstrap.ps1") ?
                crypto.createHash("sha256").update("x").digest("hex") : "a".repeat(64),
                ownership: {uid: "0", gid: "0", mode: "555", ordinaryUserWritable: false}});
            const adapter = createHostedStage2Operations({context: context(), paths: paths(), dependencies: {
                mkdirExclusive: () => undefined, makeSizedFile: () => undefined, copyExclusive: () => undefined,
                writeExclusive: () => undefined, inspectOwned: identity, inspectDirectory: directoryIdentity,
                pathExists: () => false, runOwned: async (command, argv, options) => {
                    calls.push({command, argv, options});
                    const markerRead = argv.includes(`::${WINPE_DIAGNOSTIC_OUTPUT_MARKER_NAME}`) && argv.at(-1) === "-";
                    const markerWrite = argv.includes(`::${WINPE_DIAGNOSTIC_OUTPUT_MARKER_NAME}`) && !markerRead;
                    return {process: markerWrite ? writeProcess : okProcess,
                        stdout: markerRead ? readback : argv.includes("info") ? Buffer.from(JSON.stringify({format: "qcow2",
                            "virtual-size": 51_539_607_552})) : Buffer.alloc(0), stderr: Buffer.alloc(0)};
                }
            }});
            const preparation = adapter.prepareOfflineMedia({paths: paths(), toolchain, winpeDiagnostic: authorization, seedSpec});
            return {calls, preparation};
        };
        const foreign = await run({authorization: {confirmation: WINPE_DIAGNOSTIC_CONFIRMATION, nonce: "f".repeat(32)}});
        await assert.rejects(foreign.preparation, /not bound/u);
        assert.deepEqual(foreign.calls, []);
        for (const readback of [Buffer.from("changed\r\n", "ascii"), marker.subarray(0, marker.length - 1),
            Buffer.concat([marker, Buffer.from("extra", "ascii")])]) {
            const attempt = await run({readback});
            await assert.rejects(attempt.preparation, /marker identity differs/u);
            assert.equal(attempt.calls.some(call => call.argv.includes("create") && call.argv.includes("qcow2")), false);
        }
        const failedWrite = await run({writeProcess: {...okProcess, exitCode: 1}});
        await assert.rejects(failedWrite.preparation, /marker creation did not complete safely/u);
        assert.equal(failedWrite.calls.some(call => call.argv.includes("create") && call.argv.includes("qcow2")), false);
    });

    it("validates output disk with lexical lstat and descriptor fstat O_NOFOLLOW binding pre-launch identity", () => {
        const target = paths().outputDisk;
        const expectedOwner = {uid: 1001n, gid: 1001n};
        const mockFs = {
            constants: {O_RDONLY: 0, O_NOFOLLOW: 0x20000},
            lstatSync: () => ({
                isSymbolicLink: () => false,
                isFile: () => true,
                nlink: 1n,
                dev: 42n,
                ino: 100n,
                uid: 1001n,
                gid: 1001n,
                mode: 0o600n,
                size: 67_108_864n
            }),
            openSync: () => 7,
            closeSync: () => undefined,
            fstatSync: () => ({
                isFile: () => true,
                nlink: 1n,
                dev: 42n,
                ino: 100n,
                uid: 1001n,
                gid: 1001n,
                mode: 0o600n,
                size: 67_108_864n
            })
        };

        // 1. Unknown owner identity rejected when process.getuid is unavailable and no expectedOwner given
        if (typeof process.getuid !== "function") {
            assert.throws(() => defaultValidateOutputDisk(target, null, mockFs, null), /owner identity is unknown/u);
        }

        // 2. Unexpected owner UID rejected
        assert.throws(() => defaultValidateOutputDisk(target, null, mockFs, {uid: 99999n, gid: 1001n}),
            /owner UID does not match/u);

        // 3. Unexpected owner GID rejected
        assert.throws(() => defaultValidateOutputDisk(target, null, mockFs, {uid: 1001n, gid: 99999n}),
            /owner GID does not match/u);

        // 4. Unsafe modes rejected: 0620, 0602, 0666
        for (const badMode of [0o620n, 0o602n, 0o666n]) {
            const unsafeModeFs = {...mockFs,
                lstatSync: () => ({...mockFs.lstatSync(), mode: badMode}),
                fstatSync: () => ({...mockFs.fstatSync(), mode: badMode})};
            assert.throws(() => defaultValidateOutputDisk(target, null, unsafeModeFs, expectedOwner),
                /permissions are unsafe/u);
        }

        // 5. Non-owner-writable mode rejected: 0400
        const roFs = {...mockFs,
            lstatSync: () => ({...mockFs.lstatSync(), mode: 0o400n}),
            fstatSync: () => ({...mockFs.fstatSync(), mode: 0o400n})};
        assert.throws(() => defaultValidateOutputDisk(target, null, roFs, expectedOwner),
            /retain owner writability/u);

        // 6. Lexical vs descriptor mode mismatch rejected
        const modeMismatchFs = {...mockFs,
            lstatSync: () => ({...mockFs.lstatSync(), mode: 0o600n}),
            fstatSync: () => ({...mockFs.fstatSync(), mode: 0o644n})};
        assert.throws(() => defaultValidateOutputDisk(target, null, modeMismatchFs, expectedOwner),
            /mode mismatch/u);

        // 7. Exact expected owner and safe owner-writable modes accepted
        const pre = defaultValidateOutputDisk(target, null, mockFs, expectedOwner);
        assert.deepEqual(pre, {dev: 42n, ino: 100n, uid: 1001n, gid: 1001n, size: 67_108_864n, mode: "600"});

        for (const safeMode of [0o644n, 0o640n]) {
            const safeFs = {...mockFs,
                lstatSync: () => ({...mockFs.lstatSync(), mode: safeMode}),
                fstatSync: () => ({...mockFs.fstatSync(), mode: safeMode})};
            const validated = defaultValidateOutputDisk(target, null, safeFs, expectedOwner);
            assert.equal(validated.mode, (safeMode & 0o7777n).toString(8));
        }

        // 8. Matches pre-launch identity
        const post = defaultValidateOutputDisk(target, pre, mockFs, expectedOwner);
        assert.deepEqual(post, pre);

        // 9. Post-launch mode change rejected
        const modeChangedFs = {...mockFs,
            lstatSync: () => ({...mockFs.lstatSync(), mode: 0o644n}),
            fstatSync: () => ({...mockFs.fstatSync(), mode: 0o644n})};
        assert.throws(() => defaultValidateOutputDisk(target, pre, modeChangedFs, expectedOwner),
            /mode changed post-launch/u);

        // 10. Post-launch owner UID change rejected
        const ownerChangedFs = {...mockFs,
            lstatSync: () => ({...mockFs.lstatSync(), uid: 1002n}),
            fstatSync: () => ({...mockFs.fstatSync(), uid: 1002n})};
        assert.throws(() => defaultValidateOutputDisk(target, pre, ownerChangedFs, {uid: 1002n, gid: 1001n}),
            /identity does not match/u);

        // 11. Symlink rejected
        const symlinkFs = {...mockFs, lstatSync: () => ({...mockFs.lstatSync(), isSymbolicLink: () => true})};
        assert.throws(() => defaultValidateOutputDisk(target, pre, symlinkFs, expectedOwner), /symlink|single-link/u);

        // 12. Multi-link rejected
        const multiLinkFs = {...mockFs, lstatSync: () => ({...mockFs.lstatSync(), nlink: 2n})};
        assert.throws(() => defaultValidateOutputDisk(target, pre, multiLinkFs, expectedOwner), /single-link/u);

        // 13. Wrong size rejected
        const wrongSizeFs = {...mockFs, fstatSync: () => ({...mockFs.fstatSync(), size: 1024n})};
        assert.throws(() => defaultValidateOutputDisk(target, pre, wrongSizeFs, expectedOwner), /size|stat mismatch/u);

        // 14. Device or inode changed between pre-launch and post-run
        const changedInoFs = {...mockFs,
            lstatSync: () => ({...mockFs.lstatSync(), ino: 999n}),
            fstatSync: () => ({...mockFs.fstatSync(), ino: 999n})};
        assert.throws(() => defaultValidateOutputDisk(target, pre, changedInoFs, expectedOwner), /identity does not match/u);

        // 15. Inode mismatch between lexical lstat and descriptor fstat
        const mismatchFs = {...mockFs, fstatSync: () => ({...mockFs.fstatSync(), ino: 999n})};
        assert.throws(() => defaultValidateOutputDisk(target, pre, mismatchFs, expectedOwner), /stat mismatch/u);
    });

    it("enforces 25-minute diagnostic deadline when supplied and retains shared defaults when omitted", async () => {
        assert.equal(DIAGNOSTIC_EXECUTION_MINUTES, 25);
        assert.equal(DIAGNOSTIC_CLEANUP_MINUTES, 5);
        assert.equal(DIAGNOSTIC_TIMEOUT_SECONDS, 1500);
        assert.equal(DIAGNOSTIC_CLEANUP_HEADROOM_SECONDS, 40);
        assert.ok(DIAGNOSTIC_CLEANUP_HEADROOM_SECONDS <= DIAGNOSTIC_CLEANUP_MINUTES * 60);
        assert.equal(DIAGNOSTIC_OUTER_TIMEOUT_MILLISECONDS, 1_540_000);
        assert.equal(DIAGNOSTIC_OUTER_TIMEOUT_MILLISECONDS,
            (DIAGNOSTIC_TIMEOUT_SECONDS + DIAGNOSTIC_CLEANUP_HEADROOM_SECONDS) * 1_000);

        let monitoredRequest = null;
        let commandArgv = null;
        let currentTime = 1000;
        const fakeIo = {
            inspectOwned: rootFileIdentity,
            inspectDirectory: directoryIdentity,
            monotonicMilliseconds: () => currentTime,
            pathExists: () => false,
            runMonitoredQemu: async req => {
                monitoredRequest = req;
                commandArgv = req.argv;
                return {
                    observation: {process: okProcess, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)},
                    identity: {pid: 2345, startTicks: "77",
                        executablePath: `${paths().portableRoot}/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`,
                        processGroupId: 2300},
                    absentAfter: true,
                    processGroupGone: true,
                    qmp: qmpObservation()
                };
            }
        };

        const toolchain = {
            runtime: {loader: rootFileIdentity(`${paths().portableRoot}/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`),
                libraryPath: [`${paths().portableRoot}/lib/x86_64-linux-gnu`]},
            qemu: commandIdentity(`${paths().portableRoot}/usr/bin/qemu-system-x86_64`),
            firmware: qemuFirmware()
        };
        const launcher = createHostedQemuProcessLauncher({context: context(), dependencies: fakeIo});

        // Advance fake clock during acquisition (simulating 599s elapsed prep time)
        currentTime = 600_000;

        // 1. Diagnostic deadlines: exactly 1500s from launchTime (launch-relative)
        await launcher({
            toolchain, paths: paths(), argv: ["-m", "4G"], privilegeMode: "ordinary-kvm",
            deadlines: {executionMinutes: 25, cleanupMinutes: 5}
        });
        assert.equal(commandArgv.includes("1500s"), true);
        assert.equal(monitoredRequest.timeoutMs, 1_540_000);
        assert.equal(monitoredRequest.executionDeadline, 600_000 + 1500 * 1000);
        // Late screenshot paths supplied for diagnostic contract
        assert.deepEqual(monitoredRequest.qmp.lateScreenshotPaths, [
            `${paths().root}/late-boot-1.png`,
            `${paths().root}/late-boot-2.png`
        ]);

        // 2. Unsupported deadlines: fails closed
        await assert.rejects(launcher({
            toolchain, paths: paths(), argv: ["-m", "4G"], privilegeMode: "ordinary-kvm",
            deadlines: {executionMinutes: 10, cleanupMinutes: 5}
        }), /unsupported QEMU deadlines/u);
        await assert.rejects(launcher({
            toolchain, paths: paths(), argv: ["-m", "4G"], privilegeMode: "ordinary-kvm",
            deadlines: {executionMinutes: 270, cleanupMinutes: 30}
        }), /unsupported QEMU deadlines/u);

        // 3. Shared callers omitting deadlines: retains shared defaults and stage-relative deadline
        await launcher({
            toolchain, paths: paths(), argv: ["-m", "4G"], privilegeMode: "ordinary-kvm"
        });
        assert.equal(commandArgv.includes("16200s"), true);
        assert.equal(monitoredRequest.timeoutMs, 16_240_000);
        assert.equal(monitoredRequest.executionDeadline, Math.min(600_000 + 16_200 * 1000, 1000 + 16_200 * 1000));
        // Deadline-less callers MUST NOT receive lateScreenshotPaths
        assert.equal(monitoredRequest.qmp.lateScreenshotPaths, undefined);

        /*
         * 4. A named reservation. It is launch-relative like the diagnostic one, but it is a
         * separate input: the containment preflight must never reach the CPU diagnostic's flag, and
         * it must never fall through to the 270-minute default it would otherwise get.
         */
        await launcher({
            toolchain, paths: paths(), argv: ["-m", "4G"], privilegeMode: "ordinary-kvm",
            reservation: {label: "containment-preflight", executionMilliseconds: 900_000,
                cleanupMilliseconds: 120_000}
        });
        assert.equal(commandArgv.includes("900s"), true);
        assert.equal(commandArgv.includes("16200s"), false);
        assert.equal(monitoredRequest.timeoutMs, 1_020_000);
        assert.equal(monitoredRequest.executionDeadline, 600_000 + 900_000);
        assert.equal(monitoredRequest.qmp.lateScreenshotPaths, undefined);

        // 5. A reservation may only tighten the launcher deadline, and must be complete.
        for (const reservation of [
            {label: "", executionMilliseconds: 900_000, cleanupMilliseconds: 120_000},
            {label: "containment-preflight", executionMilliseconds: 999,
                cleanupMilliseconds: 120_000},
            {label: "containment-preflight", executionMilliseconds: 900_000,
                cleanupMilliseconds: 0},
            {label: "containment-preflight", executionMilliseconds: 16_200_001,
                cleanupMilliseconds: 120_000},
            {label: "containment-preflight", executionMilliseconds: 900.5,
                cleanupMilliseconds: 120_000},
            {label: "containment-preflight", executionMilliseconds: 900_000},
            {label: "containment-preflight", executionMilliseconds: 900_000,
                cleanupMilliseconds: 120_000, extra: 1}])
            await assert.rejects(launcher({toolchain, paths: paths(), argv: ["-m", "4G"],
                privilegeMode: "ordinary-kvm", reservation}), /QEMU reservation/u,
            JSON.stringify(reservation));

        // 6. The diagnostic flag and a reservation are never both in force.
        await assert.rejects(launcher({
            toolchain, paths: paths(), argv: ["-m", "4G"], privilegeMode: "ordinary-kvm",
            deadlines: {executionMinutes: 25, cleanupMinutes: 5},
            reservation: {label: "containment-preflight", executionMilliseconds: 900_000,
                cleanupMilliseconds: 120_000}
        }), /QEMU reservation/u);

        // 7. The diagnostic behaviour is exactly what it was before the reservation existed.
        await launcher({
            toolchain, paths: paths(), argv: ["-m", "4G"], privilegeMode: "ordinary-kvm",
            deadlines: {executionMinutes: 25, cleanupMinutes: 5}
        });
        assert.equal(commandArgv.includes("1500s"), true);
        assert.equal(monitoredRequest.timeoutMs, 1_540_000);
        assert.equal(monitoredRequest.executionDeadline, 600_000 + 1500 * 1000);
    });

    it("gates failure receipt extraction strictly on proven cleanup and owned output identity", async () => {
        const failureReceipt = Buffer.from(JSON.stringify({
            schemaVersion: 1, status: "failed", nonce: NONCE,
            stage: "guest-bootstrap", failure: "bootstrap test failure"
        }) + "\n");
        const observedReceipt = Buffer.from(JSON.stringify({
            schemaVersion: 1, status: "observed", nonce: NONCE
        }) + "\n");

        let mcopyCalled = false;
        let diskValidationCalled = false;

        const makeAdapter = ({cleanupProven, treeGone, failDiskValidation, receiptBytes, mcopyThrows}) => {
            mcopyCalled = false;
            diskValidationCalled = false;
            return createHostedStage2Operations({context: context(), paths: paths(), dependencies: {
                monotonicMilliseconds: () => 1000,
                pathExists: () => false,
                inspectOwned: target => target === paths().outputDisk ? ({path: target, bytes: "67108864", sha256: "a".repeat(64),
                    ownership: {uid: "1001", gid: "1001", mode: "600", ordinaryUserWritable: false}}) : rootFileIdentity(target),
                inspectDirectory: directoryIdentity,
                validateOutputDisk: (_target, _expected) => {
                    diskValidationCalled = true;
                    if (failDiskValidation) throw new Error("disk validation failed");
                    return {dev: 1n, ino: 2n, uid: 1001n, gid: 1001n, size: 67_108_864n};
                },
                runMonitoredQemu: async () => ({
                    observation: {process: {...okProcess, exitCode: 1, cleanupProven, timedOut: false},
                        stdout: Buffer.alloc(0), stderr: Buffer.from("qemu error\n")},
                    identity: {pid: 2345, startTicks: "77",
                        executablePath: `${paths().portableRoot}/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`,
                        processGroupId: 2300},
                    absentAfter: cleanupProven,
                    processGroupGone: treeGone,
                    qmp: qmpObservation()
                }),
                /*
                 * The receipt is read from the extraction's own streamed stdout, so the mock hands
                 * the bytes back the way mcopy does. A fixture that left stdout empty and planted
                 * the receipt in the task root instead would only be testing a substitution the
                 * host must not make.
                 */
                runOwned: async (cmd, argv) => {
                    if (argv.includes("mcopy") || argv.includes(`${paths().portableRoot}/usr/bin/mtools`)) {
                        mcopyCalled = true;
                        if (mcopyThrows) throw new Error("mcopy failed");
                        return {process: okProcess, stdout: receiptBytes, stderr: Buffer.alloc(0)};
                    }
                    return {process: okProcess, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)};
                }
            }});
        };

        const toolchain = {
            runtime: {loader: rootFileIdentity(`${paths().portableRoot}/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`),
                libraryPath: [`${paths().portableRoot}/lib/x86_64-linux-gnu`]},
            qemu: commandIdentity(`${paths().portableRoot}/usr/bin/qemu-system-x86_64`),
            mcopy: commandIdentity(`${paths().portableRoot}/usr/bin/mtools`),
            firmware: qemuFirmware()
        };
        // 1. Proven cleanup (cleanupProven === true && treeGone === true) -> extracts failure receipt
        const adapter1 = makeAdapter({cleanupProven: true, treeGone: true, failDiskValidation: false, receiptBytes: failureReceipt});
        const res1 = await adapter1.launchOwnedQemu({toolchain, paths: paths(), argv: [], privilegeMode: "ordinary-kvm"});
        assert.equal(diskValidationCalled, true);
        assert.equal(mcopyCalled, true);
        assert.deepEqual(res1.guestFailure, {
            schemaVersion: 1, status: "failed", nonce: NONCE,
            stage: "guest-bootstrap", failure: "bootstrap test failure"
        });
        assert.equal(res1.guest, null);

        // 2. Unproven cleanup (cleanupProven === false) -> NO extraction
        const adapter2 = makeAdapter({cleanupProven: false, treeGone: false, failDiskValidation: false, receiptBytes: failureReceipt});
        const res2 = await adapter2.launchOwnedQemu({toolchain, paths: paths(), argv: [], privilegeMode: "ordinary-kvm"});
        assert.equal(mcopyCalled, false);
        assert.equal("guestFailure" in res2, false);
        assert.equal(res2.guest, null);

        // 3. Disk validation failure -> NO extraction
        const adapter3 = makeAdapter({cleanupProven: true, treeGone: true, failDiskValidation: true, receiptBytes: failureReceipt});
        const res3 = await adapter3.launchOwnedQemu({toolchain, paths: paths(), argv: [], privilegeMode: "ordinary-kvm"});
        assert.equal(mcopyCalled, false);
        assert.equal("guestFailure" in res3, false);
        assert.equal(res3.guest, null);

        // 4. Mcopy failure -> caught safely, primary error preserved
        const adapter4 = makeAdapter({cleanupProven: true, treeGone: true, failDiskValidation: false, receiptBytes: failureReceipt, mcopyThrows: true});
        const res4 = await adapter4.launchOwnedQemu({toolchain, paths: paths(), argv: [], privilegeMode: "ordinary-kvm"});
        assert.equal(mcopyCalled, true);
        assert.equal("guestFailure" in res4, false);
        assert.equal(res4.guest, null);

        // 5. Observed status on failed launch -> rejected, guestFailure omitted
        const adapter5 = makeAdapter({cleanupProven: true, treeGone: true, failDiskValidation: false, receiptBytes: observedReceipt});
        const res5 = await adapter5.launchOwnedQemu({toolchain, paths: paths(), argv: [], privilegeMode: "ordinary-kvm"});
        assert.equal(mcopyCalled, true);
        assert.equal("guestFailure" in res5, false);
        assert.equal(res5.guest, null);
    });

    it("gates late screenshot extraction strictly on proven cleanup and unlingering process group", async () => {
        let readScreenshots = [];
        const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
        const lateMilestones = [
            {milestone: 1, offsetMs: 120_000, status: "running", running: true,
             screenshotPath: `${paths().root}/late-boot-1.png`},
            {milestone: 2, offsetMs: 300_000, status: "running", running: true,
             screenshotPath: `${paths().root}/late-boot-2.png`}
        ];

        const makeAdapter = ({cleanupProven, treeGone, corruptScreenshot = false}) => {
            readScreenshots = [];
            return createHostedStage2Operations({context: context(), paths: paths(), dependencies: {
                monotonicMilliseconds: () => 1000,
                pathExists: () => false,
                inspectOwned: rootFileIdentity,
                inspectDirectory: directoryIdentity,
                runMonitoredQemu: async () => ({
                    observation: {process: {...okProcess, exitCode: 1, cleanupProven, timedOut: false},
                        stdout: Buffer.alloc(0), stderr: Buffer.from("qemu error\n")},
                    identity: {pid: 2345, startTicks: "77",
                        executablePath: `${paths().portableRoot}/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`,
                        processGroupId: 2300},
                    absentAfter: cleanupProven,
                    processGroupGone: treeGone,
                    qmp: qmpObservation(),
                    lateBoot: {milestones: lateMilestones}
                }),
                readOwnedVerified: (target, _maxBytes) => {
                    readScreenshots.push(target);
                    const bytes = corruptScreenshot ? Buffer.from("not-a-png") : pngBytes;
                    return {bytes, identity: {path: target, bytes: String(bytes.length), sha256: sha256ForTest(bytes)}};
                }
            }});
        };

        const toolchain = {
            runtime: {loader: rootFileIdentity(`${paths().portableRoot}/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`),
                libraryPath: [`${paths().portableRoot}/lib/x86_64-linux-gnu`]},
            qemu: commandIdentity(`${paths().portableRoot}/usr/bin/qemu-system-x86_64`),
            mcopy: commandIdentity(`${paths().portableRoot}/usr/bin/mtools`),
            firmware: qemuFirmware()
        };

        // 1. Proven cleanup (cleanupProven === true && treeGone === true) -> reads late screenshots
        const adapter1 = makeAdapter({cleanupProven: true, treeGone: true});
        const res1 = await adapter1.launchOwnedQemu({toolchain, paths: paths(), argv: [], privilegeMode: "ordinary-kvm"});
        assert.equal(readScreenshots.includes(`${paths().root}/late-boot-1.png`), true);
        assert.equal(readScreenshots.includes(`${paths().root}/late-boot-2.png`), true);
        assert.equal("lateBoot" in res1, true);
        assert.equal(res1.lateBoot.milestones.length, 2);

        // 2. Unproven cleanup (cleanupProven === false) -> late screenshots are NOT read
        const adapter2 = makeAdapter({cleanupProven: false, treeGone: true});
        const res2 = await adapter2.launchOwnedQemu({toolchain, paths: paths(), argv: [], privilegeMode: "ordinary-kvm"});
        assert.equal(readScreenshots.includes(`${paths().root}/late-boot-1.png`), false);
        assert.equal(readScreenshots.includes(`${paths().root}/late-boot-2.png`), false);
        assert.equal("lateBoot" in res2, false);

        // 3. Lingering process group (treeGone === false) -> late screenshots are NOT read
        const adapter3 = makeAdapter({cleanupProven: true, treeGone: false});
        const res3 = await adapter3.launchOwnedQemu({toolchain, paths: paths(), argv: [], privilegeMode: "ordinary-kvm"});
        assert.equal(readScreenshots.includes(`${paths().root}/late-boot-1.png`), false);
        assert.equal(readScreenshots.includes(`${paths().root}/late-boot-2.png`), false);
        assert.equal("lateBoot" in res3, false);

        // 4. Corrupt screenshot -> caught safely, lateBoot omitted, primary failureDiagnostic preserved
        const adapter4 = makeAdapter({cleanupProven: true, treeGone: true, corruptScreenshot: true});
        const res4 = await adapter4.launchOwnedQemu({toolchain, paths: paths(), argv: [], privilegeMode: "ordinary-kvm"});
        assert.equal("lateBoot" in res4, false);
        assert.equal("failureDiagnostic" in res4, true);
        assert.equal(res4.process.exitCode, 1);
    });

    it("derives the late-boot display-progress verdict from the captured frame digests", async () => {
        const png = target => Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            Buffer.from(target)
        ]);
        const lateMilestones = [
            {milestone: 1, offsetMs: 120_000, status: "running", running: true,
             screenshotPath: `${paths().root}/late-boot-1.png`},
            {milestone: 2, offsetMs: 300_000, status: "running", running: true,
             screenshotPath: `${paths().root}/late-boot-2.png`}
        ];
        const toolchain = {
            runtime: {loader: rootFileIdentity(`${paths().portableRoot}/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`),
                libraryPath: [`${paths().portableRoot}/lib/x86_64-linux-gnu`]},
            qemu: commandIdentity(`${paths().portableRoot}/usr/bin/qemu-system-x86_64`),
            mcopy: commandIdentity(`${paths().portableRoot}/usr/bin/mtools`),
            firmware: qemuFirmware()
        };
        const makeAdapter = (frameFor, options = {}) => createHostedStage2Operations({context: context(), paths: paths(),
            dependencies: {
                monotonicMilliseconds: () => 1000,
                pathExists: () => false,
                inspectOwned: rootFileIdentity,
                inspectDirectory: directoryIdentity,
                runMonitoredQemu: async () => ({
                    observation: {process: {...okProcess, exitCode: 137, cleanupProven: true, timedOut: false},
                        stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)},
                    identity: {pid: 2345, startTicks: "77",
                        executablePath: `${paths().portableRoot}/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`,
                        processGroupId: 2300},
                    absentAfter: true,
                    processGroupGone: true,
                    qmp: options.qmp === undefined ? qmpObservation() : options.qmp,
                    lateBoot: {milestones: options.milestones ?? lateMilestones}
                }),
                readOwnedVerified: target => {
                    const bytes = png(frameFor(target));
                    return {bytes, identity: {path: target, bytes: String(bytes.length),
                        sha256: sha256ForTest(bytes)}};
                },
                readOwnedPrefixVerified: target => {
                    const bytes = png(frameFor(target));
                    return {bytes, identity: {path: target, bytes: String(bytes.length),
                        sha256: sha256ForTest(bytes), observedBytes: String(bytes.length), truncated: false}};
                }
            }});

        // A guest that is alive but frozen: every frame from the last early capture onwards is the
        // same image, which is exactly the shape a QEMU killed at its wrapper deadline produces.
        const frozen = await makeAdapter(() => "frozen").launchOwnedQemu({toolchain, paths: paths(), argv: [],
            privilegeMode: "ordinary-kvm"});
        assert.equal(frozen.lateBoot.displayAdvanced, false);

        // A guest that is actually progressing changes the framebuffer between milestones.
        const moving = await makeAdapter(target => target).launchOwnedQemu({toolchain, paths: paths(), argv: [],
            privilegeMode: "ordinary-kvm"});
        assert.equal(moving.lateBoot.displayAdvanced, true);

        // Progress before the late window must not be counted: early-boot-1 differing from
        // early-boot-2 is firmware still drawing its first screen, not the guest advancing.
        const earlyOnly = await makeAdapter(target =>
            target.endsWith("early-boot-1.png") ? "first" : "settled").launchOwnedQemu({toolchain, paths: paths(),
            argv: [], privilegeMode: "ordinary-kvm"});
        assert.equal(earlyOnly.lateBoot.displayAdvanced, false);

        // Undetermined: without an early observation a single milestone leaves nothing to compare,
        // so the verdict stays null instead of claiming the display did not advance.
        const undetermined = await makeAdapter(() => "only", {qmp: null,
            milestones: [lateMilestones[0]]}).launchOwnedQemu({toolchain, paths: paths(), argv: [],
            privilegeMode: "ordinary-kvm"});
        assert.equal(undetermined.earlyBoot, null);
        assert.equal(undetermined.lateBoot.milestones.length, 1);
        assert.equal(undetermined.lateBoot.displayAdvanced, null);

        // Serial is bounded evidence only: it can be empty and never proves that firmware did not
        // display a prompt. An unavailable capture remains explicit without failing the diagnostic.
        const serialBytes = png("frozen");
        assert.deepEqual(frozen.failureDiagnostic.serialLog, {status: "captured", bytes: String(serialBytes.length),
            sha256: sha256ForTest(serialBytes), bytesBase64: serialBytes.toString("base64"),
            observedBytes: String(serialBytes.length), truncated: false});
        const withoutSerial = await makeAdapter(target => {
            if (target === paths().serialLog) throw new Error("owned file read bound is invalid");
            return "frozen";
        }).launchOwnedQemu({toolchain, paths: paths(), argv: [], privilegeMode: "ordinary-kvm"});
        assert.deepEqual(withoutSerial.failureDiagnostic.serialLog, {status: "unavailable"});
        assert.equal(withoutSerial.lateBoot.displayAdvanced, false);
    });

    it("cancels QMP handle on child termination and monitor abort while keeping late observation failure separate from qmp-failed", async () => {
        // 1. In runHostedOwnedProcess: handle cancellation on close
        let capturedOnSessionHandle = null;
        const fakeChild = new EventEmitter();
        fakeChild.stdout = new EventEmitter();
        fakeChild.stderr = new EventEmitter();
        fakeChild.stdin = {destroy: () => {}, write: (_b, cb) => cb()};
        fakeChild.pid = 4321;

        const spawnImpl = () => fakeChild;

        const opPromise = runHostedOwnedProcess("qemu", [], {
            timeoutMs: 5000,
            qmp: {
                screenshotPaths: [`${paths().root}/early-boot-1.png`, `${paths().root}/early-boot-2.png`],
                lateScreenshotPaths: [`${paths().root}/late-boot-1.png`, `${paths().root}/late-boot-2.png`]
            },
            onQmpSessionHandle: handle => {
                capturedOnSessionHandle = handle;
            }
        }, {
            spawnImpl,
            isGroupAlive: () => false
        });

        // Trigger child close
        fakeChild.emit("close", 0, null);
        const hostedRes = await opPromise;
        assert.equal(hostedRes.process.exitCode, 0);
        assert.equal(hostedRes.process.cleanupProven, true);
        assert.notEqual(capturedOnSessionHandle, null);
        assert.equal(typeof capturedOnSessionHandle.cancel, "function");

        // 2. In runMonitoredQemu: handle cancellation on monitor abort (deadline)
        let cancelCalled = false;
        const fakeHandle = {
            cancel: () => {
                cancelCalled = true;
            }
        };
        let nowMs = 1000;
        const fakeQmpObs = qmpObservation();
        const monitoredResult = await runMonitoredQemu({
            createOwnedPidFile: () => null,
            pathExists: () => true,
            readOwnedVerified: () => ({bytes: Buffer.from("1234\n")}),
            readQemuProcessIdentity: async () => ({state: "present", pid: 1234, processGroupId: 1234,
                startTicks: "55", executablePath: "/bin/qemu"}),
            observeRuntimeResources: async () => ({
                taskBytes: "1000", freeBytes: "100000000000", effectiveMemoryBytes: "10000000000"
            }),
            monotonicMilliseconds: () => {
                nowMs += 500_000;
                return nowMs;
            },
            wait: async () => {},
            isProcessGroupAlive: () => false,
            runOwned: async (_cmd, _argv, opts) => {
                opts.onSpawn(1234);
                opts.onQmpSessionHandle?.(fakeHandle);
                opts.onQmpSession?.(Promise.resolve(fakeQmpObs));
                // Deliver a rejected late observation promise: must NOT cause qmp-failed
                opts.onLateObservation?.(Promise.reject(new Error("late screenshot timeout")));
                return {
                    process: {...okProcess, exitCode: 0, cleanupProven: true},
                    stdout: Buffer.alloc(0),
                    stderr: Buffer.alloc(0)
                };
            }
        }, {
            command: "/bin/qemu",
            argv: [],
            timeoutMs: 1_540_000,
            executionDeadline: 2000,
            expectedExecutable: "/bin/qemu",
            pidPath: "/tmp/pid",
            resources: {},
            qmp: {screenshotPaths: []}
        });

        // Cancel called on abort
        assert.equal(cancelCalled, true);
        // Late observation failure does NOT cause qmp-failed
        assert.notEqual(monitoredResult.terminationReason, "qmp-failed");
        assert.equal(monitoredResult.lateBoot, null);
    });
});

function sha256ForTest(bytes) {
    return crypto.createHash("sha256").update(bytes).digest("hex");
}

describe("Stage 3 serial completion observer", () => {
    const COMPLETION_NONCE = "8a1065a48db13a3f671b2e6824507521";
    const DIGEST = character => character.repeat(64);
    const VALID_RECORD = {schemaVersion: 1, kind: "myspeed-stage3-publication-complete", nonce: COMPLETION_NONCE,
        baseline: {bytes: "1985", sha256: DIGEST("a")}, cpu: {bytes: "2809", sha256: DIGEST("b")}};
    const markerLine = (record = VALID_RECORD) => `${COMPLETION_RECORD_PREFIX} ${JSON.stringify(record)}`;

    /*
     * A synthetic append-only log. `write` appends the way QEMU's file chardev does; `replace` and
     * `shrink` stand in for a log swapped or truncated under the observer, which must fail closed.
     * The reader mirrors the real one: bytes from an offset, plus the identity that must not change.
     */
    const channel = () => {
        const state = {text: "", device: 1, inode: 1};
        return {
            write(value) { state.text += value; },
            replace(value) { state.text = value; state.inode += 1; },
            shrink(length) { state.text = state.text.slice(0, length); },
            read(start, maximumBytes) {
                const bytes = Buffer.from(state.text, "latin1");
                /* A real range reader reports the smaller size; it does not refuse to read. */
                const from = Math.min(start, bytes.length);
                return {bytes: bytes.subarray(from, Math.min(bytes.length, from + maximumBytes)),
                    identity: {device: String(state.device), inode: String(state.inode),
                        observedBytes: String(bytes.length)}};
            }};
    };
    const consume = (observer, source) => observer.consume((start, maximum) => source.read(start, maximum));

    it("observes a record split across two poll ticks", () => {
        const source = channel();
        const observer = createSerialCompletionObserver(COMPLETION_NONCE);
        const line = markerLine();
        source.write(line.slice(0, 40));
        assert.equal(consume(observer, source).completion, null);
        source.write(`${line.slice(40)}\r\n`);
        const outcome = consume(observer, source);
        assert.equal(outcome.failure, null);
        assert.equal(outcome.completion.record.cpu.sha256, DIGEST("b"));
        assert.equal(outcome.completion.record.baseline.bytes, "1985");
    });

    it("ignores firmware chatter and ANSI escapes before the record", () => {
        const source = channel();
        const observer = createSerialCompletionObserver(COMPLETION_NONCE);
        source.write("[2J[01;01HBdsDxe: starting Boot0004 \"Windows Boot Manager\"\r\n".repeat(20));
        assert.equal(consume(observer, source).completion, null);
        assert.equal(consume(observer, source).failure, null);
        source.write(`${markerLine()}\r\n`);
        assert.ok(consume(observer, source).completion);
    });

    it("latches the first record and ignores repeated polling of the same bytes", () => {
        const source = channel();
        const observer = createSerialCompletionObserver(COMPLETION_NONCE);
        source.write(`${markerLine()}\r\n`);
        const first = consume(observer, source);
        assert.ok(first.completion);
        const second = consume(observer, source);
        assert.equal(second.completion, first.completion);
        assert.equal(second.failure, null);
    });

    it("refuses a marker-shaped line that fails the contract instead of ignoring it", () => {
        const source = channel();
        const observer = createSerialCompletionObserver(COMPLETION_NONCE);
        source.write(`${markerLine({...VALID_RECORD, nonce: "0".repeat(32)})}\r\n`);
        const outcome = consume(observer, source);
        assert.equal(outcome.completion, null);
        assert.equal(outcome.failure, "serial-completion-invalid");
    });

    it("refuses a second record", () => {
        const source = channel();
        const observer = createSerialCompletionObserver(COMPLETION_NONCE);
        source.write(`${markerLine()}\r\n${markerLine()}\r\n`);
        assert.equal(consume(observer, source).failure, "serial-completion-invalid");
    });

    it("fails closed when the log is replaced or shrinks under it", () => {
        for (const damage of [source => source.replace("fresh log\r\n"), source => source.shrink(3)]) {
            const source = channel();
            const observer = createSerialCompletionObserver(COMPLETION_NONCE);
            source.write("BdsDxe: starting\r\n");
            assert.equal(consume(observer, source).failure, null);
            damage(source);
            assert.equal(consume(observer, source).failure, "serial-channel-failed");
        }
    });

    it("fails closed on a line longer than a record may be", () => {
        const source = channel();
        const observer = createSerialCompletionObserver(COMPLETION_NONCE);
        source.write("x".repeat(MAX_COMPLETION_RECORD_BYTES + 1));
        assert.equal(consume(observer, source).failure, "serial-channel-failed");
    });

    it("fails closed on a non-ASCII byte", () => {
        const source = channel();
        const observer = createSerialCompletionObserver(COMPLETION_NONCE);
        source.write("chatter é\r\n");
        assert.equal(consume(observer, source).failure, "serial-channel-failed");
    });

    it("fails closed once the total observation cap is exhausted", () => {
        const source = channel();
        const observer = createSerialCompletionObserver(COMPLETION_NONCE);
        source.write("chatter\r\n".repeat(Math.ceil(MAX_SERIAL_OBSERVATION_BYTES / 9) + 1));
        assert.equal(consume(observer, source).failure, "serial-channel-failed");
    });

    it("supplies no trigger, and no failure, when the channel cannot be read this tick", () => {
        const observer = createSerialCompletionObserver(COMPLETION_NONCE);
        const outcome = observer.consume(() => { throw new Error("serial log unavailable"); });
        assert.equal(outcome.completion, null);
        assert.equal(outcome.failure, null);
    });

    it("keeps a latched channel failure even when a valid record arrives later", () => {
        const source = channel();
        const observer = createSerialCompletionObserver(COMPLETION_NONCE);
        source.write("x".repeat(MAX_COMPLETION_RECORD_BYTES + 1));
        assert.equal(consume(observer, source).failure, "serial-channel-failed");
        source.write(`\r\n${markerLine()}\r\n`);
        const outcome = consume(observer, source);
        assert.equal(outcome.failure, "serial-channel-failed");
        assert.equal(outcome.completion, null);
    });
});

describe("owned serial range reader", () => {
    const withRoot = run => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-range-"));
        try { return run(root); } finally { fs.rmSync(root, {recursive: true, force: true}); }
    };
    const read = (target, start, maximum) =>
        defaultReadOwnedRangeVerified(target, start, maximum);

    it("reads forward from an offset and follows a growing file", () => withRoot(root => {
        const target = path.join(root, "serial.log");
        fs.writeFileSync(target, "first\n");
        const opening = read(target, 0, 1024);
        assert.equal(opening.bytes.toString("latin1"), "first\n");
        assert.equal(opening.identity.observedBytes, "6");

        fs.appendFileSync(target, "second\n");
        const appended = read(target, 6, 1024);
        assert.equal(appended.bytes.toString("latin1"), "second\n");
        assert.equal(appended.identity.inode, opening.identity.inode);
        assert.equal(appended.identity.observedBytes, "13");
    }));

    it("clamps a start beyond the end instead of reading out of bounds", () => withRoot(root => {
        const target = path.join(root, "serial.log");
        fs.writeFileSync(target, "short\n");
        const observed = read(target, 4096, 1024);
        assert.equal(observed.bytes.length, 0);
        /* The caller needs the true size to notice that the file shrank under it. */
        assert.equal(observed.identity.observedBytes, "6");
    }));

    it("honours the maximum and reports a new identity when the file is replaced", () => withRoot(root => {
        const target = path.join(root, "serial.log");
        fs.writeFileSync(target, "abcdefghij");
        assert.equal(read(target, 2, 3).bytes.toString("latin1"), "cde");
        const before = read(target, 0, 1024).identity.inode;
        fs.rmSync(target);
        fs.writeFileSync(target, "replaced\n");
        assert.notEqual(read(target, 0, 1024).identity.inode, before);
    }));

    it("refuses a symlink, a hard-linked file, a directory and an invalid window", () => withRoot(root => {
        const target = path.join(root, "serial.log");
        fs.writeFileSync(target, "bytes\n");
        assert.throws(() => read(path.join(root, "missing.log"), 0, 1024));
        assert.throws(() => read(root, 0, 1024), /not an ordinary file/u);
        assert.throws(() => read(target, -1, 1024), /start is invalid/u);
        assert.throws(() => read(target, 0, 0), /maximum is invalid/u);

        const linked = path.join(root, "linked.log");
        try { fs.linkSync(target, linked); } catch { return; }
        assert.throws(() => read(linked, 0, 1024), /read bound is invalid/u);
    }));
});
