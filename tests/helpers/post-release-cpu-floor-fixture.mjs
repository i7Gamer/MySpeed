import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {buildAcceptedStage3Fixture} from "./windows-cpu-floor-stage3-fixture.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(HERE, "..", "fixtures", "post-release-native-v1.6.1");

export const MANIFEST_PATH = path.join(FIXTURE_ROOT, "qualification-manifest.json");
export const BASELINE_SUMMARY_PATH = path.join(FIXTURE_ROOT, "baseline-qualification-summary.json");

export const REPOSITORY = "i7Gamer/MySpeed";
export const TAG_NAME = "v1.6.1";
export const HARNESS_SHA = "dce629fd50ea007221b3a9f2698c32a573bca160";
export const CANDIDATE_SHA = "4fa4dd40a89a062735f98bd85d685e0624ff46a8";
export const HOSTED_RUN_ID = "40000000001";
export const HOSTED_RUN_ATTEMPT = "1";
export const HOSTED_NONCE = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

// The image version Gemini's Stage 3 fixture stamps into its hosted context. The post-release
// hosted context must match it exactly or the request-to-binding check correctly refuses.
export const HOSTED_IMAGE_VERSION = "20260901.1";

export const BASELINE_ARTIFACT_ID = 10341896645;
export const BASELINE_ARTIFACT_NAME = "MySpeed-windows-x64-baseline.exe";
export const BASELINE_ARCHIVE_SIZE = 46649471;
export const BASELINE_ARCHIVE_DIGEST =
    "sha256:280b4a99c8a1f20aca5958c065b12ecb14519125769ee0460840168963db07ed";
export const BASELINE_SUMMARY_SHA256 =
    "e8e8106aa6584fe99382a205842d78dbf83d21ae9fe8b4edafc6156cf2f29ddd";
export const DEFAULT_VARIANT_SUMMARY_SHA256 =
    "042d5f2d2d761680891d3140ca2278f9aa358400c2a00601f8780b6bdfdf98ec";
export const QUALIFICATION_RUN_ID = 34829932391;
export const QUALIFICATION_RUN_ATTEMPT = 1;
export const BASELINE_ARTIFACT_EXPIRES_AT = "2026-12-13T09:48:51Z";
export const OBSERVED_AT = "2026-09-15T13:28:33Z";

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

export const manifestBytes = () => fs.readFileSync(MANIFEST_PATH);

// The authentic historical summary, extracted once from artifact 10341896645 and verified against
// the digest the sealed manifest declares. Never regenerate these bytes.
export const authenticBaselineSummaryBytes = () => fs.readFileSync(BASELINE_SUMMARY_PATH);

export const targetInput = () => ({
    harnessSourceSha: HARNESS_SHA,
    observedAt: "2026-09-14T12:30:00Z",
    manifestBytes: manifestBytes(),
    tag: {repository: REPOSITORY, name: TAG_NAME, commitSha: CANDIDATE_SHA},
    qualificationRun: {repository: REPOSITORY, id: QUALIFICATION_RUN_ID, attempt: QUALIFICATION_RUN_ATTEMPT,
        headSha: CANDIDATE_SHA, event: "workflow_dispatch", status: "completed", conclusion: "success",
        workflowName: "Qualify release candidate", createdAt: "2026-09-14T09:48:50Z",
        updatedAt: "2026-09-14T09:54:31Z"},
    qualificationArchive: {repository: REPOSITORY, id: 10342345489,
        name: "release-qualification-manifest", size: 7046,
        digest: "sha256:18c3ecc771432edd7d4e3434243b449d58dc983851d9c1bf244ca12897aec077",
        expired: false, createdAt: "2026-09-14T09:54:28Z", updatedAt: "2026-09-14T09:54:28Z",
        expiresAt: "2026-09-21T09:54:27Z", runId: QUALIFICATION_RUN_ID, runAttempt: QUALIFICATION_RUN_ATTEMPT,
        headSha: CANDIDATE_SHA},
    release: {repository: REPOSITORY, id: 388294074, tagName: TAG_NAME,
        targetCommitish: "development", createdAt: "2026-09-14T09:48:17Z",
        publishedAt: "2026-09-14T10:00:58Z", draft: false, prerelease: false,
        platformImmutable: false, assets: structuredClone(PUBLISHED_ASSETS)}
});

