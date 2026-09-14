import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";

import {
    CAPABILITY_LIMITS,
    classifyKvmProbe,
    createClosureManifest,
    KVM_PROBE_SOURCE,
    runOwnedProcess,
    validateClosureManifest,
    validateHostedContext
} from "./linux-kvm-capability.mjs";

const SCHEMA_VERSION = 1;
const CORE_NAME = "linux-kvm-capability.mjs";
const CORE_MANIFEST_NAME = "closure.json";
const EXTENSION_NAME = "linux-kvm-privileged-capability.mjs";
const PRIVILEGED_MANIFEST_NAME = "privileged-closure.json";
const ORDINARY_RESULT_NAME = "result.json";
const PRIVILEGED_RESULT_NAME = "privileged-result.json";
const PROBE_NAME = "probe";
const SUDO_PATH = "/usr/bin/sudo";
const TIMEOUT_PATH = "/usr/bin/timeout";
const SHA256 = /^[a-f0-9]{64}$/;
const UINT_DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/;
const SAFE_VERSION = /^[^\x00-\x1f\x7f]+$/;
const TOOL_FACT_KEYS = Object.freeze(["dev", "gid", "ino", "mode", "size", "uid"]);
const PROCESS_IDENTITY_KEYS = Object.freeze(["kind", "pid", "schemaVersion", "startTicks"]);

export const PRIVILEGED_LIMITS = Object.freeze({
    outerTimeoutMs: 40_000,
    cleanupTimeoutMs: 5_000,
    rootTimeoutSeconds: 30,
    streamBytes: CAPABILITY_LIMITS.streamBytes,
    resultBytes: CAPABILITY_LIMITS.resultBytes,
    toolBytes: 67_108_864,
    pollIntervalMs: 50
});

function assertObject(value, name) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new TypeError(`${name} must be an object`);
    return value;
}

function assertKeys(value, expected, name) {
    assertObject(value, name);
    const actual = Object.keys(value).sort();
    const sorted = [...expected].sort();
    if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index]))
        throw new TypeError(`${name} keys are invalid`);
}

function assertExactString(value, pattern, name) {
    if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
    const match = value.match(pattern);
    if (!match || match.index !== 0 || match[0].length !== value.length) throw new TypeError(`${name} is invalid`);
    return value;
}

function deepFreeze(value) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value)) deepFreeze(child);
    }
    return value;
}

function sha256(bytes) {
    return crypto.createHash("sha256").update(bytes).digest("hex");
}

function sameJson(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function fileRecord(name, bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > PRIVILEGED_LIMITS.resultBytes)
        throw new TypeError(`${name} bytes are invalid`);
    return {name, bytes: bytes.length, sha256: sha256(bytes)};
}

export function createPrivilegedClosureManifest({context, coreBytes, extensionBytes, coreManifestBytes}) {
    const checkedContext = validateHostedContext(context);
    return deepFreeze({schemaVersion: SCHEMA_VERSION, context: checkedContext, files: [
        fileRecord(CORE_MANIFEST_NAME, coreManifestBytes), fileRecord(CORE_NAME, coreBytes),
        fileRecord(EXTENSION_NAME, extensionBytes)
    ]});
}

function validatePrivilegedClosureManifest({manifest, context, coreBytes, extensionBytes, coreManifestBytes}) {
    assertKeys(manifest, ["context", "files", "schemaVersion"], "privileged manifest");
    const expected = createPrivilegedClosureManifest({context, coreBytes, extensionBytes, coreManifestBytes});
    if (!sameJson(manifest, expected)) throw new TypeError("privileged closure manifest mismatch");
    return expected;
}

