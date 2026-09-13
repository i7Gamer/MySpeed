#!/usr/bin/env node
import crypto from "node:crypto";
import dgram from "node:dgram";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

const SCHEMA_VERSION = 1;
const SANDBOX_EXECUTABLE = "/usr/bin/sandbox-exec";
const PROFILE_FILE = "macos-isolation.sb";
const EVIDENCE_FILE = "macos-isolation.json";
const SOURCE_PARAMETER = "SOURCE_ROOT";
const DEFAULT_SOURCE_SENTINEL = "package.json";
const TASK_PREFIX = "myspeed-macos-isolation-";
const SCRIPT_COPY = "macos-isolation.mjs";
const WORK_DIRECTORY = "work";
const NONCE_BYTES = 24;
const CANARY_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 2_000;
const MAX_OUTPUT_BYTES = 1_048_576;
const MAX_SOURCE_SENTINEL_BYTES = 1_048_576;
const FORBIDDEN_PORT = 9;
const TEST_NET_IPV4 = "192.0.2.1";
const TEST_NET_IPV6 = "2001:db8::1";
const LOOPBACK_IPV4 = "127.0.0.1";
const DGRAM_NOT_RUNNING_CODE = "ERR_SOCKET_DGRAM_NOT_RUNNING";
const ALLOWED_DENIAL_CODES = new Set(["EACCES", "EPERM"]);
const ARCHITECTURES = new Map([["x64", "X64"], ["arm64", "ARM64"]]);
const SAFE_ENVIRONMENT_KEYS = ["PATH", "LANG", "LC_ALL"];

const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const isWithin = (parent, candidate) => {
    const relative = path.relative(parent, candidate);
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
};

const assertPlainDirectory = (directory, label, lstat = fs.lstatSync) => {
    const stat = lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error(`${label} must be a non-symlink directory: ${directory}`);
};

export const buildSandboxProfile = () => `(version 1)
(allow default)
(deny network*)
(allow network-bind (local ip "localhost:*"))
(allow network-inbound (local ip "localhost:*"))
(allow network-outbound (remote ip "localhost:*"))
(deny file-read*
    (literal (param "${SOURCE_PARAMETER}"))
    (subpath (param "${SOURCE_PARAMETER}")))
(deny file-write*
    (literal (param "${SOURCE_PARAMETER}"))
    (subpath (param "${SOURCE_PARAMETER}")))
`;

export const parseArguments = values => {
    const [command, ...rest] = values;
    if (!new Set(["canary", "probe", "helper"]).has(command))
        throw new Error("macOS isolation command must be canary, probe, or helper");
    const allowed = command === "canary"
        ? new Set(["expected-arch", "source-root", "evidence-dir", "source-sentinel"])
        : command === "probe"
            ? new Set(["source-root", "source-sentinel", "work-root"])
            : new Set();
    const options = {};
    for (let index = 0; index < rest.length; index += 2) {
        const name = rest[index];
        const value = rest[index + 1];
        if (!name?.startsWith("--") || value === undefined) throw new Error(`Invalid argument ${name ?? ""}`);
        const key = name.slice(2);
        if (!allowed.has(key)) throw new Error(`Unknown ${command} argument --${key}`);
        const normalizedKey = key.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
        if (Object.hasOwn(options, normalizedKey)) throw new Error(`Duplicate ${command} argument --${key}`);
        options[normalizedKey] = value;
    }

    const required = command === "canary"
        ? ["expectedArch", "sourceRoot", "evidenceDir"]
        : command === "probe" ? ["sourceRoot", "sourceSentinel", "workRoot"] : [];
    for (const key of required)
        if (!options[key]) throw new Error(`Missing --${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`);
    if (command === "canary" && !options.sourceSentinel) options.sourceSentinel = DEFAULT_SOURCE_SENTINEL;
    return {command, ...options};
};

