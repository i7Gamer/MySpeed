import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {buildV161PostReleaseMsiAcquisitionPlan, createV161PostReleaseMsiAcquisitionRecord,
    validateV161PostReleaseMsiAcquisitionRecord} from
    "../../scripts/release/post-release-msi-acquisition.mjs";

const REPOSITORY = "i7Gamer/MySpeed";
const CANDIDATE_SHA = "4fa4dd40a89a062735f98bd85d685e0624ff46a8";
const HARNESS_SHA = "dce629fd50ea007221b3a9f2698c32a573bca160";
const ROOT = "C:\\runner\\post-release-msi-acquisition";
const context = () => ({repository: REPOSITORY, sourceSha: HARNESS_SHA, eventSha: HARNESS_SHA,
    runId: "40000000001", runAttempt: "1", imageVersion: "20260907.229.1",
    nonce: "a1b2c3d4e5f60718293a4b5c6d7e8f90"});
const published = (releaseAssetId, name, bytes, sha256) => ({provenance: "github-release-asset",
    releaseAssetId: String(releaseAssetId), name,
    url: `https://github.com/${REPOSITORY}/releases/download/v1.6.1/${name}`, bytes, sha256});
const envelope = () => ({schemaVersion: 1, kind: "myspeed-v1.6.1-post-release-msi-request-provenance",
    status: "bound", authority: "request-provenance-only", legacyPresealHostCompatible: false,
    harness: context(), candidate: {repository: REPOSITORY, sourceSha: CANDIDATE_SHA,
        version: "1.6.1", windowsStamp: "1.6.1.45", tagName: "v1.6.1"},
    originalQualification: {manifest: {bytes: 21518,
        sha256: "7339a6446d048bbae93759734bcafc94208e2b847af15677e847ae9a4b2f8bca"},
    archive: {name: "release-qualification-manifest"}, run: {id: 34829932391, attempt: 1}},
    publication: {releaseId: 388294074, tagName: "v1.6.1", publishedAt: "2026-09-14T10:00:58Z"},
    candidates: [{bindingId: "candidate-default",
        msi: published(563103039, "MySpeed-installer.msi", 53702656,
            "5f9573c785ee8d51a661548e74da514a24c2932c200f1c0a1de6b6e0c1a03f6d"),
        exe: published(563103772, "MySpeed-windows-x64.exe", 111524352,
            "bc4eea0a06c890eb5c0da0472a1705b3219aac3f5000383d9847120b5681d154")},
    {bindingId: "candidate-baseline",
        msi: published(563102948, "MySpeed-installer-baseline.msi", 53702656,
            "7536c7668dcb0721c643493f595bf8714114d9aa4807357a8263ffe1c9c6bbed"),
        exe: published(563103679, "MySpeed-windows-x64-baseline.exe", 111524352,
            "bc4eea0a06c890eb5c0da0472a1705b3219aac3f5000383d9847120b5681d154")} ]});

const plan = () => buildV161PostReleaseMsiAcquisitionPlan(envelope(), context(), ROOT);
const observations = value => value.files.map(file => ({bindingId: file.bindingId, role: file.role,
    path: file.destinationPath, bytes: file.source.bytes, sha256: file.source.sha256}));
const runtimeObservation = value => ({path: value.runtime.destinationPath, bytes: 77777777,
    sha256: value.runtime.sha256});

