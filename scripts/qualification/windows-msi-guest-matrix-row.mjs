import {createWindowsMsiMatrixContract, validateWindowsMsiMatrixContract} from "./windows-msi-matrix-contract.mjs";
import {createHash} from "node:crypto";
import path from "node:path";

const SCHEMA_VERSION = 1;
const REQUEST_KIND = "myspeed-windows-msi-guest-matrix-row-request";
const RESULT_KIND = "myspeed-windows-msi-guest-matrix-row-result";
const MODERN_PROFILE = "modern-msi-v1";
const QEMU_CPU_MODEL = "host";
const SCENARIO_COUNT = 14;
const MAX_SCENARIO_INDEX = SCENARIO_COUNT - 1;
const MAX_EVIDENCE_BYTES = 1_048_576;
const UINT32_MAX = 0xffff_ffff;
const CPUID_HEX = /^[0-9a-f]{8}$/u;
const XCR0_HEX = /^[0-9a-f]{16}$/u;
const CPUID_REGISTER = /^0x[0-9a-f]{8}$/u;
const CPUID_XCR0 = /^0x[0-9a-f]{16}$/u;
const MODERN_CPU_REQUIREMENT_KEYS = ["sse42", "popcnt", "osxsave", "avx", "avx2",
    "xcr0RequiredMask"];
const OPERATION_HANDLERS = Object.freeze({
    "install-candidate": "msi", "seed-data": "fixture", "run-oracle": "oracle",
    "restart-service-and-run-oracle": "oracle", cleanup: "cleanup", "install-source": "msi",
    "install-target": "msi", "verify-sole-related-product": "state", "install-fixture": "msi",
    "verify-higher-stamp": "state", "install-lower-stamp-fixture": "msi",
    "record-product-file-service-and-data-state": "state", "stop-service": "service",
    "damage-owned-executable": "fixture", "force-repair-executable": "msi",
    "damage-owned-configuration": "fixture", "repair-configuration": "msi",
    "install-predecessor": "rollback", "inject-post-removal-failure": "rollback",
    "verify-rollback": "rollback", "restart-and-run-oracle": "oracle", "uninstall-source": "msi",
    "verify-product-service-and-program-files-removed": "state",
    "run-oracle-with-preserved-data": "oracle", "install-contained-predecessor": "containment",
    "remove-containment": "containment", "run-candidate-oracle": "oracle",
    "seed-legacy-data": "fixture", "verify-one-time-migration": "state",
    "seed-legacy-and-destination-sentinels": "fixture", "verify-destination-not-overwritten": "state"
});

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, expected, label) => {
    if (!isObject(value)) throw new Error(`${label} must be an object`);
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
        throw new Error(`${label} keys differ`);
    return value;
};
const string = (value, label, pattern = /^.{1,1024}$/u) => {
    if (typeof value !== "string") throw new Error(`${label} differs`);
    const match = pattern.exec(value);
    if (!match || match.index !== 0 || match[0].length !== value.length) throw new Error(`${label} differs`);
    return value;
};
const exact = (value, expected, label) => {
    if (string(value, label) !== expected) throw new Error(`${label} differs`);
    return value;
};
const integer = (value, label, minimum, maximum) => {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
        throw new Error(`${label} differs`);
    return value;
};
const bool = (value, label) => {
    if (typeof value !== "boolean") throw new Error(`${label} differs`);
    return value;
};
const hash = (value, label, length = 64) => string(value, label,
    new RegExp(`^[0-9a-f]{${length}}$`, "u"));
const sha256 = value => createHash("sha256").update(value).digest("hex");
const windowsPath = (value, label) => {
    const item = string(value, label, /^[A-Za-z]:\\[^\x00-\x1f\x7f*?]*$/u);
    if (path.win32.normalize(item) !== item || item.slice(2).includes(":"))
        throw new Error(`${label} differs`);
    return item;
};
const descendant = (root, value, label) => {
    const item = windowsPath(value, label);
    const relative = path.win32.relative(root, item);
    if (relative === "" || relative === ".." || relative.startsWith(`..${path.win32.sep}`)
        || path.win32.isAbsolute(relative)) throw new Error(`${label} escapes its root`);
    return item;
};

