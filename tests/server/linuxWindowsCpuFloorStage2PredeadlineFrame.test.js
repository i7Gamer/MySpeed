import assert from "node:assert/strict";
import crypto from "node:crypto";
import {describe, it} from "node:test";
import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";

import {
    runEarlyBootQmpSession,
    validatePredeadlineScreenshotPath,
    MID_WINDOW_SAMPLE_OFFSETS_MILLISECONDS,
    PREDEADLINE_FRAME_LEAD_MILLISECONDS,
    PREDEADLINE_FRAME_COMMAND_TIMEOUT_MILLISECONDS,
    PREDEADLINE_FRAME_TICK_JITTER_MILLISECONDS,
    PREDEADLINE_FRAME_CLEANUP_HEADROOM_MILLISECONDS
} from "../../scripts/qualification/linux-windows-cpu-floor-stage2-qmp.mjs";
import {
    validatePredeadlineFrameDiagnostic,
    validateMidWindowFramesDiagnostic,
    validateQemuLaunchDiagnostic,
    MID_WINDOW_FRAME_UNAVAILABLE_REASONS,
    PREDEADLINE_FRAME_STATUSES,
    PREDEADLINE_FRAME_SKIPPED_REASONS,
    PREDEADLINE_FRAME_UNAVAILABLE_REASONS,
    PREDEADLINE_FRAME_MALFORMED_REASONS,
    MAX_PREDEADLINE_FRAME_BYTES
} from "../../scripts/qualification/linux-windows-cpu-floor-stage2.mjs";
import {
    collectMidWindowFramesDiagnostic,
    collectPredeadlineFrameDiagnostic,
    createHostedStage2Operations,
    runHostedOwnedProcess,
    runMonitoredQemu
} from "../../scripts/qualification/linux-windows-cpu-floor-stage2-hosted.mjs";

const NONCE = "c92cbf717ee04ed4948ed011060743bb";
const ROOT = `/home/runner/work/_temp/myspeed-windows-cpu-floor-${NONCE}`;
const PREDEADLINE_PATH = `${ROOT}/predeadline-frame.png`;
const SCREENSHOTS = [`${ROOT}/early-boot-1.png`, `${ROOT}/early-boot-2.png`];
const LATE_SCREENSHOTS = [`${ROOT}/late-boot-1.png`, `${ROOT}/late-boot-2.png`];

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DUMMY_PNG = Buffer.concat([PNG_HEADER, Buffer.from("IHDR-dummy-data")]);

function sha256(bytes) {
    return crypto.createHash("sha256").update(bytes).digest("hex");
}

function stream(messages) {
    return ReadableStream.from(messages.map(value => Buffer.from(`${typeof value === "string" ? value :
        JSON.stringify(value)}\n`)));
}

describe("Predeadline frame path validation", () => {
    it("accepts canonical predeadline frame path", () => {
        const path = validatePredeadlineScreenshotPath(PREDEADLINE_PATH);
        assert.equal(path, PREDEADLINE_PATH);
    });

    it("rejects invalid basenames or directories", () => {
        assert.throws(() => validatePredeadlineScreenshotPath(`${ROOT}/late-boot-3.png`), /predeadline/u);
        assert.throws(() => validatePredeadlineScreenshotPath(`${ROOT}/other.png`), /predeadline/u);
        assert.throws(() => validatePredeadlineScreenshotPath(`/tmp/predeadline-frame.png`), /predeadline/u);
        assert.throws(() => validatePredeadlineScreenshotPath(""), /predeadline/u);
        assert.throws(() => validatePredeadlineScreenshotPath(null), /predeadline/u);
    });

    it("rejects Stage 3 and MSI roots", () => {
        const stage3Path = `/home/runner/work/_temp/myspeed-stage3-${NONCE}/predeadline-frame.png`;
        const msiPath = `/home/runner/work/_temp/myspeed-windows-msi-${NONCE}/predeadline-frame.png`;
        assert.throws(() => validatePredeadlineScreenshotPath(stage3Path), /predeadline/u);
        assert.throws(() => validatePredeadlineScreenshotPath(msiPath), /predeadline/u);
    });
});

describe("Named lead constant code-derived justification", () => {
    it("matches sum of command timeout, tick jitter, and cleanup headroom", () => {
        assert.equal(PREDEADLINE_FRAME_COMMAND_TIMEOUT_MILLISECONDS, 10_000);
        assert.equal(PREDEADLINE_FRAME_TICK_JITTER_MILLISECONDS, 5_000);
        assert.equal(PREDEADLINE_FRAME_CLEANUP_HEADROOM_MILLISECONDS, 5_000);
        assert.equal(
            PREDEADLINE_FRAME_LEAD_MILLISECONDS,
            PREDEADLINE_FRAME_COMMAND_TIMEOUT_MILLISECONDS +
            PREDEADLINE_FRAME_TICK_JITTER_MILLISECONDS +
            PREDEADLINE_FRAME_CLEANUP_HEADROOM_MILLISECONDS
        );
        assert.equal(PREDEADLINE_FRAME_LEAD_MILLISECONDS, 20_000);
    });
});

