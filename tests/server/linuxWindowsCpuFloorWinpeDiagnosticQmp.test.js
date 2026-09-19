import assert from "node:assert/strict";
import crypto from "node:crypto";
import {describe, it} from "node:test";

import {
    INSTALLER_BOOT_CONFIRMATION,
    INSTALLER_BOOT_CONFIRMATION_AFTER_FIRST_FRAME,
    LATE_BOOT_MILESTONE_OFFSETS_MILLISECONDS,
    LATE_MILESTONE_UNAVAILABLE_REASONS,
    PREDEADLINE_FRAME_COMMAND_TIMEOUT_MILLISECONDS,
    WINPE_DIAGNOSTIC_CONFIRMATION,
    WINPE_DIAGNOSTIC_CONSOLE_OPEN_MILLISECONDS,
    WINPE_DIAGNOSTIC_CONSOLE_QCODES,
    WINPE_DIAGNOSTIC_DRIVE_LETTERS,
    WINPE_DIAGNOSTIC_EXCHANGE_BUDGET_MILLISECONDS,
    WINPE_DIAGNOSTIC_HOLD_MILLISECONDS,
    WINPE_DIAGNOSTIC_KEY_GAP_MILLISECONDS,
    WINPE_DIAGNOSTIC_LATEST_OFFSET_MILLISECONDS,
    WINPE_DIAGNOSTIC_LATEST_RECORDED_OFFSET_MILLISECONDS,
    WINPE_DIAGNOSTIC_PHASE_MILLISECONDS,
    WINPE_DIAGNOSTIC_REPLY_TIMEOUT_MILLISECONDS,
    WINPE_DIAGNOSTIC_TAG_LENGTH,
    encodeWinpeDiagnosticKeys,
    runEarlyBootQmpSession,
    validateInstallerBootConfirmation,
    validateInstallerBootInput,
    validateWinpeDiagnosticAuthorization,
    validateWinpeDiagnosticInput,
    winpeDiagnosticBudget,
    winpeDiagnosticCommand,
    winpeDiagnosticScriptName,
    winpeDiagnosticScriptTag
} from "../../scripts/qualification/linux-windows-cpu-floor-stage2-qmp.mjs";

const NONCE = "0123456789abcdef0123456789abcdef";
const OTHER_NONCE = "fedcba9876543210fedcba9876543210";
const ROOT = `/home/runner/work/_temp/myspeed-windows-cpu-floor-${NONCE}`;
const SCREENSHOTS = [`${ROOT}/early-boot-1.png`, `${ROOT}/early-boot-2.png`];
const LATE_SCREENSHOTS = [`${ROOT}/late-boot-1.png`, `${ROOT}/late-boot-2.png`];
const AUTHORIZATION = {confirmation: WINPE_DIAGNOSTIC_CONFIRMATION, nonce: NONCE};
/* Long enough that a settling session always wins, short enough that a stuck one fails quickly. */
const SETTLEMENT_WATCHDOG_MILLISECONDS = 2_000;
/*
 * A slow flood serves one large fragment per read instead of a byte, so a reader that kept
 * going would reach the source's transcript cap within a handful of turns rather than tens of
 * thousands. The abandon lands after the third, with the fragment that follows it delayed by a
 * turn so the reader is demonstrably parked when the exchange it belonged to is given up.
 */
const FLOOD_FRAGMENT_BYTES = 4_096;
const FRAGMENTS_BEFORE_ABANDON = 3;
const ORPHAN_OBSERVATION_MILLISECONDS = 50;