const assertModernCpu = value => {
    const dynamicCpu = Object.hasOwn(value, "cpuRequirements");
    exactKeys(value, ["profile", "serial", "qemuCpuModel", "evidenceRoot", "baseImageSha256",
        "overlayNonce", "overlayReceiptSha256", "qemuLaunchSha256", "cpuEvidenceSha256", "cpuid",
        "cpuProbe"].filter(name => !dynamicCpu || !["cpuid", "cpuProbe"].includes(name))
        .concat(dynamicCpu ? ["cpuRequirements"] : []), "MSI guest");
    exact(value.profile, MODERN_PROFILE, "MSI guest profile");
    hash(value.serial, "MSI guest serial", 32);
    exact(value.qemuCpuModel, QEMU_CPU_MODEL, "MSI guest QEMU CPU model");
    windowsPath(value.evidenceRoot, "MSI guest evidence root");
    hash(value.baseImageSha256, "MSI guest base image SHA-256");
    hash(value.overlayNonce, "MSI guest overlay nonce", 32);
    hash(value.overlayReceiptSha256, "MSI guest overlay receipt SHA-256");
    hash(value.qemuLaunchSha256, "MSI guest QEMU launch SHA-256");
    hash(value.cpuEvidenceSha256, "MSI guest CPU evidence SHA-256");
    if (dynamicCpu) {
        exactKeys(value.cpuRequirements, MODERN_CPU_REQUIREMENT_KEYS, "MSI guest CPU requirements");
        if (value.cpuRequirements.xcr0RequiredMask !== "0000000000000006"
            || ["sse42", "popcnt", "osxsave", "avx", "avx2"].some(name =>
                value.cpuRequirements[name] !== true)
            || value.cpuEvidenceSha256 !== sha256(Buffer.from(JSON.stringify(value.cpuRequirements))))
            throw new Error("MSI guest CPU requirements differ");
        return;
    }
    exactKeys(value.cpuid, ["vendor", "leaf1EcxHex", "leaf7EbxHex", "xcr0Hex", "sse42", "popcnt",
        "osxsave", "avx", "avx2"], "MSI guest CPUID");
    string(value.cpuid.vendor, "MSI guest CPU vendor", /^[ -~]{1,16}$/u);
    string(value.cpuid.leaf1EcxHex, "MSI guest CPUID leaf 1", CPUID_HEX);
    string(value.cpuid.leaf7EbxHex, "MSI guest CPUID leaf 7", CPUID_HEX);
    string(value.cpuid.xcr0Hex, "MSI guest XCR0", XCR0_HEX);
    for (const name of ["sse42", "popcnt", "osxsave", "avx", "avx2"])
        if (!bool(value.cpuid[name], `MSI guest ${name}`)) throw new Error("MSI guest modern CPU evidence failed");
    const leaf1Ecx = BigInt(`0x${value.cpuid.leaf1EcxHex}`);
    const leaf7Ebx = BigInt(`0x${value.cpuid.leaf7EbxHex}`);
    const bit = (word, index) => (word & (1n << BigInt(index))) !== 0n;
    if (value.cpuid.sse42 !== bit(leaf1Ecx, 20) || value.cpuid.popcnt !== bit(leaf1Ecx, 23)
        || value.cpuid.osxsave !== bit(leaf1Ecx, 27) || value.cpuid.avx !== bit(leaf1Ecx, 28)
        || value.cpuid.avx2 !== bit(leaf7Ebx, 5)) throw new Error("MSI guest CPUID flags differ");
    const xcr0 = BigInt(`0x${value.cpuid.xcr0Hex}`);
    const requiredXcr0Mask = 0x6n;
    if ((xcr0 & requiredXcr0Mask) !== requiredXcr0Mask) throw new Error("MSI guest XCR0 differs");
    exactKeys(value.cpuProbe, ["bytesBase64", "sha256", "record"], "MSI guest raw CPUID proof");
    hash(value.cpuProbe.sha256, "MSI guest raw CPUID SHA-256");
    if (typeof value.cpuProbe.bytesBase64 !== "string") throw new Error("MSI guest raw CPUID bytes differ");
    const rawBytes = Buffer.from(value.cpuProbe.bytesBase64, "base64");
    if (rawBytes.toString("base64") !== value.cpuProbe.bytesBase64 || rawBytes.length < 1
        || rawBytes.length > MAX_EVIDENCE_BYTES || sha256(rawBytes) !== value.cpuProbe.sha256
        || value.cpuEvidenceSha256 !== value.cpuProbe.sha256) throw new Error("MSI guest raw CPUID bytes differ");
    exactKeys(value.cpuProbe.record, ["schemaVersion", "kind", "maxBasicLeaf", "leaf1", "leaf7Subleaf0",
        "xcr0", "features"], "MSI guest raw CPUID record");
    integer(value.cpuProbe.record.schemaVersion, "MSI guest raw CPUID schema", 1, 1);
    exact(value.cpuProbe.record.kind, "cpuid", "MSI guest raw CPUID kind");
    integer(value.cpuProbe.record.maxBasicLeaf, "MSI guest raw CPUID maximum leaf", 7, UINT32_MAX);
    for (const name of ["leaf1", "leaf7Subleaf0"]) {
        exactKeys(value.cpuProbe.record[name], ["eax", "ebx", "ecx", "edx"], `MSI guest raw CPUID ${name}`);
        for (const register of Object.values(value.cpuProbe.record[name]))
            string(register, `MSI guest raw CPUID ${name} register`, CPUID_REGISTER);
    }
    string(value.cpuProbe.record.xcr0, "MSI guest raw CPUID XCR0", CPUID_XCR0);
    exactKeys(value.cpuProbe.record.features, ["sse42", "popcnt", "osxsave", "avx", "avx2"],
        "MSI guest raw CPUID features");
    for (const name of ["sse42", "popcnt", "osxsave", "avx", "avx2"])
        if (value.cpuProbe.record.features[name] !== value.cpuid[name])
            throw new Error("MSI guest raw CPUID feature differs");
    if (value.cpuProbe.record.leaf1.ecx.slice(2) !== value.cpuid.leaf1EcxHex
        || value.cpuProbe.record.leaf7Subleaf0.ebx.slice(2) !== value.cpuid.leaf7EbxHex
        || value.cpuProbe.record.xcr0.slice(2) !== value.cpuid.xcr0Hex)
        throw new Error("MSI guest raw CPUID register differs");
    let parsed; let rawText;
    try { rawText = new TextDecoder("utf-8", {fatal: true}).decode(rawBytes); parsed = JSON.parse(rawText); } catch {
        throw new Error("MSI guest raw CPUID JSON differs");
    }
    const canonicalRecord = JSON.stringify(value.cpuProbe.record);
    if (JSON.stringify(parsed) !== canonicalRecord
        || (rawText !== `${canonicalRecord}\n` && rawText !== `${canonicalRecord}\r\n`))
        throw new Error("MSI guest raw CPUID record binding differs");
};

