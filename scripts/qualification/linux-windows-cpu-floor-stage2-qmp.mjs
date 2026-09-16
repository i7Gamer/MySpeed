import crypto from "node:crypto";

const QMP_MESSAGE_TIMEOUT_MILLISECONDS = 10_000;
const QMP_SESSION_TIMEOUT_MILLISECONDS = 90_000;
const FIRST_SCREENSHOT_DELAY_MILLISECONDS = 5_000;
const SECOND_SCREENSHOT_DELAY_MILLISECONDS = 30_000;
const MAXIMUM_TRANSCRIPT_BYTES = 65_536;
const MAXIMUM_MESSAGES = 64;
/*
 * Stage 3 boots its own fresh install under a root of its own, bound to the same run nonce. It is
 * admitted for the two early frames only, exactly like the preflight below: Stage 3 opens no late
 * capture, so a late name under this root would widen the shared validator for a caller that has
 * no use for it. A Stage 3 keypress is never implied by this admission - it stays default-denied
 * and is authorized, if ever, only by an explicit request-bound confirmation.
 */
const STAGE3_ROOT_PATTERN = /^\/home\/runner\/work\/_temp\/myspeed-stage3-[a-f0-9]{32}$/u;
const INSTALLER_BOOT_CONFIRMATION_ROOT_PATTERN =
    /^\/home\/runner\/work\/_temp\/myspeed-(?:windows-cpu-floor|stage3)-[a-f0-9]{32}$/u;
/*
 * The containment preflight boots one disposable overlay under its own fixed child of the MSI
 * task root - not a row, and never a descendant of one. It is admitted for the two early frames
 * only: MSI enables no late capture, so a late name under this root would widen the shared
 * validator for a caller that has no use for it.
 */
const EARLY_ONLY_ROOT_SUFFIX = "/containment-preflight";
const SCREENSHOT_PATH_PATTERN = /^(\/home\/runner\/work\/_temp\/myspeed-(?:windows-(?:cpu-floor-[a-f0-9]{32}(?:\/post-release-baseline)?|msi-[a-f0-9]{32}\/(?:row-(?:0[0-9]|1[0-3])-[a-f0-9]{32}|containment-preflight))|stage3-[a-f0-9]{32}))\/(early|late)-boot-([12])\.png$/u;
const isEarlyOnlyRoot = root => root.endsWith(EARLY_ONLY_ROOT_SUFFIX) || STAGE3_ROOT_PATTERN.test(root);

export const LATE_BOOT_MILESTONE_OFFSETS_MILLISECONDS = Object.freeze([120_000, 300_000]);
export const MAX_LATE_BOOT_MILESTONES = 2;
export const INSTALLER_BOOT_CONFIRMATION = "single-enter-before-setup-v1";
export const INSTALLER_BOOT_CONFIRMATION_AFTER_FIRST_FRAME = "single-enter-after-first-frame-v2";
export const INSTALLER_BOOT_CONFIRMATION_QCODE = "ret";
export const INSTALLER_BOOT_CONFIRMATION_HOLD_MILLISECONDS = 100;
export const INSTALLER_BOOT_CONFIRMATION_REQUESTED_OFFSET_MILLISECONDS = 2_000;
export const INSTALLER_BOOT_CONFIRMATION_LATEST_OFFSET_MILLISECONDS = 3_000;
export const INSTALLER_BOOT_CONFIRMATION_AFTER_FIRST_FRAME_REQUESTED_OFFSET_MILLISECONDS = 5_000;
export const INSTALLER_BOOT_CONFIRMATION_AFTER_FIRST_FRAME_LATEST_OFFSET_MILLISECONDS = 6_000;

/*
 * The WinPE answer-file diagnostic.
 *
 * This is a separate authorization, not a third installer-boot-confirmation policy. The two boot
 * policies answer a firmware prompt before Setup exists; this one types one fixed line into a WinPE
 * console long after Setup has started, so sharing their field would let a boot-policy request reach
 * a keyboard sequence it never asked for. The undefined/v1/v2 contracts above are untouched by it,
 * and `validateInstallerBootConfirmation` still refuses this confirmation string.
 *
 * What it proves and what it cannot. A QMP reply proves the monitor accepted a `send-key`; it proves
 * nothing about guest-side receipt, about the guest having focus, or about a key having been
 * released. The whole sequence is therefore best-effort evidence gathering whose only host-side
 * assertion is "these exact events were accepted at these offsets"; whether a console opened and
 * read them is settled, if at all, by the guest's own collected output and the +300s frame.
 */