function transport(responses, stallWrite = null, flood = null, slowFlood = null, failWrite = null) {
    /*
     * A fake QMP transport rather than a canned array: the diagnostic writes 85 commands whose ids
     * are derived, so the transcript has to answer what was actually written. `responses` overrides
     * individual ids, which is how a monitor refusal mid-sequence is exercised.
     */
    const writes = [];
    let resolveChunk = null;
    const pending = [];
    const push = value => {
        const chunk = Buffer.from(`${JSON.stringify(value)}\r\n`);
        if (resolveChunk !== null) { const resolver = resolveChunk; resolveChunk = null; resolver({value: chunk, done: false}); }
        else pending.push(chunk);
    };
    /*
     * Once flooding, every read is served immediately with something that is not the reply being
     * waited for - a QMP event, which `expectResponse` skips, or a fragment of a message, which
     * leaves the parser mid-line. Either renews the per-chunk deadline for as long as it lasts, so
     * the exchange can only end on one of the source's own bounds.
     */
    let flooding = null;
    let slowFlooding = false;
    let floodReads = 0;
    const readable = {[Symbol.asyncIterator]: () => ({
        next: () => {
            if (pending.length > 0) return Promise.resolve({value: pending.shift(), done: false});
            if (slowFlooding) {
                floodReads += 1;
                const served = floodReads;
                const fragment = Buffer.alloc(FLOOD_FRAGMENT_BYTES, 0x20);
                return new Promise(resolve => setTimeout(() => {
                    if (served !== FRAGMENTS_BEFORE_ABANDON) return resolve({value: fragment, done: false});
                    /* Abandon first, then let the fragment land a turn later, fully after it. */
                    slowFlood.abandon();
                    setTimeout(() => resolve({value: fragment, done: false}), 0);
                }, 0));
            }
            if (flooding !== null) {
                return Promise.resolve({value: flooding === "fragments" ? Buffer.from(" ") :
                    Buffer.from(`${JSON.stringify({event: "RTC_CHANGE", data: {offset: 1}})}\r\n`), done: false});
            }
            return new Promise(resolve => { resolveChunk = resolve; });
        }
    })};
    push({QMP: {version: {qemu: {major: 10, minor: 1, micro: 2}, package: ""}, capabilities: []}});
    return {writes, readable, floodReads: () => floodReads, writeBytes: bytes => {
        const value = JSON.parse(bytes.toString("utf8"));
        writes.push(value);
        /* A pipe write that never settles: the bytes may already be gone, so a reply is owed. */
        if (value.id === stallWrite) return new Promise(() => undefined);
        /* A write that fails outright, which the session tags with its own provenance. */
        if (value.id === failWrite) throw new Error("pipe write failed");
        if (slowFlood !== null && value.id === slowFlood.id) { slowFlooding = true; return; }
        if (flood !== null && value.id === flood.id) { flooding = flood.kind; return; }
        const override = responses?.[value.id];
        const reply = override === undefined ? {return: {}, id: value.id} :
            typeof override === "function" ? override(value) : override;
        /* `null` withholds the reply entirely, which is how an owed acknowledgement is abandoned. */
        if (reply !== null) push(reply);
    }};
}

const STATUS_RESPONSES = {
    status: {return: {running: true, status: "running"}, id: "status"},
    "late-status-1": {return: {running: true, status: "running"}, id: "late-status-1"},
    "late-status-2": {return: {running: true, status: "running"}, id: "late-status-2"}
};

/*
 * Only `now` and `wait` are injected by default. `cancellableDelay` falls through to `wait` when no
 * timer factory is supplied, which leaves the real `withDeadline` timers alone - a blanket fake
 * timer factory would fire the per-message deadline instantly and prove nothing about pacing.
 *
 * `timers` opts one test out of that, for the deadlines themselves rather than the pacing: a test
 * that must abandon an owed acknowledgement has to fire a real `withDeadline` timer, and cannot do
 * it by waiting ten seconds. Every existing test leaves `timers` unset and keeps its real timers.
 */
async function runDiagnosticSession({responses, authorization = AUTHORIZATION, clock, nowHook,
    timers, stallWrite, flood, slowFlood, failWrite} = {}) {
    const bus = transport({...responses, ...STATUS_RESPONSES}, stallWrite, flood, slowFlood, failWrite);
    let now = 0;
    let nowReads = 0;
    const waits = [];
    let latePromise = null;
    await runEarlyBootQmpSession({
        readable: bus.readable, writeBytes: bus.writeBytes, screenshotPaths: SCREENSHOTS,
        lateScreenshotPaths: LATE_SCREENSHOTS, winpeDiagnostic: authorization,
        onLateObservation: promise => { latePromise = promise; }
    }, {
        /*
         * `nowHook` sees a 1-based index for every clock read, which is how a test can place a
         * jump on one exact read - the acknowledgement of a single key - instead of advancing a
         * whole delay and hitting a different check than the one under test.
         */
        now: () => { nowReads += 1; return nowHook?.(nowReads, now) ?? now; },
        wait: async milliseconds => { waits.push(milliseconds); now += clock?.(milliseconds) ?? milliseconds; },
        ...(timers ?? {})
    });
    return {late: await latePromise, writes: bus.writes, waits, floodReads: bus.floodReads,
        elapsed: () => now};
}

