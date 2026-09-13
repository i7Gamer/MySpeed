#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
    assertLinuxNetworkIsolation,
    assertOwnedListener,
    assertOriginalBuildUnavailable,
    assertPortFree,
    buildLocalOrigin,
    checkJsonResponse,
    checkPng,
    requestLocal,
    sanitizedEnvironment,
    stopOwnedProcess,
    systemListeners,
    waitForListenerFreeExit,
    waitForOwnedListener,
    waitForProcessExit
} from "./safety.mjs";
import {
    CONFIG_SENTINEL,
    FIXTURE_MARKER,
    loadHandoffFixture,
    makeFixtureAccessibleToUid,
    SYNTHETIC_PASSWORD,
    TEST_RESULT_SENTINEL
} from "./fixture.mjs";
import { checkPopulatedDatabase, checkResetDatabase, inspectPopulatedDatabase } from "./sqlite-check.mjs";

const LISTEN_TIMEOUT_MS = 30_000;
const PROCESS_EXIT_TIMEOUT_MS = 30_000;
const RESET_NOTHING_TO_DO_EXIT = 113;
const SUCCESS_EXIT = 0;
export const EVIDENCE_DIRECTORY_MODE = 0o755;
export const EVIDENCE_FILE_MODE = 0o644;
const MIN_CLIENT_BYTES = 128;
const MIN_JAVASCRIPT_BYTES = 32;
const RUNTIME_PROBE_TIMEOUT_MS = 10_000;
const HEALTHCHECK_HANDSHAKE_TIMEOUT_MS = 20_000;
const HEALTHCHECK_HANDSHAKE_POLL_MS = 100;
const HEALTHCHECK_NONCE_BYTES = 24;
const HEALTHCHECK_REQUEST = "healthcheck-request.json";
const HEALTHCHECK_ACKNOWLEDGEMENT = "healthcheck-ack.json";
const WORK_PREFIX = "myspeed-qualification-";
const EVIDENCE_PREFIX = "myspeed-evidence-";

