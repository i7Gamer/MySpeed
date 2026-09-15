import {createHash} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import zlib from "node:zlib";

import {createWindowsMsiLifecycleHostEvidenceFixture} from "./linux-windows-msi-lifecycle-host-fixture.mjs";
import {createWindowsMsiGuestRowSemanticResult} from "./windows-msi-guest-lifecycle-evidence-fixture.mjs";
import {buildWindowsMsiLifecycleQemuArguments,
    runWindowsMsiLifecycleHost} from "../../scripts/qualification/linux-windows-msi-lifecycle-host.mjs";
import {createV161PostReleaseMsiEnvelope} from "../../scripts/release/post-release-msi-envelope.mjs";
import {buildV161PostReleaseMsiAcquisitionPlan, createV161PostReleaseMsiAcquisitionRecord} from "../../scripts/release/post-release-msi-acquisition.mjs";
import {prepareV161PostReleaseMsiOnWindows} from "../../scripts/release/post-release-msi-hosted-prepare.mjs";
import {buildV161PostReleaseMsiFixturePlan, prepareV161PostReleaseMsiFixturesOnWindows} from "../../scripts/release/post-release-msi-fixture-preparation.mjs";
import {buildWindowsMsiSetupCompleteActivation, getCompletedWindowsMsiActivationEvidence} from "../../scripts/qualification/windows-msi-post-setup-activation.mjs";
import {WINDOWS_BASELINE_RUNTIME_BUNDLE_CONSTANTS} from "../../scripts/qualification/windows-baseline-guest-runtime-bundle.mjs";
import {POST_RELEASE_BASELINE_INPUT_CONSTANTS} from "../../scripts/release/post-release-msi-baseline-input-preparation.mjs";
import {createPostReleaseV161HarnessContext, createPostReleaseV161Target} from "./post-release-v161-target-fixture.mjs";
import {createV161PostReleaseMsiHostBinding} from "../../scripts/release/post-release-msi-host-bridge.mjs";
import {observeV161PostReleaseMsiPreparation} from "../../scripts/release/post-release-msi-linux-controller.mjs";
import {sealWindowsMsiExecutionClosure, WINDOWS_MSI_CONTROLLER_CLOSURE,
    WINDOWS_MSI_GUEST_CLOSURE} from "../../scripts/qualification/windows-msi-execution-closure.mjs";

const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_VERSION_NEEDED = 20;
const ZIP_COMPRESSION_STORE = 0;
const ZIP_LOCAL_HEADER_FIXED_BYTES = 30;
const ZIP_CENTRAL_DIRECTORY_FIXED_BYTES = 46;
const ZIP_END_OF_CENTRAL_DIRECTORY_BYTES = 22;

const HOST_NONCE = "9".repeat(32);
const ONE_MINUTE_MS = 60_000;
const PER_ROW_SIMULATED_MS = 11 * ONE_MINUTE_MS;
const MANIFEST_SHA256 = "7339a6446d048bbae93759734bcafc94208e2b847af15677e847ae9a4b2f8bca";
const BASE_SHA256 = "d".repeat(64);
const PREPARED_BASE_SHA256 = "c".repeat(64);
const PREPARATION_ROOT = "C:\\runner-temp\\myspeed-v1.6.1-msi-a1b2c3d4e5f60718293a4b5c6d7e8f90";
const EXECUTION_ROOT = `/opt/myspeed/windows-msi/myspeed-windows-msi-${HOST_NONCE}/acquired`;
const IMAGE_PATH = `/home/runner/work/_temp/myspeed-windows-cpu-floor-${HOST_NONCE}/system.qcow2`;
const IMAGE_BYTES = "53687091200";
const IMAGE_VIRTUAL_BYTES = "51539607552";
const RUNTIME_BYTES = 85_268_464;
const DEFAULT_ARTIFACT_ID = "10337212686";
const DEFAULT_ARTIFACT_NAME = "post-release-v1.6.1-msi-lifecycle-evidence";
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const SYSTEM_TOOLS = Object.freeze([
    {role: "msiexec", path: "C:\\Windows\\System32\\msiexec.exe", bytes: "1024", sha256: "8".repeat(64)},
    {role: "sc", path: "C:\\Windows\\System32\\sc.exe", bytes: "2048", sha256: "9".repeat(64)},
    {role: "powershell", path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        bytes: "4096", sha256: "b".repeat(64)}
]);

const PRODUCT_INDEX = Object.freeze({
    "candidate-default": 1,
    "candidate-baseline": 2,
    "authentic-1.6.0-default-msi": 5,
    "authentic-1.6.0-baseline-msi": 6,
    "authentic-1.1.0-msi": 7
});

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

