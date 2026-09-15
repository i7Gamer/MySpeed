/*
 * The complete post-release MSI controller fixture: a published v1.6.1 target, its acquisition plan,
 * a prepared Windows artifact observed exactly as the controller observes it, a sealed installed
 * base, a Stage 2 toolchain and the closure sources.
 *
 * It lives here rather than inside one test because two of them need the same starting state: the
 * host bridge, which checks what the binding does with it, and the preflight integration, which
 * drives the real controller from it. Nothing here runs anything - every observation is injected and
 * every identity is a fixture value.
 */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import fs from "node:fs";
import path from "node:path";


import {createWindowsMsiPrerequisiteEvidenceFixture} from
    "./windows-msi-prerequisite-evidence-fixture.mjs";
import {createWindowsMsiLifecycleHostEvidenceFixture} from
    "./linux-windows-msi-lifecycle-host-fixture.mjs";
import {createV161PostReleaseMsiEnvelope} from
    "../../scripts/release/post-release-msi-envelope.mjs";
import {buildV161PostReleaseMsiAcquisitionPlan, createV161PostReleaseMsiAcquisitionRecord} from
    "../../scripts/release/post-release-msi-acquisition.mjs";
import {prepareV161PostReleaseMsiOnWindows} from
    "../../scripts/release/post-release-msi-hosted-prepare.mjs";
import {buildV161PostReleaseMsiFixturePlan, prepareV161PostReleaseMsiFixturesOnWindows} from
    "../../scripts/release/post-release-msi-fixture-preparation.mjs";
import {buildWindowsMsiSetupCompleteActivation, getCompletedWindowsMsiActivationEvidence} from
    "../../scripts/qualification/windows-msi-post-setup-activation.mjs";
import {WINDOWS_BASELINE_RUNTIME_BUNDLE_CONSTANTS} from
    "../../scripts/qualification/windows-baseline-guest-runtime-bundle.mjs";
import {POST_RELEASE_BASELINE_INPUT_CONSTANTS} from
    "../../scripts/release/post-release-msi-baseline-input-preparation.mjs";
import {createPostReleaseV161HarnessContext, createPostReleaseV161Target,
    POST_RELEASE_V161_HARNESS_SHA} from
    "./post-release-v161-target-fixture.mjs";
import {buildV161PostReleaseMsiArtifactInputs, observeV161PostReleaseMsiPreparation, POST_RELEASE_MSI_LINUX_CONTROLLER_CONSTANTS} from "../../scripts/release/post-release-msi-linux-controller.mjs";

export const HOST_NONCE = "9".repeat(32);
const PNG_BYTES = Buffer.from("89504e470d0a1a0a", "hex");
export const earlyBoot = rowRoot => ({schemaVersion: 1, kind: "qemu-early-boot-observation", inputSent: false,
    version: {major: 9, minor: 2, micro: 1}, status: "running", running: true,
    screenshots: [1, 2].map(index => ({path: `${rowRoot}/early-boot-${index}.png`,
        bytes: String(PNG_BYTES.length), sha256: createHash("sha256").update(PNG_BYTES).digest("hex"),
        bytesBase64: PNG_BYTES.toString("base64")}))});
export const MINUTE = 60_000;
export const JOB_BUDGET = Object.freeze({jobBudgetMilliseconds: 300 * MINUTE,
    rowAllowanceMilliseconds: 15 * MINUTE, rowCleanupMarginMilliseconds: 2 * MINUTE,
    finalMarginMilliseconds: 10 * MINUTE});
