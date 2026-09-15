import {createHash} from "node:crypto";

import {createWindowsMsiPrerequisiteEvidenceFixture} from
    "./windows-msi-prerequisite-evidence-fixture.mjs";
import {createWindowsMsiGuestLifecycleEvidenceFixture, WINDOWS_MSI_GUEST_EVIDENCE_DEFAULT_IDENTITY} from
    "./windows-msi-guest-lifecycle-evidence-fixture.mjs";
import {buildWindowsMsiGuestSeedDocuments} from "../../scripts/qualification/windows-msi-guest-seed-documents.mjs";
import {buildWindowsMsiLifecycleQemuArguments, runWindowsMsiLifecycleHost,
    WINDOWS_MSI_LIFECYCLE_OUTPUT_DISK_BYTES} from "../../scripts/qualification/linux-windows-msi-lifecycle-host.mjs";

const HOST_NONCE = "9".repeat(32);
const HOST_ROOT = "/opt/myspeed/windows-msi";
const MINUTE = 60_000;
const FIXTURE_JOB_BUDGET = Object.freeze({jobBudgetMilliseconds: 300 * MINUTE,
    rowAllowanceMilliseconds: 15 * MINUTE, rowCleanupMarginMilliseconds: 2 * MINUTE,
    finalMarginMilliseconds: 10 * MINUTE});
const ROW_MILLISECONDS = 16_200_000;
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const PNG_BYTES = Buffer.from("89504e470d0a1a0a", "hex");
const identity = (path, bytes = "4096", hash = "a".repeat(64)) => ({path, bytes, sha256: hash});
const ownedIdentity = (path, bytes = "4096", hash = "a".repeat(64)) => ({...identity(path, bytes, hash),
    ownership: {uid: "0", gid: "0", mode: "444", ordinaryUserWritable: false}});
const retainedDocument = (root, name, document) => ({path: `${root}/${name}`, bytes: document.bytes,
    sha256: document.sha256, bytesBase64: document.bytesBase64});
const earlyBoot = rowRoot => ({schemaVersion: 1, kind: "qemu-early-boot-observation", inputSent: false,
    version: {major: 9, minor: 2, micro: 1}, status: "running", running: true,
    screenshots: [1, 2].map(index => ({path: `${rowRoot}/early-boot-${index}.png`,
        bytes: String(PNG_BYTES.length), sha256: sha256(PNG_BYTES), bytesBase64: PNG_BYTES.toString("base64")}))});

export const createWindowsMsiLifecycleCandidateProvenanceFixture = (guest, override) => {
    if (override !== undefined) return structuredClone(override);
    const execution = JSON.parse(Buffer.from(guest.evidence.rows[0].executionManifest.bytesBase64, "base64"));
    const records = [{bindingId: "candidate-default", exeName: "MySpeed-windows-x64.exe",
        msiName: "release-msi-MySpeed-installer.msi"},
    {bindingId: "candidate-baseline", exeName: "MySpeed-windows-x64-baseline.exe",
        msiName: "release-msi-MySpeed-installer-baseline.msi"}];
    return {preseal: {artifactId: "100", artifactName: "release-candidate-manifest",
        archive: {bytes: "2048", sha256: "f".repeat(64)},
        innerManifest: {name: "qualification-manifest.json", bytes: "1024",
            sha256: guest.expected.candidateManifestSha256}}, artifacts: records.map((record, index) => {
            const artifact = execution.artifacts.find(item => item.bindingId === record.bindingId);
            return {bindingId: record.bindingId, msi: {artifactId: String(101 + index * 2),
                artifactName: record.msiName, archive: {bytes: String(4096 + index),
                    sha256: String(index + 1).repeat(64).slice(0, 64)},
                inner: {name: "MySpeed-installer.msi", bytes: String(artifact.bytes), sha256: artifact.sha256}},
            exe: {artifactId: String(102 + index * 2), artifactName: record.exeName,
                archive: {bytes: String(8192 + index), sha256: String(index + 3).repeat(64).slice(0, 64)},
                inner: {name: "MySpeed.exe", bytes: String(artifact.exeBytes), sha256: artifact.exeSha256}}};
        })};
};

