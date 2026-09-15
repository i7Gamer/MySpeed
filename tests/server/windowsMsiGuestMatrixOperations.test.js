import {createHash} from "node:crypto";
import {describe, it} from "node:test";
import assert from "node:assert/strict";

import {createWindowsMsiMatrixContract} from "../../scripts/qualification/windows-msi-matrix-contract.mjs";
import {runWindowsMsiGuestMatrixRow} from "../../scripts/qualification/windows-msi-guest-matrix-row.mjs";
import {OPEN_GRAPH_QUALIFICATION_TIMEOUT_MS} from "../../scripts/qualification/safety.mjs";
import {validateWindowsMsiGuestMatrixSemanticResult} from "../../scripts/qualification/windows-msi-guest-matrix-executor.mjs";
import {
    createWindowsMsiGuestBoundaryArguments,
    createWindowsMsiGuestMatrixOperations,
    createWindowsMsiGuestSnapshotArguments,
    validateWindowsMsiGuestExecutionManifest,
    validateWindowsMsiGuestMatrixFixtureManifest,
    WINDOWS_MSI_GUEST_PRODUCT_BINDINGS
} from "../../scripts/qualification/windows-msi-guest-matrix-operations.mjs";

const HASH = "a".repeat(64);
const HARNESS_SOURCE_SHA = "1".repeat(40);
const CANDIDATE_SOURCE_SHA = "2".repeat(40);
const ERROR_CREATING_DESTINATION_FILE = 1310;
const hashes = value => createHash("sha256").update(value).digest("hex");
const command = (manifest, toolName, arguments_, exitCode = 0) => ({toolPath: manifest.tools[toolName].path,
    toolSha256: manifest.tools[toolName].sha256, arguments: arguments_, workingDirectory: manifest.outputRoot,
    exitCode, stdoutBytes: 0, stdoutSha256: hashes(Buffer.alloc(0)), stderrBytes: 0,
    stderrSha256: hashes(Buffer.alloc(0))});
const productCode = index => `{00000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}}`;
const root = "E:\\myspeed-msi";
const matrix = createWindowsMsiMatrixContract();
const PROBE_ROLES = Object.freeze(["avx", "avx2", "cpuid", "illegal", "known-bad", "known-good",
    "popcnt", "sse42"]);
const rawCpuid = () => ({schemaVersion: 1, kind: "cpuid", maxBasicLeaf: 7,
    leaf1: {eax: "0x00000000", ebx: "0x00000000", ecx: "0x18900000", edx: "0x00000000"},
    leaf7Subleaf0: {eax: "0x00000000", ebx: "0x00000120", ecx: "0x00000000", edx: "0x00000000"},
    xcr0: "0x0000000000000007", features: {sse42: true, popcnt: true, osxsave: true, avx: true, avx2: true}});
const cpuProbe = () => { const record = rawCpuid(); const raw = Buffer.from(`${JSON.stringify(record)}\r\n`); return {
    bytesBase64: raw.toString("base64"), sha256: hashes(raw), record}; };
const populatedFiles = () => ({".myspeed-qualification.json": "4".repeat(64),
    "bin/speedtest.exe": "5".repeat(64), "data/storage.db": "6".repeat(64)});
const fixtureManifest = () => ({schemaVersion: 1,
    source: {commit: CANDIDATE_SOURCE_SHA, bunLockSha256: "7".repeat(64), packageSha256: "8".repeat(64)},
    populated: {root: "synthetic-populated", nonce: "9".repeat(48), markerSha256: "4".repeat(64),
        databaseSha256: "6".repeat(64), filesSha256: populatedFiles()},
    reset: {root: "synthetic-reset", nonce: "a".repeat(48), markerSha256: "b".repeat(64),
        filesSha256: {".myspeed-qualification.json": "b".repeat(64)}},
    expected: {ping: "123.456", resultId: "qualification-seed-row", passwordValueSha256: "2".repeat(64)}});