export const WINPE_DIAGNOSTIC_CONFIRMATION = "winpe-answer-file-diagnostic-v1";
/*
 * The executed script's name is a salted digest of the run nonce, truncated to an 8.3-safe base
 * name so it resolves under Joliet and under ISO 9660's 8.3 fallback alike. It is collision
 * avoidance and a pre-execution guard on a name that cannot be guessed from the retained frame - it
 * is NOT authentication and NOT proof of a unique seed volume. The script itself re-verifies the
 * trusted seed identity before it collects anything.
 */
const WINPE_DIAGNOSTIC_TAG_SALT = "myspeed-winpe-answer-file-diagnostic-v1";
export const WINPE_DIAGNOSTIC_TAG_LENGTH = 8;
/*
 * Every standard fixed-disk/optical letter except X, which WinPE itself occupies. C-H was an
 * avoidable limit: Windows Setup places the boot media and any extra volume wherever it likes, and a
 * seed that landed on I would have been invisible. The set is fixed and closed - this is a bounded
 * probe for one derived filename, never a general script search.
 */
export const WINPE_DIAGNOSTIC_DRIVE_LETTERS = Object.freeze(
    [..."cdefghijklmnopqrstuvwyz"]);
export const WINPE_DIAGNOSTIC_HOLD_MILLISECONDS = 30;
/*
 * The gap is measured from the monitor's reply to the previous key and is strictly longer than the
 * hold, so the release of key N is due before key N+1 is written. Nothing here depends on QEMU's
 * internal key-queue semantics, and neither figure is evidence that the guest observed either edge.
 */
export const WINPE_DIAGNOSTIC_KEY_GAP_MILLISECONDS = 60;
export const WINPE_DIAGNOSTIC_CONSOLE_QCODES = Object.freeze(["shift", "f10"]);
export const WINPE_DIAGNOSTIC_CONSOLE_OPEN_MILLISECONDS = 2_000;
export const WINPE_DIAGNOSTIC_SUBMIT_QCODE = "ret";
/* Per-reply allowance and the whole-phase bound, both enforced on every write, read and delay. */
export const WINPE_DIAGNOSTIC_REPLY_TIMEOUT_MILLISECONDS = 10_000;
export const WINPE_DIAGNOSTIC_PHASE_MILLISECONDS = 60_000;
/*
 * The phase opens after the +120s frame and must be finished well before the +300s frame that
 * observes its effect, so the sequence can never straddle the milestone it is evidence for.
 */
export const WINPE_DIAGNOSTIC_LATEST_OFFSET_MILLISECONDS = 240_000;
/*
 * The deadline gates the start of an exchange, never its acknowledgement, so the last offset a
 * record can hold is one reply timeout past the latest offset. Derived from the two bounds rather
 * than chosen, so neither can be widened without widening this with it.
 */
export const WINPE_DIAGNOSTIC_LATEST_RECORDED_OFFSET_MILLISECONDS =
    WINPE_DIAGNOSTIC_LATEST_OFFSET_MILLISECONDS + WINPE_DIAGNOSTIC_REPLY_TIMEOUT_MILLISECONDS;
/* Measured against the shipped reader: the longest reply this session sees is 45 bytes. */
export const WINPE_DIAGNOSTIC_REPLY_BYTES = 64;

const WINPE_DIAGNOSTIC_QCODE_BY_CHARACTER = new Map([
    [" ", ["spc"]], [".", ["dot"]], ["\\", ["backslash"]],
    [":", ["shift", "semicolon"]], ["%", ["shift", "5"]], ["(", ["shift", "9"]],
    [")", ["shift", "0"]], ["@", ["shift", "2"]],
    ...[..."abcdefghijklmnopqrstuvwxyz"].map(character => [character, [character]]),
    ...[..."0123456789"].map(character => [character, [character]])
]);

const NONCE_PATTERN = /^[a-f0-9]{32}$/u;

export function winpeDiagnosticScriptTag(nonce) {
    if (typeof nonce !== "string" || !NONCE_PATTERN.test(nonce))
        throw new TypeError("WinPE diagnostic nonce is invalid");
    return crypto.createHash("sha256").update(`${nonce}|${WINPE_DIAGNOSTIC_TAG_SALT}`)
        .digest("hex").slice(0, WINPE_DIAGNOSTIC_TAG_LENGTH);
}

export function winpeDiagnosticScriptName(nonce) { return `${winpeDiagnosticScriptTag(nonce)}.cmd`; }