describe("Predeadline frame diagnostic schema validation", () => {
    it("exports frozen status constants and maximum byte cap", () => {
        assert.deepEqual(PREDEADLINE_FRAME_STATUSES, ["captured", "skipped", "unavailable", "malformed"]);
        assert.equal(MAX_PREDEADLINE_FRAME_BYTES, 1_048_576);
    });

    it("accepts valid captured predeadline frame", () => {
        const sample = {
            schemaVersion: 1,
            status: "captured",
            offsetMs: 1_480_000,
            screenshot: {
                path: PREDEADLINE_PATH,
                bytes: String(DUMMY_PNG.length),
                sha256: sha256(DUMMY_PNG),
                bytesBase64: DUMMY_PNG.toString("base64")
            }
        };
        const validated = validatePredeadlineFrameDiagnostic(sample, ROOT);
        assert.deepEqual(validated, sample);
    });

    it("rejects captured frame with path mismatch or non-PNG content", () => {
        const wrongPath = {
            schemaVersion: 1,
            status: "captured",
            offsetMs: 1_480_000,
            screenshot: {
                path: `${ROOT}/other.png`,
                bytes: String(DUMMY_PNG.length),
                sha256: sha256(DUMMY_PNG),
                bytesBase64: DUMMY_PNG.toString("base64")
            }
        };
        assert.throws(() => validatePredeadlineFrameDiagnostic(wrongPath, ROOT), /path/u);

        const nonPng = {
            schemaVersion: 1,
            status: "captured",
            offsetMs: 1_480_000,
            screenshot: {
                path: PREDEADLINE_PATH,
                bytes: "4",
                sha256: sha256(Buffer.from("text")),
                bytesBase64: Buffer.from("text").toString("base64")
            }
        };
        assert.throws(() => validatePredeadlineFrameDiagnostic(nonPng, ROOT), /content/u);
    });

    it("accepts all valid skipped reasons", () => {
        for (const reason of PREDEADLINE_FRAME_SKIPPED_REASONS) {
            const diag = {schemaVersion: 1, status: "skipped", reason};
            const validated = validatePredeadlineFrameDiagnostic(diag);
            assert.deepEqual(validated, diag);
        }
    });

    it("rejects invalid skipped reason or extra keys", () => {
        assert.throws(() => validatePredeadlineFrameDiagnostic({schemaVersion: 1, status: "skipped", reason: "unknown"}));
        assert.throws(() => validatePredeadlineFrameDiagnostic({schemaVersion: 1, status: "skipped", reason: "insufficient-time", extra: true}));
    });

    it("accepts all valid unavailable reasons with optional offsetMs and preserves backward compatibility", () => {
        for (const reason of PREDEADLINE_FRAME_UNAVAILABLE_REASONS) {
            const diagWithout = {schemaVersion: 1, status: "unavailable", reason};
            const validatedWithout = validatePredeadlineFrameDiagnostic(diagWithout);
            assert.deepEqual(validatedWithout, diagWithout);

            const diagWith = {schemaVersion: 1, status: "unavailable", reason, offsetMs: 1_480_000};
            const validatedWith = validatePredeadlineFrameDiagnostic(diagWith);
            assert.deepEqual(validatedWith, diagWith);
        }
    });

    it("keeps continuous-dispatcher provenance internal to preserve diagnostic schemas", () => {
        const reasons = ["qmp-shutdown-malformed", "qmp-unexpected-response", "dispatcher-terminal"];
        for (const reason of reasons) {
            assert.equal(PREDEADLINE_FRAME_UNAVAILABLE_REASONS.includes(reason), false);
            assert.equal(MID_WINDOW_FRAME_UNAVAILABLE_REASONS.includes(reason), false);
        }
    });

    it("maps internal dispatcher provenance to the disclosed command-failed reason at the hosted boundary", () => {
        // The QMP session reports its raw provenance; the hosted collectors are the only consumers
        // and must publish a vocabulary reason so the failure diagnostic still validates.
        const offsetMs = 1_480_000;
        const reasons = ["qmp-shutdown-malformed", "qmp-unexpected-response", "dispatcher-terminal"];
        for (const reason of reasons) {
            const predeadline = collectPredeadlineFrameDiagnostic({}, {paths: {root: ROOT}},
                {status: "unavailable", reason, offsetMs}, true);
            assert.deepEqual(predeadline, {schemaVersion: 1, status: "unavailable", reason: "command-failed", offsetMs});
            assert.deepEqual(validatePredeadlineFrameDiagnostic(predeadline, ROOT), predeadline);

            const midWindow = collectMidWindowFramesDiagnostic({}, {paths: {root: ROOT}}, [
                {schemaVersion: 1, status: "unavailable", nominalOffsetMs: MID_WINDOW_SAMPLE_OFFSETS_MILLISECONDS[0],
                    offsetMs, reason},
                {schemaVersion: 1, status: "unavailable", nominalOffsetMs: MID_WINDOW_SAMPLE_OFFSETS_MILLISECONDS[1],
                    reason: "reader-unavailable"}
            ], true);
            assert.deepEqual(midWindow, [
                {schemaVersion: 1, status: "unavailable", nominalOffsetMs: MID_WINDOW_SAMPLE_OFFSETS_MILLISECONDS[0],
                    reason: "command-failed", offsetMs},
                {schemaVersion: 1, status: "unavailable", nominalOffsetMs: MID_WINDOW_SAMPLE_OFFSETS_MILLISECONDS[1],
                    reason: "reader-unavailable"}
            ]);
            assert.deepEqual(validateMidWindowFramesDiagnostic(midWindow, ROOT), midWindow);
        }
    });

    it("rejects invalid offsetMs or unexpected keys on unavailable frame", () => {
        assert.throws(() => validatePredeadlineFrameDiagnostic({
            schemaVersion: 1, status: "unavailable", reason: "command-failed", offsetMs: -1
        }), /offset/u);
        assert.throws(() => validatePredeadlineFrameDiagnostic({
            schemaVersion: 1, status: "unavailable", reason: "command-failed", offsetMs: 1.5
        }), /offset/u);
        assert.throws(() => validatePredeadlineFrameDiagnostic({
            schemaVersion: 1, status: "unavailable", reason: "command-failed", offsetMs: "1480000"
        }), /offset/u);
        assert.throws(() => validatePredeadlineFrameDiagnostic({
            schemaVersion: 1, status: "unavailable", reason: "command-failed", extraKey: true
        }), /keys/u);
    });

    it("accepts all valid malformed reasons with bytes and sha256", () => {
        for (const reason of PREDEADLINE_FRAME_MALFORMED_REASONS) {
            const diag = {schemaVersion: 1, status: "malformed", reason, bytes: "100", sha256: "a".repeat(64)};
            const validated = validatePredeadlineFrameDiagnostic(diag);
            assert.deepEqual(validated, diag);
        }
    });

    it("integrates with validateQemuLaunchDiagnostic optionally", () => {
        const baseProcess = {
            exitCode: 1, signal: null, timedOut: true, cleanupProven: true,
            treeGone: true, qemuPid: 12345, qemuStartTicks: "1000",
            launcherExecutablePath: "/usr/bin/qemu-system-x86_64",
            processGroupId: 12345, qemuPidAbsentAfter: true, terminationReason: "deadline"
        };
        const baseDiagnostic = {
            schemaVersion: 1,
            kind: "qemu-launch-failure-diagnostic",
            process: baseProcess,
            processFlags: {errorObserved: false, stdoutOverflow: false, stderrOverflow: false},
            monitorFailure: null,
            stderr: {bytes: "0", sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", bytesBase64: ""}
        };

        // 1. Without predeadlineFrame (historical fixture compatibility)
        const validWithout = validateQemuLaunchDiagnostic(baseDiagnostic, baseProcess, NONCE);
        assert.equal(validWithout.predeadlineFrame, undefined);

        // 2. With valid predeadlineFrame
        const diagWithFrame = {
            ...baseDiagnostic,
            predeadlineFrame: {
                schemaVersion: 1,
                status: "skipped",
                reason: "guest-already-exited"
            }
        };
        const validWith = validateQemuLaunchDiagnostic(diagWithFrame, baseProcess, NONCE);
        assert.equal(validWith.predeadlineFrame.status, "skipped");
    });
});

describe("QMP predeadline frame sequencing & scheduling", () => {
    /*
     * A bounded session shares one reader, so a milestone that abandons an owed acknowledgement
     * closes it for the predeadline frame too. The milestone loop already names that condition
     * `reader-unavailable`; this frame reported the session's raw internal provenance instead,
     * which the hosted collector then coerced to `command-failed` because no vocabulary admits
     * it - telling a reader the monitor refused a command when no command was ever issued.
     */
    it("names a closed reader on the predeadline frame as the milestone loop does", async () => {
        const writes = [];
        let predeadline = null;
        let resolvePredeadline;
        const predeadlineSettled = new Promise(resolve => { resolvePredeadline = resolve; });
        let latePromise = null;
        let clock = 0;
        let armed = false;
        const pending = [];
        let resolveChunk = null;
        const push = value => {
            const chunk = Buffer.from(`${JSON.stringify(value)}\r\n`);
            if (resolveChunk !== null) {
                const resolver = resolveChunk;
                resolveChunk = null;
                resolver({value: chunk, done: false});
            } else pending.push(chunk);
        };
        const readable = {[Symbol.asyncIterator]: () => ({next: () => (pending.length > 0 ?
            Promise.resolve({value: pending.shift(), done: false}) :
            new Promise(resolve => { resolveChunk = resolve; }))})};
        push({QMP: {version: {qemu: {major: 10, minor: 1, micro: 2}, package: ""}, capabilities: []}});
        await runEarlyBootQmpSession({
            readable,
            writeBytes: bytes => {
                const value = JSON.parse(bytes.toString("utf8"));
                writes.push(value);
                /* Withheld: the read that follows can only end at its deadline, still owed. */
                if (value.id === "late-screenshot-1") { armed = true; return; }
                push(/status$/u.test(value.id) ? {return: {running: true, status: "running"}, id: value.id} :
                    {return: {}, id: value.id});
            },
            screenshotPaths: SCREENSHOTS,
            lateScreenshotPaths: LATE_SCREENSHOTS,
            predeadline: {screenshotPath: PREDEADLINE_PATH, executionDeadline: 1_500_000},
            onPredeadlineObservation: observation => { predeadline = observation; resolvePredeadline(); },
            onLateObservation: promise => { latePromise = promise; }
        }, {
            now: () => clock,
            wait: async milliseconds => { clock += milliseconds; },
            /*
             * Pacing runs immediately; the reply deadline is held back until there is an owed
             * acknowledgement to abandon, so the reader closes for the reason under test rather
             * than every exchange expiring at once.
             */
            setTimer: (callback, milliseconds) => {
                if (armed && milliseconds === PREDEADLINE_FRAME_COMMAND_TIMEOUT_MILLISECONDS) {
                    queueMicrotask(callback);
                    return 0;
                }
                return setTimeout(callback, 0);
            },
            clearTimer: handle => clearTimeout(handle)
        });
        await latePromise;
        let watchdog;
        await Promise.race([predeadlineSettled, new Promise((resolve, reject) => {
            watchdog = setTimeout(() => reject(new Error("the predeadline frame never settled")), 2_000);
        })]).finally(() => clearTimeout(watchdog));
        assert.equal(predeadline.status, "unavailable");
        assert.equal(predeadline.reason, "reader-unavailable",
            "no command was issued, so the monitor refused none");
        assert.equal(PREDEADLINE_FRAME_UNAVAILABLE_REASONS.includes(predeadline.reason), true,
            "and the reason has to be one the hosted collector will publish");
    });

    it("schedules screendump at executionDeadline minus lead milliseconds and settles late milestones promptly", async () => {
        let simulatedTime = 0;
        const delays = [];
        const writes = [];
        let predeadlineObservation = null;
        let lateObservationPromise = null;
        let resolvePredeadline;
        const predeadlinePromise = new Promise(resolve => { resolvePredeadline = resolve; });

        const fakeWait = async ms => {
            delays.push(ms);
            simulatedTime += ms;
        };

        // 25 minutes = 1500s = 1,500,000 ms. Lead = 20,000 ms. Target = 1,480,000 ms.
        const executionDeadline = 1_500_000;

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
                {return: {}, id: "late-screenshot-2"},
                {return: {}, id: "predeadline-screenshot"}
            ]),
            writeBytes: bytes => writes.push(JSON.parse(bytes.toString("utf8"))),
            screenshotPaths: SCREENSHOTS,
            lateScreenshotPaths: LATE_SCREENSHOTS,
            predeadline: {screenshotPath: PREDEADLINE_PATH, executionDeadline},
            onPredeadlineObservation: obs => {
                predeadlineObservation = obs;
                resolvePredeadline(obs);
            },
            onLateObservation: promise => { lateObservationPromise = promise; }
        }, {
            wait: fakeWait,
            now: () => simulatedTime
        });

        assert.equal(result.running, true);
        assert.ok(lateObservationPromise !== null);

        // Late boot observation resolves promptly at T+300s with 2 milestones (NOT held hostage by predeadline)
        const lateResult = await lateObservationPromise;
        assert.equal(lateResult.milestones.length, 2);
        assert.deepEqual(delays.slice(0, 4), [5_000, 30_000, 85_000, 180_000]);

        // Predeadline completes at target offset
        await predeadlinePromise;
        assert.deepEqual(delays, [5_000, 30_000, 85_000, 180_000, 1_180_000]);
        assert.equal(simulatedTime, 1_480_000);

        // Writes include early boot, late milestones, and the single predeadline screendump
        assert.deepEqual(writes.map(w => w.id), [
            "capabilities", "status", "screenshot-1", "screenshot-2",
            "late-status-1", "late-screenshot-1", "late-status-2", "late-screenshot-2",
            "predeadline-screenshot"
        ]);
        assert.deepEqual(writes[8], {
            execute: "screendump",
            arguments: {filename: PREDEADLINE_PATH, format: "png"},
            id: "predeadline-screenshot"
        });

        assert.deepEqual(predeadlineObservation, {
            status: "captured",
            offsetMs: 1_480_000,
            screenshotPath: PREDEADLINE_PATH
        });
    });

    it("preserves already captured 120/300s observations when guest exits before predeadline", async () => {
        let sessionControl = null;
        let predeadlineObservation = null;
        let lateObservationPromise = null;
        let resolvePredeadline;
        const predeadlinePromise = new Promise(resolve => { resolvePredeadline = resolve; });

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
            writeBytes: () => undefined,
            screenshotPaths: SCREENSHOTS,
            lateScreenshotPaths: LATE_SCREENSHOTS,
            predeadline: {screenshotPath: PREDEADLINE_PATH, executionDeadline: 1_500_000},
            onPredeadlineObservation: obs => {
                predeadlineObservation = obs;
                resolvePredeadline(obs);
            },
            onLateObservation: promise => { lateObservationPromise = promise; },
            onSession: control => { sessionControl = control; }
        }, {
            wait: async () => undefined,
            now: () => 300_000
        });

        assert.equal(result.running, true);
        assert.ok(sessionControl !== null);
        assert.ok(lateObservationPromise !== null);

        // Late boot observation settled at T+300s with 2 milestones
        const lateResult = await lateObservationPromise;
        assert.ok(lateResult !== null);
        assert.equal(lateResult.milestones.length, 2);

        // Guest exits at 600s, triggering cancel
        sessionControl.cancel();

        // Predeadline observation settles as skipped without invalidating lateResult
        await predeadlinePromise;
        assert.deepEqual(predeadlineObservation, {
            status: "skipped",
            reason: "guest-already-exited"
        });
        assert.equal(lateResult.milestones.length, 2);
    });

    it("safely skips capture if executionDeadline leaves insufficient time", async () => {
        let simulatedTime = 0;
        let predeadlineObservation = null;
        let lateObservationPromise = null;
        let resolvePredeadline;
        const predeadlinePromise = new Promise(resolve => { resolvePredeadline = resolve; });
        const writes = [];

        // Short deadline of 310s (target offset = 310s - 20s = 290s <= 300s)
        const executionDeadline = 310_000;

        await runEarlyBootQmpSession({
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
            predeadline: {screenshotPath: PREDEADLINE_PATH, executionDeadline},
            onPredeadlineObservation: obs => {
                predeadlineObservation = obs;
                resolvePredeadline(obs);
            },
            onLateObservation: promise => { lateObservationPromise = promise; }
        }, {
            wait: async ms => { simulatedTime += ms; },
            now: () => simulatedTime
        });

        assert.ok(lateObservationPromise !== null);
        await lateObservationPromise;
        await predeadlinePromise;

        assert.deepEqual(predeadlineObservation, {
            status: "skipped",
            reason: "insufficient-time"
        });
        // No predeadline screendump written
        assert.ok(!writes.some(w => w.id === "predeadline-screenshot"));
    });

    it("safely skips capture if wakeup delay leaves insufficient cleanup headroom", async () => {
        let simulatedTime = 0;
        let predeadlineObservation = null;
        let resolvePredeadline;
        const predeadlinePromise = new Promise(resolve => { resolvePredeadline = resolve; });
        const writes = [];

        // Execution deadline is 1,500,000. Target offset is 1,480,000.
        // Simulated event loop stall: wakeup occurs at 1,497,000 (remaining = 3,000 <= 5,000 headroom)
        const executionDeadline = 1_500_000;

        await runEarlyBootQmpSession({
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
            predeadline: {screenshotPath: PREDEADLINE_PATH, executionDeadline},
            onPredeadlineObservation: obs => {
                predeadlineObservation = obs;
                resolvePredeadline(obs);
            }
        }, {
            wait: async ms => {
                if (ms > 500_000) simulatedTime = 1_497_000;
                else simulatedTime += ms;
            },
            now: () => simulatedTime
        });

        await predeadlinePromise;
        assert.deepEqual(predeadlineObservation, {
            status: "skipped",
            reason: "insufficient-time"
        });
        assert.ok(!writes.some(w => w.id === "predeadline-screenshot"));
    });

    it("records actual observed offset rather than planned target", async () => {
        let simulatedTime = 0;
        let predeadlineObservation = null;
        let resolvePredeadline;
        const predeadlinePromise = new Promise(resolve => { resolvePredeadline = resolve; });

        await runEarlyBootQmpSession({
            readable: stream([
                {QMP: {version: {qemu: {major: 10, minor: 1, micro: 2}, package: ""}, capabilities: []}},
                {return: {}, id: "capabilities"},
                {return: {running: true, status: "running"}, id: "status"},
                {return: {}, id: "screenshot-1"},
                {return: {}, id: "screenshot-2"},
                {return: {running: true, status: "running"}, id: "late-status-1"},
                {return: {}, id: "late-screenshot-1"},
                {return: {running: true, status: "running"}, id: "late-status-2"},
                {return: {}, id: "late-screenshot-2"},
                {return: {}, id: "predeadline-screenshot"}
            ]),
            writeBytes: () => {
                // Command processing takes 1,500 ms
                simulatedTime += 1_500;
            },
            screenshotPaths: SCREENSHOTS,
            lateScreenshotPaths: LATE_SCREENSHOTS,
            predeadline: {screenshotPath: PREDEADLINE_PATH, executionDeadline: 1_500_000},
            onPredeadlineObservation: obs => {
                predeadlineObservation = obs;
                resolvePredeadline(obs);
            }
        }, {
            wait: async ms => { simulatedTime += ms; },
            now: () => simulatedTime
        });

        await predeadlinePromise;
        assert.equal(predeadlineObservation.status, "captured");
        // Observed offset is 1,481,500 (1,480,000 scheduled + 1,500 elapsed during command)
        assert.equal(predeadlineObservation.offsetMs, 1_481_500);
    });

    it("safely skips capture if session is cancelled before target offset", async () => {
        let sessionControl = null;
        let predeadlineObservation = null;
        let timerCleared = false;

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
            writeBytes: () => undefined,
            screenshotPaths: SCREENSHOTS,
            lateScreenshotPaths: LATE_SCREENSHOTS,
            predeadline: {screenshotPath: PREDEADLINE_PATH, executionDeadline: 1_500_000},
            onPredeadlineObservation: obs => { predeadlineObservation = obs; },
            onSession: control => { sessionControl = control; }
        }, {
            wait: async () => undefined,
            setTimer: () => 123,
            clearTimer: id => { if (id === 123) timerCleared = true; },
            now: () => 300_000
        });

        assert.equal(result.running, true);
        assert.ok(sessionControl !== null);

        // Guest exits at 600s, triggering cancel
        sessionControl.cancel();
        assert.equal(timerCleared, true);

        // Wait a microtick for the cancelled delay promise to settle
        await Promise.resolve();
        assert.deepEqual(predeadlineObservation, {
            status: "skipped",
            reason: "guest-already-exited"
        });
    });

    it("handles screendump fallback command failure gracefully and records offsetMs", async () => {
        let simulatedTime = 0;
        let predeadlineObservation = null;
        let lateObservationPromise = null;
        let resolvePredeadline;
        const predeadlinePromise = new Promise(resolve => { resolvePredeadline = resolve; });

        await runEarlyBootQmpSession({
            readable: stream([
                {QMP: {version: {qemu: {major: 10, minor: 1, micro: 2}, package: ""}, capabilities: []}},
                {return: {}, id: "capabilities"},
                {return: {running: true, status: "running"}, id: "status"},
                {return: {}, id: "screenshot-1"},
                {return: {}, id: "screenshot-2"},
                {return: {running: true, status: "running"}, id: "late-status-1"},
                {return: {}, id: "late-screenshot-1"},
                {return: {running: true, status: "running"}, id: "late-status-2"},
                {return: {}, id: "late-screenshot-2"},
                // Unexpected response format without return or error
                {id: "predeadline-screenshot"}
            ]),
            writeBytes: () => undefined,
            screenshotPaths: SCREENSHOTS,
            lateScreenshotPaths: LATE_SCREENSHOTS,
            predeadline: {screenshotPath: PREDEADLINE_PATH, executionDeadline: 1_500_000},
            onPredeadlineObservation: obs => {
                predeadlineObservation = obs;
                resolvePredeadline(obs);
            },
            onLateObservation: promise => { lateObservationPromise = promise; }
        }, {
            wait: async ms => { simulatedTime += ms; },
            now: () => simulatedTime
        });

        assert.ok(lateObservationPromise !== null);
        const lateResult = await lateObservationPromise;
        assert.equal(lateResult.milestones.length, 2);
        await predeadlinePromise;

        assert.deepEqual(predeadlineObservation, {
            status: "unavailable",
            reason: "command-failed",
            offsetMs: 1_480_000
        });
    });

    it("distinguishes qmp-error-response when screendump returns explicit QMP error and records offsetMs", async () => {
        let simulatedTime = 0;
        let predeadlineObservation = null;
        let lateObservationPromise = null;
        let resolvePredeadline;
        const predeadlinePromise = new Promise(resolve => { resolvePredeadline = resolve; });

        await runEarlyBootQmpSession({
            readable: stream([
                {QMP: {version: {qemu: {major: 10, minor: 1, micro: 2}, package: ""}, capabilities: []}},
                {return: {}, id: "capabilities"},
                {return: {running: true, status: "running"}, id: "status"},
                {return: {}, id: "screenshot-1"},
                {return: {}, id: "screenshot-2"},
                {return: {running: true, status: "running"}, id: "late-status-1"},
                {return: {}, id: "late-screenshot-1"},
                {return: {running: true, status: "running"}, id: "late-status-2"},
                {return: {}, id: "late-screenshot-2"},
                {error: {class: "GenericError", desc: "Device not found"}, id: "predeadline-screenshot"}
            ]),
            writeBytes: () => undefined,
            screenshotPaths: SCREENSHOTS,
            lateScreenshotPaths: LATE_SCREENSHOTS,
            predeadline: {screenshotPath: PREDEADLINE_PATH, executionDeadline: 1_500_000},
            onPredeadlineObservation: obs => {
                predeadlineObservation = obs;
                resolvePredeadline(obs);
            },
            onLateObservation: promise => { lateObservationPromise = promise; }
        }, {
            wait: async ms => { simulatedTime += ms; },
            now: () => simulatedTime
        });

        assert.ok(lateObservationPromise !== null);
        const lateResult = await lateObservationPromise;
        assert.equal(lateResult.milestones.length, 2);
        await predeadlinePromise;

        assert.deepEqual(predeadlineObservation, {
            status: "unavailable",
            reason: "qmp-error-response",
            offsetMs: 1_480_000
        });
    });

    it("distinguishes qmp-id-mismatch when screendump returns unexpected response ID and records offsetMs", async () => {
        let simulatedTime = 0;
        let predeadlineObservation = null;
        let lateObservationPromise = null;
        let resolvePredeadline;
        const predeadlinePromise = new Promise(resolve => { resolvePredeadline = resolve; });

        await runEarlyBootQmpSession({
            readable: stream([
                {QMP: {version: {qemu: {major: 10, minor: 1, micro: 2}, package: ""}, capabilities: []}},
                {return: {}, id: "capabilities"},
                {return: {running: true, status: "running"}, id: "status"},
                {return: {}, id: "screenshot-1"},
                {return: {}, id: "screenshot-2"},
                {return: {running: true, status: "running"}, id: "late-status-1"},
                {return: {}, id: "late-screenshot-1"},
                {return: {running: true, status: "running"}, id: "late-status-2"},
                {return: {}, id: "late-screenshot-2"},
                {return: {}, id: "unmatched-id"}
            ]),
            writeBytes: () => undefined,
            screenshotPaths: SCREENSHOTS,
            lateScreenshotPaths: LATE_SCREENSHOTS,
            predeadline: {screenshotPath: PREDEADLINE_PATH, executionDeadline: 1_500_000},
            onPredeadlineObservation: obs => {
                predeadlineObservation = obs;
                resolvePredeadline(obs);
            },
            onLateObservation: promise => { lateObservationPromise = promise; }
        }, {
            wait: async ms => { simulatedTime += ms; },
            now: () => simulatedTime
        });

        assert.ok(lateObservationPromise !== null);
        const lateResult = await lateObservationPromise;
        assert.equal(lateResult.milestones.length, 2);
        await predeadlinePromise;

        assert.deepEqual(predeadlineObservation, {
            status: "unavailable",
            reason: "qmp-id-mismatch",
            offsetMs: 1_480_000
        });
    });

    it("distinguishes qmp-stream-ended when readable stream ends before screendump response and records offsetMs", async () => {
        let simulatedTime = 0;
        let predeadlineObservation = null;
        let lateObservationPromise = null;
        let resolvePredeadline;
        const predeadlinePromise = new Promise(resolve => { resolvePredeadline = resolve; });

        // Stream ends after late milestones without responding to predeadline screenshot
        await runEarlyBootQmpSession({
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
            writeBytes: () => undefined,
            screenshotPaths: SCREENSHOTS,
            lateScreenshotPaths: LATE_SCREENSHOTS,
            predeadline: {screenshotPath: PREDEADLINE_PATH, executionDeadline: 1_500_000},
            onPredeadlineObservation: obs => {
                predeadlineObservation = obs;
                resolvePredeadline(obs);
            },
            onLateObservation: promise => { lateObservationPromise = promise; }
        }, {
            wait: async ms => { simulatedTime += ms; },
            now: () => simulatedTime
        });

        assert.ok(lateObservationPromise !== null);
        const lateResult = await lateObservationPromise;
        assert.equal(lateResult.milestones.length, 2);
        await predeadlinePromise;

        assert.deepEqual(predeadlineObservation, {
            status: "unavailable",
            reason: "qmp-stream-ended",
            offsetMs: 1_480_000
        });
    });

    it("distinguishes qmp-write-failed when write fails during screendump and records offsetMs", async () => {
        let simulatedTime = 0;
        let predeadlineObservation = null;
        let lateObservationPromise = null;
        let resolvePredeadline;
        const predeadlinePromise = new Promise(resolve => { resolvePredeadline = resolve; });

        await runEarlyBootQmpSession({
            readable: stream([
                {QMP: {version: {qemu: {major: 10, minor: 1, micro: 2}, package: ""}, capabilities: []}},
                {return: {}, id: "capabilities"},
                {return: {running: true, status: "running"}, id: "status"},
                {return: {}, id: "screenshot-1"},
                {return: {}, id: "screenshot-2"},
                {return: {running: true, status: "running"}, id: "late-status-1"},
                {return: {}, id: "late-screenshot-1"},
                {return: {running: true, status: "running"}, id: "late-status-2"},
                {return: {}, id: "late-screenshot-2"},
                {return: {}, id: "predeadline-screenshot"}
            ]),
            writeBytes: bytes => {
                const message = JSON.parse(bytes.toString("utf8"));
                if (message.id === "predeadline-screenshot") {
                    throw new Error("EPIPE: broken pipe");
                }
            },
            screenshotPaths: SCREENSHOTS,
            lateScreenshotPaths: LATE_SCREENSHOTS,
            predeadline: {screenshotPath: PREDEADLINE_PATH, executionDeadline: 1_500_000},
            onPredeadlineObservation: obs => {
                predeadlineObservation = obs;
                resolvePredeadline(obs);
            },
            onLateObservation: promise => { lateObservationPromise = promise; }
        }, {
            wait: async ms => { simulatedTime += ms; },
            now: () => simulatedTime
        });

        assert.ok(lateObservationPromise !== null);
        const lateResult = await lateObservationPromise;
        assert.equal(lateResult.milestones.length, 2);
        await predeadlinePromise;

        assert.deepEqual(predeadlineObservation, {
            status: "unavailable",
            reason: "qmp-write-failed",
            offsetMs: 1_480_000
        });
    });

    it("distinguishes command-timeout when screendump exceeds deadline and records offsetMs", async () => {
        let simulatedTime = 0;
        let predeadlineObservation = null;
        let lateObservationPromise = null;
        let resolvePredeadline;
        const predeadlinePromise = new Promise(resolve => { resolvePredeadline = resolve; });

        await runEarlyBootQmpSession({
            readable: (async function* () {
                const initial = [
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
                for (const item of initial) yield Buffer.from(`${JSON.stringify(item)}\n`);
                // Wait forever on predeadline response (triggering command timeout)
                await new Promise(() => {});
            })(),
            writeBytes: () => undefined,
            screenshotPaths: SCREENSHOTS,
            lateScreenshotPaths: LATE_SCREENSHOTS,
            predeadline: {screenshotPath: PREDEADLINE_PATH, executionDeadline: 1_500_000},
            onPredeadlineObservation: obs => {
                predeadlineObservation = obs;
                resolvePredeadline(obs);
            },
            onLateObservation: promise => { lateObservationPromise = promise; }
        }, {
            wait: async ms => { simulatedTime += ms; },
            setTimer: (callback, ms) => {
                // Advance simulated clock when deadline fires
                return setTimeout(() => {
                    simulatedTime += ms;
                    callback();
                }, 10);
            },
            clearTimer: id => clearTimeout(id),
            now: () => simulatedTime
        });

        assert.ok(lateObservationPromise !== null);
        const lateResult = await lateObservationPromise;
        assert.equal(lateResult.milestones.length, 2);
        await predeadlinePromise;

        assert.equal(predeadlineObservation.status, "unavailable");
        assert.equal(predeadlineObservation.reason, "command-timeout");
        assert.ok(Number.isSafeInteger(predeadlineObservation.offsetMs));
        assert.ok(predeadlineObservation.offsetMs >= 1_480_000);
    });

    it("handles asynchronous QMP events during long idle interval and captures screendump successfully", async () => {
        let simulatedTime = 0;
        let predeadlineObservation = null;
        let lateObservationPromise = null;
        let resolvePredeadline;
        const predeadlinePromise = new Promise(resolve => { resolvePredeadline = resolve; });
        const writes = [];

        await runEarlyBootQmpSession({
            readable: stream([
                {QMP: {version: {qemu: {major: 10, minor: 1, micro: 2}, package: ""}, capabilities: []}},
                {return: {}, id: "capabilities"},
                {return: {running: true, status: "running"}, id: "status"},
                {return: {}, id: "screenshot-1"},
                {return: {}, id: "screenshot-2"},
                {return: {running: true, status: "running"}, id: "late-status-1"},
                {return: {}, id: "late-screenshot-1"},
                {return: {running: true, status: "running"}, id: "late-status-2"},
                {return: {}, id: "late-screenshot-2"},
                // Asynchronous events during the ~20-minute gap
                {event: "RTC_CHANGE", data: {offset: 0}, timestamp: {seconds: 1726567200, microseconds: 0}},
                {event: "NIC_RX_FILTER_CHANGED", data: {name: "nic0"}, timestamp: {seconds: 1726567300, microseconds: 0}},
                {event: "SUSPEND_DISK", timestamp: {seconds: 1726567400, microseconds: 0}},
                {return: {}, id: "predeadline-screenshot"}
            ]),
            writeBytes: bytes => writes.push(JSON.parse(bytes.toString("utf8"))),
            screenshotPaths: SCREENSHOTS,
            lateScreenshotPaths: LATE_SCREENSHOTS,
            predeadline: {screenshotPath: PREDEADLINE_PATH, executionDeadline: 1_500_000},
            onPredeadlineObservation: obs => {
                predeadlineObservation = obs;
                resolvePredeadline(obs);
            },
            onLateObservation: promise => { lateObservationPromise = promise; }
        }, {
            wait: async ms => { simulatedTime += ms; },
            now: () => simulatedTime
        });

        assert.ok(lateObservationPromise !== null);
        const lateResult = await lateObservationPromise;
        assert.equal(lateResult.milestones.length, 2);
        await predeadlinePromise;

        assert.deepEqual(predeadlineObservation, {
            status: "captured",
            offsetMs: 1_480_000,
            screenshotPath: PREDEADLINE_PATH
        });
        assert.ok(writes.some(w => w.id === "predeadline-screenshot"));
    });
});

