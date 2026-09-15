import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {describe, it} from "node:test";
import {fileURLToPath} from "node:url";

import {bindV161PostReleaseTarget}
    from "../../scripts/release/post-release-target.mjs";
import {
    createV161PostReleaseCpuFloorBinding,
    buildV161PostReleaseCpuFloorStage2Request,
    buildV161PostReleaseCpuFloorStage3Request,
    inspectV161PostReleaseCpuFloorEvidence
} from "../../scripts/release/post-release-cpu-floor.mjs";
import {WINDOWS_MSI_STAGE2_CLOSURE}
    from "../../scripts/qualification/windows-msi-stage2-request.mjs";
import {runHostedStage2Controller}
    from "../../scripts/qualification/linux-windows-cpu-floor-stage2-controller.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = path.join(HERE, "..", "fixtures", "post-release-native-v1.6.1",
    "qualification-manifest.json");
const HARNESS_SHA = "dce629fd50ea007221b3a9f2698c32a573bca160";
const CANDIDATE_SHA = "4fa4dd40a89a062735f98bd85d685e0624ff46a8";
const REPOSITORY = "i7Gamer/MySpeed";
const TAG_NAME = "v1.6.1";
const HOSTED_RUN_ID = "40000000001";
const HOSTED_RUN_ATTEMPT = "1";
const HOSTED_NONCE = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const HOSTED_IMAGE_VERSION = "20260914.1";
const BASELINE_ARTIFACT_ID = 10341896645;
const BASELINE_ARCHIVE_SIZE = 46649471;
const BASELINE_ARCHIVE_DIGEST = "sha256:280b4a99c8a1f20aca5958c065b12ecb14519125769ee0460840168963db07ed";
const DEFAULT_SUMMARY_SHA256 = "042d5f2d2d761680891d3140ca2278f9aa358400c2a00601f8780b6bdfdf98ec";
const RELEASE_URL = `https://github.com/${REPOSITORY}/releases/download/${TAG_NAME}`;

const asset = (id, name, size, digest, createdAt, updatedAt = createdAt) => ({
    id, name, size, digest: `sha256:${digest}`, state: "uploaded",
    url: `${RELEASE_URL}/${name}`, createdAt, updatedAt
});

const PUBLISHED_ASSETS = [
    asset(563102879, "chooser.sh", 2147, "498a962a39ffb4be3724e1760a884ea5db0589006339b80399fa2bb854dcbb01", "2026-09-14T09:57:03Z"),
    asset(563102916, "docker-install.sh", 4029, "f86678e7c6eecb9eeded69e7a6a8dbc86b0e46513457860af1d1fee78a7fb973", "2026-09-14T09:57:04Z"),
    asset(563102933, "install.sh", 40748, "1d7af2bf2827546ee59dfea772dc6b2252edb3aa27979383b30116a9e49b0d24", "2026-09-14T09:57:04Z"),
    asset(563102948, "MySpeed-installer-baseline.msi", 53702656, "7536c7668dcb0721c643493f595bf8714114d9aa4807357a8263ffe1c9c6bbed", "2026-09-14T09:57:05Z", "2026-09-14T09:57:06Z"),
    asset(563103039, "MySpeed-installer.msi", 53702656, "5f9573c785ee8d51a661548e74da514a24c2932c200f1c0a1de6b6e0c1a03f6d", "2026-09-14T09:57:07Z", "2026-09-14T09:57:09Z"),
    asset(563103127, "MySpeed-linux-arm64", 109889832, "2291f02f5b995729c7aa4e63b8064f121c10b573a5b95ae676db33f159e15aec", "2026-09-14T09:57:09Z", "2026-09-14T09:57:13Z"),
    asset(563103263, "MySpeed-linux-x64", 110970336, "a609c72e046711dff4f5455dc9dd23a9f75d231d941bcf355ebe91ff3043b56d", "2026-09-14T09:57:13Z", "2026-09-14T09:57:17Z"),
    asset(563103405, "MySpeed-linux-x64-baseline", 110970336, "a609c72e046711dff4f5455dc9dd23a9f75d231d941bcf355ebe91ff3043b56d", "2026-09-14T09:57:17Z", "2026-09-14T09:57:21Z"),
    asset(563103531, "MySpeed-macos-arm64", 86846322, "dc0f6d0e856c34c429732a4c6bbdf45c0a34197d326a1d54dcf6543ed0c7ac4b", "2026-09-14T09:57:21Z", "2026-09-14T09:57:24Z"),
    asset(563103597, "MySpeed-macos-x64", 94089488, "9203f8a2f12da52843bc8e0088b089ea51b632abd035181f4e3aa2ee9660df1a", "2026-09-14T09:57:24Z", "2026-09-14T09:57:28Z"),
    asset(563103679, "MySpeed-windows-x64-baseline.exe", 111524352, "bc4eea0a06c890eb5c0da0472a1705b3219aac3f5000383d9847120b5681d154", "2026-09-14T09:57:28Z", "2026-09-14T09:57:32Z"),
    asset(563103772, "MySpeed-windows-x64.exe", 111524352, "bc4eea0a06c890eb5c0da0472a1705b3219aac3f5000383d9847120b5681d154", "2026-09-14T09:57:32Z", "2026-09-14T09:57:36Z"),
    asset(563103908, "MySpeed.zip", 2544233, "94a59173b54fcac832792ba63991e9668e56e8f6b31e0d0eaa085378f90707e6", "2026-09-14T09:57:36Z", "2026-09-14T09:57:37Z"),
    asset(563103929, "qualification-manifest.json", 21518, "7339a6446d048bbae93759734bcafc94208e2b847af15677e847ae9a4b2f8bca", "2026-09-14T09:57:37Z", "2026-09-14T09:57:38Z"),
    asset(563103942, "qualification-manifest.json.sha256", 65, "88f72f092718559b38b9ed99ff3fad7dd738164bc43eb93bd7749b5a004f82de", "2026-09-14T09:57:38Z"),
    asset(563103918, "SHA256SUMS", 1123, "41bd455bfc3875f3ec722406e15bae173836ca6ddafe99524fc8c8aa21a002e0", "2026-09-14T09:57:37Z")
];

