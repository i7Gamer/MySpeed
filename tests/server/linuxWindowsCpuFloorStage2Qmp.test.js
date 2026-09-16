import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";

import {
    INSTALLER_BOOT_CONFIRMATION,
    INSTALLER_BOOT_CONFIRMATION_HOLD_MILLISECONDS,
    INSTALLER_BOOT_CONFIRMATION_LATEST_OFFSET_MILLISECONDS,
    INSTALLER_BOOT_CONFIRMATION_QCODE,
    INSTALLER_BOOT_CONFIRMATION_REQUESTED_OFFSET_MILLISECONDS,
    LATE_BOOT_MILESTONE_OFFSETS_MILLISECONDS,
    MAX_LATE_BOOT_MILESTONES,
    runEarlyBootQmpSession,
    validateInstallerBootConfirmation,
    validateInstallerBootInput,
    validateLateScreenshots
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

