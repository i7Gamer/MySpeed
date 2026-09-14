import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {describe, it} from "node:test";

import {runV161PostReleaseMsiPrepare} from
    "../../scripts/release/post-release-msi-prepare-controller.mjs";
import {createPostReleaseV161Target} from "../helpers/post-release-v161-target-fixture.mjs";

const WORKFLOW = fs.readFileSync(".github/workflows/post-release-msi-prepare.yml", "utf8");

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
            const operations = {initialize: async () => {}, download: async () => {},
                observe: async file => ({bindingId: file.bindingId, role: file.role,
                    path: file.destinationPath, bytes: file.source.bytes, sha256: file.source.sha256}),
                extractZipMember: async () => {}, observeRuntime: async runtime =>
                    ({path: runtime.destinationPath, bytes: 90000000, sha256: runtime.sha256}),
                inspectMsi: async () => ({ProductCode: "{AAAAAAAA-1111-1111-1111-111111111111}",
                    ProductVersion: "1.6.1.0", UpgradeCode: "{BBBBBBBB-2222-2222-2222-222222222222}"})};
            const result = await runV161PostReleaseMsiPrepare({environment: {GITHUB_ACTIONS: "true",
                CI: "true", GITHUB_REPOSITORY: "i7Gamer/MySpeed", GITHUB_SHA: target.harness.sourceSha,
                GITHUB_RUN_ID: "40000000001", GITHUB_RUN_ATTEMPT: "1", ImageVersion: "20260907.229.1",
                RUNNER_OS: "Windows", RUNNER_ARCH: "X64", RUNNER_ENVIRONMENT: "github-hosted"},
            captured, manifestBytes: fs.readFileSync(
                "tests/fixtures/post-release-native-v1.6.1/qualification-manifest.json"),
            acquisitionRoot, outputPath, powershellPath: "C:\\hostedtoolcache\\pwsh.exe", operations,
            now: () => new Date("2026-09-14T12:30:00Z")});
            assert.equal(result.target.candidate.sourceSha, target.candidate.sourceSha);
            assert.equal(result.envelope.harness.imageVersion, "20260907.229.1");
            assert.deepEqual(result.windowsPreparation.preparation, result.acquisition.preparation);
            assert.equal(result.inspections.length, 5);
            assert.deepEqual(result.releaseGatesCleared, []);
            assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, "utf8")), result);
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
        assert.match(WORKFLOW, /post-release-v1\.6\.1-msi-preparation/u);
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
