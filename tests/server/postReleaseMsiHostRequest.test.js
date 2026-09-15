import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {describe, it} from "node:test";

import {buildWindowsMsiSetupCompleteActivation, getCompletedWindowsMsiActivationEvidence} from
    "../../scripts/qualification/windows-msi-post-setup-activation.mjs";
import {createWindowsMsiPrerequisiteEvidenceFixture} from
    "../helpers/windows-msi-prerequisite-evidence-fixture.mjs";
import {createWindowsMsiGuestLifecycleEvidenceFixture} from
    "../helpers/windows-msi-guest-lifecycle-evidence-fixture.mjs";
import {validateWindowsMsiGuestExecutionManifest} from "../../scripts/qualification/windows-msi-guest-matrix-operations.mjs";
import {validateWindowsMsiGuestMatrixRowRequest} from "../../scripts/qualification/windows-msi-guest-matrix-row.mjs";
import {validateWindowsMsiLifecycleHostRequest} from "../../scripts/qualification/linux-windows-msi-lifecycle-host.mjs";
import {buildV161PostReleaseMsiHostRequest, resolveV161PostReleaseMsiQemuLaunchSha256} from
    "../../scripts/release/post-release-msi-host-request.mjs";

const HARNESS_SHA = "a".repeat(40);
const CANDIDATE_SHA = "4fa4dd40efcb17f49351df6d70e60975cd4fd948";
const HOST_NONCE = "9".repeat(32);
const MINUTE = 60_000;
const JOB_BUDGET = Object.freeze({jobBudgetMilliseconds: 300 * MINUTE,
    rowAllowanceMilliseconds: 15 * MINUTE, rowCleanupMarginMilliseconds: 2 * MINUTE,
    finalMarginMilliseconds: 10 * MINUTE});
const HASH = "a".repeat(64);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const prerequisiteRecords = context => {
    const {rollbackCalibration, oldContainment} = createWindowsMsiPrerequisiteEvidenceFixture({context});
    return {rollbackCalibration, oldContainment};
};
const owned = (file, bytes = "4096", sha256 = HASH) => ({path: file, bytes, sha256,
    ownership: {uid: "0", gid: "0", mode: "444", ordinaryUserWritable: false}});
const source = (name, bytes = 4096, sha256 = HASH) => ({path: `/opt/myspeed/inputs/${name}`, bytes, sha256});

