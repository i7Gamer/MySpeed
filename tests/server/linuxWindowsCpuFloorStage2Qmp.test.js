import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";

import {
    INSTALLER_BOOT_CONFIRMATION,
    INSTALLER_BOOT_CONFIRMATION_AFTER_FIRST_FRAME,
    INSTALLER_BOOT_CONFIRMATION_AFTER_FIRST_FRAME_LATEST_OFFSET_MILLISECONDS,
    INSTALLER_BOOT_CONFIRMATION_AFTER_FIRST_FRAME_REQUESTED_OFFSET_MILLISECONDS,
    INSTALLER_BOOT_CONFIRMATION_CADENCE,
    INSTALLER_BOOT_CONFIRMATION_CADENCE_LATEST_OFFSET_MILLISECONDS,
    INSTALLER_BOOT_CONFIRMATION_CADENCE_OFFSETS_MILLISECONDS,
    INSTALLER_BOOT_CONFIRMATION_CADENCE_SLACK_MILLISECONDS,
    INSTALLER_BOOT_CONFIRMATION_HOLD_MILLISECONDS,
    INSTALLER_BOOT_CONFIRMATION_LATEST_OFFSET_MILLISECONDS,
    INSTALLER_BOOT_CONFIRMATION_QCODE,
    INSTALLER_BOOT_CONFIRMATION_REQUESTED_OFFSET_MILLISECONDS,
    LATE_BOOT_MILESTONE_OFFSETS_MILLISECONDS,
    MAX_LATE_BOOT_MILESTONES,
    runEarlyBootQmpSession,
    validateInstallerBootConfirmation,
    validateInstallerBootInput,
    validateLateScreenshots,
    validateScreenshots
} from "../../scripts/qualification/linux-windows-cpu-floor-stage2-qmp.mjs";
import {runHostedOwnedProcess, runMonitoredQemu} from
    "../../scripts/qualification/linux-windows-cpu-floor-stage2-hosted.mjs";
import {buildWindowsMsiContainmentPreflightRequest} from
    "../../scripts/qualification/windows-msi-containment-preflight.mjs";
import {windowsMsiContainmentPreflightPaths} from
    "../../scripts/qualification/windows-msi-containment-preflight-host.mjs";

const ROOT = "/home/runner/work/_temp/myspeed-windows-cpu-floor-0123456789abcdef0123456789abcdef";
const SCREENSHOTS = [`${ROOT}/early-boot-1.png`, `${ROOT}/early-boot-2.png`];
const LATE_SCREENSHOTS = [`${ROOT}/late-boot-1.png`, `${ROOT}/late-boot-2.png`];

