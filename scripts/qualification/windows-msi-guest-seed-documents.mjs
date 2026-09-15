import {createHash} from "node:crypto";
import path from "node:path";

import {validateWindowsMsiGuestPreflightEnvelope, validateWindowsMsiGuestPreflightRequest,
    WINDOWS_MSI_GUEST_PREFLIGHT_CONSTANTS} from "./windows-msi-guest-containment-preflight-executor.mjs";
import {validateWindowsMsiGuestMatrixEnvelope} from "./windows-msi-guest-matrix-executor.mjs";
import {validateWindowsMsiGuestExecutionManifest} from "./windows-msi-guest-matrix-operations.mjs";
import {validateWindowsMsiGuestMatrixRowRequest} from "./windows-msi-guest-matrix-row.mjs";

const SCHEMA_VERSION = 1;
const MAX_INPUT_BYTES = 1_048_576;
const MAX_RESULT_BYTES = 1_048_576;
const MAX_DURATION_MILLISECONDS = 16_200_000;
const MAX_PATH_CHARACTERS = 1024;
const FILE_NAMES = Object.freeze({rowRequest: "row-request.json", executionManifest: "execution-manifest.json",
    envelope: "matrix-envelope.json", launcherRequest: "launch-request.json",
    semanticResult: "result.json", launcherResult: "launcher-result.json",
    matrixRunner: "windows-msi-guest-matrix-executor.mjs", launcher: "media-job-launcher.ps1"});

/*
 * The preflight travels through the same transport as a matrix row: its own request document, its
 * own envelope, and the same launch request the generic guest runner already understands - pointed
 * at the preflight runner instead of the matrix one. Nothing new is invented on the guest side.
 */
const PREFLIGHT_FILE_NAMES = Object.freeze({preflightRequest: "preflight-request.json",
    envelope: "preflight-envelope.json", launcherRequest: "launch-request.json",
    semanticResult: "result.json", launcherResult: "launcher-result.json",
    preflightRunner: "windows-msi-guest-containment-preflight-executor.mjs",
    launcher: "media-job-launcher.ps1"});

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, expected, label) => {
    if (!isObject(value)) throw new TypeError(`${label} must be an object`);
    const actual = Object.keys(value).sort(); const wanted = [...expected].sort();
    if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
        throw new TypeError(`${label} keys differ`);
};
const exactString = (value, pattern, label) => {
    if (typeof value !== "string" || value.length < 1 || value.length > MAX_PATH_CHARACTERS)
        throw new TypeError(`${label} differs`);
    const match = pattern.exec(value);
    if (!match || match.index !== 0 || match[0].length !== value.length) throw new TypeError(`${label} differs`);
    return value;
};
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const identity = (value, root, expectedName, label) => {
    exactKeys(value, ["path", "bytes", "sha256"], label);
    const expectedPath = path.win32.join(root, expectedName);
    if (value.path !== expectedPath || !Number.isSafeInteger(value.bytes) || value.bytes < 1
        || value.bytes > 1_073_741_824) throw new TypeError(`${label} differs`);
    exactString(value.sha256, /^[0-9a-f]{64}$/u, `${label} SHA-256`);
    return value;
};
const retain = (name, value) => {
    const bytes = Buffer.from(JSON.stringify(value), "utf8");
    if (bytes.length < 1 || bytes.length > MAX_INPUT_BYTES) throw new TypeError(`${name} exceeds its bound`);
    return Object.freeze({name, bytes: bytes.length, sha256: sha256(bytes), bytesBase64: bytes.toString("base64")});
};

