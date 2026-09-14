import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {describe, it} from "node:test";

import {runV161PostReleaseMsiPrepare} from
    "../../scripts/release/post-release-msi-prepare-controller.mjs";
import {createPostReleaseV161Target} from "../helpers/post-release-v161-target-fixture.mjs";

const WORKFLOW = fs.readFileSync(".github/workflows/post-release-msi-prepare.yml", "utf8");
const HASH = character => character.repeat(64);
const candidatePayload = () => ({exe: {bytes: 111_524_352,
    sha256: "bc4eea0a06c890eb5c0da0472a1705b3219aac3f5000383d9847120b5681d154",
    fileVersion: "1.6.1.45", productVersion: "1.6.1.45"},
configuration: {bytes: 450, sha256: HASH("c")},
wrapper: {bytes: 12_000_000, sha256: HASH("d")}, inventory: [
    {path: "File/MySpeed.exe", bytes: 111_524_352,
        sha256: "bc4eea0a06c890eb5c0da0472a1705b3219aac3f5000383d9847120b5681d154"},
    {path: "File/MySpeedService.exe", bytes: 12_000_000, sha256: HASH("d")},
    {path: "File/MySpeedService.xml", bytes: 450, sha256: HASH("c")},
    {path: "File/WinSW-LICENSE.txt", bytes: 1_000, sha256: HASH("7")}
]});
const predecessorPayload = () => { const value = candidatePayload();
    value.exe = {bytes: 100_000_000, sha256: HASH("6"), fileVersion: "1.6.0.44",
        productVersion: "1.6.0.44"};
    value.inventory[0] = {path: "File/MySpeed.exe", bytes: value.exe.bytes,
        sha256: value.exe.sha256}; return value; };