describe("WinPE answer-file diagnostic command derivation", () => {
    it("derives one frozen command over every standard letter but X, with a salted 8.3-safe name", () => {
        assert.deepEqual(WINPE_DIAGNOSTIC_DRIVE_LETTERS, [..."cdefghijklmnopqrstuvwyz"]);
        assert.equal(WINPE_DIAGNOSTIC_DRIVE_LETTERS.includes("x"), false);
        assert.equal(WINPE_DIAGNOSTIC_DRIVE_LETTERS.length, 23);
        const tag = winpeDiagnosticScriptTag(NONCE);
        assert.equal(tag.length, WINPE_DIAGNOSTIC_TAG_LENGTH);
        assert.match(tag, /^[a-f0-9]{8}$/u);
        assert.notEqual(tag, NONCE.slice(0, WINPE_DIAGNOSTIC_TAG_LENGTH));
        assert.notEqual(tag, winpeDiagnosticScriptTag(OTHER_NONCE));
        assert.equal(winpeDiagnosticScriptName(NONCE), `${tag}.cmd`);
        assert.equal(winpeDiagnosticCommand(NONCE),
            `for %d in (c d e f g h i j k l m n o p q r s t u v w y z) do @call %d:\\${tag}.cmd`);
        /* The typed backslash must survive as one literal character, not an escape. */
        assert.equal([...winpeDiagnosticCommand(NONCE)].filter(character => character === "\\").length, 1);
        assert.throws(() => winpeDiagnosticScriptTag("not-a-nonce"), /nonce is invalid/u);
        assert.throws(() => winpeDiagnosticScriptTag(NONCE.toUpperCase()), /nonce is invalid/u);
    });

    it("encodes every character, shifting exactly the six symbols that need it", () => {
        const command = winpeDiagnosticCommand(NONCE);
        const keys = encodeWinpeDiagnosticKeys(command);
        assert.equal(keys.length, command.length);
        assert.equal(keys.map(key => key.character).join(""), command);
        const shifted = keys.filter(key => key.qcodes[0] === "shift");
        assert.deepEqual(shifted.map(key => key.character), ["%", "(", ")", "@", "%", ":"]);
        assert.ok(shifted.every(key => key.qcodes.length === 2));
        assert.deepEqual(keys.find(key => key.character === "\\").qcodes, ["backslash"]);
        assert.deepEqual(keys.find(key => key.character === ".").qcodes, ["dot"]);
        assert.deepEqual(keys.find(key => key.character === " ").qcodes, ["spc"]);
        assert.ok(keys.filter(key => key.qcodes.length === 1).every(key => /^[a-z0-9]$/u.test(key.qcodes[0]) ||
            ["spc", "dot", "backslash"].includes(key.qcodes[0])));
        assert.throws(() => encodeWinpeDiagnosticKeys("echo ~"), /not encodable/u);
        assert.throws(() => encodeWinpeDiagnosticKeys(""), /command is invalid/u);
    });

    it("derives the transcript budget from the sequence and preserves today's event headroom exactly", () => {
        const budget = winpeDiagnosticBudget(NONCE);
        assert.equal(budget.keyEvents, 1 + budget.command.length + 1);
        assert.equal(budget.maximumMessages, 64 + budget.keyEvents);
        assert.equal(budget.maximumTranscriptBytes, 65_536 + budget.keyEvents * 64);
        /*
         * Headroom, not a chosen number: an ordinary late session reads nine replies of its own out
         * of 64; the diagnostic reads those nine plus its own 85 out of 64 + 85. The slack left for
         * asynchronous events is identical.
         */
        assert.equal(budget.maximumMessages - (9 + budget.keyEvents), 64 - 9);
    });
});