export const assertHostedMacEnvironment = ({expectedArch, sourceRoot, environment = process.env,
    platform = process.platform, architecture = process.arch, realpath = fs.realpathSync,
    lstat = fs.lstatSync}) => {
    if (platform !== "darwin") throw new Error("The isolation canary runs only on macOS");
    const runnerArch = ARCHITECTURES.get(expectedArch);
    if (!runnerArch) throw new Error("Expected architecture must be x64 or arm64");
    if (architecture !== expectedArch || environment.RUNNER_ARCH !== runnerArch)
        throw new Error(`Runner architecture does not match expected ${expectedArch}`);
    if (environment.CI !== "true" || environment.GITHUB_ACTIONS !== "true"
        || environment.RUNNER_ENVIRONMENT !== "github-hosted")
        throw new Error("The isolation canary requires a GitHub-hosted Actions runner");
    if (!path.isAbsolute(sourceRoot) || path.resolve(sourceRoot) !== sourceRoot)
        throw new Error("Source root must be an absolute canonical path");
    const runnerTempInput = environment.RUNNER_TEMP;
    if (!runnerTempInput || !path.isAbsolute(runnerTempInput) || path.resolve(runnerTempInput) !== runnerTempInput)
        throw new Error("RUNNER_TEMP must be an absolute canonical path");
    if (isWithin(path.resolve(sourceRoot), path.resolve(runnerTempInput))
        || isWithin(path.resolve(runnerTempInput), path.resolve(sourceRoot)))
        throw new Error("Source root and RUNNER_TEMP must be separate directory trees");

    assertPlainDirectory(sourceRoot, "Source root", lstat);
    assertPlainDirectory(runnerTempInput, "RUNNER_TEMP", lstat);
    const canonicalSource = realpath(sourceRoot);
    const canonicalTemp = realpath(runnerTempInput);
    if (canonicalSource !== sourceRoot || canonicalTemp !== runnerTempInput)
        throw new Error("Source root and RUNNER_TEMP must already use canonical paths");
    if (isWithin(canonicalSource, canonicalTemp) || isWithin(canonicalTemp, canonicalSource))
        throw new Error("Source root and RUNNER_TEMP must be separate directory trees");
    return {sourceRoot: canonicalSource, runnerTemp: canonicalTemp, architecture};
};

export const buildSandboxArguments = ({profileFile, sourceRoot, scriptFile, workRoot, sourceSentinel}) => {
    for (const [label, value] of Object.entries({profileFile, sourceRoot, scriptFile, workRoot, sourceSentinel}))
        if (!path.isAbsolute(value)) throw new Error(`${label} must be absolute`);
    return [
        "-D", `${SOURCE_PARAMETER}=${sourceRoot}`,
        "-f", profileFile,
        process.execPath, scriptFile, "probe",
        "--source-root", sourceRoot,
        "--source-sentinel", sourceSentinel,
        "--work-root", workRoot
    ];
};

const assertDenied = (result, label) => {
    if (!result || result.denied !== true || result.timedOut !== false
        || !ALLOWED_DENIAL_CODES.has(result.code))
        throw new Error(`${label} did not produce an immediate policy denial`);
};

const validateForbidden = (result, prefix) => {
    for (const key of ["tcp4", "tcp6", "udp4", "udp6"]) assertDenied(result?.[key], `${prefix} ${key}`);
};

export const validateProbeResult = result => {
    if (result?.schemaVersion !== SCHEMA_VERSION) throw new Error("Probe schema is invalid");
    if (result.loopback?.roundTrip !== true || result.loopback?.host !== LOOPBACK_IPV4)
        throw new Error("Loopback round-trip did not succeed");
    if (result.temporaryFile?.roundTrip !== true) throw new Error("Temporary-file round-trip did not succeed");
    assertDenied(result.sourceRoot, "Source-root probe");
    assertDenied(result.sourceSentinel, "Source-sentinel probe");
    validateForbidden(result.forbidden, "Main-process denial");
    if (result.helper?.inherited !== true) throw new Error("Helper did not prove inherited isolation");
    validateForbidden(result.helper.forbidden, "Helper denial");
    return result;
};