function assertProcess(value, name) {
    assertKeys(value, ["cleanupProven", "errorObserved", "exitCode", "signal", "stderrOverflow",
        "stdoutOverflow", "timedOut"], name);
    if (value.exitCode !== null && (!Number.isInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 255))
        throw new TypeError(`${name}.exitCode is invalid`);
    if (value.signal !== null && typeof value.signal !== "string") throw new TypeError(`${name}.signal is invalid`);
    for (const key of ["cleanupProven", "errorObserved", "stderrOverflow", "stdoutOverflow", "timedOut"])
        if (typeof value[key] !== "boolean") throw new TypeError(`${name}.${key} is invalid`);
    return value;
}

function assertObservation(value, name) {
    assertKeys(value, ["process", "stderr", "stdout"], name);
    assertProcess(value.process, `${name}.process`);
    if (!Buffer.isBuffer(value.stdout) || !Buffer.isBuffer(value.stderr) ||
        value.stdout.length > PRIVILEGED_LIMITS.streamBytes || value.stderr.length > PRIVILEGED_LIMITS.streamBytes)
        throw new TypeError(`${name} streams are invalid`);
    return value;
}

function serializedStream(bytes) {
    return {bytes: bytes.length, sha256: sha256(bytes), base64: bytes.toString("base64")};
}

function serializedObservation(value) {
    const observation = assertObservation(value, "observation");
    return {process: structuredClone(observation.process), stdout: serializedStream(observation.stdout),
        stderr: serializedStream(observation.stderr)};
}

function parseProbeProcessIdentity(bytes, name) {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > PRIVILEGED_LIMITS.streamBytes)
        throw new TypeError(`${name} is invalid`);
    let value;
    try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new TypeError(`${name} is not JSON`); }
    if (!bytes.equals(Buffer.from(`${JSON.stringify(value)}\n`))) throw new TypeError(`${name} bytes are not canonical`);
    assertKeys(value, PROCESS_IDENTITY_KEYS, name);
    if (value.schemaVersion !== SCHEMA_VERSION || value.kind !== "linux-kvm-probe-process" ||
        !Number.isInteger(value.pid) || value.pid <= 0 || value.pid > 0x7fffffff)
        throw new TypeError(`${name} identity is invalid`);
    assertExactString(value.startTicks, POSITIVE_DECIMAL, `${name} startTicks`);
    return deepFreeze(structuredClone(value));
}

