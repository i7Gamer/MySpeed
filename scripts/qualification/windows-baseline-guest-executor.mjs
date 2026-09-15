import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {spawnSync as spawnSyncChild} from "node:child_process";
import {fileURLToPath} from "node:url";

import {createWindowsBaselineGuestOperations} from "./windows-baseline-guest-operations.mjs";
import {runWindowsBaselineGuest} from "./windows-baseline-guest-runner.mjs";
import {createWindowsBaselineGuestRuntime} from "./windows-baseline-guest-runtime.mjs";

const SCHEMA_VERSION = 1;
const PROFILE = "baseline-cpu";
const SUCCESS_EXIT_CODE = 0;
const FAILURE_EXIT_CODE = 1;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_FAILURE_CHARACTERS = 512;
const GUARD_TIMEOUT_MILLISECONDS = 30_000;
const GUARD_STREAM_BYTES = 262_144;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WRAPPER_PATH = path.join(HERE, "windows-baseline-guest-candidate-wrapper.ps1");
const POWERSHELL_RELATIVE_PATH = "System32\\WindowsPowerShell\\v1.0\\powershell.exe";

const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exactString = (value, pattern, label) => {
    const match = typeof value === "string" ? pattern.exec(value) : null;
    if (match === null || match.index !== 0 || match[0].length !== value.length)
        throw new TypeError(`${label} differs`);
    return value;
};

function readOwnedJson(identity, label) {
    exactString(identity?.path, /^(?:[A-Za-z]:\\|\\\\)[^\x00-\x1f\x7f]+$/u, `${label} path`);
    exactString(identity?.sha256, /^[0-9a-f]{64}$/u, `${label} SHA`);
    const handle = fs.openSync(identity.path, "r");
    try {
        const before = fs.fstatSync(handle, {bigint: true});
        const lexical = fs.lstatSync(identity.path, {bigint: true});
        if (!before.isFile() || !lexical.isFile() || lexical.isSymbolicLink() || before.nlink !== 1n ||
            before.dev !== lexical.dev || before.ino !== lexical.ino || before.size < 2n ||
            before.size > BigInt(MAX_JSON_BYTES) || fs.realpathSync.native(identity.path) !== identity.path)
            throw new Error(`${label} physical identity differs`);
        const bytes = fs.readFileSync(handle); const after = fs.fstatSync(handle, {bigint: true});
        if (BigInt(bytes.length) !== before.size || sha256(bytes) !== identity.sha256 || before.dev !== after.dev ||
            before.ino !== after.ino || before.size !== after.size || before.nlink !== after.nlink)
            throw new Error(`${label} content identity differs`);
        try { return JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes)); }
        catch { throw new TypeError(`${label} is not valid UTF-8 JSON`); }
    } finally { fs.closeSync(handle); }
}

function writeNewResult(target, value) {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
    if (bytes.length < 2 || bytes.length > MAX_JSON_BYTES) throw new Error("baseline result size differs");
    const temporary = `${target}.tmp`;
    if (fs.existsSync(target) || fs.existsSync(temporary)) throw new Error("baseline result path is not fresh");
    let handle;
    try {
        handle = fs.openSync(temporary, "wx+"); fs.writeFileSync(handle, bytes); fs.fsyncSync(handle);
        const observed = Buffer.alloc(bytes.length); let offset = 0;
        while (offset < observed.length) {
            const count = fs.readSync(handle, observed, offset, observed.length - offset, offset);
            if (count < 1) throw new Error("baseline result verification was truncated");
            offset += count;
        }
        if (!observed.equals(bytes)) throw new Error("baseline result write differs");
        fs.closeSync(handle); handle = undefined; fs.renameSync(temporary, target);
    } catch (error) {
        if (handle !== undefined) fs.closeSync(handle);
        try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* retained failure */ }
        throw error;
    }
}

function failure(error) {
    const message = (error instanceof Error ? error.message : String(error)).replace(/[\x00-\x1f\x7f]+/gu, " ")
        .slice(0, MAX_FAILURE_CHARACTERS) || "unspecified failure";
    return {schemaVersion: SCHEMA_VERSION, status: "failed", profile: PROFILE, cleanupProven: false,
        failure: message};
}

function validateResult(value) {
    if (!isObject(value) || value.schemaVersion !== SCHEMA_VERSION || value.profile !== PROFILE ||
        !["observed", "failed"].includes(value.status) || typeof value.cleanupProven !== "boolean")
        throw new TypeError("baseline guest result differs");
    if (value.status === "observed" && (value.cleanupProven !== true || !isObject(value.summary)))
        throw new TypeError("baseline guest success differs");
    if (value.status === "failed" && (typeof value.failure !== "string" || value.failure.length < 1 ||
        value.failure.length > MAX_FAILURE_CHARACTERS)) throw new TypeError("baseline guest failure differs");
    return value;
}

function powershellPath() {
    if (process.platform !== "win32" || typeof process.env.SystemRoot !== "string")
        throw new Error("baseline guest process host differs");
    return path.join(process.env.SystemRoot, POWERSHELL_RELATIVE_PATH);
}

