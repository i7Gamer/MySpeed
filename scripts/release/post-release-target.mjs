import {createHash} from "node:crypto";
import {isDeepStrictEqual} from "node:util";

const SCHEMA_VERSION = 1;
const REPOSITORY = "i7Gamer/MySpeed";
const TAG_NAME = "v1.6.1";
const CANDIDATE_SOURCE_SHA = "4fa4dd40a89a062735f98bd85d685e0624ff46a8";
const VERSION = "1.6.1";
const WINDOWS_STAMP = "1.6.1.45";
const RELEASE_ID = 388294074;
const RELEASE_TARGET = "development";
const RELEASE_CREATED_AT = "2026-09-14T09:48:17Z";
const RELEASE_PUBLISHED_AT = "2026-09-14T10:00:58Z";
const QUALIFICATION_RUN_ID = 34829932391;
const QUALIFICATION_RUN_ATTEMPT = 1;
const QUALIFICATION_RUN_CREATED_AT = "2026-09-14T09:48:50Z";
const QUALIFICATION_RUN_UPDATED_AT = "2026-09-14T09:54:31Z";
const QUALIFICATION_ARCHIVE_ID = 10342345489;
const QUALIFICATION_ARCHIVE_SIZE = 7046;
const QUALIFICATION_ARCHIVE_DIGEST = "sha256:18c3ecc771432edd7d4e3434243b449d58dc983851d9c1bf244ca12897aec077";
const QUALIFICATION_ARCHIVE_CREATED_AT = "2026-09-14T09:54:28Z";
const QUALIFICATION_ARCHIVE_EXPIRES_AT = "2026-09-21T09:54:27Z";
const MANIFEST_SIZE = 21518;
const MANIFEST_SHA256 = "7339a6446d048bbae93759734bcafc94208e2b847af15677e847ae9a4b2f8bca";
const REDUCED_SCOPE_ID = "owner-approved-reduced-v1.6.1";
const DEFERRED_CHECKS = [
    "Windows native full verification with enforced outbound denial",
    "Windows native CPU-floor verification",
    "Disposable Windows MSI lifecycle acceptance"
];
const RELEASE_URL = `https://github.com/${REPOSITORY}/releases/download/${TAG_NAME}`;

const publishedAsset = (id, name, size, digest, createdAt, updatedAt = createdAt) => ({
    id, name, size, digest: `sha256:${digest}`, state: "uploaded",
    url: `${RELEASE_URL}/${name}`, createdAt, updatedAt
});

const PUBLISHED_ASSETS = [
    publishedAsset(563102879, "chooser.sh", 2147, "498a962a39ffb4be3724e1760a884ea5db0589006339b80399fa2bb854dcbb01", "2026-09-14T09:57:03Z"),
    publishedAsset(563102916, "docker-install.sh", 4029, "f86678e7c6eecb9eeded69e7a6a8dbc86b0e46513457860af1d1fee78a7fb973", "2026-09-14T09:57:04Z"),
    publishedAsset(563102933, "install.sh", 40748, "1d7af2bf2827546ee59dfea772dc6b2252edb3aa27979383b30116a9e49b0d24", "2026-09-14T09:57:04Z"),
    publishedAsset(563102948, "MySpeed-installer-baseline.msi", 53702656, "7536c7668dcb0721c643493f595bf8714114d9aa4807357a8263ffe1c9c6bbed", "2026-09-14T09:57:05Z", "2026-09-14T09:57:06Z"),
    publishedAsset(563103039, "MySpeed-installer.msi", 53702656, "5f9573c785ee8d51a661548e74da514a24c2932c200f1c0a1de6b6e0c1a03f6d", "2026-09-14T09:57:07Z", "2026-09-14T09:57:09Z"),
    publishedAsset(563103127, "MySpeed-linux-arm64", 109889832, "2291f02f5b995729c7aa4e63b8064f121c10b573a5b95ae676db33f159e15aec", "2026-09-14T09:57:09Z", "2026-09-14T09:57:13Z"),
    publishedAsset(563103263, "MySpeed-linux-x64", 110970336, "a609c72e046711dff4f5455dc9dd23a9f75d231d941bcf355ebe91ff3043b56d", "2026-09-14T09:57:13Z", "2026-09-14T09:57:17Z"),
    publishedAsset(563103405, "MySpeed-linux-x64-baseline", 110970336, "a609c72e046711dff4f5455dc9dd23a9f75d231d941bcf355ebe91ff3043b56d", "2026-09-14T09:57:17Z", "2026-09-14T09:57:21Z"),
    publishedAsset(563103531, "MySpeed-macos-arm64", 86846322, "dc0f6d0e856c34c429732a4c6bbdf45c0a34197d326a1d54dcf6543ed0c7ac4b", "2026-09-14T09:57:21Z", "2026-09-14T09:57:24Z"),
    publishedAsset(563103597, "MySpeed-macos-x64", 94089488, "9203f8a2f12da52843bc8e0088b089ea51b632abd035181f4e3aa2ee9660df1a", "2026-09-14T09:57:24Z", "2026-09-14T09:57:28Z"),
    publishedAsset(563103679, "MySpeed-windows-x64-baseline.exe", 111524352, "bc4eea0a06c890eb5c0da0472a1705b3219aac3f5000383d9847120b5681d154", "2026-09-14T09:57:28Z", "2026-09-14T09:57:32Z"),
    publishedAsset(563103772, "MySpeed-windows-x64.exe", 111524352, "bc4eea0a06c890eb5c0da0472a1705b3219aac3f5000383d9847120b5681d154", "2026-09-14T09:57:32Z", "2026-09-14T09:57:36Z"),
    publishedAsset(563103908, "MySpeed.zip", 2544233, "94a59173b54fcac832792ba63991e9668e56e8f6b31e0d0eaa085378f90707e6", "2026-09-14T09:57:36Z", "2026-09-14T09:57:37Z"),
    publishedAsset(563103929, "qualification-manifest.json", 21518, MANIFEST_SHA256, "2026-09-14T09:57:37Z", "2026-09-14T09:57:38Z"),
    publishedAsset(563103942, "qualification-manifest.json.sha256", 65, "88f72f092718559b38b9ed99ff3fad7dd738164bc43eb93bd7749b5a004f82de", "2026-09-14T09:57:38Z"),
    publishedAsset(563103918, "SHA256SUMS", 1123, "41bd455bfc3875f3ec722406e15bae173836ca6ddafe99524fc8c8aa21a002e0", "2026-09-14T09:57:37Z")
];