function validateOrdinaryObservation({ordinary, ordinaryBytes, context, coreManifest, probeBytes}) {
    const checkedContext = validateHostedContext(context);
    if (!Buffer.isBuffer(ordinaryBytes) || ordinaryBytes.length === 0 ||
        ordinaryBytes.length > PRIVILEGED_LIMITS.resultBytes || !Buffer.isBuffer(probeBytes) ||
        probeBytes.length === 0 || probeBytes.length > CAPABILITY_LIMITS.probeBinaryBytes)
        throw new TypeError("ordinary evidence inputs are invalid");
    let parsed;
    try { parsed = JSON.parse(ordinaryBytes.toString("utf8")); }
    catch { throw new TypeError("ordinary evidence is not JSON"); }
    if (!sameJson(parsed, ordinary) || !ordinaryBytes.equals(Buffer.from(`${JSON.stringify(ordinary)}\n`)))
        throw new TypeError("ordinary evidence bytes do not match the record");
    assertObject(ordinary, "ordinary evidence");
    if (ordinary.schemaVersion !== SCHEMA_VERSION ||
        ordinary.classification !== "github-hosted-linux-kvm-capability-nonqualifying" ||
        !["permission-denied", "usable"].includes(ordinary.capability) || ordinary.qualifying !== false ||
        ordinary.releaseGateCleared !== false || !sameJson(ordinary.context, checkedContext) ||
        !sameJson(ordinary.closure, coreManifest.module))
        throw new TypeError("ordinary evidence identity is invalid");
    assertObject(ordinary.source, "ordinary source");
    assertExactString(ordinary.source.sha256, SHA256, "ordinary source hash");
    if (ordinary.source.sha256 !== sha256(Buffer.from(KVM_PROBE_SOURCE)) ||
        ordinary.source.bytes !== Buffer.byteLength(KVM_PROBE_SOURCE))
        throw new TypeError("ordinary source identity mismatch");
    assertObject(ordinary.probeBinary, "ordinary probe binary");
    if (ordinary.probeBinary.bytes !== probeBytes.length || ordinary.probeBinary.sha256 !== sha256(probeBytes))
        throw new TypeError("ordinary probe binary mismatch");
    const verdict = classifyKvmProbe({process: ordinary.process, probe: ordinary.probe});
    if (verdict.classification !== ordinary.capability || verdict.qualifying ||
        ordinary.status !== (verdict.usable ? "passed" : "failed"))
        throw new TypeError("ordinary evidence verdict is inconsistent");
    assertKeys(ordinary.streams, ["stderr", "stdout"], "ordinary streams");
    const expectedStdout = Buffer.from(`${JSON.stringify(ordinary.probe)}\n`);
    let processIdentity = null;
    for (const [name, expected] of [["stdout", expectedStdout], ["stderr", null]]) {
        const record = ordinary.streams[name];
        assertKeys(record, ["base64", "bytes", "sha256"], `ordinary ${name}`);
        assertExactString(record.sha256, SHA256, `ordinary ${name} hash`);
        if (typeof record.base64 !== "string") throw new TypeError(`ordinary ${name} base64 is invalid`);
        const decoded = Buffer.from(record.base64, "base64");
        if (record.base64 !== decoded.toString("base64") || record.bytes !== decoded.length ||
            record.sha256 !== sha256(decoded) || (expected && !decoded.equals(expected)))
            throw new TypeError(`ordinary ${name} bytes mismatch`);
        if (name === "stderr") processIdentity = parseProbeProcessIdentity(decoded, "ordinary probe process identity");
    }
    return {ordinary, verdict, processIdentity};
}

export function validateOrdinaryPermissionDenied(inputs) {
    const validated = validateOrdinaryObservation(inputs);
    if (validated.verdict.classification !== "permission-denied" || validated.verdict.usable)
        throw new TypeError("ordinary evidence is not an exact permission denial");
    return validated.ordinary;
}

function assertProbePath(probePath, workRoot, context) {
    if (typeof probePath !== "string") throw new TypeError("probePath must be a string");
    if (typeof workRoot !== "string" || path.basename(workRoot) !== `myspeed-kvm-capability-${context.nonce}` ||
        !path.posix.isAbsolute(workRoot) || path.posix.normalize(workRoot) !== workRoot ||
        path.posix.dirname(probePath) !== workRoot || path.posix.basename(probePath) !== PROBE_NAME)
        throw new TypeError("probePath is invalid");
    return probePath;
}

export function buildPrivilegedArguments(probePath) {
    const pattern = /^\/[^\x00-\x1f\x7f]*\/myspeed-kvm-capability-[a-f0-9]{32}\/probe$/;
    const match = typeof probePath === "string" ? probePath.match(pattern) : null;
    if (!match || match[0] !== probePath || probePath.includes("//") || probePath.includes("/../"))
        throw new TypeError("probePath is invalid");
    return Object.freeze(["-n", "--", TIMEOUT_PATH, "--foreground", "--signal=KILL",
        `${PRIVILEGED_LIMITS.rootTimeoutSeconds}s`, probePath]);
}

function validateTool(value, expectedPath, name) {
    assertKeys(value, ["bytes", "facts", "path"], `${name} identity`);
    if (value.path !== expectedPath || !Buffer.isBuffer(value.bytes) || value.bytes.length === 0 ||
        value.bytes.length > PRIVILEGED_LIMITS.toolBytes) throw new TypeError(`${name} identity is invalid`);
    assertKeys(value.facts, TOOL_FACT_KEYS, `${name} facts`);
    for (const key of TOOL_FACT_KEYS)
        assertExactString(value.facts[key], ["uid", "gid"].includes(key) ? UINT_DECIMAL : POSITIVE_DECIMAL,
            `${name} facts.${key}`);
    const mode = BigInt(value.facts.mode);
    if (value.facts.uid !== "0" || BigInt(value.facts.size) !== BigInt(value.bytes.length) ||
        (mode & 0o170000n) !== 0o100000n || (mode & 0o22n) !== 0n)
        throw new TypeError(`${name} ownership or mode is invalid`);
    return value;
}