export const prerequisiteRecords = context => {
    const {rollbackCalibration, oldContainment} = createWindowsMsiPrerequisiteEvidenceFixture({context});
    return {rollbackCalibration, oldContainment};
};
export const MANIFEST_SHA256 = "7339a6446d048bbae93759734bcafc94208e2b847af15677e847ae9a4b2f8bca";
export const BASE_SHA256 = "d".repeat(64);
export const PREPARED_BASE_SHA256 = "c".repeat(64);
export const PREPARATION_ROOT = "C:\\runner-temp\\myspeed-v1.6.1-msi-a1b2c3d4e5f60718293a4b5c6d7e8f90";
export const EXECUTION_ROOT = `/opt/myspeed/windows-msi/myspeed-windows-msi-${HOST_NONCE}/acquired`;
export const IMAGE_PATH = `/home/runner/work/_temp/myspeed-windows-cpu-floor-${HOST_NONCE}/system.qcow2`;
export const IMAGE_BYTES = "53687091200";
export const IMAGE_VIRTUAL_BYTES = "51539607552";
export const SYSTEM_TOOLS = [
    {role: "msiexec", path: "C:\\Windows\\System32\\msiexec.exe", bytes: "1024", sha256: "8".repeat(64)},
    {role: "sc", path: "C:\\Windows\\System32\\sc.exe", bytes: "2048", sha256: "9".repeat(64)},
    {role: "powershell", path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        bytes: "4096", sha256: "b".repeat(64)}
];

export const harnessContext = () => createPostReleaseV161HarnessContext();
export const hostedContext = () => ({schemaVersion: 1, repository: "i7Gamer/MySpeed",
    sourceSha: POST_RELEASE_V161_HARNESS_SHA, eventSha: POST_RELEASE_V161_HARNESS_SHA,
    runId: "40000000001", runAttempt: "1", nonce: HOST_NONCE,
    environment: {GITHUB_ACTIONS: "true", CI: "true", RUNNER_OS: "Linux", RUNNER_ARCH: "X64",
        RUNNER_ENVIRONMENT: "github-hosted", ImageOS: "ubuntu24", ImageVersion: "20260914.1"}});
export const installedBaseSeal = () => ({schemaVersion: 1,
    kind: "myspeed-stage2-installed-base-same-job-ephemeral", status: "sealed",
    authority: "same-job-ephemeral-identity-only", context: hostedContext(),
    source: {stage2Classification: "github-hosted-windows-cpu-floor-stage2-calibration-nonqualifying",
        activation: getCompletedWindowsMsiActivationEvidence(buildWindowsMsiSetupCompleteActivation({
            repository: hostedContext().repository, sourceSha: hostedContext().sourceSha,
            eventSha: hostedContext().eventSha, runId: hostedContext().runId,
            runAttempt: hostedContext().runAttempt, nonce: hostedContext().nonce})),
        processGroupId: 2001, qemuPid: 2001, qemuStartTicks: "123456",
        guestOutputSha256: "b".repeat(64),
        systemTools: SYSTEM_TOOLS,
        preparedSystemDisk: {bytes: "1048576", sha256: PREPARED_BASE_SHA256}},
    image: {path: IMAGE_PATH, bytes: IMAGE_BYTES, sha256: BASE_SHA256, dev: "2049", ino: "4097",
        kind: "file", ownership: {uid: "0", gid: "0", mode: "444", ordinaryUserWritable: false},
        format: "qcow2", virtualBytes: IMAGE_VIRTUAL_BYTES, backingFilename: null, sealedReadOnly: true}});
const localObservations = plan => plan.files.map(file => ({bindingId: file.bindingId, role: file.role,
    path: file.destinationPath, bytes: file.source.bytes, sha256: file.source.sha256}));