const createToolchain = () => {
    const result = Object.fromEntries(["runtimeLoader", "qemu", "qemuImg", "genisoimage", "mformat", "mcopy",
        "ovmfCode", "ovmfVarsTemplate"].map((name, index) => [name,
        ownedIdentity(`/opt/myspeed/tools/${name}`, String(4096 + index),
            String(index + 1).repeat(64).slice(0, 64))]));
    result.portableRoot = "/opt/myspeed/tools";
    result.libraryPath = ["/opt/myspeed/tools/lib"];
    result.firmware = {searchPath: "/opt/myspeed/tools/usr/share/qemu",
        kvmvapic: ownedIdentity("/opt/myspeed/tools/usr/share/qemu/kvmvapic.bin", "4096", "8".repeat(64)),
        vga: ownedIdentity("/opt/myspeed/tools/usr/share/seabios/vgabios-stdvga.bin", "8192", "9".repeat(64))};
    return result;
};

const buildRows = guest => guest.evidence.rows.map((guestRow, scenarioIndex) => {
    const rowRequestValue = JSON.parse(Buffer.from(guestRow.rowRequest.bytesBase64, "base64"));
    const executionValue = JSON.parse(Buffer.from(guestRow.executionManifest.bytesBase64, "base64"));
    const rowNonce = rowRequestValue.nonce;
    const rowRoot = `${HOST_ROOT}/myspeed-windows-msi-${HOST_NONCE}/row-${String(scenarioIndex)
        .padStart(2, "0")}-${rowNonce}`;
    const seedRoot = `${rowRoot}/seed`;
    const documents = buildWindowsMsiGuestSeedDocuments({rowRequest: rowRequestValue,
        executionManifest: executionValue, matrixRunner: {
            path: `${executionValue.seedRoot}\\windows-msi-guest-matrix-executor.mjs`,
            bytes: 14_000, sha256: "d".repeat(64)}, launcher: {
            path: `${executionValue.seedRoot}\\media-job-launcher.ps1`, bytes: 32_000,
            sha256: "e".repeat(64)}, observerSha256: "f".repeat(64),
        wallDeadlineUnixMilliseconds: 2_000_000_000_000});
    return {scenarioIndex, scenarioId: guestRow.scenarioId, nonce: rowNonce, rowRoot,
        overlayPath: `${rowRoot}/system-overlay.qcow2`, seedRoot, seedIsoPath: `${rowRoot}/seed.iso`,
        outputDiskPath: `${rowRoot}/output.img`, guestResultPath: `${rowRoot}/guest-result.json`,
        serialLogPath: `${rowRoot}/serial.log`, pidPath: `${rowRoot}/qemu.pid`,
        ovmfVarsPath: `${rowRoot}/OVMF_VARS.fd`,
        rowRequest: retainedDocument(seedRoot, "row-request.json", documents.rowRequest),
        executionManifest: retainedDocument(seedRoot, "execution-manifest.json", documents.executionManifest),
        guestEnvelope: retainedDocument(seedRoot, "matrix-envelope.json", documents.envelope),
        launcherRequest: retainedDocument(seedRoot, "launch-request.json", documents.launcherRequest),
        seedFiles: [{name: "node.exe", sourcePath: "/opt/myspeed/closure/node.exe",
            bytes: "85268464", sha256: "b".repeat(64)},
        {name: "windows-msi-guest-matrix-executor.mjs", sourcePath: "/opt/myspeed/closure/matrix.mjs",
            bytes: "14000", sha256: "d".repeat(64)},
        {name: "media-job-launcher.ps1", sourcePath: "/opt/myspeed/closure/launcher.ps1",
            bytes: "32000", sha256: "e".repeat(64)},
        {name: "windows-msi-guest-runner.ps1", sourcePath: "/opt/myspeed/closure/runner.ps1",
            bytes: "19000", sha256: "1".repeat(64)}]};
});

