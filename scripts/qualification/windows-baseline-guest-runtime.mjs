import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {spawn as spawnChild, spawnSync as spawnSyncChild} from "node:child_process";

import {checkPopulatedInstance} from "./check-artifact.mjs";
import {systemListeners} from "./safety.mjs";
import {checkPopulatedDatabase as inspectPopulatedDatabase,
    checkResetDatabase as inspectResetDatabase} from "./sqlite-check.mjs";
import {cleanupWindowsBaselineGuestFixture,
    materializeWindowsBaselineGuestFixture} from "./windows-baseline-guest-materializer.mjs";

const SUCCESS_EXIT_CODE = 0;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const PUBLICATION_POLL_MILLISECONDS = 50;
const CONTROLLER_EXIT_TIMEOUT_MILLISECONDS = 310_000;
const INSPECTION_TIMEOUT_MILLISECONDS = 30_000;
const INSPECTION_STREAM_BYTES = 262_144;
const MAX_CANDIDATE_BYTES = 512 * 1024 * 1024;

const jsonBytes = value => Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function writeNewJson(target, value) {
    const bytes = jsonBytes(value);
    if (bytes.length < 2 || bytes.length > MAX_JSON_BYTES) throw new Error("baseline guest JSON size differs");
    const handle = fs.openSync(target, "wx");
    try { fs.writeFileSync(handle, bytes); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    return sha256(bytes);
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function readPublishedJson(target, deadline = Date.now() + CONTROLLER_EXIT_TIMEOUT_MILLISECONDS) {
    for (;;) {
        if (Date.now() >= deadline) throw new Error("baseline guest JSON publication exceeded its deadline");
        try {
            const handle = fs.openSync(target, "r");
            try {
                const stat = fs.fstatSync(handle);
                if (!stat.isFile() || stat.size < 2 || stat.size > MAX_JSON_BYTES)
                    throw new Error("baseline guest JSON file differs");
                const bytes = fs.readFileSync(handle);
                if (bytes.length !== stat.size) throw new Error("baseline guest JSON read was truncated");
                return JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes));
            } finally { fs.closeSync(handle); }
        } catch (error) {
            if (!["ENOENT", "EBUSY", "EPERM"].includes(error?.code)) throw error;
            await delay(PUBLICATION_POLL_MILLISECONDS);
        }
    }
}

function waitForChild(child, timeoutMilliseconds, setTimer = setTimeout, clearTimer = clearTimeout) {
    return new Promise((resolve, reject) => {
        if (child.exitCode !== null) return resolve({exitCode: child.exitCode, signal: child.signalCode});
        let timer;
        const cleanup = () => { clearTimer(timer); child.off("error", onError); child.off("exit", onExit); };
        const onError = error => { cleanup(); reject(error); };
        const onExit = (exitCode, signal) => { cleanup(); resolve({exitCode, signal}); };
        child.once("error", onError); child.once("exit", onExit);
        timer = setTimer(() => { cleanup(); reject(new Error("baseline candidate controller exceeded its deadline")); },
            timeoutMilliseconds);
    });
}

function validateConfiguration(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("baseline runtime differs");
    for (const name of ["powershellPath", "wrapper", "candidateController", "cleanStopController", "network"])
        if (!(name in value)) throw new TypeError(`baseline runtime ${name} is absent`);
    if (typeof value.powershellPath !== "string" || !value.wrapper || !value.candidateController ||
        !value.cleanStopController) throw new TypeError("baseline runtime identity differs");
    return value;
}

function inspectCandidateWithWrapper(configuration, input, spawnSync) {
    const candidate = input?.request?.candidate;
    if (!candidate || typeof candidate.path !== "string" || typeof candidate.bytes !== "string" ||
        !/^[1-9][0-9]*$/u.test(candidate.bytes) || Number(candidate.bytes) > MAX_CANDIDATE_BYTES ||
        typeof candidate.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(candidate.sha256))
        throw new TypeError("baseline candidate inspection input differs");
    const argv = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
        configuration.wrapper.path, "-Mode", "InspectCandidate", "-InspectedCandidatePath", candidate.path,
        "-ExpectedCandidateSha256", candidate.sha256, "-MaximumCandidateBytes", String(MAX_CANDIDATE_BYTES),
        "-CandidateControllerPath", configuration.candidateController.path,
        "-ExpectedCandidateControllerSha256", configuration.candidateController.sha256,
        "-CleanStopControllerPath", configuration.cleanStopController.path,
        "-ExpectedCleanStopControllerSha256", configuration.cleanStopController.sha256];
    const result = spawnSync(configuration.powershellPath, argv, {cwd: path.dirname(candidate.path), encoding: "utf8",
        timeout: INSPECTION_TIMEOUT_MILLISECONDS, maxBuffer: INSPECTION_STREAM_BYTES, windowsHide: true});
    if (result.error !== undefined || result.signal !== null || result.status !== SUCCESS_EXIT_CODE ||
        result.stderr !== "" || Buffer.byteLength(result.stdout ?? "", "utf8") > INSPECTION_STREAM_BYTES)
        throw new Error("baseline candidate identity process failed");
    let value;
    try { value = JSON.parse(result.stdout); }
    catch { throw new TypeError("baseline candidate identity output is invalid"); }
    const expectedKeys = ["path", "finalPath", "bytes", "sha256", "volumeSerial", "fileId", "linkCount",
        "isRegular", "reparsePoint"];
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys.sort()) ||
        typeof value.path !== "string" || typeof value.finalPath !== "string" || typeof value.sha256 !== "string" ||
        typeof value.bytes !== "number" || !Number.isSafeInteger(value.bytes) || value.bytes < 1 ||
        value.bytes > MAX_CANDIDATE_BYTES || value.bytes !== Number(candidate.bytes) ||
        value.path.toLowerCase() !== candidate.path.toLowerCase() ||
        value.finalPath.toLowerCase() !== candidate.path.toLowerCase() || value.sha256 !== candidate.sha256 ||
        !/^[0-9a-f]{8}$/u.test(value.volumeSerial) || !/^[0-9a-f]{16}$/u.test(value.fileId) ||
        value.linkCount !== 1 || value.isRegular !== true || value.reparsePoint !== false)
        throw new TypeError("baseline candidate identity output differs");
    return {volumeSerial: value.volumeSerial, fileId: value.fileId};
}