export function winpeDiagnosticCommand(nonce) {
    const letters = WINPE_DIAGNOSTIC_DRIVE_LETTERS.join(" ");
    return `for %d in (${letters}) do @call %d:\\${winpeDiagnosticScriptName(nonce)}`;
}

/*
 * The complete key encoding, derived from the command text rather than declared beside it, so a
 * command this table cannot express fails here instead of typing something else into the guest.
 */
export function encodeWinpeDiagnosticKeys(command) {
    if (typeof command !== "string" || command.length < 1)
        throw new TypeError("WinPE diagnostic command is invalid");
    return Object.freeze([...command].map((character, index) => {
        const qcodes = WINPE_DIAGNOSTIC_QCODE_BY_CHARACTER.get(character);
        if (qcodes === undefined)
            throw new TypeError(`WinPE diagnostic command character ${index} is not encodable`);
        return Object.freeze({character, qcodes: Object.freeze([...qcodes])});
    }));
}

/*
 * Derived from the exact sequence, never chosen: one console shortcut, one event per character, one
 * submit. The default ceilings stay where they are and the diagnostic keeps exactly today's
 * headroom for asynchronous events on top of its own traffic.
 */
export function winpeDiagnosticBudget(nonce) {
    const command = winpeDiagnosticCommand(nonce);
    const keyEvents = 1 + encodeWinpeDiagnosticKeys(command).length + 1;
    return Object.freeze({command, keyEvents,
        maximumMessages: MAXIMUM_MESSAGES + keyEvents,
        maximumTranscriptBytes: MAXIMUM_TRANSCRIPT_BYTES + keyEvents * WINPE_DIAGNOSTIC_REPLY_BYTES});
}

export function validateWinpeDiagnosticAuthorization(value) {
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).length !== 2 || value.confirmation !== WINPE_DIAGNOSTIC_CONFIRMATION ||
        typeof value.nonce !== "string" || !NONCE_PATTERN.test(value.nonce))
        throw new TypeError("WinPE diagnostic authorization is invalid");
    return Object.freeze({confirmation: value.confirmation, nonce: value.nonce});
}

const WINPE_DIAGNOSTIC_INPUT_KEYS = ["acknowledgedKeyEvents", "commandSha256", "confirmation",
    "consoleOpenedOffsetMs", "failure", "firstKeyOffsetMs", "keyEvents", "kind", "schemaVersion",
    "scriptTag", "status", "submitted", "submittedOffsetMs"];
export const WINPE_DIAGNOSTIC_INPUT_KIND = "winpe-answer-file-diagnostic-input";

export function validateWinpeDiagnosticInput(value, authorization) {
    const checked = validateWinpeDiagnosticAuthorization(authorization);
    if (checked === undefined) throw new TypeError("WinPE diagnostic input is not authorized");
    const budget = winpeDiagnosticBudget(checked.nonce);
    const offset = candidate => Number.isSafeInteger(candidate) && candidate >= 0 &&
        candidate <= WINPE_DIAGNOSTIC_LATEST_RECORDED_OFFSET_MILLISECONDS;
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(WINPE_DIAGNOSTIC_INPUT_KEYS) ||
        value.schemaVersion !== 1 || value.kind !== WINPE_DIAGNOSTIC_INPUT_KIND ||
        value.confirmation !== checked.confirmation ||
        value.scriptTag !== winpeDiagnosticScriptTag(checked.nonce) ||
        value.commandSha256 !== crypto.createHash("sha256").update(budget.command).digest("hex") ||
        value.keyEvents !== budget.keyEvents ||
        !Number.isSafeInteger(value.acknowledgedKeyEvents) || value.acknowledgedKeyEvents < 0 ||
        value.acknowledgedKeyEvents > budget.keyEvents ||
        !["submitted", "aborted"].includes(value.status) ||
        value.submitted !== (value.status === "submitted") ||
        value.submitted !== (value.acknowledgedKeyEvents === budget.keyEvents) ||
        (value.consoleOpenedOffsetMs !== null && !offset(value.consoleOpenedOffsetMs)) ||
        (value.firstKeyOffsetMs !== null && !offset(value.firstKeyOffsetMs)) ||
        (value.submittedOffsetMs !== null && !offset(value.submittedOffsetMs)) ||
        (value.submitted && value.submittedOffsetMs === null) ||
        (!value.submitted && value.submittedOffsetMs !== null) ||
        (value.failure !== null && (typeof value.failure !== "string" || value.failure.length < 1 ||
            value.failure.length > 512 || /[\x00-\x1f\x7f]/u.test(value.failure))))
        throw new TypeError("WinPE diagnostic input is invalid");
    return Object.freeze({...value});
}