function assertActualGuest(spawnSync = spawnSyncChild) {
    const shell = powershellPath();
    const result = spawnSync(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", WRAPPER_PATH, "-Mode", "TestActualGuard"], {encoding: "utf8", windowsHide: true,
        timeout: GUARD_TIMEOUT_MILLISECONDS, maxBuffer: GUARD_STREAM_BYTES});
    validateWindowsBaselineGuestGuardProcessResult(result);
}

export function validateWindowsBaselineGuestGuardProcessResult(result) {
    if (!isObject(result)) throw new Error("baseline guest guard process result differs");
    if (result.error !== undefined || result.signal !== null || result.status !== SUCCESS_EXIT_CODE ||
        result.stderr !== "" || Buffer.byteLength(result.stdout ?? "", "utf8") > GUARD_STREAM_BYTES)
        throw new Error(failure(new Error(`baseline guest guard process failed: `
            + `${result.error?.message ?? ""} ${result.stderr ?? ""}`)).failure);
    let value;
    try { value = JSON.parse(result.stdout); }
    catch { throw new TypeError("baseline guest guard output is invalid"); }
    if (!isObject(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["accepted", "profile"]) ||
        value.accepted !== true || value.profile !== PROFILE) throw new TypeError("baseline guest guard differs");
}

function defaultRuntime(request, execution, configuration = {}) {
    const shell = configuration.powershellPath ?? powershellPath();
    return createWindowsBaselineGuestRuntime({powershellPath: shell,
        wrapper: {path: WRAPPER_PATH, sha256: sha256(fs.readFileSync(WRAPPER_PATH))},
        candidateController: structuredClone(execution.candidateController),
        cleanStopController: structuredClone(execution.cleanStopController),
        network: {hardwareNics: 0, enabledNonLoopbackInterfaces: 0, nonLoopbackRoutes: 0},
        dependencies: configuration.dependencies});
}

export async function executeWindowsBaselineGuest(input, dependencies = {}) {
    const functionNames = ["assertGuest", "readJson", "writeResult", "createRuntime", "createOperations", "runGuest"];
    if (!isObject(dependencies) || Object.keys(dependencies).some(name =>
        name !== "runtimeConfiguration" && (!functionNames.includes(name) || typeof dependencies[name] !== "function")))
        return {exitCode: FAILURE_EXIT_CODE, result: failure(new TypeError("baseline executor dependencies differ"))};
    if (Object.hasOwn(dependencies, "runtimeConfiguration") && (!isObject(dependencies.runtimeConfiguration)
        || Object.keys(dependencies.runtimeConfiguration).some(name => !["powershellPath", "dependencies"].includes(name))))
        return {exitCode: FAILURE_EXIT_CODE, result: failure(new TypeError("baseline runtime configuration differs"))};
    const runtimeConfiguration = dependencies.runtimeConfiguration ?? {};
    if ((Object.hasOwn(runtimeConfiguration, "powershellPath") && typeof runtimeConfiguration.powershellPath !== "string")
        || (Object.hasOwn(runtimeConfiguration, "dependencies") && !isObject(runtimeConfiguration.dependencies)))
        return {exitCode: FAILURE_EXIT_CODE, result: failure(new TypeError("baseline runtime configuration differs"))};
    const io = {assertGuest: assertActualGuest, readJson: readOwnedJson, writeResult: writeNewResult,
        createRuntime: (request, execution) => defaultRuntime(request, execution, runtimeConfiguration),
        createOperations: createWindowsBaselineGuestOperations,
        runGuest: runWindowsBaselineGuest, ...dependencies};
    let result;
    try {
        if (!isObject(input)) throw new TypeError("baseline guest invocation differs");
        await io.assertGuest();
        const request = io.readJson({path: input.requestPath, sha256: input.expectedRequestSha256},
            "baseline guest request");
        const execution = io.readJson({path: input.executionPath, sha256: input.expectedExecutionSha256},
            "baseline guest execution manifest");
        const runtime = io.createRuntime(request, execution);
        const operations = io.createOperations({request, execution, dependencies: runtime});
        result = validateResult(await io.runGuest(request, operations));
    } catch (error) { result = failure(error); }
    try { io.writeResult(input.resultPath, result); }
    catch (error) { return {exitCode: FAILURE_EXIT_CODE, result: failure(error)}; }
    return {exitCode: result.status === "observed" ? SUCCESS_EXIT_CODE : FAILURE_EXIT_CODE, result};
}

function parseCommandLine(argv) {
    const names = ["--request", "--request-sha256", "--execution", "--execution-sha256", "--result"];
    if (argv.length !== names.length * 2) throw new TypeError("baseline guest arguments differ");
    const values = {};
    for (let index = 0; index < names.length; index += 1) {
        if (argv[index * 2] !== names[index]) throw new TypeError("baseline guest arguments differ");
        values[names[index]] = argv[index * 2 + 1];
    }
    return {requestPath: values["--request"], expectedRequestSha256: values["--request-sha256"],
        executionPath: values["--execution"], expectedExecutionSha256: values["--execution-sha256"],
        resultPath: values["--result"]};
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const output = await executeWindowsBaselineGuest(parseCommandLine(process.argv.slice(2)));
    process.exitCode = output.exitCode;
}

export const WINDOWS_BASELINE_GUEST_EXECUTOR_CONSTANTS = Object.freeze({GUARD_TIMEOUT_MILLISECONDS,
    MAX_FAILURE_CHARACTERS, MAX_JSON_BYTES, PROFILE});