const hostedContext = (harness) => ({
    schemaVersion: 1,
    repository: harness.repository,
    sourceSha: harness.sourceSha,
    eventSha: harness.eventSha,
    runId: harness.runId,
    runAttempt: harness.runAttempt,
    nonce: HOST_NONCE,
    environment: {
        GITHUB_ACTIONS: "true",
        CI: "true",
        RUNNER_OS: "Linux",
        RUNNER_ARCH: "X64",
        RUNNER_ENVIRONMENT: "github-hosted",
        ImageOS: "ubuntu24",
        ImageVersion: harness.imageVersion ?? "20260914.1"
    }
});

const installedBaseSeal = (harness) => ({
    schemaVersion: 1,
    kind: "myspeed-stage2-installed-base-same-job-ephemeral",
    status: "sealed",
    authority: "same-job-ephemeral-identity-only",
    context: hostedContext(harness),
    source: {
        stage2Classification: "github-hosted-windows-cpu-floor-stage2-calibration-nonqualifying",
        activation: getCompletedWindowsMsiActivationEvidence(buildWindowsMsiSetupCompleteActivation({
            repository: harness.repository,
            sourceSha: harness.sourceSha,
            eventSha: harness.eventSha,
            runId: harness.runId,
            runAttempt: harness.runAttempt,
            nonce: HOST_NONCE
        })),
        processGroupId: 2001,
        qemuPid: 2001,
        qemuStartTicks: "123456",
        guestOutputSha256: "b".repeat(64),
        systemTools: SYSTEM_TOOLS,
        preparedSystemDisk: {bytes: "1048576", sha256: PREPARED_BASE_SHA256}
    },
    image: {
        path: IMAGE_PATH,
        bytes: IMAGE_BYTES,
        sha256: BASE_SHA256,
        dev: "2049",
        ino: "4097",
        kind: "file",
        ownership: {uid: "0", gid: "0", mode: "444", ordinaryUserWritable: false},
        format: "qcow2",
        virtualBytes: IMAGE_VIRTUAL_BYTES,
        backingFilename: null,
        sealedReadOnly: true
    }
});

const localObservations = plan => plan.files.map(file => ({
    bindingId: file.bindingId,
    role: file.role,
    path: file.destinationPath,
    bytes: file.source.bytes,
    sha256: file.source.sha256
}));

const candidateArtifacts = (plan, fixturePreparation) => ({
    ...Object.fromEntries(plan.files.filter(file => file.role === "msi").map(file => {
        const payload = file.bindingId === "candidate-default"
            ? fixturePreparation.candidatePayload
            : file.bindingId === "candidate-baseline"
                ? fixturePreparation.candidateBaselinePayload
                : fixturePreparation.authenticPayloads.find(item => item.bindingId === file.bindingId)?.payload;
        return [file.bindingId, {
            msi: {bytes: file.source.bytes, sha256: file.source.sha256},
            exe: plan.files.find(item => item.bindingId === file.bindingId && item.role === "exe")?.source ?? {
                bytes: payload.exe.bytes,
                sha256: payload.exe.sha256
            },
            configurationSha256: payload.configuration.sha256,
            serviceWrapperSha256: payload?.wrapper.sha256
        }];
    })),
    ...Object.fromEntries(fixturePreparation.fixtures.map(file => [file.bindingId, {
        msi: {bytes: file.bytes, sha256: file.sha256},
        exe: {bytes: file.exeBytes, sha256: file.exeSha256},
        productCode: file.productCode,
        configurationSha256: file.configurationSha256,
        serviceWrapperSha256: file.serviceWrapperSha256
    }]))
});

const decodedExecution = row => JSON.parse(Buffer.from(row.executionManifest.bytesBase64, "base64"));

const retainedTransportDocument = (name, value) => {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    return {
        path: `${EXECUTION_ROOT}/${name}`,
        bytes: bytes.length,
        sha256: sha256(bytes),
        bytesBase64: bytes.toString("base64")
    };
};