describe("WinPE answer-file diagnostic authorization", () => {
    it("is a separate authorization that never becomes a third boot-confirmation policy", () => {
        assert.throws(() => validateInstallerBootConfirmation(WINPE_DIAGNOSTIC_CONFIRMATION),
            /installer boot confirmation is invalid/u);
        assert.equal(validateInstallerBootConfirmation(undefined), undefined);
        assert.equal(validateInstallerBootConfirmation(INSTALLER_BOOT_CONFIRMATION),
            "single-enter-before-setup-v1");
        assert.equal(validateInstallerBootConfirmation(INSTALLER_BOOT_CONFIRMATION_AFTER_FIRST_FRAME),
            "single-enter-after-first-frame-v2");
        assert.equal(validateInstallerBootInput(false, undefined), false);
        assert.equal(validateWinpeDiagnosticAuthorization(undefined), undefined);
        assert.deepEqual({...validateWinpeDiagnosticAuthorization(AUTHORIZATION)}, AUTHORIZATION);
    });

    it("refuses a malformed, extended or wrongly confirmed authorization", () => {
        for (const value of [null, [], "x", {}, {confirmation: WINPE_DIAGNOSTIC_CONFIRMATION},
            {confirmation: "single-enter-before-setup-v1", nonce: NONCE},
            {confirmation: WINPE_DIAGNOSTIC_CONFIRMATION, nonce: "zz"},
            {confirmation: WINPE_DIAGNOSTIC_CONFIRMATION, nonce: NONCE, extra: 1}])
            assert.throws(() => validateWinpeDiagnosticAuthorization(value), /authorization is invalid/u);
    });

    it("refuses an unauthorized, replayed or self-inconsistent input record", () => {
        const budget = winpeDiagnosticBudget(NONCE);
        const accepted = {schemaVersion: 1, kind: "winpe-answer-file-diagnostic-input",
            confirmation: WINPE_DIAGNOSTIC_CONFIRMATION, scriptTag: winpeDiagnosticScriptTag(NONCE),
            commandSha256: crypto.createHash("sha256").update(budget.command).digest("hex"),
            keyEvents: budget.keyEvents, acknowledgedKeyEvents: budget.keyEvents,
            consoleOpenedOffsetMs: 121_000, firstKeyOffsetMs: 123_000, submittedOffsetMs: 131_000,
            submitted: true, status: "submitted", failure: null};
        assert.deepEqual({...validateWinpeDiagnosticInput(accepted, AUTHORIZATION)}, accepted);
        assert.throws(() => validateWinpeDiagnosticInput(accepted, undefined), /is not authorized/u);
        assert.throws(() => validateWinpeDiagnosticInput(accepted,
            {confirmation: WINPE_DIAGNOSTIC_CONFIRMATION, nonce: OTHER_NONCE}), /input is invalid/u);
        for (const override of [
            {submitted: false}, {status: "aborted"}, {acknowledgedKeyEvents: budget.keyEvents - 1},
            {acknowledgedKeyEvents: budget.keyEvents + 1}, {keyEvents: budget.keyEvents + 1},
            {submittedOffsetMs: null}, {submittedOffsetMs: WINPE_DIAGNOSTIC_LATEST_RECORDED_OFFSET_MILLISECONDS + 1},
            {scriptTag: "deadbeef"}, {commandSha256: "0".repeat(64)}, {status: "partial"},
            {failure: "x\u0000y"}, {kind: "installer-boot-confirmation"}])
            assert.throws(() => validateWinpeDiagnosticInput({...accepted, ...override}, AUTHORIZATION),
                /input is invalid/u);
        const aborted = {...accepted, acknowledgedKeyEvents: 3, submitted: false, status: "aborted",
            submittedOffsetMs: null, failure: "WinPE diagnostic phase deadline exceeded"};
        assert.deepEqual({...validateWinpeDiagnosticInput(aborted, AUTHORIZATION)}, aborted);
        assert.throws(() => validateWinpeDiagnosticInput({...aborted, submittedOffsetMs: 130_000},
            AUTHORIZATION), /input is invalid/u);
        /*
         * The deadline is checked before the final exchange, never after it, so the acknowledgement
         * it records can land later than the latest offset by at most one reply timeout. Refusing
         * that record would throw away a sequence that actually completed.
         */
        assert.equal(WINPE_DIAGNOSTIC_LATEST_RECORDED_OFFSET_MILLISECONDS,
            WINPE_DIAGNOSTIC_LATEST_OFFSET_MILLISECONDS + WINPE_DIAGNOSTIC_REPLY_TIMEOUT_MILLISECONDS);
        assert.equal(validateWinpeDiagnosticInput({...accepted,
            submittedOffsetMs: WINPE_DIAGNOSTIC_LATEST_RECORDED_OFFSET_MILLISECONDS}, AUTHORIZATION)
            .submittedOffsetMs, WINPE_DIAGNOSTIC_LATEST_RECORDED_OFFSET_MILLISECONDS);
    });
});

