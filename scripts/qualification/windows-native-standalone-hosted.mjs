import crypto from "node:crypto";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {assertWindowsNativeStandaloneHostRequest, assertWindowsNativeStandaloneProofRequest,
    inspectWindowsNativeStandaloneEvidence} from "./windows-native-standalone-proof.mjs";
import {bindNativeCandidatePreseal} from "../release/native-candidate-preseal.mjs";

const FIXTURE_MARKER = ".myspeed-qualification.json";
const HANDOFF_SCHEMA_VERSION = 1;
const EXECUTION_INPUT_KIND = "myspeed-windows-native-standalone-execution-input";
const PROOF_REQUEST_KIND = "myspeed-windows-native-standalone-proof-request";
const HOST_REQUEST_KIND = "myspeed-windows-native-standalone-host-request";
const CANDIDATE_REQUEST_KIND = "myspeed-windows-native-candidate-request";
const NORMAL_DEADLINE_MS = 600_000;
const HARD_DEADLINE_MS = 610_000;
const CANDIDATE_NORMAL_DEADLINE_MS = 300_000;
const CANDIDATE_HARD_DEADLINE_MS = 310_000;
const STOP_REQUEST_TIMEOUT_MS = 240_000;
const STOP_REQUEST_POLL_MS = 50;
const GRACEFUL_EXIT_TIMEOUT_MS = 30_000;
const FORCED_CLEANUP_TIMEOUT_MS = 10_000;
const MIN_PORT = 65_000;
const MAXIMUM_CANDIDATE_BYTES = 268_435_456;
const MAXIMUM_CLI_INPUT_BYTES = 2_097_152;
const HOST_EXECUTION_TIMEOUT_MS = 620_000;
const MAXIMUM_PROCESS_OUTPUT_BYTES = 65_536;
const MAXIMUM_FAILURE_CHARACTERS = 1_024;
const MAXIMUM_PRESEAL_BYTES = 10_485_760;
const SHA256 = /^[0-9a-f]{64}$/u;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SOURCE_SHA = /^[0-9a-f]{40}$/u;
const RUN_ID = /^[1-9][0-9]{0,19}$/u;
const RUN_ATTEMPT = /^[1-9][0-9]{0,9}$/u;
const NONCE = /^[0-9a-f]{32}$/u;
const FIXTURE_NONCE = /^[0-9a-f]{48}$/u;
const ALIASES = ["default", "baseline"];
const SCENARIOS = ["populated-first-boot", "populated-restart", "fresh-no-config-reset"];
const LOGICAL_NAMES = new Map([
    ["default", "MySpeed-windows-x64.exe"],
    ["baseline", "MySpeed-windows-x64-baseline.exe"]
]);

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, names, label) => {
    if (!isObject(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...names].sort()))
        throw new Error(`${label} keys differ`);
};
const string = (value, label, pattern = /^[^\u0000-\u001f\u007f]{1,1024}$/u) => {
    if (typeof value !== "string") throw new Error(`${label} must be a string`);
    const match = pattern.exec(value);
    if (!match || match[0] !== value) throw new Error(`${label} differs`);
    return value;
};
const integerString = (value, label, pattern) => string(value, label, pattern);
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const hashFile = file => hash(fs.readFileSync(file));
const canonicalWindowsPath = (value, label) => {
    const candidate = string(value, label, /^[A-Za-z]:\\[^\u0000-\u001f\u007f]{1,1020}$/u);
    if (path.win32.resolve(candidate) !== candidate) throw new Error(`${label} is not canonical`);
    return candidate;
};
const descendant = (root, candidate, label, allowRoot = false) => {
    const relative = path.win32.relative(root, candidate);
    if ((!allowRoot && relative === "") || relative === ".." || relative.startsWith(`..${path.win32.sep}`)
        || path.win32.isAbsolute(relative)) throw new Error(`${label} is outside its root`);
};
const assertHash = (value, label) => string(value, label, SHA256);
const artifactDigest = (value, label) => string(value, label, SHA256_DIGEST);
const artifactId = (value, label) => integerString(value, label, RUN_ID);
const createJsonRecord = value => {
    const bytes = Buffer.from(JSON.stringify(value), "utf8");
    return {value, bytes, sha256: hash(bytes)};
};

const visitInventory = root => {
    const records = [];
    const visit = directory => {
        for (const name of fs.readdirSync(directory).sort()) {
            const file = path.join(directory, name);
            const stat = fs.lstatSync(file);
            if (stat.isSymbolicLink()) throw new Error("Fixture transport contains a symbolic link");
            if (stat.isDirectory()) visit(file);
            else if (stat.isFile()) {
                if (stat.nlink !== 1) throw new Error("Fixture transport contains a hard link");
                records.push(file);
            } else throw new Error("Fixture transport contains a special file");
        }
    };
    visit(root);
    return Object.fromEntries(records.sort().map(file =>
        [path.relative(root, file).replaceAll(path.sep, "/"), hashFile(file)]));
};

