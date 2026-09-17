import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {
    runEarlyBootQmpSession,
    validateMidWindowScreenshotPaths,
    MID_WINDOW_SAMPLE_OFFSETS_MILLISECONDS,
    MID_WINDOW_FRAME_FILENAMES,
    MID_WINDOW_COMMAND_TIMEOUT_MILLISECONDS,
    MID_WINDOW_SCHEDULING_MARGIN_MILLISECONDS,
    WINPE_DIAGNOSTIC_CONFIRMATION
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

// Collects per-slot onMidWindowFrame(index, record) calls into a two-slot array, and resolves once
// both slots have reported - the one consistent callback signature used at every hop.
function collectMidWindowFrames() {
    const frames = [null, null];
    const calls = [];
    let resolveBoth;
    const bothSettled = new Promise(resolve => { resolveBoth = resolve; });
    const onMidWindowFrame = (index, record) => {
        frames[index] = record;
        calls.push({index, record});
        if (calls.length === MID_WINDOW_SAMPLE_OFFSETS_MILLISECONDS.length) resolveBoth(frames);
    };
    return {frames, calls, bothSettled, onMidWindowFrame};
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

    it("returns a defensive copy: mutating the caller's array after validation does not change it", () => {
        const input = [...MID_WINDOW_PATHS];
        const returned = validateMidWindowScreenshotPaths(input);
        assert.notEqual(returned, input);
        input[0] = "mutated";
        assert.deepEqual(returned, MID_WINDOW_PATHS);
    });
});

describe("Mid-window capture: disabled by default", () => {
    it("does not attach any onMidWindowFrame call when midWindow input is absent", async () => {
        const collected = collectMidWindowFrames();
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
            onMidWindowFrame: collected.onMidWindowFrame,
            onPredeadlineObservation: obs => { predeadlineObservation = obs; resolvePredeadline(obs); }
        }, {wait: async ms => { simulatedTime += ms; }, now: () => simulatedTime});
        await predeadlinePromise;
        assert.equal(collected.calls.length, 0);
        assert.equal(predeadlineObservation?.status, "captured");
    });
});