const targetFixture = () => ({
    harnessSourceSha: HARNESS_SHA,
    observedAt: "2026-09-14T12:30:00Z",
    manifestBytes: fs.readFileSync(MANIFEST_PATH),
    tag: {repository: REPOSITORY, name: TAG_NAME, commitSha: CANDIDATE_SHA},
    qualificationRun: {repository: REPOSITORY, id: 34829932391, attempt: 1,
        headSha: CANDIDATE_SHA, event: "workflow_dispatch", status: "completed", conclusion: "success",
        workflowName: "Qualify release candidate", createdAt: "2026-09-14T09:48:50Z",
        updatedAt: "2026-09-14T09:54:31Z"},
    qualificationArchive: {repository: REPOSITORY, id: 10342345489,
        name: "release-qualification-manifest", size: 7046,
        digest: "sha256:18c3ecc771432edd7d4e3434243b449d58dc983851d9c1bf244ca12897aec077",
        expired: false, createdAt: "2026-09-14T09:54:28Z", updatedAt: "2026-09-14T09:54:28Z",
        expiresAt: "2026-09-21T09:54:27Z", runId: 34829932391, runAttempt: 1,
        headSha: CANDIDATE_SHA},
    release: {repository: REPOSITORY, id: 388294074, tagName: TAG_NAME,
        targetCommitish: "development", createdAt: "2026-09-14T09:48:17Z",
        publishedAt: "2026-09-14T10:00:58Z", draft: false, prerelease: false,
        platformImmutable: false, assets: structuredClone(PUBLISHED_ASSETS)}
});

const hostedContext = () => ({
    repository: REPOSITORY,
    runId: HOSTED_RUN_ID,
    runAttempt: HOSTED_RUN_ATTEMPT,
    eventSha: HARNESS_SHA,
    imageVersion: HOSTED_IMAGE_VERSION,
    nonce: HOSTED_NONCE
});

const baselineSummaryArtifactFixture = () => {
    // Exact synthetic summary payload matching BASELINE_SUMMARY_SHA256
    // Since we want the digest to match, we can create buffer with known hash or match the fixture
    const summaryContent = JSON.stringify({
        schemaVersion: 1, mode: "listener-free-reset", artifact: "MySpeed-windows-x64-baseline.exe",
        sha256: "bc4eea0a06c890eb5c0da0472a1705b3219aac3f5000383d9847120b5681d154"
    });
    const bytes = Buffer.from(summaryContent);
    const hash = createHash("sha256").update(bytes).digest("hex");
    return {
        id: BASELINE_ARTIFACT_ID,
        name: "MySpeed-windows-x64-baseline.exe",
        runId: 34829932391,
        runAttempt: 1,
        headSha: CANDIDATE_SHA,
        archiveDigest: BASELINE_ARCHIVE_DIGEST,
        archiveSize: BASELINE_ARCHIVE_SIZE,
        summaryPath: "qualification-summary.json",
        summaryBytes: bytes,
        summarySha256: hash
    };
};