function validateVersionObservation(observation, name) {
    assertObservation(observation, `${name} version observation`);
    if (observation.process.exitCode !== 0 || observation.process.signal !== null || observation.process.timedOut ||
        observation.process.stdoutOverflow || observation.process.stderrOverflow ||
        !observation.process.cleanupProven || observation.process.errorObserved)
        throw new Error(`${name} version observation failed`);
    const version = observation.stdout.toString("utf8").split(/\r?\n/, 1)[0];
    assertExactString(version, SAFE_VERSION, `${name} version`);
    return version;
}

function validateProcessState(value, identity, probePath) {
    assertKeys(value, value.state === "absent" ? ["state"] : ["executablePath", "pid", "startTicks", "state"],
        "owned probe process state");
    if (value.state === "absent") return {state: "absent"};
    if (value.state !== "present" || value.pid !== identity.pid || value.startTicks !== identity.startTicks ||
        value.executablePath !== probePath) throw new TypeError("owned probe process identity is ambiguous");
    return structuredClone(value);
}

async function waitForNoOwnedProbe(operations, identity, probePath) {
    const started = operations.monotonicMs();
    if (!Number.isFinite(started) || started < 0) throw new TypeError("cleanup clock is invalid");
    while (true) {
        const state = validateProcessState(operations.observeOwnedProbeProcess(identity, probePath), identity, probePath);
        if (state.state === "absent") return state;
        const now = operations.monotonicMs();
        if (!Number.isFinite(now) || now < started) throw new TypeError("cleanup clock is invalid");
        if (now - started >= PRIVILEGED_LIMITS.cleanupTimeoutMs) return state;
        await operations.sleep(PRIVILEGED_LIMITS.pollIntervalMs);
    }
}

function capabilityFor(observation, probe, afterState) {
    if (afterState.state !== "absent" || !observation.process.cleanupProven) return "cleanup-unproved";
    if (observation.process.timedOut || observation.process.stdoutOverflow || observation.process.stderrOverflow ||
        observation.process.errorObserved || observation.process.exitCode !== 0 || observation.process.signal !== null)
        return "process-failed";
    return classifyKvmProbe({process: observation.process, probe}).classification;
}

function sanitizeFailure(error) {
    return (error instanceof Error ? error.message : String(error)).replace(/[\x00-\x1f\x7f]+/g, " ").slice(0, 512) ||
        "unspecified failure";
}