describe("Mid-window capture: happy path and admission timing", () => {
    it("captures both slots at their nominal offsets and predeadline still runs after", async () => {
        let simulatedTime = 0;
        const writes = [];
        const collected = collectMidWindowFrames();
        let predeadlineObservation = null;
        let resolvePredeadline;
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
            onMidWindowFrame: collected.onMidWindowFrame,
            onPredeadlineObservation: obs => { predeadlineObservation = obs; resolvePredeadline(obs); }
        }, {wait: async ms => { simulatedTime += ms; }, now: () => simulatedTime});

        const frames = await collected.bothSettled;
        assert.deepEqual(frames[0], {
            schemaVersion: 1, status: "captured", nominalOffsetMs: 600_000, offsetMs: 600_000,
            screenshotPath: MID_WINDOW_PATHS[0]
        });
        assert.deepEqual(frames[1], {
            schemaVersion: 1, status: "captured", nominalOffsetMs: 900_000, offsetMs: 900_000,
            screenshotPath: MID_WINDOW_PATHS[1]
        });
        assert.throws(() => { frames[0].status = "mutated"; });

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
        const collected = collectMidWindowFrames();
        await runEarlyBootQmpSession({
            readable: stream([...EARLY_MESSAGES, {return: {}, id: "mid-window-screenshot-1"}]),
            writeBytes: () => undefined,
            screenshotPaths: SCREENSHOTS,
            lateScreenshotPaths: LATE_SCREENSHOTS,
            midWindow: {screenshotPaths: MID_WINDOW_PATHS, executionDeadline},
            onMidWindowFrame: collected.onMidWindowFrame
        }, {wait: async ms => { simulatedTime += ms; }, now: () => simulatedTime});
        const frames = await collected.bothSettled;

        assert.equal(frames[0].status, "captured");
        assert.deepEqual(frames[1], {
            schemaVersion: 1, status: "skipped", nominalOffsetMs: 900_000, reason: "insufficient-time"
        });
    });

    it("skips both slots as insufficient-time exactly one millisecond past the admission cutoff", async () => {
        // Cutoff for slot 1 (600s): admitted iff now + 10s + 5s < protectedStart = deadline - 20s,
        // i.e. deadline > 635_000. At deadline == 635_000 exactly it must be refused (strict <).
        const refused = collectMidWindowFrames();
        await runEarlyBootQmpSession({
            readable: stream(EARLY_MESSAGES),
            writeBytes: () => undefined,
            screenshotPaths: SCREENSHOTS,
            lateScreenshotPaths: LATE_SCREENSHOTS,
            midWindow: {screenshotPaths: MID_WINDOW_PATHS, executionDeadline: 635_000},
            onMidWindowFrame: refused.onMidWindowFrame
        }, {wait: async () => undefined, now: () => 0});
        const refusedFrames = await refused.bothSettled;
        assert.deepEqual(refusedFrames[0], {
            schemaVersion: 1, status: "skipped", nominalOffsetMs: 600_000, reason: "insufficient-time"
        });

        const admitted = collectMidWindowFrames();
        await runEarlyBootQmpSession({
            readable: stream([...EARLY_MESSAGES, {return: {}, id: "mid-window-screenshot-1"}]),
            writeBytes: () => undefined,
            screenshotPaths: SCREENSHOTS,
            lateScreenshotPaths: LATE_SCREENSHOTS,
            midWindow: {screenshotPaths: MID_WINDOW_PATHS, executionDeadline: 635_001},
            onMidWindowFrame: admitted.onMidWindowFrame
        }, {wait: async () => undefined, now: () => 0});
        const admittedFrames = await admitted.bothSettled;
        assert.equal(admittedFrames[0].status, "captured");
    });

    it("crosses the admission cutoff between the post-wake check and the actual writeBytes call, " +
        "and records skipped/insufficient-time without tainting the reader", async () => {
        // executionDeadline = 1_000_000 -> protectedStart = 980_000, admission cutoff at now < 965_000.
        // The scripted clock: sessionStartTime=0, slot-1 preWaitNow=600_000 (fits), post-wake
        // check=960_000 (still fits), then the writeBytes-boundary recheck=970_000 (no longer fits) -
        // the clock crosses the cutoff strictly between those last two checks. No write for slot 1 may
        // ever be issued, and the reader must not be tainted (proven by predeadline reporting its own
        // ordinary "insufficient-time" outcome rather than the tainted "reader-unavailable").
        const nowSequence = [0, 600_000, 960_000, 970_000, 1_000_000];
        let nowIndex = 0;
        const now = () => nowSequence[Math.min(nowIndex++, nowSequence.length - 1)];
        const executionDeadline = 1_000_000;
        const writes = [];
        const collected = collectMidWindowFrames();
        let predeadlineObservation = null;
        let resolvePredeadline;
        const predeadlinePromise = new Promise(resolve => { resolvePredeadline = resolve; });
        await runEarlyBootQmpSession({
            readable: stream(EARLY_MESSAGES),
            writeBytes: bytes => { writes.push(JSON.parse(bytes.toString("utf8"))); return undefined; },
            screenshotPaths: SCREENSHOTS,
            lateScreenshotPaths: LATE_SCREENSHOTS,
            midWindow: {screenshotPaths: MID_WINDOW_PATHS, executionDeadline},
            predeadline: {screenshotPath: PREDEADLINE_PATH, executionDeadline},
            onMidWindowFrame: collected.onMidWindowFrame,
            onPredeadlineObservation: obs => { predeadlineObservation = obs; resolvePredeadline(obs); }
        }, {wait: async () => undefined, now});
        const frames = await collected.bothSettled;

        assert.deepEqual(frames[0], {
            schemaVersion: 1, status: "skipped", nominalOffsetMs: 600_000, reason: "insufficient-time"
        });
        assert.equal(writes.some(w => w.id === "mid-window-screenshot-1"), false,
            "no write may be issued once the admission window has closed at the writeBytes boundary");

        await predeadlinePromise;
        assert.notEqual(predeadlineObservation.reason, "reader-unavailable",
            "an admission miss must not taint the reader for a command never issued");
    });

    it("reports session-closed (not guest-already-exited) when cancelled before a slot's turn", async () => {
        let sessionControl = null;
        const collected = collectMidWindowFrames();
        await runEarlyBootQmpSession({
            readable: stream(EARLY_MESSAGES),
            writeBytes: () => undefined,
            screenshotPaths: SCREENSHOTS,
            lateScreenshotPaths: LATE_SCREENSHOTS,
            midWindow: {screenshotPaths: MID_WINDOW_PATHS, executionDeadline: 1_500_000},
            onMidWindowFrame: collected.onMidWindowFrame,
            onSession: control => { sessionControl = control; }
        }, {wait: async () => undefined, setTimer: () => 1, clearTimer: () => undefined, now: () => 300_000});
        sessionControl.cancel();
        const frames = await collected.bothSettled;
        assert.deepEqual(frames[0], {
            schemaVersion: 1, status: "skipped", nominalOffsetMs: 600_000, reason: "session-closed"
        });
        assert.deepEqual(frames[1], {
            schemaVersion: 1, status: "skipped", nominalOffsetMs: 900_000, reason: "session-closed"
        });
    });
});

