import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {describe, it} from "node:test";

import {createWindowsMsiGuestLifecycleEvidenceFixture} from
    "../helpers/windows-msi-guest-lifecycle-evidence-fixture.mjs";
import {buildWindowsMsiGuestPreflightSeedDocuments, buildWindowsMsiGuestSeedDocuments} from "../../scripts/qualification/windows-msi-guest-seed-documents.mjs";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const decode = value => JSON.parse(Buffer.from(value.bytesBase64, "base64"));
const fixture = async () => {
    const aggregate = await createWindowsMsiGuestLifecycleEvidenceFixture();
    const rowRequest = decode(aggregate.evidence.rows[0].rowRequest);
    const executionManifest = decode(aggregate.evidence.rows[0].executionManifest);
    return {rowRequest, executionManifest, matrixRunner: {
        path: `${executionManifest.seedRoot}\\windows-msi-guest-matrix-executor.mjs`,
        bytes: 14_000, sha256: "1".repeat(64)}, launcher: {
        path: `${executionManifest.seedRoot}\\media-job-launcher.ps1`,
        bytes: 32_000, sha256: "2".repeat(64)}, observerSha256: "3".repeat(64),
    wallDeadlineUnixMilliseconds: 2_000_000_000_000};
};

describe("modern MSI guest seed documents", () => {
    it("builds the exact matrix envelope and owned-Job launch request for fixed staged paths", async () => {
        const input = await fixture();
        const documents = buildWindowsMsiGuestSeedDocuments(input);
        assert.deepEqual(Object.keys(documents), ["rowRequest", "executionManifest", "envelope",
            "launcherRequest"]);
        const envelope = decode(documents.envelope);
        const launch = decode(documents.launcherRequest);
        assert.equal(envelope.rowRequest.path, `${input.executionManifest.seedRoot}\\row-request.json`);
        assert.equal(envelope.executionManifest.path,
            `${input.executionManifest.seedRoot}\\execution-manifest.json`);
        assert.equal(envelope.resultPath, `${input.executionManifest.outputRoot}\\result.json`);
        assert.equal(launch.files.semanticRequest.path,
            `${input.executionManifest.seedRoot}\\matrix-envelope.json`);
        assert.equal(launch.files.semanticRequest.sha256, documents.envelope.sha256);
        assert.equal(launch.files.node.sha256, input.executionManifest.tools.node.sha256);
        assert.equal(launch.files.runner.sha256, input.matrixRunner.sha256);
        assert.equal(launch.guest.seedRoot, input.executionManifest.seedRoot);
        assert.equal(launch.guest.outputRoot, input.executionManifest.outputRoot);
        assert.equal(launch.maximumDurationMilliseconds, 16_200_000);
    });

    it("rejects foreign Stage1, paths, observer, and deadlines before producing seed bytes", async () => {
        for (const mutate of [value => { value.executionManifest.probeArtifact.sourceSha = "f".repeat(40); },
            value => { value.matrixRunner.path = "C:\\Windows\\Temp\\foreign.mjs"; },
            value => { value.launcher.path += "\n"; }, value => { value.observerSha256 = "f".repeat(63); },
            value => { value.wallDeadlineUnixMilliseconds = 0; }]) {
            const input = await fixture(); mutate(input);
            assert.throws(() => buildWindowsMsiGuestSeedDocuments(input));
        }
    });
});

