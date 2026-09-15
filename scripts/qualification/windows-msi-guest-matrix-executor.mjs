import {createHash} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {pathToFileURL} from "node:url";

import {createWindowsMsiGuestMatrixOperations,
    validateWindowsMsiGuestExecutionManifest,
    validateWindowsMsiGuestLifecycleReceipts,
    validateWindowsMsiGuestOperationDetails} from "./windows-msi-guest-matrix-operations.mjs";
import {runWindowsMsiGuestMatrixRow, validateWindowsMsiGuestMatrixRowRequest,
    validateWindowsMsiGuestMatrixRowResult} from "./windows-msi-guest-matrix-row.mjs";

const SCHEMA_VERSION = 1;
const ENVELOPE_KIND = "myspeed-windows-msi-guest-matrix-envelope";
const SEMANTIC_RESULT_KIND = "myspeed-windows-msi-guest-matrix-semantic-result";
const MAX_INPUT_BYTES = 1_048_576;
const MAX_RESULT_BYTES = 1_048_576;
const MAX_PATH_CHARACTERS = 1024;

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, keys, label) => {
    if (!isObject(value)) throw new Error(`${label} must be an object`);
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
        throw new Error(`${label} keys differ`);
    return value;
};
const exactString = (value, label, pattern) => {
    if (typeof value !== "string" || value.length < 1 || value.length > MAX_PATH_CHARACTERS)
        throw new Error(`${label} differs`);
    const match = pattern.exec(value);
    if (!match || match.index !== 0 || match[0].length !== value.length) throw new Error(`${label} differs`);
    return value;
};
const hash = (value, label, length = 64) => exactString(value, label,
    new RegExp(`^[0-9a-f]{${length}}$`, "u"));
