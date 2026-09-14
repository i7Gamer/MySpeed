import {createHash} from "node:crypto";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

import {materializeWindowsNativeStandaloneFixture,
    writeWindowsNativeStandaloneExecutionPlan} from
    "../qualification/windows-native-standalone-hosted.mjs";
import {bindV161PostReleaseTarget} from "./post-release-target.mjs";
import {buildV161PostReleaseStandaloneProducerPlan, createV161PostReleaseStandaloneBinding,
    retainV161PostReleaseStandaloneProducerPlan, writeV161PostReleaseEnvelopeExclusive}
    from "./post-release-standalone.mjs";

const REPOSITORY = "i7Gamer/MySpeed";
const TAG_NAME = "v1.6.1";
const CANDIDATE_SOURCE_SHA = "4fa4dd40a89a062735f98bd85d685e0624ff46a8";
const QUALIFICATION_RUN_ID = 34829932391;
const QUALIFICATION_RUN_ATTEMPT = 1;
const QUALIFICATION_ARCHIVE_ID = 10342345489;
const RELEASE_ID = 388294074;
const ENVIRONMENT_KEYS = ["CI", "GITHUB_ACTIONS", "GITHUB_REPOSITORY", "GITHUB_RUN_ATTEMPT",
    "GITHUB_RUN_ID", "GITHUB_SHA", "ImageOS", "ImageVersion", "RUNNER_ARCH", "RUNNER_ENVIRONMENT",
    "RUNNER_OS", "RUNNER_TEMP"];
const OPERATION_KEYS = ["acquirePublicAsset", "fetchFixedJson", "hashClosure", "now",
    "prepareOwnedExecutionMaterial", "readEnvelope", "readManifestBytes", "writeEnvelope",
    "writeExecutionPlan"];
const FIXED_ENDPOINTS = Object.freeze({
    tag: `https://api.github.com/repos/${REPOSITORY}/git/ref/tags/${TAG_NAME}`,
    run: `https://api.github.com/repos/${REPOSITORY}/actions/runs/${QUALIFICATION_RUN_ID}/attempts/${QUALIFICATION_RUN_ATTEMPT}`,
    artifact: `https://api.github.com/repos/${REPOSITORY}/actions/artifacts/${QUALIFICATION_ARCHIVE_ID}`,
    release: `https://api.github.com/repos/${REPOSITORY}/releases/${RELEASE_ID}`
});
const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const POSITIVE_DECIMAL = /^[1-9][0-9]{0,19}$/u;
const IMAGE_VERSION = /^[0-9A-Za-z._-]{1,64}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const MAXIMUM_PUBLIC_ASSET_BYTES = 268_435_456;
const MAXIMUM_API_BYTES = 2_097_152;
const MAXIMUM_MANIFEST_BYTES = 65_536;
const MAXIMUM_POWERSHELL_OUTPUT_BYTES = 65_536;
const MAXIMUM_FAILURE_CHARACTERS = 1_024;
const ACQUISITION_NAMES = new Set(["qualification-manifest.json", "MySpeed-windows-x64-baseline.exe",
    "MySpeed-windows-x64.exe"]);
const CLOSURE_NAMES = ["adapter", "canary", "candidateController", "cleanStopController", "host", "proof"];

function fail(message) {
    throw new Error(`Invalid v1.6.1 hosted preparation: ${message}`);
}

function exactKeys(value, expected, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
    const actual = Object.keys(value).sort();
    const keys = [...expected].sort();
    if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
        fail(`${label} keys differ`);
    }
}

function exactString(value, pattern, label) {
    if (typeof value !== "string") fail(`${label} must be a string`);
    const match = pattern.exec(value);
    if (!match || match.index !== 0 || match[0].length !== value.length) fail(`${label} differs`);
}