const probeArtifact = () => ({schemaVersion: 1, repository: "i7Gamer/MySpeed", sourceSha: HARNESS_SOURCE_SHA,
    runId: "123", runAttempt: "1", artifactId: "456", artifactName: "windows-cpu-readiness-evidence",
    archive: {bytes: "33554432", sha256: "6".repeat(64)},
    innerManifest: {name: "result.json", bytes: "262144", sha256: "7".repeat(64)},
    files: PROBE_ROLES.map((role, index) => ({role, name: `${role.replaceAll("-", "_")}.exe`,
        bytes: `${4096 + index}`, sha256: `${index + 1}`.repeat(64).slice(0, 64)}))});
const execution = () => ({
    seedRoot: "E:\\seed", outputRoot: `${root}\\output`, programFilesRoot: "C:\\Program Files", programDataRoot: "C:\\ProgramData",
    installRoot: "C:\\Program Files\\MySpeed", installedExePath: "C:\\Program Files\\MySpeed\\MySpeed.exe",
    configurationPath: "C:\\Program Files\\MySpeed\\MySpeedService.xml",
    serviceWrapperPath: "C:\\Program Files\\MySpeed\\MySpeedService.exe",
    dataRoot: "C:\\ProgramData\\MySpeed", databasePath: "C:\\ProgramData\\MySpeed\\data\\storage.db",
    legacyDataRoot: "C:\\Program Files\\MySpeed\\data", serviceName: "MySpeed", origin: "http://127.0.0.1:5216",
    probeArtifact: probeArtifact(),
    tools: Object.fromEntries([["msiexec", "C:\\Windows\\System32\\msiexec.exe"],
        ["sc", "C:\\Windows\\System32\\sc.exe"],
        ["powershell", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"],
        ["node", "E:\\seed\\node.exe"], ["cpuid", "E:\\seed\\cpuid.exe"]].map(([name, toolPath]) => [name,
        name === "cpuid" ? {path: toolPath, bytes: 4098, sha256: "3".repeat(64)}
            : {path: toolPath, bytes: 100, sha256: HASH}])),
    helpers: Object.fromEntries([["oracle", "oracle.mjs"], ["sqlite", "sqlite.mjs"],
        ["rollback", "rollback.ps1"], ["containment", "containment.ps1"]].map(([name, file]) =>
        [name, {path: `E:\\seed\\${file}`, bytes: 123, sha256: HASH}])),
    artifacts: WINDOWS_MSI_GUEST_PRODUCT_BINDINGS.map((bindingId, index) => ({bindingId,
        path: `E:\\seed\\${bindingId}.msi`, bytes: 1024 + index, sha256: String(index + 1).repeat(64).slice(0, 64),
        productCode: productCode(index), exeBytes: index < 2 || index === 3 ? 12_345 + index : null,
        exeSha256: index < 2 || index === 3 ? "b".repeat(64) : null,
        configurationSha256: index < 2 ? "c".repeat(64) : null,
        serviceWrapperSha256: index < 2 ? "d".repeat(64) : null})),
    fixture: {sourceSha: CANDIDATE_SOURCE_SHA, populatedRoot: "E:\\seed\\populated", manifestPath: "E:\\seed\\fixture.json",
        manifestSha256: "e".repeat(64), legacyRoot: "E:\\seed\\legacy",
        populatedMarkerSha256: "4".repeat(64), populatedDatabaseSha256: "6".repeat(64),
        populatedFilesSha256: populatedFiles(),
        destinationSentinelSha256: "f".repeat(64), legacySentinelSha256: "1".repeat(64),
        expected: {ping: "123.456", resultId: "qualification-seed-row",
            passwordValueSha256: "2".repeat(64)}},
    limits: {processMilliseconds: 900_000, streamBytes: 65_536, evidenceBytes: 1_048_576}
});
const request = index => ({schemaVersion: 1, kind: "myspeed-windows-msi-guest-matrix-row-request",
    qualifying: false, sourceSha: HARNESS_SOURCE_SHA, eventSha: "2".repeat(40), runId: "123",
    runAttempt: "1", nonce: "3".repeat(32), scenarioIndex: index, matrix,
    guest: {profile: "modern-msi-v1", serial: "3".repeat(32), qemuCpuModel: "host",
        evidenceRoot: `${root}\\output`, baseImageSha256: "d".repeat(64), overlayNonce: "e".repeat(32),
        overlayReceiptSha256: "f".repeat(64), qemuLaunchSha256: "5".repeat(64), cpuEvidenceSha256: cpuProbe().sha256,
        cpuid: {vendor: "GenuineIntel", leaf1EcxHex: "18900000", leaf7EbxHex: "00000120",
            xcr0Hex: "0000000000000007", sse42: true, popcnt: true, osxsave: true, avx: true, avx2: true},
        cpuProbe: cpuProbe()},
    prerequisites: {closureSha256: "7".repeat(64), candidateManifestSha256: "8".repeat(64),
        fixtureManifestSha256: "9".repeat(64), rollbackCalibrationSha256: "b".repeat(64),
        oldContainmentSha256: "c".repeat(64)}});

const native = manifest => {
    const calls = [];
    const evidenceFiles = new Map();
    const states = new Map(WINDOWS_MSI_GUEST_PRODUCT_BINDINGS.map(name => [name, -1]));
    let serviceState = null;
    let listenerCount = 0;
    let installRootExists = false;
    let dataRootExists = false;
    let legacySeeded = false;
    let destinationSeeded = false;
    let ifeoActive = false;
    const current = () => ({products: [...states].map(([bindingId, state]) => ({bindingId, state})),
        serviceCount: serviceState === null ? 0 : 1, serviceState, servicePath: serviceState === null ? null : manifest.serviceWrapperPath,
        serviceStartName: serviceState === null ? null : "LocalSystem", servicePid: serviceState === "Running" ? 42 : 0,
        listenerCount, listenerPid: listenerCount === 1 ? 84 : null,
        listenerParentPid: listenerCount === 1 ? 42 : null,
        listenerImagePath: listenerCount === 1 ? manifest.installedExePath : null,
        installRootExists, dataRootExists});
    const observation = (value, arguments_) => ({command: command(manifest, "powershell", arguments_), value});
    const msi = (action, item, logKind, exitCode = 0) => command(manifest, "msiexec", [action,
        action === "/i" ? item.path : item.productCode, "/qn", "/norestart", "/L*V!",
        `${manifest.outputRoot}\\${logKind}-${item.bindingId}.log`, "REBOOT=ReallySuppress"], exitCode);
    const candidateInstall = item => {
        for (const name of states.keys()) states.set(name, -1);
        states.set(item.bindingId, 5); installRootExists = true;
        serviceState = ifeoActive ? "Stopped" : "Running";
        listenerCount = ifeoActive ? 0 : 1;
    };
    return {calls, evidenceFiles, value: {
        assertBoundary: async () => ({...observation({networkAdapters: 0, serial: "3".repeat(32), manufacturer: "QEMU"},
            createWindowsMsiGuestBoundaryArguments("3".repeat(32))), cpuCommand: {...command(manifest, "cpuid", []),
            stdoutBytes: Buffer.from(cpuProbe().bytesBase64, "base64").length,
            stdoutSha256: cpuProbe().sha256}}),
        snapshot: async () => observation(current(), createWindowsMsiGuestSnapshotArguments(manifest)),
        install: async item => { calls.push(`install:${item.bindingId}`); candidateInstall(item); return msi("/i", item, "install"); },
        uninstall: async item => { calls.push(`uninstall:${item.bindingId}`); states.set(item.bindingId, -1);
            if (![...states.values()].includes(5)) { serviceState = null; listenerCount = 0; installRootExists = false; }
            return msi("/x", item, "uninstall"); },
        repair: async (item, mode) => { calls.push(`repair:${item.bindingId}:${mode}`); candidateInstall(item); return msi(mode, item, "repair"); },
        service: async action => { calls.push(`service:${action}`); serviceState = action === "start" ? "Running" : "Stopped";
            listenerCount = action === "start" ? 1 : 0; return command(manifest, "sc", [action, "MySpeed"]); },
        seedPopulated: async () => { calls.push("seed:populated"); dataRootExists = true; },
        seedLegacy: async () => { calls.push("seed:legacy"); legacySeeded = true; },
        seedDestinationSentinel: async () => { calls.push("seed:destination"); destinationSeeded = true; dataRootExists = true; },
        damage: async target => calls.push(`damage:${target}`), oracle: async () => { calls.push("oracle"); return {elapsedMs: 1}; },
        database: async () => { calls.push("database"); return manifest.fixture.expected; },
        rollback: async (item, predecessor) => { calls.push(`rollback:${item.bindingId}`); states.set(item.bindingId, -1);
            states.set("safe-rollback-predecessor", 5); serviceState = "Stopped"; listenerCount = 0;
            return {command: command(manifest, "powershell", ["-NoLogo", "-NoProfile", "-NonInteractive",
                "-File", manifest.helpers.rollback.path, "-Mode", "InvokeGuestCandidateRollback",
                "-CandidateMsiPath", item.path, "-CandidateMsiSha256", item.sha256,
                "-CandidateProductCode", item.productCode, "-CandidatePayloadBytes", String(item.exeBytes),
                "-PredecessorProductCode", predecessor.productCode, "-PredecessorPayloadSha256",
                predecessor.exeSha256, "-EvidenceRoot", manifest.outputRoot, "-Nonce", "3".repeat(32),
                "-ExpectedSerial", "3".repeat(32), "-HelperSha256", manifest.helpers.rollback.sha256]), proof: {accepted: true,
                errorCode: ERROR_CREATING_DESTINATION_FILE, installContextBalanced: true, securityRestored: true,
                predecessorRestored: true, candidateAbsent: true, recordsSha256: HASH}}; },
        containment: async (action, item) => { calls.push(`containment:${action}:${item.bindingId}`);
            ifeoActive = action === "Install";
            if (action === "Install") candidateInstall(item); return {command: command(manifest, "powershell",
                ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", manifest.helpers.containment.path,
                    "-Mode", action, "-ProductCode", item.productCode, "-MsiPath", item.path,
                    "-MsiSha256", item.sha256, "-EvidenceRoot", manifest.outputRoot, "-Nonce", "3".repeat(32),
                    "-ExpectedSerial", "3".repeat(32), "-HelperSha256", manifest.helpers.containment.sha256]), proof: {status: "completed", mode: action,
                productCode: item.productCode, ifeoActive: action === "Install", oldPayloadExecutionCount: 0,
                registryRestored: action === "Remove", launchInventorySha256: HASH}}; },
        removeOwned: async () => { calls.push("remove-owned"); dataRootExists = false; installRootExists = false;
            return {installRootRemoved: true, dataRootRemoved: true}; },
        hashFile: async file => file.endsWith("legacy.sentinel") && legacySeeded ? manifest.fixture.legacySentinelSha256
            : file.endsWith("destination.sentinel") && destinationSeeded ? manifest.fixture.destinationSentinelSha256
                : file === manifest.databasePath ? manifest.fixture.populatedDatabaseSha256
                : file === manifest.installedExePath ? manifest.artifacts[0].exeSha256
                    : file === manifest.configurationPath ? manifest.artifacts[0].configurationSha256
                        : file === manifest.serviceWrapperPath ? manifest.artifacts[0].serviceWrapperSha256 : HASH,
        writeEvidence: async (index, operation, value) => { const bytes = Buffer.from(JSON.stringify(value));
            const target = `${manifest.outputRoot}\\${String(index).padStart(2, "0")}-${operation}.json`;
            evidenceFiles.set(target, bytes); return {path: target,
                bytes: bytes.length, sha256: hashes(bytes)}; }
    }};
};