export const validateWindowsMsiModernCpuObservation = (value, requirements) => {
    exactKeys(value, ["bytesBase64", "sha256", "record"], "MSI guest observed CPUID");
    exactKeys(requirements, MODERN_CPU_REQUIREMENT_KEYS, "MSI guest CPU requirements");
    hash(value.sha256, "MSI guest observed CPUID SHA-256");
    if (typeof value.bytesBase64 !== "string") throw new Error("MSI guest observed CPUID bytes differ");
    const bytes = Buffer.from(value.bytesBase64, "base64");
    const text = new TextDecoder("utf-8", {fatal: true}).decode(bytes);
    const record = JSON.parse(text);
    if (bytes.toString("base64") !== value.bytesBase64 || sha256(bytes) !== value.sha256
        || JSON.stringify(record) !== JSON.stringify(value.record)
        || (text !== `${JSON.stringify(record)}\n` && text !== `${JSON.stringify(record)}\r\n`))
        throw new Error("MSI guest observed CPUID identity differs");
    exactKeys(record, ["schemaVersion", "kind", "maxBasicLeaf", "leaf1", "leaf7Subleaf0", "xcr0", "features"],
        "MSI guest observed CPUID record");
    exactKeys(record.features, ["sse42", "popcnt", "osxsave", "avx", "avx2"],
        "MSI guest observed CPUID features");
    for (const name of ["leaf1", "leaf7Subleaf0"]) {
        exactKeys(record[name], ["eax", "ebx", "ecx", "edx"], `MSI guest observed CPUID ${name}`);
        for (const register of Object.values(record[name])) string(register, "MSI guest CPUID register", CPUID_REGISTER);
    }
    const leaf1 = BigInt(record.leaf1.ecx);
    const leaf7 = BigInt(record.leaf7Subleaf0.ebx);
    const bit = (word, index) => (word & (1n << BigInt(index))) !== 0n;
    if (record.schemaVersion !== 1 || record.kind !== "cpuid" || !Number.isSafeInteger(record.maxBasicLeaf)
        || record.maxBasicLeaf < 7
        || record.xcr0?.match(CPUID_XCR0)?.[0] !== record.xcr0
        || record.features == null || ["sse42", "popcnt", "osxsave", "avx", "avx2"].some(name =>
            record.features[name] !== requirements[name])
        || record.features.sse42 !== bit(leaf1, 20) || record.features.popcnt !== bit(leaf1, 23)
        || record.features.osxsave !== bit(leaf1, 27) || record.features.avx !== bit(leaf1, 28)
        || record.features.avx2 !== bit(leaf7, 5)
        || (BigInt(record.xcr0) & BigInt(`0x${requirements.xcr0RequiredMask}`))
            !== BigInt(`0x${requirements.xcr0RequiredMask}`))
        throw new Error("MSI guest observed CPUID does not meet requirements");
    return value;
};