describe("fixed v1.6.1 post-release MSI acquisition", () => {
    it("plans the exact current, predecessor, and Node byte identities in closed order", () => {
        const value = plan();
        assert.deepEqual(value.files.map(file => [file.bindingId, file.role]), [
            ["candidate-default", "msi"], ["candidate-default", "exe"],
            ["candidate-baseline", "msi"], ["candidate-baseline", "exe"],
            ["authentic-1.6.0-default-msi", "msi"],
            ["authentic-1.6.0-baseline-msi", "msi"], ["authentic-1.1.0-msi", "msi"],
            ["node-22.19.0-windows-x64", "runtime-archive"]]);
        assert.deepEqual(value.files.slice(0, 4).map(file => file.source.releaseAssetId),
            [563103039, 563103772, 563102948, 563103679]);
        assert.deepEqual(value.files.slice(4, 7).map(file =>
            [file.source.releaseId, file.source.releaseAssetId, file.source.bytes, file.source.sha256]), [
            [384231789, 549130770, 51445760,
                "97c7f843aff0290a547dc56a996c78a9d5d4350b7cee954445117b13ad50debc"],
            [384231789, 549129968, 51101696,
                "d26f3acf30cfbe130ed32cb5d09ce1ccffe134e81261625bf87e49f3a5de81d2"],
            [366720262, 505104227, 50552832,
                "8c4095dfe68b77fb2c43fe6996f3d2bb0fd78bf46eedec0cc18777a91b7712e5"]]);
        assert.deepEqual(value.files[7].source, {provenance: "nodejs-release-shasums",
            version: "22.19.0", name: "node-v22.19.0-win-x64.zip",
            url: "https://nodejs.org/dist/v22.19.0/node-v22.19.0-win-x64.zip", bytes: 35424607,
            sha256: "ea3fad0e67a991d8477d8c01344b56e69c676ccb733f065b22436994b1253f86",
            executableSha256: "995a3fb3cefad590cd3f4b321532a4b9582fb9c6575320ed2e3e894caac3e362"});
        assert.deepEqual(value.runtime, {archiveBindingId: "node-22.19.0-windows-x64",
            format: "zip", member: "node-v22.19.0-win-x64/node.exe",
            destinationPath: `${ROOT}\\node-v22.19.0-win-x64\\node.exe`,
            sha256: "995a3fb3cefad590cd3f4b321532a4b9582fb9c6575320ed2e3e894caac3e362"});
        assert.ok(Object.isFrozen(value));
        assert.ok(Object.isFrozen(value.files[0].source));
        assert.equal(JSON.stringify(value).includes("actionsArtifact"), false);
    });

    it("requires the fixed published envelope and the caller's trusted harness context", () => {
        for (const mutate of [
            value => { value.publication.releaseId += 1; },
            value => { value.candidate.sourceSha = "f".repeat(40); },
            value => { value.candidates[0].msi.releaseAssetId = "1"; },
            value => { value.candidates[1].exe.sha256 = "f".repeat(64); },
            value => { value.candidates.reverse(); }
        ]) {
            const value = envelope(); mutate(value);
            assert.throws(() => buildV161PostReleaseMsiAcquisitionPlan(value, context(), ROOT));
        }
        assert.throws(() => buildV161PostReleaseMsiAcquisitionPlan(envelope(),
            {...context(), nonce: "f".repeat(32)}, ROOT), /harness/i);
        for (const invalidRoot of ["relative", "/opt/myspeed/acquisition",
            "C:\\runner\\..\\escape", "C:\\runner\\\\acquisition"]) {
            assert.throws(() => buildV161PostReleaseMsiAcquisitionPlan(
                envelope(), context(), invalidRoot), /root/i);
        }
    });

    it("plans bounded metadata inspection and fixture preparation prerequisites without product claims", () => {
        const value = plan();
        assert.deepEqual(value.inspection, {scope: "windows-installer-database-read-only",
            bindings: ["candidate-default", "candidate-baseline", "authentic-1.6.0-default-msi",
                "authentic-1.6.0-baseline-msi", "authentic-1.1.0-msi"],
            properties: ["ProductCode", "ProductVersion", "UpgradeCode"], nativeExecution: false});
        assert.deepEqual(value.fixturePreparation, [
            {bindingId: "lower-stamp-fixture", source: ".github/workflows/build-msi.yml",
                status: "requires-deterministic-prepare-adapter",
                requirement: "derive-identities-from-inspected-candidate-and-use-a-lower-windows-stamp"},
            {bindingId: "safe-rollback-predecessor",
                source: "scripts/qualification/windows-msi-rollback-calibration.ps1",
                mode: "GetFixtures", role: "predecessor"}
        ]);
        assert.equal(JSON.stringify(value.fixturePreparation).includes("productCode"), false);
    });

    it("builds and validates a detached retained local-byte record", () => {
        const acquisitionPlan = plan();
        const local = observations(acquisitionPlan);
        const runtime = runtimeObservation(acquisitionPlan);
        const record = createV161PostReleaseMsiAcquisitionRecord(acquisitionPlan, local, runtime);
        local[0].sha256 = "f".repeat(64);
        runtime.sha256 = "f".repeat(64);
        assert.equal(record.files[0].local.sha256, record.files[0].source.sha256);
        assert.deepEqual(record.runtime, {archiveBindingId: "node-22.19.0-windows-x64",
            local: {path: acquisitionPlan.runtime.destinationPath, bytes: 77777777,
                sha256: acquisitionPlan.runtime.sha256}});
        assert.ok(Object.isFrozen(record));
        assert.deepEqual(record.preparation, {repository: REPOSITORY,
            candidateSourceSha: CANDIDATE_SHA, harnessSourceSha: HARNESS_SHA,
            runId: "40000000001", runAttempt: "1", imageVersion: "20260907.229.1",
            nonce: "a1b2c3d4e5f60718293a4b5c6d7e8f90"});
        assert.equal(validateV161PostReleaseMsiAcquisitionRecord(
            JSON.parse(JSON.stringify(record)), acquisitionPlan), true);
    });

    it("rejects partial, reordered, relocated, changed, and self-asserted local bytes", () => {
        const acquisitionPlan = plan();
        const good = observations(acquisitionPlan);
        for (const [label, mutate] of [
            ["partial", value => { value.pop(); }], ["reordered", value => { value.reverse(); }],
            ["relocated", value => { value[0].path = `${ROOT}\\wrong.msi`; }],
            ["changed bytes", value => { value[0].bytes += 1; }],
            ["changed hash", value => { value[0].sha256 = "0".repeat(64); }],
            ["duplicate binding", value => { value[2].bindingId = value[0].bindingId; }]
        ]) {
            const value = structuredClone(good); mutate(value);
            assert.throws(() => createV161PostReleaseMsiAcquisitionRecord(
                acquisitionPlan, value, runtimeObservation(acquisitionPlan)), undefined, label);
        }
        for (const [label, mutate] of [
            ["runtime path", value => { value.path = `${ROOT}\\other\\node.exe`; }],
            ["runtime bytes", value => { value.bytes = 0; }],
            ["runtime hash", value => { value.sha256 = "0".repeat(64); }],
            ["runtime keys", value => { value.archiveBindingId = "self-asserted"; }]
        ]) {
            const runtime = runtimeObservation(acquisitionPlan); mutate(runtime);
            assert.throws(() => createV161PostReleaseMsiAcquisitionRecord(
                acquisitionPlan, good, runtime), undefined, label);
        }
        assert.throws(() => createV161PostReleaseMsiAcquisitionRecord(
            structuredClone(acquisitionPlan), good, runtimeObservation(acquisitionPlan)), /plan/i);
    });
});