const prerequisiteContext = overrides => ({...WINDOWS_MSI_GUEST_EVIDENCE_DEFAULT_IDENTITY,
    sourceSha: overrides.sourceSha ?? WINDOWS_MSI_GUEST_EVIDENCE_DEFAULT_IDENTITY.sourceSha,
    eventSha: overrides.eventSha ?? WINDOWS_MSI_GUEST_EVIDENCE_DEFAULT_IDENTITY.eventSha,
    runId: overrides.runId ?? WINDOWS_MSI_GUEST_EVIDENCE_DEFAULT_IDENTITY.runId,
    runAttempt: overrides.runAttempt ?? WINDOWS_MSI_GUEST_EVIDENCE_DEFAULT_IDENTITY.runAttempt,
    nonce: HOST_NONCE});

const buildRequest = (guest, rows, toolchain, candidateProvenance, prerequisites) => ({schemaVersion: 1,
    kind: "myspeed-windows-msi-lifecycle-host-request", qualifying: false,
    context: {schemaVersion: 1, repository: "i7Gamer/MySpeed", sourceSha: guest.expected.sourceSha,
        eventSha: guest.expected.eventSha, runId: guest.expected.runId, runAttempt: guest.expected.runAttempt,
        nonce: HOST_NONCE, environment: {GITHUB_ACTIONS: "true", CI: "true", RUNNER_OS: "Linux",
            RUNNER_ARCH: "X64", RUNNER_ENVIRONMENT: "github-hosted", ImageOS: "ubuntu24",
            ImageVersion: "20260914.1"}}, privilegeMode: "reviewed-sudo-kvm", repository: "i7Gamer/MySpeed",
    sourceSha: guest.expected.sourceSha, eventSha: guest.expected.eventSha, runId: guest.expected.runId,
    runAttempt: guest.expected.runAttempt, nonce: HOST_NONCE,
    taskRoot: `${HOST_ROOT}/myspeed-windows-msi-${HOST_NONCE}`, expected: guest.expected, candidateProvenance,
    prerequisiteEvidence: {rollbackCalibration: prerequisites.rollbackCalibration,
        oldContainment: prerequisites.oldContainment},
    toolchain,
    toolchainSha256: sha256(Buffer.from(JSON.stringify(toolchain))),
    baseImage: ownedIdentity("/opt/myspeed/base/windows-modern.qcow2", "53687091200",
        guest.expected.baseImageSha256), rows,
    limits: {outputDiskBytes: WINDOWS_MSI_LIFECYCLE_OUTPUT_DISK_BYTES, rowMilliseconds: ROW_MILLISECONDS,
        budget: {...FIXTURE_JOB_BUDGET}}});

const buildBoundGuest = async (overrides, toolchain, prerequisites) => {
    const firstGuest = await createWindowsMsiGuestLifecycleEvidenceFixture(overrides);
    const firstRows = buildRows(firstGuest); const firstRequest = buildRequest(firstGuest, firstRows, toolchain,
        createWindowsMsiLifecycleCandidateProvenanceFixture(firstGuest, overrides.candidateProvenance),
        prerequisites);
    const overlayReceiptSha256ByScenario = firstRows.map(row => sha256(Buffer.from(row.nonce)));
    const qemuLaunchSha256ByScenario = firstRows.map(row => {
        const overlay = {path: row.overlayPath, format: "qcow2", backingBaseSha256: firstRequest.baseImage.sha256,
            createNew: true, receiptSha256: overlayReceiptSha256ByScenario[row.scenarioIndex]};
        const media = {seed: {path: row.seedIsoPath, bytes: "1048576", sha256: "c".repeat(64),
            manifestSha256: firstGuest.expected.closureSha256, readOnly: true, volumeLabel: "MYSPEEDSEED"},
        outputBefore: {path: row.outputDiskPath, bytes: String(WINDOWS_MSI_LIFECYCLE_OUTPUT_DISK_BYTES),
            sha256: "e".repeat(64), createNew: true, volumeLabel: "MYSPEEDOUT"},
        ovmfVarsSha256: firstRequest.toolchain.ovmfVarsTemplate.sha256};
        return sha256(Buffer.from(JSON.stringify(buildWindowsMsiLifecycleQemuArguments({request: firstRequest,
            row, overlay, media}))));
    });
    return createWindowsMsiGuestLifecycleEvidenceFixture({...overrides,
        overlayReceiptSha256ByScenario, qemuLaunchSha256ByScenario});
};

