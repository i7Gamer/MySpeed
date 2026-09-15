import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {describe, it} from "node:test";

import {inspectCompletedWindowsMsiGuestMatrixEvidence,
    validateCompletedWindowsMsiGuestMatrixEvidence} from
    "../../scripts/qualification/windows-msi-guest-lifecycle-evidence.mjs";
import {createWindowsMsiGuestLifecycleEvidenceFixture} from
    "../helpers/windows-msi-guest-lifecycle-evidence-fixture.mjs";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const retain = value => { const bytes = Buffer.from(JSON.stringify(value)); return {
    bytes: bytes.length, sha256: sha256(bytes), bytesBase64: bytes.toString("base64")}; };

describe("Windows MSI guest lifecycle aggregate evidence", () => {
    it("replays all fourteen raw operation-specific semantic results", async () => {
        const fixture = await createWindowsMsiGuestLifecycleEvidenceFixture();
        assert.deepEqual(JSON.parse(fixture.evidenceBytes), fixture.evidence);
        assert.equal(sha256(fixture.evidenceBytes), fixture.evidenceSha256);
        assert.equal(validateCompletedWindowsMsiGuestMatrixEvidence(fixture.evidence, fixture.expected),
            fixture.evidence);
        const inspection = inspectCompletedWindowsMsiGuestMatrixEvidence(fixture.evidence, fixture.expected);
        assert.equal(inspection.status, "accepted");
        assert.equal(inspection.qualifying, false);
        assert.equal(inspection.rows.length, 14);
        assert.deepEqual(inspection.releaseGatesCleared, []);
        assert.ok(inspection.rows.every((row, index) => row.scenarioIndex === index
            && row.semanticResultSha256 === fixture.evidence.rows[index].semanticResult.sha256));
    });

    it("rejects missing, reordered, reused, foreign, or merely rehashed rows", async () => {
        const mutations = [
            value => { value.rows.pop(); },
            value => { value.rows.reverse(); },
            value => { value.rows[1].rowRequest = value.rows[0].rowRequest; },
            value => { value.rows[0].semanticResult.bytesBase64 += "AA=="; },
            value => { const semantic = JSON.parse(Buffer.from(value.rows[0].semanticResult.bytesBase64, "base64"));
                const operation = JSON.parse(Buffer.from(semantic.evidence[0].bytesBase64, "base64"));
                operation.details = {foo: true};
                const changed = Buffer.from(JSON.stringify(operation));
                const changedIdentity = {...semantic.evidence[0].identity, bytes: changed.length,
                    sha256: sha256(changed)};
                semantic.evidence[0] = {identity: changedIdentity, bytesBase64: changed.toString("base64")};
                semantic.rowResult.operationProofs[0].evidence = changedIdentity;
                semantic.rowResult.operationProofs[0].stateProofSha256 = changedIdentity.sha256;
                value.rows[0].semanticResult = retain(semantic); },
            value => { const request = JSON.parse(Buffer.from(value.rows[0].rowRequest.bytesBase64, "base64"));
                request.prerequisites.candidateManifestSha256 = "f".repeat(64);
                value.rows[0].rowRequest = retain(request); },
            value => { const request = JSON.parse(Buffer.from(value.rows[0].rowRequest.bytesBase64, "base64"));
                request.prerequisites.fixtureManifestSha256 = "f".repeat(64);
                value.rows[0].rowRequest = retain(request); },
            value => { const execution = JSON.parse(Buffer.from(value.rows[0].executionManifest.bytesBase64,
                "base64")); execution.fixture.manifestSha256 = "f".repeat(64);
                value.rows[0].executionManifest = retain(execution); },
            value => { value.releaseGatesCleared.push("msiLifecycle"); }
        ];
        for (const mutate of mutations) {
            const fixture = await createWindowsMsiGuestLifecycleEvidenceFixture();
            mutate(fixture.evidence);
            assert.throws(() => validateCompletedWindowsMsiGuestMatrixEvidence(fixture.evidence,
                fixture.expected));
        }
    });

    it("requires external source, preseal, closure, base-image, and Stage1 expectations", async () => {
        for (const name of ["sourceSha", "eventSha", "runId", "runAttempt", "candidateManifestSha256",
            "closureSha256", "fixtureManifestSha256", "rollbackCalibrationSha256", "oldContainmentSha256",
            "baseImageSha256", "probeArtifact"]) {
            const fixture = await createWindowsMsiGuestLifecycleEvidenceFixture();
            if (name === "probeArtifact") fixture.expected[name] = {...fixture.expected[name], artifactId: "999"};
            else fixture.expected[name] = name.endsWith("Sha256") || name.endsWith("Sha")
                ? "f".repeat(fixture.expected[name].length) : name === "runId" ? "999" : "9";
            assert.throws(() => validateCompletedWindowsMsiGuestMatrixEvidence(fixture.evidence,
                fixture.expected), /binding|probe/i);
        }
    });

    it("binds caller-supplied provenance and candidate identities into every nonce-owned row", async () => {
        const sourceSha = "3".repeat(40); const eventSha = "4".repeat(40);
        const probeFixture = await createWindowsMsiGuestLifecycleEvidenceFixture({sourceSha, eventSha,
            runId: "987654", runAttempt: "2", candidateManifestSha256: "5".repeat(64),
            candidateArtifacts: {"candidate-default": {msi: {bytes: 51_445_760, sha256: "6".repeat(64)},
                exe: {bytes: 85_000_001, sha256: "7".repeat(64)}},
            "candidate-baseline": {msi: {bytes: 51_101_696, sha256: "8".repeat(64)},
                exe: {bytes: 84_000_001, sha256: "9".repeat(64)}}}});
        assert.equal(probeFixture.expected.sourceSha, sourceSha);
        assert.equal(probeFixture.expected.eventSha, eventSha);
        assert.equal(probeFixture.expected.probeArtifact.sourceSha, sourceSha);
        assert.equal(probeFixture.expected.probeArtifact.runId, "987654");
        for (const retainedRow of probeFixture.evidence.rows) {
            const request = JSON.parse(Buffer.from(retainedRow.rowRequest.bytesBase64, "base64"));
            const execution = JSON.parse(Buffer.from(retainedRow.executionManifest.bytesBase64, "base64"));
            const expectedInput = `C:\\Windows\\Temp\\myspeed-msi-input-${request.nonce}`;
            const expectedOutput = `C:\\Windows\\Temp\\myspeed-msi-output-${request.nonce}`;
            assert.equal(execution.seedRoot, expectedInput);
            assert.equal(execution.outputRoot, expectedOutput);
            assert.equal(request.guest.evidenceRoot, expectedOutput);
            assert.deepEqual(execution.artifacts.slice(0, 2).map(({bytes, sha256, exeBytes, exeSha256}) =>
                ({bytes, sha256, exeBytes, exeSha256})), [
                {bytes: 51_445_760, sha256: "6".repeat(64), exeBytes: 85_000_001, exeSha256: "7".repeat(64)},
                {bytes: 51_101_696, sha256: "8".repeat(64), exeBytes: 84_000_001, exeSha256: "9".repeat(64)}]);
        }
        const suppliedProbe = structuredClone(probeFixture.expected.probeArtifact);
        suppliedProbe.artifactId = "654321";
        suppliedProbe.archive.sha256 = "c".repeat(64);
        suppliedProbe.files[2].sha256 = "d".repeat(64);
        const rebound = await createWindowsMsiGuestLifecycleEvidenceFixture({sourceSha, eventSha,
            runId: "987654", runAttempt: "2", candidateManifestSha256: "5".repeat(64),
            overlayReceiptSha256ByScenario: Array.from({length: 14}, (_, index) =>
                String(index + 10).repeat(64).slice(0, 64)),
            qemuLaunchSha256ByScenario: Array.from({length: 14}, (_, index) =>
                String(index + 24).repeat(64).slice(0, 64)),
            probeArtifact: suppliedProbe, candidateArtifacts: {"candidate-default": {
                msi: {bytes: 51_445_760, sha256: "6".repeat(64)},
                exe: {bytes: 85_000_001, sha256: "7".repeat(64)}}, "candidate-baseline": {
                msi: {bytes: 51_101_696, sha256: "8".repeat(64)},
                exe: {bytes: 84_000_001, sha256: "9".repeat(64)}}}});
        assert.deepEqual(rebound.expected.probeArtifact, suppliedProbe);
        rebound.evidence.rows.forEach((row, index) => {
            const request = JSON.parse(Buffer.from(row.rowRequest.bytesBase64, "base64"));
            assert.equal(request.guest.overlayReceiptSha256,
                String(index + 10).repeat(64).slice(0, 64));
            assert.equal(request.guest.qemuLaunchSha256, String(index + 24).repeat(64).slice(0, 64));
        });
    });
});
