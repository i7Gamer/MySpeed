import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {describe, it} from "node:test";
import {fileURLToPath} from "node:url";

import {bindV161PostReleaseTarget, buildV161WindowsExeAcquisitionPlan}
    from "../../scripts/release/post-release-target.mjs";
import {createV161PostReleaseStandaloneBinding, createV161PostReleaseStandaloneEnvelope,
    buildV161PostReleaseStandaloneProducerPlan, inspectV161PostReleaseStandaloneEvidence,
    retainV161PostReleaseStandaloneProducerPlan}
    from "../../scripts/release/post-release-standalone.mjs";
import {createWindowsNativeStandaloneEvidenceFixture} from
    "../helpers/windows-native-standalone-evidence-fixture.mjs";
import {prepareV161PostReleaseHostedCoordinator, runV161PostReleaseHostedControllerCli}
    from "../../scripts/release/post-release-hosted-controller.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.join(HERE, "..", "..");
const MANIFEST_REPOSITORY_PATH = "tests/fixtures/post-release-native-v1.6.1/qualification-manifest.json";
const MANIFEST_PATH = path.join(HERE, "..", "fixtures", "post-release-native-v1.6.1",
    "qualification-manifest.json");
const MANIFEST_BYTES = 21_518;
const MANIFEST_SHA256 = "7339a6446d048bbae93759734bcafc94208e2b847af15677e847ae9a4b2f8bca";
const WORKFLOW_PATH = path.join(HERE, "..", "..", ".github", "workflows",
    "windows-native-post-release-v1.6.1.yml");
const HARNESS_SHA = "dce629fd50ea007221b3a9f2698c32a573bca160";
const CANDIDATE_SHA = "4fa4dd40a89a062735f98bd85d685e0624ff46a8";
const REPOSITORY = "i7Gamer/MySpeed";
const TAG_NAME = "v1.6.1";
const HOSTED_RUN_ID = "40000000001";
const HOSTED_RUN_ATTEMPT = "1";
const HOSTED_NONCE = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const HOSTED_IMAGE_VERSION = "20260914.1";
const RELEASE_URL = `https://github.com/${REPOSITORY}/releases/download/${TAG_NAME}`;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
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