const makeInput = async () => {
    const guest = await createWindowsMsiGuestLifecycleEvidenceFixture({sourceSha: HARNESS_SHA,
        eventSha: HARNESS_SHA, candidateSourceSha: CANDIDATE_SHA});
    const sample = JSON.parse(Buffer.from(guest.evidence.rows[0].executionManifest.bytesBase64, "base64"));
    const context = {schemaVersion: 1, repository: "i7Gamer/MySpeed", sourceSha: HARNESS_SHA,
        eventSha: HARNESS_SHA, runId: "123", runAttempt: "1", nonce: HOST_NONCE,
        environment: {GITHUB_ACTIONS: "true", CI: "true", RUNNER_OS: "Linux", RUNNER_ARCH: "X64",
            RUNNER_ENVIRONMENT: "github-hosted", ImageOS: "ubuntu24", ImageVersion: "20260914.1"}};
    const activation = buildWindowsMsiSetupCompleteActivation({repository: context.repository,
        sourceSha: context.sourceSha, eventSha: context.eventSha, runId: context.runId,
        runAttempt: context.runAttempt, nonce: context.nonce});
    const systemTools = [
        {role: "msiexec", path: "C:\\Windows\\System32\\msiexec.exe", bytes: "1024", sha256: "8".repeat(64)},
        {role: "sc", path: "C:\\Windows\\System32\\sc.exe", bytes: "2048", sha256: "9".repeat(64)},
        {role: "powershell", path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            bytes: "4096", sha256: "b".repeat(64)}
    ];
    const imagePath = `/home/runner/work/_temp/myspeed-windows-cpu-floor-${HOST_NONCE}/system.qcow2`;
    const installedBaseSeal = {schemaVersion: 1, kind: "myspeed-stage2-installed-base-same-job-ephemeral",
        status: "sealed", authority: "same-job-ephemeral-identity-only", context,
        source: {stage2Classification: "github-hosted-windows-cpu-floor-stage2-calibration-nonqualifying",
            activation: getCompletedWindowsMsiActivationEvidence(activation), systemTools,
            processGroupId: 2001, qemuPid: 2001, qemuStartTicks: "123", guestOutputSha256: "c".repeat(64),
            preparedSystemDisk: {bytes: "1024", sha256: "d".repeat(64)}},
        image: {...owned(imagePath, "53687091200", "e".repeat(64)), kind: "file", dev: "8", ino: "9",
            format: "qcow2", virtualBytes: "51539607552", backingFilename: null, sealedReadOnly: true}};
    const toolchain = Object.fromEntries(["runtimeLoader", "qemu", "qemuImg", "genisoimage", "mformat",
        "mcopy", "ovmfCode", "ovmfVarsTemplate"].map((name, index) => [name,
        owned(`/opt/myspeed/tools/${name}`, String(4096 + index), String(index + 1).repeat(64).slice(0, 64))]));
    toolchain.portableRoot = "/opt/myspeed/tools"; toolchain.libraryPath = ["/opt/myspeed/tools/lib"];
    toolchain.firmware = {searchPath: "/opt/myspeed/tools/usr/share/qemu",
        kvmvapic: owned("/opt/myspeed/tools/usr/share/qemu/kvmvapic.bin", "4096", "8".repeat(64)),
        vga: owned("/opt/myspeed/tools/usr/share/seabios/vgabios-stdvga.bin", "8192", "9".repeat(64))};
    const manifest = {schemaVersion: 1,
        source: {commit: CANDIDATE_SHA, bunLockSha256: "7".repeat(64), packageSha256: "8".repeat(64)},
        populated: {root: "transport", nonce: "9".repeat(48), markerSha256: "4".repeat(64),
            databaseSha256: "6".repeat(64), filesSha256: sample.fixture.populatedFilesSha256},
        reset: {root: "reset", nonce: "a".repeat(48), markerSha256: "b".repeat(64),
            filesSha256: {".myspeed-qualification.json": "b".repeat(64)}}, expected: sample.fixture.expected};
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    const fixtureFiles = Object.entries(manifest.populated.filesSha256).map(([name, sha256], index) => ({
        name: `fixture/populated/${name}`, sourcePath: `/opt/myspeed/fixture/${name}`,
        sourceRole: "candidate", sourceSha: CANDIDATE_SHA, bytes: 100 + index, sha256}));
    fixtureFiles.push({name: "fixture/populated/destination.sentinel", sourceRole: "harness",
        sourceSha: HARNESS_SHA, sourcePath: "/opt/myspeed/generated/populated/destination.sentinel",
        bytes: 101, sha256: sample.fixture.destinationSentinelSha256},
    {name: "fixture/legacy/legacy.sentinel", sourceRole: "harness", sourceSha: HARNESS_SHA,
        sourcePath: "/opt/myspeed/generated/legacy/legacy.sentinel", bytes: 102,
        sha256: sample.fixture.legacySentinelSha256});
    const artifacts = sample.artifacts.map(({path: _path, ...item}) => ({...item,
        sourcePath: `/opt/myspeed/appassets/${item.bindingId}.msi`}));
    const cpuid = guest.expected.probeArtifact.files.find(file => file.role === "cpuid");
    const sources = {node: source("node.exe", 85_268_464, "b".repeat(64)),
        cpuid: source("cpuid.exe", Number(cpuid.bytes), cpuid.sha256),
        matrixRunner: source("windows-msi-guest-matrix-executor.mjs", 14_000, "d".repeat(64)),
        matrixOperations: source("windows-msi-guest-matrix-operations.mjs", 15_000, "6".repeat(64)),
        matrixRow: source("windows-msi-guest-matrix-row.mjs", 16_000, "7".repeat(64)),
        matrixContract: source("windows-msi-matrix-contract.mjs", 17_000, "8".repeat(64)),
        launcher: source("media-job-launcher.ps1", 32_000, "e".repeat(64)),
        runner: source("windows-msi-guest-runner.ps1", 19_000, "1".repeat(64)),
        oracle: source("oracle.mjs", 10_000, "2".repeat(64)), sqlite: source("sqlite.mjs", 11_000, "3".repeat(64)),
        oracleSafety: source("safety.mjs", 18_000, "9".repeat(64)),
        oracleFixture: source("fixture.mjs", 19_000, "a".repeat(64)),
        rollback: source("rollback.ps1", 12_000, "4".repeat(64)),
        containment: source("containment.ps1", 13_000, "5".repeat(64))};
    return {context, taskRoot: `/opt/myspeed/windows-msi/myspeed-windows-msi-${HOST_NONCE}`, toolchain,
        installedBaseSeal, candidateManifestSha256: "f".repeat(64), probeArtifact: guest.expected.probeArtifact,
        prerequisiteEvidence: prerequisiteRecords(context), budget: {...JOB_BUDGET}, artifacts,
        fixture: {manifest: {path: "/opt/myspeed/fixture/fixture.json", bytes: manifestBytes.length,
            sha256: hash(manifestBytes), bytesBase64: manifestBytes.toString("base64")},
        execution: {...sample.fixture, sourceSha: CANDIDATE_SHA, manifestSha256: hash(manifestBytes),
            populatedMarkerSha256: manifest.populated.markerSha256,
            populatedDatabaseSha256: manifest.populated.databaseSha256,
            populatedFilesSha256: manifest.populated.filesSha256, expected: manifest.expected},
        files: fixtureFiles}, sources,
        wallDeadlineUnixMilliseconds: 2_000_000_000_000};
};