export async function runPrivilegedRetry(request, operations) {
    assertKeys(request, ["context", "coreManifest", "ordinary", "ordinaryBytes", "probePath", "resultPath", "workRoot"],
        "request");
    const checkedContext = validateHostedContext(request.context);
    const probePath = assertProbePath(request.probePath, request.workRoot, checkedContext);
    const expectedResult = path.posix.join(request.workRoot, PRIVILEGED_RESULT_NAME);
    if (request.resultPath !== expectedResult) throw new TypeError("resultPath is invalid");
    for (const name of ["observeOwnedProbeProcess", "monotonicMs", "readProbe", "resolveTool", "runOwned", "sleep",
        "writeExclusive"])
        if (typeof operations?.[name] !== "function") throw new TypeError(`operations.${name} is required`);
    let ordinaryIdentity = null;
    let stage = "ordinary-evidence";
    try {
        const probeBefore = operations.readProbe(probePath, CAPABILITY_LIMITS.probeBinaryBytes);
        const ordinaryObservation = validateOrdinaryObservation({ordinary: request.ordinary,
            ordinaryBytes: request.ordinaryBytes,
            context: checkedContext, coreManifest: request.coreManifest, probeBytes: probeBefore});
        ordinaryIdentity = {bytes: request.ordinaryBytes.length, sha256: sha256(request.ordinaryBytes),
            capability: ordinaryObservation.verdict.classification};
        if (ordinaryObservation.verdict.usable) {
            const skipped = deepFreeze({schemaVersion: SCHEMA_VERSION, status: "observed",
                classification: "github-hosted-linux-kvm-privileged-capability-nonqualifying",
                capability: "ordinary-usable", retryPerformed: false, qualifying: false, releaseGateCleared: false,
                context: checkedContext, ordinary: ordinaryIdentity});
            operations.writeExclusive(request.resultPath, `${JSON.stringify(skipped)}\n`, PRIVILEGED_LIMITS.resultBytes);
            return skipped;
        }
        if (ordinaryObservation.verdict.classification !== "permission-denied")
            throw new Error("ordinary observation does not authorize privileged retry");
        stage = "tool-identities";
        const sudo = validateTool(operations.resolveTool(SUDO_PATH, PRIVILEGED_LIMITS.toolBytes), SUDO_PATH, "sudo");
        const timeout = validateTool(operations.resolveTool(TIMEOUT_PATH, PRIVILEGED_LIMITS.toolBytes), TIMEOUT_PATH,
            "timeout");
        stage = "tool-versions";
        const sudoVersionObservation = await operations.runOwned(SUDO_PATH, ["--version"],
            CAPABILITY_LIMITS.probeTimeoutMs);
        const timeoutVersionObservation = await operations.runOwned(TIMEOUT_PATH, ["--version"],
            CAPABILITY_LIMITS.probeTimeoutMs);
        const sudoVersion = validateVersionObservation(sudoVersionObservation, "sudo");
        const timeoutVersion = validateVersionObservation(timeoutVersionObservation, "timeout");
        stage = "privileged-retry";
        const argv = buildPrivilegedArguments(probePath);
        const retry = assertObservation(await operations.runOwned(SUDO_PATH, argv, PRIVILEGED_LIMITS.outerTimeoutMs),
            "privileged retry");
        let probe = null, processIdentity = null;
        try { probe = JSON.parse(retry.stdout.toString("utf8")); } catch { /* classified as failed below */ }
        try { processIdentity = parseProbeProcessIdentity(retry.stderr, "privileged probe process identity"); }
        catch { /* missing identity makes cleanup unproved below */ }
        stage = "root-process-cleanup";
        const afterState = processIdentity === null ? {state: "ambiguous"} :
            await waitForNoOwnedProbe(operations, processIdentity, probePath);
        stage = "identity-revalidation";
        const probeAfter = operations.readProbe(probePath, CAPABILITY_LIMITS.probeBinaryBytes);
        const sudoAfter = validateTool(operations.resolveTool(SUDO_PATH, PRIVILEGED_LIMITS.toolBytes), SUDO_PATH, "sudo");
        const timeoutAfter = validateTool(operations.resolveTool(TIMEOUT_PATH, PRIVILEGED_LIMITS.toolBytes), TIMEOUT_PATH,
            "timeout");
        if (!Buffer.isBuffer(probeAfter) || !probeAfter.equals(probeBefore) || !sudoAfter.bytes.equals(sudo.bytes) ||
            !timeoutAfter.bytes.equals(timeout.bytes) || !sameJson(sudoAfter.facts, sudo.facts) ||
            !sameJson(timeoutAfter.facts, timeout.facts)) throw new Error("executed file identity changed");
        let capability = afterState.state !== "absent" || !retry.process.cleanupProven ?
            "cleanup-unproved" : "process-failed";
        if (probe !== null && capability !== "cleanup-unproved") {
            try { capability = capabilityFor(retry, probe, afterState); } catch { capability = "process-failed"; }
        }
        const evidence = deepFreeze({schemaVersion: SCHEMA_VERSION, status: capability === "usable" ? "observed" : "failed",
            classification: "github-hosted-linux-kvm-privileged-capability-nonqualifying", capability,
            retryPerformed: true, qualifying: false, releaseGateCleared: false, context: checkedContext,
            ordinary: ordinaryIdentity,
            privileged: {argv: [...argv], probeBinary: {bytes: probeBefore.length, sha256: sha256(probeBefore)},
                tools: {sudo: {path: sudo.path, facts: structuredClone(sudo.facts), bytes: sudo.bytes.length,
                    sha256: sha256(sudo.bytes), version: sudoVersion,
                    versionObservation: serializedObservation(sudoVersionObservation)},
                timeout: {path: timeout.path, facts: structuredClone(timeout.facts), bytes: timeout.bytes.length,
                    sha256: sha256(timeout.bytes),
                    version: timeoutVersion, versionObservation: serializedObservation(timeoutVersionObservation)}},
                observation: serializedObservation(retry), probe,
                rootProbeProcess: {identity: processIdentity, after: afterState}}});
        operations.writeExclusive(request.resultPath, `${JSON.stringify(evidence)}\n`, PRIVILEGED_LIMITS.resultBytes);
        return evidence;
    } catch (error) {
        const failure = deepFreeze({schemaVersion: SCHEMA_VERSION, status: "failed",
            classification: "github-hosted-linux-kvm-privileged-capability-nonqualifying",
            capability: stage === "root-process-cleanup" ? "cleanup-unproved" : "execution-failed",
            qualifying: false, releaseGateCleared: false, context: checkedContext, ordinary: ordinaryIdentity,
            stage, error: sanitizeFailure(error)});
        operations.writeExclusive(request.resultPath, `${JSON.stringify(failure)}\n`, PRIVILEGED_LIMITS.resultBytes);
        return failure;
    }
}