const assertDigestInventory = (actual, expected, label) => {
    if (!isObject(expected) || Object.values(expected).some(value => typeof value !== "string" || !SHA256.test(value))
        || JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} inventory differs`);
};

const readTransportMarker = (root, entry, label) => {
    const markerPath = path.join(root, FIXTURE_MARKER);
    if (hashFile(markerPath) !== entry.markerSha256) throw new Error(`${label} marker digest differs`);
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    exactKeys(marker, ["nonce", "root", "dataDirectory", "binaryDirectory", "createdAt"], `${label} marker`);
    string(marker.nonce, `${label} nonce`, FIXTURE_NONCE);
    if (marker.nonce !== entry.nonce) throw new Error(`${label} marker nonce differs`);
    string(marker.root, `${label} producer root`);
    string(marker.dataDirectory, `${label} producer data path`);
    string(marker.binaryDirectory, `${label} producer binary path`);
    string(marker.createdAt, `${label} creation time`, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
    return marker;
};

const copyFixtureTree = (source, destination) => {
    if (fs.existsSync(destination)) throw new Error("Execution fixture root already exists");
    fs.mkdirSync(destination, {recursive: false});
    const copy = (left, right) => {
        for (const name of fs.readdirSync(left).sort()) {
            if (name === FIXTURE_MARKER && left === source) continue;
            const sourcePath = path.join(left, name);
            const destinationPath = path.join(right, name);
            const stat = fs.lstatSync(sourcePath);
            if (stat.isDirectory()) { fs.mkdirSync(destinationPath); copy(sourcePath, destinationPath); }
            else fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
        }
    };
    copy(source, destination);
};

export const materializeWindowsNativeStandaloneFixture = async input => {
    exactKeys(input, ["manifestPath", "populated", "reset", "manifest", "outputManifestPath",
        "populatedRoot", "resetRoot", "expectedSourceSha"], "Fixture relocation input");
    string(input.expectedSourceSha, "Fixture expected source", SOURCE_SHA);
    const manifestPath = path.resolve(input.manifestPath);
    const populatedTransport = path.resolve(input.populated);
    const resetTransport = path.resolve(input.reset);
    const outputManifest = path.resolve(input.outputManifestPath);
    const populatedRoot = path.resolve(input.populatedRoot);
    const resetRoot = path.resolve(input.resetRoot);
    if ([outputManifest, populatedRoot, resetRoot].some(value => fs.existsSync(value)))
        throw new Error("Execution fixture output already exists");
    const manifestBytes = fs.readFileSync(manifestPath);
    const manifest = JSON.parse(manifestBytes);
    if (JSON.stringify(manifest) !== JSON.stringify(input.manifest))
        throw new Error("Fixture transport manifest bytes differ");
    exactKeys(manifest, ["schemaVersion", "source", "populated", "reset", "expected"], "Fixture transport manifest");
    if (manifest.schemaVersion !== HANDOFF_SCHEMA_VERSION || manifest.source?.commit !== input.expectedSourceSha)
        throw new Error("Fixture transport source differs");
    exactKeys(manifest.source, ["commit", "bunLockSha256", "packageSha256"], "Fixture transport source");
    assertHash(manifest.source.bunLockSha256, "Fixture bun lock digest");
    assertHash(manifest.source.packageSha256, "Fixture package digest");
    exactKeys(manifest.populated, ["root", "nonce", "markerSha256", "databaseSha256", "filesSha256"],
        "Populated transport");
    exactKeys(manifest.reset, ["root", "nonce", "markerSha256", "filesSha256"], "Reset transport");
    exactKeys(manifest.expected, ["ping", "resultId", "passwordValueSha256"], "Fixture expected values");
    if (manifest.expected.ping !== "123.456" || manifest.expected.resultId !== "qualification-seed-row")
        throw new Error("Fixture sentinel values differ");
    assertHash(manifest.expected.passwordValueSha256, "Fixture password fingerprint");
    for (const [root, entry, label] of [[populatedTransport, manifest.populated, "Populated transport"],
        [resetTransport, manifest.reset, "Reset transport"]]) {
        string(entry.nonce, `${label} nonce`, FIXTURE_NONCE);
        assertHash(entry.markerSha256, `${label} marker digest`);
        assertDigestInventory(visitInventory(root), entry.filesSha256, label);
    }
    assertHash(manifest.populated.databaseSha256, "Fixture database digest");
    const database = path.join(populatedTransport, "data", "storage.db");
    if (hashFile(database) !== manifest.populated.databaseSha256
        || fs.existsSync(path.join(resetTransport, "data", "storage.db")))
        throw new Error("Fixture database transport differs");
    const populatedMarker = readTransportMarker(populatedTransport, manifest.populated, "Populated transport");
    const resetMarker = readTransportMarker(resetTransport, manifest.reset, "Reset transport");
    copyFixtureTree(populatedTransport, populatedRoot);
    copyFixtureTree(resetTransport, resetRoot);
    const writeMarker = (root, marker) => {
        const value = {...marker, root, dataDirectory: path.join(root, "data"), binaryDirectory: path.join(root, "bin")};
        fs.writeFileSync(path.join(root, FIXTURE_MARKER), JSON.stringify(value, null, 2) + "\n", {flag: "wx"});
    };
    writeMarker(populatedRoot, populatedMarker);
    writeMarker(resetRoot, resetMarker);
    const handoff = {schemaVersion: HANDOFF_SCHEMA_VERSION, source: manifest.source,
        populated: {root: populatedRoot, nonce: manifest.populated.nonce,
            markerSha256: hashFile(path.join(populatedRoot, FIXTURE_MARKER)),
            databaseSha256: manifest.populated.databaseSha256, filesSha256: visitInventory(populatedRoot)},
        reset: {root: resetRoot, nonce: manifest.reset.nonce,
            markerSha256: hashFile(path.join(resetRoot, FIXTURE_MARKER)), filesSha256: visitInventory(resetRoot)},
        expected: manifest.expected};
    fs.writeFileSync(outputManifest, JSON.stringify(handoff, null, 2) + "\n", {flag: "wx", mode: 0o444});
    fs.chmodSync(outputManifest, 0o444);
    return handoff;
};

const assertIdentity = (value, expectedPath, expectedSha, label) => {
    exactKeys(value, ["path", "bytes", "sha256", "volumeSerial", "fileId", "linkCount", "reparsePoint"], label);
    if (canonicalWindowsPath(value.path, `${label} path`) !== expectedPath
        || assertHash(value.sha256, `${label} SHA`) !== expectedSha) throw new Error(`${label} differs`);
    if (!Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > MAXIMUM_CANDIDATE_BYTES)
        throw new Error(`${label} bytes differ`);
    string(value.volumeSerial, `${label} volume`, /^[0-9a-f]{8}$/u);
    string(value.fileId, `${label} file ID`, /^[0-9a-f]{16}$/u);
    if (value.linkCount !== 1 || value.reparsePoint !== false) throw new Error(`${label} is not an ordinary owned file`);
};

export const buildWindowsNativeStandaloneExecutionPlan = input => {
    exactKeys(input, ["schemaVersion", "kind", "qualifying", "expectedRunId", "expectedRunAttempt",
        "expectedEventSha", "expectedSourceSha", "expectedImageVersion", "nonce", "qualification", "taskRoot",
        "closure", "node", "powershell", "fixtures", "candidates"], "Standalone execution input");
    if (input.schemaVersion !== 1 || input.kind !== EXECUTION_INPUT_KIND || input.qualifying !== false)
        throw new Error("Standalone execution input differs");
    integerString(input.expectedRunId, "Execution run ID", RUN_ID);
    integerString(input.expectedRunAttempt, "Execution run attempt", RUN_ATTEMPT);
    string(input.expectedEventSha, "Execution event SHA", SOURCE_SHA);
    string(input.expectedSourceSha, "Execution source SHA", SOURCE_SHA);
    string(input.expectedImageVersion, "Execution image version", /^[0-9A-Za-z._-]{1,64}$/u);
    string(input.nonce, "Execution nonce", NONCE);
    exactKeys(input.qualification, ["sourceSha", "runId", "runAttempt", "manifestSha256", "artifactId",
        "artifactDigest"], "Qualification identity");
    if (string(input.qualification.sourceSha, "Qualification source", SOURCE_SHA) !== input.expectedSourceSha)
        throw new Error("Qualification source differs");
    integerString(input.qualification.runId, "Qualification run ID", RUN_ID);
    integerString(input.qualification.runAttempt, "Qualification run attempt", RUN_ATTEMPT);
    assertHash(input.qualification.manifestSha256, "Qualification manifest SHA");
    artifactId(input.qualification.artifactId, "Qualification manifest artifact ID");
    artifactDigest(input.qualification.artifactDigest, "Qualification manifest artifact digest");
    const taskRoot = canonicalWindowsPath(input.taskRoot, "Execution task root");
    if (!taskRoot.endsWith(`myspeed-native-standalone-${input.nonce}`)) throw new Error("Execution task root differs");
    exactKeys(input.closure, ["proofPath", "proofSha256", "adapterPath", "adapterSha256", "hostPath",
        "hostSha256", "candidateControllerPath", "candidateControllerSha256", "cleanStopControllerPath",
        "cleanStopControllerSha256", "canaryPath", "canarySha256"], "Execution closure");
    for (const name of ["proof", "adapter", "host", "candidateController", "cleanStopController", "canary"]) {
        canonicalWindowsPath(input.closure[`${name}Path`], `Execution ${name} path`);
        assertHash(input.closure[`${name}Sha256`], `Execution ${name} SHA`);
    }
    for (const [label, value] of [["node", input.node], ["powershell", input.powershell]]) {
        exactKeys(value, ["path", "sha256"], `Execution ${label}`);
        canonicalWindowsPath(value.path, `Execution ${label} path`);
        assertHash(value.sha256, `Execution ${label} SHA`);
    }
    if (!Array.isArray(input.fixtures) || input.fixtures.length !== ALIASES.length
        || !Array.isArray(input.candidates) || input.candidates.length !== ALIASES.length)
        throw new Error("Execution alias set differs");
    input.fixtures.forEach((fixture, index) => {
        exactKeys(fixture, ["alias", "manifestPath", "manifestSha256", "populatedWork", "resetWork"],
            "Execution fixture");
        if (fixture.alias !== ALIASES[index]) throw new Error("Execution fixture alias order differs");
        for (const name of ["manifestPath", "populatedWork", "resetWork"]) {
            canonicalWindowsPath(fixture[name], `Execution fixture ${name}`);
            descendant(taskRoot, fixture[name], `Execution fixture ${name}`);
        }
        assertHash(fixture.manifestSha256, "Execution fixture manifest SHA");
    });
    const controllerRequests = [];
    input.candidates.forEach((candidate, aliasIndex) => {
        exactKeys(candidate, ["alias", "artifactLogicalName", "artifactId", "artifactDigest", "sourcePath",
            "expectedSha256", "sourceIdentity", "scenarios"], "Execution candidate");
        const alias = ALIASES[aliasIndex];
        if (candidate.alias !== alias || candidate.artifactLogicalName !== LOGICAL_NAMES.get(alias))
            throw new Error("Execution candidate logical identity differs");
        artifactId(candidate.artifactId, "Execution candidate artifact ID");
        artifactDigest(candidate.artifactDigest, "Execution candidate artifact digest");
        canonicalWindowsPath(candidate.sourcePath, "Execution candidate source path");
        descendant(taskRoot, candidate.sourcePath, "Execution candidate source path");
        assertHash(candidate.expectedSha256, "Execution candidate expected SHA");
        assertIdentity(candidate.sourceIdentity, candidate.sourcePath, candidate.expectedSha256,
            "Execution candidate source identity");
        if (!Array.isArray(candidate.scenarios) || candidate.scenarios.length !== SCENARIOS.length)
            throw new Error("Execution candidate scenarios differ");
        candidate.scenarios.forEach((scenario, scenarioIndex) => {
            exactKeys(scenario, ["scenario", "nonce", "taskRoot", "candidatePath", "candidateIdentity",
                "controllerPath"], "Execution scenario");
            if (scenario.scenario !== SCENARIOS[scenarioIndex]) throw new Error("Execution scenario order differs");
            string(scenario.nonce, "Execution scenario nonce", NONCE);
            const expectedNonce = crypto.createHash("sha256").update(`${input.nonce}\0${alias}\0${scenario.scenario}`)
                .digest("hex").slice(0, 32);
            if (scenario.nonce !== expectedNonce) throw new Error("Execution scenario nonce differs");
            canonicalWindowsPath(scenario.taskRoot, "Execution scenario task root");
            if (!scenario.taskRoot.endsWith(`myspeed-native-candidate-${scenario.nonce}`))
                throw new Error("Execution scenario task root differs");
            canonicalWindowsPath(scenario.candidatePath, "Execution scenario candidate path");
            canonicalWindowsPath(scenario.controllerPath, "Execution scenario controller path");
            descendant(scenario.taskRoot, scenario.candidatePath, "Execution scenario candidate path");
            descendant(scenario.taskRoot, scenario.controllerPath, "Execution scenario controller path");
            if (scenario.controllerPath !== `${scenario.taskRoot}\\windows-clean-stop-controller.ps1`)
                throw new Error("Execution scenario controller path differs");
            assertIdentity(scenario.candidateIdentity, scenario.candidatePath, candidate.expectedSha256,
                "Execution scenario candidate identity");
            const fixture = input.fixtures[aliasIndex];
            const port = MIN_PORT + aliasIndex * SCENARIOS.length + scenarioIndex;
            const value = {schemaVersion: 1, kind: CANDIDATE_REQUEST_KIND,
                expectedRunId: input.expectedRunId, expectedRunAttempt: input.expectedRunAttempt,
                expectedEventSha: input.expectedEventSha, expectedSourceSha: input.expectedSourceSha,
                expectedImageVersion: input.expectedImageVersion, nonce: scenario.nonce,
                manifestSha256: input.qualification.manifestSha256, alias,
                artifactLogicalName: candidate.artifactLogicalName, scenario: scenario.scenario,
                taskRoot: scenario.taskRoot, candidatePath: scenario.candidatePath,
                candidateSha256: scenario.candidateIdentity.sha256,
                candidateVolumeSerial: scenario.candidateIdentity.volumeSerial,
                candidateFileId: scenario.candidateIdentity.fileId,
                workingDirectory: scenario.scenario === "fresh-no-config-reset" ? fixture.resetWork : fixture.populatedWork,
                arguments: scenario.scenario === "fresh-no-config-reset" ? ["--reset-password"] : [],
                environment: {NODE_ENV: "production", DB_TYPE: "sqlite", SERVER_HOST: "127.0.0.1",
                    SERVER_PORT: String(port), RUN_TEST_ON_STARTUP: "false"},
                stdoutPath: `${scenario.taskRoot}\\stdout.log`, stderrPath: `${scenario.taskRoot}\\stderr.log`,
                readyPath: `${scenario.taskRoot}\\ready.json`, stopRequestPath: `${scenario.taskRoot}\\stop.json`,
                resultPath: `${scenario.taskRoot}\\result.json`, controllerPath: scenario.controllerPath,
                controllerSha256: input.closure.cleanStopControllerSha256,
                normalDeadlineMs: CANDIDATE_NORMAL_DEADLINE_MS, hardDeadlineMs: CANDIDATE_HARD_DEADLINE_MS,
                stopRequestTimeoutMs: STOP_REQUEST_TIMEOUT_MS, stopRequestPollMs: STOP_REQUEST_POLL_MS,
                gracefulExitTimeoutMs: GRACEFUL_EXIT_TIMEOUT_MS, forcedCleanupTimeoutMs: FORCED_CLEANUP_TIMEOUT_MS};
            controllerRequests.push({alias, scenario: scenario.scenario,
                path: `${scenario.taskRoot}\\candidate.request.json`, ...createJsonRecord(value)});
        });
    });
    const proofRequest = {schemaVersion: 1, kind: PROOF_REQUEST_KIND, qualifying: false,
        adapterRequest: {schemaVersion: 1, kind: "myspeed-windows-native-standalone-adapter-request",
            qualifying: false, expectedRunId: input.expectedRunId, expectedRunAttempt: input.expectedRunAttempt,
            expectedSourceSha: input.expectedSourceSha, expectedEventSha: input.expectedEventSha,
            expectedImageVersion: input.expectedImageVersion, nonce: input.nonce,
            aliases: input.candidates.map(candidate => ({alias: candidate.alias,
                candidateSha256: candidate.sourceIdentity.sha256, artifactLogicalName: candidate.artifactLogicalName}))},
        manifestSha256: input.qualification.manifestSha256,
        qualificationManifestArtifactId: input.qualification.artifactId,
        qualificationManifestArtifactDigest: input.qualification.artifactDigest,
        taskRoot, resultPath: `${taskRoot}\\proof.result.json`, fixtures: input.fixtures,
        candidateControllerPath: input.closure.candidateControllerPath,
        candidateControllerSha256: input.closure.candidateControllerSha256,
        cleanStopControllerPath: input.closure.cleanStopControllerPath,
        cleanStopControllerSha256: input.closure.cleanStopControllerSha256,
        hostPath: input.closure.hostPath, hostSha256: input.closure.hostSha256,
        canaryPath: input.closure.canaryPath, canarySha256: input.closure.canarySha256,
        powershellPath: input.powershell.path, qualificationSourceSha: input.qualification.sourceSha,
        qualificationRunId: input.qualification.runId, qualificationRunAttempt: input.qualification.runAttempt,
        powershellSha256: input.powershell.sha256, normalDeadlineMs: NORMAL_DEADLINE_MS,
        hardDeadlineMs: HARD_DEADLINE_MS, candidates: input.candidates.map(candidate => ({alias: candidate.alias,
            artifactLogicalName: candidate.artifactLogicalName, artifactId: candidate.artifactId,
            artifactDigest: candidate.artifactDigest, path: candidate.sourcePath,
            sha256: candidate.expectedSha256, volumeSerial: candidate.sourceIdentity.volumeSerial,
            fileId: candidate.sourceIdentity.fileId, controllerRequests: controllerRequests
                .filter(entry => entry.alias === candidate.alias).map(entry => {
                    const scenario = candidate.scenarios.find(value => value.scenario === entry.scenario);
                    return {scenario: entry.scenario, path: entry.path, sha256: entry.sha256,
                        taskRoot: scenario.taskRoot, candidatePath: scenario.candidatePath,
                        controllerPath: scenario.controllerPath};
                })}))};
    const proofRecord = createJsonRecord(proofRequest);
    const hostRequest = {schemaVersion: 1, kind: HOST_REQUEST_KIND,
        expectedRunId: input.expectedRunId, expectedRunAttempt: input.expectedRunAttempt,
        expectedEventSha: input.expectedEventSha, expectedSourceSha: input.expectedSourceSha,
        expectedImageVersion: input.expectedImageVersion, nonce: input.nonce,
        manifestSha256: input.qualification.manifestSha256, taskRoot,
        hostPath: input.closure.hostPath, hostSha256: input.closure.hostSha256,
        canaryPath: input.closure.canaryPath, canarySha256: input.closure.canarySha256,
        coordinatorExecutablePath: input.node.path, coordinatorExecutableSha256: input.node.sha256,
        coordinatorModuleSha256: input.closure.proofSha256, proofRequestSha256: proofRecord.sha256,
        proofResultPath: proofRequest.resultPath,
        coordinatorArguments: [input.closure.proofPath, "--request", `${taskRoot}\\proof.request.json`,
            "--sha256", proofRecord.sha256], workingDirectory: taskRoot,
        resultPath: `${taskRoot}\\host.result.json`, entryDiagnosticPath: `${taskRoot}\\host.entry-failure.json`,
        recoveryRequestPath: `${taskRoot}\\recovery.request.json`, recoveryReadyPath: `${taskRoot}\\recovery.ready.json`,
        recoveryResultPath: `${taskRoot}\\recovery.result.json`, cancelPath: `${taskRoot}\\recovery.cancel`,
        lockPath: `${taskRoot}\\recovery.lock`, jobName: `Global\\MySpeedStandaloneJob-${input.nonce}`,
        taskName: `MySpeedStandaloneRecovery-${input.nonce}`, normalDeadlineMs: NORMAL_DEADLINE_MS,
        hardDeadlineMs: HARD_DEADLINE_MS};
    const hostRecord = createJsonRecord(hostRequest);
    return {controllerRequests, proofRequest, proofRequestBytes: proofRecord.bytes,
        proofRequestSha256: proofRecord.sha256, hostRequest, hostRequestBytes: hostRecord.bytes,
        hostRequestSha256: hostRecord.sha256};
};

const defaultAcquisitionOperations = Object.freeze({readBytes: async file => fs.readFileSync(file)});

export const buildWindowsNativeStandaloneAcquiredExecutionPlan = async (input,
    operations = defaultAcquisitionOperations) => {
    if (!isObject(input) || !isObject(input.qualification))
        throw new Error("Standalone acquired execution input differs");
    exactKeys(input.qualification, ["repository", "sourceSha", "runId", "runAttempt", "manifestPath",
        "artifactId", "artifactDigest", "artifactSize"], "Acquired qualification identity");
    if (!isObject(operations) || Object.keys(operations).join(",") !== "readBytes"
        || typeof operations.readBytes !== "function") throw new Error("Acquisition operations differ");
    const repository = string(input.qualification.repository, "Acquired qualification repository",
        /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
    const sourceSha = string(input.qualification.sourceSha, "Acquired qualification source", SOURCE_SHA);
    const runId = integerString(input.qualification.runId, "Acquired qualification run ID", RUN_ID);
    const runAttempt = integerString(input.qualification.runAttempt, "Acquired qualification run attempt", RUN_ATTEMPT);
    const manifestPath = canonicalWindowsPath(input.qualification.manifestPath, "Acquired preseal manifest path");
    const presealArtifactId = artifactId(input.qualification.artifactId, "Acquired preseal artifact ID");
    const presealArtifactDigest = artifactDigest(input.qualification.artifactDigest,
        "Acquired preseal artifact digest");
    if (!Number.isSafeInteger(input.qualification.artifactSize) || input.qualification.artifactSize < 1
        || input.qualification.artifactSize > MAXIMUM_PRESEAL_BYTES)
        throw new Error("Acquired preseal artifact size differs");
    if (sourceSha !== input.expectedSourceSha || runId !== input.expectedRunId
        || runAttempt !== input.expectedRunAttempt)
        throw new Error("Acquired qualification run differs");
    const presealBytes = await operations.readBytes(manifestPath);
    if (!Buffer.isBuffer(presealBytes) || presealBytes.length < 2 || presealBytes.length > MAXIMUM_PRESEAL_BYTES)
        throw new Error("Acquired preseal bytes differ");
    let candidateManifest;
    try { candidateManifest = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(presealBytes)); }
    catch { throw new Error("Acquired preseal JSON differs"); }
    const bound = bindNativeCandidatePreseal({candidateManifest, presealBytes,
        presealArtifact: {name: "release-candidate-manifest", id: Number(presealArtifactId),
            archiveSize: input.qualification.artifactSize, archiveDigest: presealArtifactDigest},
        qualification: {repository, sourceSha, runId: Number(runId), runAttempt: Number(runAttempt)}});
    if (!Array.isArray(input.candidates) || input.candidates.length !== ALIASES.length)
        throw new Error("Acquired candidate set differs");
    input.candidates.forEach((candidate, index) => {
        const expected = bound.windowsAssets[index];
        if (candidate?.alias !== ALIASES[index] || candidate.artifactLogicalName !== LOGICAL_NAMES.get(ALIASES[index])
            || expected.artifact !== candidate.artifactLogicalName || expected.actionsArtifact.name !== candidate.artifactLogicalName
            || String(expected.actionsArtifact.id) !== candidate.artifactId
            || expected.actionsArtifact.archiveDigest !== candidate.artifactDigest
            || expected.sha256 !== candidate.expectedSha256)
            throw new Error("Acquired candidate preseal binding differs");
    });
    const acquired = structuredClone(input);
    acquired.qualification = {sourceSha, runId, runAttempt, manifestSha256: bound.manifest.sha256,
        artifactId: presealArtifactId, artifactDigest: presealArtifactDigest};
    return buildWindowsNativeStandaloneExecutionPlan(acquired);
};

const writeExclusive = (file, bytes) => {
    if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > MAXIMUM_CLI_INPUT_BYTES)
        throw new Error("Standalone request bytes are outside their bound");
    const parent = path.dirname(file);
    const parentStat = fs.lstatSync(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink())
        throw new Error("Standalone request parent is unsafe");
    const handle = fs.openSync(file, "wx", 0o600);
    try {
        fs.writeFileSync(handle, bytes);
        fs.fsyncSync(handle);
    } finally { fs.closeSync(handle); }
};

const boundedFailure = value => String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "?")
    .slice(0, MAXIMUM_FAILURE_CHARACTERS);

const defaultExecutionOperations = Object.freeze({
    invokeHost: async value => {
        const result = childProcess.spawnSync(value.executable, value.arguments, {cwd: value.workingDirectory,
            encoding: "utf8", timeout: value.timeoutMilliseconds, maxBuffer: value.maximumOutputBytes,
            windowsHide: true});
        if (result.error) throw new Error(`Standalone host invocation failed: ${boundedFailure(result.error.message)}`);
        return {exitCode: result.status, stdout: boundedFailure(result.stdout), stderr: boundedFailure(result.stderr)};
    },
    readBytes: async file => fs.readFileSync(file)
});

export const executeWindowsNativeStandaloneExecutionPlan = async (plan, operations = defaultExecutionOperations) => {
    if (!isObject(plan) || !isObject(plan.proofRequest) || !isObject(plan.hostRequest)
        || !Buffer.isBuffer(plan.proofRequestBytes) || !Buffer.isBuffer(plan.hostRequestBytes))
        throw new Error("Standalone executable plan differs");
    for (const name of ["proofRequestSha256", "hostRequestSha256"]) assertHash(plan[name], `Execution ${name}`);
    if (hash(plan.proofRequestBytes) !== plan.proofRequestSha256
        || hash(plan.hostRequestBytes) !== plan.hostRequestSha256
        || JSON.stringify(JSON.parse(plan.proofRequestBytes.toString("utf8"))) !== JSON.stringify(plan.proofRequest)
        || JSON.stringify(JSON.parse(plan.hostRequestBytes.toString("utf8"))) !== JSON.stringify(plan.hostRequest))
        throw new Error("Standalone executable request bytes differ");
    const proof = assertWindowsNativeStandaloneProofRequest(plan.proofRequest);
    const request = assertWindowsNativeStandaloneHostRequest(plan.hostRequest, proof);
    if (request.proofRequestSha256 !== plan.proofRequestSha256)
        throw new Error("Standalone executable proof request binding differs");
    if (!isObject(operations) || Object.keys(operations).sort().join(",") !== "invokeHost,readBytes"
        || typeof operations.invokeHost !== "function" || typeof operations.readBytes !== "function")
        throw new Error("Standalone execution operations differ");
    const hostRequestPath = path.win32.join(request.taskRoot, "host.request.json");
    const argumentsList = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", request.hostPath, "-Mode", "InvokeHostedProof", "-RequestPath", hostRequestPath,
        "-ExpectedRequestSha256", plan.hostRequestSha256, "-ExpectedRunId", request.expectedRunId,
        "-ExpectedRunAttempt", request.expectedRunAttempt, "-ExpectedEventSha", request.expectedEventSha,
        "-ExpectedSourceSha", request.expectedSourceSha, "-ExpectedImageVersion", request.expectedImageVersion,
        "-Nonce", request.nonce];
    const invocation = await operations.invokeHost({executable: plan.proofRequest.powershellPath,
        arguments: argumentsList, workingDirectory: request.taskRoot,
        timeoutMilliseconds: HOST_EXECUTION_TIMEOUT_MS, maximumOutputBytes: MAXIMUM_PROCESS_OUTPUT_BYTES});
    if (!isObject(invocation) || !Number.isSafeInteger(invocation.exitCode)
        || typeof invocation.stdout !== "string" || typeof invocation.stderr !== "string")
        throw new Error("Standalone host invocation result differs");
    if (invocation.exitCode !== 0)
        throw new Error(`Standalone host exited ${invocation.exitCode}: ${boundedFailure(invocation.stderr)}`);
    const retainedHostRequest = await operations.readBytes(hostRequestPath);
    const retainedProofRequest = await operations.readBytes(request.coordinatorArguments[2]);
    const retainedHostResult = await operations.readBytes(request.resultPath);
    if (!Buffer.isBuffer(retainedHostRequest) || !Buffer.isBuffer(retainedProofRequest)
        || !Buffer.isBuffer(retainedHostResult) || retainedHostRequest.length > MAXIMUM_CLI_INPUT_BYTES
        || retainedProofRequest.length > MAXIMUM_CLI_INPUT_BYTES || retainedHostResult.length > MAXIMUM_CLI_INPUT_BYTES)
        throw new Error("Standalone retained evidence bytes differ");
    if (!retainedHostRequest.equals(plan.hostRequestBytes)
        || !retainedProofRequest.equals(plan.proofRequestBytes))
        throw new Error("Standalone retained request bytes changed");
    return inspectWindowsNativeStandaloneEvidence({hostRequestBytes: retainedHostRequest,
        proofRequestBytes: retainedProofRequest, hostResultBytes: retainedHostResult});
};

export const executeWindowsNativeStandaloneRequestFiles = async (input, operations = defaultExecutionOperations) => {
    exactKeys(input, ["hostRequestPath", "hostRequestSha256", "proofRequestPath", "proofRequestSha256"],
        "Standalone executable request files");
    const hostRequestPath = canonicalWindowsPath(input.hostRequestPath, "Standalone host request file");
    const proofRequestPath = canonicalWindowsPath(input.proofRequestPath, "Standalone proof request file");
    const hostRequestSha256 = assertHash(input.hostRequestSha256, "Standalone host request file SHA");
    const proofRequestSha256 = assertHash(input.proofRequestSha256, "Standalone proof request file SHA");
    if (!isObject(operations) || Object.keys(operations).sort().join(",") !== "invokeHost,readBytes"
        || typeof operations.invokeHost !== "function" || typeof operations.readBytes !== "function")
        throw new Error("Standalone execution operations differ");
    const hostRequestBytes = await operations.readBytes(hostRequestPath);
    const proofRequestBytes = await operations.readBytes(proofRequestPath);
    for (const [bytes, expected, label] of [[hostRequestBytes, hostRequestSha256, "host"],
        [proofRequestBytes, proofRequestSha256, "proof"]]) {
        if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > MAXIMUM_CLI_INPUT_BYTES
            || hash(bytes) !== expected) throw new Error(`Standalone ${label} request file differs`);
    }
    let hostRequest;
    let proofRequest;
    try {
        hostRequest = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(hostRequestBytes));
        proofRequest = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(proofRequestBytes));
    } catch { throw new Error("Standalone executable request JSON differs"); }
    if (path.win32.join(hostRequest.taskRoot, "host.request.json") !== hostRequestPath
        || hostRequest.coordinatorArguments?.[2] !== proofRequestPath)
        throw new Error("Standalone executable request file path binding differs");
    return executeWindowsNativeStandaloneExecutionPlan({hostRequest, hostRequestBytes, hostRequestSha256,
        proofRequest, proofRequestBytes, proofRequestSha256}, operations);
};

export const writeWindowsNativeStandaloneExecutionPlan = plan => {
    exactKeys(plan, ["controllerRequests", "proofRequest", "proofRequestBytes", "proofRequestSha256",
        "hostRequest", "hostRequestBytes", "hostRequestSha256"], "Standalone execution plan");
    if (!Array.isArray(plan.controllerRequests) || plan.controllerRequests.length !== ALIASES.length * SCENARIOS.length)
        throw new Error("Standalone controller request set differs");
    for (const entry of plan.controllerRequests) {
        exactKeys(entry, ["alias", "scenario", "path", "value", "bytes", "sha256"], "Standalone controller request");
        writeExclusive(entry.path, entry.bytes);
        if (hash(entry.bytes) !== entry.sha256) throw new Error("Standalone controller request digest differs");
    }
    const proofRequestPath = plan.hostRequest.coordinatorArguments[2];
    const hostRequestPath = path.win32.join(plan.hostRequest.taskRoot, "host.request.json");
    writeExclusive(proofRequestPath, plan.proofRequestBytes);
    writeExclusive(hostRequestPath, plan.hostRequestBytes);
    if (hash(plan.proofRequestBytes) !== plan.proofRequestSha256
        || hash(plan.hostRequestBytes) !== plan.hostRequestSha256)
        throw new Error("Standalone top-level request digest differs");
    return {schemaVersion: 1, kind: "myspeed-windows-native-standalone-execution-plan",
        qualifying: false, controllerRequests: plan.controllerRequests.map(entry => ({alias: entry.alias,
            scenario: entry.scenario, path: entry.path, sha256: entry.sha256})), proofRequestPath,
        proofRequestSha256: plan.proofRequestSha256, hostRequestPath,
        hostRequestSha256: plan.hostRequestSha256, releaseGatesCleared: []};
};

const readBoundedStdinJson = () => {
    const bytes = fs.readFileSync(0);
    if (bytes.length < 2 || bytes.length > MAXIMUM_CLI_INPUT_BYTES)
        throw new Error("Standalone hosted CLI input is outside its bound");
    return JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes));
};

export const runWindowsNativeStandaloneHostedCli = async args => {
    if (!Array.isArray(args) || args.length !== 1
        || !new Set(["--acquired-build", "--build", "--execute", "--materialize"]).has(args[0]))
        throw new Error("Usage: windows-native-standalone-hosted.mjs --acquired-build|--build|--execute|--materialize");
    const input = readBoundedStdinJson();
    if (args[0] === "--materialize") return materializeWindowsNativeStandaloneFixture(input);
    if (args[0] === "--execute") return executeWindowsNativeStandaloneRequestFiles(input);
    if (args[0] === "--acquired-build")
        return writeWindowsNativeStandaloneExecutionPlan(await buildWindowsNativeStandaloneAcquiredExecutionPlan(input));
    return writeWindowsNativeStandaloneExecutionPlan(buildWindowsNativeStandaloneExecutionPlan(input));
};

const invokedDirectly = process.argv[1]
    && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
    try { process.stdout.write(`${JSON.stringify(await runWindowsNativeStandaloneHostedCli(process.argv.slice(2)))}\n`); }
    catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