const INPUT_KEYS = ["harnessSourceSha", "manifestBytes", "observedAt", "qualificationArchive",
    "qualificationRun", "release", "tag"];
const TAG_KEYS = ["commitSha", "name", "repository"];
const RUN_KEYS = ["attempt", "conclusion", "createdAt", "event", "headSha", "id",
    "repository", "status", "updatedAt", "workflowName"];
const ARCHIVE_KEYS = ["createdAt", "digest", "expired", "expiresAt", "headSha", "id",
    "name", "repository", "runAttempt", "runId", "size", "updatedAt"];
const RELEASE_KEYS = ["assets", "createdAt", "draft", "id", "platformImmutable", "prerelease",
    "publishedAt", "repository", "tagName", "targetCommitish"];
const ASSET_KEYS = ["createdAt", "digest", "id", "name", "size", "state", "updatedAt", "url"];
const HEX_SHA_PATTERN = /^[0-9a-f]{40}$/;
const UTC_SECONDS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const VALIDATED_TARGET = Symbol("validated-v1.6.1-post-release-target");
const WINDOWS_EXE_ROLES = new Map([
    ["MySpeed-windows-x64-baseline.exe", "baseline"],
    ["MySpeed-windows-x64.exe", "default"]
]);

function fail(message) {
    throw new Error(`Invalid v1.6.1 post-release target: ${message}`);
}
function requireExactKeys(value, keys, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)
            || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys)) {
        fail(`${label} must use the closed schema`);
    }
}

function requireEqual(actual, expected, label) {
    if (actual !== expected) fail(`${label} does not match the sealed identity`);
}

function requireExactValue(actual, expected, label) {
    if (!isDeepStrictEqual(actual, expected)) fail(`${label} does not match`);
}

function deepFreeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
}

function validateManifest(manifestBytes) {
    if (!Buffer.isBuffer(manifestBytes)) fail("manifestBytes must be a Buffer");
    requireEqual(manifestBytes.length, MANIFEST_SIZE, "manifest byte size");
    const digest = createHash("sha256").update(manifestBytes).digest("hex");
    requireEqual(digest, MANIFEST_SHA256, "manifest digest");

    let manifest;
    try {
        manifest = JSON.parse(manifestBytes.toString("utf8"));
    } catch {
        fail("manifest bytes are not JSON");
    }
    requireEqual(manifest.schemaVersion, SCHEMA_VERSION, "manifest schema version");
    requireExactValue(manifest.source, {
        repository: REPOSITORY, sha: CANDIDATE_SOURCE_SHA, version: VERSION,
        windowsStamp: WINDOWS_STAMP
    }, "manifest source");
    requireExactValue(manifest.run, {id: QUALIFICATION_RUN_ID, attempt: QUALIFICATION_RUN_ATTEMPT},
        "manifest run");
    requireEqual(manifest.promotion?.eligible, true, "reduced-scope eligibility");
    requireExactValue(manifest.promotion?.scope,
        {id: REDUCED_SCOPE_ID, deferredChecks: DEFERRED_CHECKS}, "deferred scope");
    requireExactValue(manifest.promotion?.blockers, [], "reduced-scope blockers");
    requireExactValue({
        msiLifecycle: manifest.promotion?.evidence?.msiLifecycle,
        windowsCpuFloor: manifest.promotion?.evidence?.windowsCpuFloor,
        windowsNative: manifest.promotion?.evidence?.windowsNative
    }, {msiLifecycle: null, windowsCpuFloor: null, windowsNative: null},
    "original native evidence");
    return manifest;
}

