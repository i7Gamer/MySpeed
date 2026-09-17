import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {
    runEarlyBootQmpSession,
    validateMidWindowScreenshotPaths,
    MID_WINDOW_SAMPLE_OFFSETS_MILLISECONDS,
    MID_WINDOW_FRAME_FILENAMES,
    MID_WINDOW_COMMAND_TIMEOUT_MILLISECONDS,
    MID_WINDOW_SCHEDULING_MARGIN_MILLISECONDS
} from "../../scripts/qualification/linux-windows-cpu-floor-stage2-qmp.mjs";

const NONCE = "c92cbf717ee04ed4948ed011060743bb";
const ROOT = `/home/runner/work/_temp/myspeed-windows-cpu-floor-${NONCE}`;
const SCREENSHOTS = [`${ROOT}/early-boot-1.png`, `${ROOT}/early-boot-2.png`];
const LATE_SCREENSHOTS = [`${ROOT}/late-boot-1.png`, `${ROOT}/late-boot-2.png`];
const PREDEADLINE_PATH = `${ROOT}/predeadline-frame.png`;
const MID_WINDOW_PATHS = MID_WINDOW_FRAME_FILENAMES.map(name => `${ROOT}/${name}`);

function stream(messages) {
    return ReadableStream.from(messages.map(value => Buffer.from(`${typeof value === "string" ? value :
        JSON.stringify(value)}\n`)));
}

const EARLY_MESSAGES = [
    {QMP: {version: {qemu: {major: 10, minor: 1, micro: 2}, package: ""}, capabilities: []}},
    {return: {}, id: "capabilities"},
    {return: {running: true, status: "running"}, id: "status"},
    {return: {}, id: "screenshot-1"},
    {return: {}, id: "screenshot-2"},
    {return: {running: true, status: "running"}, id: "late-status-1"},
    {return: {}, id: "late-screenshot-1"},
    {return: {running: true, status: "running"}, id: "late-status-2"},
    {return: {}, id: "late-screenshot-2"}
];

describe("Mid-window screenshot path validation", () => {
    it("accepts the two canonical mid-window frame paths in order", () => {
        assert.deepEqual(validateMidWindowScreenshotPaths(MID_WINDOW_PATHS), MID_WINDOW_PATHS);
    });

    it("rejects wrong count, wrong order, wrong root, or non-array", () => {
        assert.throws(() => validateMidWindowScreenshotPaths([MID_WINDOW_PATHS[0]]), /mid-window/u);
        assert.throws(() => validateMidWindowScreenshotPaths([MID_WINDOW_PATHS[1], MID_WINDOW_PATHS[0]]), /mid-window/u);
        assert.throws(() => validateMidWindowScreenshotPaths([`${ROOT}/other-1.png`, MID_WINDOW_PATHS[1]]), /mid-window/u);
        assert.throws(() => validateMidWindowScreenshotPaths(null), /mid-window/u);
        assert.throws(() => validateMidWindowScreenshotPaths([
            `/home/runner/work/_temp/myspeed-stage3-${NONCE}/mid-window-frame-1.png`, MID_WINDOW_PATHS[1]
        ]), /mid-window/u);
    });

    it("fixes exactly two nominal offsets, distinct and named", () => {
        assert.deepEqual(MID_WINDOW_SAMPLE_OFFSETS_MILLISECONDS, [600_000, 900_000]);
        assert.equal(MID_WINDOW_COMMAND_TIMEOUT_MILLISECONDS, 10_000);
        assert.equal(MID_WINDOW_SCHEDULING_MARGIN_MILLISECONDS, 5_000);
    });
});

describe("Mid-window capture: disabled by default", () => {
    it("does not attach any onMidWindowObservation call when midWindow input is absent", async () => {
        let called = false;
        let predeadlineObservation = null;
        let resolvePredeadline;
        const predeadlinePromise = new Promise(resolve => { resolvePredeadline = resolve; });
        let simulatedTime = 0;
        await runEarlyBootQmpSession({
            readable: stream([...EARLY_MESSAGES, {return: {}, id: "predeadline-screenshot"}]),
            writeBytes: () => undefined,
            screenshotPaths: SCREENSHOTS,
            lateScreenshotPaths: LATE_SCREENSHOTS,
            predeadline: {screenshotPath: PREDEADLINE_PATH, executionDeadline: 1_500_000},
            onMidWindowObservation: () => { called = true; },
            onPredeadlineObservation: obs => { predeadlineObservation = obs; resolvePredeadline(obs); }
        }, {wait: async ms => { simulatedTime += ms; }, now: () => simulatedTime});
        await predeadlinePromise;
        assert.equal(called, false);
        assert.equal(predeadlineObservation?.status, "captured");
    });
});