export const validateWindowsMsiGuestMatrixRowRequest = value => {
    exactKeys(value, ["schemaVersion", "kind", "qualifying", "sourceSha", "eventSha", "runId",
        "runAttempt", "nonce", "scenarioIndex", "matrix", "guest", "prerequisites"],
    "MSI guest row request");
    integer(value.schemaVersion, "MSI guest row schema", SCHEMA_VERSION, 2);
    exact(value.kind, REQUEST_KIND, "MSI guest row kind");
    if (bool(value.qualifying, "MSI guest row qualifying")) throw new Error("MSI guest row is nonqualifying");
    hash(value.sourceSha, "MSI guest row source SHA", 40);
    hash(value.eventSha, "MSI guest row event SHA", 40);
    string(value.runId, "MSI guest row run ID", /^[1-9][0-9]{0,19}$/u);
    string(value.runAttempt, "MSI guest row run attempt", /^[1-9][0-9]{0,9}$/u);
    hash(value.nonce, "MSI guest row nonce", 32);
    integer(value.scenarioIndex, "MSI guest row index", 0, MAX_SCENARIO_INDEX);
    validateWindowsMsiMatrixContract(value.matrix);
    if (value.matrix.scenarios.length !== SCENARIO_COUNT) throw new Error("MSI guest matrix row count differs");
    assertModernCpu(value.guest);
    if (value.guest.serial !== value.nonce) throw new Error("MSI guest serial is not bound to row nonce");
    exactKeys(value.prerequisites, ["closureSha256", "candidateManifestSha256", "fixtureManifestSha256",
        "rollbackCalibrationSha256", "oldContainmentSha256"], "MSI guest prerequisites");
    for (const [name, digest] of Object.entries(value.prerequisites))
        hash(digest, `MSI guest prerequisite ${name}`);
    return value;
};