export const buildWindowsMsiGuestSeedDocuments = input => {
    exactKeys(input, ["rowRequest", "executionManifest", "matrixRunner", "launcher", "observerSha256",
        "wallDeadlineUnixMilliseconds"], "MSI guest seed document input");
    const rowRequest = validateWindowsMsiGuestMatrixRowRequest(structuredClone(input.rowRequest));
    const execution = validateWindowsMsiGuestExecutionManifest(structuredClone(input.executionManifest));
    for (const name of ["sourceSha", "runId", "runAttempt"])
        if (execution.probeArtifact[name] !== rowRequest[name])
            throw new TypeError(`MSI guest Stage1 ${name} differs`);
    if (execution.outputRoot !== rowRequest.guest.evidenceRoot)
        throw new TypeError("MSI guest execution roots differ");
    const matrixRunner = identity(input.matrixRunner, execution.seedRoot, FILE_NAMES.matrixRunner,
        "MSI guest matrix runner");
    const launcher = identity(input.launcher, execution.seedRoot, FILE_NAMES.launcher, "MSI guest launcher");
    exactString(input.observerSha256, /^[0-9a-f]{64}$/u, "MSI guest observer SHA-256");
    if (!Number.isSafeInteger(input.wallDeadlineUnixMilliseconds) || input.wallDeadlineUnixMilliseconds < 1)
        throw new TypeError("MSI guest wall deadline differs");
    const rowDocument = retain(FILE_NAMES.rowRequest, rowRequest);
    const executionDocument = retain(FILE_NAMES.executionManifest, execution);
    const rowPath = path.win32.join(execution.seedRoot, FILE_NAMES.rowRequest);
    const executionPath = path.win32.join(execution.seedRoot, FILE_NAMES.executionManifest);
    const envelope = {schemaVersion: SCHEMA_VERSION, kind: "myspeed-windows-msi-guest-matrix-envelope",
        qualifying: false, sourceSha: rowRequest.sourceSha, eventSha: rowRequest.eventSha,
        runId: rowRequest.runId, runAttempt: rowRequest.runAttempt, nonce: rowRequest.nonce,
        seedRoot: execution.seedRoot, outputRoot: execution.outputRoot,
        rowRequest: {path: rowPath, bytes: rowDocument.bytes, sha256: rowDocument.sha256},
        executionManifest: {path: executionPath, bytes: executionDocument.bytes,
            sha256: executionDocument.sha256}, resultPath: path.win32.join(execution.outputRoot,
            FILE_NAMES.semanticResult), limits: {inputBytes: MAX_INPUT_BYTES, resultBytes: MAX_RESULT_BYTES}};
    validateWindowsMsiGuestMatrixEnvelope(envelope);
    const envelopeDocument = retain(FILE_NAMES.envelope, envelope);
    const launchRequest = {schemaVersion: SCHEMA_VERSION, kind: "myspeed-windows-msi-guest-launch-request",
        qualifying: false, sourceSha: rowRequest.sourceSha, eventSha: rowRequest.eventSha,
        runId: rowRequest.runId, runAttempt: rowRequest.runAttempt, nonce: rowRequest.nonce,
        observerSha256: input.observerSha256, guest: {cpuClass: "modern-msi", serial: rowRequest.guest.serial,
            cpuEvidenceSha256: rowRequest.guest.cpuEvidenceSha256,
            qemuLaunchSha256: rowRequest.guest.qemuLaunchSha256, seedRoot: execution.seedRoot,
            outputRoot: execution.outputRoot}, files: {node: execution.tools.node, runner: matrixRunner,
            launcher, semanticRequest: {path: path.win32.join(execution.seedRoot, FILE_NAMES.envelope),
                bytes: envelopeDocument.bytes, sha256: envelopeDocument.sha256}},
        semanticOutputPath: envelope.resultPath,
        launcherOutputPath: path.win32.join(execution.outputRoot, FILE_NAMES.launcherResult),
        wallDeadlineUnixMilliseconds: input.wallDeadlineUnixMilliseconds,
        maximumDurationMilliseconds: MAX_DURATION_MILLISECONDS,
        maximumSemanticResultBytes: MAX_RESULT_BYTES};
    const launcherDocument = retain(FILE_NAMES.launcherRequest, launchRequest);
    return Object.freeze({rowRequest: rowDocument, executionManifest: executionDocument,
        envelope: envelopeDocument, launcherRequest: launcherDocument});
};