describe("Monitored QEMU watchdog & stalled screendump non-blocking", () => {
    const PROCESS_PID = 2300;
    const QEMU_PID = 2345;
    const EXECUTION_DEADLINE_MILLISECONDS = 1_500_000;
    const PROCESS_TIMEOUT_MILLISECONDS = 1_000;
    const MAX_STREAM_BYTES = 65_536;
    const INITIAL_QMP_MESSAGES = Object.freeze([
        {QMP: {version: {qemu: {major: 10, minor: 1, micro: 2}, package: ""}, capabilities: []}},
        {return: {}, id: "capabilities"},
        {return: {running: true, status: "running"}, id: "status"},
        {return: {}, id: "screenshot-1"},
        {return: {}, id: "screenshot-2"},
        {return: {running: true, status: "running"}, id: "late-status-1"},
        {return: {}, id: "late-screenshot-1"},
        {return: {running: true, status: "running"}, id: "late-status-2"},
        {return: {}, id: "late-screenshot-2"}
    ]);

    function createAdapterHarness(stallKind) {
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const child = new EventEmitter();
        let groupAlive = true;
        let terminated = false;
        let qmpTime = 0;
        let predeadlineWriteAttempts = 0;
        let predeadlineWriteCallbackCalls = 0;
        let predeadlineWriteCallbackCallsAtTermination = null;
        let pendingPredeadlineWriteCallback = null;
        const qmpWriteIds = [];
        let resolveInitialSession;
        let resolvePredeadlineWrite;
        const initialSession = new Promise(resolve => { resolveInitialSession = resolve; });
        const predeadlineWrite = new Promise(resolve => { resolvePredeadlineWrite = resolve; });
        let lateObservationPromise = null;
        child.pid = PROCESS_PID;
        child.stdout = stdout;
        child.stderr = stderr;
        child.unref = () => undefined;
        child.stdin = {
            destroyed: false,
            destroy() {
                this.destroyed = true;
                pendingPredeadlineWriteCallback?.(new Error("stdin closed during monitor cleanup"));
            },
            write(bytes, callback) {
                const message = JSON.parse(Buffer.from(bytes).toString("utf8"));
                qmpWriteIds.push(message.id);
                if (message.id === "screenshot-2") resolveInitialSession();
                if (message.id !== "predeadline-screenshot") return callback();
                predeadlineWriteAttempts += 1;
                resolvePredeadlineWrite();
                if (stallKind === "response") {
                    predeadlineWriteCallbackCalls += 1;
                    callback();
                } else pendingPredeadlineWriteCallback = () => {
                    predeadlineWriteCallbackCalls += 1;
                    callback(new Error("stdin closed during monitor cleanup"));
                };
            }
        };
        for (const message of INITIAL_QMP_MESSAGES) stdout.write(`${JSON.stringify(message)}\n`);

        const inertTimer = () => Object.freeze({});
        const qmpDependencies = {
            now: () => qmpTime,
            wait: async milliseconds => { qmpTime += milliseconds; }
        };
        const fakeIo = {
            runOwned: (command, argv, options) => runHostedOwnedProcess(command, argv, options, {
                spawnImpl: () => child,
                setTimer: inertTimer,
                clearTimer: () => undefined,
                isGroupAlive: () => groupAlive
            }),
            pathExists: () => true,
            readOwnedVerified: () => ({bytes: Buffer.from(`${QEMU_PID}\n`)}),
            readQemuProcessIdentity: async () => {
                if (!terminated) await initialSession;
                return terminated ? {state: "absent"} : {
                    state: "present", pid: QEMU_PID, processGroupId: PROCESS_PID,
                    startTicks: "77", executablePath: "/owned/loader"
                };
            },
            observeRuntimeResources: async () => {
                await predeadlineWrite;
                await lateObservationPromise;
                return {taskBytes: "1", freeBytes: "90000000000", effectiveMemoryBytes: "4294967295"};
            },
            monotonicMilliseconds: () => predeadlineWriteAttempts > 0 ?
                EXECUTION_DEADLINE_MILLISECONDS + 1 : 0,
            wait: async () => undefined,
            isProcessGroupAlive: () => groupAlive,
            terminateQemuGroup: async () => {
                terminated = true;
                groupAlive = false;
                predeadlineWriteCallbackCallsAtTermination = predeadlineWriteCallbackCalls;
                stdout.destroy(new Error("QEMU process group stopped"));
                child.emit("close", 137, null);
                return true;
            }
        };
        const request = {
            command: "/owned/qemu",
            argv: [],
            timeoutMs: PROCESS_TIMEOUT_MILLISECONDS,
            maxStreamBytes: MAX_STREAM_BYTES,
            pidPath: `${ROOT}/qemu.pid`,
            expectedExecutable: "/owned/loader",
            executionDeadline: EXECUTION_DEADLINE_MILLISECONDS,
            resources: {taskPath: ROOT, roots: [ROOT]},
            qmp: {
                screenshotPaths: SCREENSHOTS,
                lateScreenshotPaths: LATE_SCREENSHOTS,
                predeadline: {screenshotPath: PREDEADLINE_PATH, executionDeadline: EXECUTION_DEADLINE_MILLISECONDS}
            },
            qmpDependencies,
            onLateObservation: promise => { lateObservationPromise = promise; }
        };
        return {fakeIo, request, predeadlineWriteAttempts: () => predeadlineWriteAttempts,
            predeadlineWriteCallbackCallsAtTermination: () => predeadlineWriteCallbackCallsAtTermination, qmpWriteIds};
    }

    for (const [stallKind, expectedCallback] of [["write", false], ["response", true]]) {
        it(`terminates through the real hosted QMP adapter when the predeadline ${stallKind} stalls`, async () => {
            const harness = createAdapterHarness(stallKind);
            const result = await runMonitoredQemu(harness.fakeIo, harness.request);

            assert.equal(harness.predeadlineWriteAttempts(), 1);
            assert.ok(harness.qmpWriteIds.includes("predeadline-screenshot"));
            assert.equal(harness.predeadlineWriteCallbackCallsAtTermination(), expectedCallback ? 1 : 0);
            assert.equal(result.terminationReason, "deadline");
            assert.equal(result.processGroupGone, true);
            assert.equal(result.absentAfter, true);
            assert.equal(expectedCallback, stallKind === "response");
            assert.equal(result.lateBoot?.milestones.length, 2);
        });
    }
});