describe("Mid-window capture: happy path and admission timing", () => {
    it("captures both slots at their nominal offsets and predeadline still runs after", async () => {
        let simulatedTime = 0;
        const writes = [];
        let midWindowObservation = null;
        let predeadlineObservation = null;
        let resolveMidWindow;
        let resolvePredeadline;
        const midWindowPromise = new Promise(resolve => { resolveMidWindow = resolve; });
        const predeadlinePromise = new Promise(resolve => { resolvePredeadline = resolve; });

        const executionDeadline = 1_500_000;
        await runEarlyBootQmpSession({
            readable: stream([...EARLY_MESSAGES,
                {return: {}, id: "mid-window-screenshot-1"},
                {return: {}, id: "mid-window-screenshot-2"},
                {return: {}, id: "predeadline-screenshot"}]),
            writeBytes: bytes => writes.push(JSON.parse(bytes.toString("utf8"))),
            screenshotPaths: SCREENSHOTS,
            lateScreenshotPaths: LATE_SCREENSHOTS,
            midWindow: {screenshotPaths: MID_WINDOW_PATHS, executionDeadline},
            predeadline: {screenshotPath: PREDEADLINE_PATH, executionDeadline},
            onMidWindowObservation: obs => { midWindowObservation = obs; resolveMidWindow(obs); },
            onPredeadlineObservation: obs => { predeadlineObservation = obs; resolvePredeadline(obs); }
        }, {wait: async ms => { simulatedTime += ms; }, now: () => simulatedTime});

        await midWindowPromise;
        assert.equal(midWindowObservation.length, 2);
        assert.deepEqual(midWindowObservation[0], {
            schemaVersion: 1, status: "captured", nominalOffsetMs: 600_000, offsetMs: 600_000,
            screenshotPath: MID_WINDOW_PATHS[0]
        });
        assert.deepEqual(midWindowObservation[1], {
            schemaVersion: 1, status: "captured", nominalOffsetMs: 900_000, offsetMs: 900_000,
            screenshotPath: MID_WINDOW_PATHS[1]
        });
        assert.throws(() => { midWindowObservation[0] = null; });

        await predeadlinePromise;
        assert.equal(predeadlineObservation.status, "captured");
        assert.deepEqual(writes.map(w => w.id).slice(-3),
            ["mid-window-screenshot-1", "mid-window-screenshot-2", "predeadline-screenshot"]);
    });

    it("skips a slot as insufficient-time when it would not fit before predeadline's protected window", async () => {
        // executionDeadline chosen so slot 2 (900s) does not fit: protectedStart = deadline - 20s.
        // Slot 2 needs 900s + 10s(command) + 5s(margin) < protectedStart, i.e. deadline > 935s.
        // Pick deadline = 930s so slot 1 (600s) fits (needs deadline > 635s) but slot 2 does not.
        const executionDeadline = 930_000;
        let simulatedTime = 0;
        let resolveMidWindow;
        const midWindowPromise = new Promise(resolve => { resolveMidWindow = resolve; });
        await runEarlyBootQmpSession({
            readable: stream([...EARLY_MESSAGES, {return: {}, id: "mid-window-screenshot-1"}]),
            writeBytes: () => undefined,
            screenshotPaths: SCREENSHOTS,
            lateScreenshotPaths: LATE_SCREENSHOTS,
            midWindow: {screenshotPaths: MID_WINDOW_PATHS, executionDeadline},
            onMidWindowObservation: resolveMidWindow
        }, {wait: async ms => { simulatedTime += ms; }, now: () => simulatedTime});
        const midWindowObservation = await midWindowPromise;

        assert.equal(midWindowObservation[0].status, "captured");
        assert.deepEqual(midWindowObservation[1], {
            schemaVersion: 1, status: "skipped", nominalOffsetMs: 900_000, reason: "insufficient-time"
        });
    });

    it("skips both slots as insufficient-time exactly one millisecond past the admission cutoff", async () => {
        // Cutoff for slot 1 (600s): admitted iff now + 10s + 5s < protectedStart = deadline - 20s,
        // i.e. deadline > 635_000. At deadline == 635_000 exactly it must be refused (strict <).
        let resolveRefused;
        const refusedPromise = new Promise(resolve => { resolveRefused = resolve; });
        await runEarlyBootQmpSession({
            readable: stream(EARLY_MESSAGES),
            writeBytes: () => undefined,
            screenshotPaths: SCREENSHOTS,
            lateScreenshotPaths: LATE_SCREENSHOTS,
            midWindow: {screenshotPaths: MID_WINDOW_PATHS, executionDeadline: 635_000},
            onMidWindowObservation: resolveRefused
        }, {wait: async () => undefined, now: () => 0});
        const refused = await refusedPromise;
        assert.deepEqual(refused[0], {
            schemaVersion: 1, status: "skipped", nominalOffsetMs: 600_000, reason: "insufficient-time"
        });

        let resolveAdmitted;
        const admittedPromise = new Promise(resolve => { resolveAdmitted = resolve; });
        await runEarlyBootQmpSession({
            readable: stream([...EARLY_MESSAGES, {return: {}, id: "mid-window-screenshot-1"}]),
            writeBytes: () => undefined,
            screenshotPaths: SCREENSHOTS,
            lateScreenshotPaths: LATE_SCREENSHOTS,
            midWindow: {screenshotPaths: MID_WINDOW_PATHS, executionDeadline: 635_001},
            onMidWindowObservation: resolveAdmitted
        }, {wait: async () => undefined, now: () => 0});
        const admitted = await admittedPromise;
        assert.equal(admitted[0].status, "captured");
    });

    it("reports session-closed (not guest-already-exited) when cancelled before a slot's turn", async () => {
        let sessionControl = null;
        let midWindowObservation = null;
        await runEarlyBootQmpSession({
            readable: stream(EARLY_MESSAGES),
            writeBytes: () => undefined,
            screenshotPaths: SCREENSHOTS,
            lateScreenshotPaths: LATE_SCREENSHOTS,
            midWindow: {screenshotPaths: MID_WINDOW_PATHS, executionDeadline: 1_500_000},
            onMidWindowObservation: obs => { midWindowObservation = obs; },
            onSession: control => { sessionControl = control; }
        }, {wait: async () => undefined, setTimer: () => 1, clearTimer: () => undefined, now: () => 300_000});
        sessionControl.cancel();
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        assert.deepEqual(midWindowObservation[0], {
            schemaVersion: 1, status: "skipped", nominalOffsetMs: 600_000, reason: "session-closed"
        });
        assert.deepEqual(midWindowObservation[1], {
            schemaVersion: 1, status: "skipped", nominalOffsetMs: 900_000, reason: "session-closed"
        });
    });
});