function validateHostedEnvironment(environment) {
    exactKeys(environment, ENVIRONMENT_KEYS, "hosted environment");
    const exact = {GITHUB_ACTIONS: "true", CI: "true", GITHUB_REPOSITORY: REPOSITORY,
        RUNNER_OS: "Windows", RUNNER_ARCH: "X64", RUNNER_ENVIRONMENT: "github-hosted",
        ImageOS: "win25-vs2026"};
    for (const [name, expected] of Object.entries(exact)) {
        if (environment[name] !== expected) fail(`hosted environment ${name} differs`);
    }
    exactString(environment.GITHUB_SHA, COMMIT_SHA, "hosted source SHA");
    if (environment.GITHUB_SHA === CANDIDATE_SOURCE_SHA) fail("harness and candidate sources collide");
    exactString(environment.GITHUB_RUN_ID, POSITIVE_DECIMAL, "hosted run ID");
    exactString(environment.GITHUB_RUN_ATTEMPT, POSITIVE_DECIMAL, "hosted run attempt");
    exactString(environment.ImageVersion, IMAGE_VERSION, "hosted image version");
    if (typeof environment.RUNNER_TEMP !== "string" || !/^[A-Za-z]:\\/.test(environment.RUNNER_TEMP)
            || path.win32.resolve(environment.RUNNER_TEMP) !== environment.RUNNER_TEMP
            || path.win32.dirname(environment.RUNNER_TEMP) === environment.RUNNER_TEMP) {
        fail("runner temp path differs");
    }
}

function isoSeconds(now) {
    if (!(now instanceof Date) || !Number.isFinite(now.valueOf())) fail("observation clock differs");
    return now.toISOString().replace(".000Z", "Z");
}

function releaseAsset(asset) {
    return {id: asset.id, name: asset.name, size: asset.size, digest: asset.digest,
        state: asset.state, url: asset.browser_download_url,
        createdAt: asset.created_at, updatedAt: asset.updated_at};
}

function targetInput(environment, captured, manifestBytes, observedAt) {
    const {tag, run, artifact, release} = captured;
    if (tag?.object?.type !== "commit" || tag.object.sha !== CANDIDATE_SOURCE_SHA) {
        fail("published tag resolution differs");
    }
    return {harnessSourceSha: environment.GITHUB_SHA, observedAt, manifestBytes,
        tag: {repository: REPOSITORY, name: TAG_NAME, commitSha: tag.object.sha},
        qualificationRun: {repository: run?.repository?.full_name, id: run.id, attempt: run.run_attempt,
            headSha: run.head_sha, event: run.event, status: run.status, conclusion: run.conclusion,
            workflowName: run.name, createdAt: run.created_at, updatedAt: run.updated_at},
        qualificationArchive: {repository: REPOSITORY, id: artifact.id, name: artifact.name,
            size: artifact.size_in_bytes, digest: artifact.digest, expired: artifact.expired,
            createdAt: artifact.created_at, updatedAt: artifact.updated_at, expiresAt: artifact.expires_at,
            runId: artifact.workflow_run?.id, runAttempt: QUALIFICATION_RUN_ATTEMPT,
            headSha: artifact.workflow_run?.head_sha},
        release: {repository: REPOSITORY, id: release.id, tagName: release.tag_name,
            targetCommitish: release.target_commitish, createdAt: release.created_at,
            publishedAt: release.published_at, draft: release.draft, prerelease: release.prerelease,
            platformImmutable: release.immutable, assets: release.assets?.map(releaseAsset)}};
}

function destination(root, name) {
    return `${root}\\myspeed-v1.6.1-acquisition\\${name}`;
}

const fileSha256 = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

async function fetchFixedJsonDefault(name, url) {
    if (FIXED_ENDPOINTS[name] !== url) fail("GitHub API endpoint differs");
    const headers = {Accept: "application/vnd.github+json", "User-Agent": "myspeed-v1.6.1-qualification"};
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const response = await fetch(url, {headers, redirect: "error"});
    if (!response.ok) fail(`GitHub API ${name} returned ${response.status}`);
    if (!response.body) fail(`GitHub API ${name} response is absent`);
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
        const value = Buffer.from(chunk);
        length += value.length;
        if (length > MAXIMUM_API_BYTES) fail(`GitHub API ${name} response is outside its bound`);
        chunks.push(value);
    }
    if (length === 0) fail(`GitHub API ${name} response is outside its bound`);
    const bytes = Buffer.concat(chunks, length);
    try { return JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes)); }
    catch { fail(`GitHub API ${name} JSON differs`); }
}