const fixture = () => ({
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

const cloneInput = input => ({...structuredClone({...input, manifestBytes: undefined}),
    manifestBytes: Buffer.from(input.manifestBytes)});
const jsonSha256 = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const githubScriptForStep = (workflow, stepName) => {
    const step = workflow.indexOf(`      - name: ${stepName}`);
    assert.ok(step >= 0, `${stepName} is absent`);
    const marker = "          script: |\n";
    const start = workflow.indexOf(marker, step) + marker.length;
    assert.ok(start >= marker.length, `${stepName} script is absent`);
    const lines = [];
    for (const line of workflow.slice(start).split("\n")) {
        if (line !== "" && !line.startsWith("            ")) break;
        lines.push(line === "" ? line : line.slice(12));
    }
    assert.ok(lines.some(Boolean), `${stepName} script is empty`);
    return lines.join("\n");
};
const hostedContext = () => ({repository: REPOSITORY, runId: HOSTED_RUN_ID,
    runAttempt: HOSTED_RUN_ATTEMPT, eventSha: HARNESS_SHA,
    imageVersion: HOSTED_IMAGE_VERSION, nonce: HOSTED_NONCE});
const standaloneEvidence = (binding, candidates = binding.candidates) =>
    createWindowsNativeStandaloneEvidenceFixture({
        sourceSha: CANDIDATE_SHA, eventSha: HARNESS_SHA, runId: HOSTED_RUN_ID,
        runAttempt: HOSTED_RUN_ATTEMPT, imageVersion: HOSTED_IMAGE_VERSION, nonce: HOSTED_NONCE,
        manifestSha256: binding.originalQualification.manifestSha256,
        qualificationSourceSha: CANDIDATE_SHA, qualificationRunId: "34829932391",
        qualificationRunAttempt: "1", qualificationManifestArtifactId: "10342345489",
        qualificationManifestArtifactDigest: binding.originalQualification.archiveDigest,
        candidates: candidates.map(candidate => ({alias: candidate.alias,
            artifactLogicalName: candidate.name, artifactId: candidate.releaseAssetId,
            artifactDigest: candidate.releaseAssetDigest, sha256: candidate.sha256}))
    });
const producerAcquired = binding => {
    const producerNonce = binding.oracleContext.nonce;
    const taskRoot = `C:\\runner\\myspeed-native-standalone-${producerNonce}`;
    const closureRoot = `${taskRoot}\\closure`;
    const hash = "4".repeat(64);
    const scenarios = ["populated-first-boot", "populated-restart", "fresh-no-config-reset"];
    return {taskRoot,
        closure: {proofPath: `${closureRoot}\\windows-native-standalone-proof.mjs`, proofSha256: hash,
            adapterPath: `${closureRoot}\\windows-native-standalone-adapter.mjs`, adapterSha256: hash,
            hostPath: `${closureRoot}\\windows-native-standalone-host.ps1`, hostSha256: hash,
            candidateControllerPath: `${closureRoot}\\windows-native-candidate-controller.ps1`,
            candidateControllerSha256: hash,
            cleanStopControllerPath: `${closureRoot}\\windows-clean-stop-controller.ps1`,
            cleanStopControllerSha256: hash,
            canaryPath: `${closureRoot}\\windows-winsw-offline-canary.ps1`, canarySha256: hash},
        node: {path: "C:\\hostedtoolcache\\node.exe", sha256: hash},
        powershell: {path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", sha256: hash},
        fixtures: binding.candidates.map(candidate => ({alias: candidate.alias,
            manifestPath: `${taskRoot}\\fixture-${candidate.alias}.json`, manifestSha256: hash,
            populatedWork: `${taskRoot}\\fixture-${candidate.alias}-populated`,
            resetWork: `${taskRoot}\\fixture-${candidate.alias}-reset`})),
        candidates: binding.candidates.map((candidate, aliasIndex) => {
            const sourcePath = `${taskRoot}\\candidate-${candidate.alias}\\${candidate.name}`;
            return {alias: candidate.alias, sourcePath,
                sourceIdentity: {path: sourcePath, bytes: candidate.bytes, sha256: candidate.sha256,
                    volumeSerial: "1".repeat(8), fileId: String(aliasIndex + 2).repeat(16),
                    linkCount: 1, reparsePoint: false},
                scenarios: scenarios.map((scenario, scenarioIndex) => {
                    const nonce = createHash("sha256")
                        .update(`${producerNonce}\0${candidate.alias}\0${scenario}`).digest("hex").slice(0, 32);
                    const root = `C:\\runner\\myspeed-native-candidate-${nonce}`;
                    return {scenario, nonce, taskRoot: root, candidatePath: `${root}\\MySpeed.exe`,
                        candidateIdentity: {path: `${root}\\MySpeed.exe`, bytes: candidate.bytes,
                            sha256: candidate.sha256, volumeSerial: "3".repeat(8),
                            fileId: String(scenarioIndex + 4).repeat(16), linkCount: 1, reparsePoint: false},
                        controllerPath: `${root}\\windows-clean-stop-controller.ps1`};
                })};
        })};
};

describe("v1.6.1 post-release Windows qualification target", () => {
    it("keeps the sealed manifest byte-exact across Git checkout line-ending settings", () => {
        const attributes = execFileSync("git", ["check-attr", "-z", "text", "--", MANIFEST_REPOSITORY_PATH], {
            cwd: REPOSITORY_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
        }).split("\0");
        assert.deepEqual(attributes, [MANIFEST_REPOSITORY_PATH, "text", "unset", ""]);
        const bytes = fs.readFileSync(MANIFEST_PATH);
        assert.equal(bytes.length, MANIFEST_BYTES);
        assert.equal(createHash("sha256").update(bytes).digest("hex"), MANIFEST_SHA256);
    });

    it("binds separate harness, candidate, Actions archive, and published-release identities", () => {
        const input = fixture();
        const target = bindV161PostReleaseTarget(input);
        assert.equal(target.kind, "myspeed-post-release-windows-qualification-target");
        assert.equal(target.status, "pending-native-evidence");
        assert.equal(target.harness.sourceSha, HARNESS_SHA);
        assert.equal(target.candidate.sourceSha, CANDIDATE_SHA);
        assert.equal(target.candidate.version, "1.6.1");
        assert.equal(target.candidate.windowsStamp, "1.6.1.45");
        assert.equal(target.originalQualification.manifest.sha256, MANIFEST_SHA256);
        assert.equal(target.originalQualification.archive.id, 10342345489);
        assert.deepEqual(target.originalQualification.nativeEvidence,
            {msiLifecycle: null, windowsCpuFloor: null, windowsNative: null});
        assert.equal(target.publication.releaseId, 388294074);
        assert.equal(target.publication.platformImmutable, false);
        assert.equal(target.publication.mutationForbidden, true);
        assert.equal(target.publication.assets.length, PUBLISHED_ASSETS.length);
        assert.deepEqual(target.releaseGatesCleared, []);
        assert.equal("eligible" in target, false);
        assert.equal("promotion" in target, false);
    });

    it("rejects malformed or conflated harness identity and unknown input fields", () => {
        for (const change of [input => { input.harnessSourceSha = "bad"; },
            input => { input.harnessSourceSha = [HARNESS_SHA]; },
            input => { input.harnessSourceSha = new String(HARNESS_SHA); },
            input => { input.harnessSourceSha = {toString: () => HARNESS_SHA}; },
            input => { input.harnessSourceSha = 123; },
            input => { input.harnessSourceSha = `${HARNESS_SHA}\n`; },
            input => { input.harnessSourceSha = `${HARNESS_SHA}\r\n`; },
            input => { input.harnessSourceSha = CANDIDATE_SHA; },
            input => { input.extra = true; }]) {
            const input = fixture(); change(input);
            assert.throws(() => bindV161PostReleaseTarget(input));
        }
    });

    it("rejects mutated, differently serialized, or relabelled original manifest bytes", () => {
        for (const change of [input => { input.manifestBytes[10] ^= 1; }, input => {
            const value = JSON.parse(input.manifestBytes); input.manifestBytes = Buffer.from(JSON.stringify(value));
        }, input => {
            const value = JSON.parse(input.manifestBytes); value.promotion.evidence.windowsNative = {status: "passed"};
            input.manifestBytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
        }, input => {
            const value = JSON.parse(input.manifestBytes); value.promotion.eligible = false;
            input.manifestBytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
        }]) {
            const input = fixture(); change(input);
            assert.throws(() => bindV161PostReleaseTarget(input));
        }
    });

    it("rejects foreign tag, repository, candidate, release, draft, or prerelease identity", () => {
        for (const change of [input => { input.tag.repository = "other/repo"; },
            input => { input.tag.name = "v1.6.2"; }, input => { input.tag.commitSha = HARNESS_SHA; },
            input => { input.release.id += 1; }, input => { input.release.tagName = "v1.6.0"; },
            input => { input.release.draft = true; }, input => { input.release.prerelease = true; },
            input => { input.release.publishedAt = "2026-09-14T10:00:59Z"; }]) {
            const input = fixture(); change(input);
            assert.throws(() => bindV161PostReleaseTarget(input));
        }
    });

    it("rejects unsuccessful, foreign, or stale qualification run and archive identities", () => {
        for (const change of [input => { input.qualificationRun.id += 1; },
            input => { input.qualificationRun.headSha = HARNESS_SHA; },
            input => { input.qualificationRun.conclusion = "failure"; },
            input => { input.qualificationArchive.id += 1; },
            input => { input.qualificationArchive.digest = `sha256:${"0".repeat(64)}`; },
            input => { input.qualificationArchive.runId += 1; },
            input => { input.qualificationArchive.expired = true; },
            input => { input.observedAt = input.qualificationArchive.expiresAt; }]) {
            const input = fixture(); change(input);
            assert.throws(() => bindV161PostReleaseTarget(input));
        }
    });

    it("accepts semantic object and asset permutations from API responses", () => {
        const canonicalTarget = bindV161PostReleaseTarget(fixture());
        const input = fixture();
        input.tag = {name: input.tag.name, repository: input.tag.repository,
            commitSha: input.tag.commitSha};
        input.qualificationRun = {workflowName: input.qualificationRun.workflowName,
            ...input.qualificationRun};
        input.qualificationArchive = {headSha: input.qualificationArchive.headSha,
            ...input.qualificationArchive};
        input.release = {assets: input.release.assets,
            platformImmutable: input.release.platformImmutable, ...input.release};
        input.release.assets = input.release.assets.reverse().map(item => ({
            url: item.url, updatedAt: item.updatedAt, state: item.state, size: item.size,
            name: item.name, id: item.id, digest: item.digest, createdAt: item.createdAt
        }));
        const target = bindV161PostReleaseTarget(input);
        assert.deepEqual(target.publication.assets.map(item => item.name),
            PUBLISHED_ASSETS.map(item => item.name));
        assert.equal(jsonSha256(target), jsonSha256(canonicalTarget));
    });

    it("rejects missing, extra, duplicated-name, duplicated-id, or changed published assets", () => {
        for (const change of [input => { input.release.assets.pop(); },
            input => { input.release.assets.push(structuredClone(input.release.assets[0])); },
            input => { input.release.assets[1].id = input.release.assets[0].id; },
            input => { input.release.assets[1].name = input.release.assets[0].name; },
            input => { input.release.assets[10].digest = `sha256:${"0".repeat(64)}`; },
            input => { input.release.assets[11].size += 1; },
            input => { input.release.assets[13].url += "?changed=1"; },
            input => { input.release.assets[0].updatedAt = "2026-09-14T09:57:04Z"; }]) {
            const input = fixture(); change(input);
            assert.throws(() => bindV161PostReleaseTarget(input));
        }
    });

    it("does not alias caller input and returns a deeply immutable target", () => {
        const input = fixture(); const before = cloneInput(input);
        const target = bindV161PostReleaseTarget(input);
        input.tag.name = "changed";
        input.qualificationRun.repository = "changed/repository";
        input.release.assets[0].name = "changed";
        assert.equal(target.candidate.tagName, TAG_NAME);
        assert.equal(target.originalQualification.run.repository, REPOSITORY);
        assert.equal(target.publication.assets[0].name, PUBLISHED_ASSETS[0].name);
        assert.equal(Object.isFrozen(target), true);
        assert.equal(Object.isFrozen(target.publication.assets), true);
        assert.equal(Object.isFrozen(target.publication.assets[0]), true);
        assert.throws(() => { target.publication.assets[0].name = "changed"; }, TypeError);
        input.tag.name = before.tag.name;
        input.qualificationRun.repository = before.qualificationRun.repository;
        input.release.assets[0].name = before.release.assets[0].name;
        assert.deepEqual(cloneInput(input), before);
    });

    it("builds an immutable acquisition-only plan for the two published Windows EXEs", () => {
        const target = bindV161PostReleaseTarget(fixture());
        const plan = buildV161WindowsExeAcquisitionPlan(target);
        assert.equal(plan.kind, "myspeed-v1.6.1-windows-exe-acquisition-plan");
        assert.equal(plan.authority, "acquisition-only");
        assert.deepEqual(plan.permissions,
            {networkAcquisition: true, nativeExecution: false, publishing: false});
        assert.deepEqual(plan.assets, [
            {role: "baseline", id: 563103679, name: "MySpeed-windows-x64-baseline.exe",
                url: `${RELEASE_URL}/MySpeed-windows-x64-baseline.exe`, bytes: 111524352,
                sha256: "bc4eea0a06c890eb5c0da0472a1705b3219aac3f5000383d9847120b5681d154"},
            {role: "default", id: 563103772, name: "MySpeed-windows-x64.exe",
                url: `${RELEASE_URL}/MySpeed-windows-x64.exe`, bytes: 111524352,
                sha256: "bc4eea0a06c890eb5c0da0472a1705b3219aac3f5000383d9847120b5681d154"}
        ]);
        assert.equal(Object.isFrozen(plan.assets[0]), true);
    });

    it("does not accept an unvalidated lookalike as an acquisition source", () => {
        const target = bindV161PostReleaseTarget(fixture());
        assert.throws(() => buildV161WindowsExeAcquisitionPlan(structuredClone(target)));
        assert.throws(() => buildV161WindowsExeAcquisitionPlan({}));
    });

    it("binds the published target and acquisition plan to the standalone oracle context", () => {
        const target = bindV161PostReleaseTarget(fixture());
        const binding = createV161PostReleaseStandaloneBinding(target, hostedContext());
        assert.equal(binding.kind, "myspeed-v1.6.1-post-release-standalone-binding");
        assert.equal(binding.authority, "evidence-inspection-only");
        assert.equal(binding.qualifying, false);
        assert.equal(binding.targetHashes.postReleaseTargetSha256, jsonSha256(target));
        assert.equal(binding.targetHashes.acquisitionPlanSha256,
            jsonSha256(buildV161WindowsExeAcquisitionPlan(target)));
        assert.equal(binding.oracleContext.sourceSha, CANDIDATE_SHA);
        assert.equal(binding.oracleContext.eventSha, HARNESS_SHA);
        assert.deepEqual(binding.candidates.map(candidate => ({alias: candidate.alias,
            id: candidate.releaseAssetId, provenance: candidate.provenance})), [
            {alias: "default", id: "563103772", provenance: "github-release-asset"},
            {alias: "baseline", id: "563103679", provenance: "github-release-asset"}
        ]);
        assert.equal(Object.isFrozen(binding.candidates[0]), true);
        assert.deepEqual(binding.releaseGatesCleared, []);
    });

    it("rejects a hosted context not bound to the harness source", () => {
        const target = bindV161PostReleaseTarget(fixture());
        for (const change of [context => { context.eventSha = CANDIDATE_SHA; },
            context => { context.repository = "other/repository"; },
            context => { context.runId = 40000000001; },
            context => { context.extra = true; }]) {
            const context = hostedContext(); change(context);
            assert.throws(() => createV161PostReleaseStandaloneBinding(target, context));
        }
        assert.throws(() => createV161PostReleaseStandaloneBinding(structuredClone(target), hostedContext()));
    });

    it("uses real retained standalone evidence and returns a sealed-envelope-bound addendum request", async () => {
        const target = bindV161PostReleaseTarget(fixture());
        const binding = createV161PostReleaseStandaloneBinding(target, hostedContext());
        const evidence = await standaloneEvidence(binding);
        const envelope = createV161PostReleaseStandaloneEnvelope(binding, {
            hostRequestBytes: evidence.hostRequestBytes, proofRequestBytes: evidence.proofRequestBytes});
        const request = inspectV161PostReleaseStandaloneEvidence(binding, evidence, envelope.bytes);
        assert.equal(request.kind, "myspeed-v1.6.1-post-release-windows-native-addendum-request");
        assert.equal(request.status, "ready-for-addendum-review");
        assert.equal(request.qualifying, false);
        assert.equal(request.authority, "addendum-review-only");
        assert.deepEqual(request.targetHashes, binding.targetHashes);
        assert.equal(request.envelope.sha256, envelope.sha256);
        assert.equal(request.hostedRun.imageVersion, HOSTED_IMAGE_VERSION);
        assert.equal(request.hostedRun.nonce, HOSTED_NONCE);
        assert.equal(request.proposedEvidence.windowsNative.status, "oracle-accepted");
        assert.equal(request.proposedEvidence.windowsCpuFloor, null);
        assert.equal(request.proposedEvidence.msiLifecycle, null);
        assert.deepEqual(request.releaseGatesCleared, []);
        assert.equal("eligible" in request, false);
        assert.equal("promotion" in request, false);
        assert.equal(Object.isFrozen(request), true);
    });

    it("rejects real oracle evidence with a different published candidate identity", async () => {
        const target = bindV161PostReleaseTarget(fixture());
        const binding = createV161PostReleaseStandaloneBinding(target, hostedContext());
        const candidates = binding.candidates.map(candidate => ({...candidate}));
        candidates[0].releaseAssetId = "563103999";
        const evidence = await standaloneEvidence(binding, candidates);
        assert.throws(() => createV161PostReleaseStandaloneEnvelope(binding, {
            hostRequestBytes: evidence.hostRequestBytes, proofRequestBytes: evidence.proofRequestBytes}));
    });

    it("rejects nonce, image-version, and alternate-target envelope rebinding", async () => {
        const target = bindV161PostReleaseTarget(fixture());
        const binding = createV161PostReleaseStandaloneBinding(target, hostedContext());
        const evidence = await standaloneEvidence(binding);
        const envelope = createV161PostReleaseStandaloneEnvelope(binding, {
            hostRequestBytes: evidence.hostRequestBytes, proofRequestBytes: evidence.proofRequestBytes});

        const secondInput = fixture(); secondInput.observedAt = "2026-09-14T12:31:00Z";
        const secondBinding = createV161PostReleaseStandaloneBinding(
            bindV161PostReleaseTarget(secondInput), hostedContext());
        assert.notEqual(binding.targetHashes.postReleaseTargetSha256,
            secondBinding.targetHashes.postReleaseTargetSha256);
        assert.throws(() => inspectV161PostReleaseStandaloneEvidence(secondBinding, evidence, envelope.bytes));

        for (const change of [context => { context.nonce = "f".repeat(32); },
            context => { context.imageVersion = "20260914.2"; }]) {
            const context = hostedContext(); change(context);
            const mismatched = createV161PostReleaseStandaloneBinding(target, context);
            assert.throws(() => inspectV161PostReleaseStandaloneEvidence(mismatched, evidence, envelope.bytes));
        }
        assert.throws(() => inspectV161PostReleaseStandaloneEvidence(structuredClone(binding),
            evidence, envelope.bytes));
    });

    it("builds the exact legacy guarded execution plan and required retained envelope", () => {
        const target = bindV161PostReleaseTarget(fixture());
        const binding = createV161PostReleaseStandaloneBinding(target, hostedContext());
        const producer = buildV161PostReleaseStandaloneProducerPlan(binding, producerAcquired(binding));
        assert.equal(producer.kind, "myspeed-v1.6.1-post-release-standalone-producer-plan");
        assert.equal(producer.authority, "retain-before-hosted-execution");
        assert.equal(producer.nativeExecutionAuthorized, false);
        assert.equal(producer.retention.requiredBeforeNativeExecution, true);
        assert.equal(producer.retention.path,
            `C:\\runner\\myspeed-native-standalone-${HOSTED_NONCE}\\post-release-envelope.json`);
        assert.equal(jsonSha256(producer.retention.envelope.value),
            producer.retention.envelope.sha256);
        assert.equal(producer.executionPlan.proofRequest.adapterRequest.expectedSourceSha, CANDIDATE_SHA);
        assert.equal(producer.executionPlan.proofRequest.adapterRequest.expectedEventSha, HARNESS_SHA);
        assert.equal(producer.executionPlan.proofRequest.candidates[0].artifactId, "563103772");
        assert.equal(producer.executionPlan.proofRequest.candidates[1].artifactId, "563103679");
        assert.equal(producer.executionPlan.controllerRequests.length, 6);
        assert.deepEqual(producer.releaseGatesCleared, []);
    });

    it("rejects acquired payload identity drift before constructing executable requests", () => {
        const target = bindV161PostReleaseTarget(fixture());
        const binding = createV161PostReleaseStandaloneBinding(target, hostedContext());
        for (const change of [input => { input.candidates[0].sourceIdentity.bytes -= 1; },
            input => { input.candidates[1].sourceIdentity.sha256 = "0".repeat(64); },
            input => { input.candidates.reverse(); }, input => { input.extra = true; }]) {
            const acquired = producerAcquired(binding); change(acquired);
            assert.throws(() => buildV161PostReleaseStandaloneProducerPlan(binding, acquired));
        }
    });

    it("retains and rereads the sealed envelope before writing executable requests", async () => {
        const binding = createV161PostReleaseStandaloneBinding(
            bindV161PostReleaseTarget(fixture()), hostedContext());
        const producer = buildV161PostReleaseStandaloneProducerPlan(binding, producerAcquired(binding));
        const events = [];
        const retained = await retainV161PostReleaseStandaloneProducerPlan(producer, {
            writeEnvelope: async ({path, bytes}) => { events.push(["write-envelope", path]);
                assert.equal(bytes, producer.retention.envelope.bytes); },
            readEnvelope: async path => { events.push(["read-envelope", path]);
                return Buffer.from(producer.retention.envelope.bytes); },
            writeExecutionPlan: async plan => { events.push(["write-execution", plan.hostRequestSha256]);
                return {kind: "synthetic-written-plan", hostRequestSha256: plan.hostRequestSha256}; }
        });
        assert.deepEqual(events.map(event => event[0]),
            ["write-envelope", "read-envelope", "write-execution"]);
        assert.equal(retained.envelopeSha256, producer.retention.envelope.sha256);
        assert.equal(retained.execution.kind, "synthetic-written-plan");
        assert.equal(retained.nativeExecutionStarted, false);
    });

    it("refuses changed request or envelope bytes before any retention write", async () => {
        const binding = createV161PostReleaseStandaloneBinding(
            bindV161PostReleaseTarget(fixture()), hostedContext());
        for (const change of [producer => { producer.executionPlan.proofRequestBytes[0] ^= 1; },
            producer => { producer.executionPlan.controllerRequests[0].bytes[0] ^= 1; },
            producer => { producer.executionPlan.controllerRequests[0].path = "C:\\foreign\\candidate.request.json"; },
            producer => { producer.executionPlan.hostRequest.taskRoot = "C:\\foreign"; },
            producer => { producer.retention.envelope.bytes[0] ^= 1; }]) {
            const producer = buildV161PostReleaseStandaloneProducerPlan(binding, producerAcquired(binding));
            change(producer);
            let called = false;
            await assert.rejects(retainV161PostReleaseStandaloneProducerPlan(producer, {
                writeEnvelope: async () => { called = true; }, readEnvelope: async () => Buffer.alloc(0),
                writeExecutionPlan: async () => { called = true; }
            }));
            assert.equal(called, false);
        }
    });

    it("prepares from fixed hosted/API identities without caller-supplied capture records", async () => {
        const source = fixture();
        const api = new Map([
            ["tag", {object: {type: "commit", sha: CANDIDATE_SHA}}],
            ["run", {id: 34829932391, run_attempt: 1, head_sha: CANDIDATE_SHA,
                event: "workflow_dispatch", status: "completed", conclusion: "success",
                name: "Qualify release candidate", created_at: "2026-09-14T09:48:50Z",
                updated_at: "2026-09-14T09:54:31Z", repository: {full_name: REPOSITORY}}],
            ["artifact", {id: 10342345489, name: "release-qualification-manifest",
                size_in_bytes: 7046, digest: source.qualificationArchive.digest, expired: false,
                created_at: "2026-09-14T09:54:28Z", updated_at: "2026-09-14T09:54:28Z",
                expires_at: "2026-09-21T09:54:27Z",
                workflow_run: {id: 34829932391, head_sha: CANDIDATE_SHA}}],
            ["release", {id: 388294074, tag_name: TAG_NAME, target_commitish: "development",
                created_at: "2026-09-14T09:48:17Z", published_at: "2026-09-14T10:00:58Z",
                draft: false, prerelease: false, immutable: false,
                assets: source.release.assets.map(value => ({id: value.id, name: value.name,
                    size: value.size, digest: value.digest, state: value.state,
                    browser_download_url: value.url, created_at: value.createdAt,
                    updated_at: value.updatedAt}))}]
        ]);
        const calls = [];
        let retainedEnvelopeBytes;
        const environment = {GITHUB_ACTIONS: "true", CI: "true", GITHUB_REPOSITORY: REPOSITORY,
            RUNNER_OS: "Windows", RUNNER_ARCH: "X64", RUNNER_ENVIRONMENT: "github-hosted",
            ImageOS: "win25-vs2026", ImageVersion: HOSTED_IMAGE_VERSION,
            GITHUB_RUN_ID: HOSTED_RUN_ID, GITHUB_RUN_ATTEMPT: HOSTED_RUN_ATTEMPT,
            GITHUB_SHA: HARNESS_SHA, RUNNER_TEMP: "C:\\runner-temp"};
        const result = await prepareV161PostReleaseHostedCoordinator({environment, operations: {
            now: () => new Date("2026-09-14T12:30:00.789Z"),
            fetchFixedJson: async (endpoint, url) => { calls.push(["api", endpoint, url]);
                return api.get(endpoint); },
            acquirePublicAsset: async request => { calls.push(["download", request.name, request.url]);
                return {path: request.destination, bytes: request.expectedBytes, sha256: request.expectedSha256}; },
            readManifestBytes: async () => Buffer.from(source.manifestBytes),
            hashClosure: async names => Object.fromEntries(names.map(name => [name, "4".repeat(64)])),
            prepareOwnedExecutionMaterial: async context => producerAcquired(context.binding),
            writeEnvelope: async ({bytes}) => { calls.push(["write-envelope"]);
                retainedEnvelopeBytes = Buffer.from(bytes); return bytes.length; },
            readEnvelope: async () => Buffer.from(retainedEnvelopeBytes),
            writeExecutionPlan: async plan => ({kind: "written", hostRequestSha256: plan.hostRequestSha256})
        }});
        assert.equal(result.kind, "myspeed-v1.6.1-post-release-hosted-preparation");
        assert.equal(result.nativeExecutionStarted, false);
        assert.equal(result.candidateSourceSha, CANDIDATE_SHA);
        assert.equal(result.harnessSourceSha, HARNESS_SHA);
        assert.equal(result.targetHashes.postReleaseTargetSha256,
            jsonSha256(bindV161PostReleaseTarget(source)));
        assert.deepEqual(calls.filter(call => call[0] === "download").map(call => call[1]),
            ["qualification-manifest.json", "MySpeed-windows-x64-baseline.exe", "MySpeed-windows-x64.exe"]);
        assert.deepEqual(calls.filter(call => call[0] === "api").map(call => call.slice(1)), [
            ["tag", "https://api.github.com/repos/i7Gamer/MySpeed/git/ref/tags/v1.6.1"],
            ["run", "https://api.github.com/repos/i7Gamer/MySpeed/actions/runs/34829932391/attempts/1"],
            ["artifact", "https://api.github.com/repos/i7Gamer/MySpeed/actions/artifacts/10342345489"],
            ["release", "https://api.github.com/repos/i7Gamer/MySpeed/releases/388294074"]
        ]);
        assert.deepEqual(calls.filter(call => call[0] === "download").map(call => call[2]), [
            "https://github.com/i7Gamer/MySpeed/releases/download/v1.6.1/qualification-manifest.json",
            "https://github.com/i7Gamer/MySpeed/releases/download/v1.6.1/MySpeed-windows-x64-baseline.exe",
            "https://github.com/i7Gamer/MySpeed/releases/download/v1.6.1/MySpeed-windows-x64.exe"
        ]);
    });

    it("exposes only the fixed no-stdin preparation command", async () => {
        for (const args of [[], ["--prepare"], ["--prepare-v1.6.1", "extra"], "--prepare-v1.6.1"]) {
            await assert.rejects(runV161PostReleaseHostedControllerCli(args), /Usage:/);
        }
    });

    it("rejects noncanonical or root runner temporary paths before any operation", async () => {
        const base = {GITHUB_ACTIONS: "true", CI: "true", GITHUB_REPOSITORY: REPOSITORY,
            RUNNER_OS: "Windows", RUNNER_ARCH: "X64", RUNNER_ENVIRONMENT: "github-hosted",
            ImageOS: "win25-vs2026", ImageVersion: HOSTED_IMAGE_VERSION,
            GITHUB_RUN_ID: HOSTED_RUN_ID, GITHUB_RUN_ATTEMPT: HOSTED_RUN_ATTEMPT,
            GITHUB_SHA: HARNESS_SHA, RUNNER_TEMP: "C:\\runner-temp"};
        for (const runnerTemp of ["C:\\runner-temp\\..\\foreign", "C:\\", "relative", "C:\\runner-temp\\"]) {
            await assert.rejects(prepareV161PostReleaseHostedCoordinator({
                environment: {...base, RUNNER_TEMP: runnerTemp}, operations: {}
            }), /runner temp path differs/);
        }
    });

    it("wires a manual nonpublishing source-free hosted preparation and execution", () => {
        const workflow = fs.readFileSync(WORKFLOW_PATH, "utf8");
        assert.match(workflow, /workflow_dispatch:/u);
        assert.match(workflow, /permissions:\s*\n\s+actions: read\s*\n\s+contents: read/u);
        assert.match(workflow, /node \$controller --prepare-v1\.6\.1/u);
        assert.match(workflow, /node \$hosted --execute/u);
        assert.match(workflow, /post-release-envelope\.json/u);
        assert.match(workflow, /'host\.entry-failure\.json'=\(Join-Path \$taskRoot 'host\.entry-failure\.json'\)/u);
        assert.match(workflow, /windows-native-post-release-evidence\.mjs'[\s\S]*--inventory/u);
        assert.match(workflow, /Hash-bound scenario evidence inventory/u);
        assert.match(workflow, /\$scenarioSources\.Count -ne 25/u);
        assert.match(workflow, /\$requiredNames \+= @\(\$scenarioSources \| ForEach-Object \{ \$_\.name \}\)/u);
        assert.match(workflow, /\[IO\.FileShare\]::Read/u);
        assert.match(workflow, /\[IO\.FileMode\]::CreateNew/u);
        assert.match(workflow, /\$entry\.allowEmpty/u);
        assert.doesNotMatch(workflow, /signed scenario evidence/iu);
        assert.match(workflow, /--test-name-pattern="compiles its native declarations\|captures native operation limits\|uses captured input bounds\|captures cleanup limits"[\s\S]*tests\/server\/windowsNativeStandaloneHost\.test\.js\s*`\s*\n\s*tests\/server\/windowsNativeCandidateController\.test\.js/u);
        assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40}/u);
        assert.match(workflow, /artifact\.workflow_run\?\.id !== context\.runId/u);
        const migrationGeneration = workflow.indexOf("node scripts/generate-migrations.js");
        const integrationGeneration = workflow.indexOf("node scripts/generate-integrations.js");
        const fixtureHandoff = workflow.indexOf("node candidate-source/scripts/qualification/fixture.mjs handoff");
        assert.ok(migrationGeneration > 0 && migrationGeneration < fixtureHandoff);
        assert.ok(integrationGeneration > migrationGeneration && integrationGeneration < fixtureHandoff);
        const generatorStep = workflow.slice(workflow.lastIndexOf("\n      - name:", migrationGeneration),
            workflow.indexOf("\n      - name:", integrationGeneration));
        assert.match(generatorStep, /working-directory: candidate-source/u);
        assert.match(generatorStep, /generate-migrations\.js[\s\S]*\$LASTEXITCODE -ne 0/u);
        assert.match(generatorStep, /generate-integrations\.js[\s\S]*\$LASTEXITCODE -ne 0/u);
        assert.equal(workflow.match(
            /\$EMPTY_FIXTURE_MEMBER = 'fixture\/populated\/data\/storage\.db-wal'/gu)?.length, 2);
        assert.equal(workflow.match(
            /\$EMPTY_FILE_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'/gu)
            ?.length, 2);
        assert.match(workflow,
            /filesSha256\['data\/storage\.db-wal'\][\s\S]*\$emptyFixtureMemberSha256 -ceq \$EMPTY_FILE_SHA256/u);
        assert.match(workflow,
            /\$relativeName -ceq \$EMPTY_FIXTURE_MEMBER[\s\S]*\$item\.Length -eq 0[\s\S]*\$sha256 -ceq \$EMPTY_FILE_SHA256/u);
        const closureBuild = workflow.slice(workflow.indexOf("\n      - name: Build exact source-free closure"),
            workflow.indexOf("\n      - name: Upload exact source-free closure"));
        assert.ok(closureBuild.indexOf("$item.Attributes") < closureBuild.indexOf("$sha256 ="));
        const executeJob = workflow.slice(workflow.indexOf("\n  execute:"), workflow.indexOf("\n  verify-provenance:"));
        assert.match(executeJob,
            /\$expected\.name -ceq \$EMPTY_FIXTURE_MEMBER[\s\S]*\[int64\]\$expected\.bytes -eq 0[\s\S]*\$expected\.sha256 -ceq \$EMPTY_FILE_SHA256/u);
        const closureValidation = executeJob.slice(executeJob.indexOf("Validate every sealed closure member"),
            executeJob.indexOf("Prepare bound target, payloads, envelope, and requests"));
        assert.ok(closureValidation.indexOf("$item.Attributes") < closureValidation.indexOf("$sha256 ="));
        assert.doesNotMatch(executeJob, /actions\/checkout@/u);
        assert.doesNotMatch(workflow, /(?:gh\s+release|releases:\s*write|contents:\s*write)/u);
    });

    it("verifies bare upload digests against prefixed GitHub artifact metadata in both jobs", async () => {
        const workflow = fs.readFileSync(WORKFLOW_PATH, "utf8");
        const digest = "9".repeat(64);
        const headSha = "8".repeat(40);
        const runId = 40_000_000_001;
        for (const fixtureValue of [
            {step: "Verify current-run closure artifact metadata", environmentName: "CLOSURE_ARTIFACT",
                artifactId: "7001", artifactName: "myspeed-v1.6.1-post-release-closure", maximumBytes: 134_217_728},
            {step: "Bind evidence archive to this run and harness", environmentName: "EVIDENCE_ARTIFACT",
                artifactId: "7002", artifactName: "myspeed-v1.6.1-post-release-native-evidence", maximumBytes: 10_485_760}
        ]) {
            const script = githubScriptForStep(workflow, fixtureValue.step);
            const execute = new AsyncFunction("github", "context", "process", script);
            const environment = {[`${fixtureValue.environmentName}_ID`]: fixtureValue.artifactId,
                [`${fixtureValue.environmentName}_DIGEST`]: digest};
            const artifact = {id: Number(fixtureValue.artifactId), name: fixtureValue.artifactName,
                digest: `sha256:${digest}`, expired: false, size_in_bytes: fixtureValue.maximumBytes,
                workflow_run: {id: runId, head_sha: headSha}};
            const run = value => execute({rest: {actions: {getArtifact: async () => ({data: value})}}},
                {repo: {owner: "i7Gamer", repo: "MySpeed"}, runId, sha: headSha}, {env: environment});
            await run(artifact);
            for (const mutate of [value => { value.digest = digest; },
                value => { value.workflow_run.id += 1; }, value => { value.workflow_run.head_sha = "7".repeat(40); }]) {
                const changed = structuredClone(artifact); mutate(changed);
                await assert.rejects(run(changed), /artifact metadata differs/u, fixtureValue.step);
            }
            const invalidEnvironment = {...environment, [`${fixtureValue.environmentName}_DIGEST`]: `A${digest.slice(1)}`};
            await assert.rejects(execute({rest: {actions: {getArtifact: async () => ({data: artifact})}}},
                {repo: {owner: "i7Gamer", repo: "MySpeed"}, runId, sha: headSha}, {env: invalidEnvironment}),
            /artifact metadata differs/u, fixtureValue.step);
        }
    });
});
