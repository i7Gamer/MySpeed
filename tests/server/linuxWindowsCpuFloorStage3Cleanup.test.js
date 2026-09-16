import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {cleanupTaskOwnedCpuProcesses, parseCpuFloorCleanupAuthorityReceipt,
    readCpuFloorCleanupAuthorityReceipt} from "../../scripts/qualification/linux-windows-cpu-floor-stage3-cleanup.mjs";

const authority = () => ({pid: 91, processGroupId: 91, startTicks: "77", executablePath: "/owned/leader"});
const receipt = (authorities = [authority()]) => Buffer.from(`${JSON.stringify({schemaVersion: 1,
    kind: "myspeed-windows-cpu-floor-cleanup-authority", authorities})}\n`);
const request = authorities => ({authorities, deadlineMilliseconds: 200});

function runtime(states) {
    let now = 0; const signals = [];
    return {signals, value: {readProcessIdentity: async () => states.shift() ?? {state: "absent"},
        signalProcessGroup: async (group, signal) => signals.push([group, signal]),
        isProcessGroupAlive: async () => false,
        monotonicMilliseconds: () => now, wait: async milliseconds => { now += milliseconds; }}};
}

describe("Stage 3 task-owned CPU cleanup", () => {
    it("signals only after exact live ownership and orders TERM before bounded KILL", async () => {
        const owned = {state: "present", ...authority()};
        const fake = runtime(Array.from({length: 5}, () => owned));
        const result = await cleanupTaskOwnedCpuProcesses(request([authority()]), fake.value);
        assert.deepEqual(fake.signals, [[91, "SIGTERM"], [91, "SIGKILL"]]);
        assert.deepEqual(result.results, [{pid: 91, status: "kill-sent", cleanupProven: true}]);
    });

    it("never signals an unrelated or PID-reused process", async () => {
        for (const changed of [{startTicks: "78"}, {executablePath: "/other/qemu"}, {processGroupId: 92}]) {
            const fake = runtime([{state: "present", ...authority(), ...changed}]);
            const result = await cleanupTaskOwnedCpuProcesses(request([authority()]), fake.value);
            assert.deepEqual(fake.signals, []);
            assert.equal(result.results[0].status, "authority-mismatch");
        }
    });

    it("does not escalate after disappearance or identity change races", async () => {
        for (const after of [{state: "absent"}, {state: "present", ...authority(), startTicks: "88"}]) {
            const fake = runtime([{state: "present", ...authority()}, after]);
            await cleanupTaskOwnedCpuProcesses(request([authority()]), fake.value);
            assert.deepEqual(fake.signals, [[91, "SIGTERM"]]);
        }
    });

    it("accepts only canonical, exact, bounded authority receipts", () => {
        assert.deepEqual(parseCpuFloorCleanupAuthorityReceipt(receipt()).authorities, [authority()]);
        for (const bytes of [Buffer.from("{}\n"), Buffer.from("{\"schemaVersion\":1}"),
            receipt([{...authority(), extra: true}]), Buffer.alloc(16 * 1024 + 1)])
            assert.throws(() => parseCpuFloorCleanupAuthorityReceipt(bytes));
    });

    it("rejects symlink-like and changing receipt files", () => {
        const bytes = receipt();
        const facts = overrides => ({isFile: () => true, isSymbolicLink: () => false, nlink: 1n,
            uid: BigInt(process.getuid?.() ?? -1), mode: 0o100600n,
            size: BigInt(bytes.length), dev: 1n, ino: 2n, mtimeNs: 3n, ...overrides});
        for (const observations of [[facts({isSymbolicLink: () => true})],
            [facts({}), facts({mtimeNs: 4n})]]) {
            let index = 0; let closed = 0;
            assert.throws(() => readCpuFloorCleanupAuthorityReceipt("/owned/receipt", {realpathParent: () => "/owned",
                open: () => 5,
                fstat: () => observations[Math.min(index++, observations.length - 1)], read: () => bytes,
                close: () => { closed++; }}));
            assert.equal(closed, 1);
        }
        assert.throws(() => readCpuFloorCleanupAuthorityReceipt("/owned/receipt", {
            realpathParent: () => "/redirected", open: () => assert.fail("must not open")}), /parent/u);
    });

    it("reports already absent authority without signalling", async () => {
        const fake = runtime([{state: "absent"}]);
        const result = await cleanupTaskOwnedCpuProcesses(request([authority()]), fake.value);
        assert.deepEqual(fake.signals, []);
        assert.equal(result.results[0].status, "already-absent");
        assert.equal(result.cleanupProven, true);
    });

    it("proves cleanup of a still-running guest from its retained receipt after an outer stop", async () => {
        // The normal outer-timeout recovery: the sequence process is gone, QEMU's own group is not,
        // and the retained receipt is the only authority the cleanup step will act on.
        const bytes = receipt();
        const owned = {state: "present", ...authority()};
        const read = readCpuFloorCleanupAuthorityReceipt("/owned/cleanup-authority.json", {
            realpathParent: () => "/owned", open: () => 5, read: () => bytes, close: () => {},
            fstat: () => ({isFile: () => true, isSymbolicLink: () => false, nlink: 1n,
                uid: BigInt(process.getuid?.() ?? -1), mode: 0o100600n, size: BigInt(bytes.length),
                dev: 1n, ino: 2n, mtimeNs: 3n})});

        let alive = true;
        const signals = [];
        const proof = await cleanupTaskOwnedCpuProcesses({authorities: [...read.authorities],
            deadlineMilliseconds: 200}, {
            readProcessIdentity: async () => alive ? owned : {state: "absent"},
            signalProcessGroup: async (group, signal) => {
                signals.push([group, signal]);
                if (signal === "SIGKILL") alive = false;
            },
            isProcessGroupAlive: async () => alive,
            monotonicMilliseconds: (() => { let now = 0; return () => (now += 50); })(),
            wait: async () => {}});

        assert.deepEqual(signals, [[91, "SIGTERM"], [91, "SIGKILL"]]);
        assert.equal(proof.cleanupProven, true);
        assert.equal(proof.results[0].status, "kill-sent");
    });

    it("rejects shared-group and expired authority without signalling", async () => {
        for (const input of [request([]), request([{...authority(), pid: 92}]),
            {authorities: [authority()], deadlineMilliseconds: 0}]) {
            const fake = runtime([{state: "present", ...authority()}]);
            const result = await cleanupTaskOwnedCpuProcesses(input, fake.value);
            assert.deepEqual(fake.signals, []);
            assert.equal(result.cleanupProven, false);
        }
    });
});