describe("Mid-window capture: WinPE-diagnostic combination is rejected at the QMP boundary", () => {
    it("rejects midWindow input combined with a winpeDiagnostic authorization", async () => {
        await assert.rejects(runEarlyBootQmpSession({
            readable: stream(EARLY_MESSAGES),
            writeBytes: () => undefined,
            screenshotPaths: SCREENSHOTS,
            lateScreenshotPaths: LATE_SCREENSHOTS,
            midWindow: {screenshotPaths: MID_WINDOW_PATHS, executionDeadline: 1_500_000},
            winpeDiagnostic: {confirmation: WINPE_DIAGNOSTIC_CONFIRMATION, nonce: NONCE}
        }, {wait: async () => undefined, now: () => 0}), /mid-window frames cannot combine/u);
    });
});

describe("Mid-window capture: stop-optional-continuation on uncertain QMP failure (reader-unavailable)", () => {
    it("taints remaining mid-window slot AND predeadline after a stalled slot-1 command times out, " +
        "and a late-arriving reply produces no second protocol read or extra callback", async () => {
        let simulatedTime = 0;
        const writes = [];
        const collected = collectMidWindowFrames();
        let predeadlineObservation = null;
        let predeadlineCallCount = 0;
        let deliverLateReply = null;
        let readCallCount = 0;
        let resolvePredeadline;
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
            onMidWindowFrame: collected.onMidWindowFrame,
            onPredeadlineObservation: obs => { predeadlineCallCount += 1; predeadlineObservation = obs; resolvePredeadline(); }
        }, {
            wait: async ms => { simulatedTime += ms; },
            setTimer: (callback, ms) => setTimeout(() => { simulatedTime += ms; callback(); }, 5),
            clearTimer: id => clearTimeout(id),
            now: () => simulatedTime
        });
        const [frames] = await Promise.all([collected.bothSettled, predeadlinePromise]);

        assert.equal(frames[0].status, "unavailable");
        assert.equal(frames[0].reason, "command-timeout");
        assert.equal(frames[1].status, "unavailable");
        assert.equal(frames[1].reason, "reader-unavailable");
        assert.equal(predeadlineObservation.status, "unavailable");
        assert.equal(predeadlineObservation.reason, "reader-unavailable");
        assert.equal(collected.calls.length, 2);
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
        assert.equal(collected.calls.length, 2, "no second mid-window report after the stale reply");
        assert.equal(predeadlineCallCount, 1, "no second predeadline report after the stale reply");
        assert.equal(readCallCount, readCallCountBeforeDelivery,
            "nothing called the shared reader again to consume the stale reply");
    });

    it("a write that succeeds only after its outer command deadline already tainted the session " +
        "must not start a new read", async () => {
        let readCallCount = 0;
        let deliverLateWrite = null;
        const pendingWrite = new Promise(resolve => { deliverLateWrite = resolve; });
        let simulatedTime = 0;
        let setTimerCallIndex = 0;
        /*
         * Every deadline in this session behaves normally (short real delay, uniform for every
         * call) except two, identified by their fixed position in this exact session's call order
         * (empirically confirmed: #22 is write()'s own internal deadline for the mid-window slot-1
         * command, #23 is the outer per-command deadline wrapping that write+read pair). #22 is made
         * inert - it must never fire, so the write settles only through the test's own control,
         * mirroring a write whose own deadline never actually elapsed. #23 fires via a microtask,
         * deterministically ahead of that still-pending write, reproducing "the outer deadline
         * observes this operation as lost while the write is still in flight and later succeeds."
         */
        const setTimer = (callback, ms) => {
            setTimerCallIndex += 1;
            const myIndex = setTimerCallIndex;
            if (myIndex === 22) return {inert: true};
            if (myIndex === 23) { queueMicrotask(callback); return {queued: true}; }
            const id = setTimeout(() => { simulatedTime += ms; callback(); }, 5);
            return {id};
        };
        const clearTimer = handle => { if (handle?.id !== undefined) clearTimeout(handle.id); };

        async function* readable() {
            for (const item of EARLY_MESSAGES) { readCallCount += 1; yield Buffer.from(`${JSON.stringify(item)}\n`); }
        }
        const writeBytes = bytes => {
            const parsed = JSON.parse(bytes.toString("utf8"));
            if (parsed.id === "mid-window-screenshot-1") return pendingWrite;
            return undefined;
        };

        const collected = collectMidWindowFrames();
        await runEarlyBootQmpSession({
            readable: readable(),
            writeBytes,
            screenshotPaths: SCREENSHOTS,
            lateScreenshotPaths: LATE_SCREENSHOTS,
            midWindow: {screenshotPaths: MID_WINDOW_PATHS, executionDeadline: 1_500_000},
            onMidWindowFrame: collected.onMidWindowFrame
        }, {wait: async ms => { simulatedTime += ms; }, setTimer, clearTimer, now: () => simulatedTime});
        const frames = await collected.bothSettled;

        // The outer deadline fired (via the queued microtask) before the write settled, tainting the
        // session; slot 2 inherits reader-unavailable without ever attempting its own write.
        assert.equal(frames[0].status, "unavailable");
        assert.equal(frames[0].reason, "command-timeout");
        assert.equal(frames[1].status, "unavailable");
        assert.equal(frames[1].reason, "reader-unavailable");
        const readCallCountAtTaint = readCallCount;
        const callCountAtTaint = collected.calls.length;

        // Deliver the late write resolution: the abandoned commandOperation's own `await write(...)`
        // now resolves successfully (not via its own deadline). It must see the taint set earlier and
        // must not proceed to call expectResponse/readMessage - the guard this test exists to prove.
        deliverLateWrite();
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

        assert.equal(readCallCount, readCallCountAtTaint,
            "a write that resolves after tainting must not start a new read");
        assert.equal(collected.calls.length, callCountAtTaint, "no further mid-window report after the late write");
    });

    it("taints mid-window when the legacy mandatory milestone loop itself fails, only when enabled", async () => {
        const collected = collectMidWindowFrames();
        let predeadlineObservation = null;
        let resolvePredeadline;
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
            onMidWindowFrame: collected.onMidWindowFrame,
            onPredeadlineObservation: obs => { predeadlineObservation = obs; resolvePredeadline(); }
        }, {wait: async () => undefined, now: () => 300_000});
        const [frames] = await Promise.all([collected.bothSettled, predeadlinePromise]);

        assert.deepEqual(frames[0], {
            schemaVersion: 1, status: "unavailable", nominalOffsetMs: 600_000, reason: "reader-unavailable"
        });
        assert.deepEqual(frames[1], {
            schemaVersion: 1, status: "unavailable", nominalOffsetMs: 900_000, reason: "reader-unavailable"
        });
        assert.equal(predeadlineObservation.status, "unavailable");
        assert.equal(predeadlineObservation.reason, "reader-unavailable");
    });

    it("a throwing onMidWindowFrame callback does not suppress predeadline finalization", async () => {
        let predeadlineObservation = null;
        let resolvePredeadline;
        const predeadlinePromise = new Promise(resolve => { resolvePredeadline = resolve; });
        let midWindowCallCount = 0;
        await runEarlyBootQmpSession({
            readable: stream([...EARLY_MESSAGES,
                {return: {}, id: "mid-window-screenshot-1"},
                {return: {}, id: "mid-window-screenshot-2"},
                {return: {}, id: "predeadline-screenshot"}]),
            writeBytes: () => undefined,
            screenshotPaths: SCREENSHOTS,
            lateScreenshotPaths: LATE_SCREENSHOTS,
            midWindow: {screenshotPaths: MID_WINDOW_PATHS, executionDeadline: 1_500_000},
            predeadline: {screenshotPath: PREDEADLINE_PATH, executionDeadline: 1_500_000},
            onMidWindowFrame: () => { midWindowCallCount += 1; throw new Error("a deliberately broken consumer"); },
            onPredeadlineObservation: obs => { predeadlineObservation = obs; resolvePredeadline(obs); }
        }, {wait: async () => undefined, now: () => 0});
        await predeadlinePromise;

        assert.equal(midWindowCallCount, 2);
        assert.equal(predeadlineObservation.status, "captured");
    });
});
