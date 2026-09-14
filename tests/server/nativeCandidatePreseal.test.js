import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {describe, it} from "node:test";
import {bindNativeCandidatePreseal} from "../../scripts/release/native-candidate-preseal.mjs";

const SOURCE_SHA = "a".repeat(40);
const DIGEST = "b".repeat(64);
const RUN_ID = 12345;
const RUN_ATTEMPT = 2;
const ARCHIVE_BYTES = 1024;
const PAYLOAD_BYTES = 512;
const FIRST_ARTIFACT_ID = 100;
const CANDIDATE_MANIFEST_ID = 200;
const WINDOWS_ASSETS = [
    ["MySpeed-windows-x64.exe", "MySpeed.exe", "MySpeed-windows-x64.exe"],
    ["MySpeed-windows-x64-baseline.exe", "MySpeed.exe", "MySpeed-windows-x64-baseline.exe"],
    ["release-msi-MySpeed-installer.msi", "MySpeed-installer.msi", "MySpeed-installer.msi"],
    ["release-msi-MySpeed-installer-baseline.msi", "MySpeed-installer.msi", "MySpeed-installer-baseline.msi"]
];
const serialize = value => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const fixture = () => {
    const qualification = {repository: "i7Gamer/MySpeed", sourceSha: SOURCE_SHA,
        runId: RUN_ID, runAttempt: RUN_ATTEMPT};
    const candidateManifest = {
        schemaVersion: 1,
        source: {repository: qualification.repository, sha: SOURCE_SHA, version: "1.6.1",
            windowsStamp: "1.6.1.100"},
        run: {id: RUN_ID, attempt: RUN_ATTEMPT},
        promotion: {eligible: false, evidence: {windowsNative: null, windowsCpuFloor: null, msiLifecycle: null},
            blockers: ["Windows native full verification with enforced outbound denial",
                "Windows native CPU-floor verification", "Disposable Windows MSI lifecycle acceptance"]},
        actionsArtifacts: WINDOWS_ASSETS.map(([name], index) => ({name, id: FIRST_ARTIFACT_ID + index,
            archiveDigest: `sha256:${DIGEST}`, archiveSize: ARCHIVE_BYTES})),
        releaseAssets: WINDOWS_ASSETS.map(([artifact, path, name]) =>
            ({artifact, path, name, sha256: DIGEST, size: PAYLOAD_BYTES}))
    };
    return {qualification, candidateManifest, presealBytes: serialize(candidateManifest),
        presealArtifact: {name: "release-candidate-manifest", id: CANDIDATE_MANIFEST_ID,
            archiveDigest: `sha256:${DIGEST}`, archiveSize: ARCHIVE_BYTES}};
};

describe("native request candidate preseal binding", () => {
    it("binds both aliases and installers to exact candidate bytes and Actions archives", () => {
        const input = fixture();
        const before = structuredClone(input.candidateManifest);
        const actual = bindNativeCandidatePreseal(input);
        assert.deepEqual(actual.qualification, input.qualification);
        assert.deepEqual(actual.manifest, {...input.presealArtifact,
            sha256: createHash("sha256").update(input.presealBytes).digest("hex"), bytes: input.presealBytes.length});
        assert.deepEqual(actual.windowsAssets, input.candidateManifest.releaseAssets.map((asset, index) =>
            ({...asset, actionsArtifact: input.candidateManifest.actionsArtifacts[index]})));
        assert.deepEqual(input.candidateManifest, before);
        assert.equal(actual.promotion, undefined);
    });

    it("rejects missing, altered, differently serialized, or final-manifest bytes", () => {
        for (const change of [input => { input.presealBytes = null; },
            input => { input.presealBytes = Buffer.from("{}"); },
            input => { input.presealBytes = Buffer.concat([input.presealBytes, Buffer.from(" ")]); },
            input => { input.presealBytes = Buffer.from(JSON.stringify(input.candidateManifest)); },
            input => { input.candidateManifest.promotion.eligible = true;
                input.presealBytes = serialize(input.candidateManifest); }]) {
            const input = fixture(); change(input);
            assert.throws(() => bindNativeCandidatePreseal(input));
        }
    });

    it("rejects cross-repository, cross-source, cross-run, and wrong-attempt candidates", () => {
        for (const [field, value] of [["repository", "other/repository"], ["sourceSha", "c".repeat(40)],
            ["runId", RUN_ID + 1], ["runAttempt", RUN_ATTEMPT + 1]]) {
            const input = fixture(); input.qualification[field] = value;
            assert.throws(() => bindNativeCandidatePreseal(input));
        }
    });

    it("rejects terminal newlines in every exact repository or digest identity", () => {
        for (const change of [input => {
            input.qualification.repository += "\n";
            input.candidateManifest.source.repository = input.qualification.repository;
        }, input => {
            input.qualification.sourceSha += "\n";
            input.candidateManifest.source.sha = input.qualification.sourceSha;
        }, input => { input.presealArtifact.archiveDigest += "\n"; },
        input => { input.candidateManifest.actionsArtifacts[0].archiveDigest += "\n"; },
        input => { input.candidateManifest.releaseAssets[0].sha256 += "\n"; }]) {
            const input = fixture(); change(input);
            input.presealBytes = serialize(input.candidateManifest);
            assert.throws(() => bindNativeCandidatePreseal(input));
        }
    });

    it("rejects invalid preseal archive metadata and candidate ID reuse", () => {
        for (const [field, value] of [["name", "release-qualification-manifest"], ["id", 0],
            ["id", FIRST_ARTIFACT_ID], ["archiveDigest", DIGEST], ["archiveSize", 0],
            ["archiveSize", Number.MAX_SAFE_INTEGER]]) {
            const input = fixture(); input.presealArtifact[field] = value;
            assert.throws(() => bindNativeCandidatePreseal(input));
        }
    });

    it("rejects omitted, duplicate, wrong-path, or unbound Windows assets", () => {
        for (const change of [manifest => { manifest.releaseAssets.pop(); },
            manifest => { manifest.releaseAssets.push(manifest.releaseAssets[0]); },
            manifest => { manifest.releaseAssets[0].path = "other.exe"; },
            manifest => { manifest.actionsArtifacts.pop(); },
            manifest => { manifest.actionsArtifacts.push(manifest.actionsArtifacts[0]); },
            manifest => { manifest.actionsArtifacts[1].id = manifest.actionsArtifacts[0].id; },
            manifest => { manifest.releaseAssets[0].sha256 = "invalid"; },
            manifest => { manifest.releaseAssets[0].size = 0; }]) {
            const input = fixture(); change(input.candidateManifest);
            input.presealBytes = serialize(input.candidateManifest);
            assert.throws(() => bindNativeCandidatePreseal(input));
        }
    });

    it("rejects already-cleared native gates or removed blockers", () => {
        for (const gate of ["windowsNative", "windowsCpuFloor", "msiLifecycle"]) {
            const input = fixture(); input.candidateManifest.promotion.evidence[gate] = {status: "passed"};
            input.presealBytes = serialize(input.candidateManifest);
            assert.throws(() => bindNativeCandidatePreseal(input));
        }
        const input = fixture(); input.candidateManifest.promotion.blockers.pop();
        input.presealBytes = serialize(input.candidateManifest);
        assert.throws(() => bindNativeCandidatePreseal(input));
    });
});