describe("Mid-window capture: stop-optional-continuation on uncertain QMP failure (reader-unavailable)", () => {
    it("taints remaining mid-window slot AND predeadline after a stalled slot-1 command times out, " +
        "and a late-arriving reply produces no second protocol read or extra callback", async () => {
        let simulatedTime = 0;
        const writes = [];
        let midWindowObservation = null;
        let predeadlineObservation = null;
        let midWindowCallCount = 0;
        let predeadlineCallCount = 0;
        let deliverLateReply = null;
        let readCallCount = 0;
        let resolveMidWindow;
        let resolvePredeadline;
        const midWindowPromise = new Promise(resolve => { resolveMidWindow = resolve; });
        const predeadlinePromise = new Promise(resolve => { resolvePredeadline = resolve; });

        // A manually-driven async iterable: yields the scripted early/legacy messages, then hangs on
        // slot 1's response until the test explicitly delivers it - after the deadline has already
        // fired - to prove the stale reply cannot be consumed by a later, different command.
        async function* readable() {
            for (const item of EARLY_MESSAGES) { readCallCount += 1; yield Buffer.from(`${JSON.stringify(item)}\n`); }
            readCallCount += 1;
            const late = await new Promise(resolve => { deliverLateReply = resolve; });
            yield Buffer.from(`${JSON.stringify(late)}\n`);
        }

        await runEarlyBootQmpSession({
            readable: readable(),
            writeBytes: bytes => writes.push(JSON.parse(bytes.toString("utf8"))),
            screenshotPaths: SCREENSHOTS,
            lateScreenshotPaths: LATE_SCREENSHOTS,
            midWindow: {screenshotPaths: MID_WINDOW_PATHS, executionDeadline: 1_500_000},
            predeadline: {screenshotPath: PREDEADLINE_PATH, executionDeadline: 1_500_000},
            onMidWindowObservation: obs => { midWindowCallCount += 1; midWindowObservation = obs; resolveMidWindow(); },
            onPredeadlineObservation: obs => { predeadlineCallCount += 1; predeadlineObservation = obs; resolvePredeadline(); }
        }, {
            wait: async ms => { simulatedTime += ms; },
            setTimer: (callback, ms) => setTimeout(() => { simulatedTime += ms; callback(); }, 5),
            clearTimer: id => clearTimeout(id),
            now: () => simulatedTime
        });
        await Promise.all([midWindowPromise, predeadlinePromise]);

        assert.equal(midWindowObservation[0].status, "unavailable");
        assert.equal(midWindowObservation[0].reason, "command-timeout");
        assert.equal(midWindowObservation[1].status, "unavailable");
        assert.equal(midWindowObservation[1].reason, "reader-unavailable");
        assert.equal(predeadlineObservation.status, "unavailable");
        assert.equal(predeadlineObservation.reason, "reader-unavailable");
        assert.equal(midWindowCallCount, 1);
        assert.equal(predeadlineCallCount, 1);
        const writeCountAtTaint = writes.length;
        const readCallCountBeforeDelivery = readCallCount;

        // Now deliver the stale reply. No further optional command was ever issued after tainting,
        // so nothing is left reading the stream to consume it; delivering it must not throw, must not
        // trigger any further write, and must not change either already-settled observation. The
        // generator resuming past its stalled await (readCallCount unmoved - nothing pulls a fresh
        // value from it because no code calls the shared reader again) is itself proof no later
        // command became a second reader of this stream.
        deliverLateReply({return: {}, id: "mid-window-screenshot-1"});
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

        assert.equal(writes.length, writeCountAtTaint, "no write was issued after tainting");
        assert.equal(midWindowCallCount, 1, "no second mid-window report after the stale reply");
        assert.equal(predeadlineCallCount, 1, "no second predeadline report after the stale reply");
        assert.equal(readCallCount, readCallCountBeforeDelivery,
            "nothing called the shared reader again to consume the stale reply");
    });

    it("taints mid-window when the legacy mandatory milestone loop itself fails, only when enabled", async () => {
        let midWindowObservation = null;
        let predeadlineObservation = null;
        let resolveMidWindow;
        let resolvePredeadline;
        const midWindowPromise = new Promise(resolve => { resolveMidWindow = resolve; });
        const predeadlinePromise = new Promise(resolve => { resolvePredeadline = resolve; });
        await runEarlyBootQmpSession({
            readable: stream([
                EARLY_MESSAGES[0], EARLY_MESSAGES[1], EARLY_MESSAGES[2], EARLY_MESSAGES[3], EARLY_MESSAGES[4],
                {return: {running: true, status: "running"}, id: "late-status-1"},
                // Malformed: neither return nor error -> expectResponse throws, ending the milestone loop.
                {id: "late-screenshot-1"}
            ]),
            writeBytes: () => undefined,
            screenshotPaths: SCREENSHOTS,
            lateScreenshotPaths: LATE_SCREENSHOTS,
            midWindow: {screenshotPaths: MID_WINDOW_PATHS, executionDeadline: 1_500_000},
            predeadline: {screenshotPath: PREDEADLINE_PATH, executionDeadline: 1_500_000},
            onMidWindowObservation: obs => { midWindowObservation = obs; resolveMidWindow(); },
            onPredeadlineObservation: obs => { predeadlineObservation = obs; resolvePredeadline(); }
        }, {wait: async () => undefined, now: () => 300_000});
        await Promise.all([midWindowPromise, predeadlinePromise]);

        assert.deepEqual(midWindowObservation[0], {
            schemaVersion: 1, status: "unavailable", nominalOffsetMs: 600_000, reason: "reader-unavailable"
        });
        assert.deepEqual(midWindowObservation[1], {
            schemaVersion: 1, status: "unavailable", nominalOffsetMs: 900_000, reason: "reader-unavailable"
        });
        assert.equal(predeadlineObservation.status, "unavailable");
        assert.equal(predeadlineObservation.reason, "reader-unavailable");
    });
});