async function acquirePublicAssetDefault(request) {
    const releasePrefix = `https://github.com/${REPOSITORY}/releases/download/${TAG_NAME}/`;
    exactKeys(request, ["destination", "expectedBytes", "expectedSha256", "name", "url"],
        "public release acquisition request");
    if (!ACQUISITION_NAMES.has(request.name) || request.url !== `${releasePrefix}${request.name}`
            || !Number.isSafeInteger(request.expectedBytes) || request.expectedBytes < 1
            || request.expectedBytes > MAXIMUM_PUBLIC_ASSET_BYTES
            || !SHA256.test(request.expectedSha256)) fail("public release acquisition request differs");
    const parent = path.dirname(request.destination);
    fs.mkdirSync(parent, {recursive: true});
    const parentStat = fs.lstatSync(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) fail("public release destination parent differs");
    // Deliberately no Authorization header: redirects to the public asset CDN
    // must never receive GITHUB_TOKEN.
    const response = await fetch(request.url, {headers: {"User-Agent": "myspeed-v1.6.1-qualification"},
        redirect: "follow"});
    if (!response.ok || !response.body) fail(`public release asset returned ${response.status}`);
    const handle = fs.openSync(request.destination, "wx", 0o600);
    const hash = createHash("sha256");
    let bytes = 0;
    let complete = false;
    try {
        for await (const chunk of response.body) {
            const value = Buffer.from(chunk);
            bytes += value.length;
            if (bytes > request.expectedBytes) fail(`public release asset is oversized: ${request.name}`);
            fs.writeSync(handle, value);
            hash.update(value);
        }
        fs.fsyncSync(handle);
        const sha256 = hash.digest("hex");
        if (bytes !== request.expectedBytes || sha256 !== request.expectedSha256) {
            fail(`public release asset identity differs: ${request.name}`);
        }
        complete = true;
        return {path: request.destination, bytes, sha256};
    } finally {
        fs.closeSync(handle);
        if (!complete) {
            try { fs.unlinkSync(request.destination); } catch (error) {
                if (error?.code !== "ENOENT") throw error;
            }
        }
    }
}

function closurePaths() {
    const releaseRoot = path.dirname(fileURLToPath(import.meta.url));
    const qualificationRoot = path.resolve(releaseRoot, "..", "qualification");
    return {adapter: path.join(qualificationRoot, "windows-native-standalone-adapter.mjs"),
        canary: path.join(qualificationRoot, "windows-winsw-offline-canary.ps1"),
        candidateController: path.join(qualificationRoot, "windows-native-candidate-controller.ps1"),
        cleanStopController: path.join(qualificationRoot, "windows-clean-stop-controller.ps1"),
        host: path.join(qualificationRoot, "windows-native-standalone-host.ps1"),
        proof: path.join(qualificationRoot, "windows-native-standalone-proof.mjs")};
}

async function hashClosureDefault(names) {
    const paths = closurePaths();
    return Object.fromEntries(names.map(name => [name, fileSha256(paths[name])]));
}

function readManifestBytesDefault(file) {
    const pathStat = fs.lstatSync(file);
    if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.nlink !== 1
            || pathStat.size < 1 || pathStat.size > MAXIMUM_MANIFEST_BYTES) {
        fail("published manifest file differs");
    }
    const handle = fs.openSync(file, fs.constants.O_RDONLY);
    try {
        const before = fs.fstatSync(handle);
        if (!before.isFile() || before.nlink !== 1 || before.size !== pathStat.size
                || before.dev !== pathStat.dev || before.ino !== pathStat.ino) {
            fail("published manifest handle identity differs");
        }
        const bytes = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < bytes.length) {
            const count = fs.readSync(handle, bytes, offset, bytes.length - offset, offset);
            if (count < 1) fail("published manifest read was truncated");
            offset += count;
        }
        const after = fs.fstatSync(handle);
        if (after.size !== before.size || after.dev !== before.dev || after.ino !== before.ino) {
            fail("published manifest changed while reading");
        }
        return bytes;
    } finally { fs.closeSync(handle); }
}