export const parseArguments = (values) => {
    const options = {args: [], mode: "full", keepWork: false};

    for (let index = 0; index < values.length; index += 1) {
        const name = values[index];
        if (name === "--keep-work") {
            options.keepWork = true;
            continue;
        }
        const value = values[++index];
        if (!name?.startsWith("--") || value === undefined) throw new Error(`Invalid verifier argument "${name ?? ""}"`);
        if (name === "--arg") options.args.push(value);
        else options[name.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    }

    if (!options.command) throw new Error("Missing --command");
    if (!new Set(["full", "listener-free-reset"]).has(options.mode))
        throw new Error("--mode must be full or listener-free-reset");
    if (options.healthcheckHandshake && options.mode !== "full")
        throw new Error("--healthcheck-handshake requires full verification");
    if (options.preseededFixtureManifest) {
        if (options.repo) throw new Error("--preseeded-fixture-manifest forbids --repo");
        if (options.sourceSha) throw new Error("--preseeded-fixture-manifest takes source identity from its manifest");
        if (!options.work) throw new Error("--preseeded-fixture-manifest requires --work");
        if (!options.resetWork) throw new Error("--preseeded-fixture-manifest requires --reset-work");
        if (!options.keepWork) throw new Error("--preseeded-fixture-manifest requires --keep-work");
        if (options.mode !== "full") throw new Error("A preseeded fixture manifest requires full verification");
    } else {
        if (!options.repo) throw new Error("Missing --repo");
        if (options.resetWork) throw new Error("--reset-work requires --preseeded-fixture-manifest");
    }
    return options;
};

const makeDirectory = (parent, prefix) => {
    fs.mkdirSync(parent, {recursive: true});
    return fs.mkdtempSync(path.join(path.resolve(parent), prefix));
};

export const createEvidenceDirectory = (parent, {
    mkdir = fs.mkdirSync,
    mkdtemp = fs.mkdtempSync,
    chmod = fs.chmodSync
} = {}) => {
    mkdir(parent, {recursive: true});
    const evidence = mkdtemp(path.join(path.resolve(parent), EVIDENCE_PREFIX));
    chmod(evidence, EVIDENCE_DIRECTORY_MODE);
    return evidence;
};

const chooseFreePort = async (host) => {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen({host, port: 0, exclusive: true}, resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not allocate a loopback verification port");
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    return address.port;
};

const sha256 = (file) => {
    const hash = crypto.createHash("sha256");
    hash.update(fs.readFileSync(file));
    return hash.digest("hex");
};

const hashIfPresent = (file) => fs.existsSync(file) ? sha256(file) : null;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const assertAbsentPath = (file, lstat) => {
    try {
        lstat(file);
    } catch (error) {
        if (error?.code === "ENOENT") return;
        throw error;
    }
    throw new Error(`Refusing stale healthcheck handshake file: ${file}`);
};

/** Hold the first verified listener until Docker has observed its own HEALTHCHECK. */
export const awaitHealthcheckHandshake = async ({directory, child, port,
    timeoutMs = HEALTHCHECK_HANDSHAKE_TIMEOUT_MS,
    pollMs = HEALTHCHECK_HANDSHAKE_POLL_MS,
    sleep = delay,
    now = Date.now,
    lstat = fs.lstatSync,
    read = fs.readFileSync,
    write = fs.writeFileSync}) => {
    const root = path.resolve(directory);
    const rootStat = lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
        throw new Error(`Healthcheck handshake directory is not safe: ${root}`);
    const requestPath = path.join(root, HEALTHCHECK_REQUEST);
    const acknowledgementPath = path.join(root, HEALTHCHECK_ACKNOWLEDGEMENT);
    assertAbsentPath(requestPath, lstat);
    assertAbsentPath(acknowledgementPath, lstat);

    const handshake = {
        nonce: crypto.randomBytes(HEALTHCHECK_NONCE_BYTES).toString("hex"),
        pid: child.pid,
        port
    };
    const requestBytes = Buffer.from(JSON.stringify(handshake) + "\n");
    write(requestPath, requestBytes, {flag: "wx", mode: EVIDENCE_FILE_MODE});
    const requestStat = lstat(requestPath);
    if (!requestStat.isFile() || requestStat.isSymbolicLink() || requestStat.nlink !== 1)
        throw new Error("Healthcheck request is not an unlinked regular file");

    const deadline = now() + timeoutMs;
    while (true) {
        if (child.exitCode !== null || child.signalCode !== null)
            throw new Error("Verified child exited before Docker acknowledged its healthcheck");
        try {
            const acknowledgementStat = lstat(acknowledgementPath);
            if (!acknowledgementStat.isFile() || acknowledgementStat.isSymbolicLink()
                || acknowledgementStat.nlink !== 1)
                throw new Error("Healthcheck acknowledgement is not an unlinked regular file");
            if (acknowledgementStat.size !== requestBytes.length
                || !read(acknowledgementPath).equals(requestBytes))
                throw new Error("Healthcheck acknowledgement did not exactly match its request");
            return {...handshake, observed: true, request: requestPath, acknowledgement: acknowledgementPath};
        } catch (error) {
            if (error?.code !== "ENOENT") throw error;
        }
        if (now() >= deadline) throw new Error("Timed out waiting for Docker healthcheck acknowledgement");
        await sleep(pollMs);
    }
};

const gitCommit = (repo) => {
    try {
        return execFileSync("git", ["rev-parse", "HEAD"], {cwd: repo, encoding: "utf8"}).trim();
    } catch {
        return null;
    }
};

const runFixture = async ({runtime, fixtureScript, command, repo, work, nonce, environment, log,
    allowedExistingBinary}) => {
    const args = [fixtureScript, command, "--repo", repo, "--work", work, "--nonce", nonce];
    if (allowedExistingBinary) args.push("--allow-existing-binary", allowedExistingBinary);
    const child = spawn(runtime, args, {
        cwd: repo,
        env: environment,
        windowsHide: true,
        stdio: ["ignore", log, log]
    });
    if (!await waitForProcessExit(child, PROCESS_EXIT_TIMEOUT_MS)) {
        await stopOwnedProcess(child);
        throw new Error(`Fixture ${command} timed out`);
    }
    if (child.exitCode !== SUCCESS_EXIT) throw new Error(`Fixture ${command} exited with code ${child.exitCode}`);
};

const startArtifact = ({command, args, work, environment, stdoutLog, stderrLog}) => {
    const stdout = fs.openSync(stdoutLog, "a", EVIDENCE_FILE_MODE);
    const stderr = fs.openSync(stderrLog, "a", EVIDENCE_FILE_MODE);
    try {
        return spawn(command, args, {
            cwd: work,
            env: environment,
            windowsHide: true,
            stdio: ["ignore", stdout, stderr]
        });
    } finally {
        fs.closeSync(stdout);
        fs.closeSync(stderr);
    }
};

const contentType = (response) => response.headers.get("content-type") ?? "";

export const clientScriptTargets = (html, origin) => {
    const verifiedOrigin = new URL(origin);
    const base = new URL("/", verifiedOrigin);
    const sources = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+\.js(?:\?[^"']*)?)["']/gi)]
        .map((match) => match[1]);
    if (sources.length === 0) throw new Error("Bundled client HTML references no JavaScript asset");

    return [...new Set(sources.map((source) => {
        if (source.includes("\\")) throw new Error(`Client script path contains a backslash: ${source}`);
        const target = new URL(source, base);
        if (target.origin !== verifiedOrigin.origin)
            throw new Error(`Client script path escaped the verified loopback origin: ${source}`);
        return `${target.pathname}${target.search}`;
    }))];
};

const sessionHeaders = async (origin) => {
    const signIn = await requestLocal(origin, "/api/session", {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({password: SYNTHETIC_PASSWORD})
    });
    checkJsonResponse(signIn, {message: "Signed in"});
    const cookie = signIn.headers.get("set-cookie")?.split(";", 1)[0];
    if (!cookie) throw new Error("Authenticated session did not set a cookie");

    const session = await requestLocal(origin, "/api/session", {headers: {cookie}});
    checkJsonResponse(session, {active: true});
    return {cookie};
};

const checkClient = async (origin) => {
    const client = await requestLocal(origin, "/");
    if (client.status !== 200 || client.bytes.length < MIN_CLIENT_BYTES
        || !contentType(client).includes("text/html"))
        throw new Error("Bundled client HTML was not served");

    const html = client.bytes.toString("utf8");
    for (const script of clientScriptTargets(html, origin)) {
        const javascript = await requestLocal(origin, script);
        if (javascript.status !== 200 || javascript.bytes.length < MIN_JAVASCRIPT_BYTES
            || !contentType(javascript).includes("javascript"))
            throw new Error(`Referenced bundled JavaScript asset was not served: ${script}`);
    }
};

const checkPopulatedInstance = async (origin) => {
    const health = await requestLocal(origin, "/api/health");
    checkJsonResponse(health, {status: "ok", database: "up"});
    const headers = await sessionHeaders(origin);

    const config = await requestLocal(origin, "/api/config", {headers});
    checkJsonResponse(config, {ping: CONFIG_SENTINEL, passwordSet: true});

    const history = await requestLocal(origin, "/api/speedtests?limit=10", {headers});
    if (history.status !== 200) throw new Error(`Speed-test API returned HTTP ${history.status}`);
    const rows = JSON.parse(history.bytes.toString("utf8"));
    if (!Array.isArray(rows) || !rows.some((row) => row.resultId === TEST_RESULT_SENTINEL))
        throw new Error("Speed-test API did not return the synthetic row");

    const storage = await requestLocal(origin, "/api/storage", {headers});
    const stored = checkJsonResponse(storage, {});
    if (!Number.isInteger(stored.testCount) || stored.testCount < 1)
        throw new Error("Storage API did not report the synthetic database row");

    await checkClient(origin);

    const image = await requestLocal(origin, "/api/opengraph/image", {headers});
    if (image.status !== 200 || !contentType(image).includes("image/png"))
        throw new Error(`Populated OpenGraph endpoint did not return PNG (HTTP ${image.status})`);
    checkPng(image.bytes);
};

const ensureListenerGone = (child, host, port) => {
    let listeners;
    try {
        listeners = systemListeners(child.pid);
    } catch (error) {
        if (error?.code === "ENOENT" || error?.code === "ESRCH") return;
        throw error;
    }

    const remains = listeners.some((listener) => Number(listener.port) === port
        && Number(listener.pid) === child.pid);
    if (remains) throw new Error(`Owned PID ${child.pid} leaked its listener on port ${port}`);
};

export const assertRuntimeIdentity = ({child, expectedUid, work,
    platform = process.platform,
    readStatus = () => fs.readFileSync(`/proc/${child.pid}/status`, "utf8"),
    readDataUid = () => fs.statSync(path.join(work, "data")).uid}) => {
    if (expectedUid === undefined) return;
    if (platform !== "linux") throw new Error("--expected-uid is supported only on Linux");
    if (!/^\d+$/.test(expectedUid)) throw new Error("--expected-uid must be a nonnegative integer");

    const status = readStatus();
    const actualUid = /^Uid:\s+(\d+)/m.exec(status)?.[1];
    if (actualUid !== expectedUid)
        throw new Error(`Artifact PID ${child.pid} runs as UID ${actualUid ?? "unknown"}, expected ${expectedUid}`);

    const capabilities = /^CapEff:\s+([0-9a-f]+)/mi.exec(status)?.[1];
    if (!capabilities || BigInt(`0x${capabilities}`) !== 0n)
        throw new Error(`Artifact PID ${child.pid} retained effective capabilities ${capabilities ?? "unknown"}`);

    const dataUid = String(readDataUid());
    if (dataUid !== expectedUid)
        throw new Error(`Synthetic data directory belongs to UID ${dataUid}, expected ${expectedUid}`);
};

export const checkCfspeedtestVersion = ({work, expectedVersion, environment, runBinary = execFileSync}) => {
    if (!/^\d+\.\d+\.\d+$/.test(expectedVersion))
        throw new Error("--expected-cfspeedtest-version must be a semantic version");
    const binary = path.join(work, "bin", "cfspeedtest");
    const output = runBinary(binary, ["--version"], {
        cwd: work,
        env: environment,
        encoding: "utf8",
        timeout: RUNTIME_PROBE_TIMEOUT_MS
    }).trim();
    const escapedVersion = expectedVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!/cfspeedtest/i.test(output) || !new RegExp(`(?:^|\\s)v?${escapedVersion}(?:\\s|$)`).test(output))
        throw new Error(`Baked cfspeedtest did not report exact version ${expectedVersion}: ${output}`);
    return output;
};

const stopCleanly = async (child, host, port) => {
    await stopOwnedProcess(child);
    if (child.exitCode !== SUCCESS_EXIT)
        throw new Error(`Artifact shutdown exited with code ${child.exitCode} and signal ${child.signalCode}`);
    ensureListenerGone(child, host, port);
};

const runResetScenario = async ({options, host, repo, environment, work, fixtureScript, fixtureRuntime,
    nonce, log, stdoutLog, stderrLog, prepared = false}) => {
    const port = await chooseFreePort(host);
    const resetEnvironment = sanitizedEnvironment(environment, {host, port});
    if (!prepared)
        await runFixture({runtime: fixtureRuntime, fixtureScript, command: "static", repo, work, nonce,
            environment: resetEnvironment, log});
    if (options.expectedUid !== undefined)
        makeFixtureAccessibleToUid({work, nonce, uid: options.expectedUid});
    await assertPortFree({host, port});

    const child = startArtifact({
        command: options.command,
        args: [...options.args, "--reset-password"],
        work,
        environment: resetEnvironment,
        stdoutLog,
        stderrLog
    });

    try {
        await waitForListenerFreeExit({child, port, timeoutMs: PROCESS_EXIT_TIMEOUT_MS});
        if (child.exitCode !== RESET_NOTHING_TO_DO_EXIT)
            throw new Error(`Fresh-no-config reset exited ${child.exitCode}; expected ${RESET_NOTHING_TO_DO_EXIT}`);

        ensureListenerGone(child, host, port);
    } finally {
        if (child.exitCode === null && child.signalCode === null) await stopOwnedProcess(child);
    }

    const database = await checkResetDatabase(path.join(work, "data", "storage.db"));
    return {work, pid: child.pid, database};
};

export const removeOwnedWork = (work, nonce, remove = fs.rmSync) => {
    const root = path.resolve(work);
    const markerPath = path.join(root, FIXTURE_MARKER);
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    if (marker.nonce !== nonce || path.resolve(marker.root) !== root)
        throw new Error(`Refusing cleanup of unowned fixture directory ${root}`);
    if (!path.basename(root).startsWith(WORK_PREFIX))
        throw new Error(`Refusing cleanup outside a generated ${WORK_PREFIX} directory`);
    remove(root, {recursive: true, force: false});
};

const main = async () => {
    const options = parseArguments(process.argv.slice(2));
    const host = "127.0.0.1";
    const repo = options.repo ? path.resolve(options.repo) : null;
    const command = path.resolve(options.command);
    const fixtureRuntime = options.fixtureRuntime ?? process.execPath;
    const fixtureScript = fileURLToPath(new URL("./fixture.mjs", import.meta.url));
    const workParent = path.resolve(options.workParent ?? os.tmpdir());
    const evidenceParent = path.resolve(options.evidenceDir ?? process.cwd());
    let handshakeDirectory = null;
    if (options.healthcheckHandshake) {
        if (!path.isAbsolute(options.healthcheckHandshake))
            throw new Error("--healthcheck-handshake must be an absolute path");
        handshakeDirectory = path.resolve(options.healthcheckHandshake);
        if (handshakeDirectory !== evidenceParent)
            throw new Error("--healthcheck-handshake must match the verifier evidence directory");
    }
    const evidence = createEvidenceDirectory(evidenceParent);
    const stdoutLog = path.join(evidence, "artifact.stdout.log");
    const stderrLog = path.join(evidence, "artifact.stderr.log");
    const fixtureLogPath = path.join(evidence, "fixture.log");
    const summaryPath = path.join(evidence, "summary.json");
    const fixtureLog = fs.openSync(fixtureLogPath, "a", EVIDENCE_FILE_MODE);
    const nonce = crypto.randomBytes(24).toString("hex");
    let work = options.work ? path.resolve(options.work) : null;
    const cleanupTargets = [];
    let activeChild = null;
    let failure = null;
    let handoff = null;

    if (!fs.existsSync(command)) throw new Error(`Artifact command does not exist: ${command}`);
    if (options.work && !options.preseededFixtureManifest && fs.existsSync(path.join(work, FIXTURE_MARKER)))
        throw new Error(`Refusing stale verification work directory: ${work}`);
    if (options.work && !fs.statSync(work).isDirectory()) throw new Error(`--work is not a directory: ${work}`);
    if (options.work && !options.keepWork)
        throw new Error("A caller-supplied --work directory requires --keep-work");

    const requestedPort = options.port === undefined ? null : Number(options.port);
    const port = requestedPort ?? await chooseFreePort(host);
    const origin = buildLocalOrigin(host, port);
    const environment = sanitizedEnvironment(process.env, {host, port});
    const artifactPath = path.resolve(options.artifact ?? command);
    const claimedSourceSha = options.sourceSha;
    if (claimedSourceSha !== undefined && !/^[0-9a-f]{40}$/.test(claimedSourceSha))
        throw new Error("--source-sha must be a lowercase 40-character commit SHA");
    const repositoryCommit = repo ? gitCommit(repo) : null;
    if (claimedSourceSha && repositoryCommit && claimedSourceSha !== repositoryCommit)
        throw new Error(`--source-sha ${claimedSourceSha} does not match repository HEAD ${repositoryCommit}`);
    const summary = {
        status: "running",
        mode: options.mode,
        commit: repositoryCommit,
        sourceSha: claimedSourceSha ?? repositoryCommit,
        artifact: artifactPath,
        artifactSha256: hashIfPresent(artifactPath),
        bunLockSha256: repo ? hashIfPresent(path.join(repo, "bun.lock")) : null,
        packageSha256: repo ? hashIfPresent(path.join(repo, "package.json")) : null,
        runtime: process.version,
        platform: process.platform,
        architecture: process.arch,
        osVersion: os.version(),
        cpu: os.cpus()[0]?.model ?? null,
        command: [command, ...options.args],
        port,
        host,
        work,
        evidence,
        originalBuildRoot: options.originalBuildRoot ? path.resolve(options.originalBuildRoot) : null,
        processes: [],
        databaseChecks: [],
        fixtures: null,
        healthcheckHandshake: null
    };
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n", {mode: EVIDENCE_FILE_MODE});

    try {
        if (options.mode === "full") assertLinuxNetworkIsolation();
        if (options.originalBuildRoot) {
            if (!path.isAbsolute(options.originalBuildRoot))
                throw new Error("--original-build-root must be absolute");
            assertOriginalBuildUnavailable(options.originalBuildRoot);
        }
        if (options.preseededFixtureManifest) {
            handoff = await loadHandoffFixture({
                file: path.resolve(options.preseededFixtureManifest),
                work,
                resetWork: path.resolve(options.resetWork)
            });
            summary.commit = handoff.source.commit;
            summary.sourceSha = handoff.source.commit;
            summary.bunLockSha256 = handoff.source.bunLockSha256;
            summary.packageSha256 = handoff.source.packageSha256;
            summary.fixtureManifest = {
                path: handoff.manifestFile,
                sha256: sha256(handoff.manifestFile)
            };
            summary.fixtures = {
                populated: {...handoff.populated},
                reset: {...handoff.reset}
            };
            summary.databaseChecks.push({scenario: "preseeded-input", ...handoff.initialDatabase});
        }
        if (work === null) work = makeDirectory(workParent, WORK_PREFIX);
        summary.work = work;

        if (options.mode === "listener-free-reset") {
            cleanupTargets.push(work);
            await runFixture({runtime: fixtureRuntime, fixtureScript, command: "static", repo, work, nonce,
                environment, log: fixtureLog});
            summary.fixtures = {
                reset: {root: work, nonce, markerSha256: sha256(path.join(work, FIXTURE_MARKER))}
            };
            if (options.expectedUid !== undefined)
                makeFixtureAccessibleToUid({work, nonce, uid: options.expectedUid});
            await assertPortFree({host, port});
            activeChild = startArtifact({command, args: [...options.args, "--reset-password"], work, environment,
                stdoutLog, stderrLog});
            summary.processes.push({scenario: "listener-free-reset", pid: activeChild.pid});
            await waitForListenerFreeExit({child: activeChild, port, timeoutMs: PROCESS_EXIT_TIMEOUT_MS});
            if (activeChild.exitCode !== RESET_NOTHING_TO_DO_EXIT)
                throw new Error(`Listener-free reset exited ${activeChild.exitCode}; expected ${RESET_NOTHING_TO_DO_EXIT}`);
            ensureListenerGone(activeChild, host, port);
            const database = await checkResetDatabase(path.join(work, "data", "storage.db"));
            summary.databaseChecks.push({scenario: "listener-free-reset", ...database});
        } else {
            let expectedDatabase;
            if (handoff) {
                expectedDatabase = handoff.expected;
            } else {
                cleanupTargets.push(work);
                const allowedExistingBinary = options.expectedCfspeedtestVersion ? "cfspeedtest" : undefined;
                await runFixture({runtime: fixtureRuntime, fixtureScript, command: "seed", repo, work, nonce,
                    environment, log: fixtureLog, allowedExistingBinary});
                const snapshot = await inspectPopulatedDatabase(
                    path.join(work, "data", "storage.db"), TEST_RESULT_SENTINEL);
                expectedDatabase = {
                    ping: CONFIG_SENTINEL,
                    resultId: TEST_RESULT_SENTINEL,
                    passwordValueSha256: snapshot.passwordValueSha256
                };
                summary.fixtures = {
                    populated: {root: work, nonce, markerSha256: sha256(path.join(work, FIXTURE_MARKER))}
                };
                summary.databaseChecks.push({scenario: "seeded-input", ...snapshot});
            if (options.expectedCfspeedtestVersion)
                summary.cfspeedtestVersion = checkCfspeedtestVersion({
                        work,
                        expectedVersion: options.expectedCfspeedtestVersion,
                    environment
                });
            }
            if (options.expectedUid !== undefined)
                makeFixtureAccessibleToUid({work, nonce: handoff?.populated.nonce ?? nonce,
                    uid: options.expectedUid});
            await assertPortFree({host, port});

            activeChild = startArtifact({command, args: options.args, work, environment, stdoutLog, stderrLog});
            summary.processes.push({scenario: "populated-first-boot", pid: activeChild.pid});
            await waitForOwnedListener({child: activeChild, host, port, timeoutMs: LISTEN_TIMEOUT_MS});
            assertRuntimeIdentity({child: activeChild, expectedUid: options.expectedUid, work});
            await checkPopulatedInstance(origin);
            if (handshakeDirectory)
                summary.healthcheckHandshake = await awaitHealthcheckHandshake({
                    directory: handshakeDirectory,
                    child: activeChild,
                    port
                });
            await stopCleanly(activeChild, host, port);
            activeChild = null;

            const afterFirstShutdown = await checkPopulatedDatabase(
                path.join(work, "data", "storage.db"), expectedDatabase);
            summary.databaseChecks.push({scenario: "after-first-shutdown", ...afterFirstShutdown});

            activeChild = startArtifact({command, args: options.args, work, environment, stdoutLog, stderrLog});
            summary.processes.push({scenario: "populated-restart", pid: activeChild.pid});
            await waitForOwnedListener({child: activeChild, host, port, timeoutMs: LISTEN_TIMEOUT_MS});
            assertRuntimeIdentity({child: activeChild, expectedUid: options.expectedUid, work});
            await checkPopulatedInstance(origin);
            await stopCleanly(activeChild, host, port);
            activeChild = null;

            const afterSecondShutdown = await checkPopulatedDatabase(
                path.join(work, "data", "storage.db"), expectedDatabase);
            summary.databaseChecks.push({scenario: "after-second-shutdown", ...afterSecondShutdown});

            const resetWork = handoff ? path.resolve(options.resetWork)
                : makeDirectory(workParent, `${WORK_PREFIX}reset-`);
            const resetNonce = handoff ? handoff.reset.nonce : nonce;
            if (!handoff) cleanupTargets.push(resetWork);
            const reset = await runResetScenario({options, host, repo, environment: process.env, work: resetWork,
                fixtureScript, fixtureRuntime, nonce: resetNonce, log: fixtureLog, stdoutLog, stderrLog,
                prepared: Boolean(handoff)});
            if (!handoff)
                summary.fixtures.reset = {
                    root: resetWork,
                    nonce: resetNonce,
                    markerSha256: sha256(path.join(resetWork, FIXTURE_MARKER))
                };
            summary.processes.push({scenario: "fresh-no-config-reset", pid: reset.pid});
            summary.databaseChecks.push({scenario: "fresh-no-config-reset", ...reset.database});
        }
    } catch (error) {
        failure = error;
    } finally {
        try {
            if (activeChild && activeChild.exitCode === null && activeChild.signalCode === null) {
                await stopOwnedProcess(activeChild);
                ensureListenerGone(activeChild, host, port);
            }
        } catch (error) {
            failure = failure
                ? new AggregateError([failure, error], "Verification and teardown both failed")
                : error;
        }

        fs.closeSync(fixtureLog);
        if (!options.keepWork) {
            for (const target of cleanupTargets.reverse()) {
                try {
                    removeOwnedWork(target, nonce);
                } catch (error) {
                    failure = failure
                        ? new AggregateError([failure, error], "Verification and cleanup both failed")
                        : error;
                }
            }
        }

        summary.status = failure ? "failed" : "passed";
        summary.exit = failure ? 1 : 0;
        summary.finishedAt = new Date().toISOString();
        summary.error = failure ? (failure.stack ?? String(failure)) : null;
        fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n", {mode: EVIDENCE_FILE_MODE});
    }

    if (failure) throw failure;
    console.log(`Artifact verified; evidence: ${evidence}`);
};

const invokedDirectly = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
});