describe("post-release MSI hosted preparation workflow", () => {
    it("runs the real controller with injected I/O and retains the complete Windows binding", async () => {
        const target = createPostReleaseV161Target();
        const {provenance: runProvenance, ...qualificationRun} = target.originalQualification.run;
        const {provenance: archiveProvenance, ...qualificationArchive} = target.originalQualification.archive;
        const captured = {tag: {repository: target.candidate.repository, name: target.candidate.tagName,
            commitSha: target.candidate.sourceSha}, qualificationRun, qualificationArchive,
        release: {repository: target.candidate.repository, id: target.publication.releaseId,
            tagName: target.publication.tagName, targetCommitish: "development",
            createdAt: "2026-09-14T09:48:17Z", publishedAt: target.publication.publishedAt,
            draft: false, prerelease: false, platformImmutable: false,
            assets: target.publication.assets.map(({provenance, ...asset}) => asset)}};
        assert.equal(runProvenance, "github-actions-run");
        assert.equal(archiveProvenance, "github-actions-archive");
        const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-msi-prepare-test-"));
        try {
            const acquisitionRoot = process.platform === "win32"
                ? path.join(temporary, "bundle", "files")
                : path.win32.join("C:\\qualification", path.basename(temporary), "bundle", "files");
            const outputPath = path.join(temporary, "bundle", "result.json");
            const fixtureProofPath = path.join(temporary, "bundle", "fixture-proof.json");
            const fixtureOutputRoot = path.win32.join(acquisitionRoot, "fixtures");
            const operations = {initialize: async () => {}, download: async () => {},
                observe: async file => ({bindingId: file.bindingId, role: file.role,
                    path: file.destinationPath, bytes: file.source.bytes, sha256: file.source.sha256}),
                extractZipMember: async () => {}, observeRuntime: async runtime =>
                    ({path: runtime.destinationPath, bytes: 90000000, sha256: runtime.sha256}),
                inspectMsi: async input => ({ProductCode: "{AAAAAAAA-1111-1111-1111-111111111111}",
                    ProductVersion: input.bindingId.startsWith("candidate-") ? "1.6.1.0" : "1.6.0.0",
                    UpgradeCode: "{A1B2C3D4-5E6F-7890-ABCD-EF1234567890}"})};
            const fixtureOperations = {initialize: async () => {}, inspectPayload: async input =>
                input.bindingId === "candidate-default" ? candidatePayload() : predecessorPayload(),
            buildClone: async input => ({bindingId: input.bindingId, path: input.destinationPath,
                bytes: 40_000_000, sha256: input.bindingId === "lower-stamp-fixture" ? HASH("e") : HASH("f"),
                properties: {ProductCode: input.productCode, ProductVersion: input.productVersion,
                    UpgradeCode: input.upgradeCode, PackageCode: input.packageCode},
                payload: structuredClone(input.expectedPayload)})};
            const result = await runV161PostReleaseMsiPrepare({environment: {GITHUB_ACTIONS: "true",
                CI: "true", GITHUB_REPOSITORY: "i7Gamer/MySpeed", GITHUB_SHA: target.harness.sourceSha,
                GITHUB_RUN_ID: "40000000001", GITHUB_RUN_ATTEMPT: "1", ImageVersion: "20260907.229.1",
                RUNNER_OS: "Windows", RUNNER_ARCH: "X64", RUNNER_ENVIRONMENT: "github-hosted"},
            captured, manifestBytes: fs.readFileSync(
                "tests/fixtures/post-release-native-v1.6.1/qualification-manifest.json"),
            acquisitionRoot, fixtureOutputRoot, outputPath, fixtureProofPath,
            powershellPath: "C:\\hostedtoolcache\\pwsh.exe", operations, fixtureOperations,
            now: () => new Date("2026-09-14T12:30:00Z")});
            assert.equal(result.target.candidate.sourceSha, target.candidate.sourceSha);
            assert.equal(result.envelope.harness.imageVersion, "20260907.229.1");
            assert.deepEqual(result.windowsPreparation.preparation, result.acquisition.preparation);
            assert.equal(result.inspections.length, 5);
            assert.deepEqual(result.fixturePreparation.fixtures.map(item => item.bindingId),
                ["lower-stamp-fixture", "safe-rollback-predecessor"]);
            assert.equal(result.fixturePreparation.fixtures[0].exeFileVersion, "1.6.0.44");
            assert.equal(result.fixturePreparation.installerExecution, false);
            assert.deepEqual(result.releaseGatesCleared, []);
            assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, "utf8")), result);
            assert.deepEqual(JSON.parse(fs.readFileSync(fixtureProofPath, "utf8")),
                result.fixturePreparation);
        } finally { fs.rmSync(temporary, {recursive: true, force: false}); }
    });

    it("is manual, read-only, pinned, nonpublishing, and runs only hosted preparation", () => {
        assert.match(WORKFLOW, /workflow_dispatch:/u);
        assert.match(WORKFLOW, /permissions:\s*\n\s+actions: read\s*\n\s+contents: read/u);
        assert.match(WORKFLOW, /runs-on: windows-2025/u);
        assert.match(WORKFLOW, /actions\/checkout@[0-9a-f]{40}/u);
        assert.match(WORKFLOW, /actions\/setup-node@[0-9a-f]{40}[\s\S]*node-version: 22\.19\.0/u);
        assert.match(WORKFLOW, /post-release-msi-prepare-controller\.mjs/u);
        assert.match(WORKFLOW, /Get-Command pwsh -CommandType Application/u);
        assert.match(WORKFLOW, /wix314-binaries\.zip/u);
        assert.match(WORKFLOW, /6ac824e1642d6f7277d0ed7ea09411a508f6116ba6fae0aa5f2c7daa2ff43d31/u);
        for (const tool of ["dark.exe", "candle.exe", "light.exe"]) assert.ok(WORKFLOW.includes(tool));
        assert.match(WORKFLOW, /--fixture-root/u);
        assert.match(WORKFLOW, /--fixture-proof/u);
        assert.match(WORKFLOW, /post-release-v1\.6\.1-msi-appassets/u);
        assert.doesNotMatch(WORKFLOW, /contents: write|packages: write|gh release|msiexec|MsiInstallProduct/u);
    });

    it("captures the exact target authorities and retains an explicitly bounded manifest", () => {
        for (const value of ["34829932391", "10342345489", "v1.6.1", "release.immutable",
            "artifact.digest", "artifact.workflow_run?.head_sha"]) assert.ok(WORKFLOW.includes(value));
        assert.match(WORKFLOW, /\$item\.Length -ne 21518/u);
        assert.match(WORKFLOW, /7339a6446d048bbae93759734bcafc94208e2b847af15677e847ae9a4b2f8bca/u);
        assert.match(WORKFLOW, /include-hidden-files: true[\s\S]*if-no-files-found: error/u);
    });
});