function observeIdentityDefault({path: candidatePath, allowedRoot, expectedSha256, binding, hostPath, powershellPath}) {
    const request = JSON.stringify({request: {path: candidatePath, allowedRoot, expectedSha256}});
    const context = binding.oracleContext;
    const output = childProcess.execFileSync(powershellPath, ["-NoLogo", "-NoProfile", "-NonInteractive",
        "-ExecutionPolicy", "Bypass", "-File", hostPath, "-Mode", "ObserveCandidateIdentity",
        "-InputJson", request, "-ExpectedRunId", context.runId, "-ExpectedRunAttempt", context.runAttempt,
        "-ExpectedEventSha", context.eventSha, "-ExpectedSourceSha", context.sourceSha,
        "-ExpectedImageVersion", context.imageVersion, "-Nonce", context.nonce],
    {encoding: "utf8", windowsHide: true, maxBuffer: MAXIMUM_POWERSHELL_OUTPUT_BYTES});
    const lines = output.trim().split(/\r?\n/u);
    if (lines.length !== 1) fail("candidate identity observer output differs");
    try { return JSON.parse(lines[0]); } catch { fail("candidate identity observer JSON differs"); }
}

async function prepareOwnedExecutionMaterialDefault({binding, downloaded, environment, closureHashes}) {
    const paths = closurePaths();
    const context = binding.oracleContext;
    const taskRoot = path.join(environment.RUNNER_TEMP, `myspeed-native-standalone-${context.nonce}`);
    fs.mkdirSync(taskRoot, {recursive: false});
    const closureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const fixtureRoot = path.join(closureRoot, "fixture");
    const fixtureTransport = path.join(fixtureRoot, "transport.json");
    const fixtureManifest = JSON.parse(fs.readFileSync(fixtureTransport, "utf8"));
    const powershellPath = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    const fixtures = [];
    const candidates = [];
    const scenarios = ["populated-first-boot", "populated-restart", "fresh-no-config-reset"];
    for (const candidate of binding.candidates) {
        const acquired = downloaded.find(value => value.alias === candidate.alias);
        if (!acquired) fail(`downloaded candidate is absent: ${candidate.alias}`);
        const candidateRoot = path.join(taskRoot, `candidate-${candidate.alias}`);
        fs.mkdirSync(candidateRoot);
        const candidatePath = path.join(candidateRoot, candidate.name);
        fs.copyFileSync(acquired.path, candidatePath, fs.constants.COPYFILE_EXCL);
        const sourceIdentity = observeIdentityDefault({path: candidatePath, allowedRoot: candidateRoot,
            expectedSha256: candidate.sha256, binding, hostPath: paths.host, powershellPath});
        const populatedWork = path.join(taskRoot, `fixture-${candidate.alias}-populated`);
        const resetWork = path.join(taskRoot, `fixture-${candidate.alias}-reset`);
        const manifestPath = path.join(taskRoot, `fixture-${candidate.alias}.json`);
        const materialized = await materializeWindowsNativeStandaloneFixture({manifestPath: fixtureTransport,
            populated: path.join(fixtureRoot, "populated"), reset: path.join(fixtureRoot, "reset"),
            manifest: fixtureManifest, outputManifestPath: manifestPath, populatedRoot: populatedWork,
            resetRoot: resetWork, expectedSourceSha: context.sourceSha});
        exactKeys(materialized, ["expected", "populated", "reset", "schemaVersion", "source"],
            `materialized fixture ${candidate.alias}`);
        if (materialized.schemaVersion !== 1 || materialized.source?.commit !== context.sourceSha
                || materialized.populated?.root !== populatedWork || materialized.reset?.root !== resetWork
                || JSON.stringify(JSON.parse(fs.readFileSync(manifestPath, "utf8")))
                    !== JSON.stringify(materialized)) {
            fail(`materialized fixture ${candidate.alias} differs`);
        }
        fixtures.push({alias: candidate.alias, manifestPath,
            manifestSha256: fileSha256(manifestPath), populatedWork, resetWork});
        const scenarioValues = [];
        for (const scenario of scenarios) {
            const nonce = createHash("sha256").update(`${context.nonce}\0${candidate.alias}\0${scenario}`)
                .digest("hex").slice(0, 32);
            const scenarioRoot = path.join(environment.RUNNER_TEMP, `myspeed-native-candidate-${nonce}`);
            fs.mkdirSync(scenarioRoot);
            const scenarioCandidate = path.join(scenarioRoot, "MySpeed.exe");
            const scenarioController = path.join(scenarioRoot, "windows-clean-stop-controller.ps1");
            fs.copyFileSync(candidatePath, scenarioCandidate, fs.constants.COPYFILE_EXCL);
            fs.copyFileSync(paths.cleanStopController, scenarioController, fs.constants.COPYFILE_EXCL);
            const candidateIdentity = observeIdentityDefault({path: scenarioCandidate, allowedRoot: scenarioRoot,
                expectedSha256: candidate.sha256, binding, hostPath: paths.host, powershellPath});
            scenarioValues.push({scenario, nonce, taskRoot: scenarioRoot, candidatePath: scenarioCandidate,
                candidateIdentity, controllerPath: scenarioController});
        }
        candidates.push({alias: candidate.alias, sourcePath: candidatePath, sourceIdentity,
            scenarios: scenarioValues});
    }
    return {taskRoot,
        closure: {proofPath: paths.proof, proofSha256: closureHashes.proof,
            adapterPath: paths.adapter, adapterSha256: closureHashes.adapter,
            hostPath: paths.host, hostSha256: closureHashes.host,
            candidateControllerPath: paths.candidateController,
            candidateControllerSha256: closureHashes.candidateController,
            cleanStopControllerPath: paths.cleanStopController,
            cleanStopControllerSha256: closureHashes.cleanStopController,
            canaryPath: paths.canary, canarySha256: closureHashes.canary},
        node: {path: process.execPath, sha256: fileSha256(process.execPath)},
        powershell: {path: powershellPath, sha256: fileSha256(powershellPath)}, fixtures, candidates};
}

