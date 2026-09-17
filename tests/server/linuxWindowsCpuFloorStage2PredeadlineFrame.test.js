import assert from "node:assert/strict";
import crypto from "node:crypto";
import {describe, it} from "node:test";

import {
    runEarlyBootQmpSession,
    validatePredeadlineScreenshotPath,
    PREDEADLINE_FRAME_LEAD_MILLISECONDS,
    PREDEADLINE_FRAME_COMMAND_TIMEOUT_MILLISECONDS,
    PREDEADLINE_FRAME_TICK_JITTER_MILLISECONDS,
    PREDEADLINE_FRAME_CLEANUP_HEADROOM_MILLISECONDS
} from "../../scripts/qualification/linux-windows-cpu-floor-stage2-qmp.mjs";
import {
    validatePredeadlineFrameDiagnostic,
    validateQemuLaunchDiagnostic,
    PREDEADLINE_FRAME_STATUSES,
    PREDEADLINE_FRAME_SKIPPED_REASONS,
    PREDEADLINE_FRAME_UNAVAILABLE_REASONS,
    PREDEADLINE_FRAME_MALFORMED_REASONS,
    MAX_PREDEADLINE_FRAME_BYTES
} from "../../scripts/qualification/linux-windows-cpu-floor-stage2.mjs";
import {
    collectPredeadlineFrameDiagnostic
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

    it("accepts all valid unavailable reasons", () => {
        for (const reason of PREDEADLINE_FRAME_UNAVAILABLE_REASONS) {
            const diag = {schemaVersion: 1, status: "unavailable", reason};
            const validated = validatePredeadlineFrameDiagnostic(diag);
            assert.deepEqual(validated, diag);
        }
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
    it("schedules screendump at executionDeadline minus lead milliseconds", async () => {
        let simulatedTime = 0;
        const delays = [];
        const writes = [];
        let predeadlineObservation = null;
        let lateObservationPromise = null;

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
            onPredeadlineObservation: obs => { predeadlineObservation = obs; },
            onLateObservation: promise => { lateObservationPromise = promise; }
        }, {
            wait: fakeWait,
            now: () => simulatedTime
        });

        assert.equal(result.running, true);
        assert.ok(lateObservationPromise !== null);
        await lateObservationPromise;

        // Early boot completed at 35s (5s + 30s)
        // Late milestone 1 at 120s (waited 85s)
        // Late milestone 2 at 300s (waited 180s)
        // Predeadline target at 1480s (waited 1480s - 300s = 1180s = 1,180,000 ms)
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

    it("safely skips capture if executionDeadline leaves insufficient time", async () => {
        let simulatedTime = 0;
        let predeadlineObservation = null;
        let lateObservationPromise = null;
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
            onPredeadlineObservation: obs => { predeadlineObservation = obs; },
            onLateObservation: promise => { lateObservationPromise = promise; }
        }, {
            wait: async ms => { simulatedTime += ms; },
            now: () => simulatedTime
        });

        assert.ok(lateObservationPromise !== null);
        await lateObservationPromise;

        assert.deepEqual(predeadlineObservation, {
            status: "skipped",
            reason: "insufficient-time"
        });
        // No predeadline screendump written
        assert.ok(!writes.some(w => w.id === "predeadline-screenshot"));
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

    it("handles screendump command failure or timeout gracefully without crashing", async () => {
        let simulatedTime = 0;
        let predeadlineObservation = null;
        let lateObservationPromise = null;

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
                // QMP screendump error
                {error: {class: "GenericError", desc: "Device not found"}, id: "predeadline-screenshot"}
            ]),
            writeBytes: () => undefined,
            screenshotPaths: SCREENSHOTS,
            lateScreenshotPaths: LATE_SCREENSHOTS,
            predeadline: {screenshotPath: PREDEADLINE_PATH, executionDeadline: 1_500_000},
            onPredeadlineObservation: obs => { predeadlineObservation = obs; },
            onLateObservation: promise => { lateObservationPromise = promise; }
        }, {
            wait: async ms => { simulatedTime += ms; },
            now: () => simulatedTime
        });

        assert.ok(lateObservationPromise !== null);
        await lateObservationPromise;

        assert.deepEqual(predeadlineObservation, {
            status: "unavailable",
            reason: "command-failed"
        });
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
});