const assertOperations = operations => {
    exactKeys(operations, ["assertGuestBoundary", "inspectFreshScenario", "executeOperation",
        "cleanupScenario"], "MSI guest row operations");
    for (const [name, operation] of Object.entries(operations))
        if (typeof operation !== "function") throw new Error(`MSI guest row operation ${name} is absent`);
};

const receipt = (value, stage, keys) => {
    exactKeys(value, ["stage", "passed", ...keys], `${stage} receipt`);
    exact(value.stage, stage, `${stage} receipt stage`);
    if (!bool(value.passed, `${stage} receipt passed`)) throw new Error(`${stage} failed`);
    return value;
};

const assertBoundary = (value, request) => {
    receipt(value, "guest-boundary", ["cpuEvidenceSha256", "qemuLaunchSha256", "networkAdapters",
        "serial", "manufacturer", "observationCommand", "cpuProbeCommand",
        ...(request.schemaVersion === 2 ? ["cpuObservation"] : [])]);
    exact(value.cpuEvidenceSha256, request.guest.cpuEvidenceSha256, "MSI guest boundary CPU evidence");
    exact(value.qemuLaunchSha256, request.guest.qemuLaunchSha256, "MSI guest boundary QEMU launch");
    integer(value.networkAdapters, "MSI guest boundary adapters", 0, 0);
    exact(value.serial, request.guest.serial, "MSI guest boundary serial");
    string(value.manufacturer, "MSI guest boundary manufacturer", /^QEMU(?: |$).{0,1019}$/u);
    if (!isObject(value.observationCommand)) throw new Error("MSI guest boundary observation is absent");
    if (!isObject(value.cpuProbeCommand)) throw new Error("MSI guest CPU probe command is absent");
    if (request.schemaVersion === 2) {
        validateWindowsMsiModernCpuObservation(value.cpuObservation, request.guest.cpuRequirements);
        exact(value.cpuObservation.sha256, value.cpuProbeCommand.stdoutSha256,
            "MSI guest observed CPU command SHA-256");
    }
};

const assertFresh = value => {
    receipt(value, "fresh-scenario", ["products", "services", "listeners", "ownedPaths", "state"]);
    for (const name of ["products", "services", "listeners", "ownedPaths"])
        integer(value[name], `MSI guest fresh ${name}`, 0, 0);
    if (!isObject(value.state)) throw new Error("MSI guest fresh state is absent");
};

const assertOperation = (value, request, scenario, operation, operationIndex) => {
    receipt(value, "matrix-operation", ["scenarioId", "operation", "operationIndex", "actualHandler",
        "evidence", "stateProofSha256"]);
    exact(value.scenarioId, scenario.id, "MSI guest operation scenario");
    exact(value.operation, operation, "MSI guest operation name");
    integer(value.operationIndex, "MSI guest operation index", operationIndex, operationIndex);
    exact(value.actualHandler, `actual-${operation}`, "MSI guest operation handler");
    exactKeys(value.evidence, ["path", "bytes", "sha256"], "MSI guest operation evidence");
    descendant(request.guest.evidenceRoot, value.evidence.path, "MSI guest operation evidence path");
    integer(value.evidence.bytes, "MSI guest operation evidence bytes", 1, MAX_EVIDENCE_BYTES);
    const evidenceSha = hash(value.evidence.sha256, "MSI guest operation evidence SHA-256");
    if (hash(value.stateProofSha256, "MSI guest operation state proof") !== evidenceSha)
        throw new Error("MSI guest operation state proof differs");
    if (!Object.hasOwn(OPERATION_HANDLERS, operation)) throw new Error("MSI guest operation is unresolved");
    return value;
};

