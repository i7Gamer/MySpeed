import assert from "node:assert/strict";
import crypto from "node:crypto";
import {describe, it} from "node:test";

import {
    INSTALLER_BOOT_CONFIRMATION,
    INSTALLER_BOOT_CONFIRMATION_AFTER_FIRST_FRAME,
    LATE_BOOT_MILESTONE_OFFSETS_MILLISECONDS,
    WINPE_DIAGNOSTIC_CONFIRMATION,
    WINPE_DIAGNOSTIC_CONSOLE_OPEN_MILLISECONDS,
    WINPE_DIAGNOSTIC_CONSOLE_QCODES,
    WINPE_DIAGNOSTIC_DRIVE_LETTERS,
    WINPE_DIAGNOSTIC_HOLD_MILLISECONDS,
    WINPE_DIAGNOSTIC_KEY_GAP_MILLISECONDS,
    WINPE_DIAGNOSTIC_LATEST_OFFSET_MILLISECONDS,
    WINPE_DIAGNOSTIC_PHASE_MILLISECONDS,
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

function transport(responses) {
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
    const readable = {[Symbol.asyncIterator]: () => ({
        next: () => pending.length > 0 ? Promise.resolve({value: pending.shift(), done: false}) :
            new Promise(resolve => { resolveChunk = resolve; })
    })};
    push({QMP: {version: {qemu: {major: 10, minor: 1, micro: 2}, package: ""}, capabilities: []}});
    return {writes, readable, writeBytes: bytes => {
        const value = JSON.parse(bytes.toString("utf8"));
        writes.push(value);
        const override = responses?.[value.id];
        push(override === undefined ? {return: {}, id: value.id} :
            typeof override === "function" ? override(value) : override);
    }};
}

const STATUS_RESPONSES = {
    status: {return: {running: true, status: "running"}, id: "status"},
    "late-status-1": {return: {running: true, status: "running"}, id: "late-status-1"},
    "late-status-2": {return: {running: true, status: "running"}, id: "late-status-2"}
};

/*
 * Only `now` and `wait` are injected. `cancellableDelay` falls through to `wait` when no timer
 * factory is supplied, which leaves the real `withDeadline` timers alone - a fake timer factory
 * would fire the per-message deadline instantly and prove nothing about pacing.
 */
async function runDiagnosticSession({responses, authorization = AUTHORIZATION, clock} = {}) {
    const bus = transport({...responses, ...STATUS_RESPONSES});
    let now = 0;
    const waits = [];
    let latePromise = null;
    await runEarlyBootQmpSession({
        readable: bus.readable, writeBytes: bus.writeBytes, screenshotPaths: SCREENSHOTS,
        lateScreenshotPaths: LATE_SCREENSHOTS, winpeDiagnostic: authorization,
        onLateObservation: promise => { latePromise = promise; }
    }, {
        now: () => now,
        wait: async milliseconds => { waits.push(milliseconds); now += clock?.(milliseconds) ?? milliseconds; }
    });
    return {late: await latePromise, writes: bus.writes, waits, elapsed: () => now};
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
            {submittedOffsetMs: null}, {submittedOffsetMs: WINPE_DIAGNOSTIC_LATEST_OFFSET_MILLISECONDS + 1},
            {scriptTag: "deadbeef"}, {commandSha256: "0".repeat(64)}, {status: "partial"},
            {failure: "x\u0000y"}, {kind: "installer-boot-confirmation"}])
            assert.throws(() => validateWinpeDiagnosticInput({...accepted, ...override}, AUTHORIZATION),
                /input is invalid/u);
        const aborted = {...accepted, acknowledgedKeyEvents: 3, submitted: false, status: "aborted",
            submittedOffsetMs: null, failure: "WinPE diagnostic phase deadline exceeded"};
        assert.deepEqual({...validateWinpeDiagnosticInput(aborted, AUTHORIZATION)}, aborted);
        assert.throws(() => validateWinpeDiagnosticInput({...aborted, submittedOffsetMs: 130_000},
            AUTHORIZATION), /input is invalid/u);
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
        assert.equal(late.milestones.length, 2, "the second frame still has to be taken");
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
