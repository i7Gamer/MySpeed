import {createHash} from "node:crypto";

import {createWindowsMsiMatrixContract} from "../../scripts/qualification/windows-msi-matrix-contract.mjs";
import {validateWindowsMsiGuestMatrixSemanticResult} from
    "../../scripts/qualification/windows-msi-guest-matrix-executor.mjs";
import {createWindowsMsiGuestBoundaryArguments, createWindowsMsiGuestMatrixOperations,
    createWindowsMsiGuestSnapshotArguments, WINDOWS_MSI_GUEST_PRODUCT_BINDINGS} from
    "../../scripts/qualification/windows-msi-guest-matrix-operations.mjs";
import {runWindowsMsiGuestMatrixRow} from "../../scripts/qualification/windows-msi-guest-matrix-row.mjs";

const SOURCE_SHA = "1".repeat(40);
const EVENT_SHA = "2".repeat(40);
const CANDIDATE_MANIFEST_SHA = "8".repeat(64);
const CLOSURE_SHA = "7".repeat(64);
const FIXTURE_MANIFEST_SHA = "e".repeat(64);
const ROLLBACK_CALIBRATION_SHA = "b".repeat(64);
const OLD_CONTAINMENT_SHA = "c".repeat(64);
const BASE_IMAGE_SHA = "d".repeat(64);
const RUN_ID = "123";
const RUN_ATTEMPT = "1";
const REPOSITORY = "i7Gamer/MySpeed";
const HASH = "a".repeat(64);
const ERROR_CREATING_DESTINATION_FILE = 1310;
const SCENARIO_COUNT = 14;
const CANDIDATE_BINDING_IDS = Object.freeze(["candidate-default", "candidate-baseline"]);
const PROBE_ROLES = Object.freeze(["avx", "avx2", "cpuid", "illegal", "known-bad", "known-good",
    "popcnt", "sse42"]);

const sha256 = value => createHash("sha256").update(value).digest("hex");
const productCode = index => `{00000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}}`;
const retained = value => { const bytes = Buffer.from(JSON.stringify(value), "utf8"); return {
    bytes: bytes.length, sha256: sha256(bytes), bytesBase64: bytes.toString("base64")}; };
const rawCpuid = () => ({schemaVersion: 1, kind: "cpuid", maxBasicLeaf: 7,
    leaf1: {eax: "0x00000000", ebx: "0x00000000", ecx: "0x18900000", edx: "0x00000000"},
    leaf7Subleaf0: {eax: "0x00000000", ebx: "0x00000120", ecx: "0x00000000", edx: "0x00000000"},
    xcr0: "0x0000000000000007", features: {sse42: true, popcnt: true, osxsave: true, avx: true, avx2: true}});
const cpuProbe = () => { const record = rawCpuid(); const bytes = Buffer.from(`${JSON.stringify(record)}\r\n`); return {
    bytesBase64: bytes.toString("base64"), sha256: sha256(bytes), record}; };
const populatedFiles = () => ({".myspeed-qualification.json": "4".repeat(64),
    "bin/speedtest.exe": "5".repeat(64), "data/storage.db": "6".repeat(64)});
const defaultProbeArtifact = ({sourceSha, runId, runAttempt}) => ({schemaVersion: 1,
    repository: "i7Gamer/MySpeed", sourceSha,
    runId, runAttempt, artifactId: "456", artifactName: "windows-cpu-readiness-evidence",
    archive: {bytes: "33554432", sha256: "6".repeat(64)},
    innerManifest: {name: "result.json", bytes: "262144", sha256: "7".repeat(64)},
    files: PROBE_ROLES.map((role, index) => ({role, name: `${role.replaceAll("-", "_")}.exe`,
        bytes: `${4096 + index}`, sha256: `${index + 1}`.repeat(64).slice(0, 64)}))});