function validateReleaseAssets(assets, manifest) {
    if (!Array.isArray(assets) || assets.length !== PUBLISHED_ASSETS.length) {
        fail("published asset inventory is incomplete or has additions");
    }
    const expectedByName = new Map(PUBLISHED_ASSETS.map(item => [item.name, item]));
    const actualByName = new Map();
    const actualIds = new Set();
    assets.forEach((actual, index) => {
        requireExactKeys(actual, ASSET_KEYS, `release.assets[${index}]`);
        if (actualByName.has(actual.name)) fail(`release asset name ${actual.name} is duplicated`);
        if (actualIds.has(actual.id)) fail(`release asset id ${actual.id} is duplicated`);
        const expected = expectedByName.get(actual.name);
        if (!expected) fail(`release asset ${actual.name} is foreign`);
        requireExactValue(actual, expected, `release asset ${actual.name}`);
        actualByName.set(actual.name, actual);
        actualIds.add(actual.id);
    });
    if (!Array.isArray(manifest.releaseAssets)) fail("manifest releaseAssets is not an array");
    for (const payload of manifest.releaseAssets) {
        const published = actualByName.get(payload.name);
        if (!published || published.size !== payload.size
                || published.digest !== `sha256:${payload.sha256}`) {
            fail(`published payload ${payload.name} differs from the sealed manifest`);
        }
    }
    return PUBLISHED_ASSETS.map(expected => ({...expected}));
}

function validateObservation(observedAt) {
    const observed = Date.parse(observedAt);
    if (typeof observedAt !== "string" || !UTC_SECONDS_PATTERN.test(observedAt)
            || !Number.isFinite(observed)
            || observed < Date.parse(RELEASE_PUBLISHED_AT)
            || observed >= Date.parse(QUALIFICATION_ARCHIVE_EXPIRES_AT)) {
        fail("observedAt is outside the published, non-expired provenance interval");
    }
}

