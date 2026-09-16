const QMP_MESSAGE_TIMEOUT_MILLISECONDS = 10_000;
const QMP_SESSION_TIMEOUT_MILLISECONDS = 90_000;
const FIRST_SCREENSHOT_DELAY_MILLISECONDS = 5_000;
const SECOND_SCREENSHOT_DELAY_MILLISECONDS = 30_000;
const MAXIMUM_TRANSCRIPT_BYTES = 65_536;
const MAXIMUM_MESSAGES = 64;
const INSTALLER_BOOT_CONFIRMATION_ROOT_PATTERN =
    /^\/home\/runner\/work\/_temp\/myspeed-windows-cpu-floor-[a-f0-9]{32}$/u;
/*
 * The containment preflight boots one disposable overlay under its own fixed child of the MSI
 * task root - not a row, and never a descendant of one. It is admitted for the two early frames
 * only: MSI enables no late capture, so a late name under this root would widen the shared
 * validator for a caller that has no use for it.
 */
const EARLY_ONLY_ROOT_SUFFIX = "/containment-preflight";
const SCREENSHOT_PATH_PATTERN = /^(\/home\/runner\/work\/_temp\/myspeed-windows-(?:cpu-floor-[a-f0-9]{32}(?:\/post-release-baseline)?|msi-[a-f0-9]{32}\/(?:row-(?:0[0-9]|1[0-3])-[a-f0-9]{32}|containment-preflight)))\/(early|late)-boot-([12])\.png$/u;

export const LATE_BOOT_MILESTONE_OFFSETS_MILLISECONDS = Object.freeze([120_000, 300_000]);
export const MAX_LATE_BOOT_MILESTONES = 2;
export const INSTALLER_BOOT_CONFIRMATION = "single-enter-before-setup-v1";
export const INSTALLER_BOOT_CONFIRMATION_QCODE = "ret";
export const INSTALLER_BOOT_CONFIRMATION_HOLD_MILLISECONDS = 100;
export const INSTALLER_BOOT_CONFIRMATION_REQUESTED_OFFSET_MILLISECONDS = 2_000;
export const INSTALLER_BOOT_CONFIRMATION_LATEST_OFFSET_MILLISECONDS = 3_000;

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
        matches[0][1].endsWith(EARLY_ONLY_ROOT_SUFFIX))
        throw new TypeError("QMP late screenshot path is invalid");
    return [...paths];
}

export function validateInstallerBootConfirmation(value) {
    if (value === undefined || value === INSTALLER_BOOT_CONFIRMATION) return value;
    throw new TypeError("QMP installer boot confirmation is invalid");
}

export function validateInstallerBootInput(value, policy) {
    validateInstallerBootConfirmation(policy);
    if (policy === undefined) {
        if (value === false) return false;
        throw new TypeError("QMP installer boot input is invalid");
    }
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        value.kind !== "installer-boot-confirmation" || value.qcode !== INSTALLER_BOOT_CONFIRMATION_QCODE ||
        value.holdMilliseconds !== INSTALLER_BOOT_CONFIRMATION_HOLD_MILLISECONDS ||
        value.requestedOffsetMilliseconds !== INSTALLER_BOOT_CONFIRMATION_REQUESTED_OFFSET_MILLISECONDS ||
        !Number.isFinite(value.sentOffsetMilliseconds) ||
        value.sentOffsetMilliseconds < INSTALLER_BOOT_CONFIRMATION_REQUESTED_OFFSET_MILLISECONDS ||
        value.sentOffsetMilliseconds > INSTALLER_BOOT_CONFIRMATION_LATEST_OFFSET_MILLISECONDS ||
        value.acknowledged !== true || Object.keys(value).length !== 6)
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