const candidateArtifacts = (plan, fixturePreparation) => ({...Object.fromEntries(plan.files.filter(file => file.role === "msi")
    .map(file => { const payload = file.bindingId === "candidate-default" ? fixturePreparation.candidatePayload
        : file.bindingId === "candidate-baseline" ? fixturePreparation.candidateBaselinePayload
            : fixturePreparation.authenticPayloads.find(item => item.bindingId === file.bindingId)?.payload;
        return [file.bindingId,
        {msi: {bytes: file.source.bytes, sha256: file.source.sha256},
            exe: plan.files.find(item => item.bindingId === file.bindingId && item.role === "exe")?.source ??
                {bytes: payload.exe.bytes, sha256: payload.exe.sha256}, configurationSha256: payload.configuration.sha256,
            serviceWrapperSha256: payload?.wrapper.sha256}];})), ...Object.fromEntries(fixturePreparation.fixtures.map(file =>
    [file.bindingId, {msi: {bytes: file.bytes, sha256: file.sha256},
        exe: {bytes: file.exeBytes, sha256: file.exeSha256},
        productCode: file.productCode,
        configurationSha256: file.configurationSha256,
        serviceWrapperSha256: file.serviceWrapperSha256}]))});
export const decodedExecution = row => JSON.parse(Buffer.from(row.executionManifest.bytesBase64, "base64"));
export const retainedTransportDocument = (name, value) => { const bytes = Buffer.from(`${JSON.stringify(value)}\n`); return {
    path: `${EXECUTION_ROOT}/${name}`, bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"), bytesBase64: bytes.toString("base64")}; };
const baselinePreparation = harness => {
    const paths = ["qualification-manifest.json", "fixture/transport.json",
        ...[".myspeed-qualification.json", ...POST_RELEASE_BASELINE_INPUT_CONSTANTS.FIXTURE_COMMON,
            "data/storage.db"].map(name => `fixture/populated/${name}`),
        ...[".myspeed-qualification.json", ...POST_RELEASE_BASELINE_INPUT_CONSTANTS.FIXTURE_COMMON]
            .map(name => `fixture/reset/${name}`),
        ...[...WINDOWS_BASELINE_RUNTIME_BUNDLE_CONSTANTS.RUNTIME_PATHS,
            "scripts/qualification/windows-baseline-guest-runtime-installer.ps1"]
            .map(name => `runtime/${name}`)];
    return {schemaVersion: 1, kind: "myspeed-v1.6.1-post-release-baseline-input-preparation",
        status: "prepared", authority: "windows-hosted-input-preparation-only",
        candidateSourceSha: POST_RELEASE_BASELINE_INPUT_CONSTANTS.CANDIDATE_SOURCE_SHA,
        harnessSourceSha: harness.sourceSha, files: paths.map((relativePath, index) => {
            const sourceRole = relativePath.startsWith("runtime/") ? "harness" : "candidate";
            return {bindingId: `baseline:${relativePath}`, sourceRole,
                sourceSha: sourceRole === "harness" ? harness.sourceSha
                    : POST_RELEASE_BASELINE_INPUT_CONSTANTS.CANDIDATE_SOURCE_SHA,
                relativePath, bytes: index === 0 ? POST_RELEASE_BASELINE_INPUT_CONSTANTS.MANIFEST_BYTES
                    : 100 + index,
                sha256: index === 0 ? POST_RELEASE_BASELINE_INPUT_CONSTANTS.MANIFEST_SHA256
                    : String((index % 9) + 1).repeat(64)};
        })};
};
const retainedTargetInput = (target, harness) => {
    const {provenance: _runProvenance, ...qualificationRun} = target.originalQualification.run;
    const {provenance: _archiveProvenance, ...qualificationArchive} = target.originalQualification.archive;
    return {tag: {repository: target.candidate.repository, name: target.candidate.tagName,
        commitSha: target.candidate.sourceSha}, qualificationRun, qualificationArchive,
    release: {repository: target.candidate.repository, id: target.publication.releaseId,
        tagName: target.publication.tagName, targetCommitish: "development",
        createdAt: "2026-09-14T09:48:17Z", publishedAt: target.publication.publishedAt,
        draft: false, prerelease: false, platformImmutable: false,
        assets: target.publication.assets.map(({provenance: _provenance, ...asset}) => asset)},
    harnessSourceSha: harness.sourceSha, observedAt: target.observedAt,
    manifestBytesBase64: fs.readFileSync(
        "tests/fixtures/post-release-native-v1.6.1/qualification-manifest.json").toString("base64")};
};
const PRODUCT_INDEX = Object.freeze({"candidate-default": 1, "candidate-baseline": 2,
    "authentic-1.6.0-default-msi": 5, "authentic-1.6.0-baseline-msi": 6,
    "authentic-1.1.0-msi": 7});
const prepare = plan => prepareV161PostReleaseMsiOnWindows(plan, {
    initialize: async () => {}, download: async () => {},
    observe: async file => ({bindingId: file.bindingId, role: file.role, path: file.destinationPath,
        bytes: file.source.bytes, sha256: file.source.sha256}),
    extractZipMember: async () => {}, observeRuntime: async runtime => ({path: runtime.destinationPath,
        bytes: 85_268_464, sha256: runtime.sha256}),
    inspectMsi: async (file, properties) => {
        assert.deepEqual(properties, ["ProductCode", "ProductVersion", "UpgradeCode"]);
        const index = PRODUCT_INDEX[file.bindingId];
        const productVersion = file.bindingId.startsWith("candidate-") ? "1.6.1.0"
            : file.bindingId.startsWith("authentic-1.6.0") ? "1.6.0.0" : "1.1.0.0";
        return {ProductCode: `{00000000-0000-0000-0000-${String(index).padStart(12, "0")}}`,
            ProductVersion: productVersion, UpgradeCode: "{A1B2C3D4-5E6F-7890-ABCD-EF1234567890}"};
    }
});

const payload = (exe, suffix) => ({exe: {bytes: exe.bytes, sha256: exe.sha256,
    fileVersion: suffix === "candidate" ? "1.6.1.45" : "1.6.0.2",
    productVersion: suffix === "candidate" ? "1.6.1.45" : "1.6.0.2"},
configuration: {bytes: 512, sha256: `${suffix === "candidate" ? "a" : "b"}`.repeat(64)},
wrapper: {bytes: 1024, sha256: `${suffix === "candidate" ? "c" : "d"}`.repeat(64)},
inventory: [{path: "MySpeed.exe", bytes: exe.bytes, sha256: exe.sha256},
    {path: "MySpeedService.exe", bytes: 1024,
        sha256: `${suffix === "candidate" ? "c" : "d"}`.repeat(64)},
    {path: "MySpeedService.xml", bytes: 512,
        sha256: `${suffix === "candidate" ? "a" : "b"}`.repeat(64)},
    {path: "data/template.db", bytes: 2048, sha256: "e".repeat(64)}]});

const prepareFixtures = async (plan, preparation) => {
    const fixturePlan = buildV161PostReleaseMsiFixturePlan({acquisitionPlan: plan,
        windowsPreparation: preparation, outputRoot: `${PREPARATION_ROOT}\\fixtures`});
    const candidateExe = plan.files.find(file => file.bindingId === "candidate-default" && file.role === "exe").source;
    const baselineExe = plan.files.find(file => file.bindingId === "candidate-baseline" && file.role === "exe").source;
    const predecessorExe = {bytes: 80_000_000, sha256: "8".repeat(64)};
    const candidatePayload = payload(candidateExe, "candidate");
    const candidateBaselinePayload = payload(baselineExe, "candidate");
    const predecessorPayload = payload(predecessorExe, "predecessor");
    return prepareV161PostReleaseMsiFixturesOnWindows(fixturePlan, {initialize: async () => {},
        inspectPayload: async inspection => inspection.bindingId === "candidate-default" ? candidatePayload
            : inspection.bindingId === "candidate-baseline" ? candidateBaselinePayload
                : inspection.bindingId === "authentic-1.6.0-default-msi" ? predecessorPayload
                    : payload({bytes: 79_000_000 - inspection.bindingId.length,
                        sha256: inspection.bindingId === "authentic-1.6.0-baseline-msi"
                            ? "4".repeat(64) : "5".repeat(64)}, "predecessor"),
        buildClone: async spec => ({bindingId: spec.bindingId, path: spec.destinationPath,
            bytes: spec.bindingId === "lower-stamp-fixture" ? 51_000_001 : 51_000_002,
            sha256: spec.bindingId === "lower-stamp-fixture" ? "6".repeat(64) : "7".repeat(64),
            properties: {ProductCode: spec.productCode, PackageCode: spec.packageCode,
                ProductVersion: spec.productVersion, UpgradeCode: spec.upgradeCode},
            payload: predecessorPayload})});
};

export const lifecycleInput = (value, sample) => {
    const context = hostedContext();
    const taskRoot = `/home/runner/work/_temp/myspeed-windows-msi-${HOST_NONCE}`;
    const records = new Map(value.baselinePreparation.files.map(file => [file.relativePath, file]));
    const populated = Object.fromEntries(value.baselinePreparation.files
        .filter(file => file.relativePath.startsWith("fixture/populated/"))
        .map(file => [file.relativePath.slice("fixture/populated/".length), file.sha256]));
    const reset = Object.fromEntries(value.baselinePreparation.files
        .filter(file => file.relativePath.startsWith("fixture/reset/"))
        .map(file => [file.relativePath.slice("fixture/reset/".length), file.sha256]));
    const manifestValue = {schemaVersion: 1, source: {commit: value.target.candidate.sourceSha,
        bunLockSha256: "1".repeat(64), packageSha256: "2".repeat(64)},
    populated: {root: "populated", nonce: "3".repeat(48),
        markerSha256: populated[".myspeed-qualification.json"],
        databaseSha256: populated["data/storage.db"], filesSha256: populated},
    reset: {root: "reset", nonce: "4".repeat(48),
        markerSha256: reset[".myspeed-qualification.json"], filesSha256: reset},
    expected: structuredClone(sample.fixture.expected)};
    const manifestBytes = Buffer.from(`${JSON.stringify(manifestValue)}\n`);
    const candidateFiles = Object.keys(populated).map(name => { const relativePath = `fixture/populated/${name}`;
        const record = records.get(relativePath); return {name: relativePath, sourceRole: "candidate",
            sourceSha: value.target.candidate.sourceSha,
            sourcePath: `${taskRoot}/appassets/files/baseline/${relativePath}`,
            bytes: record.bytes, sha256: record.sha256}; });
    const generatedSentinels = [["fixture/populated/destination.sentinel",
        Buffer.from("myspeed-v1.6.1-msi-destination-sentinel\n")],
    ["fixture/legacy/legacy.sentinel", Buffer.from("myspeed-v1.6.1-msi-legacy-sentinel\n")]]
        .map(([name, bytes]) => ({name, sourceRole: "harness", sourceSha: context.sourceSha,
            sourcePath: `${taskRoot}/generated-fixture/${name.slice("fixture/".length)}`,
            bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex")}));
    const execution = {sourceSha: value.target.candidate.sourceSha, populatedRoot: "C:\\placeholder\\populated",
        manifestPath: "C:\\placeholder\\fixture.json",
        manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
        legacyRoot: "C:\\placeholder\\legacy",
        populatedMarkerSha256: manifestValue.populated.markerSha256,
        populatedDatabaseSha256: manifestValue.populated.databaseSha256,
        populatedFilesSha256: populated, destinationSentinelSha256: generatedSentinels[0].sha256,
        legacySentinelSha256: generatedSentinels[1].sha256, expected: manifestValue.expected};
    const linuxFixture = {schemaVersion: 1, kind: "myspeed-v1.6.1-post-release-msi-linux-fixture-preparation",
        status: "prepared", authority: "same-job-local-byte-preparation-only", qualifying: false,
        binding: {candidateSourceSha: value.target.candidate.sourceSha, harnessSourceSha: context.sourceSha,
            candidateFiles, generatedSentinels}, hostFixture: {manifest: {
                path: `${taskRoot}/appassets/files/baseline/fixture/transport.json`, bytes: manifestBytes.length,
                sha256: execution.manifestSha256, bytesBase64: manifestBytes.toString("base64")},
            execution, files: [...candidateFiles, ...generatedSentinels].map(item => ({name: item.name,
                sourceRole: item.sourceRole, sourceSha: item.sourceSha, sourcePath: item.sourcePath,
                bytes: item.bytes, sha256: item.sha256}))}};
    const portableRoot = `/tmp/myspeed-windows-cpu-floor-tools-${HOST_NONCE}`;
    const ownership = {uid: "0", gid: "0", mode: "555", ordinaryUserWritable: false};
    const identity = (target, digit) => ({path: target, bytes: "4096", sha256: digit.repeat(64), ownership});
    const command = (name, digit) => ({...identity(`${portableRoot}/usr/bin/${name}`, digit),
        invocationPath: `${portableRoot}/usr/bin/${name}`});
    const probeArtifact = structuredClone(value.host.request.expected.probeArtifact);
    const cpuid = probeArtifact.files.find(file => file.role === "cpuid");
    const stage2Result = {status: "observed", stage: "complete", cpuCalibrationAccepted: true, context,
        probeArtifact, probes: {files: [{...cpuid, path: `${taskRoot}/probes/${cpuid.name}`}]},
        toolchain: {qemu: {...command("qemu-system-x86_64", "1"),
            version: "QEMU emulator version 8.2.2"}, qemuImg: command("qemu-img", "2"),
        genisoimage: command("genisoimage", "3"), mformat: command("mformat", "4"),
        mcopy: command("mcopy", "5"),
        ovmfCode: identity(`${portableRoot}/usr/share/OVMF/OVMF_CODE_4M.fd`, "6"),
        ovmfVarsTemplate: identity(`${portableRoot}/usr/share/OVMF/OVMF_VARS_4M.fd`, "7"),
        firmware: {searchPath: `${portableRoot}/usr/share/qemu`,
            kvmvapic: identity(`${portableRoot}/usr/share/qemu/kvmvapic.bin`, "8"),
            vga: identity(`${portableRoot}/usr/share/seabios/vgabios-stdvga.bin`, "9")},
        runtime: {loader: identity(`${portableRoot}/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`, "a"),
            libraryPath: [`${portableRoot}/usr/lib/x86_64-linux-gnu`, `${portableRoot}/usr/lib/7zip`]}}};
    const closureRoot = `/home/runner/work/_temp/myspeed-msi-closure-${HOST_NONCE}`;
    const closurePaths = new Map(POST_RELEASE_MSI_LINUX_CONTROLLER_CONSTANTS.CLOSURE_FILES);
    const closure = name => ({path: `${closureRoot}/${closurePaths.get(name)}`,
        bytes: 4096, sha256: "b".repeat(64)});
    const sources = {node: value.observedPreparation.execution.runtime,
        cpuid: {path: stage2Result.probes.files[0].path, bytes: Number(cpuid.bytes), sha256: cpuid.sha256},
        matrixRunner: closure("matrixRunner"), matrixOperations: closure("matrixOperations"),
        matrixRow: closure("matrixRow"), matrixContract: closure("matrixContract"),
        launcher: closure("launcher"), runner: closure("runner"), oracle: closure("oracle"),
        oracleSafety: closure("oracleSafety"), oracleFixture: closure("oracleFixture"),
        sqlite: closure("sqlite"), rollback: closure("rollback"), containment: closure("containment"),
        preflightRunner: closure("preflightRunner")};
    return {context, taskRoot, closureRoot, observedPreparation: value.observedPreparation,
        linuxFixture, installedBaseSeal: value.seal, stage2Result, sources,
        prerequisiteEvidence: prerequisiteRecords(context), budget: {...JOB_BUDGET},
        wallDeadlineUnixMilliseconds: 2_000_000_000_000};
};

export const createPostReleaseMsiControllerFixture = async (controllerMutation = null) => {
    const target = createPostReleaseV161Target();
    const harness = harnessContext();
    const envelope = createV161PostReleaseMsiEnvelope(target, harness);
    const acquisitionPlan = buildV161PostReleaseMsiAcquisitionPlan(envelope, harness, PREPARATION_ROOT);
    const acquisitionRecord = createV161PostReleaseMsiAcquisitionRecord(acquisitionPlan,
        localObservations(acquisitionPlan), {path: acquisitionPlan.runtime.destinationPath, bytes: 85_268_464,
            sha256: acquisitionPlan.runtime.sha256});
    const preparation = await prepare(acquisitionPlan);
    const fixturePreparation = await prepareFixtures(acquisitionPlan, preparation);
    const baseline = baselinePreparation(harness);
    const prepareResult = {schemaVersion: 1, kind: "myspeed-v1.6.1-post-release-msi-prepare-result",
        status: "prepared", qualifying: false, installerExecution: false, releaseGatesCleared: [],
        targetInput: retainedTargetInput(target, harness), target,
        envelope, acquisition: acquisitionRecord, windowsPreparation: preparation,
        inspections: preparation.inspections, fixturePreparation, baselinePreparation: baseline,
        pending: ["linux-transport-reobservation"]};
    const controllerTaskRoot = `/home/runner/work/_temp/myspeed-windows-msi-${HOST_NONCE}`;
    const controllerArtifactRoot = `${controllerTaskRoot}/appassets`;
    const artifact = {repository: "i7Gamer/MySpeed", id: "7001", name: "post-release-v1.6.1-msi-appassets",
        bytes: "400000000", digest: `sha256:${"e".repeat(64)}`, runId: harness.runId,
        runAttempt: harness.runAttempt, headSha: harness.sourceSha};
    const documents = new Map([["result.json", prepareResult], ["fixture-proof.json", fixturePreparation],
        ["baseline-proof.json", baseline]]);
    const identities = new Map(acquisitionPlan.files.map(file => [
        `${controllerArtifactRoot}/files/${path.win32.basename(file.destinationPath)}`, file.source]));
    for (const file of fixturePreparation.fixtures) identities.set(
        `${controllerArtifactRoot}/files/fixtures/${file.bindingId === "lower-stamp-fixture"
            ? "lower-stamp.msi" : "safe-rollback-predecessor.msi"}`, file);
    identities.set(`${controllerArtifactRoot}/files/node-v22.19.0-win-x64/node.exe`,
        {bytes: acquisitionRecord.runtime.local.bytes, sha256: acquisitionPlan.runtime.sha256});
    const controllerInput = {context: hostedContext(), taskRoot: controllerTaskRoot,
        artifactRoot: controllerArtifactRoot, artifact};
    if (controllerMutation) controllerMutation({input: controllerInput, documents, identities});
    const observedPreparation = await observeV161PostReleaseMsiPreparation(controllerInput, {
        readDocument: ({path: requested}) => { const value = documents.get(path.posix.basename(requested));
            const content = Buffer.from(`${JSON.stringify(value)}\n`); return {path: requested,
                bytes: content.length, sha256: createHash("sha256").update(content).digest("hex"), content}; },
        inspectFile: ({path: requested}) => { const expected = identities.get(requested); return {path: requested,
            bytes: expected.bytes, sha256: expected.sha256}; }
    });
    assert.deepEqual(observedPreparation.target, target);
    assert.deepEqual(observedPreparation.baselinePreparation, baseline);
    assert.equal(observedPreparation.execution.files.length, acquisitionPlan.files.length);
    const controllerArtifacts = buildV161PostReleaseMsiArtifactInputs(observedPreparation);
    assert.equal(controllerArtifacts.length, 7);
    assert.equal(controllerArtifacts.find(item => item.bindingId === "authentic-1.1.0-msi").exeSha256,
        fixturePreparation.authenticPayloads.find(item => item.bindingId === "authentic-1.1.0-msi")
            .payload.exe.sha256);
    const transport = {schemaVersion: 1,
        kind: "myspeed-v1.6.1-post-release-msi-preparation-transport",
        artifact,
        result: retainedTransportDocument("result.json", prepareResult),
        fixtureProof: retainedTransportDocument("fixture-proof.json", fixturePreparation),
        baselineProof: retainedTransportDocument("baseline-proof.json", baseline)};
    const execution = {root: EXECUTION_ROOT, transportArchiveSha256: "e".repeat(64),
        files: acquisitionPlan.files.map(file => ({bindingId: file.bindingId, role: file.role,
            path: `${EXECUTION_ROOT}/files/${path.win32.basename(file.destinationPath)}`,
            bytes: file.source.bytes, sha256: file.source.sha256})),
        fixtures: fixturePreparation.fixtures.map(file => ({bindingId: file.bindingId, role: "msi",
            path: `${EXECUTION_ROOT}/files/fixtures/${file.bindingId === "lower-stamp-fixture"
                ? "lower-stamp.msi" : "safe-rollback-predecessor.msi"}`,
            bytes: file.bytes, sha256: file.sha256})),
        runtime: {path: `${EXECUTION_ROOT}/files/node-v22.19.0-win-x64/node.exe`, bytes: 85_268_464,
            sha256: acquisitionPlan.runtime.sha256}};
    const host = await createWindowsMsiLifecycleHostEvidenceFixture({sourceSha: POST_RELEASE_V161_HARNESS_SHA,
        candidateSourceSha: target.candidate.sourceSha, systemTools: SYSTEM_TOOLS,
        eventSha: POST_RELEASE_V161_HARNESS_SHA, runId: harness.runId, runAttempt: harness.runAttempt,
        candidateManifestSha256: MANIFEST_SHA256,
        candidateArtifacts: candidateArtifacts(acquisitionPlan, fixturePreparation)});
    host.request.context = hostedContext();
    host.request.sourceSha = harness.sourceSha;
    host.request.eventSha = harness.eventSha;
    host.request.runId = harness.runId;
    host.request.runAttempt = harness.runAttempt;
    host.request.expected.sourceSha = harness.sourceSha;
    host.request.expected.eventSha = harness.eventSha;
    host.request.expected.runId = harness.runId;
    host.request.expected.runAttempt = harness.runAttempt;
    host.request.expected.candidateManifestSha256 = MANIFEST_SHA256;
    host.request.expected.baseImageSha256 = BASE_SHA256;
    host.request.baseImage = {path: IMAGE_PATH, bytes: IMAGE_BYTES, sha256: BASE_SHA256,
        ownership: {uid: "0", gid: "0", mode: "444", ordinaryUserWritable: false}};
    host.request.candidateProvenance = null;
    for (const row of host.request.rows) {
        const manifest = decodedExecution(row);
        for (const file of execution.files.filter(item => item.role === "msi")) {
            const artifact = manifest.artifacts.find(item => item.bindingId === file.bindingId);
            row.seedFiles.push({name: path.win32.basename(artifact.path), sourcePath: file.path,
                bytes: String(file.bytes), sha256: file.sha256});
        }
        for (const file of execution.fixtures) {
            const artifact = manifest.artifacts.find(item => item.bindingId === file.bindingId);
            row.seedFiles.push({name: path.win32.basename(artifact.path), sourcePath: file.path,
                bytes: String(file.bytes), sha256: file.sha256});
        }
        const node = row.seedFiles.find(file => file.name === "node.exe");
        node.sourcePath = execution.runtime.path;
        node.bytes = String(execution.runtime.bytes);
        node.sha256 = execution.runtime.sha256;
    }
    return {target, harness, envelope, acquisitionPlan, acquisitionRecord, preparation, fixturePreparation,
        baselinePreparation: baseline,
        transport, execution, observedPreparation,
        seal: installedBaseSeal(), host};
};