const fileDenial = (file, directory = false) => {
    try {
        if (directory) fs.readdirSync(file);
        else fs.readFileSync(file);
        return {denied: false, code: null, timedOut: false};
    } catch (error) {
        return {denied: ALLOWED_DENIAL_CODES.has(error?.code), code: error?.code ?? null, timedOut: false};
    }
};

const temporaryFileRoundTrip = workRoot => {
    const file = path.join(workRoot, "temporary-round-trip.txt");
    const contents = crypto.randomBytes(NONCE_BYTES).toString("hex");
    fs.writeFileSync(file, contents, {flag: "wx", mode: 0o600});
    const roundTrip = fs.readFileSync(file, "utf8") === contents;
    fs.rmSync(file);
    return {roundTrip};
};

const loopbackRoundTrip = async () => {
    const payload = crypto.randomBytes(NONCE_BYTES);
    const acceptedSockets = new Set();
    const server = net.createServer(socket => {
        acceptedSockets.add(socket);
        const chunks = [];
        socket.on("close", () => acceptedSockets.delete(socket));
        socket.on("data", bytes => {
            const received = Buffer.concat(chunks);
            chunks.push(bytes);
            if (received.length + bytes.length < payload.length) return;
            const complete = Buffer.concat(chunks);
            if (complete.equals(payload)) socket.end(payload);
            else socket.destroy(new Error("Loopback payload mismatch"));
        });
    });
    let client;
    let timer;
    try {
        await new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen({host: LOOPBACK_IPV4, port: 0, exclusive: true}, resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Loopback listener has no TCP address");
        const received = await new Promise((resolve, reject) => {
            const chunks = [];
            client = net.createConnection({host: LOOPBACK_IPV4, port: address.port});
            timer = setTimeout(() => reject(new Error("Loopback round-trip timed out")), PROBE_TIMEOUT_MS);
            client.once("error", reject);
            client.on("data", bytes => chunks.push(bytes));
            client.once("end", () => resolve(Buffer.concat(chunks)));
            client.once("connect", () => client.write(payload));
        });
        if (!received.equals(payload)) throw new Error("Loopback response mismatch");
        return {roundTrip: true, host: LOOPBACK_IPV4};
    } finally {
        clearTimeout(timer);
        client?.destroy();
        for (const socket of acceptedSockets) socket.destroy();
        if (server.listening) await new Promise(resolve => server.close(resolve));
    }
};

const tcpDenial = (host, family) => new Promise(resolve => {
    let socket;
    let timer;
    let settled = false;
    const finish = result => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket?.destroy();
        resolve(result);
    };
    timer = setTimeout(() => finish({denied: false, code: "ETIMEDOUT", timedOut: true}), PROBE_TIMEOUT_MS);
    try {
        socket = net.createConnection({host, port: FORBIDDEN_PORT, family});
        socket.once("connect", () => finish({denied: false, code: null, timedOut: false}));
        socket.once("error", error => finish({
            denied: ALLOWED_DENIAL_CODES.has(error?.code), code: error?.code ?? null, timedOut: false
        }));
    } catch (error) {
        finish({denied: ALLOWED_DENIAL_CODES.has(error?.code), code: error?.code ?? null, timedOut: false});
    }
});

const udpDenial = (host, type) => new Promise((resolve, reject) => {
    let socket;
    let timer;
    let settled = false;
    const finish = result => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
            socket?.close();
        } catch (error) {
            if (error?.code !== DGRAM_NOT_RUNNING_CODE) {
                reject(error);
                return;
            }
        }
        resolve(result);
    };
    timer = setTimeout(() => finish({denied: false, code: "ETIMEDOUT", timedOut: true}), PROBE_TIMEOUT_MS);
    try {
        socket = dgram.createSocket(type);
        socket.once("error", error => finish({
            denied: ALLOWED_DENIAL_CODES.has(error?.code), code: error?.code ?? null, timedOut: false
        }));
        socket.send(Buffer.from("myspeed-isolation-canary"), FORBIDDEN_PORT, host, error => finish(error ? {
            denied: ALLOWED_DENIAL_CODES.has(error.code), code: error.code ?? null, timedOut: false
        } : {denied: false, code: null, timedOut: false}));
    } catch (error) {
        finish({denied: ALLOWED_DENIAL_CODES.has(error?.code), code: error?.code ?? null, timedOut: false});
    }
});