describe("post-release v1.6.1 MSI host request builder", () => {
    it("builds fourteen v2 rows from authenticated byte observations without preclaimed CPUID", async () => {
        const input = await makeInput(); let provisional;
        const request = await buildV161PostReleaseMsiHostRequest(input, async provisionalRequest => {
            provisional = provisionalRequest; return resolveV161PostReleaseMsiQemuLaunchSha256(provisionalRequest);
        });
        assert.equal(request.rows.length, 14);
        assert.equal(provisional.candidateProvenance, null);
        assert.throws(() => validateWindowsMsiLifecycleHostRequest(provisional), /candidate provenance/i);
        assert.ok(provisional.rows.every(row => JSON.parse(Buffer.from(row.rowRequest.bytesBase64, "base64"))
            .guest.qemuLaunchSha256 === "0".repeat(64)));
        for (const [index, row] of request.rows.entries()) {
            const rowRequest = JSON.parse(Buffer.from(row.rowRequest.bytesBase64, "base64"));
            const execution = JSON.parse(Buffer.from(row.executionManifest.bytesBase64, "base64"));
            assert.equal(validateWindowsMsiGuestMatrixRowRequest(rowRequest), rowRequest);
            assert.equal(validateWindowsMsiGuestExecutionManifest(execution), execution);
            assert.equal(rowRequest.schemaVersion, 2);
            assert.equal(rowRequest.guest.cpuid, undefined);
            assert.equal(rowRequest.guest.qemuLaunchSha256,
                resolveV161PostReleaseMsiQemuLaunchSha256(provisional)[index]);
            assert.equal(execution.fixture.sourceSha, CANDIDATE_SHA);
            assert.equal(execution.probeArtifact.sourceSha, HARNESS_SHA);
            const destination = row.seedFiles.find(file => file.name === "fixture/populated/destination.sentinel");
            const legacy = row.seedFiles.find(file => file.name === "fixture/legacy/legacy.sentinel");
            assert.deepEqual(destination, {name: "fixture/populated/destination.sentinel",
                sourcePath: "/opt/myspeed/generated/populated/destination.sentinel", bytes: "101",
                sha256: execution.fixture.destinationSentinelSha256});
            assert.deepEqual(legacy, {name: "fixture/legacy/legacy.sentinel",
                sourcePath: "/opt/myspeed/generated/legacy/legacy.sentinel", bytes: "102",
                sha256: execution.fixture.legacySentinelSha256});
            const closureNames = row.seedFiles.slice(2, 14).map(file => file.name);
            assert.deepEqual(closureNames, ["windows-msi-guest-matrix-executor.mjs",
                "windows-msi-guest-matrix-operations.mjs", "windows-msi-guest-matrix-row.mjs",
                "windows-msi-matrix-contract.mjs", "media-job-launcher.ps1", "windows-msi-guest-runner.ps1",
                "check-artifact.mjs", "safety.mjs", "fixture.mjs", "sqlite-check.mjs",
                "windows-msi-guest-rollback.ps1", "windows-msi-guest-containment.ps1"]);
        }
        assert.equal(request.candidateProvenance, null);
        assert.equal(request.baseImage.sha256, input.installedBaseSeal.image.sha256);
    });

    it("rejects stale candidate fixtures, arbitrary empty files, and malformed launch hashes", async () => {
        for (const mutate of [
            value => { const manifest = JSON.parse(Buffer.from(value.fixture.manifest.bytesBase64, "base64"));
                manifest.source.commit = HARNESS_SHA; const data = Buffer.from(JSON.stringify(manifest));
                value.fixture.manifest = {...value.fixture.manifest, bytes: data.length,
                    sha256: hash(data), bytesBase64: data.toString("base64")}; },
            value => { value.fixture.files[0].bytes = 0; },
            value => { value.fixture.files.at(-2).sourceRole = "candidate"; },
            value => { value.fixture.files.at(-1).sourceSha = CANDIDATE_SHA; },
            value => { value.fixture.files.at(-2).sha256 = "0".repeat(64); }
        ]) {
            const value = await makeInput(); mutate(value);
            await assert.rejects(buildV161PostReleaseMsiHostRequest(value,
                async () => Array(14).fill(HASH)), /fixture|source|empty|sentinel/i);
        }
        await assert.rejects(buildV161PostReleaseMsiHostRequest(await makeInput(), async () => [HASH]),
            /launch hashes/i);
        const missingImport = await makeInput();
        delete missingImport.sources.oracleSafety;
        await assert.rejects(buildV161PostReleaseMsiHostRequest(missingImport,
            async () => Array(14).fill(HASH)), /sources.*keys/i);
    });
});