const assertCleanup = value => {
    receipt(value, "scenario-cleanup", ["products", "services", "listeners", "ownedPaths",
        "qemuPoweroffRequired", "containmentCleanup", "uninstallCommands", "ownedRemoval", "state"]);
    for (const name of ["products", "services", "listeners", "ownedPaths"])
        integer(value[name], `MSI guest cleanup ${name}`, 0, 0);
    if (!bool(value.qemuPoweroffRequired, "MSI guest QEMU poweroff"))
        throw new Error("MSI guest QEMU poweroff is required");
    if (value.containmentCleanup !== null && !isObject(value.containmentCleanup))
        throw new Error("MSI guest containment cleanup differs");
    if (!Array.isArray(value.uninstallCommands) || !isObject(value.ownedRemoval) || !isObject(value.state))
        throw new Error("MSI guest cleanup evidence differs");
};

const failure = stage => ({stage, classification: "failed"});

export const runWindowsMsiGuestMatrixRow = async (input, operations) => {
    const request = validateWindowsMsiGuestMatrixRowRequest(input);
    assertOperations(operations);
    const scenario = request.matrix.scenarios[request.scenarioIndex];
    const operationProofs = [];
    const failures = [];
    let boundaryPassed = false;
    let freshPassed = false;
    let mutationAttempted = false;
    let boundaryReceipt = null;
    let freshReceipt = null;
    let cleanupReceipt = null;
    try {
        const boundary = await operations.assertGuestBoundary({request, scenario});
        assertBoundary(boundary, request); boundaryReceipt = boundary;
        boundaryPassed = true;
        const fresh = await operations.inspectFreshScenario({request, scenario});
        assertFresh(fresh); freshReceipt = fresh;
        freshPassed = true;
        for (const [operationIndex, operation] of scenario.operations.entries()) {
            mutationAttempted = true;
            try {
                operationProofs.push(assertOperation(await operations.executeOperation({request, scenario,
                    operation, operationIndex}), request, scenario, operation, operationIndex));
            } catch {
                failures.push(failure(`operation:${operation}`));
                break;
            }
        }
    } catch {
        failures.push(failure(boundaryPassed ? "fresh-scenario" : "guest-boundary"));
    } finally {
        if (boundaryPassed && freshPassed && mutationAttempted) {
            try {
                const cleanup = await operations.cleanupScenario({request, scenario, mutationAttempted});
                assertCleanup(cleanup); cleanupReceipt = cleanup;
            } catch {
                failures.push(failure("cleanup"));
            }
        }
    }
    const passed = failures.length === 0 && operationProofs.length === scenario.operations.length;
    return {schemaVersion: SCHEMA_VERSION, kind: RESULT_KIND, status: passed ? "completed" : "failed",
        qualifying: false, rowPassed: passed, sourceSha: request.sourceSha, eventSha: request.eventSha,
        runId: request.runId, runAttempt: request.runAttempt, nonce: request.nonce,
        cpuProfile: request.guest.profile, baseImageSha256: request.guest.baseImageSha256,
        overlayNonce: request.guest.overlayNonce, overlayReceiptSha256: request.guest.overlayReceiptSha256,
        cpuEvidenceSha256: request.guest.cpuEvidenceSha256,
        qemuLaunchSha256: request.guest.qemuLaunchSha256, scenarioIndex: request.scenarioIndex,
        scenarioId: scenario.id, blocking: scenario.blocking, operations: scenario.operations,
        boundaryReceipt, freshReceipt, cleanupReceipt, operationProofs, failures, releaseGatesCleared: []};
};