describe("Windows MSI guest concrete matrix operations", () => {
    it("validates the exact executable manifest and rejects reordered artifacts", () => {
        const realistic = execution(); realistic.tools.node.bytes = 85_268_464;
        assert.equal(validateWindowsMsiGuestExecutionManifest(realistic).serviceName, "MySpeed");
        assert.equal(validateWindowsMsiGuestExecutionManifest(realistic).tools.msiexec.path,
            "C:\\Windows\\System32\\msiexec.exe");
        const changed = execution(); changed.artifacts.reverse();
        assert.throws(() => validateWindowsMsiGuestExecutionManifest(changed), /artifact|order/i);
        const toolChanged = execution(); toolChanged.tools.msiexec.sha256 += "\n";
        assert.throws(() => validateWindowsMsiGuestExecutionManifest(toolChanged), /msiexec|SHA/i);
        const oversized = execution(); oversized.tools.node.bytes = 134_217_729;
        assert.throws(() => validateWindowsMsiGuestExecutionManifest(oversized), /node|bytes/i);
        const unboundProbe = execution(); unboundProbe.tools.cpuid.sha256 = HASH;
        assert.throws(() => validateWindowsMsiGuestExecutionManifest(unboundProbe), /cpuid|probe/i);
        const staleProbe = execution(); staleProbe.probeArtifact.sourceSha = "2".repeat(40);
        assert.throws(() => createWindowsMsiGuestMatrixOperations({request: request(0), execution: staleProbe,
            native: native(staleProbe).value}), /probe artifact context/i);
        assert.equal(OPEN_GRAPH_QUALIFICATION_TIMEOUT_MS, 120_000);
    });

    it("binds the real populated fixture manifest and exact sealed inventory before seeding", () => {
        const manifest = execution();
        assert.equal(validateWindowsMsiGuestMatrixFixtureManifest(fixtureManifest(), manifest,
            request(0), populatedFiles()).populated.databaseSha256, manifest.fixture.populatedDatabaseSha256);
        for (const mutate of [
            value => { value.source.commit = HARNESS_SOURCE_SHA; },
            value => { value.expected.resultId = "other"; },
            value => { value.populated.filesSha256["data/storage.db"] = HASH; },
            value => { value.populated.markerSha256 = HASH; },
            value => { value.populated.extra = true; }
        ]) {
            const value = fixtureManifest(); mutate(value);
            assert.throws(() => validateWindowsMsiGuestMatrixFixtureManifest(value, manifest,
                request(0), populatedFiles()), /fixture|source|inventory|expected|keys|distinguished/i);
        }
        const observed = populatedFiles(); observed["bin/speedtest.exe"] = HASH;
        assert.throws(() => validateWindowsMsiGuestMatrixFixtureManifest(fixtureManifest(), manifest,
            request(0), observed), /inventory/i);
        const staleExecution = execution(); staleExecution.fixture.populatedFilesSha256["extra.txt"] = HASH;
        assert.throws(() => validateWindowsMsiGuestExecutionManifest(staleExecution), /fixture|path/i);
        const staleCandidate = execution(); staleCandidate.fixture.sourceSha = HARNESS_SOURCE_SHA;
        assert.throws(() => validateWindowsMsiGuestMatrixFixtureManifest(fixtureManifest(), staleCandidate,
            request(0), populatedFiles()), /fixture|source/i);
    });

    it("executes every accepted row through concrete MSI, service, fixture, oracle, rollback, and containment methods", async () => {
        const observed = new Set();
        for (let index = 0; index < matrix.scenarios.length; index++) {
            const input = request(index); const manifest = execution(); const injected = native(manifest);
            const result = await runWindowsMsiGuestMatrixRow(input,
                createWindowsMsiGuestMatrixOperations({request: input, execution: manifest, native: injected.value}));
            assert.equal(result.rowPassed, true, `${matrix.scenarios[index].id}: ${JSON.stringify(result.failures)}`);
            for (const call of injected.calls) observed.add(call.split(":", 1)[0]);
            assert.ok(result.operationProofs.every(proof => proof.evidence.sha256 === proof.stateProofSha256));
            const semantic = {schemaVersion: 1, kind: "myspeed-windows-msi-guest-matrix-semantic-result",
                status: "completed", qualifying: false, matrixPassed: true, sourceSha: input.sourceSha,
                eventSha: input.eventSha, runId: input.runId, runAttempt: input.runAttempt, nonce: input.nonce,
                scenarioIndex: index, scenarioId: matrix.scenarios[index].id, rowResult: result,
                evidence: result.operationProofs.map(proof => { const content = injected.evidenceFiles.get(proof.evidence.path);
                    return {identity: proof.evidence, bytesBase64: content.toString("base64")}; }),
                releaseGatesCleared: []};
            assert.equal(validateWindowsMsiGuestMatrixSemanticResult(semantic, input, manifest), semantic);
        }
        for (const method of ["install", "uninstall", "repair", "service", "seed", "oracle", "database",
            "rollback", "containment", "damage", "remove-owned"]) assert.ok(observed.has(method), method);
    });

    it("fails before mutation when the NIC-free or fresh-overlay observation differs", async () => {
        for (const mode of ["network", "product"]) {
            const input = request(0); const manifest = execution(); const injected = native(manifest);
            if (mode === "network") injected.value.assertBoundary = async () => ({command: command(manifest,
                "powershell", createWindowsMsiGuestBoundaryArguments("3".repeat(32))),
                value: {networkAdapters: 1, serial: "3".repeat(32), manufacturer: "QEMU"},
                cpuCommand: {...command(manifest, "cpuid", []),
                    stdoutBytes: Buffer.from(cpuProbe().bytesBase64, "base64").length,
                    stdoutSha256: cpuProbe().sha256}});
            else await injected.value.install(manifest.artifacts[0]);
            const result = await runWindowsMsiGuestMatrixRow(input,
                createWindowsMsiGuestMatrixOperations({request: input, execution: manifest, native: injected.value}));
            assert.equal(result.rowPassed, false);
            assert.equal(injected.calls.some(call => call === "seed:populated"), false);
        }
    });

    it("retains exact evidence identity and refuses an uncalibrated rollback or stale sentinel", async () => {
        for (const mode of ["rollback", "sentinel"]) {
            const index = mode === "rollback" ? 8 : 13; const input = request(index);
            const manifest = execution(); const injected = native(manifest);
            if (mode === "rollback") injected.value.rollback = async (item, predecessor) => ({command: command(manifest,
                "powershell", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", manifest.helpers.rollback.path,
                    "-Mode", "InvokeGuestCandidateRollback", "-CandidateMsiPath", item.path,
                    "-CandidateMsiSha256", item.sha256, "-CandidateProductCode", item.productCode,
                    "-CandidatePayloadBytes", String(item.exeBytes), "-PredecessorProductCode", predecessor.productCode,
                    "-PredecessorPayloadSha256", predecessor.exeSha256, "-EvidenceRoot", manifest.outputRoot,
                    "-Nonce", "3".repeat(32), "-ExpectedSerial", "3".repeat(32), "-HelperSha256",
                    manifest.helpers.rollback.sha256]), proof: {accepted: false, errorCode: ERROR_CREATING_DESTINATION_FILE,
                installContextBalanced: true, securityRestored: true, predecessorRestored: true,
                candidateAbsent: true, recordsSha256: HASH}});
            else injected.value.hashFile = async file => file.endsWith("destination.sentinel") ? HASH
                    : file.endsWith("legacy.sentinel") ? manifest.fixture.legacySentinelSha256
                        : file === manifest.installedExePath ? manifest.artifacts[0].exeSha256
                        : file === manifest.configurationPath ? manifest.artifacts[0].configurationSha256
                            : file === manifest.serviceWrapperPath ? manifest.artifacts[0].serviceWrapperSha256 : HASH;
            const result = await runWindowsMsiGuestMatrixRow(input,
                createWindowsMsiGuestMatrixOperations({request: input, execution: manifest, native: injected.value}));
            assert.equal(result.rowPassed, false);
            assert.ok(result.failures.some(item => item.stage.startsWith("operation:")));
        }
    });

    it("keeps authentic predecessor payloads inert until containment is removed", async () => {
        const input = request(10);
        const manifest = execution();
        const injected = native(manifest);
        const serviceCalls = [];
        const containmentCalls = [];
        const originalService = injected.value.service;
        const originalContainment = injected.value.containment;
        injected.value.service = async action => {
            serviceCalls.push(action);
            return originalService(action);
        };
        injected.value.containment = async (action, item) => {
            containmentCalls.push(action);
            return originalContainment(action, item);
        };
        const operations = createWindowsMsiGuestMatrixOperations({request: input,
            execution: manifest, native: injected.value});
        const scenario = input.matrix.scenarios[input.scenarioIndex];
        await operations.inspectFreshScenario({request: input, scenario});
        for (let index = 0; index < scenario.operations.length; index++) {
            const operation = scenario.operations[index];
            if (operation === "cleanup" || operation === "run-candidate-oracle") continue;
            await operations.executeOperation({request: input, scenario, operation, operationIndex: index});
        }
        assert.deepEqual(containmentCalls, ["Install", "Remove"]);
        assert.deepEqual(serviceCalls, ["start"],
            "the old payload stays stopped; only the candidate starts after IFEO removal");
    });
});