const MSI_HOST_NONCE = "0123456789abcdef0123456789abcdef";
const MSI_ROW_NONCE = "fedcba9876543210fedcba9876543210";
const MSI_ROOT = `/home/runner/work/_temp/myspeed-windows-msi-${MSI_HOST_NONCE}`;
const PREFLIGHT_ROOT = windowsMsiContainmentPreflightPaths(
    buildWindowsMsiContainmentPreflightRequest({
        context: {nonce: MSI_HOST_NONCE, repository: "owner/name", sourceSha: "a".repeat(40),
            eventSha: "b".repeat(40), runId: "1", runAttempt: "1"},
        taskRoot: MSI_ROOT, guestSerial: "f".repeat(32),
        expected: {productCode: "{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}",
            msi: {source: "observed-preparation", path: "/observed/old.msi", bytes: "10",
                sha256: "1".repeat(64)},
            helper: {source: "sealed-closure",
                path: "scripts/qualification/windows-msi-guest-containment.ps1", bytes: "10",
                sha256: "2".repeat(64)}}})).root;

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

    it("sends exactly one acknowledged Enter within the bounded installer-confirmation window", async () => {
        const writes = [];
        let now = 0;
        const result = await runEarlyBootQmpSession({readable: stream([
            {QMP: {version: {qemu: {major: 10, minor: 1, micro: 2}, package: ""}, capabilities: []}},
            {return: {}, id: "capabilities"},
            {return: {running: true, status: "running"}, id: "status"},
            {return: {}, id: "installer-boot-confirmation"},
            {return: {}, id: "screenshot-1"}, {return: {}, id: "screenshot-2"}
        ]), writeBytes: bytes => writes.push({value: JSON.parse(bytes.toString("utf8")), time: now}), screenshotPaths: SCREENSHOTS,
        bootConfirmation: INSTALLER_BOOT_CONFIRMATION}, {
            now: () => now,
            wait: async milliseconds => { now += milliseconds; }
        });
        assert.equal(INSTALLER_BOOT_CONFIRMATION, "single-enter-before-setup-v1");
        assert.equal(INSTALLER_BOOT_CONFIRMATION_QCODE, "ret");
        assert.equal(INSTALLER_BOOT_CONFIRMATION_HOLD_MILLISECONDS, 100);
        assert.equal(INSTALLER_BOOT_CONFIRMATION_REQUESTED_OFFSET_MILLISECONDS, 2_000);
        assert.equal(INSTALLER_BOOT_CONFIRMATION_LATEST_OFFSET_MILLISECONDS, 3_000);
        assert.deepEqual(writes.map(({value}) => value.id), ["capabilities", "status", "installer-boot-confirmation",
            "screenshot-1", "screenshot-2"]);
        assert.deepEqual(writes[2].value, {execute: "send-key", arguments: {keys: [{type: "qcode", data: "ret"}],
            "hold-time": 100}, id: "installer-boot-confirmation"});
        assert.deepEqual(writes.slice(2).map(({time}) => time), [2_000, 5_000, 35_000]);
        assert.deepEqual(result.inputSent, {kind: "installer-boot-confirmation", qcode: "ret",
            holdMilliseconds: 100, requestedOffsetMilliseconds: 2_000, sentOffsetMilliseconds: 2_000,
            acknowledged: true});
    });

    it("sends v2 Enter exactly once only after the first screenshot acknowledgement", async () => {
        const writes = [];
        let now = 0;
        const result = await runEarlyBootQmpSession({readable: stream([
            {QMP: {version: {qemu: {major: 10, minor: 1, micro: 2}, package: ""}, capabilities: []}},
            {return: {}, id: "capabilities"}, {return: {running: true, status: "running"}, id: "status"},
            {return: {}, id: "screenshot-1"}, {return: {}, id: "installer-boot-confirmation"},
            {return: {}, id: "screenshot-2"}
        ]), writeBytes: bytes => writes.push({value: JSON.parse(bytes.toString("utf8")), time: now}),
        screenshotPaths: SCREENSHOTS, bootConfirmation: INSTALLER_BOOT_CONFIRMATION_AFTER_FIRST_FRAME}, {
            now: () => now, wait: async milliseconds => { now += milliseconds; }
        });
        assert.equal(INSTALLER_BOOT_CONFIRMATION_AFTER_FIRST_FRAME, "single-enter-after-first-frame-v2");
        assert.equal(INSTALLER_BOOT_CONFIRMATION_AFTER_FIRST_FRAME_REQUESTED_OFFSET_MILLISECONDS, 5_000);
        assert.equal(INSTALLER_BOOT_CONFIRMATION_AFTER_FIRST_FRAME_LATEST_OFFSET_MILLISECONDS, 6_000);
        assert.deepEqual(writes.map(({value}) => value.id), ["capabilities", "status", "screenshot-1",
            "installer-boot-confirmation", "screenshot-2"]);
        assert.deepEqual(writes.slice(2).map(({time}) => time), [5_000, 5_000, 35_000]);
        assert.deepEqual(writes[3].value, {execute: "send-key", arguments: {keys: [{type: "qcode", data: "ret"}],
            "hold-time": 100}, id: "installer-boot-confirmation"});
        assert.equal(writes.filter(({value}) => value.execute === "send-key").length, 1);
        assert.deepEqual(result.inputSent, {kind: "installer-boot-confirmation", qcode: "ret",
            holdMilliseconds: 100, requestedOffsetMilliseconds: 5_000, sentOffsetMilliseconds: 5_000,
            acknowledged: true, afterFirstScreenshotAck: true});
    });

    it("fails closed for v2 replay, missing or late first-frame acknowledgement, and cancellation without input", async () => {
        const v1Record = {kind: "installer-boot-confirmation", qcode: "ret", holdMilliseconds: 100,
            requestedOffsetMilliseconds: 2_000, sentOffsetMilliseconds: 2_000, acknowledged: true};
        const v2Record = {...v1Record, requestedOffsetMilliseconds: 5_000, sentOffsetMilliseconds: 5_000,
            afterFirstScreenshotAck: true};
        assert.throws(() => validateInstallerBootInput(v1Record, INSTALLER_BOOT_CONFIRMATION_AFTER_FIRST_FRAME), /input/u);
        assert.throws(() => validateInstallerBootInput(v2Record, INSTALLER_BOOT_CONFIRMATION), /input/u);

        const transcript = response => stream([
            {QMP: {version: {qemu: {major: 10, minor: 1, micro: 2}, package: ""}, capabilities: []}},
            {return: {}, id: "capabilities"}, {return: {running: true, status: "running"}, id: "status"}, response
        ]);
        for (const response of [{error: {class: "CommandFailed"}, id: "screenshot-1"},
            {return: {}, id: "screenshot-1"}]) {
            let now = 0;
            const writes = [];
            await assert.rejects(runEarlyBootQmpSession({readable: transcript(response),
                writeBytes: bytes => writes.push(JSON.parse(bytes.toString("utf8"))), screenshotPaths: SCREENSHOTS,
                bootConfirmation: INSTALLER_BOOT_CONFIRMATION_AFTER_FIRST_FRAME}, {
                now: () => now, wait: async milliseconds => { now += milliseconds + (response.error ? 0 : 1_001); }
            }), /(?:response|window)/u);
            assert.deepEqual(writes.map(value => value.id), ["capabilities", "status", "screenshot-1"]);
        }
        let control = null, release;
        const writes = [];
        const pending = runEarlyBootQmpSession({readable: transcript({return: {}, id: "screenshot-1"}),
            writeBytes: bytes => writes.push(JSON.parse(bytes.toString("utf8"))), screenshotPaths: SCREENSHOTS,
            bootConfirmation: INSTALLER_BOOT_CONFIRMATION_AFTER_FIRST_FRAME, onSession: value => { control = value; }}, {
            now: () => 0, wait: () => new Promise(resolve => { release = resolve; })
        });
        while (control === null || release === undefined) await new Promise(resolve => setImmediate(resolve));
        control.cancel(); release();
        await assert.rejects(pending, /deadline/u);
        assert.deepEqual(writes.map(value => value.id), ["capabilities", "status"]);
    });

    it("rejects untrusted confirmation policy, non-root paths, stale handshakes, non-running guests, and late dispatch", async () => {
        const base = {readable: stream([]), writeBytes: () => assert.fail("confirmation wrote to QMP"),
            screenshotPaths: SCREENSHOTS};
        for (const bootConfirmation of [false, "single-enter-before-setup-v2", null])
            await assert.rejects(runEarlyBootQmpSession({...base, bootConfirmation}), /confirmation/u);
        const baselinePaths = [`${ROOT}/post-release-baseline/early-boot-1.png`,
            `${ROOT}/post-release-baseline/early-boot-2.png`];
        await assert.rejects(runEarlyBootQmpSession({...base, screenshotPaths: baselinePaths,
            bootConfirmation: INSTALLER_BOOT_CONFIRMATION}), /confirmation/u);
        const messages = (status = {running: true, status: "running"}) => stream([
            {QMP: {version: {qemu: {major: 10, minor: 1, micro: 2}, package: ""}, capabilities: []}},
            {return: {}, id: "capabilities"}, {return: status, id: "status"}
        ]);
        await assert.rejects(runEarlyBootQmpSession({readable: messages(), writeBytes: () => undefined,
            screenshotPaths: SCREENSHOTS, bootConfirmation: INSTALLER_BOOT_CONFIRMATION}, {
            now: (() => { let calls = 0; return () => ++calls === 1 ? 0 : 3_001; })(), wait: async () => undefined
        }), /window/u);
        await assert.rejects(runEarlyBootQmpSession({readable: messages({running: false, status: "paused"}),
            writeBytes: () => undefined, screenshotPaths: SCREENSHOTS,
            bootConfirmation: INSTALLER_BOOT_CONFIRMATION}, {wait: async () => undefined}), /running/u);
        let now = 0;
        await assert.rejects(runEarlyBootQmpSession({readable: messages(), writeBytes: () => undefined,
            screenshotPaths: SCREENSHOTS, bootConfirmation: INSTALLER_BOOT_CONFIRMATION}, {
            now: () => now, wait: async milliseconds => { now += milliseconds + 1_001; }
        }), /window/u);
        let microtaskNow = 0;
        const microtaskWrites = [];
        await assert.rejects(runEarlyBootQmpSession({readable: messages(),
            writeBytes: bytes => microtaskWrites.push(bytes), screenshotPaths: SCREENSHOTS,
            bootConfirmation: INSTALLER_BOOT_CONFIRMATION}, {
            now: () => microtaskNow,
            wait: async milliseconds => {
                microtaskNow += milliseconds;
                queueMicrotask(() => { microtaskNow = 3_001; });
            }
        }), /window/u);
        assert.equal(microtaskWrites.length, 2);
        for (const actualOffset of [-1, Number.NaN, 1_999]) {
            const writes = [];
            await assert.rejects(runEarlyBootQmpSession({readable: messages(),
                writeBytes: bytes => writes.push(bytes), screenshotPaths: SCREENSHOTS,
                bootConfirmation: INSTALLER_BOOT_CONFIRMATION}, {
                now: (() => { let calls = 0; return () => ++calls === 1 ? 0 : actualOffset; })(),
                wait: async () => undefined
            }), /window/u);
            assert.equal(writes.length, 2);
        }
    });

    it("validates installer confirmation options and result records fail-closed", () => {
        assert.equal(validateInstallerBootConfirmation(undefined), undefined);
        assert.equal(validateInstallerBootConfirmation(INSTALLER_BOOT_CONFIRMATION), INSTALLER_BOOT_CONFIRMATION);
        assert.throws(() => validateInstallerBootConfirmation("other"), /confirmation/u);
        assert.equal(validateInstallerBootInput(false, undefined), false);
        assert.throws(() => validateInstallerBootInput(false, INSTALLER_BOOT_CONFIRMATION), /input/u);
        const record = {kind: "installer-boot-confirmation", qcode: "ret", holdMilliseconds: 100,
            requestedOffsetMilliseconds: 2_000, sentOffsetMilliseconds: 2_001, acknowledged: true};
        assert.deepEqual(validateInstallerBootInput(record, INSTALLER_BOOT_CONFIRMATION), record);
        assert.throws(() => validateInstallerBootInput({...record, acknowledged: false}, INSTALLER_BOOT_CONFIRMATION), /input/u);
        assert.throws(() => validateInstallerBootInput({...record, sentOffsetMilliseconds: 3_001},
            INSTALLER_BOOT_CONFIRMATION), /input/u);
    });

    it("cancels the bounded confirmation wait before it can write and rejects an unacknowledged key", async () => {
        let control = null;
        const writes = [];
        let releaseWait;
        const cancelled = runEarlyBootQmpSession({readable: stream([
            {QMP: {version: {qemu: {major: 10, minor: 1, micro: 2}, package: ""}, capabilities: []}},
            {return: {}, id: "capabilities"}, {return: {running: true, status: "running"}, id: "status"}
        ]), writeBytes: bytes => writes.push(JSON.parse(bytes.toString("utf8"))), screenshotPaths: SCREENSHOTS,
        bootConfirmation: INSTALLER_BOOT_CONFIRMATION, onSession: value => { control = value; }}, {
            now: () => 0, wait: () => new Promise(resolve => { releaseWait = resolve; })
        });
        while (control === null || releaseWait === undefined) await new Promise(resolve => setImmediate(resolve));
        control.cancel();
        await assert.rejects(cancelled, /cancelled/u);
        assert.deepEqual(writes.map(value => value.id), ["capabilities", "status"]);
        releaseWait();

        let acknowledgedNow = 0;
        await assert.rejects(runEarlyBootQmpSession({readable: stream([
            {QMP: {version: {qemu: {major: 10, minor: 1, micro: 2}, package: ""}, capabilities: []}},
            {return: {}, id: "capabilities"}, {return: {running: true, status: "running"}, id: "status"},
            {error: {class: "CommandFailed"}, id: "installer-boot-confirmation"}
        ]), writeBytes: () => undefined, screenshotPaths: SCREENSHOTS,
        bootConfirmation: INSTALLER_BOOT_CONFIRMATION}, {now: () => acknowledgedNow,
            wait: async milliseconds => { acknowledgedNow += milliseconds; }}), /response/u);

        const failedWaitWrites = [];
        await assert.rejects(runEarlyBootQmpSession({readable: stream([
            {QMP: {version: {qemu: {major: 10, minor: 1, micro: 2}, package: ""}, capabilities: []}},
            {return: {}, id: "capabilities"}, {return: {running: true, status: "running"}, id: "status"}
        ]), writeBytes: bytes => failedWaitWrites.push(JSON.parse(bytes.toString("utf8"))),
        screenshotPaths: SCREENSHOTS, bootConfirmation: INSTALLER_BOOT_CONFIRMATION}, {
            now: () => 0, wait: async () => { throw new Error("confirmation wait failed"); }
        }), /confirmation wait failed/u);
        assert.deepEqual(failedWaitWrites.map(value => value.id), ["capabilities", "status"]);
    });

    it("forwards hosted opt-in confirmation through child QMP pipes and retains its session record", async () => {
        const child = new EventEmitter();
        child.pid = 322; child.stdin = new PassThrough(); child.stdout = new PassThrough();
        child.stderr = new PassThrough(); child.unref = () => undefined;
        let now = 0, session;
        const writes = [];
        child.stdin.on("data", bytes => writes.push(JSON.parse(bytes.toString("utf8"))));
        const pending = runHostedOwnedProcess("/owned/qemu", [], {timeoutMs: 1_000, maxStreamBytes: 65_536,
            qmp: {screenshotPaths: SCREENSHOTS, bootConfirmation: INSTALLER_BOOT_CONFIRMATION},
            qmpDependencies: {now: () => now, wait: async milliseconds => { now += milliseconds; }},
            onQmpSession: value => { session = value; value.then(() => child.emit("close", 0, null)); }}, {
            spawnImpl: () => child, setTimer: () => 1, clearTimer: () => undefined, isGroupAlive: () => false});
        for (const value of [
            {QMP: {version: {qemu: {major: 10, minor: 1, micro: 2}, package: ""}, capabilities: []}},
            {return: {}, id: "capabilities"}, {return: {running: true, status: "running"}, id: "status"},
            {return: {}, id: "installer-boot-confirmation"}, {return: {}, id: "screenshot-1"},
            {return: {}, id: "screenshot-2"}
        ]) child.stdout.write(`${JSON.stringify(value)}\r\n`);
        await pending;
        assert.ok(session);
        assert.equal(writes.filter(value => value.execute === "send-key").length, 1);
        assert.deepEqual((await session).inputSent, {kind: "installer-boot-confirmation", qcode: "ret",
            holdMilliseconds: 100, requestedOffsetMilliseconds: 2_000, sentOffsetMilliseconds: 2_000,
            acknowledged: true});
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

    it("admits the exact containment-preflight root through the shared session", async () => {
        assert.equal(PREFLIGHT_ROOT, `${MSI_ROOT}/containment-preflight`);
        const screenshotPaths = [`${PREFLIGHT_ROOT}/early-boot-1.png`,
            `${PREFLIGHT_ROOT}/early-boot-2.png`];
        const writes = [];
        const result = await runEarlyBootQmpSession({readable: stream([
            {QMP: {version: {qemu: {major: 10, minor: 1, micro: 2}}, capabilities: []}},
            {return: {}, id: "capabilities"}, {return: {running: true, status: "running"}, id: "status"},
            {return: {}, id: "screenshot-1"}, {return: {}, id: "screenshot-2"}
        ]), writeBytes: bytes => writes.push(JSON.parse(bytes.toString("utf8"))), screenshotPaths},
        {wait: async () => undefined});
        assert.deepEqual(result.screenshotPaths, screenshotPaths);
        assert.deepEqual(writes.filter(value => value.execute === "screendump")
            .map(value => value.arguments.filename), screenshotPaths);
    });

    it("carries the containment-preflight paths through the real monitored launcher", async () => {
        const child = new EventEmitter();
        child.pid = 654; child.stdin = new PassThrough(); child.stdout = new PassThrough();
        child.stderr = new PassThrough(); child.unref = () => undefined;
        let session;
        const pending = runHostedOwnedProcess("/owned/qemu", [], {timeoutMs: 1_000,
            maxStreamBytes: 65_536,
            qmp: {screenshotPaths: [`${PREFLIGHT_ROOT}/early-boot-1.png`,
                `${PREFLIGHT_ROOT}/early-boot-2.png`]},
            qmpDependencies: {wait: async () => undefined},
            onQmpSession: value => { session = value; value.then(() => child.emit("close", 0, null)); }}, {
            spawnImpl: () => child, setTimer: () => 1, clearTimer: () => undefined,
            isGroupAlive: () => false});
        for (const value of [
            {QMP: {version: {qemu: {major: 10, minor: 1, micro: 2}, package: ""}, capabilities: []}},
            {return: {}, id: "capabilities"}, {return: {running: true, status: "running"}, id: "status"},
            {return: {}, id: "screenshot-1"}, {return: {}, id: "screenshot-2"}
        ]) child.stdout.write(`${JSON.stringify(value)}\r\n`);
        await pending;
        assert.deepEqual((await session).screenshotPaths, [`${PREFLIGHT_ROOT}/early-boot-1.png`,
            `${PREFLIGHT_ROOT}/early-boot-2.png`]);
    });

    it("admits nothing else under the containment-preflight subtree", async () => {
        /* Late capture is not enabled for MSI, and this root may never be the one that admits it. */
        assert.throws(() => validateLateScreenshots([`${PREFLIGHT_ROOT}/late-boot-1.png`,
            `${PREFLIGHT_ROOT}/late-boot-2.png`]), /path/u);
        const refuse = async (screenshotPaths, label) => {
            await assert.rejects(runEarlyBootQmpSession({readable: stream([]),
                writeBytes: () => assert.fail(`${label} wrote to QMP`), screenshotPaths}),
            /screenshot path/u, label);
        };
        for (const root of [`${PREFLIGHT_ROOT}/nested`, `${MSI_ROOT}/../containment-preflight`,
            `${MSI_ROOT}/containment-preflights`, `${MSI_ROOT}/containment-preflight/`,
            `${MSI_ROOT}/row-00-${MSI_ROW_NONCE}/containment-preflight`,
            "/home/runner/work/_temp/myspeed-windows-msi-abc/containment-preflight",
            `/home/runner/work/_temp/myspeed-windows-msi-${MSI_HOST_NONCE.toUpperCase()}`
                + "/containment-preflight",
            `/home/runner/work/_temp/myspeed-windows-cpu-floor-${MSI_HOST_NONCE}/containment-preflight`])
            await refuse([`${root}/early-boot-1.png`, `${root}/early-boot-2.png`], root);
        for (const names of [["early-boot-1.png", "early-boot-3.png"],
            ["early-boot-2.png", "early-boot-1.png"], ["late-boot-1.png", "late-boot-2.png"]])
            await refuse(names.map(name => `${PREFLIGHT_ROOT}/${name}`), names.join(","));
        /* A preflight screenshot and a row screenshot never belong to the same session. */
        await refuse([`${PREFLIGHT_ROOT}/early-boot-1.png`,
            `${MSI_ROOT}/row-00-${MSI_ROW_NONCE}/early-boot-2.png`], "mixed preflight and row");
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


describe("Stage 3 early-boot QMP authority", () => {
    const STAGE3_NONCE = "0123456789abcdef0123456789abcdef";
    const STAGE3_ROOT = `/home/runner/work/_temp/myspeed-stage3-${STAGE3_NONCE}`;
    const STAGE3_SCREENSHOTS = [`${STAGE3_ROOT}/early-boot-1.png`, `${STAGE3_ROOT}/early-boot-2.png`];
    const greeting = {QMP: {version: {qemu: {major: 8, minor: 2, micro: 2}, package: ""}, capabilities: []}};

    it("admits exactly the two paired Stage 3 early frames", () => {
        assert.deepEqual(validateScreenshots(STAGE3_SCREENSHOTS), STAGE3_SCREENSHOTS);
    });

    it("refuses arbitrary roots, unpaired nonces and reordered Stage 3 early frames", () => {
        const other = `/home/runner/work/_temp/myspeed-stage3-${"f".repeat(32)}`;
        for (const paths of [
            [`${STAGE3_ROOT}/early-boot-1.png`, `${other}/early-boot-2.png`],
            [`${STAGE3_ROOT}/../early-boot-1.png`, `${STAGE3_ROOT}/../early-boot-2.png`],
            [`/home/runner/work/_temp/myspeed-stage3-${STAGE3_NONCE}/nested/early-boot-1.png`,
                `/home/runner/work/_temp/myspeed-stage3-${STAGE3_NONCE}/nested/early-boot-2.png`],
            [`/tmp/myspeed-stage3-${STAGE3_NONCE}/early-boot-1.png`, `/tmp/myspeed-stage3-${STAGE3_NONCE}/early-boot-2.png`],
            [`/home/runner/work/_temp/myspeed-stage3-${STAGE3_NONCE.toUpperCase()}/early-boot-1.png`,
                `/home/runner/work/_temp/myspeed-stage3-${STAGE3_NONCE.toUpperCase()}/early-boot-2.png`],
            [STAGE3_SCREENSHOTS[1], STAGE3_SCREENSHOTS[0]]
        ]) assert.throws(() => validateScreenshots(paths), /QMP screenshot path (?:set )?is invalid/u);
    });

    it("keeps late capture closed for a Stage 3 root", () => {
        assert.throws(() => validateLateScreenshots([`${STAGE3_ROOT}/late-boot-1.png`,
            `${STAGE3_ROOT}/late-boot-2.png`]), /QMP late screenshot path is invalid/u);
    });

    it("captures both Stage 3 frames and sends no key when no confirmation is bound", async () => {
        const writes = [];
        const result = await runEarlyBootQmpSession({readable: stream([greeting,
            {return: {}, id: "capabilities"}, {return: {running: true, status: "running"}, id: "status"},
            {return: {}, id: "screenshot-1"}, {return: {}, id: "screenshot-2"}]),
        writeBytes: bytes => writes.push(JSON.parse(bytes.toString("utf8"))), screenshotPaths: STAGE3_SCREENSHOTS},
        {wait: async () => undefined});
        assert.deepEqual(writes.map(value => value.id),
            ["capabilities", "status", "screenshot-1", "screenshot-2"]);
        assert.deepEqual(result, {version: {major: 8, minor: 2, micro: 2}, status: "running", running: true,
            screenshotPaths: STAGE3_SCREENSHOTS, inputSent: false});
    });

    it("sends one bounded acknowledged Enter when a Stage 3 confirmation is explicitly bound", async () => {
        const writes = [];
        let now = 0;
        const result = await runEarlyBootQmpSession({readable: stream([greeting,
            {return: {}, id: "capabilities"}, {return: {running: true, status: "running"}, id: "status"},
            {return: {}, id: "installer-boot-confirmation"},
            {return: {}, id: "screenshot-1"}, {return: {}, id: "screenshot-2"}]),
        writeBytes: bytes => writes.push(JSON.parse(bytes.toString("utf8"))), screenshotPaths: STAGE3_SCREENSHOTS,
        bootConfirmation: INSTALLER_BOOT_CONFIRMATION},
        {now: () => now, wait: async milliseconds => { now += milliseconds; }});
        assert.deepEqual(writes.map(value => value.id),
            ["capabilities", "status", "installer-boot-confirmation", "screenshot-1", "screenshot-2"]);
        assert.equal(result.inputSent.kind, "installer-boot-confirmation");
        assert.equal(result.inputSent.qcode, INSTALLER_BOOT_CONFIRMATION_QCODE);
        assert.equal(result.inputSent.acknowledged, true);
        assert.ok(result.inputSent.sentOffsetMilliseconds >= INSTALLER_BOOT_CONFIRMATION_REQUESTED_OFFSET_MILLISECONDS);
        assert.ok(result.inputSent.sentOffsetMilliseconds <= INSTALLER_BOOT_CONFIRMATION_LATEST_OFFSET_MILLISECONDS);
    });

    it("refuses an unauthorized Stage 3 input record through the shared validator", () => {
        for (const value of [true, null, {kind: "installer-boot-confirmation", qcode: "ret", holdMilliseconds: 100,
            requestedOffsetMilliseconds: 2_000, sentOffsetMilliseconds: 2_100, acknowledged: true}])
            assert.throws(() => validateInstallerBootInput(value, undefined), /QMP installer boot input is invalid/u);
        assert.equal(validateInstallerBootInput(false, undefined), false);
    });
});

describe("Stage 2 early-boot QMP cadence boot confirmation", () => {
    const CADENCE_IDS = INSTALLER_BOOT_CONFIRMATION_CADENCE_OFFSETS_MILLISECONDS
        .map((_offset, index) => `installer-boot-confirmation-${index + 1}`);
    const replies = ids => [
        {QMP: {version: {qemu: {major: 10, minor: 1, micro: 2}, package: ""}, capabilities: []}},
        {return: {}, id: "capabilities"}, {return: {running: true, status: "running"}, id: "status"},
        ...ids.map(id => ({return: {}, id})),
        {return: {}, id: "screenshot-1"}, {return: {}, id: "screenshot-2"}
    ];
    const pulse = (index, sentOffsetMilliseconds) => ({
        requestedOffsetMilliseconds: INSTALLER_BOOT_CONFIRMATION_CADENCE_OFFSETS_MILLISECONDS[index],
        sentOffsetMilliseconds, acknowledged: true});
    const cadenceInput = pulses => ({kind: "installer-boot-confirmation-cadence", qcode: "ret",
        holdMilliseconds: INSTALLER_BOOT_CONFIRMATION_HOLD_MILLISECONDS, acknowledged: true, pulses});
    const fullCadence = () => INSTALLER_BOOT_CONFIRMATION_CADENCE_OFFSETS_MILLISECONDS
        .map((offset, index) => pulse(index, offset));

    it("names the cadence policy and derives both of its bounds from the offset list", () => {
        assert.equal(INSTALLER_BOOT_CONFIRMATION_CADENCE, "cadence-enter-before-setup-v3");
        assert.deepEqual([...INSTALLER_BOOT_CONFIRMATION_CADENCE_OFFSETS_MILLISECONDS],
            [2_000, 3_200, 4_400, 5_600, 6_800, 8_000]);
        // Every gap is shorter than the firmware prompt this cadence exists to hit.
        const gaps = INSTALLER_BOOT_CONFIRMATION_CADENCE_OFFSETS_MILLISECONDS
            .slice(1).map((offset, index) => offset -
                INSTALLER_BOOT_CONFIRMATION_CADENCE_OFFSETS_MILLISECONDS[index]);
        assert.deepEqual(gaps, [1_200, 1_200, 1_200, 1_200, 1_200]);
        assert.equal(INSTALLER_BOOT_CONFIRMATION_CADENCE_LATEST_OFFSET_MILLISECONDS,
            8_000 + INSTALLER_BOOT_CONFIRMATION_CADENCE_SLACK_MILLISECONDS);
        // The whole cadence still finishes long before the first screenshot's own +30s successor.
        assert.equal(INSTALLER_BOOT_CONFIRMATION_CADENCE_LATEST_OFFSET_MILLISECONDS < 30_000, true);
        assert.equal(validateInstallerBootConfirmation(INSTALLER_BOOT_CONFIRMATION_CADENCE),
            INSTALLER_BOOT_CONFIRMATION_CADENCE);
    });

    it("sends every cadence pulse at its own offset before the first screenshot", async () => {
        const writes = [];
        let now = 0;
        const result = await runEarlyBootQmpSession({readable: stream(replies(CADENCE_IDS)),
            writeBytes: bytes => writes.push({value: JSON.parse(bytes.toString("utf8")), time: now}),
            screenshotPaths: SCREENSHOTS, bootConfirmation: INSTALLER_BOOT_CONFIRMATION_CADENCE},
        {now: () => now, wait: async milliseconds => { now += milliseconds; }});
        assert.deepEqual(writes.map(({value}) => value.id),
            ["capabilities", "status", ...CADENCE_IDS, "screenshot-1", "screenshot-2"]);
        // Every pulse is the same single bounded Enter the other two policies send.
        for (const id of CADENCE_IDS) {
            assert.deepEqual(writes.find(({value}) => value.id === id).value, {execute: "send-key",
                arguments: {keys: [{type: "qcode", data: INSTALLER_BOOT_CONFIRMATION_QCODE}],
                    "hold-time": INSTALLER_BOOT_CONFIRMATION_HOLD_MILLISECONDS}, id});
        }
        assert.deepEqual(writes.slice(2, 2 + CADENCE_IDS.length).map(({time}) => time),
            [...INSTALLER_BOOT_CONFIRMATION_CADENCE_OFFSETS_MILLISECONDS]);
        // The screenshots follow the cadence rather than interleaving with it.
        assert.deepEqual(writes.slice(-2).map(({time}) => time), [8_000, 38_000]);
        assert.deepEqual(result.inputSent, cadenceInput(fullCadence()));
    });

    it("stops the cadence at the window instead of typing past it", async () => {
        const writes = [];
        let now = 0;
        const result = await runEarlyBootQmpSession({readable: stream(replies(CADENCE_IDS.slice(0, 3))),
            writeBytes: bytes => { writes.push({value: JSON.parse(bytes.toString("utf8")), time: now});
                now += 2_000; },
            screenshotPaths: SCREENSHOTS, bootConfirmation: INSTALLER_BOOT_CONFIRMATION_CADENCE},
        {now: () => now, wait: async milliseconds => { now += milliseconds; }});
        // A session running behind schedule sends what still fits and records exactly that: a
        // truncated cadence is evidence, not a failure that would erase the early-boot observation.
        assert.deepEqual(result.inputSent.pulses.map(item => item.requestedOffsetMilliseconds),
            INSTALLER_BOOT_CONFIRMATION_CADENCE_OFFSETS_MILLISECONDS.slice(0, 3));
        for (const item of result.inputSent.pulses) {
            assert.equal(item.acknowledged, true);
            assert.equal(item.sentOffsetMilliseconds <=
                INSTALLER_BOOT_CONFIRMATION_CADENCE_LATEST_OFFSET_MILLISECONDS, true);
        }
        assert.equal(writes.filter(({value}) => value.execute === "send-key").length, 3);
    });

    it("refuses a cadence record that was not the cadence this policy authorized", () => {
        assert.deepEqual(validateInstallerBootInput(cadenceInput(fullCadence()),
            INSTALLER_BOOT_CONFIRMATION_CADENCE), cadenceInput(fullCadence()));
        // A truncated but well-formed prefix stays admissible.
        assert.equal(validateInstallerBootInput(cadenceInput(fullCadence().slice(0, 2)),
            INSTALLER_BOOT_CONFIRMATION_CADENCE).pulses.length, 2);
        const refused = [
            false,
            cadenceInput([]),
            cadenceInput([...fullCadence(), pulse(5, 8_400)]),
            // An offset list of the caller's own choosing, rather than the fixed one.
            cadenceInput([pulse(0, 2_000), {requestedOffsetMilliseconds: 2_600,
                sentOffsetMilliseconds: 2_600, acknowledged: true}]),
            // A pulse sent before its own offset, or after the gate that admits a pulse at all:
            // the record is taken at the write boundary, so it is held to that same gate.
            cadenceInput([{...pulse(0, 1_999)}]),
            cadenceInput([{...pulse(0,
                INSTALLER_BOOT_CONFIRMATION_CADENCE_LATEST_OFFSET_MILLISECONDS + 1)}]),
            cadenceInput([...fullCadence().slice(0, 5),
                pulse(5, INSTALLER_BOOT_CONFIRMATION_CADENCE_LATEST_OFFSET_MILLISECONDS + 1)]),
            // Pulses recorded out of order.
            cadenceInput([pulse(0, 4_000), pulse(1, 3_500)]),
            cadenceInput([{requestedOffsetMilliseconds: 2_000, sentOffsetMilliseconds: 2_000,
                acknowledged: false}]),
            {...cadenceInput(fullCadence()), kind: "installer-boot-confirmation"},
            {...cadenceInput(fullCadence()), qcode: "spc"},
            {...cadenceInput(fullCadence()), holdMilliseconds: 30},
            {...cadenceInput(fullCadence()), afterFirstScreenshotAck: true}
        ];
        for (const value of refused) {
            assert.throws(() => validateInstallerBootInput(value, INSTALLER_BOOT_CONFIRMATION_CADENCE),
                /installer boot input is invalid/u);
        }
        // The cadence record is not admissible under either single-keystroke policy, and neither of
        // their records is admissible under the cadence.
        for (const policy of [undefined, INSTALLER_BOOT_CONFIRMATION,
            INSTALLER_BOOT_CONFIRMATION_AFTER_FIRST_FRAME]) {
            assert.throws(() => validateInstallerBootInput(cadenceInput(fullCadence()), policy),
                /installer boot input is invalid/u);
        }
        assert.throws(() => validateInstallerBootInput({kind: "installer-boot-confirmation", qcode: "ret",
            holdMilliseconds: INSTALLER_BOOT_CONFIRMATION_HOLD_MILLISECONDS,
            requestedOffsetMilliseconds: 2_000, sentOffsetMilliseconds: 2_000, acknowledged: true},
        INSTALLER_BOOT_CONFIRMATION_CADENCE), /installer boot input is invalid/u);
    });
});
