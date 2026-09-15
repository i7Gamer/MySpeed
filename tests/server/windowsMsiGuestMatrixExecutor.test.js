import {createHash} from "node:crypto";
import {describe, it} from "node:test";
import assert from "node:assert/strict";

import {createWindowsMsiMatrixContract} from "../../scripts/qualification/windows-msi-matrix-contract.mjs";
import {createWindowsMsiGuestBoundaryArguments, createWindowsMsiGuestSnapshotArguments,
    WINDOWS_MSI_GUEST_PRODUCT_BINDINGS} from "../../scripts/qualification/windows-msi-guest-matrix-operations.mjs";
import {executeWindowsMsiGuestMatrixEnvelope,
    validateWindowsMsiGuestMatrixEnvelope,
    validateWindowsMsiGuestMatrixSemanticResult} from "../../scripts/qualification/windows-msi-guest-matrix-executor.mjs";

const HASH = "a".repeat(64);
const SOURCE_SHA = "1".repeat(40);
const EVENT_SHA = "2".repeat(40);
const NONCE = "3".repeat(32);
const SEED_ROOT = "D:\\seed";
const OUTPUT_ROOT = "E:\\output";
const PROBE_ROLES = Object.freeze(["avx", "avx2", "cpuid", "illegal", "known-bad", "known-good",
    "popcnt", "sse42"]);
const sha256 = value => createHash("sha256").update(value).digest("hex");
const bytes = value => Buffer.from(JSON.stringify(value), "utf8");
const rawCpuid = () => ({schemaVersion: 1, kind: "cpuid", maxBasicLeaf: 7,
    leaf1: {eax: "0x00000000", ebx: "0x00000000", ecx: "0x18900000", edx: "0x00000000"},
    leaf7Subleaf0: {eax: "0x00000000", ebx: "0x00000120", ecx: "0x00000000", edx: "0x00000000"},
    xcr0: "0x0000000000000007", features: {sse42: true, popcnt: true, osxsave: true, avx: true, avx2: true}});
const cpuProbe = () => { const record = rawCpuid(); const raw = Buffer.from(`${JSON.stringify(record)}\r\n`, "utf8"); return {
    bytesBase64: raw.toString("base64"), sha256: sha256(raw), record}; };
const populatedFiles = () => ({".myspeed-qualification.json": "4".repeat(64),
    "bin/speedtest.exe": "5".repeat(64), "data/storage.db": "6".repeat(64)});
const probeArtifact = () => ({schemaVersion: 1, repository: "i7Gamer/MySpeed", sourceSha: SOURCE_SHA,
    runId: "123", runAttempt: "1", artifactId: "456", artifactName: "windows-cpu-readiness-evidence",
    archive: {bytes: "33554432", sha256: "6".repeat(64)},
    innerManifest: {name: "result.json", bytes: "262144", sha256: "7".repeat(64)},
    files: PROBE_ROLES.map((role, index) => ({role, name: `${role.replaceAll("-", "_")}.exe`,
        bytes: `${4096 + index}`, sha256: `${index + 1}`.repeat(64).slice(0, 64)}))});
const command = (execution, toolName, arguments_, exitCode = 0) => ({toolPath: execution.tools[toolName].path,
    toolSha256: execution.tools[toolName].sha256, arguments: arguments_, workingDirectory: execution.outputRoot,
    exitCode, stdoutBytes: 0, stdoutSha256: sha256(Buffer.alloc(0)), stderrBytes: 0,
    stderrSha256: sha256(Buffer.alloc(0))});
const productCode = index => `{00000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}}`;