const guestInputRoot = nonce => `C:\\Windows\\Temp\\myspeed-msi-input-${nonce}`;
const guestOutputRoot = nonce => `C:\\Windows\\Temp\\myspeed-msi-output-${nonce}`;

const executionManifest = (nonce, settings) => {
    const seedRoot = guestInputRoot(nonce);
    const outputRoot = guestOutputRoot(nonce);
    const cpuid = settings.probeArtifact.files.find(file => file.role === "cpuid");
    return {seedRoot, outputRoot,
    programFilesRoot: "C:\\Program Files", programDataRoot: "C:\\ProgramData",
    installRoot: "C:\\Program Files\\MySpeed", installedExePath: "C:\\Program Files\\MySpeed\\MySpeed.exe",
    configurationPath: "C:\\Program Files\\MySpeed\\MySpeedService.xml",
    serviceWrapperPath: "C:\\Program Files\\MySpeed\\MySpeedService.exe",
    dataRoot: "C:\\ProgramData\\MySpeed", databasePath: "C:\\ProgramData\\MySpeed\\data\\storage.db",
    legacyDataRoot: "C:\\Program Files\\MySpeed\\data", serviceName: "MySpeed", origin: "http://127.0.0.1:5216",
    probeArtifact: settings.probeArtifact, tools: Object.fromEntries([
        ["msiexec", "C:\\Windows\\System32\\msiexec.exe"], ["sc", "C:\\Windows\\System32\\sc.exe"],
        ["powershell", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"],
        ["node", `${seedRoot}\\node.exe`], ["cpuid", `${seedRoot}\\cpuid.exe`]].map(([name, toolPath]) => [name,
        name === "cpuid" ? {path: toolPath, bytes: Number(cpuid.bytes), sha256: cpuid.sha256}
            : name === "node" ? {path: toolPath, bytes: 85_268_464, sha256: HASH}
                : settings.systemTools?.find(item => item.role === name)
                    ? {path: toolPath, bytes: Number(settings.systemTools.find(item => item.role === name).bytes),
                        sha256: settings.systemTools.find(item => item.role === name).sha256}
                    : {path: toolPath, bytes: 100, sha256: HASH}])),
    helpers: Object.fromEntries([["oracle", "oracle.mjs"], ["sqlite", "sqlite.mjs"],
        ["rollback", "rollback.ps1"], ["containment", "containment.ps1"]].map(([name, file]) =>
        [name, {path: `${seedRoot}\\${file}`, bytes: 123, sha256: HASH}])),
    artifacts: WINDOWS_MSI_GUEST_PRODUCT_BINDINGS.map((bindingId, index) => {
        const candidate = settings.candidateArtifacts[bindingId];
        return {bindingId,
        path: `${seedRoot}\\${bindingId}.msi`, bytes: candidate?.msi.bytes ?? 1024 + index,
        sha256: candidate?.msi.sha256 ?? String(index + 1).repeat(64).slice(0, 64),
        productCode: candidate?.productCode ?? productCode(index),
        exeBytes: candidate?.exe.bytes ?? (index === 3 ? 12_345 + index : null),
        exeSha256: candidate?.exe.sha256 ?? (index === 3 ? "b".repeat(64) : null),
        configurationSha256: candidate?.configurationSha256 ?? (index < 2 ? "c".repeat(64) : null),
        serviceWrapperSha256: candidate?.serviceWrapperSha256 ?? (index < 2 ? "d".repeat(64) : null)};}),
    fixture: {sourceSha: settings.candidateSourceSha, populatedRoot: `${seedRoot}\\populated`, manifestPath: `${seedRoot}\\fixture.json`,
        manifestSha256: settings.fixtureManifestSha256, legacyRoot: `${seedRoot}\\legacy`,
        populatedMarkerSha256: "4".repeat(64), populatedDatabaseSha256: "6".repeat(64),
        populatedFilesSha256: populatedFiles(), destinationSentinelSha256: "f".repeat(64),
        legacySentinelSha256: "1".repeat(64), expected: {ping: "123.456",
            resultId: "qualification-seed-row", passwordValueSha256: "2".repeat(64)}},
    limits: {processMilliseconds: 900_000, streamBytes: 65_536, evidenceBytes: 1_048_576}};
};

const rowRequest = (scenarioIndex, settings) => {
    const nonce = createHash("sha256").update(`msi-row\0${scenarioIndex}`).digest("hex").slice(0, 32);
    const probe = cpuProbe();
    return {schemaVersion: 1, kind: "myspeed-windows-msi-guest-matrix-row-request", qualifying: false,
        sourceSha: settings.sourceSha, eventSha: settings.eventSha, runId: settings.runId,
        runAttempt: settings.runAttempt, nonce, scenarioIndex,
        matrix: createWindowsMsiMatrixContract(), guest: {profile: "modern-msi-v1", serial: nonce,
            qemuCpuModel: "host", evidenceRoot: guestOutputRoot(nonce), baseImageSha256: BASE_IMAGE_SHA,
            overlayNonce: createHash("sha256").update(`overlay\0${scenarioIndex}`).digest("hex").slice(0, 32),
            overlayReceiptSha256: settings.overlayReceiptSha256ByScenario?.[scenarioIndex]
                ?? createHash("sha256").update(`overlay-receipt\0${scenarioIndex}`).digest("hex"),
            qemuLaunchSha256: settings.qemuLaunchSha256ByScenario?.[scenarioIndex]
                ?? createHash("sha256").update(`qemu-launch\0${scenarioIndex}`).digest("hex"),
            cpuEvidenceSha256: probe.sha256, cpuid: {vendor: "GenuineIntel", leaf1EcxHex: "18900000",
                leaf7EbxHex: "00000120", xcr0Hex: "0000000000000007", sse42: true, popcnt: true,
                osxsave: true, avx: true, avx2: true}, cpuProbe: probe}, prerequisites: {
            closureSha256: CLOSURE_SHA, candidateManifestSha256: settings.candidateManifestSha256,
            fixtureManifestSha256: settings.fixtureManifestSha256,
            rollbackCalibrationSha256: settings.rollbackCalibrationSha256,
            oldContainmentSha256: settings.oldContainmentSha256}};
};

const command = (manifest, toolName, arguments_, exitCode = 0) => ({toolPath: manifest.tools[toolName].path,
    toolSha256: manifest.tools[toolName].sha256, arguments: arguments_, workingDirectory: manifest.outputRoot,
    exitCode, stdoutBytes: 0, stdoutSha256: sha256(Buffer.alloc(0)), stderrBytes: 0,
    stderrSha256: sha256(Buffer.alloc(0))});

const nativeFixture = (manifest, request) => {
    const evidenceFiles = new Map();
    const states = new Map(WINDOWS_MSI_GUEST_PRODUCT_BINDINGS.map(name => [name, -1]));
    let serviceState = null; let listenerCount = 0; let installRootExists = false; let dataRootExists = false;
    let legacySeeded = false; let destinationSeeded = false; let containmentActive = false;
    const current = () => ({products: [...states].map(([bindingId, state]) => ({bindingId, state})),
        serviceCount: serviceState === null ? 0 : 1, serviceState,
        servicePath: serviceState === null ? null : manifest.serviceWrapperPath,
        serviceStartName: serviceState === null ? null : "LocalSystem", servicePid: serviceState === "Running" ? 42 : 0,
        listenerCount, listenerPid: listenerCount === 1 ? 84 : null,
        listenerParentPid: listenerCount === 1 ? 42 : null,
        listenerImagePath: listenerCount === 1 ? manifest.installedExePath : null,
        installRootExists, dataRootExists});
    const observation = (value, arguments_) => ({command: command(manifest, "powershell", arguments_), value});
    const msi = (action, item, logKind, exitCode = 0) => command(manifest, "msiexec", [action,
        action === "/i" ? item.path : item.productCode, "/qn", "/norestart", "/L*V!",
        `${manifest.outputRoot}\\${logKind}-${item.bindingId}.log`, "REBOOT=ReallySuppress"], exitCode);
    const install = item => { for (const name of states.keys()) states.set(name, -1); states.set(item.bindingId, 5);
        installRootExists = true; serviceState = containmentActive ? "Stopped" : "Running";
        listenerCount = containmentActive ? 0 : 1; };
    const installedArtifact = () => manifest.artifacts.find(item => states.get(item.bindingId) === 5)
        ?? manifest.artifacts[0];
    /*
     * A schemaVersion 1 row carries the CPUID bytes the host already observed; a schemaVersion 2 row
     * carries only the requirements, and the guest is the one that observes CPUID and returns the
     * observation. The double has to answer whichever question its row asked.
     */
    const cpu = request.guest.cpuProbe ?? cpuProbe();
    return {evidenceFiles, native: {
        assertBoundary: async () => ({...observation({networkAdapters: 0, serial: request.nonce,
            manufacturer: "QEMU"}, createWindowsMsiGuestBoundaryArguments(request.nonce)),
        cpuCommand: {...command(manifest, "cpuid", []),
            stdoutBytes: Buffer.from(cpu.bytesBase64, "base64").length, stdoutSha256: cpu.sha256},
        ...(request.schemaVersion === 1 ? {} : {cpuObservation: cpu})}),
        snapshot: async () => observation(current(), createWindowsMsiGuestSnapshotArguments(manifest)),
        install: async item => { install(item); return msi("/i", item, "install"); },
        uninstall: async item => { states.set(item.bindingId, -1); if (![...states.values()].includes(5)) {
            serviceState = null; listenerCount = 0; installRootExists = false; } return msi("/x", item, "uninstall"); },
        repair: async (item, mode) => { install(item); return msi(mode, item, "repair"); },
        service: async action => { serviceState = action === "start" ? "Running" : "Stopped";
            listenerCount = action === "start" ? 1 : 0; return command(manifest, "sc", [action, "MySpeed"]); },
        seedPopulated: async () => { dataRootExists = true; }, seedLegacy: async () => { legacySeeded = true; },
        seedDestinationSentinel: async () => { destinationSeeded = true; dataRootExists = true; },
        damage: async () => {}, oracle: async () => ({elapsedMs: 1}), database: async () => manifest.fixture.expected,
        rollback: async (item, predecessor) => { states.set(item.bindingId, -1); states.set("safe-rollback-predecessor", 5);
            serviceState = "Stopped"; listenerCount = 0; return {command: command(manifest, "powershell", ["-NoLogo",
                "-NoProfile", "-NonInteractive", "-File", manifest.helpers.rollback.path, "-Mode",
                "InvokeGuestCandidateRollback", "-CandidateMsiPath", item.path, "-CandidateMsiSha256", item.sha256,
                "-CandidateProductCode", item.productCode, "-CandidatePayloadBytes", String(item.exeBytes),
                "-PredecessorProductCode", predecessor.productCode, "-PredecessorPayloadSha256", predecessor.exeSha256,
                "-EvidenceRoot", manifest.outputRoot, "-Nonce", request.nonce, "-ExpectedSerial", request.nonce,
                "-HelperSha256", manifest.helpers.rollback.sha256]), proof: {accepted: true,
                errorCode: ERROR_CREATING_DESTINATION_FILE, installContextBalanced: true, securityRestored: true,
                predecessorRestored: true, candidateAbsent: true, recordsSha256: HASH}}; },
        containment: async (action, item) => { containmentActive = action === "Install";
            if (containmentActive) install(item); return {command: command(manifest, "powershell", ["-NoLogo",
                "-NoProfile", "-NonInteractive", "-File", manifest.helpers.containment.path, "-Mode", action,
                "-ProductCode", item.productCode, "-MsiPath", item.path, "-MsiSha256", item.sha256,
                "-EvidenceRoot", manifest.outputRoot, "-Nonce", request.nonce, "-ExpectedSerial", request.nonce,
                "-HelperSha256", manifest.helpers.containment.sha256]), proof: {status: "completed", mode: action,
                productCode: item.productCode, ifeoActive: containmentActive, oldPayloadExecutionCount: 0,
                registryRestored: action === "Remove", launchInventorySha256: HASH}}; },
        removeOwned: async () => { dataRootExists = false; installRootExists = false;
            return {installRootRemoved: true, dataRootRemoved: true}; },
        hashFile: async file => file.endsWith("legacy.sentinel") && legacySeeded ? manifest.fixture.legacySentinelSha256
            : file.endsWith("destination.sentinel") && destinationSeeded ? manifest.fixture.destinationSentinelSha256
                : file === manifest.databasePath ? manifest.fixture.populatedDatabaseSha256
                    : file === manifest.installedExePath ? installedArtifact().exeSha256
                        : file === manifest.configurationPath ? installedArtifact().configurationSha256
                            : file === manifest.serviceWrapperPath ? installedArtifact().serviceWrapperSha256 : HASH,
        writeEvidence: async (index, operation, value) => { const bytes = Buffer.from(JSON.stringify(value));
            const target = `${manifest.outputRoot}\\${String(index).padStart(2, "0")}-${operation}.json`;
            evidenceFiles.set(target, bytes); return {path: target, bytes: bytes.length, sha256: sha256(bytes)}; }
    }};
};

/*
 * The identity this fixture's rows are built under. Prerequisite evidence is provenance-bound to
 * the execution context, and the digests it yields are what the rows carry, so a caller that builds
 * both has to agree with the fixture on the identity before either exists.
 */
export const WINDOWS_MSI_GUEST_EVIDENCE_DEFAULT_IDENTITY = Object.freeze({repository: REPOSITORY,
    sourceSha: SOURCE_SHA, eventSha: EVENT_SHA, runId: RUN_ID, runAttempt: RUN_ATTEMPT});

/*
 * Runs one real matrix row against the native double and returns the semantic result the guest
 * would retain. Callers that build row requests from the production request builder - the exact
 * ordered fourteen, at schemaVersion 2 - use this to execute the matrix they actually requested
 * rather than a parallel set this fixture invented.
 */
export const createWindowsMsiGuestRowSemanticResult = async ({rowRequest, executionManifest}) => {
    const fixture = nativeFixture(executionManifest, rowRequest);
    const rowResult = await runWindowsMsiGuestMatrixRow(rowRequest,
        createWindowsMsiGuestMatrixOperations({request: rowRequest, execution: executionManifest,
            native: fixture.native}));
    const evidence = rowResult.operationProofs.map(proof => ({identity: proof.evidence,
        bytesBase64: fixture.evidenceFiles.get(proof.evidence.path).toString("base64")}));
    const semanticResult = {schemaVersion: 1, kind: "myspeed-windows-msi-guest-matrix-semantic-result",
        status: rowResult.status, qualifying: false, matrixPassed: rowResult.rowPassed,
        sourceSha: rowRequest.sourceSha, eventSha: rowRequest.eventSha, runId: rowRequest.runId,
        runAttempt: rowRequest.runAttempt, nonce: rowRequest.nonce,
        scenarioIndex: rowRequest.scenarioIndex,
        scenarioId: rowRequest.matrix.scenarios[rowRequest.scenarioIndex].id, rowResult, evidence,
        releaseGatesCleared: []};
    validateWindowsMsiGuestMatrixSemanticResult(semanticResult, rowRequest, executionManifest);
    return semanticResult;
};

export const createWindowsMsiGuestLifecycleEvidenceFixture = async (overrides = {}) => {
    const settings = {sourceSha: overrides.sourceSha ?? SOURCE_SHA,
        candidateSourceSha: overrides.candidateSourceSha ?? overrides.sourceSha ?? SOURCE_SHA,
        eventSha: overrides.eventSha ?? EVENT_SHA,
        runId: overrides.runId ?? RUN_ID, runAttempt: overrides.runAttempt ?? RUN_ATTEMPT,
        candidateManifestSha256: overrides.candidateManifestSha256 ?? CANDIDATE_MANIFEST_SHA,
        fixtureManifestSha256: overrides.fixtureManifestSha256 ?? FIXTURE_MANIFEST_SHA,
        rollbackCalibrationSha256: overrides.rollbackCalibrationSha256 ?? ROLLBACK_CALIBRATION_SHA,
        oldContainmentSha256: overrides.oldContainmentSha256 ?? OLD_CONTAINMENT_SHA,
        overlayReceiptSha256ByScenario: overrides.overlayReceiptSha256ByScenario,
        qemuLaunchSha256ByScenario: overrides.qemuLaunchSha256ByScenario,
        candidateArtifacts: overrides.candidateArtifacts ?? Object.fromEntries(CANDIDATE_BINDING_IDS.map(
            (bindingId, index) => [bindingId, {msi: {bytes: 1024 + index,
                sha256: String(index + 1).repeat(64).slice(0, 64)},
            exe: {bytes: 12_345 + index, sha256: "b".repeat(64)}}])),
        probeArtifact: overrides.probeArtifact ?? null, systemTools: overrides.systemTools};
    settings.probeArtifact ??= defaultProbeArtifact(settings);
    const rows = [];
    for (let scenarioIndex = 0; scenarioIndex < SCENARIO_COUNT; scenarioIndex += 1) {
        const request = rowRequest(scenarioIndex, settings);
        const manifest = executionManifest(request.nonce, settings);
        const fixture = nativeFixture(manifest, request);
        const rowResult = await runWindowsMsiGuestMatrixRow(request,
            createWindowsMsiGuestMatrixOperations({request, execution: manifest, native: fixture.native}));
        const evidence = rowResult.operationProofs.map(proof => ({identity: proof.evidence,
            bytesBase64: fixture.evidenceFiles.get(proof.evidence.path).toString("base64")}));
        const semanticResult = {schemaVersion: 1, kind: "myspeed-windows-msi-guest-matrix-semantic-result",
            status: rowResult.status, qualifying: false, matrixPassed: rowResult.rowPassed,
            sourceSha: request.sourceSha, eventSha: request.eventSha, runId: request.runId,
            runAttempt: request.runAttempt, nonce: request.nonce, scenarioIndex,
            scenarioId: request.matrix.scenarios[scenarioIndex].id, rowResult, evidence, releaseGatesCleared: []};
        validateWindowsMsiGuestMatrixSemanticResult(semanticResult, request, manifest);
        rows.push({scenarioIndex, scenarioId: semanticResult.scenarioId, rowRequest: retained(request),
            executionManifest: retained(manifest), semanticResult: retained(semanticResult)});
    }
    const expected = {sourceSha: settings.sourceSha, eventSha: settings.eventSha, runId: settings.runId,
        runAttempt: settings.runAttempt,
        candidateManifestSha256: settings.candidateManifestSha256, closureSha256: CLOSURE_SHA,
        fixtureManifestSha256: settings.fixtureManifestSha256,
        rollbackCalibrationSha256: settings.rollbackCalibrationSha256,
        oldContainmentSha256: settings.oldContainmentSha256,
        baseImageSha256: BASE_IMAGE_SHA, probeArtifact: settings.probeArtifact};
    const evidence = {schemaVersion: 1, kind: "myspeed-windows-msi-guest-lifecycle-evidence",
        status: "completed", qualifying: false, ...expected, rows, releaseGatesCleared: []};
    const evidenceBytes = Buffer.from(JSON.stringify(evidence), "utf8");
    return {expected, evidence, evidenceBytes, evidenceSha256: sha256(evidenceBytes)};
};
