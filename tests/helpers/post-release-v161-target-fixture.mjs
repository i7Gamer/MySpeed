import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {bindV161PostReleaseTarget} from "../../scripts/release/post-release-target.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const POST_RELEASE_V161_REPOSITORY = "i7Gamer/MySpeed";
export const POST_RELEASE_V161_CANDIDATE_SHA = "4fa4dd40a89a062735f98bd85d685e0624ff46a8";
export const POST_RELEASE_V161_HARNESS_SHA = "dce629fd50ea007221b3a9f2698c32a573bca160";
const RELEASE_URL = `https://github.com/${POST_RELEASE_V161_REPOSITORY}/releases/download/v1.6.1`;
const MANIFEST_PATH = path.join(HERE, "..", "fixtures", "post-release-native-v1.6.1",
    "qualification-manifest.json");
const asset = (id, name, size, digest, createdAt, updatedAt = createdAt) => ({id, name, size,
    digest: `sha256:${digest}`, state: "uploaded", url: `${RELEASE_URL}/${name}`, createdAt, updatedAt});
const PUBLISHED_ASSETS = Object.freeze([
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
]);

export const createPostReleaseV161HarnessContext = () => ({repository: POST_RELEASE_V161_REPOSITORY,
    sourceSha: POST_RELEASE_V161_HARNESS_SHA, eventSha: POST_RELEASE_V161_HARNESS_SHA,
    runId: "40000000001", runAttempt: "1", imageVersion: "20260907.229.1",
    nonce: "a1b2c3d4e5f60718293a4b5c6d7e8f90"});

export const createPostReleaseV161Target = () => bindV161PostReleaseTarget({
    harnessSourceSha: POST_RELEASE_V161_HARNESS_SHA, observedAt: "2026-09-14T12:30:00Z",
    manifestBytes: fs.readFileSync(MANIFEST_PATH),
    tag: {repository: POST_RELEASE_V161_REPOSITORY, name: "v1.6.1",
        commitSha: POST_RELEASE_V161_CANDIDATE_SHA},
    qualificationRun: {repository: POST_RELEASE_V161_REPOSITORY, id: 34829932391, attempt: 1,
        headSha: POST_RELEASE_V161_CANDIDATE_SHA, event: "workflow_dispatch", status: "completed",
        conclusion: "success", workflowName: "Qualify release candidate",
        createdAt: "2026-09-14T09:48:50Z", updatedAt: "2026-09-14T09:54:31Z"},
    qualificationArchive: {repository: POST_RELEASE_V161_REPOSITORY, id: 10342345489,
        name: "release-qualification-manifest", size: 7046,
        digest: "sha256:18c3ecc771432edd7d4e3434243b449d58dc983851d9c1bf244ca12897aec077",
        expired: false, createdAt: "2026-09-14T09:54:28Z", updatedAt: "2026-09-14T09:54:28Z",
        expiresAt: "2026-09-21T09:54:27Z", runId: 34829932391, runAttempt: 1,
        headSha: POST_RELEASE_V161_CANDIDATE_SHA},
    release: {repository: POST_RELEASE_V161_REPOSITORY, id: 388294074, tagName: "v1.6.1",
        targetCommitish: "development", createdAt: "2026-09-14T09:48:17Z",
        publishedAt: "2026-09-14T10:00:58Z", draft: false, prerelease: false,
        platformImmutable: false, assets: structuredClone(PUBLISHED_ASSETS)}});
