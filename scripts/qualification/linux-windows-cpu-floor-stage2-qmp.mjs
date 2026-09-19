import crypto from "node:crypto";

const QMP_MESSAGE_TIMEOUT_MILLISECONDS = 10_000;
const QMP_SESSION_TIMEOUT_MILLISECONDS = 90_000;
const FIRST_SCREENSHOT_DELAY_MILLISECONDS = 5_000;
const SECOND_SCREENSHOT_DELAY_MILLISECONDS = 30_000;
const MAXIMUM_TRANSCRIPT_BYTES = 65_536;
const MAXIMUM_MESSAGES = 64;
/*
 * QEMU 8.2.2's closed `ShutdownCause` enum. A `SHUTDOWN` event whose `data.reason` is outside this
 * set is a protocol failure, not an unrecognized-but-valid cause: this harness pins an exact QEMU
 * build, so a reason this set does not name did not come from that build behaving normally.
 */
export const QMP_SHUTDOWN_CAUSES = Object.freeze(["none", "host-error", "host-qmp-quit",
    "host-qmp-system-reset", "host-signal", "host-ui", "guest-shutdown", "guest-reset", "guest-panic",
    "subsystem-reset", "snapshot-load"]);
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

const PREDEADLINE_FRAME_PATH_PATTERN =
    /^\/home\/runner\/work\/_temp\/myspeed-windows-cpu-floor-[a-f0-9]{32}\/predeadline-frame\.png$/u;
export const PREDEADLINE_FRAME_COMMAND_TIMEOUT_MILLISECONDS = QMP_MESSAGE_TIMEOUT_MILLISECONDS;
export const PREDEADLINE_FRAME_TICK_JITTER_MILLISECONDS = 5_000;
export const PREDEADLINE_FRAME_CLEANUP_HEADROOM_MILLISECONDS = 5_000;
export const PREDEADLINE_FRAME_LEAD_MILLISECONDS =
    PREDEADLINE_FRAME_COMMAND_TIMEOUT_MILLISECONDS +
    PREDEADLINE_FRAME_TICK_JITTER_MILLISECONDS +
    PREDEADLINE_FRAME_CLEANUP_HEADROOM_MILLISECONDS;
export const PREDEADLINE_FRAME_FILENAME = "predeadline-frame.png";

export function validatePredeadlineScreenshotPath(value) {
    if (typeof value !== "string" || !PREDEADLINE_FRAME_PATH_PATTERN.test(value))
        throw new TypeError("QMP predeadline screenshot path is invalid");
    return value;
}

/*
 * Two optional, fixed, named diagnostic samples taken inside the existing 25-minute window - never a
 * third, never a caller-chosen offset. They only ever run when the CPU-specific caller opts in
 * explicitly; every other caller (generic MSI requests, WinPE diagnostic, Stage 3) is unaffected by
 * their mere existence in this file.
 */
export const MID_WINDOW_SAMPLE_OFFSETS_MILLISECONDS = Object.freeze([600_000, 900_000]);
export const MID_WINDOW_FRAME_FILENAMES = Object.freeze(["mid-window-frame-1.png", "mid-window-frame-2.png"]);
export const MID_WINDOW_COMMAND_TIMEOUT_MILLISECONDS = QMP_MESSAGE_TIMEOUT_MILLISECONDS;
/*
 * A named margin held back on top of the command's own timeout budget, distinct from and additive to
 * PREDEADLINE_FRAME_LEAD_MILLISECONDS (which already reserves the predeadline command's own timeout,
 * jitter, and cleanup headroom). This margin is mid-window's own scheduling slack, not a second copy
 * of predeadline's reserve.
 */
export const MID_WINDOW_SCHEDULING_MARGIN_MILLISECONDS = 5_000;

const MID_WINDOW_FRAME_PATH_PATTERNS = Object.freeze([
    /^\/home\/runner\/work\/_temp\/myspeed-windows-cpu-floor-[a-f0-9]{32}\/mid-window-frame-1\.png$/u,
    /^\/home\/runner\/work\/_temp\/myspeed-windows-cpu-floor-[a-f0-9]{32}\/mid-window-frame-2\.png$/u
]);

export function validateMidWindowScreenshotPaths(value) {
    if (!Array.isArray(value) || value.length !== MID_WINDOW_FRAME_FILENAMES.length)
        throw new TypeError("QMP mid-window screenshot paths are invalid");
    value.forEach((item, index) => {
        if (typeof item !== "string" || !MID_WINDOW_FRAME_PATH_PATTERNS[index].test(item))
            throw new TypeError("QMP mid-window screenshot paths are invalid");
    });
    // A defensive copy: the validated array must not change shape if the caller mutates its own
    // array after this call returns.
    return [...value];
}

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
 * The cadence policy: several Enter pulses across the firmware's "press any key to boot from CD"
 * window, in place of one keystroke at a fixed offset.
 *
 * v2 sends its single Enter immediately after the first screendump acknowledgement, which lands
 * between +5000 and +6000 ms. Two of six otherwise identical boots (run 35348635051 among them)
 * dropped straight to the UEFI shell because the runner's firmware raised that prompt outside the
 * window: the offset is not stable across runners, while the prompt itself stays open for only a
 * few seconds. A cadence whose gap is shorter than that prompt's own lifetime covers the span the
 * prompt has been observed to open in, wherever inside it the prompt actually appears.
 *
 * What it still cannot prove: a QMP acknowledgement says the monitor accepted a `send-key` and
 * nothing more - not that the guest read it, and not that the prompt was open when it did. The
 * serial monitor's `efi-shell-fallback` abort remains the net that catches a boot this missed.
 *
 * Bounded by construction: the offsets are a fixed, closed list no request can choose, every pulse
 * carries the same single Enter the other two policies send, and no pulse may start after the
 * latest offset below. All of them land within the first nine seconds, long before Setup exists,
 * so a pulse the firmware has already consumed reaches a boot manager holding one entry rather
 * than any part of Setup.
 */
export const INSTALLER_BOOT_CONFIRMATION_CADENCE = "cadence-enter-before-setup-v3";
export const INSTALLER_BOOT_CONFIRMATION_CADENCE_KIND = "installer-boot-confirmation-cadence";
export const INSTALLER_BOOT_CONFIRMATION_CADENCE_OFFSETS_MILLISECONDS =
    Object.freeze([2_000, 3_200, 4_400, 5_600, 6_800, 8_000]);
/* The slack one pulse may drift by before the next is due; scheduling room, not a second gap. */
export const INSTALLER_BOOT_CONFIRMATION_CADENCE_SLACK_MILLISECONDS = 500;
/*
 * The gate on starting a pulse, derived from the last offset rather than chosen, so the list and
 * this bound cannot drift apart. A pulse whose turn arrives after it is not sent at all.
 */
