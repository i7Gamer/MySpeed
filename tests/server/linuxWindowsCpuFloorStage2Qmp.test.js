import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";

import {runEarlyBootQmpSession} from
    "../../scripts/qualification/linux-windows-cpu-floor-stage2-qmp.mjs";
import {runHostedOwnedProcess, runMonitoredQemu} from
    "../../scripts/qualification/linux-windows-cpu-floor-stage2-hosted.mjs";

const ROOT = "/home/runner/work/_temp/myspeed-windows-cpu-floor-0123456789abcdef0123456789abcdef";
const SCREENSHOTS = [`${ROOT}/early-boot-1.png`, `${ROOT}/early-boot-2.png`];

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
});
