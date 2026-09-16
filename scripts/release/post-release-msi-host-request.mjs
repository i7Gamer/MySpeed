import {createHash} from "node:crypto";
import path from "node:path";

import {validateHostedContext} from "../qualification/linux-kvm-capability.mjs";
import {validateSameJobInstalledBaseSeal} from
    "../qualification/windows-msi-installed-base.mjs";
import {bindWindowsMsiPrerequisiteEvidence, inspectWindowsMsiPrerequisiteEvidence} from
    "../qualification/windows-msi-prerequisite-evidence.mjs";
import {validateWindowsMsiLifecycleBudgetLimits} from
    "../qualification/windows-msi-lifecycle-budget.mjs";
import {buildWindowsMsiGuestSeedDocuments} from "../qualification/windows-msi-guest-seed-documents.mjs";
import {createWindowsMsiMatrixContract} from "../qualification/windows-msi-matrix-contract.mjs";
import {validateWindowsMsiGuestExecutionManifest, validateWindowsMsiGuestMatrixFixtureManifest,
    WINDOWS_MSI_GUEST_PRODUCT_BINDINGS} from "../qualification/windows-msi-guest-matrix-operations.mjs";
import {validateWindowsMsiGuestMatrixRowRequest} from "../qualification/windows-msi-guest-matrix-row.mjs";
import {buildUnboundWindowsMsiLifecycleQemuArguments, WINDOWS_MSI_LIFECYCLE_OUTPUT_DISK_BYTES} from
    "../qualification/linux-windows-msi-lifecycle-host.mjs";
import {
    SCENARIO0_CALIBRATION_REQUEST_KIND,
    SCENARIO0_CALIBRATION_MAX_JOB_MILLISECONDS,
    SCENARIO0_CALIBRATION_MAX_EXECUTION_MILLISECONDS,
    SCENARIO0_CALIBRATION_MAX_CLEANUP_MILLISECONDS,
    SCENARIO0_CALIBRATION_RETENTION_RESERVE_MILLISECONDS,
    SCENARIO0_CALIBRATION_COMMAND_MILLISECONDS,
    SCENARIO0_CALIBRATION_OUTPUT_DISK_BYTES,
    SCENARIO0_CALIBRATION_RESERVATION_LABEL,
    validateWindowsMsiScenario0CalibrationRequest,
    buildWindowsMsiScenario0CalibrationQemuArguments
} from "../qualification/windows-msi-scenario0-calibration.mjs";

const SCENARIO_COUNT = 14;
const ROW_MILLISECONDS = 16_200_000;
const MAX_FILE_BYTES = 1_073_741_824;
const SHA256 = /^[0-9a-f]{64}$/u;
const POSIX_RELATIVE = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u;
const CPU_REQUIREMENTS = Object.freeze({sse42: true, popcnt: true, osxsave: true, avx: true, avx2: true,
    xcr0RequiredMask: "0000000000000006"});
const CLOSURE_SOURCES = Object.freeze([
    ["matrixRunner", "windows-msi-guest-matrix-executor.mjs"],
    ["matrixOperations", "windows-msi-guest-matrix-operations.mjs"],
    ["matrixRow", "windows-msi-guest-matrix-row.mjs"],
    ["matrixContract", "windows-msi-matrix-contract.mjs"],
    ["launcher", "media-job-launcher.ps1"],
    ["runner", "windows-msi-guest-runner.ps1"],
    ["oracle", "check-artifact.mjs"],
    ["oracleSafety", "safety.mjs"],
    ["oracleFixture", "fixture.mjs"],
    ["sqlite", "sqlite-check.mjs"],
    ["rollback", "windows-msi-guest-rollback.ps1"],
    ["containment", "windows-msi-guest-containment.ps1"]
]);
const SOURCE_NAMES = Object.freeze(["node", "cpuid", ...CLOSURE_SOURCES.map(([name]) => name)]);
const PROVISIONAL_MEDIA_SHA256 = "0".repeat(64);
const DESTINATION_SENTINEL = "fixture/populated/destination.sentinel";
const LEGACY_SENTINEL = "fixture/legacy/legacy.sentinel";

