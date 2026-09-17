import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {
    MID_WINDOW_FRAME_FILENAMES,
    runEarlyBootQmpSession
} from "../../scripts/qualification/linux-windows-cpu-floor-stage2-qmp.mjs";
import {runMonitoredQemu} from "../../scripts/qualification/linux-windows-cpu-floor-stage2-hosted.mjs";
import {validateQmpShutdownEventDiagnostic, validateQemuLaunchDiagnostic} from
    "../../scripts/qualification/linux-windows-cpu-floor-stage2.mjs";

const NONCE = "0123456789abcdef0123456789abcdef";
const ROOT = `/home/runner/work/_temp/myspeed-windows-cpu-floor-${NONCE}`;
const SCREENSHOTS = [`${ROOT}/early-boot-1.png`, `${ROOT}/early-boot-2.png`];
const LATE_SCREENSHOTS = [`${ROOT}/late-boot-1.png`, `${ROOT}/late-boot-2.png`];
const MID_WINDOW_PATHS = MID_WINDOW_FRAME_FILENAMES.map(name => `${ROOT}/${name}`);
const PREDEADLINE_PATH = `${ROOT}/predeadline-frame.png`;
const GREETING = {QMP: {version: {qemu: {major: 10, minor: 1, micro: 2}, package: ""}, capabilities: []}};
const VALID_SHUTDOWN = {event: "SHUTDOWN", data: {guest: true, reason: "guest-shutdown"},
    timestamp: {seconds: 1, microseconds: 2}};

const turn = () => new Promise(resolve => setImmediate(resolve));

class ControlledQmpStream {
    #queued = [];
    #waiter = null;
    #closed = false;
    #failure = null;
    activeNext = 0;
    maximumConcurrentNext = 0;
    nextCalls = 0;

    [Symbol.asyncIterator]() { return this; }