describe("Windows MSI guest preflight seed documents", () => {
    const SEED = "C:\\myspeed-seed";
    const OUT = "D:\\myspeed-out";
    const preflightRequest = (overrides = {}) => ({schemaVersion: 1,
        kind: "myspeed-windows-msi-guest-containment-preflight-request", qualifying: false,
        sourceSha: "1".repeat(40), eventSha: "2".repeat(40), runId: "34900000001", runAttempt: "1",
        nonce: "9".repeat(32), bindingId: "authentic-1.6.0-default-msi",
        guest: {serial: "7".repeat(32), cpuEvidenceSha256: "d".repeat(64),
            qemuLaunchSha256: "e".repeat(64), seedRoot: SEED, outputRoot: OUT},
        msi: {path: `${SEED}\\MySpeed-1.6.0.msi`, bytes: 4_194_304, sha256: "a".repeat(64),
            productCode: "{0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0}"},
        helper: {path: `${SEED}\\windows-msi-guest-containment.ps1`, bytes: 20_480,
            sha256: "c".repeat(64)},
        tools: {powershell: {path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            sha256: "f".repeat(64)}},
        limits: {launchRecords: 256, resultBytes: 65_536}, releaseGatesCleared: [], ...overrides});

    const seed = (overrides = {}) => buildWindowsMsiGuestPreflightSeedDocuments({
        preflightRequest: preflightRequest(),
        preflightRunner: {path: `${SEED}\\windows-msi-guest-containment-preflight-executor.mjs`,
            bytes: 9_000, sha256: "1".repeat(64)},
        launcher: {path: `${SEED}\\media-job-launcher.ps1`, bytes: 8_000, sha256: "2".repeat(64)},
        node: {path: "C:\\node\\node.exe", bytes: 100, sha256: "3".repeat(64)},
        observerSha256: "4".repeat(64), wallDeadlineUnixMilliseconds: 1_789_370_000_000, ...overrides});

    /*
     * The preflight rides the transport a matrix row already uses: the same launch request document
     * that `windows-msi-guest-runner.ps1` understands, pointed at the preflight runner instead of the
     * matrix one. No new guest-side PowerShell exists, and none is needed.
     */
    it("carries the preflight through the same launch request the guest runner already reads", () => {
        const documents = seed();
        assert.deepEqual(Object.keys(documents), ["preflightRequest", "envelope", "launcherRequest"]);
        const launch = JSON.parse(Buffer.from(documents.launcherRequest.bytesBase64, "base64")
            .toString("utf8"));
        assert.equal(launch.kind, "myspeed-windows-msi-guest-launch-request");
        assert.equal(launch.files.runner.path,
            `${SEED}\\windows-msi-guest-containment-preflight-executor.mjs`);
        assert.equal(launch.files.launcher.path, `${SEED}\\media-job-launcher.ps1`);
        assert.equal(launch.files.semanticRequest.sha256, documents.envelope.sha256);
        assert.equal(launch.files.semanticRequest.bytes, documents.envelope.bytes);
        assert.equal(launch.semanticOutputPath, `${OUT}\\result.json`);
        assert.equal(launch.launcherOutputPath, `${OUT}\\launcher-result.json`);
        assert.equal(launch.guest.serial, "7".repeat(32));
        assert.equal(launch.qualifying, false);
        const envelope = JSON.parse(Buffer.from(documents.envelope.bytesBase64, "base64")
            .toString("utf8"));
        assert.equal(envelope.kind, "myspeed-windows-msi-guest-containment-preflight-envelope");
        assert.equal(envelope.preflightRequest.sha256, documents.preflightRequest.sha256);
        assert.equal(envelope.preflightRequest.bytes, documents.preflightRequest.bytes);
        assert.equal(envelope.resultPath, `${OUT}\\result.json`);
        /* Every retained document re-hashes to the digest the transport binds it by. */
        for (const document of Object.values(documents))
            assert.equal(sha256(Buffer.from(document.bytesBase64, "base64")), document.sha256);
    });

    it("refuses seed inputs that were not staged where the guest will read them", () => {
        assert.throws(() => seed({preflightRunner: {path: `${OUT}\\runner.mjs`, bytes: 1,
            sha256: "1".repeat(64)}}), /runner/iu);
        assert.throws(() => seed({launcher: {path: `${SEED}\\other.ps1`, bytes: 1,
            sha256: "2".repeat(64)}}), /launcher/iu);
        assert.throws(() => seed({observerSha256: "not-a-digest"}), /observer/iu);
        assert.throws(() => seed({wallDeadlineUnixMilliseconds: 0}), /deadline/iu);
        assert.throws(() => buildWindowsMsiGuestPreflightSeedDocuments({}), /keys/iu);
    });
});