const rowRequest = () => ({schemaVersion: 1, kind: "myspeed-windows-msi-guest-matrix-row-request",
    qualifying: false, sourceSha: SOURCE_SHA, eventSha: EVENT_SHA, runId: "123", runAttempt: "1",
    nonce: NONCE, scenarioIndex: 0, matrix: createWindowsMsiMatrixContract(), guest: {
        profile: "modern-msi-v1", serial: NONCE, qemuCpuModel: "host", evidenceRoot: OUTPUT_ROOT,
        baseImageSha256: "b".repeat(64), overlayNonce: "c".repeat(32), overlayReceiptSha256: "d".repeat(64),
        qemuLaunchSha256: "e".repeat(64), cpuEvidenceSha256: cpuProbe().sha256, cpuid: {
            vendor: "GenuineIntel", leaf1EcxHex: "18900000", leaf7EbxHex: "00000120",
            xcr0Hex: "0000000000000007", sse42: true, popcnt: true, osxsave: true, avx: true, avx2: true},
        cpuProbe: cpuProbe()},
    prerequisites: {closureSha256: HASH, candidateManifestSha256: HASH, fixtureManifestSha256: HASH,
        rollbackCalibrationSha256: HASH, oldContainmentSha256: HASH}});

const executionManifest = () => ({seedRoot: SEED_ROOT, outputRoot: OUTPUT_ROOT,
    programFilesRoot: "C:\\Program Files", programDataRoot: "C:\\ProgramData",
    installRoot: "C:\\Program Files\\MySpeed", installedExePath: "C:\\Program Files\\MySpeed\\MySpeed.exe",
    configurationPath: "C:\\Program Files\\MySpeed\\MySpeedService.xml",
    serviceWrapperPath: "C:\\Program Files\\MySpeed\\MySpeedService.exe",
    dataRoot: "C:\\ProgramData\\MySpeed", databasePath: "C:\\ProgramData\\MySpeed\\data\\storage.db",
    legacyDataRoot: "C:\\Program Files\\MySpeed\\data", serviceName: "MySpeed",
    origin: "http://127.0.0.1:5216", probeArtifact: probeArtifact(), tools: Object.fromEntries([
        ["msiexec", "C:\\Windows\\System32\\msiexec.exe"], ["sc", "C:\\Windows\\System32\\sc.exe"],
        ["powershell", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"],
        ["node", `${SEED_ROOT}\\node.exe`], ["cpuid", `${SEED_ROOT}\\cpuid.exe`]].map(([name, toolPath]) => [name,
        name === "cpuid" ? {path: toolPath, bytes: 4098, sha256: "3".repeat(64)}
            : {path: toolPath, bytes: 10, sha256: HASH}])), helpers: Object.fromEntries([
        ["oracle", "oracle.mjs"], ["sqlite", "sqlite.mjs"], ["rollback", "rollback.ps1"],
        ["containment", "containment.ps1"]].map(([name, file]) => [name,
        {path: `${SEED_ROOT}\\${file}`, bytes: 10, sha256: HASH}])),
    artifacts: WINDOWS_MSI_GUEST_PRODUCT_BINDINGS.map((bindingId, index) => ({bindingId,
        path: `${SEED_ROOT}\\${bindingId}.msi`, bytes: 100 + index,
        sha256: String(index + 1).repeat(64).slice(0, 64), productCode: productCode(index),
        exeBytes: index < 2 || index === 3 ? 1000 + index : null,
        exeSha256: index < 2 || index === 3 ? "8".repeat(64) : null,
        configurationSha256: index < 2 ? "9".repeat(64) : null,
        serviceWrapperSha256: index < 2 ? "0".repeat(64) : null})),
    fixture: {sourceSha: SOURCE_SHA, populatedRoot: `${SEED_ROOT}\\populated`, manifestPath: `${SEED_ROOT}\\fixture.json`,
        manifestSha256: HASH, legacyRoot: `${SEED_ROOT}\\legacy`, destinationSentinelSha256: HASH,
        legacySentinelSha256: HASH, populatedMarkerSha256: "4".repeat(64),
        populatedDatabaseSha256: "6".repeat(64), populatedFilesSha256: populatedFiles(),
        expected: {ping: "123.456", resultId: "qualification-seed-row",
            passwordValueSha256: "7".repeat(64)}}, limits: {processMilliseconds: 900_000, streamBytes: 65_536,
        evidenceBytes: 1_048_576}});

const fixture = () => {
    const row = bytes(rowRequest());
    const execution = bytes(executionManifest());
    const envelope = {schemaVersion: 1, kind: "myspeed-windows-msi-guest-matrix-envelope", qualifying: false,
        sourceSha: SOURCE_SHA, eventSha: EVENT_SHA, runId: "123", runAttempt: "1", nonce: NONCE,
        seedRoot: SEED_ROOT, outputRoot: OUTPUT_ROOT,
        rowRequest: {path: `${SEED_ROOT}\\row-request.json`, bytes: row.length, sha256: sha256(row)},
        executionManifest: {path: `${SEED_ROOT}\\execution.json`, bytes: execution.length,
            sha256: sha256(execution)}, resultPath: `${OUTPUT_ROOT}\\result.json`,
        limits: {inputBytes: 1_048_576, resultBytes: 1_048_576}};
    return {envelope, files: new Map([[envelope.rowRequest.path, row],
        [envelope.executionManifest.path, execution]])};
};

const operationsFactory = evidenceFiles => {
    const execution = executionManifest();
    const observeCommand = () => command(execution, "powershell",
        createWindowsMsiGuestSnapshotArguments(execution));
    const boundaryCommand = () => command(execution, "powershell",
        createWindowsMsiGuestBoundaryArguments(NONCE));
    const cpuCommand = () => ({...command(execution, "cpuid", []),
        stdoutBytes: Buffer.from(cpuProbe().bytesBase64, "base64").length,
        stdoutSha256: cpuProbe().sha256});
    const state = running => ({products: execution.artifacts.map(item => ({bindingId: item.bindingId,
        state: item.bindingId === "candidate-default" && running ? 5 : -1})), serviceCount: running ? 1 : 0,
    serviceState: running ? "Running" : null, servicePath: running ? execution.serviceWrapperPath : null,
    serviceStartName: running ? "LocalSystem" : null, servicePid: running ? 42 : null,
    listenerCount: running ? 1 : 0, listenerPid: running ? 84 : null,
    listenerParentPid: running ? 42 : null, listenerImagePath: running ? execution.installedExePath : null,
    installRootExists: running, dataRootExists: running, observationCommand: observeCommand()});
    const msi = (action, item, logKind, exitCode = 0) => command(execution, "msiexec", [action,
        action === "/i" ? item.path : item.productCode, "/qn", "/norestart", "/L*V!",
        `${execution.outputRoot}\\${logKind}-${item.bindingId}.log`, "REBOOT=ReallySuppress"], exitCode);
    const service = action => command(execution, "sc", [action, "MySpeed"]);
    const candidate = execution.artifacts[0];
    const details = {
        "install-candidate": {command: msi("/i", candidate, "install"), state: state(true)},
        "seed-data": {stopCommand: service("stop"), startCommand: service("start"), state: state(true),
            databaseSha256: execution.fixture.populatedDatabaseSha256},
        "run-oracle": {state: state(true), oracle: {elapsedMs: 1}, database: execution.fixture.expected},
        "restart-service-and-run-oracle": {stopCommand: service("stop"), startCommand: service("start"),
            state: state(true), oracle: {elapsedMs: 1}, database: execution.fixture.expected},
        cleanup: {uninstallCommands: execution.artifacts.map(item => msi("/x", item, "uninstall")),
            ownedRemoval: {installRootRemoved: true, dataRootRemoved: true}, state: state(false)}
    };
    return {
    assertGuestBoundary: async ({request}) => ({stage: "guest-boundary", passed: true,
        cpuEvidenceSha256: request.guest.cpuEvidenceSha256,
        qemuLaunchSha256: request.guest.qemuLaunchSha256, networkAdapters: 0,
        serial: request.guest.serial, manufacturer: "QEMU",
        observationCommand: boundaryCommand(), cpuProbeCommand: cpuCommand()}),
    inspectFreshScenario: async () => ({stage: "fresh-scenario", passed: true, products: 0,
        services: 0, listeners: 0, ownedPaths: 0, state: state(false)}),
    executeOperation: async ({request, scenario, operation, operationIndex}) => {
        const target = `${OUTPUT_ROOT}\\${operationIndex}.json`;
        const content = bytes({schemaVersion: 1, kind: "myspeed-windows-msi-guest-operation-evidence",
            sourceSha: request.sourceSha, eventSha: request.eventSha, runId: request.runId,
            runAttempt: request.runAttempt, nonce: request.nonce, scenarioId: scenario.id, operation,
            operationIndex, details: details[operation]});
        evidenceFiles.set(target, content);
        const digest = sha256(content);
        return {stage: "matrix-operation", passed: true, scenarioId: scenario.id, operation,
            operationIndex, actualHandler: `actual-${operation}`,
            evidence: {path: target, bytes: content.length, sha256: digest}, stateProofSha256: digest};
    },
    cleanupScenario: async () => ({stage: "scenario-cleanup", passed: true, products: 0, services: 0,
        listeners: 0, ownedPaths: 0, qemuPoweroffRequired: true, containmentCleanup: null,
        uninstallCommands: execution.artifacts.map(item => msi("/x", item, "uninstall")),
        ownedRemoval: {installRootRemoved: true, dataRootRemoved: true}, state: state(false)})
    };
};

describe("Windows MSI modern guest matrix executor", () => {
    it("loads exact sealed inputs and writes one bound nonqualifying row result", async () => {
        const value = fixture();
        const evidenceFiles = new Map();
        let written = null;
        const completed = await executeWindowsMsiGuestMatrixEnvelope(value.envelope, {
            readBoundFile: async binding => value.files.get(binding.path),
            readEvidenceFile: async identity => evidenceFiles.get(identity.path),
            writeCreateNew: async (target, content) => { written = {target, content}; },
            operationsFactory: () => operationsFactory(evidenceFiles)
        });
        assert.equal(completed.semanticResult.matrixPassed, true);
        assert.equal(completed.semanticResult.qualifying, false);
        assert.equal(completed.semanticResult.evidence.length,
            value.envelope.rowRequest ? rowRequest().matrix.scenarios[0].operations.length : 0);
        assert.ok(completed.semanticResult.evidence.every(item => item.bytesBase64.length > 0));
        assert.equal(written.target, value.envelope.resultPath);
        assert.equal(sha256(written.content), completed.identity.sha256);
        assert.deepEqual(completed.identity, {path: value.envelope.resultPath,
            bytes: written.content.length, sha256: sha256(written.content)});
        assert.equal(validateWindowsMsiGuestMatrixSemanticResult(completed.semanticResult, rowRequest(),
            executionManifest()),
            completed.semanticResult);
        for (const mutate of [
            item => { item.evidence[0].bytesBase64 = Buffer.from("{}", "utf8").toString("base64"); },
            item => { item.evidence[0].identity.sha256 = HASH; },
            item => { item.rowResult.operationProofs[0].operation = "cleanup"; },
            item => { item.sourceSha = "4".repeat(40); },
            item => { item.releaseGatesCleared.push("release"); }
        ]) {
            const changed = structuredClone(completed.semanticResult); mutate(changed);
            assert.throws(() => validateWindowsMsiGuestMatrixSemanticResult(changed, rowRequest(),
                executionManifest()));
        }
        const semanticallyEmpty = structuredClone(completed.semanticResult);
        const decoded = JSON.parse(Buffer.from(semanticallyEmpty.evidence[0].bytesBase64, "base64"));
        decoded.details = {foo: true};
        const forgedBytes = bytes(decoded);
        const forgedSha = sha256(forgedBytes);
        semanticallyEmpty.evidence[0] = {identity: {...semanticallyEmpty.evidence[0].identity,
            bytes: forgedBytes.length, sha256: forgedSha}, bytesBase64: forgedBytes.toString("base64")};
        semanticallyEmpty.rowResult.operationProofs[0].evidence =
            semanticallyEmpty.evidence[0].identity;
        semanticallyEmpty.rowResult.operationProofs[0].stateProofSha256 = forgedSha;
        assert.throws(() => validateWindowsMsiGuestMatrixSemanticResult(semanticallyEmpty, rowRequest(),
            executionManifest()));
        const invalidOracle = structuredClone(completed.semanticResult);
        const oracleIndex = rowRequest().matrix.scenarios[0].operations.indexOf("run-oracle");
        const oracleEvidence = JSON.parse(Buffer.from(invalidOracle.evidence[oracleIndex].bytesBase64,
            "base64"));
        oracleEvidence.details.oracle = {elapsedMs: "passed"};
        const oracleBytes = bytes(oracleEvidence);
        const oracleSha = sha256(oracleBytes);
        invalidOracle.evidence[oracleIndex] = {identity: {...invalidOracle.evidence[oracleIndex].identity,
            bytes: oracleBytes.length, sha256: oracleSha}, bytesBase64: oracleBytes.toString("base64")};
        invalidOracle.rowResult.operationProofs[oracleIndex].evidence =
            invalidOracle.evidence[oracleIndex].identity;
        invalidOracle.rowResult.operationProofs[oracleIndex].stateProofSha256 = oracleSha;
        assert.throws(() => validateWindowsMsiGuestMatrixSemanticResult(invalidOracle, rowRequest(),
            executionManifest()), /oracle|elapsed/i);
        const lateOracle = structuredClone(invalidOracle);
        const lateEvidence = JSON.parse(Buffer.from(completed.semanticResult.evidence[oracleIndex].bytesBase64,
            "base64"));
        lateEvidence.details.oracle.elapsedMs = 120_001;
        const lateBytes = bytes(lateEvidence); const lateSha = sha256(lateBytes);
        lateOracle.evidence[oracleIndex] = {identity: {...lateOracle.evidence[oracleIndex].identity,
            bytes: lateBytes.length, sha256: lateSha}, bytesBase64: lateBytes.toString("base64")};
        lateOracle.rowResult.operationProofs[oracleIndex].evidence = lateOracle.evidence[oracleIndex].identity;
        lateOracle.rowResult.operationProofs[oracleIndex].stateProofSha256 = lateSha;
        assert.throws(() => validateWindowsMsiGuestMatrixSemanticResult(lateOracle, rowRequest(),
            executionManifest()), /oracle|elapsed/i);
        for (const mutate of [
            item => { item.rowResult.boundaryReceipt.observationCommand.arguments = ["synthetic"]; },
            item => { item.rowResult.boundaryReceipt.cpuProbeCommand.stdoutSha256 = HASH; },
            item => { item.rowResult.freshReceipt.state.products[0].state = 5; },
            item => { item.rowResult.cleanupReceipt.ownedRemoval.installRootRemoved = false; }
        ]) {
            const changed = structuredClone(completed.semanticResult); mutate(changed);
            assert.throws(() => validateWindowsMsiGuestMatrixSemanticResult(changed, rowRequest(),
                executionManifest()));
        }
    });

    it("rejects identity, context, root, and output mutations before an operation runs", async () => {
        for (const mutate of [
            value => { value.envelope.sourceSha = "4".repeat(40); },
            value => { value.envelope.rowRequest.sha256 = HASH; },
            value => { value.envelope.resultPath = "C:\\outside.json"; },
            value => { value.envelope.executionManifest.path = value.envelope.rowRequest.path; },
            value => { value.files.set(value.envelope.rowRequest.path, Buffer.from("{}")); }
        ]) {
            const value = fixture(); mutate(value); let called = false;
            await assert.rejects(executeWindowsMsiGuestMatrixEnvelope(value.envelope, {
                readBoundFile: async binding => value.files.get(binding.path),
                readEvidenceFile: async () => { throw new Error("must not read evidence"); },
                writeCreateNew: async () => { throw new Error("must not write"); },
                operationsFactory: () => { called = true; return operationsFactory(new Map()); }
            }));
            assert.equal(called, false);
        }
    });

    it("requires the exact bounded envelope schema", () => {
        const value = fixture().envelope;
        assert.equal(validateWindowsMsiGuestMatrixEnvelope(value), value);
        for (const mutate of [item => { item.qualifying = true; }, item => { item.extra = true; },
            item => { item.sourceSha += "\n"; }, item => { item.limits.resultBytes = 0; }]) {
            const changed = structuredClone(value); mutate(changed);
            assert.throws(() => validateWindowsMsiGuestMatrixEnvelope(changed));
        }
    });
});