describe("WinPE answer-file diagnostic QMP sequence", () => {
    it("types exactly one sealed sequence after the first late frame and submits it once", async () => {
        const {late, writes} = await runDiagnosticSession();
        const budget = winpeDiagnosticBudget(NONCE);
        const ids = writes.map(value => value.id);
        assert.deepEqual(ids.slice(0, 6), ["capabilities", "status", "screenshot-1", "screenshot-2",
            "late-status-1", "late-screenshot-1"]);
        assert.deepEqual(ids.slice(-1), ["late-screenshot-2"]);
        const sequence = writes.filter(value => value.execute === "send-key");
        assert.equal(sequence.length, budget.keyEvents);
        assert.deepEqual(sequence[0], {execute: "send-key", arguments: {
            keys: [...WINPE_DIAGNOSTIC_CONSOLE_QCODES].map(data => ({type: "qcode", data})),
            "hold-time": WINPE_DIAGNOSTIC_HOLD_MILLISECONDS}, id: "winpe-console"});
        assert.deepEqual(sequence.at(-1), {execute: "send-key",
            arguments: {keys: [{type: "qcode", data: "ret"}], "hold-time": WINPE_DIAGNOSTIC_HOLD_MILLISECONDS},
            id: "winpe-submit"});
        /* The whole command, reconstructed from the wire, is the command the derivation produced. */
        const typed = sequence.slice(1, -1).map(value => value.arguments.keys.at(-1).data);
        const keys = encodeWinpeDiagnosticKeys(budget.command);
        assert.deepEqual(typed, keys.map(key => key.qcodes.at(-1)));
        assert.equal(sequence.slice(1, -1).filter(value => value.arguments.keys[0].data === "shift").length, 6);
        assert.ok(sequence.every(value => value.arguments["hold-time"] === WINPE_DIAGNOSTIC_HOLD_MILLISECONDS));
        assert.equal(late.winpeDiagnostic.status, "submitted");
        assert.equal(late.winpeDiagnostic.submitted, true);
        assert.equal(late.winpeDiagnostic.acknowledgedKeyEvents, budget.keyEvents);
        assert.equal(late.winpeDiagnostic.failure, null);
        assert.equal(late.milestones.length, 2);
        assert.ok(late.milestones.every(item => item.screenshotPath),
            "both frames are taken, not merely slotted");
        assert.deepEqual(late.milestones.map(item => item.offsetMs), [...LATE_BOOT_MILESTONE_OFFSETS_MILLISECONDS]);
    });

    it("paces every key with a release barrier wider than the hold and closes before the second frame", async () => {
        const {late, waits} = await runDiagnosticSession();
        const budget = winpeDiagnosticBudget(NONCE);
        const keyGaps = waits.filter(value => value === WINPE_DIAGNOSTIC_KEY_GAP_MILLISECONDS);
        assert.equal(keyGaps.length, budget.command.length);
        assert.ok(WINPE_DIAGNOSTIC_KEY_GAP_MILLISECONDS > WINPE_DIAGNOSTIC_HOLD_MILLISECONDS);
        assert.equal(waits.filter(value => value === WINPE_DIAGNOSTIC_CONSOLE_OPEN_MILLISECONDS).length, 1);
        assert.ok(late.winpeDiagnostic.consoleOpenedOffsetMs >= LATE_BOOT_MILESTONE_OFFSETS_MILLISECONDS[0]);
        assert.ok(late.winpeDiagnostic.submittedOffsetMs < LATE_BOOT_MILESTONE_OFFSETS_MILLISECONDS[1]);
        assert.ok(late.winpeDiagnostic.submittedOffsetMs <= WINPE_DIAGNOSTIC_LATEST_OFFSET_MILLISECONDS);
        assert.ok(late.winpeDiagnostic.submittedOffsetMs - late.winpeDiagnostic.consoleOpenedOffsetMs <
            WINPE_DIAGNOSTIC_PHASE_MILLISECONDS);
    });

    it("never retries, never submits a partial sequence, and still returns both frames", async () => {
        const {late, writes} = await runDiagnosticSession({
            responses: {"winpe-key-20": {error: {class: "CommandNotFound"}, id: "winpe-key-20"}}});
        const sequence = writes.filter(value => value.execute === "send-key");
        /* One console shortcut plus twenty characters were written; the twentieth was refused. */
        assert.equal(sequence.length, 21);
        assert.equal(sequence.filter(value => value.id === "winpe-submit").length, 0);
        assert.equal(late.winpeDiagnostic.submitted, false);
        assert.equal(late.winpeDiagnostic.status, "aborted");
        assert.equal(late.winpeDiagnostic.submittedOffsetMs, null);
        assert.equal(late.winpeDiagnostic.acknowledgedKeyEvents, 20);
        assert.match(late.winpeDiagnostic.failure, /QMP response is invalid/u);
        assert.equal(late.milestones.length, 2);
        assert.ok(late.milestones[1].screenshotPath,
            "the second frame still has to be taken: a refused key is not a broken reader");
    });

    it("stops on the phase deadline mid-sequence rather than pushing the second frame", async () => {
        /* Every inter-key gap costs a whole phase allowance, so the deadline arrives inside the line. */
        const {late, writes} = await runDiagnosticSession({
            clock: milliseconds => milliseconds === WINPE_DIAGNOSTIC_KEY_GAP_MILLISECONDS ?
                WINPE_DIAGNOSTIC_PHASE_MILLISECONDS : milliseconds});
        assert.equal(late.winpeDiagnostic.submitted, false);
        assert.match(late.winpeDiagnostic.failure, /phase deadline exceeded/u);
        assert.ok(writes.filter(value => value.execute === "send-key").length < 5);
        assert.equal(late.milestones.length, 2);
    });

    it("refuses a diagnostic bound to another run, or one with no late capture at all", async () => {
        await assert.rejects(runDiagnosticSession({
            authorization: {confirmation: WINPE_DIAGNOSTIC_CONFIRMATION, nonce: OTHER_NONCE}}),
        /WinPE diagnostic root is invalid/u);
        const bus = transport({status: {return: {running: true, status: "running"}, id: "status"}});
        await assert.rejects(runEarlyBootQmpSession({readable: bus.readable, writeBytes: bus.writeBytes,
            screenshotPaths: SCREENSHOTS, winpeDiagnostic: AUTHORIZATION}, {wait: async () => undefined}),
        /WinPE diagnostic root is invalid/u);
    });

    it("leaves the no-input, v1 and v2 sessions with no send-key traffic of this kind", async () => {
        const bus = transport(STATUS_RESPONSES);
        let latePromise = null;
        let now = 0;
        const result = await runEarlyBootQmpSession({readable: bus.readable, writeBytes: bus.writeBytes,
            screenshotPaths: SCREENSHOTS, lateScreenshotPaths: LATE_SCREENSHOTS,
            onLateObservation: promise => { latePromise = promise; }}, {
            now: () => now, wait: async milliseconds => { now += milliseconds; }});
        assert.equal(result.inputSent, false);
        const late = await latePromise;
        assert.equal(Object.hasOwn(late, "winpeDiagnostic"), false);
        assert.equal(bus.writes.filter(value => value.execute === "send-key").length, 0);
    });
});