export const INSTALLER_BOOT_CONFIRMATION_CADENCE_LATEST_OFFSET_MILLISECONDS =
    INSTALLER_BOOT_CONFIRMATION_CADENCE_OFFSETS_MILLISECONDS.at(-1) +
    INSTALLER_BOOT_CONFIRMATION_CADENCE_SLACK_MILLISECONDS;
/*
 * A recorded pulse is held to that same gate, and to nothing looser. The offset a record carries is
 * taken at the write boundary rather than at the acknowledgement, so the record and the gate measure
 * the same instant: admitting a record past the gate would authorize, after the fact, a keystroke
 * the gate had already refused. The gate is therefore enforced at the write boundary too, so a
 * pulse that would land late is never sent rather than sent and then refused by this bound.
 */
const CADENCE_INPUT_KEYS = Object.freeze(["acknowledged", "holdMilliseconds", "kind", "pulses", "qcode"]);
const CADENCE_PULSE_KEYS = Object.freeze(["acknowledged", "requestedOffsetMilliseconds",
    "sentOffsetMilliseconds"]);

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
/*
 * One budget for a whole send-key exchange, which is the only bound that can express "this reply
 * took too long". The per-message deadline bounds a single pipe write and a single chunk read, and
 * a reply arriving in fragments or behind a steady event stream renews it indefinitely without any
 * single read ever expiring. Two of them, because an exchange is a write and a reply and each was
 * already allowed one - so this bounds what was previously unbounded without tightening what was
 * not, and replaces the second timer that used to race the per-message one at the same value.
 */
export const WINPE_DIAGNOSTIC_EXCHANGE_BUDGET_MILLISECONDS = 2 * WINPE_DIAGNOSTIC_REPLY_TIMEOUT_MILLISECONDS;
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
        value === INSTALLER_BOOT_CONFIRMATION_AFTER_FIRST_FRAME ||
        value === INSTALLER_BOOT_CONFIRMATION_CADENCE) return value;
    throw new TypeError("QMP installer boot confirmation is invalid");
}

/*
 * A truncated cadence is valid evidence, not a failure: the offset list is the most the host may
 * send, and a session already running behind schedule sends the prefix that still fits. Refusing
 * the short record would turn a boot that was merely typed at less often into a launch carrying no
 * early-boot observation at all. What stays pinned is the list itself - a record may drop pulses
 * from the end, never substitute an offset of its own - and the window every pulse landed in.
 */
function validateInstallerBootCadenceInput(value) {
    const offsets = INSTALLER_BOOT_CONFIRMATION_CADENCE_OFFSETS_MILLISECONDS;
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...CADENCE_INPUT_KEYS]) ||
        value.kind !== INSTALLER_BOOT_CONFIRMATION_CADENCE_KIND ||
        value.qcode !== INSTALLER_BOOT_CONFIRMATION_QCODE ||
        value.holdMilliseconds !== INSTALLER_BOOT_CONFIRMATION_HOLD_MILLISECONDS ||
        value.acknowledged !== true || !Array.isArray(value.pulses) ||
        value.pulses.length < 1 || value.pulses.length > offsets.length)
        throw new TypeError("QMP installer boot input is invalid");
    let previousSentOffsetMilliseconds = -1;
    for (const [index, pulse] of value.pulses.entries()) {
        if (!pulse || typeof pulse !== "object" || Array.isArray(pulse) ||
            JSON.stringify(Object.keys(pulse).sort()) !== JSON.stringify([...CADENCE_PULSE_KEYS]) ||
            pulse.requestedOffsetMilliseconds !== offsets[index] || pulse.acknowledged !== true ||
            !Number.isFinite(pulse.sentOffsetMilliseconds) ||
            pulse.sentOffsetMilliseconds < offsets[index] ||
            pulse.sentOffsetMilliseconds >
                INSTALLER_BOOT_CONFIRMATION_CADENCE_LATEST_OFFSET_MILLISECONDS ||
            pulse.sentOffsetMilliseconds < previousSentOffsetMilliseconds)
            throw new TypeError("QMP installer boot input is invalid");
        previousSentOffsetMilliseconds = pulse.sentOffsetMilliseconds;
    }
    return Object.freeze({...value,
        pulses: Object.freeze(value.pulses.map(pulse => Object.freeze({...pulse})))});
}