function createMessageReader(readable, dependencies) {
    if (!readable || typeof readable[Symbol.asyncIterator] !== "function")
        throw new TypeError("QMP readable stream is invalid");
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
                if (messages > MAXIMUM_MESSAGES) throw new Error("QMP transcript bound exceeded");
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
            if (totalBytes > MAXIMUM_TRANSCRIPT_BYTES) throw new Error("QMP transcript bound exceeded");
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
    const screenshotRoot = screenshotPaths[0].slice(0, -"/early-boot-1.png".length);
    if (bootConfirmation !== undefined && !INSTALLER_BOOT_CONFIRMATION_ROOT_PATTERN.test(screenshotRoot))
        throw new TypeError("QMP installer boot confirmation root is invalid");
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

    const readMessage = createMessageReader(input.readable, dependencies);
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
        const elapsed = getTime() - sessionStartTime;
        if (elapsed > INSTALLER_BOOT_CONFIRMATION_LATEST_OFFSET_MILLISECONDS)
            throw new Error("QMP installer boot confirmation window elapsed");
        await cancellableDelay(Math.max(0, INSTALLER_BOOT_CONFIRMATION_REQUESTED_OFFSET_MILLISECONDS - elapsed),
            dependencies, session);
        if (session.cancelled || session.expired)
            throw new Error("QMP installer boot confirmation cancelled");
        let sentOffsetMilliseconds = null;
        await write({execute: "send-key", arguments: {keys: [{type: "qcode", data: INSTALLER_BOOT_CONFIRMATION_QCODE}],
            "hold-time": INSTALLER_BOOT_CONFIRMATION_HOLD_MILLISECONDS}, id: "installer-boot-confirmation"}, () => {
            sentOffsetMilliseconds = getTime() - sessionStartTime;
            if (!Number.isFinite(sentOffsetMilliseconds) ||
                sentOffsetMilliseconds < INSTALLER_BOOT_CONFIRMATION_REQUESTED_OFFSET_MILLISECONDS ||
                sentOffsetMilliseconds > INSTALLER_BOOT_CONFIRMATION_LATEST_OFFSET_MILLISECONDS)
                throw new Error("QMP installer boot confirmation window elapsed");
        });
        await expectResponse(readMessage, "installer-boot-confirmation");
        // A QMP acknowledgement proves only monitor acceptance, never guest-side receipt.
        inputSent = validateInstallerBootInput({kind: "installer-boot-confirmation",
            qcode: INSTALLER_BOOT_CONFIRMATION_QCODE, holdMilliseconds: INSTALLER_BOOT_CONFIRMATION_HOLD_MILLISECONDS,
            requestedOffsetMilliseconds: INSTALLER_BOOT_CONFIRMATION_REQUESTED_OFFSET_MILLISECONDS,
            sentOffsetMilliseconds, acknowledged: true}, bootConfirmation);
    }
    const wait = dependencies.wait ?? delay;
    const firstScreenshotDelay = bootConfirmation === undefined ? FIRST_SCREENSHOT_DELAY_MILLISECONDS :
        Math.max(0, FIRST_SCREENSHOT_DELAY_MILLISECONDS - (getTime() - sessionStartTime));
    for (const [index, milliseconds] of [firstScreenshotDelay,
        SECOND_SCREENSHOT_DELAY_MILLISECONDS].entries()) {
        await wait(milliseconds);
        const id = `screenshot-${index + 1}`;
        await write({execute: "screendump", arguments: {filename: screenshotPaths[index], format: "png"}, id});
        await expectResponse(readMessage, id);
    }
    const earlyResult = Object.freeze({version: Object.freeze({...version}), status: status.status, running: status.running,
        screenshotPaths: Object.freeze(screenshotPaths), inputSent});

    if (lateScreenshotPaths !== null) {
        const runLateMilestones = async () => {
            const milestones = [];
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
                }
            } catch {
                // Non-blocking failure handled gracefully
            }
            if (milestones.length === 0) return null;
            return Object.freeze({
                schemaVersion: 1,
                kind: "qemu-late-boot-observation",
                milestones: Object.freeze(milestones)
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
