import {createHash} from "node:crypto";

import {validateWindowsMsiGuestMatrixSemanticResult} from
    "./windows-msi-guest-matrix-executor.mjs";
import {validateWindowsMsiGuestExecutionManifest} from
    "./windows-msi-guest-matrix-operations.mjs";
import {validateWindowsMsiGuestMatrixRowRequest} from
    "./windows-msi-guest-matrix-row.mjs";

const SCHEMA_VERSION = 1;
const EVIDENCE_KIND = "myspeed-windows-msi-guest-lifecycle-evidence";
const INSPECTION_KIND = "myspeed-windows-msi-guest-lifecycle-inspection";
const SCENARIO_COUNT = 14;
const MAX_JSON_BYTES = 1_048_576;
const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const RUN_ID = /^[1-9][0-9]{0,19}$/u;
const RUN_ATTEMPT = /^[1-9][0-9]{0,9}$/u;

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, expected, label) => {
    if (!isObject(value)) throw new Error(`${label} must be an object`);
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
        throw new Error(`${label} keys differ`);
    return value;
};
const exactString = (value, label, pattern) => {
    if (typeof value !== "string") throw new Error(`${label} differs`);
    const match = pattern.exec(value);
    if (!match || match.index !== 0 || match[0].length !== value.length) throw new Error(`${label} differs`);
    return value;
};
const integer = (value, label, minimum, maximum) => {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
        throw new Error(`${label} differs`);
    return value;
};
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const rawJson = (value, label) => {
    exactKeys(value, ["bytes", "sha256", "bytesBase64"], label);
    integer(value.bytes, `${label} byte count`, 1, MAX_JSON_BYTES);
    exactString(value.sha256, `${label} SHA-256`, SHA256);
    const expectedBase64Characters = 4 * Math.ceil(value.bytes / 3);
    if (typeof value.bytesBase64 !== "string" || value.bytesBase64.length !== expectedBase64Characters)
        throw new Error(`${label} base64 differs`);
    const bytes = Buffer.from(value.bytesBase64, "base64");
    if (bytes.toString("base64") !== value.bytesBase64 || bytes.length !== value.bytes
        || sha256(bytes) !== value.sha256) throw new Error(`${label} identity differs`);
    let parsed;
    try { parsed = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes)); }
    catch { throw new Error(`${label} JSON differs`); }
    if (!bytes.equals(Buffer.from(JSON.stringify(parsed), "utf8"))) throw new Error(`${label} is not canonical JSON`);
    return {bytes, parsed};
};

const validateExpected = value => {
    exactKeys(value, ["sourceSha", "eventSha", "runId", "runAttempt", "candidateManifestSha256",
        "closureSha256", "fixtureManifestSha256", "rollbackCalibrationSha256", "oldContainmentSha256",
        "baseImageSha256", "probeArtifact"], "MSI guest lifecycle expectation");
    exactString(value.sourceSha, "MSI guest lifecycle source SHA", COMMIT_SHA);
    exactString(value.eventSha, "MSI guest lifecycle event SHA", COMMIT_SHA);
    exactString(value.runId, "MSI guest lifecycle run ID", RUN_ID);
    exactString(value.runAttempt, "MSI guest lifecycle run attempt", RUN_ATTEMPT);
    for (const name of ["candidateManifestSha256", "closureSha256", "fixtureManifestSha256",
        "rollbackCalibrationSha256", "oldContainmentSha256", "baseImageSha256"])
        exactString(value[name], `MSI guest lifecycle ${name}`, SHA256);
    if (!isObject(value.probeArtifact)) throw new Error("MSI guest lifecycle probe artifact differs");
    return value;
};