function delay(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }

export function validateScreenshots(paths) {
    if (!Array.isArray(paths) || paths.length !== 2) throw new TypeError("QMP screenshot path set is invalid");
    const matches = paths.map(value => typeof value === "string" ? value.match(SCREENSHOT_PATH_PATTERN) : null);
    if (!matches[0] || !matches[1] || matches[0][1] !== matches[1][1] ||
        matches[0][2] !== "early" || matches[1][2] !== "early" ||
        matches[0][3] !== "1" || matches[1][3] !== "2")
        throw new TypeError("QMP screenshot path is invalid");
    return [...paths];
}

export function validateLateScreenshots(paths) {
    if (!Array.isArray(paths) || paths.length !== MAX_LATE_BOOT_MILESTONES)
        throw new TypeError("QMP late screenshot path set is invalid");
    const matches = paths.map(value => typeof value === "string" ? value.match(SCREENSHOT_PATH_PATTERN) : null);
    if (!matches[0] || !matches[1] || matches[0][1] !== matches[1][1] ||
        matches[0][2] !== "late" || matches[1][2] !== "late" ||
        matches[0][3] !== "1" || matches[1][3] !== "2" ||
        isEarlyOnlyRoot(matches[0][1]))
        throw new TypeError("QMP late screenshot path is invalid");
    return [...paths];
}

export function validateInstallerBootConfirmation(value) {
    if (value === undefined || value === INSTALLER_BOOT_CONFIRMATION ||
        value === INSTALLER_BOOT_CONFIRMATION_AFTER_FIRST_FRAME) return value;
    throw new TypeError("QMP installer boot confirmation is invalid");
}

export function validateInstallerBootInput(value, policy) {
    validateInstallerBootConfirmation(policy);
    if (policy === undefined) {
        if (value === false) return false;
        throw new TypeError("QMP installer boot input is invalid");
    }
    const afterFirstScreenshotAck = policy === INSTALLER_BOOT_CONFIRMATION_AFTER_FIRST_FRAME;
    const requestedOffsetMilliseconds = afterFirstScreenshotAck ?
        INSTALLER_BOOT_CONFIRMATION_AFTER_FIRST_FRAME_REQUESTED_OFFSET_MILLISECONDS :
        INSTALLER_BOOT_CONFIRMATION_REQUESTED_OFFSET_MILLISECONDS;
    const latestOffsetMilliseconds = afterFirstScreenshotAck ?
        INSTALLER_BOOT_CONFIRMATION_AFTER_FIRST_FRAME_LATEST_OFFSET_MILLISECONDS :
        INSTALLER_BOOT_CONFIRMATION_LATEST_OFFSET_MILLISECONDS;
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        value.kind !== "installer-boot-confirmation" || value.qcode !== INSTALLER_BOOT_CONFIRMATION_QCODE ||
        value.holdMilliseconds !== INSTALLER_BOOT_CONFIRMATION_HOLD_MILLISECONDS ||
        value.requestedOffsetMilliseconds !== requestedOffsetMilliseconds ||
        !Number.isFinite(value.sentOffsetMilliseconds) ||
        value.sentOffsetMilliseconds < requestedOffsetMilliseconds ||
        value.sentOffsetMilliseconds > latestOffsetMilliseconds || value.acknowledged !== true ||
        (afterFirstScreenshotAck ? value.afterFirstScreenshotAck !== true || Object.keys(value).length !== 7 :
            Object.hasOwn(value, "afterFirstScreenshotAck") || Object.keys(value).length !== 6))
        throw new TypeError("QMP installer boot input is invalid");
    return Object.freeze({...value});
}

function cancellableDelay(milliseconds, dependencies, session) {
    if (session.cancelled || session.expired || milliseconds <= 0) return Promise.resolve();
    if (dependencies.setTimer) {
        const clearTimer = dependencies.clearTimer ?? clearTimeout;
        return new Promise(resolve => {
            let timer = null;
            const done = () => {
                if (timer !== null) clearTimer(timer);
                session.activeTimer = null;
                session.onCancel = null;
                resolve();
            };
            session.onCancel = done;
            timer = dependencies.setTimer(done, milliseconds);
            session.activeTimer = timer;
        });
    }
    if (dependencies.wait) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const done = () => {
                if (settled) return;
                settled = true;
                session.onCancel = null;
                resolve();
            };
            const fail = error => {
                if (settled) return;
                settled = true;
                session.onCancel = null;
                reject(error);
            };
            session.onCancel = done;
            Promise.resolve(dependencies.wait(milliseconds)).then(done, fail);
        });
    }
    const clearTimer = dependencies.clearTimer ?? clearTimeout;
    const setTimer = dependencies.setTimer ?? setTimeout;
    return new Promise(resolve => {
        let timer = null;
        const done = () => {
            if (timer !== null) clearTimer(timer);
            session.activeTimer = null;
            session.onCancel = null;
            resolve();
        };
        session.onCancel = done;
        timer = setTimer(done, milliseconds);
        session.activeTimer = timer;
    });
}