const baselinePreparation = harness => {
    const paths = [
        "qualification-manifest.json",
        "fixture/transport.json",
        ...[".myspeed-qualification.json", ...POST_RELEASE_BASELINE_INPUT_CONSTANTS.FIXTURE_COMMON, "data/storage.db"]
            .map(name => `fixture/populated/${name}`),
        ...[".myspeed-qualification.json", ...POST_RELEASE_BASELINE_INPUT_CONSTANTS.FIXTURE_COMMON]
            .map(name => `fixture/reset/${name}`),
        ...[...WINDOWS_BASELINE_RUNTIME_BUNDLE_CONSTANTS.RUNTIME_PATHS,
            "scripts/qualification/windows-baseline-guest-runtime-installer.ps1"]
            .map(name => `runtime/${name}`)
    ];
    return {
        schemaVersion: 1,
        kind: "myspeed-v1.6.1-post-release-baseline-input-preparation",
        status: "prepared",
        authority: "windows-hosted-input-preparation-only",
        candidateSourceSha: POST_RELEASE_BASELINE_INPUT_CONSTANTS.CANDIDATE_SOURCE_SHA,
        harnessSourceSha: harness.sourceSha,
        files: paths.map((relativePath, index) => {
            const sourceRole = relativePath.startsWith("runtime/") ? "harness" : "candidate";
            return {
                bindingId: `baseline:${relativePath}`,
                sourceRole,
                sourceSha: sourceRole === "harness" ? harness.sourceSha : POST_RELEASE_BASELINE_INPUT_CONSTANTS.CANDIDATE_SOURCE_SHA,
                relativePath,
                bytes: index === 0 ? POST_RELEASE_BASELINE_INPUT_CONSTANTS.MANIFEST_BYTES : 100 + index,
                sha256: index === 0 ? POST_RELEASE_BASELINE_INPUT_CONSTANTS.MANIFEST_SHA256 : String((index % 9) + 1).repeat(64)
            };
        })
    };
};

const retainedTargetInput = (target, harness) => {
    const {provenance: _runProvenance, ...qualificationRun} = target.originalQualification.run;
    const {provenance: _archiveProvenance, ...qualificationArchive} = target.originalQualification.archive;
    return {
        tag: {
            repository: target.candidate.repository,
            name: target.candidate.tagName,
            commitSha: target.candidate.sourceSha
        },
        qualificationRun,
        qualificationArchive,
        release: {
            repository: target.candidate.repository,
            id: target.publication.releaseId,
            tagName: target.publication.tagName,
            targetCommitish: "development",
            createdAt: "2026-09-14T09:48:17Z",
            publishedAt: target.publication.publishedAt,
            draft: false,
            prerelease: false,
            platformImmutable: false,
            assets: target.publication.assets.map(({provenance: _provenance, ...asset}) => asset)
        },
        harnessSourceSha: harness.sourceSha,
        observedAt: target.observedAt,
        manifestBytesBase64: fs.readFileSync("tests/fixtures/post-release-native-v1.6.1/qualification-manifest.json").toString("base64")
    };
};

const prepareWindowsMsi = plan => prepareV161PostReleaseMsiOnWindows(plan, {
    initialize: async () => {},
    download: async () => {},
    observe: async file => ({
        bindingId: file.bindingId,
        role: file.role,
        path: file.destinationPath,
        bytes: file.source.bytes,
        sha256: file.source.sha256
    }),
    extractZipMember: async () => {},
    observeRuntime: async runtime => ({
        path: runtime.destinationPath,
        bytes: RUNTIME_BYTES,
        sha256: runtime.sha256
    }),
    inspectMsi: async (file, _properties) => {
        const index = PRODUCT_INDEX[file.bindingId];
        const productVersion = file.bindingId.startsWith("candidate-")
            ? "1.6.1.0"
            : file.bindingId.startsWith("authentic-1.6.0")
                ? "1.6.0.0"
                : "1.1.0.0";
        return {
            ProductCode: `{00000000-0000-0000-0000-${String(index).padStart(12, "0")}}`,
            ProductVersion: productVersion,
            UpgradeCode: "{A1B2C3D4-5E6F-7890-ABCD-EF1234567890}"
        };
    }
});

const payload = (exe, suffix) => ({
    exe: {
        bytes: exe.bytes,
        sha256: exe.sha256,
        fileVersion: suffix === "candidate" ? "1.6.1.45" : "1.6.0.2",
        productVersion: suffix === "candidate" ? "1.6.1.45" : "1.6.0.2"
    },
    configuration: {bytes: 512, sha256: `${suffix === "candidate" ? "a" : "b"}`.repeat(64)},
    wrapper: {bytes: 1024, sha256: `${suffix === "candidate" ? "c" : "d"}`.repeat(64)},
    inventory: [
        {path: "MySpeed.exe", bytes: exe.bytes, sha256: exe.sha256},
        {path: "MySpeedService.exe", bytes: 1024, sha256: `${suffix === "candidate" ? "c" : "d"}`.repeat(64)},
        {path: "MySpeedService.xml", bytes: 512, sha256: `${suffix === "candidate" ? "a" : "b"}`.repeat(64)},
        {path: "data/template.db", bytes: 2048, sha256: "e".repeat(64)}
    ]
});