export async function prepareV161PostReleaseHostedCoordinator({environment, operations}) {
    validateHostedEnvironment(environment);
    exactKeys(operations, OPERATION_KEYS, "hosted preparation operations");
    for (const name of OPERATION_KEYS) {
        if (typeof operations[name] !== "function") fail(`hosted operation ${name} differs`);
    }
    const captured = {};
    for (const name of ["tag", "run", "artifact", "release"]) {
        captured[name] = await operations.fetchFixedJson(name, FIXED_ENDPOINTS[name]);
    }
    const manifestName = "qualification-manifest.json";
    const manifestMetadata = captured.release.assets?.find(asset => asset.name === manifestName);
    if (!manifestMetadata) fail("published manifest asset is absent");
    const manifestPath = destination(environment.RUNNER_TEMP, manifestName);
    const manifestReceipt = await operations.acquirePublicAsset({name: manifestName,
        url: manifestMetadata.browser_download_url, destination: manifestPath,
        expectedBytes: manifestMetadata.size, expectedSha256: manifestMetadata.digest?.replace("sha256:", "")});
    if (manifestReceipt.path !== manifestPath || manifestReceipt.bytes !== manifestMetadata.size
            || manifestReceipt.sha256 !== manifestMetadata.digest?.replace("sha256:", "")) {
        fail("published manifest acquisition differs");
    }
    const manifestBytes = await operations.readManifestBytes(manifestPath);
    const target = bindV161PostReleaseTarget(targetInput(environment, captured, manifestBytes,
        isoSeconds(operations.now())));
    const closureHashes = await operations.hashClosure(CLOSURE_NAMES, environment);
    exactKeys(closureHashes, CLOSURE_NAMES, "closure hashes");
    for (const name of CLOSURE_NAMES) exactString(closureHashes[name], /^[0-9a-f]{64}$/u, `${name} hash`);
    const nonce = createHash("sha256").update(`${environment.GITHUB_RUN_ID}\0${environment.GITHUB_RUN_ATTEMPT}`
        + `\0${environment.GITHUB_SHA}`, "utf8").digest("hex").slice(0, 32);
    const hostedContext = {repository: REPOSITORY, runId: environment.GITHUB_RUN_ID,
        runAttempt: environment.GITHUB_RUN_ATTEMPT, eventSha: environment.GITHUB_SHA,
        imageVersion: environment.ImageVersion, nonce};
    const binding = createV161PostReleaseStandaloneBinding(target, hostedContext);
    const downloaded = [];
    for (const candidate of binding.candidates.slice().reverse()) {
        const receipt = await operations.acquirePublicAsset({name: candidate.name, url: candidate.url,
            destination: destination(environment.RUNNER_TEMP, candidate.name),
            expectedBytes: candidate.bytes, expectedSha256: candidate.sha256});
        if (receipt.path !== destination(environment.RUNNER_TEMP, candidate.name)
                || receipt.bytes !== candidate.bytes || receipt.sha256 !== candidate.sha256) {
            fail(`published candidate acquisition differs: ${candidate.alias}`);
        }
        downloaded.push({...receipt, alias: candidate.alias, name: candidate.name});
    }
    const acquired = await operations.prepareOwnedExecutionMaterial({binding, downloaded,
        environment, captured, closureHashes, fixedEndpoints: FIXED_ENDPOINTS});
    const producer = buildV161PostReleaseStandaloneProducerPlan(binding, acquired);
    const retained = await retainV161PostReleaseStandaloneProducerPlan(producer, {
        writeEnvelope: operations.writeEnvelope,
        readEnvelope: operations.readEnvelope,
        writeExecutionPlan: operations.writeExecutionPlan
    });
    return {schemaVersion: 1, kind: "myspeed-v1.6.1-post-release-hosted-preparation",
        status: "prepared", qualifying: false, nativeExecutionStarted: false,
        candidateSourceSha: CANDIDATE_SOURCE_SHA, harnessSourceSha: environment.GITHUB_SHA,
        targetHashes: {...binding.targetHashes}, envelopePath: retained.envelopePath,
        envelopeSha256: retained.envelopeSha256, execution: retained.execution,
        releaseGatesCleared: []};
}