const sha256 = value => createHash("sha256").update(value).digest("hex");
const clone = value => structuredClone(value);
const freeze = value => {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) freeze(child);
    return Object.freeze(value);
};
const object = (value, label) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} differs`);
};
const exactKeys = (value, keys, label) => {
    object(value, label); const actual = Object.keys(value).sort(); const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
        throw new TypeError(`${label} keys differ`);
};
const hash = (value, label) => {
    if (typeof value !== "string" || SHA256.exec(value)?.[0] !== value) throw new TypeError(`${label} differs`);
    return value;
};
const bytes = (value, label, allowEmpty = false) => {
    const parsed = typeof value === "string" && /^(?:0|[1-9][0-9]{0,15})$/u.test(value) ? Number(value) : value;
    if (!Number.isSafeInteger(parsed) || parsed < (allowEmpty ? 0 : 1) || parsed > MAX_FILE_BYTES)
        throw new TypeError(`${label} differs`);
    return parsed;
};
const sourceIdentity = (value, label, allowEmpty = false) => {
    exactKeys(value, ["path", "bytes", "sha256"], label);
    if (typeof value.path !== "string" || !path.posix.isAbsolute(value.path)
        || path.posix.normalize(value.path) !== value.path) throw new TypeError(`${label} path differs`);
    const size = bytes(value.bytes, `${label} bytes`, allowEmpty);
    hash(value.sha256, `${label} SHA-256`);
    return {path: value.path, bytes: size, sha256: value.sha256};
};
const retainedJson = (value, root, name) => {
    const data = Buffer.from(JSON.stringify(value), "utf8");
    return {path: `${root}/${name}`, bytes: data.length, sha256: sha256(data), bytesBase64: data.toString("base64")};
};
const decodeManifest = value => {
    exactKeys(value, ["path", "bytes", "sha256", "bytesBase64"], "MSI fixture manifest source");
    const identity = sourceIdentity({path: value.path, bytes: value.bytes, sha256: value.sha256},
        "MSI fixture manifest source");
    const data = Buffer.from(value.bytesBase64, "base64");
    if (data.toString("base64") !== value.bytesBase64 || data.length !== identity.bytes
        || sha256(data) !== identity.sha256) throw new TypeError("MSI fixture manifest bytes differ");
    return JSON.parse(new TextDecoder("utf8", {fatal: true}).decode(data));
};

const inspectV161PostReleaseMsiHostFixture = (value, expectedContext) => {
    const context = validateHostedContext(expectedContext);
    exactKeys(value, ["manifest", "execution", "files"], "post-release MSI fixture");
    const fixtureManifest = decodeManifest(value.manifest);
    exactKeys(value.execution, ["sourceSha", "populatedRoot", "manifestPath", "manifestSha256", "legacyRoot",
        "populatedMarkerSha256", "populatedDatabaseSha256", "populatedFilesSha256",
        "destinationSentinelSha256", "legacySentinelSha256", "expected"],
    "post-release MSI fixture execution");
    if (value.execution.sourceSha !== fixtureManifest.source.commit
        || value.execution.manifestSha256 !== value.manifest.sha256
        || value.execution.populatedMarkerSha256 !== fixtureManifest.populated.markerSha256
        || value.execution.populatedDatabaseSha256 !== fixtureManifest.populated.databaseSha256
        || JSON.stringify(value.execution.populatedFilesSha256) !== JSON.stringify(fixtureManifest.populated.filesSha256)
        || JSON.stringify(value.execution.expected) !== JSON.stringify(fixtureManifest.expected))
        throw new TypeError("post-release MSI fixture execution differs");
    hash(value.execution.destinationSentinelSha256, "post-release MSI destination sentinel");
    hash(value.execution.legacySentinelSha256, "post-release MSI legacy sentinel");
    const candidateFixtureNames = Object.keys(fixtureManifest.populated?.filesSha256 ?? {})
        .map(name => `fixture/populated/${name}`);
    const expectedFixtureNames = [...candidateFixtureNames, DESTINATION_SENTINEL, LEGACY_SENTINEL];
    if (!Array.isArray(value.files) || value.files.length !== expectedFixtureNames.length)
        throw new TypeError("post-release MSI fixture files differ");
    const fixtureFiles = value.files.map((file, index) => {
        exactKeys(file, ["name", "sourceRole", "sourceSha", "sourcePath", "bytes", "sha256"],
            "post-release MSI fixture file");
        const allowEmpty = file.name === "fixture/populated/data/storage.db-wal";
        const candidate = index < candidateFixtureNames.length;
        if (file.name !== expectedFixtureNames[index] || POSIX_RELATIVE.exec(file.name)?.[0] !== file.name
            || file.sourceRole !== (candidate ? "candidate" : "harness")
            || file.sourceSha !== (candidate ? fixtureManifest.source.commit : context.sourceSha))
            throw new TypeError("post-release MSI fixture file name differs");
        const source = sourceIdentity({path: file.sourcePath, bytes: file.bytes, sha256: file.sha256},
            "post-release MSI fixture file", allowEmpty);
        if (source.bytes === 0 && (!allowEmpty
            || source.sha256 !== "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"))
            throw new TypeError("post-release MSI empty fixture file differs");
        if (candidate && fixtureManifest.populated.filesSha256[file.name.slice("fixture/populated/".length)]
            !== source.sha256) throw new TypeError("post-release MSI candidate fixture identity differs");
        if (file.name === DESTINATION_SENTINEL
            && source.sha256 !== value.execution.destinationSentinelSha256)
            throw new TypeError("post-release MSI destination sentinel differs");
        if (file.name === LEGACY_SENTINEL && source.sha256 !== value.execution.legacySentinelSha256)
            throw new TypeError("post-release MSI legacy sentinel differs");
        return {...file, bytes: source.bytes};
    });
    return {fixtureManifest, fixtureFiles};
};

export const validateV161PostReleaseMsiHostFixture = (value, expectedContext) => {
    inspectV161PostReleaseMsiHostFixture(value, expectedContext);
    return freeze(clone(value));
};
const rowPaths = (taskRoot, hostNonce, scenarioIndex) => {
    const nonce = sha256(Buffer.from(`${hostNonce}\0msi-lifecycle\0${scenarioIndex}`, "utf8")).slice(0, 32);
    const rowRoot = `${taskRoot}/row-${String(scenarioIndex).padStart(2, "0")}-${nonce}`;
    return {nonce, rowRoot, seedRoot: `${rowRoot}/seed`, overlayPath: `${rowRoot}/system-overlay.qcow2`,
        seedIsoPath: `${rowRoot}/seed.iso`, outputDiskPath: `${rowRoot}/output.img`,
        guestResultPath: `${rowRoot}/guest-result.json`, serialLogPath: `${rowRoot}/serial.log`,
        pidPath: `${rowRoot}/qemu.pid`, ovmfVarsPath: `${rowRoot}/OVMF_VARS.fd`};
};

export const buildV161PostReleaseMsiHostRequest = async (input, resolveQemuLaunchSha256) => {
    exactKeys(input, ["context", "taskRoot", "toolchain", "installedBaseSeal", "candidateManifestSha256",
        "probeArtifact", "prerequisiteEvidence", "artifacts", "fixture",
        "sources", "budget", "wallDeadlineUnixMilliseconds"], "post-release MSI request input");
    if (typeof resolveQemuLaunchSha256 !== "function") throw new TypeError("QEMU launch resolver is absent");
    const context = validateHostedContext(input.context);
    const seal = validateSameJobInstalledBaseSeal(input.installedBaseSeal, context);
    if (typeof input.taskRoot !== "string" || path.posix.normalize(input.taskRoot) !== input.taskRoot
        || !input.taskRoot.endsWith(`/myspeed-windows-msi-${context.nonce}`))
        throw new TypeError("post-release MSI task root differs");
    hash(input.candidateManifestSha256, "candidate manifest");
    /*
     * The rollback-calibration and old-containment prerequisites arrive as their producers' retained
     * documents rather than as digests a caller chose. Inspecting them here is what makes the two
     * digests the rows carry mean anything: they are the SHA-256 of bytes whose typed acceptance
     * semantics were just replayed, and the same bytes travel with the request so an independent
     * consumer reaches the same conclusion without trusting this builder.
     */
    exactKeys(input.prerequisiteEvidence, ["rollbackCalibration", "oldContainment"],
        "post-release MSI prerequisite evidence");
    const prerequisites = bindWindowsMsiPrerequisiteEvidence({
        rollbackCalibration: input.prerequisiteEvidence.rollbackCalibration,
        oldContainment: input.prerequisiteEvidence.oldContainment,
        context: {repository: context.repository, sourceSha: context.sourceSha, eventSha: context.eventSha,
            runId: context.runId, runAttempt: context.runAttempt, nonce: context.nonce}});
    if (!Number.isSafeInteger(input.wallDeadlineUnixMilliseconds) || input.wallDeadlineUnixMilliseconds < 1)
        throw new TypeError("post-release MSI wall deadline differs");
    if (!Array.isArray(input.artifacts) || input.artifacts.length !== WINDOWS_MSI_GUEST_PRODUCT_BINDINGS.length)
        throw new TypeError("post-release MSI artifacts differ");
    const artifactSources = input.artifacts.map((item, index) => {
        exactKeys(item, ["bindingId", "sourcePath", "bytes", "sha256", "productCode", "exeBytes", "exeSha256",
            "configurationSha256", "serviceWrapperSha256"], "post-release MSI artifact");
        if (item.bindingId !== WINDOWS_MSI_GUEST_PRODUCT_BINDINGS[index])
            throw new TypeError("post-release MSI artifact order differs");
        const source = sourceIdentity({path: item.sourcePath, bytes: item.bytes, sha256: item.sha256},
            "post-release MSI artifact source");
        return {item, source};
    });
    exactKeys(input.sources, SOURCE_NAMES, "post-release MSI sources");
    const sources = Object.fromEntries(SOURCE_NAMES.map(name => [name, sourceIdentity(input.sources[name],
        `post-release MSI ${name}`)]));
    const {fixtureManifest, fixtureFiles} = inspectV161PostReleaseMsiHostFixture(input.fixture, context);
    const cpuid = input.probeArtifact?.files?.find(file => file.role === "cpuid");
    if (!cpuid) throw new TypeError("post-release MSI CPUID probe differs");
    const matrix = createWindowsMsiMatrixContract();
    const closureSha256 = sha256(Buffer.from(JSON.stringify(sources), "utf8"));
    const buildRow = (scenario, scenarioIndex, launchHash) => {
        const host = rowPaths(input.taskRoot, context.nonce, scenarioIndex);
        const seedRoot = `C:\\Windows\\Temp\\myspeed-msi-input-${host.nonce}`;
        const outputRoot = `C:\\Windows\\Temp\\myspeed-msi-output-${host.nonce}`;
        const overlayReceiptSha256 = sha256(Buffer.from(JSON.stringify({path: host.overlayPath, format: "qcow2",
            backingFilename: seal.image.path, backingBaseSha256: seal.image.sha256}), "utf8"));
        const request = {schemaVersion: 2, kind: "myspeed-windows-msi-guest-matrix-row-request",
            qualifying: false, sourceSha: context.sourceSha, eventSha: context.eventSha, runId: context.runId,
            runAttempt: context.runAttempt, nonce: host.nonce, scenarioIndex, matrix,
            guest: {profile: "modern-msi-v1", serial: host.nonce, qemuCpuModel: "host", evidenceRoot: outputRoot,
                baseImageSha256: seal.image.sha256,
                overlayNonce: sha256(Buffer.from(`${context.nonce}\0overlay\0${scenarioIndex}`)).slice(0, 32),
                overlayReceiptSha256, qemuLaunchSha256: launchHash,
                cpuEvidenceSha256: sha256(Buffer.from(JSON.stringify(CPU_REQUIREMENTS))),
                cpuRequirements: clone(CPU_REQUIREMENTS)},
            prerequisites: {closureSha256, candidateManifestSha256: input.candidateManifestSha256,
                fixtureManifestSha256: input.fixture.manifest.sha256,
                rollbackCalibrationSha256: prerequisites.rollbackCalibrationSha256,
                oldContainmentSha256: prerequisites.oldContainmentSha256}};
        validateWindowsMsiGuestMatrixRowRequest(request);
        const systemTools = new Map(seal.source.systemTools.map(tool => [tool.role, tool]));
        const tool = role => { const value = systemTools.get(role); return {path: value.path,
            bytes: bytes(value.bytes, `${role} bytes`), sha256: value.sha256}; };
        const execution = {seedRoot, outputRoot, programFilesRoot: "C:\\Program Files",
            programDataRoot: "C:\\ProgramData", installRoot: "C:\\Program Files\\MySpeed",
            installedExePath: "C:\\Program Files\\MySpeed\\MySpeed.exe",
            configurationPath: "C:\\Program Files\\MySpeed\\MySpeedService.xml",
            serviceWrapperPath: "C:\\Program Files\\MySpeed\\MySpeedService.exe",
            dataRoot: "C:\\ProgramData\\MySpeed", databasePath: "C:\\ProgramData\\MySpeed\\data\\storage.db",
            legacyDataRoot: "C:\\Program Files\\MySpeed\\data", serviceName: "MySpeed",
            origin: "http://127.0.0.1:5216", probeArtifact: clone(input.probeArtifact),
            tools: {msiexec: tool("msiexec"), sc: tool("sc"), powershell: tool("powershell"),
                node: {path: `${seedRoot}\\node.exe`, bytes: input.sources.node?.bytes, sha256: input.sources.node?.sha256},
                cpuid: {path: `${seedRoot}\\cpuid.exe`, bytes: Number(cpuid.bytes), sha256: cpuid.sha256}},
            helpers: Object.fromEntries([["oracle", "check-artifact.mjs"], ["sqlite", "sqlite-check.mjs"],
                ["rollback", "windows-msi-guest-rollback.ps1"],
                ["containment", "windows-msi-guest-containment.ps1"]].map(([name, destination]) => [name,
                {path: `${seedRoot}\\${destination}`, bytes: sources[name].bytes,
                    sha256: sources[name].sha256}])),
            artifacts: artifactSources.map(({item}) => ({bindingId: item.bindingId,
                path: `${seedRoot}\\${item.bindingId}.msi`, bytes: bytes(item.bytes, "artifact bytes"),
                sha256: item.sha256, productCode: item.productCode, exeBytes: item.exeBytes,
                exeSha256: item.exeSha256, configurationSha256: item.configurationSha256,
                serviceWrapperSha256: item.serviceWrapperSha256})),
            fixture: clone(input.fixture.execution),
            limits: {processMilliseconds: 900_000, streamBytes: 65_536, evidenceBytes: 1_048_576}};
        execution.fixture.populatedRoot = `${seedRoot}\\fixture\\populated`;
        execution.fixture.manifestPath = `${seedRoot}\\fixture.json`;
        execution.fixture.legacyRoot = `${seedRoot}\\legacy`;
        validateWindowsMsiGuestExecutionManifest(execution);
        const observedInventory = Object.fromEntries(fixtureFiles.filter(file => file.sourceRole === "candidate")
            .map(file => [file.name.slice("fixture/populated/".length), file.sha256]));
        validateWindowsMsiGuestMatrixFixtureManifest(fixtureManifest, execution, request, observedInventory);
        const documents = buildWindowsMsiGuestSeedDocuments({rowRequest: request, executionManifest: execution,
            matrixRunner: {path: `${seedRoot}\\windows-msi-guest-matrix-executor.mjs`,
                bytes: sources.matrixRunner.bytes, sha256: sources.matrixRunner.sha256},
            launcher: {path: `${seedRoot}\\media-job-launcher.ps1`, bytes: sources.launcher.bytes,
                sha256: sources.launcher.sha256}, observerSha256: sources.launcher.sha256,
            wallDeadlineUnixMilliseconds: input.wallDeadlineUnixMilliseconds});
        const retain = (name, value) => ({path: `${host.seedRoot}/${name}`, bytes: value.bytes,
            sha256: value.sha256, bytesBase64: value.bytesBase64});
        const seedFiles = [{name: "node.exe", sourcePath: input.sources.node.path,
            bytes: String(input.sources.node.bytes), sha256: input.sources.node.sha256},
        {name: "cpuid.exe", sourcePath: input.sources.cpuid.path, bytes: String(input.sources.cpuid.bytes),
            sha256: input.sources.cpuid.sha256}, ...CLOSURE_SOURCES.map(([name, destination]) => ({name: destination,
            sourcePath: sources[name].path, bytes: String(sources[name].bytes), sha256: sources[name].sha256})),
        ...artifactSources.map(({item, source}) => ({name: `${item.bindingId}.msi`, sourcePath: source.path,
            bytes: String(source.bytes), sha256: source.sha256})),
        {name: "fixture.json", sourcePath: input.fixture.manifest.path, bytes: String(input.fixture.manifest.bytes),
            sha256: input.fixture.manifest.sha256}, ...fixtureFiles.map(file => ({name: file.name,
            sourcePath: file.sourcePath, bytes: String(file.bytes), sha256: file.sha256}))];
        return {scenarioIndex, scenarioId: scenario.id, ...host,
            rowRequest: retain("row-request.json", documents.rowRequest),
            executionManifest: retain("execution-manifest.json", documents.executionManifest),
            guestEnvelope: retain("matrix-envelope.json", documents.envelope),
            launcherRequest: retain("launch-request.json", documents.launcherRequest), seedFiles};
    };
    const buildRows = launchHashes => matrix.scenarios.map((scenario, scenarioIndex) =>
        buildRow(scenario, scenarioIndex, launchHashes[scenarioIndex]));
    const baseImage = {path: seal.image.path, bytes: seal.image.bytes, sha256: seal.image.sha256,
        ownership: clone(seal.image.ownership)};
    const buildRequest = rows => ({schemaVersion: 1, kind: "myspeed-windows-msi-lifecycle-host-request",
        qualifying: false, context: clone(context), privilegeMode: "reviewed-sudo-kvm",
        repository: context.repository, sourceSha: context.sourceSha, eventSha: context.eventSha,
        runId: context.runId, runAttempt: context.runAttempt, nonce: context.nonce, taskRoot: input.taskRoot,
        expected: {sourceSha: context.sourceSha, eventSha: context.eventSha, runId: context.runId,
            runAttempt: context.runAttempt, candidateManifestSha256: input.candidateManifestSha256,
            closureSha256, fixtureManifestSha256: input.fixture.manifest.sha256,
            rollbackCalibrationSha256: prerequisites.rollbackCalibrationSha256,
            oldContainmentSha256: prerequisites.oldContainmentSha256, baseImageSha256: seal.image.sha256,
            probeArtifact: clone(input.probeArtifact)}, candidateProvenance: null,
        prerequisiteEvidence: clone(prerequisites.records),
        toolchain: clone(input.toolchain), toolchainSha256: sha256(Buffer.from(JSON.stringify(input.toolchain))),
        baseImage: clone(baseImage), rows,
        limits: {outputDiskBytes: WINDOWS_MSI_LIFECYCLE_OUTPUT_DISK_BYTES, rowMilliseconds: ROW_MILLISECONDS,
            budget: validateWindowsMsiLifecycleBudgetLimits(input.budget)}});
    const provisional = freeze(buildRequest(buildRows(Array(SCENARIO_COUNT).fill("0".repeat(64)))));
    const launchHashes = await resolveQemuLaunchSha256(provisional);
    if (!Array.isArray(launchHashes) || launchHashes.length !== SCENARIO_COUNT)
        throw new TypeError("post-release MSI QEMU launch hashes differ");
    launchHashes.forEach((value, index) => hash(value, `QEMU launch hash ${index}`));
    return freeze(buildRequest(buildRows(launchHashes)));
};

export const buildV161PostReleaseMsiScenario0CalibrationHostRequest = async (input, resolveQemuLaunchSha256 = resolveV161PostReleaseMsiScenario0CalibrationQemuLaunchSha256) => {
    const optionalKeys = [];
    if (input.prerequisites !== undefined) optionalKeys.push("prerequisites");
    if (input.prerequisiteEvidence !== undefined) optionalKeys.push("prerequisiteEvidence");
    exactKeys(input, ["context", "taskRoot", "toolchain", "installedBaseSeal", "candidateManifestSha256",
        "probeArtifact", "budget", "artifacts", "fixture", "sources", "wallDeadlineUnixMilliseconds",
        "candidateProvenance", ...optionalKeys],
    "post-release MSI scenario0 calibration host request input");
    const context = validateHostedContext(input.context);
    const seal = validateSameJobInstalledBaseSeal(input.installedBaseSeal, context);
    const toolchainSha256 = sha256(Buffer.from(JSON.stringify(input.toolchain)));
    if (!Number.isSafeInteger(input.wallDeadlineUnixMilliseconds) || input.wallDeadlineUnixMilliseconds < 1)
        throw new TypeError("post-release MSI wall deadline differs");
    if (!Array.isArray(input.artifacts) || input.artifacts.length !== WINDOWS_MSI_GUEST_PRODUCT_BINDINGS.length)
        throw new TypeError("post-release MSI artifacts differ");
    const artifactSources = input.artifacts.map((item, index) => {
        exactKeys(item, ["bindingId", "sourcePath", "bytes", "sha256", "productCode", "exeBytes", "exeSha256",
            "configurationSha256", "serviceWrapperSha256"], "post-release MSI artifact");
        if (item.bindingId !== WINDOWS_MSI_GUEST_PRODUCT_BINDINGS[index])
            throw new TypeError("post-release MSI artifact order differs");
        const source = sourceIdentity({path: item.sourcePath, bytes: item.bytes, sha256: item.sha256},
            "post-release MSI artifact source");
        return {item, source};
    });
    exactKeys(input.sources, SOURCE_NAMES, "post-release MSI sources");
    const sources = Object.fromEntries(SOURCE_NAMES.map(name => [name, sourceIdentity(input.sources[name],
        `post-release MSI ${name}`)]));
    const {fixtureManifest, fixtureFiles} = inspectV161PostReleaseMsiHostFixture(input.fixture, context);
    const cpuid = input.probeArtifact?.files?.find(file => file.role === "cpuid");
    if (!cpuid) throw new TypeError("post-release MSI CPUID probe differs");
    const matrix = createWindowsMsiMatrixContract();
    const closureSha256 = sha256(Buffer.from(JSON.stringify(sources), "utf8"));
    let rollbackCalibrationSha256 = "0".repeat(64);
    if (input.prerequisiteEvidence?.rollbackCalibration) {
        const inspected = inspectWindowsMsiPrerequisiteEvidence({
            name: "rollbackCalibration",
            value: input.prerequisiteEvidence.rollbackCalibration,
            context: {
                repository: context.repository, sourceSha: context.sourceSha,
                eventSha: context.eventSha, runId: context.runId,
                runAttempt: context.runAttempt, nonce: context.nonce
            }
        });
        rollbackCalibrationSha256 = inspected.sha256;
    }
    const prerequisites = input.prerequisites ?? {
        rollbackCalibrationSha256,
        oldContainmentSha256: "0".repeat(64)
    };
    const host = rowPaths(input.taskRoot, context.nonce, 0);
    const seedRoot = `C:\\Windows\\Temp\\myspeed-msi-input-${host.nonce}`;
    const outputRoot = `C:\\Windows\\Temp\\myspeed-msi-output-${host.nonce}`;
    const overlayReceiptSha256 = sha256(Buffer.from(JSON.stringify({path: host.overlayPath, format: "qcow2",
        backingFilename: seal.image.path, backingBaseSha256: seal.image.sha256}), "utf8"));

    const buildRow0 = launchHash => {
        const request = {schemaVersion: 2, kind: "myspeed-windows-msi-guest-matrix-row-request",
            qualifying: false, sourceSha: context.sourceSha, eventSha: context.eventSha, runId: context.runId,
            runAttempt: context.runAttempt, nonce: host.nonce, scenarioIndex: 0, matrix,
            guest: {profile: "modern-msi-v1", serial: host.nonce, qemuCpuModel: "host", evidenceRoot: outputRoot,
                baseImageSha256: seal.image.sha256,
                overlayNonce: sha256(Buffer.from(`${context.nonce}\0overlay\0${0}`)).slice(0, 32),
                overlayReceiptSha256, qemuLaunchSha256: launchHash,
                cpuEvidenceSha256: sha256(Buffer.from(JSON.stringify(CPU_REQUIREMENTS))),
                cpuRequirements: clone(CPU_REQUIREMENTS)},
            prerequisites: {closureSha256, candidateManifestSha256: input.candidateManifestSha256,
                fixtureManifestSha256: input.fixture.manifest.sha256,
                rollbackCalibrationSha256: prerequisites.rollbackCalibrationSha256,
                oldContainmentSha256: prerequisites.oldContainmentSha256}};
        validateWindowsMsiGuestMatrixRowRequest(request);
        const systemTools = new Map(seal.source.systemTools.map(tool => [tool.role, tool]));
        const tool = role => { const value = systemTools.get(role); return {path: value.path,
            bytes: bytes(value.bytes, `${role} bytes`), sha256: value.sha256}; };
        const execution = {seedRoot, outputRoot, programFilesRoot: "C:\\Program Files",
            programDataRoot: "C:\\ProgramData", installRoot: "C:\\Program Files\\MySpeed",
            installedExePath: "C:\\Program Files\\MySpeed\\MySpeed.exe",
            configurationPath: "C:\\Program Files\\MySpeed\\MySpeedService.xml",
            serviceWrapperPath: "C:\\Program Files\\MySpeed\\MySpeedService.exe",
            dataRoot: "C:\\ProgramData\\MySpeed", databasePath: "C:\\ProgramData\\MySpeed\\data\\storage.db",
            legacyDataRoot: "C:\\Program Files\\MySpeed\\data", serviceName: "MySpeed",
            origin: "http://127.0.0.1:5216", probeArtifact: clone(input.probeArtifact),
            tools: {msiexec: tool("msiexec"), sc: tool("sc"), powershell: tool("powershell"),
                node: {path: `${seedRoot}\\node.exe`, bytes: input.sources.node?.bytes, sha256: input.sources.node?.sha256},
                cpuid: {path: `${seedRoot}\\cpuid.exe`, bytes: Number(cpuid.bytes), sha256: cpuid.sha256}},
            helpers: Object.fromEntries([["oracle", "check-artifact.mjs"], ["sqlite", "sqlite-check.mjs"],
                ["rollback", "windows-msi-guest-rollback.ps1"],
                ["containment", "windows-msi-guest-containment.ps1"]].map(([name, destination]) => [name,
                {path: `${seedRoot}\\${destination}`, bytes: sources[name].bytes,
                    sha256: sources[name].sha256}])),
            artifacts: artifactSources.map(({item}) => ({bindingId: item.bindingId,
                path: `${seedRoot}\\${item.bindingId}.msi`, bytes: bytes(item.bytes, "artifact bytes"),
                sha256: item.sha256, productCode: item.productCode, exeBytes: item.exeBytes,
                exeSha256: item.exeSha256, configurationSha256: item.configurationSha256,
                serviceWrapperSha256: item.serviceWrapperSha256})),
            fixture: clone(input.fixture.execution),
            limits: {processMilliseconds: 900_000, streamBytes: 65_536, evidenceBytes: 1_048_576}};
        execution.fixture.populatedRoot = `${seedRoot}\\fixture\\populated`;
        execution.fixture.manifestPath = `${seedRoot}\\fixture.json`;
        execution.fixture.legacyRoot = `${seedRoot}\\legacy`;
        validateWindowsMsiGuestExecutionManifest(execution);
        const observedInventory = Object.fromEntries(fixtureFiles.filter(file => file.sourceRole === "candidate")
            .map(file => [file.name.slice("fixture/populated/".length), file.sha256]));
        validateWindowsMsiGuestMatrixFixtureManifest(fixtureManifest, execution, request, observedInventory);
        const documents = buildWindowsMsiGuestSeedDocuments({rowRequest: request, executionManifest: execution,
            matrixRunner: {path: `${seedRoot}\\windows-msi-guest-matrix-executor.mjs`,
                bytes: sources.matrixRunner.bytes, sha256: sources.matrixRunner.sha256},
            launcher: {path: `${seedRoot}\\media-job-launcher.ps1`, bytes: sources.launcher.bytes,
                sha256: sources.launcher.sha256}, observerSha256: sources.launcher.sha256,
            wallDeadlineUnixMilliseconds: input.wallDeadlineUnixMilliseconds});
        const retain = (name, value) => ({path: `${host.seedRoot}/${name}`, bytes: value.bytes,
            sha256: value.sha256, bytesBase64: value.bytesBase64});
        const seedFiles = [{name: "node.exe", sourcePath: input.sources.node.path,
            bytes: String(input.sources.node.bytes), sha256: input.sources.node.sha256},
        {name: "cpuid.exe", sourcePath: input.sources.cpuid.path, bytes: String(input.sources.cpuid.bytes),
            sha256: input.sources.cpuid.sha256}, ...CLOSURE_SOURCES.map(([name, destination]) => ({name: destination,
            sourcePath: sources[name].path, bytes: String(sources[name].bytes), sha256: sources[name].sha256})),
        ...artifactSources.map(({item, source}) => ({name: `${item.bindingId}.msi`, sourcePath: source.path,
            bytes: String(source.bytes), sha256: source.sha256})),
        {name: "fixture.json", sourcePath: input.fixture.manifest.path, bytes: String(input.fixture.manifest.bytes),
            sha256: input.fixture.manifest.sha256}, ...fixtureFiles.map(file => ({name: file.name,
            sourcePath: file.sourcePath, bytes: String(file.bytes), sha256: file.sha256}))];
        return {scenarioIndex: 0, scenarioId: matrix.scenarios[0].id, ...host,
            rowRequest: retain("row-request.json", documents.rowRequest),
            executionManifest: retain("execution-manifest.json", documents.executionManifest),
            guestEnvelope: retain("matrix-envelope.json", documents.envelope),
            launcherRequest: retain("launch-request.json", documents.launcherRequest), seedFiles};
    };

    const baseImage = {path: seal.image.path, bytes: seal.image.bytes, sha256: seal.image.sha256,
        ownership: clone(seal.image.ownership)};
    const execAllowance = Math.min(input.budget.rowAllowanceMilliseconds ?? input.budget.maxExecutionMilliseconds ?? SCENARIO0_CALIBRATION_MAX_EXECUTION_MILLISECONDS,
        SCENARIO0_CALIBRATION_MAX_EXECUTION_MILLISECONDS);
    const jobBudget = Math.min(input.budget.jobBudgetMilliseconds, SCENARIO0_CALIBRATION_MAX_JOB_MILLISECONDS);

    const buildRequest = row => ({
        schemaVersion: 1,
        kind: SCENARIO0_CALIBRATION_REQUEST_KIND,
        qualifying: false,
        sourceSha: context.sourceSha,
        eventSha: context.eventSha,
        runId: context.runId,
        runAttempt: context.runAttempt,
        nonce: context.nonce,
        toolchainSha256,
        context: clone(context),
        limits: {
            jobBudgetMilliseconds: jobBudget,
            maxExecutionMilliseconds: SCENARIO0_CALIBRATION_MAX_EXECUTION_MILLISECONDS,
            maxCleanupMilliseconds: SCENARIO0_CALIBRATION_MAX_CLEANUP_MILLISECONDS,
            retentionReserveMilliseconds: SCENARIO0_CALIBRATION_RETENTION_RESERVE_MILLISECONDS,
            commandMilliseconds: SCENARIO0_CALIBRATION_COMMAND_MILLISECONDS,
            outputDiskBytes: SCENARIO0_CALIBRATION_OUTPUT_DISK_BYTES
        },
        reservation: {
            label: SCENARIO0_CALIBRATION_RESERVATION_LABEL,
            executionMilliseconds: execAllowance,
            cleanupMilliseconds: SCENARIO0_CALIBRATION_MAX_CLEANUP_MILLISECONDS
        },
        toolchain: clone(input.toolchain),
        baseImage: clone(baseImage),
        candidateProvenance: clone(input.candidateProvenance),
        expected: {
            sourceSha: context.sourceSha,
            eventSha: context.eventSha,
            runId: context.runId,
            runAttempt: context.runAttempt,
            candidateManifestSha256: input.candidateManifestSha256,
            closureSha256,
            fixtureManifestSha256: input.fixture.manifest.sha256,
            baseImageSha256: seal.image.sha256,
            probeArtifact: clone(input.probeArtifact)
        },
        row,
        installedBaseSeal: clone(seal),
        /*
         * The deadline the whole job is held to, fixed before this controller started and therefore
         * already carrying the setup it never saw. It travels in the request so the budget the
         * operations run under is the one a reader of the retained document can recompute.
         */
        wallDeadlineUnixMilliseconds: input.wallDeadlineUnixMilliseconds
    });

    const provisional = freeze(buildRequest(buildRow0("0".repeat(64))));
    const launchHash = await resolveQemuLaunchSha256(provisional);
    hash(launchHash, "Scenario 0 calibration QEMU launch hash");
    return freeze(validateWindowsMsiScenario0CalibrationRequest(buildRequest(buildRow0(launchHash))));
};

export const resolveV161PostReleaseMsiScenario0CalibrationQemuLaunchSha256 = provisionalRequest => {
    const request = freeze(clone(provisionalRequest));
    const row = request.row;
    const rowRequest = JSON.parse(Buffer.from(row.rowRequest.bytesBase64, "base64"));
    const overlay = {
        path: row.overlayPath, format: "qcow2",
        backingBaseSha256: request.baseImage.sha256, createNew: true,
        receiptSha256: rowRequest.guest.overlayReceiptSha256
    };
    const media = {
        seed: {
            path: row.seedIsoPath, bytes: "1", sha256: PROVISIONAL_MEDIA_SHA256,
            manifestSha256: PROVISIONAL_MEDIA_SHA256, readOnly: true, volumeLabel: "MYSPEEDSEED"
        },
        outputBefore: {
            path: row.outputDiskPath, bytes: String(SCENARIO0_CALIBRATION_OUTPUT_DISK_BYTES),
            sha256: PROVISIONAL_MEDIA_SHA256, createNew: true, volumeLabel: "MYSPEEDOUT"
        },
        ovmfVarsSha256: request.toolchain.ovmfVarsTemplate.sha256
    };
    const argv = buildWindowsMsiScenario0CalibrationQemuArguments({request, row, overlay, media});
    return sha256(Buffer.from(JSON.stringify(argv), "utf8"));
};


export const resolveV161PostReleaseMsiQemuLaunchSha256 = provisionalRequest => {
    const request = freeze(clone(provisionalRequest));
    return freeze(request.rows.map(row => {
        const rowRequest = JSON.parse(Buffer.from(row.rowRequest.bytesBase64, "base64"));
        const overlay = {path: row.overlayPath, format: "qcow2",
            backingBaseSha256: request.baseImage.sha256, createNew: true,
            receiptSha256: rowRequest.guest.overlayReceiptSha256};
        const media = {seed: {path: row.seedIsoPath, bytes: "1", sha256: PROVISIONAL_MEDIA_SHA256,
            manifestSha256: PROVISIONAL_MEDIA_SHA256, readOnly: true, volumeLabel: "MYSPEEDSEED"},
        outputBefore: {path: row.outputDiskPath, bytes: String(WINDOWS_MSI_LIFECYCLE_OUTPUT_DISK_BYTES),
            sha256: PROVISIONAL_MEDIA_SHA256, createNew: true, volumeLabel: "MYSPEEDOUT"},
        ovmfVarsSha256: request.toolchain.ovmfVarsTemplate.sha256};
        const argv = buildUnboundWindowsMsiLifecycleQemuArguments({request, row, overlay, media});
        return sha256(Buffer.from(JSON.stringify(argv), "utf8"));
    }));
};

export const POST_RELEASE_MSI_HOST_REQUEST_CONSTANTS = Object.freeze({CPU_REQUIREMENTS, ROW_MILLISECONDS,
    SCENARIO_COUNT, DESTINATION_SENTINEL, LEGACY_SENTINEL});