function readOwnedFile(filePath, maximumBytes) {
    const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const before = fs.fstatSync(descriptor, {bigint: true});
        if (!before.isFile() || before.size <= 0n || before.size > BigInt(maximumBytes))
            throw new Error("owned file size is invalid");
        const bytes = Buffer.alloc(Number(before.size));
        let offset = 0;
        while (offset < bytes.length) {
            const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
            if (count === 0) throw new Error("owned file read was truncated");
            offset += count;
        }
        const after = fs.fstatSync(descriptor, {bigint: true});
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
            before.mtimeNs !== after.mtimeNs) throw new Error("owned file changed while reading");
        return bytes;
    } finally { fs.closeSync(descriptor); }
}

function writeExclusive(filePath, bytes, maximumBytes) {
    const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    if (value.length === 0 || value.length > maximumBytes) throw new Error("output size is invalid");
    fs.writeFileSync(filePath, value, {encoding: null, flag: "wx", mode: 0o600});
}

function fixedSpawn(command, argv, options) {
    return spawn(command, argv, {...options, env: {LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin"}, shell: false});
}

function processStartTicks(stat) {
    const close = stat.lastIndexOf(") ");
    if (close < 0) throw new Error("process stat is malformed");
    const fields = stat.slice(close + 2).split(" ");
    return assertExactString(fields[19], POSITIVE_DECIMAL, "process start ticks");
}

function observeOwnedProbeProcess(identity, probePath) {
    const procRoot = `/proc/${identity.pid}`;
    try {
        const before = processStartTicks(fs.readFileSync(`${procRoot}/stat`, "utf8"));
        const executablePath = fs.readlinkSync(`${procRoot}/exe`);
        const after = processStartTicks(fs.readFileSync(`${procRoot}/stat`, "utf8"));
        if (before !== identity.startTicks || after !== identity.startTicks || executablePath !== probePath)
            throw new Error("owned probe PID is reused or ambiguous");
        return {state: "present", pid: identity.pid, startTicks: identity.startTicks, executablePath};
    } catch (error) {
        if (["ENOENT", "ESRCH"].includes(error.code)) return {state: "absent"};
        throw error;
    }
}

function readRootOwnedTool(toolPath, maximumBytes) {
    if (![SUDO_PATH, TIMEOUT_PATH].includes(toolPath) || fs.realpathSync(toolPath) !== toolPath)
        throw new Error("tool path is invalid");
    const descriptor = fs.openSync(toolPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const before = fs.fstatSync(descriptor, {bigint: true});
        if (!before.isFile() || before.size <= 0n || before.size > BigInt(maximumBytes))
            throw new Error("tool size is invalid");
        const bytes = Buffer.alloc(Number(before.size));
        let offset = 0;
        while (offset < bytes.length) {
            const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
            if (count === 0) throw new Error("tool read was truncated");
            offset += count;
        }
        const after = fs.fstatSync(descriptor, {bigint: true});
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
            before.mtimeNs !== after.mtimeNs || before.mode !== after.mode || before.uid !== after.uid ||
            before.gid !== after.gid) throw new Error("tool identity changed while reading");
        return {path: toolPath, bytes, facts: {dev: before.dev.toString(), ino: before.ino.toString(),
            mode: before.mode.toString(), uid: before.uid.toString(), gid: before.gid.toString(),
            size: before.size.toString()}};
    } finally { fs.closeSync(descriptor); }
}

const nativeOperations = Object.freeze({
    readProbe: readOwnedFile,
    resolveTool: readRootOwnedTool,
    runOwned(command, argv, timeoutMs) {
        return runOwnedProcess(command, argv, timeoutMs, {spawnImpl: fixedSpawn});
    },
    observeOwnedProbeProcess,
    monotonicMs: () => Number(process.hrtime.bigint() / 1_000_000n),
    sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    writeExclusive
});

function parseArguments(argv) {
    if (argv.length < 1) throw new TypeError("mode is required");
    const options = {};
    for (let index = 1; index < argv.length; index += 2) {
        if (!argv[index]?.startsWith("--") || index + 1 >= argv.length) throw new TypeError("arguments are invalid");
        const key = argv[index].slice(2);
        if (Object.hasOwn(options, key)) throw new TypeError(`duplicate option: ${key}`);
        options[key] = argv[index + 1];
    }
    return {mode: argv[0], options};
}

function assertOptionKeys(options, expected) {
    const actual = Object.keys(options).sort(), sorted = [...expected].sort();
    if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index]))
        throw new TypeError("option schema mismatch");
}