export const buildWindowsMsiGuestPreflightSeedDocuments = input => {
    exactKeys(input, ["preflightRequest", "preflightRunner", "launcher", "observerSha256", "node",
        "wallDeadlineUnixMilliseconds"], "MSI guest preflight seed document input");
    const request = validateWindowsMsiGuestPreflightRequest(structuredClone(input.preflightRequest));
    const seedRoot = request.guest.seedRoot;
    const outputRoot = request.guest.outputRoot;
    const preflightRunner = identity(input.preflightRunner, seedRoot, PREFLIGHT_FILE_NAMES.preflightRunner,
        "MSI guest preflight runner");
    const launcher = identity(input.launcher, seedRoot, PREFLIGHT_FILE_NAMES.launcher,
        "MSI guest preflight launcher");
    exactString(input.observerSha256, /^[0-9a-f]{64}$/u, "MSI guest preflight observer SHA-256");
    exactKeys(input.node, ["path", "bytes", "sha256"], "MSI guest preflight node");
    if (!Number.isSafeInteger(input.wallDeadlineUnixMilliseconds) || input.wallDeadlineUnixMilliseconds < 1)
        throw new TypeError("MSI guest preflight wall deadline differs");
    const requestDocument = retain(PREFLIGHT_FILE_NAMES.preflightRequest, request);
    const envelope = {schemaVersion: SCHEMA_VERSION,
        kind: WINDOWS_MSI_GUEST_PREFLIGHT_CONSTANTS.envelopeKind, qualifying: false,
        sourceSha: request.sourceSha, eventSha: request.eventSha, runId: request.runId,
        runAttempt: request.runAttempt, nonce: request.nonce, seedRoot, outputRoot,
        preflightRequest: {path: path.win32.join(seedRoot, PREFLIGHT_FILE_NAMES.preflightRequest),
            bytes: requestDocument.bytes, sha256: requestDocument.sha256},
        resultPath: path.win32.join(outputRoot, PREFLIGHT_FILE_NAMES.semanticResult),
        limits: {inputBytes: MAX_INPUT_BYTES,
            resultBytes: WINDOWS_MSI_GUEST_PREFLIGHT_CONSTANTS.maximumResultBytes}};
    validateWindowsMsiGuestPreflightEnvelope(envelope);
    const envelopeDocument = retain(PREFLIGHT_FILE_NAMES.envelope, envelope);
    const launchRequest = {schemaVersion: SCHEMA_VERSION, kind: "myspeed-windows-msi-guest-launch-request",
        qualifying: false, sourceSha: request.sourceSha, eventSha: request.eventSha,
        runId: request.runId, runAttempt: request.runAttempt, nonce: request.nonce,
        observerSha256: input.observerSha256, guest: {cpuClass: "modern-msi", serial: request.guest.serial,
            cpuEvidenceSha256: request.guest.cpuEvidenceSha256,
            qemuLaunchSha256: request.guest.qemuLaunchSha256, seedRoot, outputRoot},
        files: {node: input.node, runner: preflightRunner, launcher,
            semanticRequest: {path: path.win32.join(seedRoot, PREFLIGHT_FILE_NAMES.envelope),
                bytes: envelopeDocument.bytes, sha256: envelopeDocument.sha256}},
        semanticOutputPath: envelope.resultPath,
        launcherOutputPath: path.win32.join(outputRoot, PREFLIGHT_FILE_NAMES.launcherResult),
        wallDeadlineUnixMilliseconds: input.wallDeadlineUnixMilliseconds,
        maximumDurationMilliseconds: MAX_DURATION_MILLISECONDS,
        maximumSemanticResultBytes: WINDOWS_MSI_GUEST_PREFLIGHT_CONSTANTS.maximumResultBytes};
    const launcherDocument = retain(PREFLIGHT_FILE_NAMES.launcherRequest, launchRequest);
    return Object.freeze({preflightRequest: requestDocument, envelope: envelopeDocument,
        launcherRequest: launcherDocument});
};

export const WINDOWS_MSI_GUEST_PREFLIGHT_SEED_FILE_NAMES = PREFLIGHT_FILE_NAMES;

export const WINDOWS_MSI_GUEST_SEED_DOCUMENT_CONSTANTS = Object.freeze({FILE_NAMES, MAX_DURATION_MILLISECONDS,
    MAX_INPUT_BYTES, MAX_RESULT_BYTES});