export const hostedContext = () => ({
    schemaVersion: 1,
    repository: REPOSITORY,
    sourceSha: HARNESS_SHA,
    eventSha: HARNESS_SHA,
    runId: HOSTED_RUN_ID,
    runAttempt: HOSTED_RUN_ATTEMPT,
    nonce: HOSTED_NONCE,
    environment: {GITHUB_ACTIONS: "true", CI: "true", RUNNER_OS: "Linux", RUNNER_ARCH: "X64",
        RUNNER_ENVIRONMENT: "github-hosted", ImageOS: "ubuntu24", ImageVersion: HOSTED_IMAGE_VERSION}
});

export const baselineArtifactRecord = () => ({
    id: BASELINE_ARTIFACT_ID,
    name: BASELINE_ARTIFACT_NAME,
    runId: QUALIFICATION_RUN_ID,
    runAttempt: QUALIFICATION_RUN_ATTEMPT,
    headSha: CANDIDATE_SHA,
    archiveSize: BASELINE_ARCHIVE_SIZE,
    archiveDigest: BASELINE_ARCHIVE_DIGEST,
    expired: false,
    expiresAt: BASELINE_ARTIFACT_EXPIRES_AT
});

export const acquisitionInput = () => ({
    artifact: baselineArtifactRecord(),
    summaryBytes: authenticBaselineSummaryBytes(),
    observedAt: OBSERVED_AT
});

const TRANSPORT_ROOT = `/home/runner/work/_temp/myspeed-stage2-transport-${HOSTED_NONCE}`;

// Placeholder retained-evidence identities, only used to obtain the candidate projection before the
// real Stage 3 fixture computes the identities of its own retained Stage 2 bytes.
export const placeholderStage2Receipts = () => ({
    result: {path: `${TRANSPORT_ROOT}/stage2-result.json`, bytes: "4096", sha256: "1".repeat(64)},
    guestResult: {path: `${TRANSPORT_ROOT}/guest-result.json`, bytes: "2048", sha256: "2".repeat(64)}
});

export const OTHER_RUN_ID = "40000000002";
export const OTHER_NONCE = "f0e1d2c3b4a5968778695a4b3c2d1e0f";

/** A Stage 3 execution that is internally valid but bound to entirely unrelated identities. */
export const buildUnrelatedStage3Fixture = () => buildAcceptedStage3Fixture();

/** The same post-release candidate observed in a different hosted execution. */
export async function buildOtherExecutionStage3Fixture(candidate) {
    return buildAcceptedStage3Fixture({
        sourceSha: HARNESS_SHA,
        eventSha: HARNESS_SHA,
        candidateSourceSha: CANDIDATE_SHA,
        runId: OTHER_RUN_ID,
        runAttempt: HOSTED_RUN_ATTEMPT,
        nonce: OTHER_NONCE,
        candidate: structuredClone(candidate)
    });
}

/**
 * Drives Gemini's real Stage 3 producer with inert injected operations over the post-release
 * candidate projection, so the consumer is tested against an actually produced result.
 */
export async function buildPostReleaseStage3Fixture(candidate) {
    return buildAcceptedStage3Fixture({
        sourceSha: HARNESS_SHA,
        eventSha: HARNESS_SHA,
        candidateSourceSha: CANDIDATE_SHA,
        runId: HOSTED_RUN_ID,
        runAttempt: HOSTED_RUN_ATTEMPT,
        nonce: HOSTED_NONCE,
        candidate: structuredClone(candidate)
    });
}