const integer = (value, label, minimum, maximum) => {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
        throw new Error(`${label} differs`);
    return value;
};
const windowsPath = (value, label) => {
    const candidate = exactString(value, label, /^[A-Za-z]:\\[^\x00-\x1f\x7f:*?"<>|]*$/u);
    if (path.win32.normalize(candidate) !== candidate || candidate.slice(2).includes(":"))
        throw new Error(`${label} differs`);
    return candidate;
};
const descendant = (root, value, label) => {
    const candidate = windowsPath(value, label);
    const relative = path.win32.relative(root, candidate);
    if (relative === "" || relative === ".." || relative.startsWith(`..${path.win32.sep}`)
        || path.win32.isAbsolute(relative)) throw new Error(`${label} escapes its root`);
    return candidate;
};
const sha256 = value => createHash("sha256").update(value).digest("hex");
const binding = (value, root, label, maximumBytes) => {
    exactKeys(value, ["path", "bytes", "sha256"], label);
    descendant(root, value.path, `${label} path`);
    integer(value.bytes, `${label} bytes`, 1, maximumBytes);
    hash(value.sha256, `${label} SHA-256`);
    return value;
};

export const validateWindowsMsiGuestMatrixEnvelope = value => {
    exactKeys(value, ["schemaVersion", "kind", "qualifying", "sourceSha", "eventSha", "runId",
        "runAttempt", "nonce", "seedRoot", "outputRoot", "rowRequest", "executionManifest",
        "resultPath", "limits"], "MSI guest matrix envelope");
    integer(value.schemaVersion, "MSI guest matrix envelope schema", SCHEMA_VERSION, SCHEMA_VERSION);
    if (exactString(value.kind, "MSI guest matrix envelope kind", /^[a-z0-9-]+$/u) !== ENVELOPE_KIND)
        throw new Error("MSI guest matrix envelope kind differs");
    if (typeof value.qualifying !== "boolean" || value.qualifying)
        throw new Error("MSI guest matrix envelope must be nonqualifying");
    hash(value.sourceSha, "MSI guest matrix source SHA", 40);
    hash(value.eventSha, "MSI guest matrix event SHA", 40);
    exactString(value.runId, "MSI guest matrix run ID", /^[1-9][0-9]{0,19}$/u);
    exactString(value.runAttempt, "MSI guest matrix run attempt", /^[1-9][0-9]{0,9}$/u);
    hash(value.nonce, "MSI guest matrix nonce", 32);
    const seedRoot = windowsPath(value.seedRoot, "MSI guest seed root");
    const outputRoot = windowsPath(value.outputRoot, "MSI guest output root");
    if (seedRoot.toLowerCase() === outputRoot.toLowerCase()) throw new Error("MSI guest roots collide");
    exactKeys(value.limits, ["inputBytes", "resultBytes"], "MSI guest matrix limits");
    const inputBytes = integer(value.limits.inputBytes, "MSI guest matrix input bound", 1, MAX_INPUT_BYTES);
    integer(value.limits.resultBytes, "MSI guest matrix result bound", 1, MAX_RESULT_BYTES);
    binding(value.rowRequest, seedRoot, "MSI guest row request", inputBytes);
    binding(value.executionManifest, seedRoot, "MSI guest execution manifest", inputBytes);
    if (value.rowRequest.path.toLowerCase() === value.executionManifest.path.toLowerCase())
        throw new Error("MSI guest input paths collide");
    descendant(outputRoot, value.resultPath, "MSI guest result path");
    return value;
};

const readBoundFile = bindingValue => {
    const descriptor = fs.openSync(bindingValue.path, "r");
    try {
        const before = fs.fstatSync(descriptor);
        if (!before.isFile() || before.size !== bindingValue.bytes) throw new Error("MSI guest bound file differs");
        const content = fs.readFileSync(descriptor);
        const after = fs.fstatSync(descriptor);
        if (after.size !== before.size || sha256(content) !== bindingValue.sha256)
            throw new Error("MSI guest bound file identity differs");
        return content;
    } finally {
        fs.closeSync(descriptor);
    }
};

const parseBoundJson = async (bindingValue, read) => {
    const content = await read(bindingValue);
    if (!Buffer.isBuffer(content) || content.length !== bindingValue.bytes
        || sha256(content) !== bindingValue.sha256) throw new Error("MSI guest bound JSON identity differs");
    return JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(content));
};

const validateOperationEvidence = (value, request, scenario, operationIndex, execution) => {
    exactKeys(value, ["schemaVersion", "kind", "sourceSha", "eventSha", "runId", "runAttempt",
        "nonce", "scenarioId", "operation", "operationIndex", "details"], "MSI guest operation evidence");
    integer(value.schemaVersion, "MSI guest operation evidence schema", SCHEMA_VERSION, SCHEMA_VERSION);
    if (value.kind !== "myspeed-windows-msi-guest-operation-evidence"
        || value.sourceSha !== request.sourceSha || value.eventSha !== request.eventSha
        || value.runId !== request.runId || value.runAttempt !== request.runAttempt
        || value.nonce !== request.nonce || value.scenarioId !== scenario.id
        || value.operation !== scenario.operations[operationIndex] || value.operationIndex !== operationIndex)
        throw new Error("MSI guest operation evidence binding differs");
    validateWindowsMsiGuestOperationDetails(value.operation, value.details, scenario, execution, request);
    return value;
};

export const validateWindowsMsiGuestMatrixSemanticResult = (value, requestValue, executionValue) => {
    const request = validateWindowsMsiGuestMatrixRowRequest(requestValue);
    const execution = validateWindowsMsiGuestExecutionManifest(executionValue);
    const scenario = request.matrix.scenarios[request.scenarioIndex];
    exactKeys(value, ["schemaVersion", "kind", "status", "qualifying", "matrixPassed", "sourceSha",
        "eventSha", "runId", "runAttempt", "nonce", "scenarioIndex", "scenarioId", "rowResult",
        "evidence", "releaseGatesCleared"], "MSI guest matrix semantic result");
    integer(value.schemaVersion, "MSI guest semantic result schema", SCHEMA_VERSION, SCHEMA_VERSION);
    if (value.kind !== SEMANTIC_RESULT_KIND || typeof value.qualifying !== "boolean" || value.qualifying
        || typeof value.matrixPassed !== "boolean") throw new Error("MSI guest semantic result differs");
    const rowResult = validateWindowsMsiGuestMatrixRowResult(value.rowResult, request);
    if (rowResult.rowPassed) validateWindowsMsiGuestLifecycleReceipts(rowResult, request, execution);
    if (value.status !== rowResult.status || value.matrixPassed !== rowResult.rowPassed
        || value.sourceSha !== request.sourceSha || value.eventSha !== request.eventSha
        || value.runId !== request.runId || value.runAttempt !== request.runAttempt
        || value.nonce !== request.nonce || value.scenarioIndex !== request.scenarioIndex
        || value.scenarioId !== scenario.id) throw new Error("MSI guest semantic result binding differs");
    if (!Array.isArray(value.evidence) || value.evidence.length !== rowResult.operationProofs.length)
        throw new Error("MSI guest semantic evidence count differs");
    value.evidence.forEach((entry, index) => {
        exactKeys(entry, ["identity", "bytesBase64"], "MSI guest semantic evidence");
        exactKeys(entry.identity, ["path", "bytes", "sha256"], "MSI guest semantic evidence identity");
        const proof = rowResult.operationProofs[index].evidence;
        if (entry.identity.path !== proof.path || entry.identity.bytes !== proof.bytes
            || entry.identity.sha256 !== proof.sha256 || typeof entry.bytesBase64 !== "string")
            throw new Error("MSI guest semantic evidence identity differs");
        const content = Buffer.from(entry.bytesBase64, "base64");
        if (content.toString("base64") !== entry.bytesBase64 || content.length !== entry.identity.bytes
            || sha256(content) !== entry.identity.sha256)
            throw new Error("MSI guest semantic evidence bytes differ");
        validateOperationEvidence(JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(content)),
            request, scenario, index, execution);
    });
    if (!Array.isArray(value.releaseGatesCleared) || value.releaseGatesCleared.length !== 0)
        throw new Error("MSI guest semantic result clears a gate");
    return value;
};