function contextFromEnvironment(options) {
    return validateHostedContext({schemaVersion: SCHEMA_VERSION, repository: process.env.GITHUB_REPOSITORY,
        sourceSha: options["source-sha"], eventSha: options["event-sha"], runId: options["run-id"],
        runAttempt: options["run-attempt"], nonce: options.nonce,
        environment: {GITHUB_ACTIONS: process.env.GITHUB_ACTIONS, CI: process.env.CI,
            RUNNER_OS: process.env.RUNNER_OS, RUNNER_ARCH: process.env.RUNNER_ARCH,
            RUNNER_ENVIRONMENT: process.env.RUNNER_ENVIRONMENT, ImageOS: process.env.ImageOS,
            ImageVersion: process.env.ImageVersion}});
}

function directChild(parent, candidate, expectedName) {
    const resolved = path.resolve(candidate);
    if (path.dirname(resolved) !== parent || path.basename(resolved) !== expectedName)
        throw new TypeError(`${expectedName} is not an exact direct child`);
    return resolved;
}

async function emitManifest(options) {
    assertOptionKeys(options, ["core", "core-manifest", "event-sha", "nonce", "output", "run-attempt", "run-id",
        "source-sha"]);
    const context = contextFromEnvironment(options);
    const closureRoot = fs.realpathSync(path.dirname(fileURLToPath(import.meta.url)));
    const corePath = directChild(closureRoot, options.core, CORE_NAME);
    const coreManifestPath = directChild(closureRoot, options["core-manifest"], CORE_MANIFEST_NAME);
    const outputPath = directChild(closureRoot, options.output, PRIVILEGED_MANIFEST_NAME);
    const manifest = createPrivilegedClosureManifest({context, coreBytes: readOwnedFile(corePath, PRIVILEGED_LIMITS.resultBytes),
        extensionBytes: readOwnedFile(fileURLToPath(import.meta.url), PRIVILEGED_LIMITS.resultBytes),
        coreManifestBytes: readOwnedFile(coreManifestPath, PRIVILEGED_LIMITS.resultBytes)});
    writeExclusive(outputPath, `${JSON.stringify(manifest)}\n`, PRIVILEGED_LIMITS.resultBytes);
}