export function validateInstallerBootInput(value, policy) {
    validateInstallerBootConfirmation(policy);
    if (policy === undefined) {
        if (value === false) return false;
        throw new TypeError("QMP installer boot input is invalid");
    }
    if (policy === INSTALLER_BOOT_CONFIRMATION_CADENCE) return validateInstallerBootCadenceInput(value);
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

const QMP_ERROR_PROVENANCE = new WeakMap();
/*
 * The boot cadence's own write-boundary abort, marked like the mid-window one below and for the same
 * reason: it is raised before any bytes leave, so it owes no response and must not taint the shared
 * reader. It ends the cadence where it stands, leaving the pulses already sent as the record.
 */
const INSTALLER_BOOT_CADENCE_ABORT_ERRORS = new WeakSet();
function createInstallerBootCadenceAbortError() {
    const error = new Error("QMP installer boot confirmation window elapsed");
    INSTALLER_BOOT_CADENCE_ABORT_ERRORS.add(error);
    return error;
}
/*
 * A distinct marker (not a QMP_ERROR_PROVENANCE reason) for the mid-window write-boundary admission
 * recheck: it means no command was ever issued, so the loop must record `insufficient-time` and must
 * NOT taint the shared reader - unlike every other rejection in this loop, which was issued and so
 * leaves the reader's state uncertain.
 */
const MID_WINDOW_ADMISSION_ABORT_ERRORS = new WeakSet();
function createMidWindowAdmissionAbortError() {
    const error = new Error("QMP mid-window admission window closed");
    MID_WINDOW_ADMISSION_ABORT_ERRORS.add(error);
    return error;
}

/*
 * One source, one iterator, one buffered-byte cursor for the whole session. `readBounded` is
 * byte-for-byte the previous per-call-deadline reader (used for the greeting always, and for the
 * entire session when no continuous dispatcher is ever created). `createDispatcher` hands the SAME
 * iterator/buffer state to a continuous single-reader pump, so a session that starts with bounded
 * reads (the greeting, always read this way) and later switches to the pump never opens a second
 * reader of the underlying stream - it is one cursor throughout, only the read strategy changes.
 */
function createQmpMessageSource(readable, dependencies, bounds = {}) {
    if (!readable || typeof readable[Symbol.asyncIterator] !== "function")
        throw new TypeError("QMP readable stream is invalid");
    const maximumMessages = bounds.maximumMessages ?? MAXIMUM_MESSAGES;
    const maximumTranscriptBytes = bounds.maximumTranscriptBytes ?? MAXIMUM_TRANSCRIPT_BYTES;
    if (maximumMessages < MAXIMUM_MESSAGES || maximumTranscriptBytes < MAXIMUM_TRANSCRIPT_BYTES)
        throw new TypeError("QMP transcript bounds are invalid");
    const iterator = readable[Symbol.asyncIterator]();
    let buffered = Buffer.alloc(0), totalBytes = 0, messages = 0;

    // Synchronous: returns a parsed message already fully buffered, or undefined if none is ready yet.
    function extractOneMessage() {
        const newline = buffered.indexOf(0x0a);
        if (newline < 0) return undefined;
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

    /*
     * The shared reader's terminal state. A bounded session has exactly one reader, so an exchange
     * that is abandoned while its acknowledgement is still owed leaves an unconsumed reply on that
     * reader: the next command would read it as its own response, or wait forever for a reply the
     * orphaned read already took. Neither is recoverable from here, so the reader is closed to all
     * further traffic instead.
     *
     * The trigger is ownership, not timing. A deadline is only one of the ways an exchange can be
     * abandoned - a phase boundary crossed between a successful write and its reply abandons one
     * with no timer involved at all. Expiry before a command is issued owes nothing, and expiry
     * after its acknowledgement is consumed owes nothing; everything between them closes the reader.
     */
    let readerAbandoned = null;
    let responseOwed = false;

    function assertReaderUsable() {
        if (readerAbandoned === null) return;
        const error = new Error("QMP reader abandoned an acknowledgement");
        QMP_ERROR_PROVENANCE.set(error, "qmp-reader-abandoned");
        throw error;
    }

    /* Called at the write boundary, once bytes may have left: from here a response is owed. */
    function markResponseOwed() { responseOwed = true; }

    /*
     * Called the instant the acknowledgement is read, before anything judges what it says. A reply
     * that was taken off the reader leaves it in sync whether it carries a result or a refusal, and
     * a monitor refusal is an ordinary protocol outcome the caller is expected to survive. Owing is
     * about who holds the reply, not about whether the reply was welcome.
     */
    function markResponseConsumed() { responseOwed = false; }

    async function boundedExchange(run) {
        assertReaderUsable();
        try {
            const value = await run();
            responseOwed = false;
            return value;
        } catch (error) {
            if (responseOwed) readerAbandoned = error;
            throw error;
        }
    }

    async function readBounded() {
        while (true) {
            /*
             * Rechecked every iteration, not once on entry. The read that was abandoned is still
             * running here - that is what makes it an orphan - and more bytes arriving would
             * otherwise have it consume another message and open another `iterator.next()` on a
             * reader that has already been closed to further traffic.
             */
            assertReaderUsable();
            const message = extractOneMessage();
            if (message !== undefined) return message;
            const next = await withDeadline(iterator.next(), dependencies);
            if (next.done) {
                const streamEndError = new Error("QMP stream ended before response");
                QMP_ERROR_PROVENANCE.set(streamEndError, "qmp-stream-ended");
                throw streamEndError;
            }
            const chunk = Buffer.from(next.value);
            totalBytes += chunk.length;
            if (totalBytes > maximumTranscriptBytes) throw new Error("QMP transcript bound exceeded");
            buffered = Buffer.concat([buffered, chunk]);
        }
    }

    /*
     * A continuous single-reader pump, created at most once per source. It owns every later
     * `iterator.next()` call: once `expect()` starts it (on the first command), nothing else may call
     * `readBounded()` or a second `createDispatcher()` against this same source.
     *
     * Any uncertain command/read/protocol failure makes the dispatcher terminal. It never starts
     * another read or command afterward; only the single iterator.next() already pending at the
     * terminal transition may settle, and that settlement is ignored. Continuous capture before that
     * boundary covers the evidence gap between the +600s response and a later +900s write failure.
     */
    function createDispatcher(getTime, sessionStartTime, onShutdownEvent) {
        const defer = dependencies.defer ?? setImmediate;
        let pending = null;
        let activeEntry = null;
        let terminalError = null;
        let resolveTerminal;
        const terminalSignal = new Promise(resolve => { resolveTerminal = resolve; });
        let shutdownRecord = null;
        let pumpStarted = false;

        function completeEntry(entry) {
            if (entry.timer !== null) entry.clearTimer(entry.timer);
            entry.timer = null;
            entry.completed = true;
            if (activeEntry === entry) activeEntry = null;
        }

        function rejectPending(error) {
            if (pending === null) return;
            const entry = pending;
            pending = null;
            entry.reject(error);
        }

        function terminate(error) {
            if (terminalError !== null) return;
            terminalError = error instanceof Error ? error : new Error(String(error));
            resolveTerminal(terminalError);
            if (activeEntry !== null) completeEntry(activeEntry);
            rejectPending(terminalError);
        }

        function captureShutdown(value) {
            const data = value.data;
            if (!data || typeof data !== "object" || Array.isArray(data) || typeof data.guest !== "boolean" ||
                typeof data.reason !== "string" || !QMP_SHUTDOWN_CAUSES.includes(data.reason)) {
                const error = new Error("QMP SHUTDOWN event is invalid");
                QMP_ERROR_PROVENANCE.set(error, "qmp-shutdown-malformed");
                throw error;
            }
            // Every SHUTDOWN is validated; only retention/callback are first-event-only.
            if (shutdownRecord !== null) return;
            const offsetMs = Math.round(getTime() - sessionStartTime);
            if (!Number.isSafeInteger(offsetMs) || offsetMs < 0) {
                const error = new Error("QMP SHUTDOWN event offset is invalid");
                QMP_ERROR_PROVENANCE.set(error, "qmp-shutdown-malformed");
                throw error;
            }
            shutdownRecord = Object.freeze({schemaVersion: 1, status: "captured", guest: data.guest,
                reason: data.reason, offsetMs});
            if (typeof onShutdownEvent === "function") {
                try { onShutdownEvent(shutdownRecord); }
                catch { /* a throwing callback cannot fail the pump */ }
            }
        }

        // Returns true after routing a response, so the loop can yield to the command continuation.
        function handleMessage(value) {
            if (value.event !== undefined) {
                if (value.event === "SHUTDOWN") captureShutdown(value);
                return false;
            }
            if (pending === null) {
                const error = new Error("QMP response arrived without a pending command");
                QMP_ERROR_PROVENANCE.set(error, "qmp-unexpected-response");
                throw error;
            }
            if (value.id !== pending.id) {
                const error = new Error("QMP response is invalid");
                QMP_ERROR_PROVENANCE.set(error, "qmp-id-mismatch");
                throw error;
            }
            if (value.error !== undefined || value.return === undefined) {
                const error = new Error("QMP response is invalid");
                if (value.error !== undefined) QMP_ERROR_PROVENANCE.set(error, "qmp-error-response");
                throw error;
            }
            const entry = pending;
            pending = null;
            if (!entry.deadlineIncludesWrite) completeEntry(entry);
            entry.resolve(value.return);
            return true;
        }

        async function pumpLoop() {
            try {
                while (terminalError === null) {
                    let message;
                    try { message = extractOneMessage(); }
                    catch (error) { terminate(error); return; }
                    if (message === undefined) {
                        let next;
                        try { next = await iterator.next(); } // no per-read deadline: idle-safe
                        catch (error) { terminate(error); return; }
                        // Cancellation/timeout/write failure terminalizes the dispatcher while this one
                        // read may still be pending. Its eventual settlement is ignored and never
                        // followed by another iterator.next().
                        if (terminalError !== null) return;
                        if (next.done) {
                            const error = new Error("QMP stream ended before response");
                            QMP_ERROR_PROVENANCE.set(error, "qmp-stream-ended");
                            terminate(error);
                            return;
                        }
                        const chunk = Buffer.from(next.value);
                        totalBytes += chunk.length;
                        if (totalBytes > maximumTranscriptBytes) {
                            terminate(new Error("QMP transcript bound exceeded"));
                            return;
                        }
                        buffered = Buffer.concat([buffered, chunk]);
                        continue;
                    }
                    try {
                        if (handleMessage(message)) {
                            // Give the serialized command continuation one event-loop turn to finish
                            // its bounded write/result bookkeeping and arm an immediately-following
                            // command before an already-buffered response is examined. If the caller
                            // instead enters a real delay, the pump resumes on this turn and remains
                            // continuously parked in iterator.next() for events throughout that delay.
                            await new Promise(resolve => defer(resolve));
                        }
                    } catch (error) {
                        terminate(error);
                        return;
                    }
                }
            } catch (error) {
                terminate(error);
            }
        }

        function taintedError() {
            const error = new Error("QMP dispatcher is terminal", {cause: terminalError});
            QMP_ERROR_PROVENANCE.set(error, "dispatcher-terminal");
            return error;
        }

        function ensurePumpStarted() {
            if (!pumpStarted) { pumpStarted = true; pumpLoop().catch(() => undefined); }
        }

        function startResponseDeadline(entry, timeoutMilliseconds) {
            if (terminalError !== null || activeEntry !== entry || entry.timer !== null) return;
            entry.timer = entry.setTimer(() => {
                if (activeEntry === entry && !entry.completed)
                    terminate(new Error("QMP response deadline exceeded"));
            }, timeoutMilliseconds);
        }

        /* Registers the one pending waiter for `id`, then starts the pump on first use. The caller
         * chooses whether the response budget includes the write (mid-window/predeadline's prior
         * outer deadline) or begins after a successful write (the legacy early/late behavior). */
        function expect(id, timeoutMilliseconds, deadlineIncludesWrite) {
            if (terminalError !== null) throw taintedError();
            if (activeEntry !== null) throw new Error("QMP dispatcher command already pending");
            const setTimer = dependencies.setTimer ?? setTimeout;
            const clearTimer = dependencies.clearTimer ?? clearTimeout;
            let resolveResponse, rejectResponse;
            const responsePromise = new Promise((resolve, reject) => {
                resolveResponse = resolve;
                rejectResponse = reject;
            });
            // The command path may still be awaiting a bounded write when this response rejects.
            // Attach a terminal handler now so that gap can never produce an unhandled rejection.
            responsePromise.catch(() => undefined);
            const entry = {id, resolve: resolveResponse, reject: rejectResponse, clearTimer, timer: null,
                completed: false, deadlineIncludesWrite};
            pending = entry;
            activeEntry = entry;
            entry.setTimer = setTimer;
            if (deadlineIncludesWrite) startResponseDeadline(entry, timeoutMilliseconds);
            ensurePumpStarted();
            return {entry, responsePromise};
        }

        /* Called when the write that was supposed to satisfy an armed `expect(id, ...)` itself failed
         * (including the mid-window admission-abort, which owes no response and must not taint). */
        function abandon(id, error) {
            const admissionAbort = error instanceof Error &&
                (MID_WINDOW_ADMISSION_ABORT_ERRORS.has(error) ||
                    INSTALLER_BOOT_CADENCE_ABORT_ERRORS.has(error));
            if (admissionAbort) {
                if (activeEntry !== null && activeEntry.id === id) completeEntry(activeEntry);
                if (pending !== null && pending.id === id) rejectPending(error);
                return;
            }
            terminate(error);
        }

        return {expect, abandon, complete: completeEntry, startResponseDeadline, terminate,
            waitForTermination: () => terminalSignal,
            get shutdownRecord() { return shutdownRecord; }};
    }

    return {readBounded, createDispatcher, boundedExchange, markResponseOwed, markResponseConsumed};
}

/*
 * Why a late-boot milestone has no frame, as a stable identifier rather than a message. The reader
 * case reuses the mid-window vocabulary, because it is the same condition seen from another loop.
 */
const LATE_MILESTONE_DEFAULT_REASON = "milestone-failed";
/*
 * The same condition, in the vocabulary the optional frames publish. Their raw provenance is
 * internal: the hosted collectors admit only a closed set and coerce anything else to
 * `command-failed`, which would tell a reader the monitor refused a command when the session never
 * issued one. A closed reader is what the milestone loop below calls `reader-unavailable`, and the
 * frames say the same thing about the same reader.
 */
function optionalFrameReason(provenance) {
    return provenance === "qmp-reader-abandoned" ? "reader-unavailable" : provenance;
}
function lateMilestoneUnavailableReason(error) {
    const provenance = error && typeof error === "object" ? QMP_ERROR_PROVENANCE.get(error) : undefined;
    if (provenance === "qmp-reader-abandoned") return "reader-unavailable";
    return provenance ?? LATE_MILESTONE_DEFAULT_REASON;
}

async function expectResponse(readMessage, id, onAcknowledged = () => undefined) {
    while (true) {
        const value = await readMessage();
        if (value.event !== undefined) continue;
        if (value.id !== id) {
            /*
             * Deliberately before the notification below: this reply was not ours, so the reply that
             * is ours is still unread and still owed. A mismatch is a genuine desync.
             */
            const err = new Error("QMP response is invalid");
            QMP_ERROR_PROVENANCE.set(err, "qmp-id-mismatch");
            throw err;
        }
        onAcknowledged();
        if (value.error !== undefined) {
            const err = new Error("QMP response is invalid");
            QMP_ERROR_PROVENANCE.set(err, "qmp-error-response");
            throw err;
        }
        if (value.return === undefined)
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
    const predeadline = input?.predeadline !== undefined ? {
        screenshotPath: validatePredeadlineScreenshotPath(input.predeadline.screenshotPath),
        executionDeadline: input.predeadline.executionDeadline
    } : null;
    const midWindow = input?.midWindow !== undefined ? {
        screenshotPaths: validateMidWindowScreenshotPaths(input.midWindow.screenshotPaths),
        executionDeadline: input.midWindow.executionDeadline
    } : null;
    const screenshotRoot = screenshotPaths[0].slice(0, -"/early-boot-1.png".length);
    if (predeadline !== null) {
        if (lateScreenshotPaths === null)
            throw new TypeError("QMP predeadline requires late screenshot paths");
        if (!Number.isFinite(predeadline.executionDeadline))
            throw new TypeError("QMP predeadline execution deadline is invalid");
        const predeadlineRoot = predeadline.screenshotPath.slice(0, -`/${PREDEADLINE_FRAME_FILENAME}`.length);
        if (predeadlineRoot !== screenshotRoot)
            throw new TypeError("QMP predeadline root is invalid");
    }
    if (midWindow !== null) {
        if (lateScreenshotPaths === null)
            throw new TypeError("QMP mid-window requires late screenshot paths");
        if (!Number.isFinite(midWindow.executionDeadline))
            throw new TypeError("QMP mid-window execution deadline is invalid");
        midWindow.screenshotPaths.forEach((path, index) => {
            const root = path.slice(0, -`/${MID_WINDOW_FRAME_FILENAMES[index]}`.length);
            if (root !== screenshotRoot) throw new TypeError("QMP mid-window root is invalid");
        });
        /*
         * Rejected here too, not only at the controller's authorization boundary: a WinPE diagnostic
         * session runs on its own reservation-bound session, never the fixed 25/5 diagnostic deadlines
         * mid-window is scoped to, and this callable must never silently disable one in favor of the
         * other.
         */
        if (winpeDiagnostic !== undefined)
            throw new TypeError("QMP mid-window frames cannot combine with a WinPE diagnostic authorization");
    }
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

    let dispatcher = null;
    const cancelSession = () => {
        session.cancelled = true;
        dispatcher?.terminate(new Error("QMP session cancelled"));
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

    const messageSource = createQmpMessageSource(input.readable, dependencies, winpeDiagnostic === undefined ? {} :
        winpeDiagnosticBudget(winpeDiagnostic.nonce));
    const readMessage = messageSource.readBounded;
    const getTime = dependencies.now ?? (() => performance.now());
    const sessionStartTime = getTime();
    const greeting = await readMessage();
    const version = greeting?.QMP?.version?.qemu;
    if (![version?.major, version?.minor, version?.micro].every(value => Number.isSafeInteger(value) && value >= 0) ||
        !Array.isArray(greeting?.QMP?.capabilities) ||
        !greeting.QMP.capabilities.every(value => typeof value === "string"))
        throw new Error("QMP greeting is invalid");
    /*
     * Only a mid-window session ever gets a continuous dispatcher: default, MSI, WinPE and Stage 3
     * sessions (midWindow === null, always true when winpeDiagnostic is set - the two are mutually
     * exclusive by the validation above) keep the exact bounded-per-read behavior they always had, via
     * `write` + `expectResponse` below unchanged. A mid-window session routes every later command
     * through the dispatcher instead: `sendAndAwait` is the only place that decides which.
     */
    dispatcher = midWindow !== null ? messageSource.createDispatcher(getTime, sessionStartTime,
        input.onShutdownEvent) : null;
    session.cancelDispatcher = () => dispatcher?.terminate(new Error("QMP session deadline exceeded"));
    const write = (value, beforeWrite = () => undefined) => {
        if (session.expired || session.cancelled) return Promise.reject(new Error("QMP session deadline exceeded"));
        const operation = Promise.resolve().then(async () => {
            if (session.expired || session.cancelled) throw new Error("QMP session deadline exceeded");
            beforeWrite();
            /*
             * Serialized before the response is owed, not after: a value that cannot be encoded
             * never reaches the wire, so it owes nothing and must not close the shared reader.
             */
            const encoded = Buffer.from(`${JSON.stringify(value)}\n`);
            /*
             * Past every pre-write abort, so bytes may now leave and a response becomes owed. A
             * dispatcher session has its own terminal guard and single-reader admission, so only
             * the bounded path arms this one.
             */
            if (dispatcher === null) messageSource.markResponseOwed();
            try {
                return await input.writeBytes(encoded);
            } catch (error) {
                if (error && typeof error === "object" && !QMP_ERROR_PROVENANCE.has(error)) {
                    QMP_ERROR_PROVENANCE.set(error, "qmp-write-failed");
                }
                throw error;
            }
        });
        /* Cancellation/protocol failure must settle a command whose underlying write is stuck. The
         * Promise.race handlers permanently observe that write, while settling this wrapper clears
         * its own deadline timer; no attempt is made to cancel the underlying pipe operation. */
        const guarded = dispatcher === null ? operation : Promise.race([operation,
            dispatcher.waitForTermination().then(error => { throw error; })]);
        return withDeadline(guarded, dependencies);
    };
    /*
     * The one call site every command in this session uses. With no dispatcher it is exactly the
     * original write-then-expectResponse pair, sharing the single bounded reader. With a dispatcher,
     * the response waiter is armed first (satisfying the single-reader admission ordering), then the
     * write is issued; a write that never sent bytes (a real failure, or the mid-window admission
     * abort) tells the dispatcher so it can unregister the waiter it already holds without a queue.
     *
     * The bounded write is awaited before the already-armed response. A response may safely settle
     * first, but a later write failure must still win and terminalize the dispatcher; reporting the
     * response as success before that write outcome is known would lose an uncertain-write failure.
     */
    const sendAndAwait = async (value, id, timeoutMilliseconds = QMP_MESSAGE_TIMEOUT_MILLISECONDS,
        beforeWrite = () => undefined, deadlineIncludesWrite = false) => {
        if (dispatcher === null) {
            return await messageSource.boundedExchange(async () => {
                await write(value, beforeWrite);
                return await expectResponse(readMessage, id, messageSource.markResponseConsumed);
            });
        }
        const {entry, responsePromise} = dispatcher.expect(id, timeoutMilliseconds, deadlineIncludesWrite);
        try {
            await write(value, beforeWrite);
        } catch (error) {
            dispatcher.abandon(id, error);
            throw error;
        }
        if (!deadlineIncludesWrite) dispatcher.startResponseDeadline(entry, timeoutMilliseconds);
        const response = await responsePromise;
        dispatcher.complete(entry);
        return response;
    };
    await sendAndAwait({execute: "qmp_capabilities", id: "capabilities"}, "capabilities");
    const status = await sendAndAwait({execute: "query-status", id: "status"}, "status");
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
        await sendAndAwait({execute: "send-key", arguments: {keys: [{type: "qcode", data: INSTALLER_BOOT_CONFIRMATION_QCODE}],
            "hold-time": INSTALLER_BOOT_CONFIRMATION_HOLD_MILLISECONDS}, id: "installer-boot-confirmation"},
        "installer-boot-confirmation", QMP_MESSAGE_TIMEOUT_MILLISECONDS, () => {
            sentOffsetMilliseconds = getTime() - sessionStartTime;
            if (!Number.isFinite(sentOffsetMilliseconds) ||
                sentOffsetMilliseconds < requestedOffsetMilliseconds || sentOffsetMilliseconds > latestOffsetMilliseconds)
                throw new Error("QMP installer boot confirmation window elapsed");
        });
        // A QMP acknowledgement proves only monitor acceptance, never guest-side receipt.
        return validateInstallerBootInput({kind: "installer-boot-confirmation",
            qcode: INSTALLER_BOOT_CONFIRMATION_QCODE, holdMilliseconds: INSTALLER_BOOT_CONFIRMATION_HOLD_MILLISECONDS,
            requestedOffsetMilliseconds, sentOffsetMilliseconds, acknowledged: true,
            ...(afterFirstScreenshotAck ? {afterFirstScreenshotAck: true} : {})}, bootConfirmation);
    };
    /*
     * The cadence runs to completion before the first screendump rather than interleaving with it:
     * the QMP monitor takes one command at a time, and a frame taken in the middle of the window
     * would either delay a pulse past its offset or push the frame behind the whole cadence. The
     * first screenshot follows immediately after the last pulse, which is why its own delay is
     * already measured from the session start rather than from here.
     */
    const sendInstallerBootConfirmationCadence = async () => {
        const offsets = INSTALLER_BOOT_CONFIRMATION_CADENCE_OFFSETS_MILLISECONDS;
        const pulses = [];
        const elapsed = () => getTime() - sessionStartTime;
        for (const [index, requestedOffsetMilliseconds] of offsets.entries()) {
            if (elapsed() > INSTALLER_BOOT_CONFIRMATION_CADENCE_LATEST_OFFSET_MILLISECONDS) break;
            await cancellableDelay(Math.max(0, requestedOffsetMilliseconds - elapsed()), dependencies, session);
            if (session.cancelled || session.expired)
                throw new Error("QMP installer boot confirmation cancelled");
            // Re-checked after the delay, not only before it: a delay that overran is exactly what
            // this gate exists to catch, and the pulses already sent stand as their own record.
            if (elapsed() > INSTALLER_BOOT_CONFIRMATION_CADENCE_LATEST_OFFSET_MILLISECONDS) break;
            let sentOffsetMilliseconds = null;
            const id = `installer-boot-confirmation-${index + 1}`;
            try {
                await sendAndAwait({execute: "send-key",
                    arguments: {keys: [{type: "qcode", data: INSTALLER_BOOT_CONFIRMATION_QCODE}],
                        "hold-time": INSTALLER_BOOT_CONFIRMATION_HOLD_MILLISECONDS}, id},
                id, QMP_MESSAGE_TIMEOUT_MILLISECONDS, () => {
                    /*
                     * The gate again, at the last instant before any bytes leave. The checks above
                     * cannot see a stall that happens after them, and this one runs while the write
                     * is still refusable - so a pulse that has become late is dropped rather than
                     * typed late and then refused by a record bound that would have to be looser
                     * than the gate to admit it.
                     */
                    sentOffsetMilliseconds = elapsed();
                    if (sentOffsetMilliseconds >
                        INSTALLER_BOOT_CONFIRMATION_CADENCE_LATEST_OFFSET_MILLISECONDS)
                        throw createInstallerBootCadenceAbortError();
                });
            } catch (error) {
                if (!(error instanceof Error) || !INSTALLER_BOOT_CADENCE_ABORT_ERRORS.has(error)) throw error;
                break;
            }
            pulses.push({requestedOffsetMilliseconds, sentOffsetMilliseconds, acknowledged: true});
        }
        if (pulses.length < 1) throw new Error("QMP installer boot confirmation window elapsed");
        // A QMP acknowledgement proves only monitor acceptance, never guest-side receipt.
        return validateInstallerBootInput({kind: INSTALLER_BOOT_CONFIRMATION_CADENCE_KIND,
            qcode: INSTALLER_BOOT_CONFIRMATION_QCODE,
            holdMilliseconds: INSTALLER_BOOT_CONFIRMATION_HOLD_MILLISECONDS, acknowledged: true,
            pulses}, bootConfirmation);
    };
    if (bootConfirmation === INSTALLER_BOOT_CONFIRMATION)
        inputSent = await sendInstallerBootConfirmation();
    if (bootConfirmation === INSTALLER_BOOT_CONFIRMATION_CADENCE)
        inputSent = await sendInstallerBootConfirmationCadence();
    const wait = dependencies.wait ?? delay;
    const firstScreenshotDelay = bootConfirmation === undefined ? FIRST_SCREENSHOT_DELAY_MILLISECONDS :
        Math.max(0, FIRST_SCREENSHOT_DELAY_MILLISECONDS - (getTime() - sessionStartTime));
    for (const [index, milliseconds] of [firstScreenshotDelay,
        SECOND_SCREENSHOT_DELAY_MILLISECONDS].entries()) {
        await wait(milliseconds);
        const id = `screenshot-${index + 1}`;
        await sendAndAwait({execute: "screendump", arguments: {filename: screenshotPaths[index], format: "png"}, id}, id);
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
            /*
             * One budget for the whole exchange, not one timer per half. The inner deadlines bound
             * a single pipe write and a single chunk read; neither can express "this reply has taken
             * too long", because `expectResponse` skips QMP events and `readBounded` gives every
             * chunk a fresh deadline - a fragmented reply or a steady event stream extends one
             * response indefinitely while no individual read ever expires. Two independently defined
             * constants of the same value around the same operation raced on registration order and
             * bounded nothing extra.
             *
             * The phase check between the write and the reply is inside the exchange on purpose: if
             * it throws there, the acknowledgement is owed and unread, and the reader closes.
             */
            const sendKey = async (qcodes, id, final = false) => {
                assertPhaseOpen();
                await messageSource.boundedExchange(() => withDeadline((async () => {
                    await write({execute: "send-key", arguments: {
                        keys: qcodes.map(data => ({type: "qcode", data})),
                        "hold-time": WINPE_DIAGNOSTIC_HOLD_MILLISECONDS}, id});
                    assertPhaseOpen();
                    return await expectResponse(readMessage, id, messageSource.markResponseConsumed);
                })(), dependencies, WINPE_DIAGNOSTIC_EXCHANGE_BUDGET_MILLISECONDS));
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
        let resolveLateBoot;
        const latePromise = new Promise(resolve => { resolveLateBoot = resolve; });
        latePromise.catch(() => undefined);
        input.onLateObservation?.(latePromise);

        const runLateMilestones = async () => {
            const milestones = [];
            let winpeDiagnosticRecord = null;
            let predeadlineSettled = false;
            /*
             * A stray timeout does not cancel its own losing read/write (Promise.race never does):
             * that operation may still resolve later, and a later optional command reusing the one
             * shared QMP reader while it does would be a second concurrent reader of the same
             * transcript. This flag is the conservative answer - once ANY optional-phase QMP command
             * fails for ANY reason (not only a timeout: an id-mismatch can leave the wanted response
             * still outstanding too), no further optional write/read is issued for the rest of this
             * session. It only ever becomes true when mid-window capture is enabled, so a disabled or
             * WinPE/MSI session's behavior is untouched by this flag's mere existence.
             */
            let optionalContinuationUnsafe = false;
            const reportPredeadline = record => {
                if (predeadlineSettled) return;
                predeadlineSettled = true;
                input.onPredeadlineObservation?.(record);
            };
            /*
             * What the failing milestone had already observed when it was abandoned. A milestone
             * whose `query-status` completed and whose screendump did not really did observe a
             * status; one abandoned before `query-status` observed nothing at all. The two are
             * recorded as different shapes rather than one shape with invented fields.
             */
            let observedStatus = null;
            try {
                for (let i = 0; i < MAX_LATE_BOOT_MILESTONES; i += 1) {
                    if (session.cancelled || session.expired) break;
                    observedStatus = null;
                    const targetOffset = LATE_BOOT_MILESTONE_OFFSETS_MILLISECONDS[i];
                    const elapsed = getTime() - sessionStartTime;
                    const remaining = Math.max(0, targetOffset - elapsed);
                    await cancellableDelay(remaining, dependencies, session);
                    if (session.cancelled || session.expired) break;
                    const milestoneIndex = i + 1;
                    const statusId = `late-status-${milestoneIndex}`;
                    const lateStatus = await sendAndAwait({execute: "query-status", id: statusId}, statusId);
                    observedStatus = lateStatus;
                    if (session.cancelled || session.expired) break;
                    const screenshotId = `late-screenshot-${milestoneIndex}`;
                    await sendAndAwait({execute: "screendump", arguments: {
                        filename: lateScreenshotPaths[i], format: "png"
                    }, id: screenshotId}, screenshotId);
                    milestones.push(Object.freeze({
                        milestone: milestoneIndex,
                        offsetMs: targetOffset,
                        status: lateStatus.status,
                        running: lateStatus.running,
                        screenshotPath: lateScreenshotPaths[i]
                    }));
                    observedStatus = null;
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
            } catch (error) {
                /*
                 * Any milestone failure terminates the milestone loop - but the milestones it did
                 * not reach must still say so. Dropping them makes an abandoned frame and a frame
                 * that was never due indistinguishable, and the list `validateLateBoot` accepts is
                 * dense and positional: a slot cannot be omitted and then reappear later. So every
                 * remaining slot is filled in place, carrying only what was actually observed.
                 */
                if (midWindow !== null) optionalContinuationUnsafe = true;
                const reason = lateMilestoneUnavailableReason(error);
                const abandonedIndex = milestones.length;
                /*
                 * Only a loop that observed something backfills. A late-boot phase that failed on
                 * its very first command observed nothing at all, and `null` is already this
                 * record's way of saying so - a list of nothing but gaps would assert that two
                 * milestones were missed, which is no more true than it is useful.
                 */
                const observedAnything = abandonedIndex > 0 || observedStatus !== null;
                for (let i = observedAnything ? abandonedIndex : MAX_LATE_BOOT_MILESTONES;
                    i < MAX_LATE_BOOT_MILESTONES; i += 1) {
                    /* Only the milestone that was interrupted can have observed anything. */
                    const partial = i === abandonedIndex && observedStatus !== null ?
                        {status: observedStatus.status, running: observedStatus.running} : {};
                    milestones.push(Object.freeze({
                        milestone: i + 1,
                        offsetMs: LATE_BOOT_MILESTONE_OFFSETS_MILLISECONDS[i],
                        ...partial,
                        unavailable: Object.freeze({reason})
                    }));
                }
            }

            // Late boot observation settles promptly at Milestone 2 (300s) - never held hostage by predeadline!
            const lateBootRecord = (milestones.length === 0 && winpeDiagnosticRecord === null) ? null : Object.freeze({
                schemaVersion: 1,
                kind: "qemu-late-boot-observation",
                milestones: Object.freeze([...milestones]),
                ...(winpeDiagnosticRecord === null ? {} : {winpeDiagnostic: winpeDiagnosticRecord})
            });
            resolveLateBoot(lateBootRecord);

            if (midWindow !== null) {
                /*
                 * One precise callback signature, used at every hop: `onMidWindowFrame(index, record)`,
                 * fired at most once per slot, immediately once that slot's own outcome is decided.
                 * This (not a single end-of-loop array) is what lets a caller retain a slot that
                 * finished before the process settled while correctly closing a slot that never got
                 * the chance to run - a single combined report cannot represent that split. A throwing
                 * callback must never suppress the predeadline finalization that follows this loop.
                 */
                const reportMidWindowFrame = (index, record) => {
                    try { input.onMidWindowFrame?.(index, Object.freeze(record)); }
                    catch { /* a throwing callback must not suppress predeadline finalization */ }
                };
                for (let i = 0; i < MID_WINDOW_SAMPLE_OFFSETS_MILLISECONDS.length; i += 1) {
                    const nominalOffsetMs = MID_WINDOW_SAMPLE_OFFSETS_MILLISECONDS[i];
                    /*
                     * protectedStart is the same boundary predeadline already protects for itself
                     * (executionDeadline minus its own lead, which already bundles its command
                     * timeout, jitter, and cleanup headroom). A mid-window sample may only start when
                     * it - plus its own command timeout and its own named scheduling margin - fits
                     * entirely before that boundary, so an overdue sample can never eat into
                     * predeadline's reserved window. This is evaluated fresh before waiting, again
                     * after waking, and once more immediately before the write itself (the actual
                     * writeBytes boundary, via `write`'s `beforeWrite` hook), per the runtime-admission
                     * decision.
                     */
                    const protectedStart = midWindow.executionDeadline - PREDEADLINE_FRAME_LEAD_MILLISECONDS;
                    const fits = now => now + MID_WINDOW_COMMAND_TIMEOUT_MILLISECONDS +
                        MID_WINDOW_SCHEDULING_MARGIN_MILLISECONDS < protectedStart;
                    if (optionalContinuationUnsafe) {
                        reportMidWindowFrame(i, {schemaVersion: 1, status: "unavailable", nominalOffsetMs, reason: "reader-unavailable"});
                        continue;
                    }
                    if (session.cancelled || session.expired) {
                        reportMidWindowFrame(i, {schemaVersion: 1, status: "skipped", nominalOffsetMs, reason: "session-closed"});
                        continue;
                    }
                    const preWaitNow = Math.max(getTime(), sessionStartTime + nominalOffsetMs);
                    if (!fits(preWaitNow)) {
                        reportMidWindowFrame(i, {schemaVersion: 1, status: "skipped", nominalOffsetMs, reason: "insufficient-time"});
                        continue;
                    }
                    const remaining = Math.max(0, nominalOffsetMs - (getTime() - sessionStartTime));
                    await cancellableDelay(remaining, dependencies, session);
                    if (session.cancelled || session.expired) {
                        reportMidWindowFrame(i, {schemaVersion: 1, status: "skipped", nominalOffsetMs, reason: "session-closed"});
                        continue;
                    }
                    if (!fits(getTime())) {
                        reportMidWindowFrame(i, {schemaVersion: 1, status: "skipped", nominalOffsetMs, reason: "insufficient-time"});
                        continue;
                    }
                    if (optionalContinuationUnsafe) {
                        reportMidWindowFrame(i, {schemaVersion: 1, status: "unavailable", nominalOffsetMs, reason: "reader-unavailable"});
                        continue;
                    }
                    try {
                        const screenshotId = `mid-window-screenshot-${i + 1}`;
                        /*
                         * The dispatcher (always present here: this loop only runs when midWindow !==
                         * null) owns the response wait and its own timeout directly - there is no
                         * separate outer race and no "losing write must not start a new read" hazard
                         * to guard against, because there is exactly one `pending` slot in the
                         * dispatcher and a write that never sent bytes (the admission abort below)
                         * tells it so via `abandon`, never by racing a second reader.
                         */
                        await sendAndAwait({
                            execute: "screendump",
                            arguments: {filename: midWindow.screenshotPaths[i], format: "png"},
                            id: screenshotId
                        }, screenshotId, MID_WINDOW_COMMAND_TIMEOUT_MILLISECONDS, () => {
                            // The actual writeBytes boundary: a command never issued here must
                            // never taint the dispatcher, unlike every other rejection in this loop.
                            if (!fits(getTime())) throw createMidWindowAdmissionAbortError();
                        }, true);
                        const observedOffsetMs = Math.round(getTime() - sessionStartTime);
                        reportMidWindowFrame(i, {schemaVersion: 1, status: "captured", nominalOffsetMs,
                            offsetMs: observedOffsetMs, screenshotPath: midWindow.screenshotPaths[i]});
                    } catch (error) {
                        if (error instanceof Error && MID_WINDOW_ADMISSION_ABORT_ERRORS.has(error)) {
                            reportMidWindowFrame(i, {schemaVersion: 1, status: "skipped", nominalOffsetMs, reason: "insufficient-time"});
                            continue;
                        }
                        optionalContinuationUnsafe = true;
                        const observedOffsetMs = Math.round(getTime() - sessionStartTime);
                        const isTimeout = error?.message?.includes("deadline");
                        const provenance = (error && typeof error === "object") ?
                            QMP_ERROR_PROVENANCE.get(error) : undefined;
                        const reason = isTimeout ? "command-timeout" : (optionalFrameReason(provenance) ?? "command-failed");
                        reportMidWindowFrame(i, {schemaVersion: 1, status: "unavailable", nominalOffsetMs,
                            offsetMs: observedOffsetMs, reason});
                    }
                }
            }

            if (predeadline !== null) {
                try {
                    if (optionalContinuationUnsafe) {
                        reportPredeadline({status: "unavailable", reason: "reader-unavailable"});
                    } else if (session.cancelled || session.expired) {
                        reportPredeadline({status: "skipped", reason: "guest-already-exited"});
                    } else {
                        const targetOffset = Math.round(predeadline.executionDeadline - sessionStartTime - PREDEADLINE_FRAME_LEAD_MILLISECONDS);
                        const elapsed = getTime() - sessionStartTime;
                        const remaining = targetOffset - elapsed;
                        if (targetOffset <= LATE_BOOT_MILESTONE_OFFSETS_MILLISECONDS[1] || remaining <= 0) {
                            reportPredeadline({status: "skipped", reason: "insufficient-time"});
                        } else {
                            await cancellableDelay(remaining, dependencies, session);
                            if (session.cancelled || session.expired) {
                                reportPredeadline({status: "skipped", reason: "guest-already-exited"});
                            } else {
                                const wakeupTime = getTime();
                                const remainingBeforeDeadline = Math.round(predeadline.executionDeadline - wakeupTime);
                                if (remainingBeforeDeadline <= PREDEADLINE_FRAME_CLEANUP_HEADROOM_MILLISECONDS) {
                                    reportPredeadline({status: "skipped", reason: "insufficient-time"});
                                } else {
                                    const totalCommandBudget = Math.min(
                                        PREDEADLINE_FRAME_COMMAND_TIMEOUT_MILLISECONDS,
                                        Math.max(0, remainingBeforeDeadline - PREDEADLINE_FRAME_CLEANUP_HEADROOM_MILLISECONDS)
                                    );
                                    try {
                                        const screenshotId = "predeadline-screenshot";
                                        await sendAndAwait({
                                            execute: "screendump",
                                            arguments: {filename: predeadline.screenshotPath, format: "png"},
                                            id: screenshotId
                                        }, screenshotId, totalCommandBudget, undefined, true);
                                        const observedOffsetMs = Math.round(getTime() - sessionStartTime);
                                        reportPredeadline({
                                            status: "captured",
                                            offsetMs: observedOffsetMs,
                                            screenshotPath: predeadline.screenshotPath
                                        });
                                    } catch (error) {
                                        const observedOffsetMs = Math.round(getTime() - sessionStartTime);
                                        const isTimeout = error?.message?.includes("deadline");
                                        const provenance = (error && typeof error === "object") ?
                                            QMP_ERROR_PROVENANCE.get(error) : undefined;
                                        const reason = isTimeout ? "command-timeout" : (optionalFrameReason(provenance) ?? "command-failed");
                                        reportPredeadline({
                                            status: "unavailable",
                                            reason,
                                            offsetMs: observedOffsetMs
                                        });
                                    }
                                }
                            }
                        }
                    }
                } catch (error) {
                    const observedOffsetMs = Math.round(getTime() - sessionStartTime);
                    const isTimeout = error?.message?.includes("deadline");
                    const provenance = (error && typeof error === "object") ?
                        QMP_ERROR_PROVENANCE.get(error) : undefined;
                    const reason = isTimeout ? "command-timeout" : (optionalFrameReason(provenance) ?? "command-failed");
                    reportPredeadline({
                        status: "unavailable",
                        reason,
                        offsetMs: observedOffsetMs
                    });
                }
            }
        };
        runLateMilestones().catch(() => undefined);
    }

    return earlyResult;
}

export function runEarlyBootQmpSession(input, dependencies = {}) {
    const session = {expired: false, cancelled: false, activeTimer: null, onCancel: null,
        cancelDispatcher: null};
    const operation = runSession(input, dependencies, session).catch(error => {
        // An early-phase failure after the continuous dispatcher started must not leave its idle
        // reader live until some outer process owner eventually notices and cancels the session.
        session.cancelDispatcher?.();
        throw error;
    });
    return withDeadline(operation, dependencies, QMP_SESSION_TIMEOUT_MILLISECONDS,
        () => {
            session.expired = true;
            session.cancelDispatcher?.();
            if (typeof session.onCancel === "function") session.onCancel();
        });
}