describe("WinPE answer-file diagnostic never costs the frame it exists to observe", () => {
    it("keeps the completed record and the +300s frame when the deadline falls on the final acknowledgement", async () => {
        /*
         * The submit key is the last of 85 exchanges, so a loaded runner crosses the phase deadline
         * there before anywhere else. Nothing follows that acknowledgement, so it must not be
         * discarded: the sequence did land, and the second frame is the evidence about its effect.
         */
        let reads = 0;
        let jumpAt = null;
        const session = await runDiagnosticSession({
            responses: {"winpe-submit": value => { jumpAt = reads + 2; return {return: {}, id: value.id}; }},
            nowHook: (index, current) => {
                reads = index;
                return index === jumpAt ? current + WINPE_DIAGNOSTIC_PHASE_MILLISECONDS + 1 : current;
            }
        });
        const budget = winpeDiagnosticBudget(NONCE);
        assert.equal(session.late.winpeDiagnostic.status, "submitted");
        assert.equal(session.late.winpeDiagnostic.submitted, true);
        assert.equal(session.late.winpeDiagnostic.acknowledgedKeyEvents, budget.keyEvents);
        assert.equal(session.late.winpeDiagnostic.failure, null);
        assert.equal(session.late.milestones.length, 2);
        assert.equal(session.late.milestones[1].screenshotPath, LATE_SCREENSHOTS[1]);
    });

    /*
     * The counterpart to the two tests above, and the reason they are not in conflict. A phase
     * deadline that falls before a command is issued, or after its acknowledgement is consumed,
     * owes nothing and must keep the frame. A deadline that falls while an acknowledgement is
     * still owed leaves an unconsumed reply on a shared reader, and continuing would let it be
     * read as the next command's response. That session stops instead, and says so.
     */
    it("issues nothing further once an owed acknowledgement is abandoned", async () => {
        let armed = false;
        const running = runDiagnosticSession({
            /* Withheld, so the read that follows the write can only end at its deadline. */
            responses: {"winpe-console": () => { armed = true; return null; }},
            /*
             * Injecting a timer factory also takes over `cancellableDelay`, which otherwise falls
             * through to `wait`. Pacing delays therefore have to keep running - they are just run
             * immediately, since this test is about ordering rather than timing - while the reply
             * deadline is the one held back until there is an owed acknowledgement to abandon.
             */
            timers: {
                setTimer: (callback, milliseconds) => {
                    if (armed && milliseconds === WINPE_DIAGNOSTIC_REPLY_TIMEOUT_MILLISECONDS) {
                        queueMicrotask(callback);
                        return 0;
                    }
                    return setTimeout(callback, 0);
                },
                clearTimer: handle => clearTimeout(handle)
            }
        });
        /*
         * A real timer, not the session's injected one: continuing past the abandoned reply lets a
         * later command wait on a reply the orphaned reader already took, and that waits forever.
         * The watchdog turns that into a failure with a name instead of a hung suite.
         */
        let watchdog;
        const session = await Promise.race([running, new Promise((resolve, reject) => {
            watchdog = setTimeout(() => reject(new Error("session did not settle after the abandoned reply")),
                SETTLEMENT_WATCHDOG_MILLISECONDS);
        })]).finally(() => clearTimeout(watchdog));
        const issued = session.writes.map(value => value.id);
        assert.ok(issued.includes("late-screenshot-1"), "the first milestone completed before the abandon");
        assert.equal(issued.includes("late-status-2"), false, "no command may follow an abandoned reply");
        assert.equal(issued.includes("late-screenshot-2"), false);
        assert.equal(session.late.milestones.length, 2, "the abandoned milestone keeps its slot");
        assert.equal(session.late.milestones[1].milestone, 2);
        assert.equal(session.late.milestones[1].offsetMs, LATE_BOOT_MILESTONE_OFFSETS_MILLISECONDS[1]);
        /* Nothing was observed for it, so nothing is reported for it beyond why. */
        assert.equal(Object.hasOwn(session.late.milestones[1], "status"), false);
        assert.equal(Object.hasOwn(session.late.milestones[1], "running"), false);
        assert.equal(Object.hasOwn(session.late.milestones[1], "screenshotPath"), false);
        assert.equal(session.late.milestones[1].unavailable.reason, "reader-unavailable");
    });

    /*
     * The same phase deadline as the test below, one clock read earlier, and the opposite outcome.
     * Crossing it after an acknowledgement is consumed abandons nothing and keeps the frame;
     * crossing it between the write and its reply leaves that reply unread on the shared reader,
     * and no timer is involved in either case. Ownership decides, not timing.
     */
    /*
     * A reply buried under something the reader keeps having to skip - events, which
     * `expectResponse` discards, or fragments, which leave the parser mid-line - renews the
     * per-chunk deadline indefinitely without any single read expiring. What actually ends it is
     * the transcript and byte caps the source already enforces, so the flood is bounded by volume
     * rather than by time; the whole-exchange budget is the bound on time, and on a tight flood the
     * volume cap always reaches its limit first.
     *
     * What matters either way is the same, and is what these assert: however the exchange ends, it
     * ended with an acknowledgement still owed, so the session must stop rather than read on.
     */
    for (const kind of ["events", "fragments"]) {
        it(`stops with an owed reply when one is buried under a stream of ${kind}`, async () => {
            let armed = false;
            let watchdog;
            const running = runDiagnosticSession({
                flood: {id: "winpe-console", kind},
                responses: {"late-screenshot-1": value => { armed = true; return {return: {}, id: value.id}; }},
                timers: {
                    setTimer: (callback, milliseconds) => {
                        if (armed && milliseconds === WINPE_DIAGNOSTIC_EXCHANGE_BUDGET_MILLISECONDS) {
                            queueMicrotask(callback);
                            return 0;
                        }
                        return setTimeout(callback, 0);
                    },
                    clearTimer: handle => clearTimeout(handle)
                }
            });
            const session = await Promise.race([running, new Promise((resolve, reject) => {
                watchdog = setTimeout(() => reject(new Error(`a reply behind ${kind} was never bounded`)),
                    SETTLEMENT_WATCHDOG_MILLISECONDS);
            })]).finally(() => clearTimeout(watchdog));
            assert.equal(session.writes.map(value => value.id).includes("late-status-2"), false);
            assert.equal(session.late.milestones[1].unavailable.reason, "reader-unavailable");
        });
    }

    /*
     * The orphan itself, rather than the commands that come after it. The whole-exchange budget
     * bounds the exchange, not the read inside it: `withDeadline` never cancels its loser, so the
     * read that was mid-line when the budget fired is still parked on the shared iterator. A
     * fragment arriving after that would have it complete a message, consume it, and open another
     * `iterator.next()` on a reader that has already been closed to further traffic - taking bytes
     * no one owns and hiding them from anything that looked next.
     *
     * Checking abandonment once on entry cannot see this, because the loop was entered before the
     * exchange was given up. The fragment is deliberately delayed a turn past the abandon so the
     * reader is provably parked at the moment ownership ends.
     */
    it("stops consuming fragments once the exchange that owned them was abandoned", async () => {
        let fireBudget = null;
        let watchdog;
        const running = runDiagnosticSession({
            slowFlood: {id: "winpe-console", abandon: () => fireBudget?.()},
            timers: {
                setTimer: (callback, milliseconds) => {
                    /* Held, not fired: this budget ends the exchange on the flood's schedule. */
                    if (milliseconds === WINPE_DIAGNOSTIC_EXCHANGE_BUDGET_MILLISECONDS) {
                        fireBudget = callback;
                        return 0;
                    }
                    /*
                     * Pacing runs immediately, as everywhere else here, but a read deadline is left
                     * at its real length and unreferenced. The orphaned read is the subject of this
                     * test: firing its own deadline instantly would end it for a reason that has
                     * nothing to do with the guard, and the test would pass without the guard.
                     * Every other delay is pacing and runs immediately, as in the tests above.
                     */
                    if (milliseconds === PREDEADLINE_FRAME_COMMAND_TIMEOUT_MILLISECONDS) {
                        const handle = setTimeout(callback, milliseconds);
                        handle.unref?.();
                        return handle;
                    }
                    return setTimeout(callback, 0);
                },
                clearTimer: handle => clearTimeout(handle)
            }
        });
        const session = await Promise.race([running, new Promise((resolve, reject) => {
            watchdog = setTimeout(() => reject(new Error("the flooded exchange was never abandoned")),
                SETTLEMENT_WATCHDOG_MILLISECONDS);
        })]).finally(() => clearTimeout(watchdog));
        /* Long enough for an orphan still reading to take several more fragments. */
        await new Promise(resolve => setTimeout(resolve, ORPHAN_OBSERVATION_MILLISECONDS));
        assert.equal(session.floodReads(), FRAGMENTS_BEFORE_ABANDON,
            "no fragment may be consumed after the exchange that asked for it was abandoned");
        assert.equal(session.writes.map(value => value.id).includes("late-status-2"), false);
        assert.equal(session.late.milestones[1].unavailable.reason, "reader-unavailable");
    });

    /*
     * The symmetric half of the abandoned-read case. A bounded write shares the same deadline
     * mechanism and is equally uncancellable, so a write left pending owes a reply exactly as a
     * pending read does - the bytes may already have reached the monitor.
     */
    it("issues nothing further once a pending write is abandoned", async () => {
        let armed = false;
        let watchdog;
        const running = runDiagnosticSession({
            stallWrite: "winpe-console",
            /* Armed on the last exchange before the diagnostic, since a stalled write never replies. */
            responses: {"late-screenshot-1": value => { armed = true; return {return: {}, id: value.id}; }},
            timers: {
                setTimer: (callback, milliseconds) => {
                    if (armed && milliseconds === WINPE_DIAGNOSTIC_REPLY_TIMEOUT_MILLISECONDS) {
                        queueMicrotask(callback);
                        return 0;
                    }
                    return setTimeout(callback, 0);
                },
                clearTimer: handle => clearTimeout(handle)
            }
        });
        const session = await Promise.race([running, new Promise((resolve, reject) => {
            watchdog = setTimeout(() => reject(new Error("session did not settle after the abandoned write")),
                SETTLEMENT_WATCHDOG_MILLISECONDS);
        })]).finally(() => clearTimeout(watchdog));
        const issued = session.writes.map(value => value.id);
        assert.equal(issued.includes("late-status-2"), false, "no command may follow an abandoned write");
        assert.equal(session.late.milestones.length, 2);
        assert.equal(session.late.milestones[1].unavailable.reason, "reader-unavailable");
    });

    /*
     * The milestone record publishes a closed vocabulary, and what it discloses is what the
     * optional frames disclose: the provenance that names what happened to this command. Nothing
     * else records that, so collapsing it into the generic reason would lose the only account of
     * why the milestone was missed.
     */
    it("publishes the specific cause of a milestone its own command lost", async () => {
        let watchdog;
        const running = runDiagnosticSession({failWrite: "late-status-2"});
        const session = await Promise.race([running, new Promise((resolve, reject) => {
            watchdog = setTimeout(() => reject(new Error("the failed write never settled")),
                SETTLEMENT_WATCHDOG_MILLISECONDS);
        })]).finally(() => clearTimeout(watchdog));
        assert.equal(session.late.milestones[1].unavailable.reason, "qmp-write-failed",
            "a write that failed is the reason, and the record is the only place it is said");
        assert.equal(LATE_MILESTONE_UNAVAILABLE_REASONS.includes(
            session.late.milestones[1].unavailable.reason), true,
            "and it has to be a reason the record is allowed to publish");
    });

    it("stops when the phase closes between a write and its reply, with no deadline involved", async () => {
        let reads = 0;
        let jumpAt = null;
        const session = await runDiagnosticSession({
            responses: {"winpe-key-5": value => { jumpAt = reads + 1; return {return: {}, id: value.id}; }},
            nowHook: (index, current) => {
                reads = index;
                return jumpAt !== null && index >= jumpAt ?
                    current + WINPE_DIAGNOSTIC_PHASE_MILLISECONDS + 1 : current;
            }
        });
        const issued = session.writes.map(value => value.id);
        assert.equal(issued.includes("late-status-2"), false, "the reader owed a reply it never read");
        assert.equal(session.late.milestones.length, 2);
        assert.equal(session.late.milestones[1].unavailable.reason, "reader-unavailable");
    });

    it("still captures the +300s frame when the deadline aborts the sequence mid-line", async () => {
        let reads = 0;
        let jumpAt = null;
        const session = await runDiagnosticSession({
            responses: {"winpe-key-10": value => { jumpAt = reads + 2; return {return: {}, id: value.id}; }},
            nowHook: (index, current) => {
                reads = index;
                return jumpAt !== null && index >= jumpAt ?
                    current + WINPE_DIAGNOSTIC_PHASE_MILLISECONDS + 1 : current;
            }
        });
        assert.equal(session.late.winpeDiagnostic.status, "aborted");
        assert.equal(session.late.winpeDiagnostic.submitted, false);
        assert.equal(session.late.winpeDiagnostic.submittedOffsetMs, null);
        assert.match(session.late.winpeDiagnostic.failure, /phase deadline exceeded/u);
        assert.equal(session.late.winpeDiagnostic.acknowledgedKeyEvents, 11);
        assert.equal(session.late.milestones.length, 2);
        assert.equal(session.writes.filter(value => value.execute === "send-key").length, 11);
    });
});