export function bindV161PostReleaseTarget(input) {
    requireExactKeys(input, INPUT_KEYS, "input");
    if (typeof input.harnessSourceSha !== "string"
            || input.harnessSourceSha.length !== CANDIDATE_SOURCE_SHA.length
            || !HEX_SHA_PATTERN.test(input.harnessSourceSha)
            || input.harnessSourceSha === CANDIDATE_SOURCE_SHA) {
        fail("harness source must be a distinct full commit SHA");
    }
    validateObservation(input.observedAt);

    requireExactKeys(input.tag, TAG_KEYS, "tag");
    requireExactValue(input.tag,
        {repository: REPOSITORY, name: TAG_NAME, commitSha: CANDIDATE_SOURCE_SHA}, "tag");

    requireExactKeys(input.qualificationRun, RUN_KEYS, "qualificationRun");
    requireExactValue(input.qualificationRun, {
        repository: REPOSITORY, id: QUALIFICATION_RUN_ID, attempt: QUALIFICATION_RUN_ATTEMPT,
        headSha: CANDIDATE_SOURCE_SHA, event: "workflow_dispatch", status: "completed",
        conclusion: "success", workflowName: "Qualify release candidate",
        createdAt: QUALIFICATION_RUN_CREATED_AT, updatedAt: QUALIFICATION_RUN_UPDATED_AT
    }, "qualificationRun");

    requireExactKeys(input.qualificationArchive, ARCHIVE_KEYS, "qualificationArchive");
    requireExactValue(input.qualificationArchive, {
        repository: REPOSITORY, id: QUALIFICATION_ARCHIVE_ID,
        name: "release-qualification-manifest", size: QUALIFICATION_ARCHIVE_SIZE,
        digest: QUALIFICATION_ARCHIVE_DIGEST, expired: false,
        createdAt: QUALIFICATION_ARCHIVE_CREATED_AT, updatedAt: QUALIFICATION_ARCHIVE_CREATED_AT,
        expiresAt: QUALIFICATION_ARCHIVE_EXPIRES_AT, runId: QUALIFICATION_RUN_ID,
        runAttempt: QUALIFICATION_RUN_ATTEMPT, headSha: CANDIDATE_SOURCE_SHA
    }, "qualificationArchive");

    requireExactKeys(input.release, RELEASE_KEYS, "release");
    const releaseMetadata = {...input.release};
    delete releaseMetadata.assets;
    requireExactValue(releaseMetadata, {
        repository: REPOSITORY, id: RELEASE_ID, tagName: TAG_NAME,
        targetCommitish: RELEASE_TARGET, createdAt: RELEASE_CREATED_AT,
        publishedAt: RELEASE_PUBLISHED_AT, draft: false, prerelease: false,
        platformImmutable: false
    }, "published release");

    const manifest = validateManifest(input.manifestBytes);
    const releaseAssets = validateReleaseAssets(input.release.assets, manifest);

    const target = {
        schemaVersion: SCHEMA_VERSION,
        kind: "myspeed-post-release-windows-qualification-target",
        status: "pending-native-evidence",
        scope: "post-release-evidence-addendum-only",
        harness: {sourceSha: input.harnessSourceSha},
        candidate: {
            repository: REPOSITORY, sourceSha: CANDIDATE_SOURCE_SHA,
            version: VERSION, windowsStamp: WINDOWS_STAMP, tagName: TAG_NAME
        },
        originalQualification: {
            run: {
                repository: REPOSITORY, id: QUALIFICATION_RUN_ID, attempt: QUALIFICATION_RUN_ATTEMPT,
                headSha: CANDIDATE_SOURCE_SHA, event: "workflow_dispatch", status: "completed",
                conclusion: "success", workflowName: "Qualify release candidate",
                createdAt: QUALIFICATION_RUN_CREATED_AT, updatedAt: QUALIFICATION_RUN_UPDATED_AT,
                provenance: "github-actions-run"
            },
            manifest: {bytes: MANIFEST_SIZE, sha256: MANIFEST_SHA256},
            archive: {
                repository: REPOSITORY, id: QUALIFICATION_ARCHIVE_ID,
                name: "release-qualification-manifest", size: QUALIFICATION_ARCHIVE_SIZE,
                digest: QUALIFICATION_ARCHIVE_DIGEST, expired: false,
                createdAt: QUALIFICATION_ARCHIVE_CREATED_AT, updatedAt: QUALIFICATION_ARCHIVE_CREATED_AT,
                expiresAt: QUALIFICATION_ARCHIVE_EXPIRES_AT, runId: QUALIFICATION_RUN_ID,
                runAttempt: QUALIFICATION_RUN_ATTEMPT, headSha: CANDIDATE_SOURCE_SHA,
                provenance: "github-actions-archive"
            },
            reducedScope: {id: REDUCED_SCOPE_ID, deferredChecks: [...DEFERRED_CHECKS]},
            nativeEvidence: {msiLifecycle: null, windowsCpuFloor: null, windowsNative: null}
        },
        publication: {
            releaseId: RELEASE_ID, tagName: TAG_NAME, publishedAt: RELEASE_PUBLISHED_AT,
            platformImmutable: false, mutationForbidden: true,
            assets: releaseAssets.map(item => ({...item, provenance: "github-release-asset"}))
        },
        observedAt: input.observedAt,
        releaseGatesCleared: []
    };
    Object.defineProperty(target, VALIDATED_TARGET, {value: true});
    deepFreeze(target);
    return target;
}

export function buildV161WindowsExeAcquisitionPlan(target) {
    if (!target || typeof target !== "object" || !Object.isFrozen(target)
            || target[VALIDATED_TARGET] !== true) {
        fail("acquisition source must be an immutable target returned by the binder");
    }
    const publishedByName = new Map(target.publication.assets.map(item => [item.name, item]));
    const assets = [...WINDOWS_EXE_ROLES].map(([name, role]) => {
        const published = publishedByName.get(name);
        if (!published) fail(`validated target is missing ${name}`);
        return {
            role, id: published.id, name: published.name, url: published.url,
            bytes: published.size, sha256: published.digest.slice("sha256:".length)
        };
    });
    return deepFreeze({
        schemaVersion: SCHEMA_VERSION,
        kind: "myspeed-v1.6.1-windows-exe-acquisition-plan",
        authority: "acquisition-only",
        permissions: {networkAcquisition: true, nativeExecution: false, publishing: false},
        binding: {
            repository: target.candidate.repository,
            tagName: target.candidate.tagName,
            candidateSourceSha: target.candidate.sourceSha,
            harnessSourceSha: target.harness.sourceSha,
            releaseId: target.publication.releaseId,
            manifestSha256: target.originalQualification.manifest.sha256
        },
        assets
    });
}