export const createWindowsMsiLifecycleHostEvidenceFixture = async (overrides = {}) => {
    const toolchain = createToolchain();
    const prerequisites = createWindowsMsiPrerequisiteEvidenceFixture({context: prerequisiteContext(overrides)});
    const guestOverrides = {...overrides,
        rollbackCalibrationSha256: prerequisites.rollbackCalibrationSha256,
        oldContainmentSha256: prerequisites.oldContainmentSha256};
    const guest = await buildBoundGuest(guestOverrides, toolchain, prerequisites);
    const rows = buildRows(guest); const request = buildRequest(guest, rows, toolchain,
        createWindowsMsiLifecycleCandidateProvenanceFixture(guest, overrides.candidateProvenance),
        prerequisites); const calls = [];
    const operations = {
        inspectBase: async ({phase}) => { calls.push(`base:${phase}`); return {...request.baseImage,
            format: "qcow2", virtualBytes: "68719476736", sealedReadOnly: true}; },
        createOverlay: async ({row}) => { calls.push(`overlay:${row.scenarioIndex}`); return {
            path: row.overlayPath, format: "qcow2", backingBaseSha256: request.baseImage.sha256,
            createNew: true, receiptSha256: sha256(Buffer.from(row.nonce))}; },
        prepareMedia: async ({row}) => { calls.push(`media:${row.scenarioIndex}`); return {
            seed: {path: row.seedIsoPath, bytes: "1048576", sha256: "c".repeat(64),
                manifestSha256: guest.expected.closureSha256, readOnly: true, volumeLabel: "MYSPEEDSEED"},
            outputBefore: {path: row.outputDiskPath, bytes: String(WINDOWS_MSI_LIFECYCLE_OUTPUT_DISK_BYTES),
                sha256: "e".repeat(64), createNew: true, volumeLabel: "MYSPEEDOUT"},
            ovmfVarsSha256: request.toolchain.ovmfVarsTemplate.sha256}; },
        launchRow: async ({row, overlay, media}) => { calls.push(`launch:${row.scenarioIndex}`);
            const argv = buildWindowsMsiLifecycleQemuArguments({request, row, overlay, media});
            return {argv, argvSha256: sha256(Buffer.from(JSON.stringify(argv))),
                loaderPath: request.toolchain.runtimeLoader.path,
                loaderSha256: request.toolchain.runtimeLoader.sha256, qemuPath: request.toolchain.qemu.path,
                qemuSha256: request.toolchain.qemu.sha256, pid: 2000 + row.scenarioIndex,
                startTicks: String(5000 + row.scenarioIndex), processGroupId: 2000 + row.scenarioIndex,
                exitCode: 0, signal: null, timedOut: false, terminationReason: null,
                cleanupProven: true, treeGone: true, earlyBoot: earlyBoot(row.rowRoot)}; },
        readGuestResult: async ({row}) => { calls.push(`read:${row.scenarioIndex}`); return {
            bytes: Buffer.from(guest.evidence.rows[row.scenarioIndex].semanticResult.bytesBase64, "base64"),
            outputAfter: identity(row.outputDiskPath, String(WINDOWS_MSI_LIFECYCLE_OUTPUT_DISK_BYTES),
                String(row.scenarioIndex + 1).repeat(64).slice(0, 64))}; },
        cleanupRow: async ({row, groupZero}) => { calls.push(`cleanup:${row.scenarioIndex}`); return {
            groupZeroBeforeRemoval: groupZero, removed: true}; }
    };
    const result = await runWindowsMsiLifecycleHost(request, operations);
    return {request, result, calls};
};