const prepareFixtures = async (plan, preparation) => {
    const fixturePlan = buildV161PostReleaseMsiFixturePlan({
        acquisitionPlan: plan,
        windowsPreparation: preparation,
        outputRoot: `${PREPARATION_ROOT}\\fixtures`
    });
    const candidateExe = plan.files.find(file => file.bindingId === "candidate-default" && file.role === "exe").source;
    const baselineExe = plan.files.find(file => file.bindingId === "candidate-baseline" && file.role === "exe").source;
    const predecessorExe = {bytes: 80_000_000, sha256: "8".repeat(64)};
    const candidatePayload = payload(candidateExe, "candidate");
    const candidateBaselinePayload = payload(baselineExe, "candidate");
    const predecessorPayload = payload(predecessorExe, "predecessor");
    return prepareV161PostReleaseMsiFixturesOnWindows(fixturePlan, {
        initialize: async () => {},
        inspectPayload: async inspection => inspection.bindingId === "candidate-default"
            ? candidatePayload
            : inspection.bindingId === "candidate-baseline"
                ? candidateBaselinePayload
                : inspection.bindingId === "authentic-1.6.0-default-msi"
                    ? predecessorPayload
                    : payload({
                        bytes: 79_000_000 - inspection.bindingId.length,
                        sha256: inspection.bindingId === "authentic-1.6.0-baseline-msi" ? "4".repeat(64) : "5".repeat(64)
                    }, "predecessor"),
        buildClone: async spec => ({
            bindingId: spec.bindingId,
            path: spec.destinationPath,
            bytes: spec.bindingId === "lower-stamp-fixture" ? 51_000_001 : 51_000_002,
            sha256: spec.bindingId === "lower-stamp-fixture" ? "6".repeat(64) : "7".repeat(64),
            properties: {
                ProductCode: spec.productCode,
                PackageCode: spec.packageCode,
                ProductVersion: spec.productVersion,
                UpgradeCode: spec.upgradeCode
            },
            payload: predecessorPayload
        })
    });
};

const earlyBoot = rowRoot => ({
    schemaVersion: 1,
    kind: "qemu-early-boot-observation",
    inputSent: false,
    version: {major: 9, minor: 2, micro: 1},
    status: "running",
    running: true,
    screenshots: [1, 2].map(index => {
        const png = Buffer.from("89504e470d0a1a0a", "hex");
        return {
            path: `${rowRoot}/early-boot-${index}.png`,
            bytes: String(png.length),
            sha256: sha256(png),
            bytesBase64: png.toString("base64")
        };
    })
});

/**
 * Creates a standard uncompressed ZIP archive Buffer in memory.
 * @param {Array<{name: string, data: Buffer | string}>} files
 * @returns {Buffer}
 */