describe("Hosted launcher end-to-end propagation & unified clock", () => {
    const rootFileIdentity = target => ({path: target, bytes: "100", sha256: "0".repeat(64),
        ownership: {uid: "0", gid: "0", mode: "755", ordinaryUserWritable: false}});
    const commandIdentity = target => ({path: target, invocationPath: target, bytes: "100", sha256: "0".repeat(64),
        ownership: {uid: "0", gid: "0", mode: "755", ordinaryUserWritable: false}});
    const directoryIdentity = target => ({path: target, dev: "1", ino: target === "/tmp" ? "1" : "2", uid: "0",
        gid: "0", mode: target === "/tmp" ? "1777" : "755", ordinaryUserWritable: target === "/tmp",
        sticky: target === "/tmp"});

    const contextObj = {
        schemaVersion: 1, repository: "i7Gamer/MySpeed", sourceSha: "a".repeat(40), eventSha: "b".repeat(40),
        runId: "123", runAttempt: "1", nonce: NONCE, environment: {GITHUB_ACTIONS: "true", CI: "true",
            RUNNER_OS: "Linux", RUNNER_ARCH: "X64", RUNNER_ENVIRONMENT: "github-hosted", ImageOS: "ubuntu24",
            ImageVersion: "20260907.1"}
    };

    const toolchainObj = {
        runtime: {loader: rootFileIdentity("/tmp/tools/ld.so"), libraryPath: ["/tmp/tools"]},
        qemu: commandIdentity("/tmp/tools/qemu-system-x86_64"),
        firmware: {
            searchPath: "/tmp/tools",
            kvmvapic: rootFileIdentity("/tmp/tools/kvmvapic.bin"),
            vga: rootFileIdentity("/tmp/tools/vgabios-stdvga.bin")
        },
        ovmfVarsTemplate: rootFileIdentity("/tmp/tools/OVMF_VARS.fd")
    };

    const pathsObj = {
        root: ROOT, packageRoot: `${ROOT}/packages`, portableRoot: `/tmp/tools`,
        qemuPid: `${ROOT}/qemu.pid`, outputDisk: `${ROOT}/output.img`, serialLog: `${ROOT}/serial.log`,
        systemDisk: `${ROOT}/system.qcow2`, ovmfVars: `${ROOT}/OVMF_VARS.fd`
    };

    it("propagates predeadline observation end-to-end through createHostedStage2Operations failure diagnostic", async () => {
        const fakeIo = {
            inspectOwned: rootFileIdentity,
            inspectDirectory: directoryIdentity,
            monotonicMilliseconds: () => 1_000,
            pathExists: target => target === PREDEADLINE_PATH,
            validateOutputDisk: () => ({dev: "1", ino: "2", uid: 0n, gid: 0n, size: 67108864n, mode: "600"}),
            readOwnedVerified: target => {
                if (target === PREDEADLINE_PATH) {
                    return {
                        identity: {path: PREDEADLINE_PATH, bytes: String(DUMMY_PNG.length), sha256: sha256(DUMMY_PNG)},
                        bytes: DUMMY_PNG
                    };
                }
                return {
                    identity: {path: target, bytes: "10", sha256: sha256(Buffer.from("0123456789"))},
                    bytes: Buffer.from("0123456789")
                };
            },
            runMonitoredQemu: async () => {
                return {
                    observation: {
                        process: {exitCode: 1, signal: null, timedOut: true, cleanupProven: true,
                            stdoutOverflow: false, stderrOverflow: false, errorObserved: false},
                        stdout: Buffer.alloc(0),
                        stderr: Buffer.alloc(0)
                    },
                    identity: {pid: 12345, startTicks: "100", executablePath: "/tmp/tools/ld.so", processGroupId: 12345},
                    absentAfter: true,
                    processGroupGone: true,
                    terminationReason: "deadline",
                    qmpShutdownEvent: {schemaVersion: 1, status: "captured", guest: true,
                        reason: "guest-shutdown", offsetMs: 900_000},
                    predeadline: {
                        status: "captured",
                        offsetMs: 1_480_000,
                        screenshotPath: PREDEADLINE_PATH
                    }
                };
            }
        };

        const ops = createHostedStage2Operations({context: contextObj, paths: pathsObj, dependencies: fakeIo});
        const launched = await ops.launchOwnedQemu({
            toolchain: toolchainObj,
            paths: pathsObj,
            argv: ["-m", "4G"],
            privilegeMode: "ordinary-kvm",
            midWindowFrames: true
        });

        // Verify end-to-end propagation: launched.failureDiagnostic.predeadlineFrame is populated!
        assert.ok(launched.failureDiagnostic);
        assert.ok(launched.failureDiagnostic.predeadlineFrame);
        assert.equal(launched.failureDiagnostic.predeadlineFrame.status, "captured");
        assert.equal(launched.failureDiagnostic.predeadlineFrame.offsetMs, 1_480_000);
        assert.equal(launched.failureDiagnostic.predeadlineFrame.screenshot.path, PREDEADLINE_PATH);
        assert.deepEqual(launched.failureDiagnostic.qmpShutdownEvent, {schemaVersion: 1, status: "captured",
            guest: true, reason: "guest-shutdown", offsetMs: 900_000});
    });

    it("unifies host monotonic clock authority with QMP dependencies through real adapter path", async () => {
        let capturedQmpDeps = null;
        let capturedExecutionDeadline = null;

        const largeHostClockOffset = 100_000_000;
        const fakeIo = {
            inspectOwned: rootFileIdentity,
            inspectDirectory: directoryIdentity,
            monotonicMilliseconds: () => largeHostClockOffset,
            pathExists: () => false,
            validateOutputDisk: () => null,
            runMonitoredQemu: async req => {
                capturedQmpDeps = req.qmpDependencies;
                capturedExecutionDeadline = req.executionDeadline;
                return {
                    observation: {
                        process: {exitCode: 0, signal: null, timedOut: false, cleanupProven: true,
                            stdoutOverflow: false, stderrOverflow: false, errorObserved: false},
                        stdout: Buffer.alloc(0),
                        stderr: Buffer.alloc(0)
                    },
                    identity: {pid: 12345, startTicks: "100", executablePath: "/tmp/tools/ld.so", processGroupId: 12345},
                    absentAfter: true,
                    processGroupGone: true,
                    terminationReason: null
                };
            }
        };

        const ops = createHostedStage2Operations({context: contextObj, paths: pathsObj, dependencies: fakeIo});
        await ops.launchOwnedQemu({
            toolchain: toolchainObj,
            paths: pathsObj,
            argv: ["-m", "4G"],
            privilegeMode: "ordinary-kvm",
            deadlines: {executionMinutes: 25, cleanupMinutes: 5}
        });

        // Verify executionDeadline was computed from host clock (100_000_000 + 1500s * 1000 = 101_500_000)
        assert.equal(capturedExecutionDeadline, largeHostClockOffset + 1_500_000);

        // Verify qmpDependencies receives the SAME host clock authority
        assert.ok(capturedQmpDeps);
        assert.equal(typeof capturedQmpDeps.now, "function");
        assert.equal(capturedQmpDeps.now(), largeHostClockOffset);
    });
});