async function retry(options) {
    assertOptionKeys(options, ["closure-root", "core-manifest", "event-sha", "manifest", "nonce", "ordinary-result",
        "result", "run-attempt", "run-id", "source-sha"]);
    const context = contextFromEnvironment(options);
    const runnerTemp = fs.realpathSync(process.env.RUNNER_TEMP);
    const closureRoot = fs.realpathSync(options["closure-root"]);
    if (closureRoot !== path.join(runnerTemp, "linux-kvm-capability-closure"))
        throw new TypeError("closure root mismatch");
    const extensionPath = directChild(closureRoot, fileURLToPath(import.meta.url), EXTENSION_NAME);
    const corePath = directChild(closureRoot, path.join(closureRoot, CORE_NAME), CORE_NAME);
    const coreManifestPath = directChild(closureRoot, options["core-manifest"], CORE_MANIFEST_NAME);
    const privilegedManifestPath = directChild(closureRoot, options.manifest, PRIVILEGED_MANIFEST_NAME);
    const coreBytes = readOwnedFile(corePath, PRIVILEGED_LIMITS.resultBytes);
    const extensionBytes = readOwnedFile(extensionPath, PRIVILEGED_LIMITS.resultBytes);
    const coreManifestBytes = readOwnedFile(coreManifestPath, PRIVILEGED_LIMITS.resultBytes);
    const coreManifest = validateClosureManifest({manifest: JSON.parse(coreManifestBytes.toString("utf8")),
        moduleBytes: coreBytes,
        expectedContext: context});
    validatePrivilegedClosureManifest({manifest: JSON.parse(readOwnedFile(privilegedManifestPath,
        PRIVILEGED_LIMITS.resultBytes).toString("utf8")), context, coreBytes, extensionBytes, coreManifestBytes});
    const workRoot = path.join(runnerTemp, `myspeed-kvm-capability-${context.nonce}`);
    const ordinaryResultPath = directChild(workRoot, options["ordinary-result"], ORDINARY_RESULT_NAME);
    const resultPath = directChild(workRoot, options.result, PRIVILEGED_RESULT_NAME);
    const ordinaryBytes = readOwnedFile(ordinaryResultPath, PRIVILEGED_LIMITS.resultBytes);
    const ordinary = JSON.parse(ordinaryBytes.toString("utf8"));
    const probePath = directChild(workRoot, path.join(workRoot, PROBE_NAME), PROBE_NAME);
    await runPrivilegedRetry({context, coreManifest, ordinary, ordinaryBytes, probePath, resultPath, workRoot},
        nativeOperations);
}

async function cli() {
    const {mode, options} = parseArguments(process.argv.slice(2));
    if (mode === "emit-manifest") await emitManifest(options);
    else if (mode === "retry") await retry(options);
    else throw new TypeError("unknown mode");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    cli().catch(error => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