export function createZipBuffer(files, zipOptions = {}) {
    const parts = [];
    const cdEntries = [];
    let offset = 0;
    for (const file of files) {
        const nameBuf = Buffer.from(file.name, "utf8");
        const rawBuf = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, "utf8");
        const isDeflate = file.deflate === true;
        const compressedBuf = isDeflate ? zlib.deflateRawSync(rawBuf) : rawBuf;
        const method = file.method !== undefined
            ? file.method
            : (isDeflate ? 8 : ZIP_COMPRESSION_STORE);
        const crc = zlib.crc32(rawBuf);
        const flags = (file.flags ?? 0) | (file.dataDescriptor ? 0x0008 : 0);
        const externalAttr = file.externalAttr ?? 0;
        const declaredUncompressedSize = file.declaredSize !== undefined ? file.declaredSize : rawBuf.length;
        const declaredCompressedSize = file.declaredCompressedSize !== undefined ? file.declaredCompressedSize : compressedBuf.length;

        const local = Buffer.alloc(ZIP_LOCAL_HEADER_FIXED_BYTES);
        local.writeUInt32LE(file.corruptLocalSignature ? 0x00000000 : ZIP_LOCAL_FILE_HEADER_SIGNATURE, 0);
        local.writeUInt16LE(ZIP_VERSION_NEEDED, 4);
        local.writeUInt16LE(flags, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(0, 10);
        local.writeUInt16LE(0, 12);
        local.writeUInt32LE(file.dataDescriptor ? 0 : crc, 14);
        local.writeUInt32LE(file.dataDescriptor ? 0 : declaredCompressedSize, 18);
        local.writeUInt32LE(file.dataDescriptor ? 0 : declaredUncompressedSize, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);

        const cd = Buffer.alloc(ZIP_CENTRAL_DIRECTORY_FIXED_BYTES);
        cd.writeUInt32LE(file.corruptCentralSignature ? 0x00000000 : ZIP_CENTRAL_DIRECTORY_SIGNATURE, 0);
        cd.writeUInt16LE(ZIP_VERSION_NEEDED, 4);
        cd.writeUInt16LE(ZIP_VERSION_NEEDED, 6);
        cd.writeUInt16LE(flags, 8);
        cd.writeUInt16LE(method, 10);
        cd.writeUInt16LE(0, 12);
        cd.writeUInt16LE(0, 14);
        cd.writeUInt32LE(crc, 16);
        cd.writeUInt32LE(declaredCompressedSize, 20);
        cd.writeUInt32LE(declaredUncompressedSize, 24);
        cd.writeUInt16LE(nameBuf.length, 28);
        cd.writeUInt16LE(0, 30);
        cd.writeUInt16LE(0, 32);
        cd.writeUInt16LE(0, 34);
        cd.writeUInt16LE(0, 36);
        cd.writeUInt32LE(externalAttr >>> 0, 38);
        cd.writeUInt32LE(file.localHeaderOffset !== undefined ? file.localHeaderOffset : offset, 42);

        const descriptor = file.dataDescriptor ? Buffer.alloc(16) : null;
        if (descriptor) {
            descriptor.writeUInt32LE(0x08074b50, 0);
            descriptor.writeUInt32LE(crc, 4);
            descriptor.writeUInt32LE(declaredCompressedSize, 8);
            descriptor.writeUInt32LE(declaredUncompressedSize, 12);
        }
        parts.push(local, nameBuf, compressedBuf, ...(descriptor ? [descriptor] : []));
        cdEntries.push(cd, nameBuf);
        offset += local.length + nameBuf.length + compressedBuf.length + (descriptor?.length ?? 0);
    }

    const cdOffset = zipOptions.cdOffset !== undefined ? zipOptions.cdOffset : offset;
    let cdSize = 0;
    for (const p of cdEntries) cdSize += p.length;
    if (zipOptions.cdSize !== undefined) cdSize = zipOptions.cdSize;

    const totalCount = zipOptions.totalEntries !== undefined ? zipOptions.totalEntries : files.length;
    const eocd = Buffer.alloc(ZIP_END_OF_CENTRAL_DIRECTORY_BYTES);
    eocd.writeUInt32LE(zipOptions.corruptEocdSignature ? 0x00000000 : ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(totalCount, 8);
    eocd.writeUInt16LE(totalCount, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    eocd.writeUInt16LE(0, 20);

    return Buffer.concat([...parts, ...cdEntries, eocd]);
}

/**
 * Creates a complete valid synthetic evidence bundle for v1.6.1 MSI lifecycle verification.
 * @param {Object} [options]
 * @returns {Promise<Object>}
 */
export async function createPostReleaseMsiEvidenceFixture(options = {}) {
    const target = createPostReleaseV161Target();
    const harness = createPostReleaseV161HarnessContext();
    if (options.harnessOverrides) Object.assign(harness, options.harnessOverrides);

    const envelope = createV161PostReleaseMsiEnvelope(target, harness);
    const acquisitionPlan = buildV161PostReleaseMsiAcquisitionPlan(envelope, harness, PREPARATION_ROOT);
    const acquisitionRecord = createV161PostReleaseMsiAcquisitionRecord(
        acquisitionPlan,
        localObservations(acquisitionPlan),
        {path: acquisitionPlan.runtime.destinationPath, bytes: RUNTIME_BYTES, sha256: acquisitionPlan.runtime.sha256}
    );
    const preparation = await prepareWindowsMsi(acquisitionPlan);
    const fixturePreparation = await prepareFixtures(acquisitionPlan, preparation);
    const baseline = baselinePreparation(harness);

    const prepareResult = {
        schemaVersion: 1,
        kind: "myspeed-v1.6.1-post-release-msi-prepare-result",
        status: "prepared",
        qualifying: false,
        installerExecution: false,
        releaseGatesCleared: [],
        targetInput: retainedTargetInput(target, harness),
        target,
        envelope,
        acquisition: acquisitionRecord,
        windowsPreparation: preparation,
        inspections: preparation.inspections,
        fixturePreparation,
        baselinePreparation: baseline,
        pending: ["linux-transport-reobservation"]
    };

    const controllerTaskRoot = `/home/runner/work/_temp/myspeed-windows-msi-${HOST_NONCE}`;
    const controllerArtifactRoot = `${controllerTaskRoot}/appassets`;
    const artifact = {
        repository: harness.repository,
        id: "7001",
        name: "post-release-v1.6.1-msi-appassets",
        bytes: "400000000",
        digest: `sha256:${"e".repeat(64)}`,
        runId: harness.runId,
        runAttempt: harness.runAttempt,
        headSha: harness.sourceSha
    };

    const documents = new Map([
        ["result.json", prepareResult],
        ["fixture-proof.json", fixturePreparation],
        ["baseline-proof.json", baseline]
    ]);
    const identities = new Map(acquisitionPlan.files.map(file => [
        `${controllerArtifactRoot}/files/${path.win32.basename(file.destinationPath)}`,
        file.source
    ]));
    for (const file of fixturePreparation.fixtures) {
        identities.set(
            `${controllerArtifactRoot}/files/fixtures/${file.bindingId === "lower-stamp-fixture" ? "lower-stamp.msi" : "safe-rollback-predecessor.msi"}`,
            file
        );
    }
    identities.set(
        `${controllerArtifactRoot}/files/node-v22.19.0-win-x64/node.exe`,
        {bytes: acquisitionRecord.runtime.local.bytes, sha256: acquisitionPlan.runtime.sha256}
    );

    const controllerInput = {
        context: hostedContext(harness),
        taskRoot: controllerTaskRoot,
        artifactRoot: controllerArtifactRoot,
        artifact
    };

    await observeV161PostReleaseMsiPreparation(controllerInput, {
        readDocument: ({path: requested}) => {
            const value = documents.get(path.posix.basename(requested));
            const content = Buffer.from(`${JSON.stringify(value)}\n`);
            return {path: requested, bytes: content.length, sha256: sha256(content), content};
        },
        inspectFile: ({path: requested}) => {
            const expected = identities.get(requested);
            return {path: requested, bytes: expected.bytes, sha256: expected.sha256};
        }
    });

    const transport = {
        schemaVersion: 1,
        kind: "myspeed-v1.6.1-post-release-msi-preparation-transport",
        artifact,
        result: retainedTransportDocument("result.json", prepareResult),
        fixtureProof: retainedTransportDocument("fixture-proof.json", fixturePreparation),
        baselineProof: retainedTransportDocument("baseline-proof.json", baseline)
    };

    const execution = {
        root: EXECUTION_ROOT,
        transportArchiveSha256: "e".repeat(64),
        files: acquisitionPlan.files.map(file => ({
            bindingId: file.bindingId,
            role: file.role,
            path: `${EXECUTION_ROOT}/files/${path.win32.basename(file.destinationPath)}`,
            bytes: file.source.bytes,
            sha256: file.source.sha256
        })),
        fixtures: fixturePreparation.fixtures.map(file => ({
            bindingId: file.bindingId,
            role: "msi",
            path: `${EXECUTION_ROOT}/files/fixtures/${file.bindingId === "lower-stamp-fixture" ? "lower-stamp.msi" : "safe-rollback-predecessor.msi"}`,
            bytes: file.bytes,
            sha256: file.sha256
        })),
        runtime: {
            path: `${EXECUTION_ROOT}/files/node-v22.19.0-win-x64/node.exe`,
            bytes: RUNTIME_BYTES,
            sha256: acquisitionPlan.runtime.sha256
        }
    };

    const host = await createWindowsMsiLifecycleHostEvidenceFixture({
        sourceSha: harness.sourceSha,
        candidateSourceSha: target.candidate.sourceSha,
        systemTools: SYSTEM_TOOLS,
        eventSha: harness.eventSha,
        runId: harness.runId,
        runAttempt: harness.runAttempt,
        candidateManifestSha256: MANIFEST_SHA256,
        candidateArtifacts: candidateArtifacts(acquisitionPlan, fixturePreparation)
    });

    host.request.context = hostedContext(harness);
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
    host.request.baseImage = {
        path: IMAGE_PATH,
        bytes: IMAGE_BYTES,
        sha256: BASE_SHA256,
        ownership: {uid: "0", gid: "0", mode: "444", ordinaryUserWritable: false}
    };
    host.request.candidateProvenance = null;

    for (const row of host.request.rows) {
        const manifest = decodedExecution(row);
        for (const file of execution.files.filter(item => item.role === "msi")) {
            const art = manifest.artifacts.find(item => item.bindingId === file.bindingId);
            row.seedFiles.push({
                name: path.win32.basename(art.path),
                sourcePath: file.path,
                bytes: String(file.bytes),
                sha256: file.sha256
            });
        }
        for (const file of execution.fixtures) {
            const art = manifest.artifacts.find(item => item.bindingId === file.bindingId);
            row.seedFiles.push({
                name: path.win32.basename(art.path),
                sourcePath: file.path,
                bytes: String(file.bytes),
                sha256: file.sha256
            });
        }
        const node = row.seedFiles.find(file => file.name === "node.exe");
        node.sourcePath = execution.runtime.path;
        node.bytes = String(execution.runtime.bytes);
        node.sha256 = execution.runtime.sha256;
    }

    const bound = createV161PostReleaseMsiHostBinding({
        target,
        harnessContext: harness,
        envelope,
        acquisitionPlan,
        acquisitionRecord,
        preparation,
        fixturePreparation,
        baselinePreparation: baseline,
        transport,
        execution,
        installedBaseSeal: installedBaseSeal(harness),
        hostRequest: host.request
    });

    let request = structuredClone(bound.hostRequest);

    // Execute synthetic host operations to produce valid hostResult
    const rowVectors = new Map(request.rows.map(row => {
        const overlay = {
            path: row.overlayPath,
            format: "qcow2",
            backingBaseSha256: request.baseImage.sha256,
            createNew: true,
            receiptSha256: sha256(Buffer.from(row.nonce))
        };
        const media = {
            seed: {
                path: row.seedIsoPath,
                bytes: "1048576",
                sha256: sha256(Buffer.from(row.nonce)),
                manifestSha256: request.expected.closureSha256,
                readOnly: true,
                volumeLabel: "MYSPEEDSEED",
                activationHandoffSha256: sha256(Buffer.from(row.scenarioId))
            },
            outputBefore: {
                path: row.outputDiskPath,
                bytes: String(request.limits.outputDiskBytes),
                sha256: sha256(Buffer.from(row.outputDiskPath)),
                createNew: true,
                volumeLabel: "MYSPEEDOUT"
            },
            ovmfVarsSha256: request.toolchain.ovmfVarsTemplate.sha256
        };
        const rowRequest = JSON.parse(Buffer.from(row.rowRequest.bytesBase64, "base64"));
        const executionManifest = JSON.parse(Buffer.from(row.executionManifest.bytesBase64, "base64"));
        return [row.scenarioIndex, {row, overlay, media, rowRequest, executionManifest}];
    }));

    const base = {...request.baseImage, format: "qcow2", virtualBytes: "68719476736", sealedReadOnly: true};
    let now = 0;
    const operations = {
        inspectBase: async () => ({...base}),
        createOverlay: async ({row}) => ({...rowVectors.get(row.scenarioIndex).overlay}),
        prepareMedia: async ({row}) => structuredClone(rowVectors.get(row.scenarioIndex).media),
        launchRow: async ({row, overlay, media}) => {
            now += PER_ROW_SIMULATED_MS;
            const argv = buildWindowsMsiLifecycleQemuArguments({request, row, overlay, media});
            return {
                argv,
                argvSha256: sha256(Buffer.from(JSON.stringify(argv))),
                loaderPath: request.toolchain.runtimeLoader.path,
                loaderSha256: request.toolchain.runtimeLoader.sha256,
                qemuPath: request.toolchain.qemu.path,
                qemuSha256: request.toolchain.qemu.sha256,
                pid: 3000 + row.scenarioIndex,
                startTicks: String(7000 + row.scenarioIndex),
                processGroupId: 3000 + row.scenarioIndex,
                exitCode: 0,
                signal: null,
                timedOut: false,
                terminationReason: null,
                cleanupProven: true,
                treeGone: true,
                earlyBoot: earlyBoot(row.rowRoot)
            };
        },
        readGuestResult: async ({row}) => {
            const vector = rowVectors.get(row.scenarioIndex);
            const semanticResult = await createWindowsMsiGuestRowSemanticResult({
                rowRequest: vector.rowRequest,
                executionManifest: vector.executionManifest
            });
            return {
                bytes: Buffer.from(JSON.stringify(semanticResult), "utf8"),
                outputAfter: {
                    path: row.outputDiskPath,
                    bytes: String(request.limits.outputDiskBytes),
                    sha256: sha256(Buffer.from(`after-${row.nonce}`))
                }
            };
        },
        cleanupRow: async ({groupZero}) => ({groupZeroBeforeRemoval: groupZero, removed: true})
    };

    let result = structuredClone(await runWindowsMsiLifecycleHost(request, operations, {monotonicMilliseconds: () => now}));

    if (options.mutateRequest) options.mutateRequest(request);
    if (options.mutateResult) options.mutateResult(result);

    const requestBytes = Buffer.from(`${JSON.stringify(request, null, 2)}\n`, "utf8");
    const resultBytes = Buffer.from(`${JSON.stringify(result, null, 2)}\n`, "utf8");

    const files = [
        {name: "msi-host-request.json", data: requestBytes},
        {name: "msi-lifecycle-result.json", data: resultBytes}
    ];
    const closureContext = (({repository, sourceSha, eventSha, runId, runAttempt, nonce}) =>
        ({repository, sourceSha, eventSha, runId, runAttempt, nonce}))(request.context);
    const observe = member => { const bytes = fs.readFileSync(path.join(REPOSITORY_ROOT, member));
        return {path: member, bytes: String(bytes.length), sha256: sha256(bytes)}; };
    const closureBytes = Buffer.from(`${JSON.stringify(sealWindowsMsiExecutionClosure({context: closureContext,
        controller: WINDOWS_MSI_CONTROLLER_CLOSURE.map(observe), guest: WINDOWS_MSI_GUEST_CLOSURE.map(observe)}))}\n`);
    const stdoutBytes = Buffer.alloc(0);
    const stderrBytes = Buffer.alloc(0);
    const summaryBytes = Buffer.from(`${JSON.stringify({schemaVersion: 1,
        kind: "myspeed-windows-msi-lifecycle-transport-summary", status: "observed", qualifying: false,
        releaseGatesCleared: [], controllerExit: 0, resultPresent: true,
        result: {bytes: resultBytes.length, sha256: sha256(resultBytes)}, progressPresent: false,
        progress: null, rowsCompleted: 14, refusedScenarioIndex: null,
        streams: [{name: "controller.stdout", bytes: 0, sha256: sha256(stdoutBytes)},
            {name: "controller.stderr", bytes: 0, sha256: sha256(stderrBytes)}], accepted: true,
        hostRequestPresent: true, hostRequest: {bytes: requestBytes.length, sha256: sha256(requestBytes)}})}\n`);
    files.push({name: "controller.stdout", data: stdoutBytes}, {name: "controller.stderr", data: stderrBytes},
        {name: "transport-summary.json", data: summaryBytes},
        {name: "msi-execution-closure.json", data: closureBytes});
    const manifest = {schemaVersion: 1, kind: "myspeed-windows-msi-lifecycle-evidence-manifest",
        status: "observed", qualifying: false, repository: harness.repository, sourceSha: harness.sourceSha,
        runId: harness.runId, runAttempt: harness.runAttempt, nonce: request.context.nonce,
        files: files.map(file => ({name: file.name, bytes: String(file.data.length), sha256: sha256(file.data)})),
        releaseGatesCleared: []};
    if (options.mutateEvidenceManifest) options.mutateEvidenceManifest(manifest);
    files.push({name: "evidence-manifest.json", data: Buffer.from(`${JSON.stringify(manifest)}\n`)});

    if (options.mutateFiles) options.mutateFiles(files);

    const archiveBytes = createZipBuffer(files);
    const archiveSha256 = sha256(archiveBytes);

    const artifactMetadata = {
        id: Number(options.artifactId ?? DEFAULT_ARTIFACT_ID),
        name: options.artifactName ?? DEFAULT_ARTIFACT_NAME,
        size_in_bytes: archiveBytes.length,
        digest: `sha256:${archiveSha256}`,
        expired: false,
        workflow_run: {
            id: Number(harness.runId),
            head_sha: harness.sourceSha
        }
    };

    if (options.mutateMetadata) options.mutateMetadata(artifactMetadata);

    const expectedExecution = {
        repository: harness.repository,
        workflow: "post-release-msi-lifecycle.yml",
        runId: harness.runId,
        runAttempt: harness.runAttempt,
        sourceSha: harness.sourceSha,
        artifactId: options.artifactId ?? DEFAULT_ARTIFACT_ID,
        artifactName: options.artifactName ?? DEFAULT_ARTIFACT_NAME
    };

    return {
        target,
        harness,
        request,
        result,
        files: new Map(files.map(f => [f.name, f.data])),
        archiveBytes,
        archiveSha256,
        artifactMetadata,
        expectedExecution
    };
}