    next() {
        this.nextCalls += 1;
        this.activeNext += 1;
        this.maximumConcurrentNext = Math.max(this.maximumConcurrentNext, this.activeNext);
        let operation;
        if (this.#failure !== null) operation = Promise.reject(this.#failure);
        else if (this.#queued.length > 0) operation = Promise.resolve({done: false, value: this.#queued.shift()});
        else if (this.#closed) operation = Promise.resolve({done: true, value: undefined});
        else operation = new Promise((resolve, reject) => { this.#waiter = {resolve, reject}; });
        return operation.finally(() => { this.activeNext -= 1; });
    }

    push(value) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(`${JSON.stringify(value)}\n`);
        if (this.#waiter !== null) {
            const {resolve} = this.#waiter;
            this.#waiter = null;
            resolve({done: false, value: chunk});
        } else this.#queued.push(chunk);
    }

    close() {
        this.#closed = true;
        if (this.#waiter !== null) {
            const {resolve} = this.#waiter;
            this.#waiter = null;
            resolve({done: true, value: undefined});
        }
    }

    fail(error) {
        this.#failure = error;
        if (this.#waiter !== null) {
            const {reject} = this.#waiter;
            this.#waiter = null;
            reject(error);
        }
    }
}

function responseFor(command) {
    if (command.id === "status" || command.id.startsWith("late-status-"))
        return {return: {running: true, status: "running"}, id: command.id};
    return {return: {}, id: command.id};
}

function createSessionHarness(overrides = {}) {
    const bus = new ControlledQmpStream();
    bus.push(GREETING);
    let now = 0;
    const writes = [];
    const shutdownEvents = [];
    const frames = [];
    const predeadline = [];
    let sessionHandle = null;
    const input = {
        readable: bus,
        writeBytes: async bytes => {
            const command = JSON.parse(bytes.toString("utf8"));
            writes.push(command);
            const handled = await overrides.onWrite?.(command, bus);
            if (handled !== true) bus.push(responseFor(command));
        },
        screenshotPaths: SCREENSHOTS,
        lateScreenshotPaths: LATE_SCREENSHOTS,
        midWindow: {screenshotPaths: MID_WINDOW_PATHS, executionDeadline: 1_500_000},
        predeadline: {screenshotPath: PREDEADLINE_PATH, executionDeadline: 1_500_000},
        onSession: handle => { sessionHandle = handle; overrides.onSession?.(handle); },
        onShutdownEvent: record => { shutdownEvents.push(record); overrides.onShutdownEvent?.(record); },
        onMidWindowFrame: (index, record) => { frames[index] = record; overrides.onMidWindowFrame?.(index, record); },
        onPredeadlineObservation: record => { predeadline.push(record); overrides.onPredeadlineObservation?.(record); }
    };
    const dependencies = {
        now: () => now,
        wait: async milliseconds => {
            const before = now;
            now += milliseconds;
            await overrides.onWait?.({before, after: now, milliseconds, bus});
        },
        ...overrides.dependencies
    };
    const started = runEarlyBootQmpSession(input, dependencies);
    return {bus, dependencies, frames, input, predeadline, shutdownEvents, started,
        writes, get now() { return now; }, get sessionHandle() { return sessionHandle; }};
}

async function waitFor(predicate, message = "condition") {
    for (let index = 0; index < 200; index += 1) {
        if (predicate()) return;
        await turn();
    }
    assert.fail(`Timed out waiting for ${message}`);
}

describe("continuous single-reader QMP SHUTDOWN capture", () => {
    it("retains an idle-gap event once when the later +900s write fails and closes later diagnostics", async () => {
        const harness = createSessionHarness({
            onWait: async ({before, after, bus}) => {
                if (before >= 600_000 && after >= 900_000) {
                    bus.push(VALID_SHUTDOWN);
                    await turn();
                }
            },
            onWrite: command => {
                if (command.id === "mid-window-screenshot-2") throw new Error("broken QMP pipe");
                return false;
            }
        });
        await harness.started;
        await waitFor(() => harness.frames.length === 2 && harness.predeadline.length === 1, "diagnostic finalization");
        assert.equal(harness.shutdownEvents.length, 1);
        assert.deepEqual(harness.shutdownEvents[0], {schemaVersion: 1, status: "captured", guest: true,
            reason: "guest-shutdown", offsetMs: 900_000});
        assert.equal(harness.frames[0].status, "captured");
        assert.equal(harness.frames[1].reason, "qmp-write-failed");
        assert.equal(harness.predeadline[0].reason, "reader-unavailable");
        assert.equal(harness.bus.maximumConcurrentNext, 1);
        harness.bus.close();
    });

    it("does not lose a response delivered after waiter registration but before writeBytes resolves", async () => {
        let releaseWrite;
        const blockedWrite = new Promise(resolve => { releaseWrite = resolve; });
        const harness = createSessionHarness({onWrite: async (command, bus) => {
            if (command.id !== "capabilities") return false;
            bus.push(responseFor(command));
            await blockedWrite;
            return true;
        }});
        await waitFor(() => harness.writes.length === 1, "capabilities write");
        await turn();
        assert.equal(harness.writes[0].id, "capabilities");
        releaseWrite();
        const result = await harness.started;
        assert.equal(result.running, true);
        assert.equal(harness.bus.maximumConcurrentNext, 1);
        harness.sessionHandle.cancel();
        harness.bus.close();
    });

    it("preserves separate legacy write and response deadlines while arming the waiter first", async () => {
        let releaseWrite;
        const blockedWrite = new Promise(resolve => { releaseWrite = resolve; });
        const timers = [];
        const harness = createSessionHarness({
            dependencies: {
                setTimer: (callback, milliseconds) => {
                    const timer = {callback, milliseconds, cleared: false};
                    timers.push(timer);
                    return timer;
                },
                clearTimer: timer => { if (timer) timer.cleared = true; }
            },
            onWrite: async command => {
                if (command.id !== "capabilities") return false;
                await blockedWrite;
                return true;
            }
        });
        await waitFor(() => harness.writes.length === 1, "capabilities write");
        const activeResponseTimers = () => timers.filter(timer => timer.milliseconds === 10_000 && !timer.cleared);
        assert.equal(activeResponseTimers().length, 1,
            "only the write deadline is armed while the legacy write is pending");
        releaseWrite();
        await waitFor(() => activeResponseTimers().length === 1 &&
            timers.filter(timer => timer.milliseconds === 10_000).length >= 3,
            "post-write response deadline");
        harness.bus.push(responseFor(harness.writes[0]));
        assert.equal((await harness.started).running, true);
        harness.sessionHandle.cancel();
        harness.bus.close();
    });

    it("does not let an early response mask a later failure of the same write", async () => {
        let rejectWrite;
        const blockedWrite = new Promise((_resolve, reject) => { rejectWrite = reject; });
        const harness = createSessionHarness({onWrite: async (command, bus) => {
            if (command.id !== "capabilities") return false;
            bus.push(responseFor(command));
            await blockedWrite;
            return true;
        }});
        await waitFor(() => harness.writes.length === 1, "capabilities write");
        await turn();
        rejectWrite(new Error("late write failure"));
        await assert.rejects(harness.started, /late write failure/u);
        const callsAtFailure = harness.bus.nextCalls;
        harness.bus.push(VALID_SHUTDOWN);
        await turn();
        assert.equal(harness.bus.nextCalls, callsAtFailure);
        assert.equal(harness.shutdownEvents.length, 0);
        harness.bus.close();
    });

    it("keeps a write-inclusive command budget armed after an early response", async () => {
        const activeTimers = new Set();
        let totalBudgetTimer = null;
        const neverSettles = new Promise(() => undefined);
        const harness = createSessionHarness({
            dependencies: {
                setTimer: (callback, milliseconds) => {
                    const timer = {callback, milliseconds, cleared: false};
                    activeTimers.add(timer);
                    if (milliseconds > 60_000 && milliseconds !== 90_000) queueMicrotask(() => {
                        if (!timer.cleared) callback();
                    });
                    return timer;
                },
                clearTimer: timer => {
                    if (timer) {
                        timer.cleared = true;
                        activeTimers.delete(timer);
                    }
                }
            },
            onWrite: (command, bus) => {
                if (command.id !== "mid-window-screenshot-1") return false;
                totalBudgetTimer = [...activeTimers][0];
                bus.push(responseFor(command));
                return neverSettles;
            }
        });
        await harness.started;
        for (let index = 0; index < 2_000 && totalBudgetTimer === null; index += 1) await turn();
        assert.notEqual(totalBudgetTimer, null,
            `mid-window write was not reached; writes=${harness.writes.map(command => command.id).join(",")}`);
        await turn();
        assert.equal(totalBudgetTimer.cleared, false,
            "the write-inclusive budget must remain armed until both response and write settle");
        totalBudgetTimer.callback();
        await waitFor(() => harness.frames.length === 2, "mid-window timeout diagnostic");
        assert.equal(harness.frames[0].reason, "command-timeout");
        harness.bus.close();
    });

    it("terminalizes the idle dispatcher when early setup fails after pump startup", async () => {
        const harness = createSessionHarness({dependencies: {
            wait: async () => { throw new Error("early wait failed"); }
        }});
        await assert.rejects(harness.started, /early wait failed/u);
        const callsAtFailure = harness.bus.nextCalls;
        harness.bus.push(VALID_SHUTDOWN);
        await turn();
        assert.equal(harness.bus.nextCalls, callsAtFailure);
        assert.equal(harness.shutdownEvents.length, 0);
        harness.bus.close();
    });

    it("settles cancellation promptly while the underlying write never settles", async () => {
        const neverSettles = new Promise(() => undefined);
        const harness = createSessionHarness({
            dependencies: {
                setTimer: () => ({inert: true}),
                clearTimer: () => undefined
            },
            onWrite: command => command.id === "capabilities" ? neverSettles : false
        });
        await waitFor(() => harness.writes.length === 1 && harness.sessionHandle !== null,
            "pending capabilities write");
        harness.sessionHandle.cancel();
        await assert.rejects(harness.started, /cancelled/u);
        const callsAtCancel = harness.bus.nextCalls;
        harness.bus.push(VALID_SHUTDOWN);
        await turn();
        assert.equal(harness.bus.nextCalls, callsAtCancel);
        assert.equal(harness.shutdownEvents.length, 0);
        harness.bus.close();
    });

    it("makes a response timeout terminal, drops the late reply, and starts no later read or command", async () => {
        const activeTimers = new Set();
        const setTimer = (callback, milliseconds) => {
            const timer = {callback, milliseconds, cleared: false};
            activeTimers.add(timer);
            if (milliseconds > 60_000 && milliseconds !== 90_000) queueMicrotask(() => {
                if (!timer.cleared) callback();
            });
            return timer;
        };
        const clearTimer = timer => { if (timer) { timer.cleared = true; activeTimers.delete(timer); } };
        const harness = createSessionHarness({
            dependencies: {setTimer, clearTimer},
            onWrite: command => command.id === "mid-window-screenshot-1"
        });
        await harness.started;
        await waitFor(() => harness.writes.some(command => command.id === "mid-window-screenshot-1"), "slot-1 write");
        const responseTimer = [...activeTimers].find(timer => timer.milliseconds === 10_000);
        assert.ok(responseTimer);
        responseTimer.callback();
        await waitFor(() => harness.frames.length === 2 && harness.predeadline.length === 1, "timeout finalization");
        const callsAtTerminal = harness.bus.nextCalls;
        harness.bus.push({return: {}, id: "mid-window-screenshot-1"});
        await turn();
        await turn();
        assert.equal(harness.bus.nextCalls, callsAtTerminal);
        assert.equal(harness.writes.some(command => command.id === "mid-window-screenshot-2"), false);
        assert.equal(harness.writes.some(command => command.id === "predeadline-screenshot"), false);
        assert.equal(harness.bus.maximumConcurrentNext, 1);
        harness.bus.close();
    });

    it("fails closed on an unsolicited response instead of queuing it for a future command", async () => {
        let releaseLateWait;
        const lateWait = new Promise(resolve => { releaseLateWait = resolve; });
        const harness = createSessionHarness({onWait: ({before}) => before === 35_000 ? lateWait : undefined});
        await harness.started;
        harness.bus.push({return: {}, id: "unsolicited"});
        await turn();
        releaseLateWait();
        await waitFor(() => harness.frames.length === 2 && harness.predeadline.length === 1, "terminal finalization");
        assert.equal(harness.writes.some(command => command.id === "late-status-1"), false);
        assert.equal(harness.frames[0].reason, "reader-unavailable");
        assert.equal(harness.bus.maximumConcurrentNext, 1);
        harness.bus.close();
    });

    it("terminalizes an idle pump on cancellation and does not read again after the pending next settles", async () => {
        let releaseLateWait;
        const lateWait = new Promise(resolve => { releaseLateWait = resolve; });
        const harness = createSessionHarness({onWait: ({before}) => before === 35_000 ? lateWait : undefined});
        await harness.started;
        await waitFor(() => harness.bus.activeNext === 1, "idle read");
        harness.sessionHandle.cancel();
        releaseLateWait();
        await waitFor(() => harness.frames.length === 2 && harness.predeadline.length === 1, "cancel finalization");
        const callsAtCancel = harness.bus.nextCalls;
        harness.bus.push(VALID_SHUTDOWN);
        await turn();
        await turn();
        assert.equal(harness.bus.nextCalls, callsAtCancel);
        assert.equal(harness.shutdownEvents.length, 0);
        assert.equal(harness.frames.every(frame => frame.reason === "session-closed"), true);
        assert.equal(harness.predeadline[0].reason, "guest-already-exited");
        harness.bus.close();
    });

    it("counts ignored events against message and byte caps", async () => {
        const messageHarness = createSessionHarness({onWrite: (command, bus) => {
            if (command.id !== "capabilities") return false;
            for (let index = 0; index < 64; index += 1) bus.push({event: "RESET", data: {guest: false}});
            bus.push(responseFor(command));
            return true;
        }});
        await assert.rejects(messageHarness.started, /transcript bound/u);
        messageHarness.bus.close();

        const byteHarness = createSessionHarness({onWrite: (command, bus) => {
            if (command.id !== "capabilities") return false;
            bus.push({event: "RESET", data: {padding: "x".repeat(65_536)}});
            return true;
        }});
        await assert.rejects(byteHarness.started, /transcript bound/u);
        byteHarness.bus.close();
    });

    it("keeps the first immutable valid event and ignores duplicates even when the callback throws", async () => {
        let calls = 0;
        const harness = createSessionHarness({
            onShutdownEvent: () => { calls += 1; throw new Error("observer failed"); },
            onWrite: (command, bus) => {
                if (command.id === "status") {
                    bus.push(VALID_SHUTDOWN);
                    bus.push({event: "SHUTDOWN", data: {guest: false, reason: "host-ui"}});
                }
                return false;
            }
        });
        const result = await harness.started;
        assert.equal(result.running, true);
        assert.equal(calls, 1);
        assert.equal(harness.shutdownEvents.length, 1);
        assert.equal(Object.isFrozen(harness.shutdownEvents[0]), true);
        assert.deepEqual(harness.shutdownEvents[0], {schemaVersion: 1, status: "captured", guest: true,
            reason: "guest-shutdown", offsetMs: 0});
        harness.sessionHandle.cancel();
        harness.bus.close();
    });

    it("fails closed for malformed SHUTDOWN but ignores a bounded non-SHUTDOWN event", async () => {
        const ignored = createSessionHarness({onWrite: (command, bus) => {
            if (command.id === "capabilities") bus.push({event: "RESET", data: {guest: true}});
            return false;
        }});
        assert.equal((await ignored.started).running, true);
        ignored.sessionHandle.cancel();
        ignored.bus.close();

        for (const bad of [
            {event: "SHUTDOWN", data: null},
            {event: "SHUTDOWN", data: {guest: "true", reason: "guest-shutdown"}},
            {event: "SHUTDOWN", data: {guest: true, reason: "future-cause"}}
        ]) {
            const malformed = createSessionHarness({onWrite: (command, bus) => {
                if (command.id === "capabilities") bus.push(bad);
                return false;
            }});
            await assert.rejects(malformed.started, /SHUTDOWN event is invalid/u);
            malformed.bus.close();
        }
    });

    it("validates later SHUTDOWN events even after retaining the first valid record", async () => {
        const harness = createSessionHarness({onWrite: (command, bus) => {
            if (command.id === "capabilities") {
                bus.push(VALID_SHUTDOWN);
                bus.push({event: "SHUTDOWN", data: {guest: true, reason: "future-cause"}});
            }
            return false;
        }});
        await assert.rejects(harness.started, /SHUTDOWN event is invalid/u);
        assert.equal(harness.shutdownEvents.length, 1);
        assert.equal(harness.shutdownEvents[0].reason, "guest-shutdown");
        harness.bus.close();
    });

    it("rejects once without an unhandled rejection when the stream ends or fails with a command pending", async () => {
        const unhandled = [];
        const onUnhandled = reason => { unhandled.push(reason); };
        process.on("unhandledRejection", onUnhandled);
        try {
            const ended = createSessionHarness({onWrite: (command, bus) => {
                if (command.id === "capabilities") { bus.close(); return true; }
                return false;
            }});
            await assert.rejects(ended.started, /stream ended/u);

            const failed = createSessionHarness({onWrite: (command, bus) => {
                if (command.id === "capabilities") { bus.fail(new Error("read exploded")); return true; }
                return false;
            }});
            await assert.rejects(failed.started, /read exploded/u);
            await turn();
            assert.deepEqual(unhandled, []);
            assert.equal(ended.bus.maximumConcurrentNext, 1);
            assert.equal(failed.bus.maximumConcurrentNext, 1);
        } finally {
            process.off("unhandledRejection", onUnhandled);
        }
    });
});

describe("QMP shutdown event hosted and replay boundaries", () => {
    const valid = () => ({schemaVersion: 1, status: "captured", guest: true,
        reason: "guest-shutdown", offsetMs: 600_000});

    it("validates an exact captured record, accepts historical absence, and rejects malformed replay", () => {
        const accepted = validateQmpShutdownEventDiagnostic(valid());
        assert.equal(Object.isFrozen(accepted), true);
        for (const bad of [
            {...valid(), extra: true}, {...valid(), status: "unavailable"}, {...valid(), guest: "true"},
            {...valid(), reason: "future-cause"}, {...valid(), offsetMs: -1},
            {...valid(), offsetMs: Number.MAX_SAFE_INTEGER + 1}
        ]) assert.throws(() => validateQmpShutdownEventDiagnostic(bad), /invalid|keys/u);

        const process = {exitCode: null, signal: null, timedOut: false, cleanupProven: true,
            treeGone: true, qemuPid: 1, qemuStartTicks: "1", launcherExecutablePath: "/x",
            processGroupId: 1, qemuPidAbsentAfter: true, terminationReason: "deadline"};
        const historical = {schemaVersion: 1, kind: "qemu-launch-failure-diagnostic", process,
            processFlags: {errorObserved: false, stdoutOverflow: false, stderrOverflow: false},
            monitorFailure: null, stderr: {bytes: "0", sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                bytesBase64: ""}};
        assert.doesNotThrow(() => validateQemuLaunchDiagnostic(historical, process, NONCE));
        assert.deepEqual(validateQemuLaunchDiagnostic({...historical, qmpShutdownEvent: valid()}, process, NONCE)
            .qmpShutdownEvent, valid());
    });

    it("copies, validates, freezes, and finalizes the hosted callback at most once", async () => {
        let callback;
        const source = valid();
        let forwarded = 0;
        const monitored = await runMonitoredQemu({
            monotonicMilliseconds: () => 0,
            createOwnedPidFile: () => null,
            runOwned: async (_command, _argv, options) => {
                callback = options.onShutdownEvent;
                options.onShutdownEvent({...source, reason: "future-cause"});
                options.onShutdownEvent(source);
                options.onShutdownEvent({...valid(), guest: false, reason: "host-ui"});
                return {process: {exitCode: 1, signal: null, timedOut: false, stdoutOverflow: false,
                    stderrOverflow: false, cleanupProven: true, errorObserved: false},
                stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)};
            },
            isProcessGroupAlive: () => false,
            readQemuProcessIdentity: async () => ({state: "absent"}),
            wait: async () => undefined
        }, {command: "/bin/false", argv: [], timeoutMs: 1_000, pidPath: "/tmp/missing.pid",
            expectedExecutable: "/bin/false", maxStreamBytes: 1_024,
            qmp: {screenshotPaths: SCREENSHOTS, midWindow: {screenshotPaths: MID_WINDOW_PATHS,
                executionDeadline: 1_500_000}}, onShutdownEvent: () => { forwarded += 1; }});
        source.reason = "host-error";
        assert.deepEqual(monitored.qmpShutdownEvent, valid());
        assert.equal(Object.isFrozen(monitored.qmpShutdownEvent), true);
        assert.equal(forwarded, 1);
        callback({...valid(), reason: "host-signal"});
        assert.deepEqual(monitored.qmpShutdownEvent, valid());
        assert.equal(forwarded, 1);
    });
});