export const validateWindowsMsiGuestMatrixRowResult = (value, input) => {
    const request = validateWindowsMsiGuestMatrixRowRequest(input);
    const scenario = request.matrix.scenarios[request.scenarioIndex];
    exactKeys(value, ["schemaVersion", "kind", "status", "qualifying", "rowPassed", "sourceSha",
        "eventSha", "runId", "runAttempt", "nonce", "cpuProfile", "baseImageSha256", "overlayNonce",
        "overlayReceiptSha256", "cpuEvidenceSha256",
        "qemuLaunchSha256", "scenarioIndex", "scenarioId", "blocking", "operations", "operationProofs",
        "boundaryReceipt", "freshReceipt", "cleanupReceipt", "failures", "releaseGatesCleared"],
    "MSI guest row result");
    integer(value.schemaVersion, "MSI guest result schema", SCHEMA_VERSION, SCHEMA_VERSION);
    exact(value.kind, RESULT_KIND, "MSI guest result kind");
    if (bool(value.qualifying, "MSI guest result qualifying")) throw new Error("MSI guest result is qualifying");
    const passed = bool(value.rowPassed, "MSI guest result pass");
    exact(value.status, passed ? "completed" : "failed", "MSI guest result status");
    for (const [name, expected] of Object.entries({sourceSha: request.sourceSha, eventSha: request.eventSha,
        runId: request.runId, runAttempt: request.runAttempt, nonce: request.nonce,
        cpuProfile: request.guest.profile, baseImageSha256: request.guest.baseImageSha256,
        overlayNonce: request.guest.overlayNonce, overlayReceiptSha256: request.guest.overlayReceiptSha256,
        cpuEvidenceSha256: request.guest.cpuEvidenceSha256,
        qemuLaunchSha256: request.guest.qemuLaunchSha256, scenarioId: scenario.id}))
        exact(value[name], expected, `MSI guest result ${name}`);
    integer(value.scenarioIndex, "MSI guest result scenario index", request.scenarioIndex, request.scenarioIndex);
    if (bool(value.blocking, "MSI guest result blocking") !== scenario.blocking)
        throw new Error("MSI guest result blocking differs");
    if (!Array.isArray(value.operations) || value.operations.length !== scenario.operations.length ||
        value.operations.some((operation, index) => operation !== scenario.operations[index]))
        throw new Error("MSI guest result operations differ");
    if (!Array.isArray(value.operationProofs) || value.operationProofs.length > scenario.operations.length)
        throw new Error("MSI guest operation proofs differ");
    if (value.boundaryReceipt !== null) assertBoundary(value.boundaryReceipt, request);
    if (value.freshReceipt !== null) assertFresh(value.freshReceipt);
    if (value.cleanupReceipt !== null) assertCleanup(value.cleanupReceipt);
    value.operationProofs.forEach((proof, index) => assertOperation(proof, request, scenario,
        scenario.operations[index], index));
    if (!Array.isArray(value.failures) || value.failures.some(entry => {
        try {
            exactKeys(entry, ["stage", "classification"], "MSI guest failure");
            string(entry.stage, "MSI guest failure stage", /^(?:guest-boundary|fresh-scenario|cleanup|operation:[a-z0-9-]+)$/u);
            return entry.classification !== "failed";
        } catch { return true; }
    })) throw new Error("MSI guest failures differ");
    if (passed && (value.operationProofs.length !== scenario.operations.length || value.failures.length !== 0
        || value.boundaryReceipt === null || value.freshReceipt === null || value.cleanupReceipt === null))
        throw new Error("MSI guest passing result is incomplete");
    if (!passed && value.failures.length === 0) throw new Error("MSI guest failure is absent");
    if (!Array.isArray(value.releaseGatesCleared) || value.releaseGatesCleared.length !== 0)
        throw new Error("MSI guest result clears a gate");
    return value;
};

export const WINDOWS_MSI_GUEST_OPERATION_HANDLERS = OPERATION_HANDLERS;
