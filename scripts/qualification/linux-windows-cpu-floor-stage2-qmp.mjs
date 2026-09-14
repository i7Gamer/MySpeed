const QMP_MESSAGE_TIMEOUT_MILLISECONDS = 10_000;
const QMP_SESSION_TIMEOUT_MILLISECONDS = 90_000;
const FIRST_SCREENSHOT_DELAY_MILLISECONDS = 5_000;
const SECOND_SCREENSHOT_DELAY_MILLISECONDS = 30_000;
const MAXIMUM_TRANSCRIPT_BYTES = 65_536;
const MAXIMUM_MESSAGES = 64;
const SCREENSHOT_PATH_PATTERN = /^(\/home\/runner\/work\/_temp\/myspeed-windows-cpu-floor-[a-f0-9]{32})\/early-boot-([12])\.png$/u;

function delay(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }

function validateScreenshots(paths) {
    if (!Array.isArray(paths) || paths.length !== 2) throw new TypeError("QMP screenshot path set is invalid");
    const matches = paths.map(value => typeof value === "string" ? value.match(SCREENSHOT_PATH_PATTERN) : null);
    if (!matches[0] || !matches[1] || matches[0][1] !== matches[1][1] || matches[0][2] !== "1" ||
        matches[1][2] !== "2") throw new TypeError("QMP screenshot path is invalid");
    return [...paths];
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
    if (typeof input.writeBytes !== "function") throw new TypeError("QMP writer is invalid");
    const readMessage = createMessageReader(input.readable, dependencies);
    const greeting = await readMessage();
    const version = greeting?.QMP?.version?.qemu;
    if (![version?.major, version?.minor, version?.micro].every(value => Number.isSafeInteger(value) && value >= 0) ||
        !Array.isArray(greeting?.QMP?.capabilities) ||
        !greeting.QMP.capabilities.every(value => typeof value === "string"))
        throw new Error("QMP greeting is invalid");
    const write = value => {
        if (session.expired) return Promise.reject(new Error("QMP session deadline exceeded"));
        return withDeadline(Promise.resolve().then(() => {
            if (session.expired) throw new Error("QMP session deadline exceeded");
            return input.writeBytes(Buffer.from(`${JSON.stringify(value)}\n`));
        }), dependencies);
    };
    await write({execute: "qmp_capabilities", id: "capabilities"});
    await expectResponse(readMessage, "capabilities");
    await write({execute: "query-status", id: "status"});
    const status = await expectResponse(readMessage, "status");
    if (typeof status.running !== "boolean" || typeof status.status !== "string" || status.status.length < 1)
        throw new Error("QMP status response is invalid");
    const wait = dependencies.wait ?? delay;
    for (const [index, milliseconds] of [FIRST_SCREENSHOT_DELAY_MILLISECONDS,
        SECOND_SCREENSHOT_DELAY_MILLISECONDS].entries()) {
        await wait(milliseconds);
        const id = `screenshot-${index + 1}`;
        await write({execute: "screendump", arguments: {filename: screenshotPaths[index], format: "png"}, id});
        await expectResponse(readMessage, id);
    }
    return Object.freeze({version: Object.freeze({...version}), status: status.status, running: status.running,
        screenshotPaths: Object.freeze(screenshotPaths), inputSent: false});
}

export function runEarlyBootQmpSession(input, dependencies = {}) {
    const session = {expired: false};
    return withDeadline(runSession(input, dependencies, session), dependencies, QMP_SESSION_TIMEOUT_MILLISECONDS,
        () => { session.expired = true; });
}