export const validateCompletedWindowsMsiGuestMatrixEvidence = (value, expectedValue) => {
    const expected = validateExpected(expectedValue);
    exactKeys(value, ["schemaVersion", "kind", "status", "qualifying", "sourceSha", "eventSha", "runId",
        "runAttempt", "candidateManifestSha256", "closureSha256", "fixtureManifestSha256",
        "rollbackCalibrationSha256", "oldContainmentSha256", "baseImageSha256", "probeArtifact",
        "rows", "releaseGatesCleared"], "MSI guest lifecycle evidence");
    integer(value.schemaVersion, "MSI guest lifecycle schema", SCHEMA_VERSION, SCHEMA_VERSION);
    if (value.kind !== EVIDENCE_KIND || value.status !== "completed" || value.qualifying !== false)
        throw new Error("MSI guest lifecycle evidence did not complete");
    for (const name of ["sourceSha", "eventSha", "runId", "runAttempt", "candidateManifestSha256",
        "closureSha256", "fixtureManifestSha256", "rollbackCalibrationSha256", "oldContainmentSha256",
        "baseImageSha256"])
        if (value[name] !== expected[name]) throw new Error(`MSI guest lifecycle binding differs: ${name}`);
    if (JSON.stringify(value.probeArtifact) !== JSON.stringify(expected.probeArtifact))
        throw new Error("MSI guest lifecycle probe artifact differs");
    if (!Array.isArray(value.rows) || value.rows.length !== SCENARIO_COUNT)
        throw new Error("MSI guest lifecycle row count differs");
    if (!Array.isArray(value.releaseGatesCleared) || value.releaseGatesCleared.length !== 0)
        throw new Error("MSI guest lifecycle evidence cleared a gate");
    const nonces = new Set();
    const overlays = new Set();
    const launches = new Set();
    let retainedMatrix = null;
    value.rows.forEach((row, scenarioIndex) => {
        exactKeys(row, ["scenarioIndex", "scenarioId", "rowRequest", "executionManifest", "semanticResult"],
            "MSI guest lifecycle row");
        integer(row.scenarioIndex, "MSI guest lifecycle row index", scenarioIndex, scenarioIndex);
        const requestRaw = rawJson(row.rowRequest, "MSI guest lifecycle row request");
        const executionRaw = rawJson(row.executionManifest, "MSI guest lifecycle execution manifest");
        const semanticRaw = rawJson(row.semanticResult, "MSI guest lifecycle semantic result");
        const request = validateWindowsMsiGuestMatrixRowRequest(requestRaw.parsed);
        const execution = validateWindowsMsiGuestExecutionManifest(executionRaw.parsed);
        const semantic = validateWindowsMsiGuestMatrixSemanticResult(semanticRaw.parsed, request, execution);
        const scenario = request.matrix.scenarios[scenarioIndex];
        if (request.scenarioIndex !== scenarioIndex || row.scenarioId !== scenario.id
            || semantic.scenarioIndex !== scenarioIndex || semantic.scenarioId !== scenario.id
            || semantic.status !== "completed" || semantic.matrixPassed !== true
            || semantic.rowResult.rowPassed !== true)
            throw new Error("MSI guest lifecycle row did not pass");
        for (const name of ["sourceSha", "eventSha", "runId", "runAttempt"])
            if (request[name] !== expected[name]) throw new Error(`MSI guest lifecycle row binding differs: ${name}`);
        if (request.prerequisites.candidateManifestSha256 !== expected.candidateManifestSha256
            || request.prerequisites.closureSha256 !== expected.closureSha256
            || request.prerequisites.fixtureManifestSha256 !== expected.fixtureManifestSha256
            || request.prerequisites.rollbackCalibrationSha256 !== expected.rollbackCalibrationSha256
            || request.prerequisites.oldContainmentSha256 !== expected.oldContainmentSha256
            || execution.fixture.manifestSha256 !== expected.fixtureManifestSha256
            || request.guest.baseImageSha256 !== expected.baseImageSha256
            || JSON.stringify(execution.probeArtifact) !== JSON.stringify(expected.probeArtifact))
            throw new Error("MSI guest lifecycle row prerequisite differs");
        if (retainedMatrix === null) retainedMatrix = JSON.stringify(request.matrix);
        else if (JSON.stringify(request.matrix) !== retainedMatrix) throw new Error("MSI guest lifecycle matrix differs");
        for (const [set, identity, label] of [[nonces, request.nonce, "nonce"],
            [overlays, request.guest.overlayNonce, "overlay"], [launches, request.guest.qemuLaunchSha256, "launch"]]) {
            if (set.has(identity)) throw new Error(`MSI guest lifecycle ${label} is reused`);
            set.add(identity);
        }
    });
    return value;
};

export const inspectCompletedWindowsMsiGuestMatrixEvidence = (value, expected) => {
    const checked = validateCompletedWindowsMsiGuestMatrixEvidence(value, expected);
    return {schemaVersion: SCHEMA_VERSION, kind: INSPECTION_KIND, status: "accepted", qualifying: false,
        sourceSha: checked.sourceSha, eventSha: checked.eventSha, runId: checked.runId,
        runAttempt: checked.runAttempt, candidateManifestSha256: checked.candidateManifestSha256,
        closureSha256: checked.closureSha256, fixtureManifestSha256: checked.fixtureManifestSha256,
        rollbackCalibrationSha256: checked.rollbackCalibrationSha256,
        oldContainmentSha256: checked.oldContainmentSha256, baseImageSha256: checked.baseImageSha256,
        rows: checked.rows.map(row => ({scenarioIndex: row.scenarioIndex, scenarioId: row.scenarioId,
            rowRequestSha256: row.rowRequest.sha256, executionManifestSha256: row.executionManifest.sha256,
            semanticResultSha256: row.semanticResult.sha256})), releaseGatesCleared: []};
};
