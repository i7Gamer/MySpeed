import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";

import {
    LATE_BOOT_MILESTONE_OFFSETS_MILLISECONDS,
    MAX_LATE_BOOT_MILESTONES,
    runEarlyBootQmpSession,
    validateLateScreenshots
} from "../../scripts/qualification/linux-windows-cpu-floor-stage2-qmp.mjs";
import {runHostedOwnedProcess, runMonitoredQemu} from
    "../../scripts/qualification/linux-windows-cpu-floor-stage2-hosted.mjs";

const ROOT = "/home/runner/work/_temp/myspeed-windows-cpu-floor-0123456789abcdef0123456789abcdef";
const SCREENSHOTS = [`${ROOT}/early-boot-1.png`, `${ROOT}/early-boot-2.png`];
const LATE_SCREENSHOTS = [`${ROOT}/late-boot-1.png`, `${ROOT}/late-boot-2.png`];

function stream(messages) {
    return ReadableStream.from(messages.map(value => Buffer.from(`${typeof value === "string" ? value :
        JSON.stringify(value)}\r\n`)));
}

describe("Stage 2 early-boot QMP session", () => {
    it("negotiates exact commands and captures status plus two owned-path screenshots without input", async () => {
        const writes = [];
        const result = await runEarlyBootQmpSession({readable: stream([
            {QMP: {version: {qemu: {major: 10, minor: 1, micro: 2}, package: ""}, capabilities: []}},
            {return: {}, id: "capabilities"},
            {return: {running: true, status: "running"}, id: "status"},
            {return: {}, id: "screenshot-1"},
            {return: {}, id: "screenshot-2"}
        ]), writeBytes: bytes => writes.push(JSON.parse(bytes.toString("utf8"))), screenshotPaths: SCREENSHOTS},
        {wait: async () => undefined});
        assert.deepEqual(writes, [
            {execute: "qmp_capabilities", id: "capabilities"},
            {execute: "query-status", id: "status"},
            {execute: "screendump", arguments: {filename: SCREENSHOTS[0], format: "png"}, id: "screenshot-1"},
            {execute: "screendump", arguments: {filename: SCREENSHOTS[1], format: "png"}, id: "screenshot-2"}
        ]);
        assert.deepEqual(result, {version: {major: 10, minor: 1, micro: 2}, status: "running",
            running: true, screenshotPaths: SCREENSHOTS, inputSent: false});
    });

    it("rejects timeout, malformed JSON, transcript overflow, and mismatched responses", async () => {
        const base = {writeBytes: () => undefined, screenshotPaths: SCREENSHOTS};
        await assert.rejects(runEarlyBootQmpSession({...base, readable: new ReadableStream({start() {}})}, {
            setTimer: callback => { callback(); return 1; }, clearTimer: () => undefined}), /deadline/u);
        await assert.rejects(runEarlyBootQmpSession({...base, readable: stream(["{"]) }), /JSON/u);
        await assert.rejects(runEarlyBootQmpSession({...base, readable: stream(["x".repeat(65_537)])}), /bound/u);
        await assert.rejects(runEarlyBootQmpSession({...base, readable: stream([
            {QMP: {version: {qemu: {major: -1, minor: 1, micro: 2}, package: ""}, capabilities: []}}
        ])}), /greeting/u);
        await assert.rejects(runEarlyBootQmpSession({...base, readable: stream([
            {QMP: {version: {qemu: {major: 10, minor: 1, micro: 2}, package: ""}, capabilities: []}},
            {return: {}, id: "wrong"}
        ])}), /response/u);
    });

    it("bounds an unresolved inherited-pipe write", async () => {
        let timerCount = 0;
        await assert.rejects(runEarlyBootQmpSession({readable: stream([
            {QMP: {version: {qemu: {major: 10, minor: 1, micro: 2}, package: ""}, capabilities: []}}
        ]), writeBytes: () => new Promise(() => undefined), screenshotPaths: SCREENSHOTS}, {
            setTimer: callback => { timerCount += 1; if (timerCount === 3) queueMicrotask(callback); return timerCount; },
            clearTimer: () => undefined
        }), /deadline/u);
    });

    it("does not issue later commands after the whole-session deadline", async () => {
        const writes = [];
        let expireSession, releaseWrite;
        const firstWrite = new Promise(resolve => { releaseWrite = resolve; });
        const pending = runEarlyBootQmpSession({readable: stream([
            {QMP: {version: {qemu: {major: 10, minor: 1, micro: 2}, package: ""}, capabilities: []}},
            {return: {}, id: "capabilities"}
        ]), writeBytes: bytes => { writes.push(JSON.parse(bytes.toString("utf8"))); expireSession(); return firstWrite; },
        screenshotPaths: SCREENSHOTS}, {
            setTimer: (callback, milliseconds) => { if (milliseconds === 90_000) expireSession = callback; return 1; },
            clearTimer: () => undefined
        });
        await assert.rejects(pending, /deadline/u);
        releaseWrite();
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(writes, [{execute: "qmp_capabilities", id: "capabilities"}]);
    });

    it("rejects screenshot paths outside the exact Stage 2 root before writing", async () => {
        let wrote = false;
        await assert.rejects(runEarlyBootQmpSession({readable: stream([]), writeBytes: () => { wrote = true; },
            screenshotPaths: [SCREENSHOTS[0], "/tmp/early-boot-2.png"]}), /screenshot path/u);
        assert.equal(wrote, false);
    });

    it("accepts only the closed MSI row roots and never mixes screenshot owners", async () => {
        const hostNonce = "0123456789abcdef0123456789abcdef";
        const rowNonce = "fedcba9876543210fedcba9876543210";
        const msiRoot = `/home/runner/work/_temp/myspeed-windows-msi-${hostNonce}`;
        for (const index of ["00", "13"]) {
            const root = `${msiRoot}/row-${index}-${rowNonce}`;
            const screenshotPaths = [`${root}/early-boot-1.png`, `${root}/early-boot-2.png`];
            const result = await runEarlyBootQmpSession({readable: stream([
                {QMP: {version: {qemu: {major: 10, minor: 1, micro: 2}}, capabilities: []}},
                {return: {}, id: "capabilities"}, {return: {running: true, status: "running"}, id: "status"},
                {return: {}, id: "screenshot-1"}, {return: {}, id: "screenshot-2"}
            ]), writeBytes: () => undefined, screenshotPaths}, {wait: async () => undefined});
            assert.deepEqual(result.screenshotPaths, screenshotPaths);
        }
        for (const root of [`${msiRoot}/row-14-${rowNonce}`, `${msiRoot}/row-0-${rowNonce}`,
            `${msiRoot}/../row-00-${rowNonce}`, `${msiRoot}/row-00-${rowNonce}/nested`]) {
            await assert.rejects(runEarlyBootQmpSession({readable: stream([]),
                writeBytes: () => assert.fail("invalid root wrote to QMP"),
                screenshotPaths: [`${root}/early-boot-1.png`, `${root}/early-boot-2.png`]}), /screenshot path/u);
        }
        await assert.rejects(runEarlyBootQmpSession({readable: stream([]),
            writeBytes: () => assert.fail("mixed row owners wrote to QMP"), screenshotPaths: [
                `${msiRoot}/row-00-${rowNonce}/early-boot-1.png`,
                `${msiRoot}/row-01-${rowNonce}/early-boot-2.png`]}), /screenshot path/u);
    });

    it("accepts the fixed same-job baseline child but rejects other nested roots", async () => {
        const root = `${ROOT}/post-release-baseline`;
        const screenshotPaths = [`${root}/early-boot-1.png`, `${root}/early-boot-2.png`];
        const result = await runEarlyBootQmpSession({readable: stream([
            {QMP: {version: {qemu: {major: 10, minor: 1, micro: 2}}, capabilities: []}},
            {return: {}, id: "capabilities"}, {return: {running: true, status: "running"}, id: "status"},
            {return: {}, id: "screenshot-1"}, {return: {}, id: "screenshot-2"}
        ]), writeBytes: () => undefined, screenshotPaths}, {wait: async () => undefined});
        assert.deepEqual(result.screenshotPaths, screenshotPaths);
        for (const invalidRoot of [`${ROOT}/other`, `${root}/nested`, `${root}/../post-release-baseline`]) {
            await assert.rejects(runEarlyBootQmpSession({readable: stream([]),
                writeBytes: () => assert.fail("unowned baseline path wrote to QMP"),
                screenshotPaths: [`${invalidRoot}/early-boot-1.png`, `${invalidRoot}/early-boot-2.png`]}),
            /screenshot path/u);
        }
    });

    it("runs QMP only over inherited child pipes and exposes its bounded session to the owner", async () => {
        const child = new EventEmitter();
        child.pid = 321; child.stdin = new PassThrough(); child.stdout = new PassThrough();
        child.stderr = new PassThrough(); child.unref = () => undefined;
        let spawnOptions, session;
        const pending = runHostedOwnedProcess("/owned/qemu", [], {timeoutMs: 1_000, maxStreamBytes: 65_536,
            qmp: {screenshotPaths: SCREENSHOTS}, qmpDependencies: {wait: async () => undefined},
            onQmpSession: value => { session = value; value.then(() => child.emit("close", 0, null)); }}, {
            spawnImpl: (_command, _argv, options) => { spawnOptions = options; return child; },
            setTimer: () => 1, clearTimer: () => undefined, isGroupAlive: () => false
        });
        assert.equal(child.stdout.listenerCount("data"), 0);
        for (const value of [
            {QMP: {version: {qemu: {major: 8, minor: 2, micro: 2}, package: ""}, capabilities: []}},
            {return: {}, id: "capabilities"}, {return: {running: true, status: "running"}, id: "status"},
            {return: {}, id: "screenshot-1"}, {return: {}, id: "screenshot-2"}
        ]) child.stdout.write(`${JSON.stringify(value)}\r\n`);
        const result = await pending;
        assert.deepEqual(spawnOptions.stdio, ["pipe", "pipe", "pipe"]);
        assert.equal((await session).inputSent, false);
        assert.equal(result.process.exitCode, 0);
    });

    it("routes a QMP protocol failure through the existing proved process-group cleanup", async () => {
        let finish, settlementReason = null, groupAlive = true, identityReads = 0;
        const operation = new Promise(resolve => { finish = resolve; });
        const result = await runMonitoredQemu({
            runOwned: (_command, _argv, options) => {
                options.onSpawn(2300); options.onTerminationReady(reason => { settlementReason = reason; });
                options.onQmpSession(Promise.reject(new Error("malformed QMP")));
                return operation;
            },
            pathExists: () => true,
            readOwnedVerified: () => ({bytes: Buffer.from("2345\n")}),
            readQemuProcessIdentity: () => ++identityReads === 1 ? {state: "present", pid: 2345,
                processGroupId: 2300, startTicks: "77", executablePath: "/owned/loader"} : {state: "absent"},
            monotonicMilliseconds: () => 1,
            wait: async () => undefined,
            isProcessGroupAlive: () => groupAlive,
            terminateQemuGroup: async () => { groupAlive = false;
                finish({process: {exitCode: 137, signal: null, timedOut: false, stdoutOverflow: false,
                    stderrOverflow: false, cleanupProven: false, errorObserved: false},
                stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)}); return true; }
        }, {command: "/owned/qemu", argv: [], timeoutMs: 1_000, maxStreamBytes: 65_536,
            pidPath: "/owned/qemu.pid", expectedExecutable: "/owned/loader", executionDeadline: 100_000,
            resources: {taskPath: "/owned", roots: ["/owned"]}, qmp: {screenshotPaths: SCREENSHOTS}});
        assert.equal(result.terminationReason, "qmp-failed");
        assert.equal(result.processGroupGone, true);
        assert.equal(settlementReason, "monitor-qmp-failed");
    });

    it("validates late-boot screenshot paths within the exact owned root", () => {
        assert.equal(MAX_LATE_BOOT_MILESTONES, 2);
        assert.deepEqual(LATE_BOOT_MILESTONE_OFFSETS_MILLISECONDS, [120_000, 300_000]);
        const valid = validateLateScreenshots(LATE_SCREENSHOTS);
        assert.deepEqual(valid, LATE_SCREENSHOTS);
        assert.throws(() => validateLateScreenshots([LATE_SCREENSHOTS[0]]), /path/u);
        assert.throws(() => validateLateScreenshots([...LATE_SCREENSHOTS, `${ROOT}/late-boot-3.png`]), /path/u);
        assert.throws(() => validateLateScreenshots([`${ROOT}/late-boot-2.png`, `${ROOT}/late-boot-1.png`]), /path/u);
        assert.throws(() => validateLateScreenshots([LATE_SCREENSHOTS[0], "/tmp/late-boot-2.png"]), /path/u);
        assert.throws(() => validateLateScreenshots([
            `${ROOT}/late-boot-1.png`,
            `/home/runner/work/_temp/myspeed-windows-cpu-floor-other/late-boot-2.png`
        ]), /path/u);
    });

    it("schedules late milestones at absolute T+120s and T+300s offsets using remaining time", async () => {
        const writes = [];
        let simulatedTime = 0;
        const delaysRecorded = [];
        let lateObservationPromise = null;

        const fakeWait = async milliseconds => {
            delaysRecorded.push(milliseconds);
            simulatedTime += milliseconds;
        };

        const result = await runEarlyBootQmpSession({
            readable: stream([
                {QMP: {version: {qemu: {major: 10, minor: 1, micro: 2}, package: ""}, capabilities: []}},
                {return: {}, id: "capabilities"},
                {return: {running: true, status: "running"}, id: "status"},
                {return: {}, id: "screenshot-1"},
                {return: {}, id: "screenshot-2"},
                {return: {running: true, status: "running"}, id: "late-status-1"},
                {return: {}, id: "late-screenshot-1"},
                {return: {running: true, status: "running"}, id: "late-status-2"},
                {return: {}, id: "late-screenshot-2"}
            ]),
            writeBytes: bytes => writes.push(JSON.parse(bytes.toString("utf8"))),
            screenshotPaths: SCREENSHOTS,
            lateScreenshotPaths: LATE_SCREENSHOTS,
            onLateObservation: promise => { lateObservationPromise = promise; }
        }, {
            wait: fakeWait,
            now: () => simulatedTime
        });

        // Early boot resolves promptly with existing shape
        assert.deepEqual(result, {version: {major: 10, minor: 1, micro: 2}, status: "running",
            running: true, screenshotPaths: SCREENSHOTS, inputSent: false});

        // Verify late observation completed
        assert.ok(lateObservationPromise !== null);
        const lateResult = await lateObservationPromise;
        assert.equal(lateResult.kind, "qemu-late-boot-observation");
        assert.equal(lateResult.schemaVersion, 1);
        assert.equal(lateResult.milestones.length, 2);
        assert.deepEqual(lateResult.milestones[0], {
            milestone: 1, offsetMs: 120_000, status: "running", running: true,
            screenshotPath: LATE_SCREENSHOTS[0]
        });
        assert.deepEqual(lateResult.milestones[1], {
            milestone: 2, offsetMs: 300_000, status: "running", running: true,
            screenshotPath: LATE_SCREENSHOTS[1]
        });

        // Verify delays: 5s, 30s (T+35s), then 85s (to reach T+120s), then 180s (to reach T+300s)
        assert.deepEqual(delaysRecorded, [5_000, 30_000, 85_000, 180_000]);
        assert.equal(simulatedTime, 300_000);

        // Verify all expected commands written
        assert.deepEqual(writes.map(w => w.id), [
            "capabilities", "status", "screenshot-1", "screenshot-2",
            "late-status-1", "late-screenshot-1", "late-status-2", "late-screenshot-2"
        ]);
    });

    it("clears late timer and settles late observation promptly on session cancellation", async () => {
        let cleared = false;
        let sessionControl = null;
        let lateObservationPromise = null;

        const result = await runEarlyBootQmpSession({
            readable: stream([
                {QMP: {version: {qemu: {major: 10, minor: 1, micro: 2}, package: ""}, capabilities: []}},
                {return: {}, id: "capabilities"},
                {return: {running: true, status: "running"}, id: "status"},
                {return: {}, id: "screenshot-1"},
                {return: {}, id: "screenshot-2"}
            ]),
            writeBytes: () => undefined,
            screenshotPaths: SCREENSHOTS,
            lateScreenshotPaths: LATE_SCREENSHOTS,
            onLateObservation: promise => { lateObservationPromise = promise; },
            onSession: control => { sessionControl = control; }
        }, {
            wait: async () => undefined,
            setTimer: () => 999,
            clearTimer: id => { if (id === 999) cleared = true; },
            now: () => 35_000
        });

        assert.equal(result.running, true);
        assert.ok(sessionControl !== null);
        assert.ok(lateObservationPromise !== null);

        // Cancel session while waiting for late milestone 1
        sessionControl.cancel();
        assert.equal(cleared, true);

        // Late observation should settle promptly with empty milestones / null
        const lateResult = await lateObservationPromise;
        assert.equal(lateResult, null);
    });

    it("ensures late milestone errors never fail or invalidate early boot observation", async () => {
        let lateObservationPromise = null;
        const result = await runEarlyBootQmpSession({
            readable: stream([
                {QMP: {version: {qemu: {major: 10, minor: 1, micro: 2}, package: ""}, capabilities: []}},
                {return: {}, id: "capabilities"},
                {return: {running: true, status: "running"}, id: "status"},
                {return: {}, id: "screenshot-1"},
                {return: {}, id: "screenshot-2"},
                // Late command returns error
                {error: {class: "CommandFailed", desc: "screendump failed"}, id: "late-status-1"}
            ]),
            writeBytes: () => undefined,
            screenshotPaths: SCREENSHOTS,
            lateScreenshotPaths: LATE_SCREENSHOTS,
            onLateObservation: promise => { lateObservationPromise = promise; }
        }, {
            wait: async () => undefined,
            now: () => 35_000
        });

        // Early boot observation is valid and unmodified
        assert.equal(result.status, "running");
        assert.equal(result.running, true);

        // Late observation handles the error gracefully without unhandled rejection
        const lateResult = await lateObservationPromise;
        assert.equal(lateResult, null);
    });
});