function withDeadline(promise, dependencies, milliseconds = QMP_MESSAGE_TIMEOUT_MILLISECONDS,
    onDeadline = () => undefined) {
    const setTimer = dependencies.setTimer ?? setTimeout;
    const clearTimer = dependencies.clearTimer ?? clearTimeout;
    let timer;
    const deadline = new Promise((resolve, reject) => {
        timer = setTimer(() => { onDeadline(); reject(new Error("QMP response deadline exceeded")); }, milliseconds);
    });
    return Promise.race([promise, deadline]).finally(() => clearTimer(timer));
}

function createMessageReader(readable, dependencies, bounds = {}) {
    if (!readable || typeof readable[Symbol.asyncIterator] !== "function")
        throw new TypeError("QMP readable stream is invalid");
    const maximumMessages = bounds.maximumMessages ?? MAXIMUM_MESSAGES;
    const maximumTranscriptBytes = bounds.maximumTranscriptBytes ?? MAXIMUM_TRANSCRIPT_BYTES;
    if (maximumMessages < MAXIMUM_MESSAGES || maximumTranscriptBytes < MAXIMUM_TRANSCRIPT_BYTES)
        throw new TypeError("QMP transcript bounds are invalid");
    const iterator = readable[Symbol.asyncIterator]();
    let buffered = Buffer.alloc(0), totalBytes = 0, messages = 0;
    return async () => {
        while (true) {
            const newline = buffered.indexOf(0x0a);
            if (newline >= 0) {
                let line = buffered.subarray(0, newline);
                buffered = buffered.subarray(newline + 1);
                if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
                if (line.length < 2) throw new Error("QMP JSON message is invalid");
                messages += 1;
                if (messages > maximumMessages) throw new Error("QMP transcript bound exceeded");
                try {
                    const value = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(line));
                    if (!value || typeof value !== "object" || Array.isArray(value))
                        throw new Error("QMP JSON message is invalid");
                    return value;
                } catch (error) {
                    throw new Error("QMP JSON message is invalid", {cause: error});
                }
            }
            const next = await withDeadline(iterator.next(), dependencies);
            if (next.done) throw new Error("QMP stream ended before response");
            const chunk = Buffer.from(next.value);
            totalBytes += chunk.length;
            if (totalBytes > maximumTranscriptBytes) throw new Error("QMP transcript bound exceeded");
            buffered = Buffer.concat([buffered, chunk]);
        }
    };
}

async function expectResponse(readMessage, id) {
    while (true) {
        const value = await readMessage();
        if (value.event !== undefined) continue;
        if (value.id !== id || value.error !== undefined || value.return === undefined)
            throw new Error("QMP response is invalid");
        return value.return;
    }
}