const forbiddenProbes = async () => ({
    tcp4: await tcpDenial(TEST_NET_IPV4, 4),
    tcp6: await tcpDenial(TEST_NET_IPV6, 6),
    udp4: await udpDenial(TEST_NET_IPV4, "udp4"),
    udp6: await udpDenial(TEST_NET_IPV6, "udp6")
});

const helperProbe = () => {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "helper"], {
        encoding: "utf8",
        timeout: CANARY_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        stdio: ["ignore", "pipe", "pipe"]
    });
    if (result.error) throw result.error;
    if (result.status !== 0 || result.signal)
        throw new Error(`Isolation helper failed (${result.signal ?? result.status}): ${result.stderr}`);
    const helper = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    if (helper.inherited !== true) throw new Error("Isolation helper did not report inheritance");
    validateForbidden(helper.forbidden, "Helper denial");
    return helper;
};

export const runIsolationProbe = async ({sourceRoot, sourceSentinel, workRoot}, dependencies = {}) => {
    const runLoopback = dependencies.loopbackRoundTrip ?? loopbackRoundTrip;
    const runTemporaryFile = dependencies.temporaryFileRoundTrip ?? temporaryFileRoundTrip;
    const runFileDenial = dependencies.fileDenial ?? fileDenial;
    const runForbidden = dependencies.forbiddenProbes ?? forbiddenProbes;
    const runHelper = dependencies.helperProbe ?? helperProbe;
    const result = {
        schemaVersion: SCHEMA_VERSION,
        loopback: await runLoopback(),
        temporaryFile: runTemporaryFile(workRoot),
        sourceRoot: runFileDenial(sourceRoot, true),
        sourceSentinel: runFileDenial(sourceSentinel, false),
        forbidden: await runForbidden(),
        helper: runHelper()
    };
    return validateProbeResult(result);
};

const safeChildEnvironment = (environment, workRoot) => {
    const child = {TMPDIR: workRoot, HOME: workRoot};
    for (const key of SAFE_ENVIRONMENT_KEYS)
        if (typeof environment[key] === "string" && environment[key]) child[key] = environment[key];
    return child;
};

const createEvidenceDirectory = ({evidenceDir, runnerTemp, sourceRoot}) => {
    if (!path.isAbsolute(evidenceDir) || path.resolve(evidenceDir) !== evidenceDir)
        throw new Error("Evidence directory must be an absolute canonical path");
    if (path.dirname(evidenceDir) !== runnerTemp)
        throw new Error("Evidence directory must be a direct child of RUNNER_TEMP");
    if (isWithin(sourceRoot, evidenceDir) || isWithin(evidenceDir, sourceRoot))
        throw new Error("Evidence directory and source root must be separate directory trees");
    if (fs.existsSync(evidenceDir)) throw new Error(`Refusing existing evidence directory: ${evidenceDir}`);
    assertPlainDirectory(runnerTemp, "Evidence parent");
    if (fs.realpathSync(runnerTemp) !== runnerTemp)
        throw new Error("Evidence parent must already use its canonical path");
    fs.mkdirSync(evidenceDir, {mode: 0o700});
    assertPlainDirectory(evidenceDir, "Evidence directory");
    if (fs.realpathSync(evidenceDir) !== evidenceDir)
        throw new Error("Evidence directory must resolve to its requested canonical path");
};

const spawnErrorEvidence = error => error ? {
    code: typeof error.code === "string" ? error.code : null,
    message: error.message ?? String(error)
} : null;