function defaultHostedOperations() {
    return Object.freeze({
        acquirePublicAsset: acquirePublicAssetDefault,
        fetchFixedJson: fetchFixedJsonDefault,
        hashClosure: hashClosureDefault,
        now: () => new Date(),
        prepareOwnedExecutionMaterial: prepareOwnedExecutionMaterialDefault,
        readEnvelope: async file => fs.readFileSync(file),
        readManifestBytes: async file => readManifestBytesDefault(file),
        writeEnvelope: async input => writeV161PostReleaseEnvelopeExclusive(input),
        writeExecutionPlan: async plan => writeWindowsNativeStandaloneExecutionPlan(plan)
    });
}

function processHostedEnvironment() {
    return Object.fromEntries(ENVIRONMENT_KEYS.map(name => [name, process.env[name]]));
}

export async function runV161PostReleaseHostedControllerCli(args) {
    if (!Array.isArray(args) || args.length !== 1 || args[0] !== "--prepare-v1.6.1") {
        throw new Error("Usage: post-release-hosted-controller.mjs --prepare-v1.6.1");
    }
    return prepareV161PostReleaseHostedCoordinator({environment: processHostedEnvironment(),
        operations: defaultHostedOperations()});
}

const invokedDirectly = process.argv[1]
    && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
    runV161PostReleaseHostedControllerCli(process.argv.slice(2)).then(result => {
        process.stdout.write(`${JSON.stringify(result)}\n`);
    }).catch(error => {
        const message = String(error?.message ?? error).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "?")
            .slice(0, MAXIMUM_FAILURE_CHARACTERS);
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
    });
}