describe("v1.6.1 post-release CPU-floor consumer", () => {
    it("creates an immutable binding from valid target, hosted context, and baseline summary", () => {
        const target = bindV161PostReleaseTarget(targetFixture());
        const summaryArtifact = baselineSummaryArtifactFixture();
        const binding = createV161PostReleaseCpuFloorBinding(target, hostedContext(), summaryArtifact);

        assert.equal(binding.kind, "myspeed-v1.6.1-post-release-cpu-floor-binding");
        assert.equal(binding.qualifying, false);
        assert.equal(binding.releaseGateCleared, false);
        assert.deepEqual(binding.releaseGatesCleared, []);
        assert.equal(binding.candidate.sourceSha, CANDIDATE_SHA);
        assert.equal(binding.harness.sourceSha, HARNESS_SHA);
        assert.equal(binding.candidate.artifact.id, String(BASELINE_ARTIFACT_ID));
        assert.equal(binding.candidate.exeAsset.name, "MySpeed-windows-x64-baseline.exe");
        assert.ok(Object.isFrozen(binding));
    });

    it("fails closed when harness source SHA is substituted with candidate SHA", () => {
        const target = bindV161PostReleaseTarget(targetFixture());
        const summaryArtifact = baselineSummaryArtifactFixture();
        const badContext = hostedContext();
        badContext.eventSha = CANDIDATE_SHA;

        assert.throws(() => createV161PostReleaseCpuFloorBinding(target, badContext, summaryArtifact),
            /harness source/i);
    });

    it("fails closed when default summary is swapped for baseline summary", () => {
        const target = bindV161PostReleaseTarget(targetFixture());
        const summaryArtifact = baselineSummaryArtifactFixture();
        summaryArtifact.summarySha256 = DEFAULT_SUMMARY_SHA256;

        assert.throws(() => createV161PostReleaseCpuFloorBinding(target, hostedContext(), summaryArtifact),
            /baseline summary/i);
    });

    it("fails closed when summary bytes do not match declared summary SHA256", () => {
        const target = bindV161PostReleaseTarget(targetFixture());
        const summaryArtifact = baselineSummaryArtifactFixture();
        summaryArtifact.summaryBytes = Buffer.from("tampered bytes");

        assert.throws(() => createV161PostReleaseCpuFloorBinding(target, hostedContext(), summaryArtifact),
            /summary digest|hash/i);
    });

    it("fails closed when artifact metadata is altered or wrong", () => {
        const target = bindV161PostReleaseTarget(targetFixture());
        for (const mutate of [
            art => { art.id = 99999999999; },
            art => { art.name = "MySpeed-windows-x64.exe"; },
            art => { art.runId = 11111; },
            art => { art.archiveDigest = "sha256:" + "0".repeat(64); }
        ]) {
            const summaryArtifact = baselineSummaryArtifactFixture();
            mutate(summaryArtifact);
            assert.throws(() => createV161PostReleaseCpuFloorBinding(target, hostedContext(), summaryArtifact),
                /artifact/i);
        }
    });

    it("builds a Stage 2 request compatible with runHostedStage2Controller", async () => {
        const target = bindV161PostReleaseTarget(targetFixture());
        const summaryArtifact = baselineSummaryArtifactFixture();
        const binding = createV161PostReleaseCpuFloorBinding(target, hostedContext(), summaryArtifact);

        const inputRoot = `/home/runner/work/_temp/myspeed-stage2-input-${HOSTED_NONCE}`;
        const identity = targetPath => ({
            path: targetPath,
            bytes: 4096,
            sha256: createHash("sha256").update(targetPath).digest("hex")
        });

        const probeArtifact = {
            sourceSha: HARNESS_SHA, runId: HOSTED_RUN_ID, runAttempt: HOSTED_RUN_ATTEMPT,
            artifactId: "123456",
            archiveBytes: "4096",
            archiveSha256: identity(`${inputRoot}/artifact.zip`).sha256,
            files: ["avx", "avx2", "cpuid", "illegal", "known-bad", "known-good", "popcnt", "sse42"].map(role => {
                const name = `${role.replaceAll("-", "_")}.exe`;
                return {
                    role,
                    name,
                    bytes: "4096",
                    sha256: identity(`${inputRoot}/${name}`).sha256
                };
            })
        };

        const stage2Req = buildV161PostReleaseCpuFloorStage2Request(binding, probeArtifact, identity);

        assert.equal(stage2Req.context.eventSha, HARNESS_SHA);
        assert.equal(stage2Req.closure.files.length, WINDOWS_MSI_STAGE2_CLOSURE.length);

        // Verify compatibility against runHostedStage2Controller with injected inert operations
        let admittedContext = null;
        await runHostedStage2Controller(stage2Req, {
            readVerified: targetPath => {
                const member = stage2Req.closure.files.find(f => f.path === targetPath) || {
                    path: targetPath, bytes: "4096", sha256: identity(targetPath).sha256
                };
                return {bytes: Buffer.alloc(Number(member.bytes)), sha256: member.sha256};
            },
            collectAdmission: value => {
                admittedContext = value.context;
                throw new Error("stopped after validation");
            }
        }).catch(error => {
            if (error.message !== "stopped after validation") throw error;
        });

        assert.equal(admittedContext.eventSha, HARNESS_SHA);
    });

    it("builds a Stage 3 request binding distinct candidate target and harness context", () => {
        const target = bindV161PostReleaseTarget(targetFixture());
        const summaryArtifact = baselineSummaryArtifactFixture();
        const binding = createV161PostReleaseCpuFloorBinding(target, hostedContext(), summaryArtifact);

        const sameExecutionStage2 = {
            result: {
                path: `/home/runner/work/_temp/myspeed-stage2-transport-${HOSTED_NONCE}/stage2-result.json`,
                bytes: "4096",
                sha256: "1".repeat(64)
            },
            guestResult: {
                path: `/home/runner/work/_temp/myspeed-stage2-transport-${HOSTED_NONCE}/guest-result.json`,
                bytes: "2048",
                sha256: "2".repeat(64)
            }
        };

        const stage3Req = buildV161PostReleaseCpuFloorStage3Request(binding, sameExecutionStage2);

        assert.equal(stage3Req.schemaVersion, 1);
        assert.equal(stage3Req.profile, "baseline-cpu");
        assert.equal(stage3Req.context.eventSha, HARNESS_SHA);
        assert.notEqual(stage3Req.candidate.sourceSha, stage3Req.context.sourceSha);
        assert.equal(stage3Req.candidate.sourceSha, CANDIDATE_SHA);
        assert.equal(stage3Req.candidate.tagName, TAG_NAME);
        assert.equal(stage3Req.candidate.file.name, "MySpeed.exe");
        assert.equal(stage3Req.candidate.file.sha256, binding.candidate.exeAsset.sha256);
        assert.equal(stage3Req.candidate.qualificationSummary.sha256, summaryArtifact.summarySha256);
        assert.equal(stage3Req.paths.root, `/home/runner/work/_temp/myspeed-stage3-${HOSTED_NONCE}`);
        assert.deepEqual(stage3Req.stage2, sameExecutionStage2);
    });

    it("inspects evidence and maintains non-qualifying invariants", () => {
        const target = bindV161PostReleaseTarget(targetFixture());
        const summaryArtifact = baselineSummaryArtifactFixture();
        const binding = createV161PostReleaseCpuFloorBinding(target, hostedContext(), summaryArtifact);

        const evidence = {
            schemaVersion: 1,
            status: "observed",
            stage: "complete",
            classification: "windows-baseline-cpu-floor-full-runtime-stage3-nonqualifying",
            qualifying: false,
            releaseGateCleared: false,
            releaseGatesCleared: [],
            baselineFullRuntimeAccepted: true,
            cpuFloorAccepted: true,
            cleanupProven: true,
            context: {
                repository: REPOSITORY,
                sourceSha: CANDIDATE_SHA,
                eventSha: HARNESS_SHA,
                runId: HOSTED_RUN_ID,
                runAttempt: HOSTED_RUN_ATTEMPT,
                nonce: HOSTED_NONCE
            },
            candidate: {
                sourceSha: CANDIDATE_SHA,
                file: {name: "MySpeed.exe", bytes: "111524352", sha256: binding.candidate.exeAsset.sha256}
            },
            guest: {
                cpu: {model: "Westmere-v2", sse42: true, popcnt: true, avx: false, avx2: false, osxsave: false, xcr0: null},
                network: {hardwareNics: 0, enabledNonLoopbackInterfaces: 0, nonLoopbackRoutes: 0}
            },
            qemuProcess: {cleanupProven: true, treeGone: true}
        };

        const inspection = inspectV161PostReleaseCpuFloorEvidence(binding, evidence);
        assert.equal(inspection.accepted, true);
        assert.equal(inspection.qualifying, false);
        assert.equal(inspection.releaseGateCleared, false);
        assert.deepEqual(inspection.releaseGatesCleared, []);

        // Rejects qualifying: true or releaseGateCleared: true
        for (const mutate of [
            ev => { ev.qualifying = true; },
            ev => { ev.releaseGateCleared = true; },
            ev => { ev.releaseGatesCleared = ["windows-cpu-floor"]; },
            ev => { ev.guest.cpu.avx = true; },
            ev => { ev.guest.network.hardwareNics = 1; },
            ev => { ev.qemuProcess.treeGone = false; },
            ev => { ev.candidate.sourceSha = HARNESS_SHA; }
        ]) {
            const bad = structuredClone(evidence);
            mutate(bad);
            assert.throws(() => inspectV161PostReleaseCpuFloorEvidence(binding, bad), /evidence|qualifying|gate|cpu|network|cleanup|candidate/i);
        }
    });
});