const readBoundedSourceSentinel = (file, expectedBytes) => {
    const buffer = Buffer.alloc(expectedBytes + 1);
    const descriptor = fs.openSync(file, "r");
    let bytesRead = 0;
    try {
        while (bytesRead < buffer.length) {
            const count = fs.readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
            if (count === 0) break;
            bytesRead += count;
        }
    } finally {
        fs.closeSync(descriptor);
    }
    return buffer.subarray(0, bytesRead);
};

const removeOwnedTaskRoot = ({taskRoot, runnerTemp, runId}) => {
    if (path.dirname(taskRoot) !== runnerTemp || path.basename(taskRoot) !== `${TASK_PREFIX}${runId}`)
        throw new Error("Refusing cleanup outside the owned macOS isolation root");
    assertPlainDirectory(taskRoot, "macOS isolation root");
    fs.rmSync(taskRoot, {recursive: true, force: false});
};

export const runMacosIsolationCanary = (options, dependencies = {}) => {
    const environment = dependencies.environment ?? process.env;
    const platform = dependencies.platform ?? process.platform;
    const architecture = dependencies.architecture ?? process.arch;
    const readFile = dependencies.readFile ?? fs.readFileSync;
    const readDirectory = dependencies.readDirectory ?? fs.readdirSync;
    const readSourceSentinel = dependencies.readSourceSentinel ?? readBoundedSourceSentinel;
    const spawnSandbox = dependencies.spawnSandbox ?? spawnSync;
    const context = assertHostedMacEnvironment({
        expectedArch: options.expectedArch,
        sourceRoot: options.sourceRoot,
        environment,
        platform,
        architecture
    });
    if (!options.sourceSentinel || path.basename(options.sourceSentinel) !== options.sourceSentinel
        || options.sourceSentinel === "." || options.sourceSentinel === "..")
        throw new Error("Source sentinel must be one plain relative filename");
    const sourceSentinel = path.join(context.sourceRoot, options.sourceSentinel);
    const sentinelStat = fs.lstatSync(sourceSentinel);
    if (!sentinelStat.isFile() || sentinelStat.isSymbolicLink() || sentinelStat.nlink !== 1)
        throw new Error("Source sentinel must be an unlinked regular file");
    if (!Number.isSafeInteger(sentinelStat.size) || sentinelStat.size > MAX_SOURCE_SENTINEL_BYTES)
        throw new Error(`Source sentinel exceeds the ${MAX_SOURCE_SENTINEL_BYTES}-byte read limit`);
    createEvidenceDirectory({evidenceDir: options.evidenceDir, runnerTemp: context.runnerTemp,
        sourceRoot: context.sourceRoot});

    const runId = crypto.randomBytes(NONCE_BYTES).toString("hex");
    const taskRoot = path.join(context.runnerTemp, `${TASK_PREFIX}${runId}`);
    fs.mkdirSync(taskRoot, {mode: 0o700});
    const workRoot = path.join(taskRoot, WORK_DIRECTORY);
    const profile = Buffer.from(buildSandboxProfile());
    const profileFile = path.join(taskRoot, PROFILE_FILE);
    const evidenceProfile = path.join(options.evidenceDir, PROFILE_FILE);
    const scriptFile = path.join(taskRoot, SCRIPT_COPY);
    const evidence = {
        schemaVersion: SCHEMA_VERSION,
        status: "running",
        runId,
        architecture: context.architecture,
        platform,
        os: {version: os.version(), release: os.release()},
        runnerImage: {os: environment.ImageOS ?? null, version: environment.ImageVersion ?? null},
        sourceRoot: context.sourceRoot,
        sourceRootPreSandboxReadable: false,
        sourceSentinel: {path: sourceSentinel, byteLength: null, sha256: null, preSandboxReadable: false},
        sandboxExecutable: {path: SANDBOX_EXECUTABLE, sha256: null},
        profile: {path: PROFILE_FILE, sha256: sha256(profile)},
        probeScriptSha256: null,
        sandbox: null,
        probe: null,
        cleanup: {temporaryFilesRemoved: false, processTreeExitProven: false}
    };

    let failure;
    try {
        const sourceEntries = readDirectory(context.sourceRoot);
        if (!Array.isArray(sourceEntries) || !sourceEntries.includes(options.sourceSentinel))
            throw new Error("Source root pre-sandbox read did not find the sentinel");
        evidence.sourceRootPreSandboxReadable = true;
        const sentinelBytes = readSourceSentinel(sourceSentinel, sentinelStat.size);
        if (!Buffer.isBuffer(sentinelBytes) || sentinelBytes.length !== sentinelStat.size
            || sentinelBytes.length > MAX_SOURCE_SENTINEL_BYTES)
            throw new Error("Source sentinel changed or exceeded its bounded pre-sandbox read");
        evidence.sourceSentinel = {
            path: sourceSentinel,
            byteLength: sentinelBytes.length,
            sha256: sha256(sentinelBytes),
            preSandboxReadable: true
        };
        fs.mkdirSync(workRoot, {mode: 0o700});
        fs.writeFileSync(profileFile, profile, {flag: "wx", mode: 0o600});
        fs.writeFileSync(evidenceProfile, profile, {flag: "wx", mode: 0o600});
        const moduleBytes = readFile(fileURLToPath(import.meta.url));
        fs.writeFileSync(scriptFile, moduleBytes, {flag: "wx", mode: 0o500});
        evidence.probeScriptSha256 = sha256(moduleBytes);
        evidence.sandboxExecutable.sha256 = sha256(readFile(SANDBOX_EXECUTABLE));
        const args = buildSandboxArguments({profileFile, sourceRoot: context.sourceRoot, scriptFile,
            workRoot, sourceSentinel});
        const result = spawnSandbox(SANDBOX_EXECUTABLE, args, {
            cwd: taskRoot,
            env: safeChildEnvironment(environment, workRoot),
            encoding: "utf8",
            timeout: CANARY_TIMEOUT_MS,
            maxBuffer: MAX_OUTPUT_BYTES,
            stdio: ["ignore", "pipe", "pipe"]
        });
        evidence.sandbox = {
            status: result.status ?? null,
            signal: result.signal ?? null,
            stdout: result.stdout ?? "",
            stderr: result.stderr ?? "",
            error: spawnErrorEvidence(result.error)
        };
        if (result.error) throw result.error;
        if (result.status !== 0 || result.signal)
            throw new Error(`sandbox-exec failed with ${result.signal ?? result.status}: ${result.stderr ?? ""}`);
        const line = String(result.stdout).trim().split(/\r?\n/).at(-1);
        evidence.probe = validateProbeResult(JSON.parse(line));
        evidence.cleanup.processTreeExitProven = true;
        evidence.status = "passed";
    } catch (error) {
        failure = error;
        evidence.status = "failed";
        evidence.error = error?.stack ?? String(error);
    } finally {
        try {
            removeOwnedTaskRoot({taskRoot, runnerTemp: context.runnerTemp, runId});
            evidence.cleanup.temporaryFilesRemoved = true;
        } catch (error) {
            failure = failure
                ? new AggregateError([failure, error], "Canary and cleanup both failed") : error;
            evidence.status = "failed";
            evidence.error = failure?.stack ?? String(failure);
        }
        fs.writeFileSync(path.join(options.evidenceDir, EVIDENCE_FILE), JSON.stringify(evidence, null, 2) + "\n",
            {flag: "wx", mode: 0o600});
    }
    if (failure) throw failure;
    return evidence;
};

const main = async () => {
    const options = parseArguments(process.argv.slice(2));
    if (options.command === "canary") {
        const evidence = runMacosIsolationCanary(options);
        process.stdout.write(`${JSON.stringify(evidence)}\n`);
        return;
    }
    if (options.command === "probe") {
        const result = await runIsolationProbe(options);
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return;
    }
    const forbidden = await forbiddenProbes();
    validateForbidden(forbidden, "Helper denial");
    process.stdout.write(`${JSON.stringify({inherited: true, forbidden})}\n`);
};

const invokedDirectly = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main().catch(error => {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
});