const writeCreateNew = (target, content) => {
    fs.writeFileSync(target, content, {flag: "wx"});
};

export const executeWindowsMsiGuestMatrixEnvelope = async (input, {
    readBoundFile: read = readBoundFile,
    readEvidenceFile: readEvidence = readBoundFile,
    writeCreateNew: write = writeCreateNew,
    operationsFactory = ({request, execution}) => createWindowsMsiGuestMatrixOperations({request, execution})
} = {}) => {
    const envelope = validateWindowsMsiGuestMatrixEnvelope(input);
    const rowRequest = validateWindowsMsiGuestMatrixRowRequest(await parseBoundJson(envelope.rowRequest, read));
    const execution = validateWindowsMsiGuestExecutionManifest(
        await parseBoundJson(envelope.executionManifest, read));
    for (const [name, expected] of Object.entries({sourceSha: envelope.sourceSha, eventSha: envelope.eventSha,
        runId: envelope.runId, runAttempt: envelope.runAttempt, nonce: envelope.nonce}))
        if (rowRequest[name] !== expected) throw new Error(`MSI guest row ${name} differs`);
    if (execution.seedRoot.toLowerCase() !== envelope.seedRoot.toLowerCase()
        || execution.outputRoot.toLowerCase() !== envelope.outputRoot.toLowerCase()
        || rowRequest.guest.evidenceRoot.toLowerCase() !== envelope.outputRoot.toLowerCase())
        throw new Error("MSI guest envelope roots differ");
    const operations = operationsFactory({request: rowRequest, execution});
    const rowResult = await runWindowsMsiGuestMatrixRow(rowRequest, operations);
    validateWindowsMsiGuestMatrixRowResult(rowResult, rowRequest);
    const evidence = [];
    for (const proof of rowResult.operationProofs) {
        const content = await readEvidence(proof.evidence);
        if (!Buffer.isBuffer(content) || content.length !== proof.evidence.bytes
            || sha256(content) !== proof.evidence.sha256)
            throw new Error("MSI guest operation evidence identity differs");
        evidence.push({identity: proof.evidence, bytesBase64: content.toString("base64")});
    }
    const semanticResult = {schemaVersion: SCHEMA_VERSION, kind: SEMANTIC_RESULT_KIND,
        status: rowResult.status, qualifying: false, matrixPassed: rowResult.rowPassed,
        sourceSha: rowRequest.sourceSha, eventSha: rowRequest.eventSha, runId: rowRequest.runId,
        runAttempt: rowRequest.runAttempt, nonce: rowRequest.nonce, scenarioIndex: rowRequest.scenarioIndex,
        scenarioId: rowRequest.matrix.scenarios[rowRequest.scenarioIndex].id,
        rowResult, evidence, releaseGatesCleared: []};
    validateWindowsMsiGuestMatrixSemanticResult(semanticResult, rowRequest, execution);
    const resultBytes = Buffer.from(JSON.stringify(semanticResult), "utf8");
    if (resultBytes.length < 1 || resultBytes.length > envelope.limits.resultBytes)
        throw new Error("MSI guest matrix result exceeds its bound");
    await write(envelope.resultPath, resultBytes);
    return {semanticResult, identity: {path: envelope.resultPath, bytes: resultBytes.length,
        sha256: sha256(resultBytes)}};
};

const cli = async () => {
    const expectedArguments = ["--request", "--request-sha256"];
    if (process.argv.length !== 6 || process.argv[2] !== expectedArguments[0]
        || process.argv[4] !== expectedArguments[1]) throw new Error("MSI guest executor arguments differ");
    const requestPath = windowsPath(process.argv[3], "MSI guest envelope path");
    const expectedSha = hash(process.argv[5], "MSI guest envelope SHA-256");
    const stat = fs.statSync(requestPath);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_INPUT_BYTES)
        throw new Error("MSI guest envelope file differs");
    const envelopeBinding = {path: requestPath, bytes: stat.size, sha256: expectedSha};
    const envelope = await parseBoundJson(envelopeBinding, readBoundFile);
    const completed = await executeWindowsMsiGuestMatrixEnvelope(envelope);
    if (!completed.semanticResult.matrixPassed) process.exitCode = 1;
};

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await cli();