async function runSession(input, dependencies, session) {
    const screenshotPaths = validateScreenshots(input?.screenshotPaths);
    const lateScreenshotPaths = input?.lateScreenshotPaths !== undefined ?
        validateLateScreenshots(input.lateScreenshotPaths) : null;
    const bootConfirmation = validateInstallerBootConfirmation(input?.bootConfirmation);
    const winpeDiagnostic = validateWinpeDiagnosticAuthorization(input?.winpeDiagnostic);
    const screenshotRoot = screenshotPaths[0].slice(0, -"/early-boot-1.png".length);
    if (bootConfirmation !== undefined && !INSTALLER_BOOT_CONFIRMATION_ROOT_PATTERN.test(screenshotRoot))
        throw new TypeError("QMP installer boot confirmation root is invalid");
    /*
     * The diagnostic is bound to this exact run: its nonce has to be the one in the root it is
     * typing on behalf of, and it has no meaning without the late capture whose first frame opens
     * its one window.
     */
    if (winpeDiagnostic !== undefined &&
        (lateScreenshotPaths === null ||
            screenshotRoot !== `/home/runner/work/_temp/myspeed-windows-cpu-floor-${winpeDiagnostic.nonce}`))
        throw new TypeError("QMP WinPE diagnostic root is invalid");
    if (typeof input.writeBytes !== "function") throw new TypeError("QMP writer is invalid");

    const cancelSession = () => {
        session.cancelled = true;
        if (session.activeTimer !== null) {
            const clearTimer = dependencies.clearTimer ?? clearTimeout;
            clearTimer(session.activeTimer);
            session.activeTimer = null;
        }
        if (typeof session.onCancel === "function") {
            session.onCancel();
        }
    };
    input.onSession?.({cancel: cancelSession});

    const readMessage = createMessageReader(input.readable, dependencies, winpeDiagnostic === undefined ? {} :
        winpeDiagnosticBudget(winpeDiagnostic.nonce));
    const getTime = dependencies.now ?? (() => performance.now());
    const sessionStartTime = getTime();
    const greeting = await readMessage();
    const version = greeting?.QMP?.version?.qemu;
    if (![version?.major, version?.minor, version?.micro].every(value => Number.isSafeInteger(value) && value >= 0) ||
        !Array.isArray(greeting?.QMP?.capabilities) ||
        !greeting.QMP.capabilities.every(value => typeof value === "string"))
        throw new Error("QMP greeting is invalid");
    const write = (value, beforeWrite = () => undefined) => {
        if (session.expired || session.cancelled) return Promise.reject(new Error("QMP session deadline exceeded"));
        return withDeadline(Promise.resolve().then(() => {
            if (session.expired || session.cancelled) throw new Error("QMP session deadline exceeded");
            beforeWrite();
            return input.writeBytes(Buffer.from(`${JSON.stringify(value)}\n`));
        }), dependencies);
    };
    await write({execute: "qmp_capabilities", id: "capabilities"});
    await expectResponse(readMessage, "capabilities");
    await write({execute: "query-status", id: "status"});
    const status = await expectResponse(readMessage, "status");
    if (typeof status.running !== "boolean" || typeof status.status !== "string" || status.status.length < 1)
        throw new Error("QMP status response is invalid");
    let inputSent = false;
    if (bootConfirmation !== undefined) {
        if (status.running !== true || status.status !== "running")
            throw new Error("QMP installer boot confirmation requires a running guest");
    }
    const sendInstallerBootConfirmation = async () => {
        const afterFirstScreenshotAck = bootConfirmation === INSTALLER_BOOT_CONFIRMATION_AFTER_FIRST_FRAME;
        const requestedOffsetMilliseconds = afterFirstScreenshotAck ?
            INSTALLER_BOOT_CONFIRMATION_AFTER_FIRST_FRAME_REQUESTED_OFFSET_MILLISECONDS :
            INSTALLER_BOOT_CONFIRMATION_REQUESTED_OFFSET_MILLISECONDS;
        const latestOffsetMilliseconds = afterFirstScreenshotAck ?
            INSTALLER_BOOT_CONFIRMATION_AFTER_FIRST_FRAME_LATEST_OFFSET_MILLISECONDS :
            INSTALLER_BOOT_CONFIRMATION_LATEST_OFFSET_MILLISECONDS;
        const elapsed = getTime() - sessionStartTime;
        if (elapsed > latestOffsetMilliseconds)
            throw new Error("QMP installer boot confirmation window elapsed");
        if (!afterFirstScreenshotAck)
            await cancellableDelay(Math.max(0, requestedOffsetMilliseconds - elapsed), dependencies, session);
        if (session.cancelled || session.expired)
            throw new Error("QMP installer boot confirmation cancelled");
        let sentOffsetMilliseconds = null;
        await write({execute: "send-key", arguments: {keys: [{type: "qcode", data: INSTALLER_BOOT_CONFIRMATION_QCODE}],
            "hold-time": INSTALLER_BOOT_CONFIRMATION_HOLD_MILLISECONDS}, id: "installer-boot-confirmation"}, () => {
            sentOffsetMilliseconds = getTime() - sessionStartTime;
            if (!Number.isFinite(sentOffsetMilliseconds) ||
                sentOffsetMilliseconds < requestedOffsetMilliseconds || sentOffsetMilliseconds > latestOffsetMilliseconds)
                throw new Error("QMP installer boot confirmation window elapsed");
        });
        await expectResponse(readMessage, "installer-boot-confirmation");
        // A QMP acknowledgement proves only monitor acceptance, never guest-side receipt.
        return validateInstallerBootInput({kind: "installer-boot-confirmation",
            qcode: INSTALLER_BOOT_CONFIRMATION_QCODE, holdMilliseconds: INSTALLER_BOOT_CONFIRMATION_HOLD_MILLISECONDS,
            requestedOffsetMilliseconds, sentOffsetMilliseconds, acknowledged: true,
            ...(afterFirstScreenshotAck ? {afterFirstScreenshotAck: true} : {})}, bootConfirmation);
    };
    if (bootConfirmation === INSTALLER_BOOT_CONFIRMATION)
        inputSent = await sendInstallerBootConfirmation();
    const wait = dependencies.wait ?? delay;
    const firstScreenshotDelay = bootConfirmation === undefined ? FIRST_SCREENSHOT_DELAY_MILLISECONDS :
        Math.max(0, FIRST_SCREENSHOT_DELAY_MILLISECONDS - (getTime() - sessionStartTime));
    for (const [index, milliseconds] of [firstScreenshotDelay,
        SECOND_SCREENSHOT_DELAY_MILLISECONDS].entries()) {
        await wait(milliseconds);
        const id = `screenshot-${index + 1}`;
        await write({execute: "screendump", arguments: {filename: screenshotPaths[index], format: "png"}, id});
        await expectResponse(readMessage, id);
        if (index === 0 && bootConfirmation === INSTALLER_BOOT_CONFIRMATION_AFTER_FIRST_FRAME)
            inputSent = await sendInstallerBootConfirmation();
    }
    const earlyResult = Object.freeze({version: Object.freeze({...version}), status: status.status, running: status.running,
        screenshotPaths: Object.freeze(screenshotPaths), inputSent});

    if (lateScreenshotPaths !== null) {
        /*
         * One sealed sequence, at most once, opened only after the +120s frame has been taken and
         * acknowledged. There is no retry: a failure anywhere leaves `submitted: false`, and because
         * the submit key is the last event of the sequence, an abort can never leave a partial line
         * executing - it leaves an unsubmitted line in a console nothing will read.
         */
        const diagnosticState = {attempted: false};
        const runWinpeDiagnostic = async () => {
            if (winpeDiagnostic === undefined || diagnosticState.attempted) return null;
            diagnosticState.attempted = true;
            const budget = winpeDiagnosticBudget(winpeDiagnostic.nonce);
            const keys = encodeWinpeDiagnosticKeys(budget.command);
            const phaseStart = getTime();
            const record = {schemaVersion: 1, kind: WINPE_DIAGNOSTIC_INPUT_KIND,
                confirmation: winpeDiagnostic.confirmation,
                scriptTag: winpeDiagnosticScriptTag(winpeDiagnostic.nonce),
                commandSha256: crypto.createHash("sha256").update(budget.command).digest("hex"),
                keyEvents: budget.keyEvents, acknowledgedKeyEvents: 0, consoleOpenedOffsetMs: null,
                firstKeyOffsetMs: null, submittedOffsetMs: null, submitted: false, status: "aborted",
                failure: null};
            /*
             * Checked before every single write, read and delay - not once at the top. A phase that
             * has run out of either its own allowance or the room before the +300s frame stops
             * where it stands rather than pushing the milestone it exists to observe.
             */
            const assertPhaseOpen = () => {
                if (session.cancelled || session.expired) throw new Error("WinPE diagnostic cancelled");
                const now = getTime();
                if (now - phaseStart > WINPE_DIAGNOSTIC_PHASE_MILLISECONDS ||
                    now - sessionStartTime > WINPE_DIAGNOSTIC_LATEST_OFFSET_MILLISECONDS)
                    throw new Error("WinPE diagnostic phase deadline exceeded");
                return now;
            };
            /*
             * `final` marks the key nothing follows. The deadline still gates that key's write and
             * its read; what it must not do is fire once the monitor has already acknowledged the
             * submit, because there is no next action left to stop and discarding the record would
             * cost the +300s frame the whole phase exists to observe.
             */
            const sendKey = async (qcodes, id, final = false) => {
                assertPhaseOpen();
                await withDeadline(write({execute: "send-key", arguments: {
                    keys: qcodes.map(data => ({type: "qcode", data})),
                    "hold-time": WINPE_DIAGNOSTIC_HOLD_MILLISECONDS}, id}), dependencies,
                WINPE_DIAGNOSTIC_REPLY_TIMEOUT_MILLISECONDS);
                assertPhaseOpen();
                await withDeadline(expectResponse(readMessage, id), dependencies,
                    WINPE_DIAGNOSTIC_REPLY_TIMEOUT_MILLISECONDS);
                record.acknowledgedKeyEvents += 1;
                return final ? getTime() : assertPhaseOpen();
            };
            try {
                record.consoleOpenedOffsetMs = Math.round(
                    await sendKey([...WINPE_DIAGNOSTIC_CONSOLE_QCODES], "winpe-console") - sessionStartTime);
                await cancellableDelay(WINPE_DIAGNOSTIC_CONSOLE_OPEN_MILLISECONDS, dependencies, session);
                for (const [index, key] of keys.entries()) {
                    assertPhaseOpen();
                    const at = await sendKey([...key.qcodes], `winpe-key-${index + 1}`);
                    if (index === 0) record.firstKeyOffsetMs = Math.round(at - sessionStartTime);
                    await cancellableDelay(WINPE_DIAGNOSTIC_KEY_GAP_MILLISECONDS, dependencies, session);
                }
                const submitted = await sendKey([WINPE_DIAGNOSTIC_SUBMIT_QCODE], "winpe-submit", true);
                record.submittedOffsetMs = Math.round(submitted - sessionStartTime);
                record.submitted = true;
                record.status = "submitted";
            } catch (error) {
                record.failure = (error instanceof Error ? error.message : String(error))
                    .replace(/[\x00-\x1f\x7f]+/gu, " ").slice(0, 512) || "unspecified failure";
            }
            return validateWinpeDiagnosticInput(record, winpeDiagnostic);
        };
        const runLateMilestones = async () => {
            const milestones = [];
            let winpeDiagnosticRecord = null;
            try {
                for (let i = 0; i < MAX_LATE_BOOT_MILESTONES; i += 1) {
                    if (session.cancelled || session.expired) break;
                    const targetOffset = LATE_BOOT_MILESTONE_OFFSETS_MILLISECONDS[i];
                    const elapsed = getTime() - sessionStartTime;
                    const remaining = Math.max(0, targetOffset - elapsed);
                    await cancellableDelay(remaining, dependencies, session);
                    if (session.cancelled || session.expired) break;
                    const milestoneIndex = i + 1;
                    const statusId = `late-status-${milestoneIndex}`;
                    await write({execute: "query-status", id: statusId});
                    const lateStatus = await expectResponse(readMessage, statusId);
                    if (session.cancelled || session.expired) break;
                    const screenshotId = `late-screenshot-${milestoneIndex}`;
                    await write({execute: "screendump", arguments: {
                        filename: lateScreenshotPaths[i], format: "png"
                    }, id: screenshotId});
                    await expectResponse(readMessage, screenshotId);
                    milestones.push(Object.freeze({
                        milestone: milestoneIndex,
                        offsetMs: targetOffset,
                        status: lateStatus.status,
                        running: lateStatus.running,
                        screenshotPath: lateScreenshotPaths[i]
                    }));
                    /*
                     * The one window: after the first frame is on disk and before the wait for the
                     * second one starts. Its own failure never breaks the milestone loop, because
                     * the second frame is part of the evidence about whether the input landed.
                     */
                    if (milestoneIndex === 1 && winpeDiagnostic !== undefined)
                        /*
                         * Its own catch, not the loop's: the loop's `catch` ends every remaining
                         * milestone, so a record that cannot be validated must cost this loop
                         * nothing. An absent record is reported as inconclusive downstream, which
                         * is the honest outcome; a missing second frame would not be.
                         */
                        try { winpeDiagnosticRecord = await runWinpeDiagnostic(); }
                        catch { winpeDiagnosticRecord = null; }
                }
            } catch {
                // Non-blocking failure handled gracefully
            }
            if (milestones.length === 0 && winpeDiagnosticRecord === null) return null;
            return Object.freeze({
                schemaVersion: 1,
                kind: "qemu-late-boot-observation",
                milestones: Object.freeze(milestones),
                ...(winpeDiagnosticRecord === null ? {} : {winpeDiagnostic: winpeDiagnosticRecord})
            });
        };
        const latePromise = runLateMilestones();
        latePromise.catch(() => undefined);
        input.onLateObservation?.(latePromise);
    }

    return earlyResult;
}

export function runEarlyBootQmpSession(input, dependencies = {}) {
    const session = {expired: false, cancelled: false, activeTimer: null, onCancel: null};
    return withDeadline(runSession(input, dependencies, session), dependencies, QMP_SESSION_TIMEOUT_MILLISECONDS,
        () => { session.expired = true; if (typeof session.onCancel === "function") session.onCancel(); });
}