describe("Post-cleanup collection & verification", () => {
    it("refuses collection when cleanup is unproven", () => {
        const diag = collectPredeadlineFrameDiagnostic({}, {paths: {root: ROOT}}, {
            status: "captured", offsetMs: 1_480_000, screenshotPath: PREDEADLINE_PATH
        }, false);
        assert.deepEqual(diag, {
            schemaVersion: 1,
            status: "unavailable",
            reason: "cleanup-unproven"
        });
    });

    it("propagates skipped observation", () => {
        const diag = collectPredeadlineFrameDiagnostic({}, {paths: {root: ROOT}}, {
            status: "skipped", reason: "insufficient-time"
        }, true);
        assert.deepEqual(diag, {
            schemaVersion: 1,
            status: "skipped",
            reason: "insufficient-time"
        });
    });

    it("refuses path outside task root and reports malformed without reading disk", () => {
        const outsidePath = "/home/runner/work/_temp/myspeed-windows-cpu-floor-other/predeadline-frame.png";
        let readAttempted = false;
        const io = {
            pathExists: () => { readAttempted = true; return true; },
            readOwnedVerified: () => { readAttempted = true; return null; }
        };
        const diag = collectPredeadlineFrameDiagnostic(io, {paths: {root: ROOT}}, {
            status: "captured", offsetMs: 1_480_000, screenshotPath: outsidePath
        }, true);
        assert.equal(readAttempted, false);
        assert.equal(diag.status, "malformed");
        assert.equal(diag.reason, "path-mismatch");
    });

    it("guards against exceptions thrown by io.pathExists or io.readOwnedVerified", () => {
        const throwingIo = {
            pathExists: () => { throw new Error("EACCES: permission denied"); }
        };
        const diag = collectPredeadlineFrameDiagnostic(throwingIo, {paths: {root: ROOT}}, {
            status: "captured", offsetMs: 1_480_000, screenshotPath: PREDEADLINE_PATH
        }, true);
        assert.equal(diag.status, "unavailable");
        assert.equal(diag.reason, "read-error");

        const throwingReadIo = {
            pathExists: () => true,
            readOwnedVerified: () => { throw new Error("EIO: i/o error"); }
        };
        const diagRead = collectPredeadlineFrameDiagnostic(throwingReadIo, {paths: {root: ROOT}}, {
            status: "captured", offsetMs: 1_480_000, screenshotPath: PREDEADLINE_PATH
        }, true);
        assert.equal(diagRead.status, "unavailable");
        assert.equal(diagRead.reason, "read-error");
    });

    it("reports unavailable when file is missing from disk", () => {
        const io = {
            pathExists: () => false
        };
        const diag = collectPredeadlineFrameDiagnostic(io, {paths: {root: ROOT}}, {
            status: "captured", offsetMs: 1_480_000, screenshotPath: PREDEADLINE_PATH
        }, true);
        assert.deepEqual(diag, {
            schemaVersion: 1,
            status: "unavailable",
            reason: "file-missing"
        });
    });

    it("reports malformed on invalid PNG signature", () => {
        const badBytes = Buffer.from("NOT_A_PNG_FILE");
        const io = {
            pathExists: () => true,
            readOwnedVerified: () => ({
                identity: {path: PREDEADLINE_PATH, bytes: String(badBytes.length), sha256: sha256(badBytes)},
                bytes: badBytes
            })
        };
        const diag = collectPredeadlineFrameDiagnostic(io, {paths: {root: ROOT}}, {
            status: "captured", offsetMs: 1_480_000, screenshotPath: PREDEADLINE_PATH
        }, true);
        assert.equal(diag.status, "malformed");
        assert.equal(diag.reason, "invalid-png-signature");
        assert.equal(diag.bytes, String(badBytes.length));
        assert.equal(diag.sha256, sha256(badBytes));
    });

    it("reports malformed on sha256 mismatch", () => {
        const io = {
            pathExists: () => true,
            readOwnedVerified: () => ({
                identity: {path: PREDEADLINE_PATH, bytes: String(DUMMY_PNG.length), sha256: "0".repeat(64)},
                bytes: DUMMY_PNG
            })
        };
        const diag = collectPredeadlineFrameDiagnostic(io, {paths: {root: ROOT}}, {
            status: "captured", offsetMs: 1_480_000, screenshotPath: PREDEADLINE_PATH
        }, true);
        assert.equal(diag.status, "malformed");
        assert.equal(diag.reason, "hash-mismatch");
    });

    it("collects valid captured frame and matches expected schema", () => {
        const io = {
            pathExists: () => true,
            readOwnedVerified: () => ({
                identity: {path: PREDEADLINE_PATH, bytes: String(DUMMY_PNG.length), sha256: sha256(DUMMY_PNG)},
                bytes: DUMMY_PNG
            })
        };
        const diag = collectPredeadlineFrameDiagnostic(io, {paths: {root: ROOT}}, {
            status: "captured", offsetMs: 1_480_000, screenshotPath: PREDEADLINE_PATH
        }, true);
        assert.deepEqual(diag, {
            schemaVersion: 1,
            status: "captured",
            offsetMs: 1_480_000,
            screenshot: {
                path: PREDEADLINE_PATH,
                bytes: String(DUMMY_PNG.length),
                sha256: sha256(DUMMY_PNG),
                bytesBase64: DUMMY_PNG.toString("base64")
            }
        });
    });

    it("preserves optional offsetMs when collecting unavailable diagnostic", () => {
        const diagWith = collectPredeadlineFrameDiagnostic({}, {paths: {root: ROOT}}, {
            status: "unavailable", reason: "qmp-error-response", offsetMs: 1_480_000
        }, true);
        assert.deepEqual(diagWith, {
            schemaVersion: 1,
            status: "unavailable",
            reason: "qmp-error-response",
            offsetMs: 1_480_000
        });

        const diagWithout = collectPredeadlineFrameDiagnostic({}, {paths: {root: ROOT}}, {
            status: "unavailable", reason: "command-timeout"
        }, true);
        assert.deepEqual(diagWithout, {
            schemaVersion: 1,
            status: "unavailable",
            reason: "command-timeout"
        });
    });
});