export function createWindowsBaselineGuestRuntime(configuration) {
    const value = validateConfiguration(configuration);
    const supplied = value.dependencies ?? {};
    const syncSpawn = supplied.spawnSync ?? spawnSyncChild;
    const io = {writeNewJson, spawn: spawnChild, readPublishedJson,
        checkPopulated: async ({origin}) => {
            const started = Date.now(); await checkPopulatedInstance(origin); return {elapsedMs: Date.now() - started};
        },
        checkPopulatedDatabase: ({work, expected}) => inspectPopulatedDatabase(path.join(work, "data", "storage.db"),
            expected),
        checkResetDatabase: ({work}) => inspectResetDatabase(path.join(work, "data", "storage.db")),
        observeListener: ({port}) => ({listenerGone: !systemListeners(process.pid)
            .some(listener => Number(listener.port) === port)}),
        materialize: input => materializeWindowsBaselineGuestFixture({...input,
            dependencies: {checkPopulatedDatabase: inspectPopulatedDatabase}}),
        cleanup: cleanupWindowsBaselineGuestFixture,
        inspectCandidate: input => inspectCandidateWithWrapper(value, input, syncSpawn),
        setTimer: setTimeout, clearTimer: clearTimeout, now: Date.now, ...supplied};
    return Object.freeze({
        materialize: io.materialize,
        observeNetwork: async () => structuredClone(value.network),
        observeListener: io.observeListener,
        inspectCandidate: io.inspectCandidate,
        async startController({request, requestPath}) {
            const requestSha256 = io.writeNewJson(requestPath, request);
            const argv = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
                value.wrapper.path, "-Mode", "InvokeGuestCandidate", "-RequestPath", requestPath,
                "-ExpectedRequestSha256", requestSha256, "-CandidateControllerPath", value.candidateController.path,
                "-ExpectedCandidateControllerSha256", value.candidateController.sha256,
                "-CleanStopControllerPath", value.cleanStopController.path,
                "-ExpectedCleanStopControllerSha256", value.cleanStopController.sha256,
                "-ExpectedRunId", request.expectedRunId, "-ExpectedRunAttempt", request.expectedRunAttempt,
                "-ExpectedEventSha", request.expectedEventSha, "-ExpectedSourceSha", request.expectedSourceSha,
                "-ExpectedImageVersion", request.expectedImageVersion, "-ExpectedNonce", request.nonce];
            const startedAt = io.now();
            const child = io.spawn(value.powershellPath, argv, {cwd: request.taskRoot, windowsHide: true,
                stdio: "ignore"});
            const hardDeadline = startedAt + Math.min(request.hardDeadlineMs, CONTROLLER_EXIT_TIMEOUT_MILLISECONDS);
            const completion = waitForChild(child, Math.max(0, hardDeadline - io.now()),
                io.setTimer, io.clearTimer);
            completion.catch(() => undefined);
            return {child, request: structuredClone(request), requestSha256, argv, startedAt, completion};
        },
        readReady: ({request, started}) => io.readPublishedJson(request.readyPath,
            started.startedAt + request.normalDeadlineMs),
        checkPopulated: io.checkPopulated,
        waitController: ({started}) => started.completion,
        readResult: ({request, started}) => io.readPublishedJson(request.resultPath,
            started.startedAt + request.hardDeadlineMs),
        writeStop: ({request, value: stop}) => io.writeNewJson(request.stopRequestPath, stop),
        checkPopulatedDatabase: io.checkPopulatedDatabase,
        checkResetDatabase: io.checkResetDatabase,
        cleanup: io.cleanup
    });
}

export const WINDOWS_BASELINE_GUEST_RUNTIME_CONSTANTS = Object.freeze({CONTROLLER_EXIT_TIMEOUT_MILLISECONDS,
    MAX_JSON_BYTES, PUBLICATION_POLL_MILLISECONDS, SUCCESS_EXIT_CODE});

