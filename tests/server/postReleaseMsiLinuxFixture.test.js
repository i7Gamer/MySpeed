import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {describe, it} from "node:test";

import {WINDOWS_BASELINE_RUNTIME_BUNDLE_CONSTANTS} from
    "../../scripts/qualification/windows-baseline-guest-runtime-bundle.mjs";
import {prepareV161PostReleaseBaselineInputs, validateV161PostReleaseBaselineInputPreparation} from
    "../../scripts/release/post-release-msi-baseline-input-preparation.mjs";
import {createCandidateBaselineFixtureSource} from "../helpers/baseline-fixture-source.mjs";
import {prepareV161PostReleaseMsiLinuxFixture, validateV161PostReleaseMsiLinuxFixturePreparation} from
    "../../scripts/release/post-release-msi-linux-fixture.mjs";
import {validateV161PostReleaseMsiHostFixture} from "../../scripts/release/post-release-msi-host-request.mjs";

const HARNESS_SHA = "a".repeat(40);
const NONCE = "0123456789abcdef0123456789abcdef";
const TASK_ROOT = `/home/runner/work/_temp/myspeed-windows-msi-${NONCE}`;
const ARTIFACT_ROOT = `${TASK_ROOT}/appassets`;
const sha256 = value => createHash("sha256").update(value).digest("hex");
const write = (root, relative, bytes) => { const target = path.join(root, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), {recursive: true}); fs.writeFileSync(target, bytes, {flag: "wx"}); };

const context = () => ({schemaVersion: 1, repository: "i7Gamer/MySpeed", sourceSha: HARNESS_SHA,
    eventSha: HARNESS_SHA, runId: "40000000001", runAttempt: "1", nonce: NONCE,
    environment: {GITHUB_ACTIONS: "true", CI: "true", RUNNER_OS: "Linux", RUNNER_ARCH: "X64",
        RUNNER_ENVIRONMENT: "github-hosted", ImageOS: "ubuntu24", ImageVersion: "20260914.1"}});

const makePreparation = root => {
    const source = createCandidateBaselineFixtureSource(path.join(root, "candidate"));
    const harnessRoot = path.join(root, "harness");
    for (const relative of [...WINDOWS_BASELINE_RUNTIME_BUNDLE_CONSTANTS.RUNTIME_PATHS,
        "scripts/qualification/windows-baseline-guest-runtime-installer.ps1"])
        write(harnessRoot, relative, Buffer.from(`harness:${relative}`));
    const outputRoot = path.join(root, "baseline-output");
    const value = prepareV161PostReleaseBaselineInputs({candidateFixture: {
        manifestPath: source.manifest.path, populatedRoot: source.populatedRoot, resetRoot: source.resetRoot},
    harnessRoot, harnessSourceSha: HARNESS_SHA, manifestPath: fs.realpathSync.native(
        "tests/fixtures/post-release-native-v1.6.1/qualification-manifest.json"), outputRoot});
    return {value, outputRoot};
};

const testOperations = (localRoot, generatedRoot, calls) => ({
    readExact: ({path: requested, expected, allowEmpty}) => {
        calls.push(["read", requested]);
        const relative = requested.slice(`${ARTIFACT_ROOT}/files/baseline/`.length);
        const bytes = fs.readFileSync(path.join(localRoot, ...relative.split("/")));
        assert.equal(allowEmpty, expected.relativePath.endsWith("storage.db-wal"));
        return {path: requested, bytes, identity: {path: requested, bytes: bytes.length, sha256: sha256(bytes)}};
    },
    createExact: ({path: requested, bytes}) => {
        calls.push(["create", requested]);
        const relative = requested.slice(`${TASK_ROOT}/generated-fixture/`.length);
        const target = path.join(generatedRoot, ...relative.split("/"));
        write(generatedRoot, relative, bytes);
        const retained = fs.readFileSync(target);
        return {path: requested, bytes: retained,
            identity: {path: requested, bytes: retained.length, sha256: sha256(retained)}};
    }
});

describe("post-release MSI Linux fixture preparation", () => {
    it("validates the real Windows producer and supplies separately branded sentinel bytes to every row input", async () => {
        const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-msi-linux-fixture-")));
        try {
            const {value, outputRoot} = makePreparation(root); const calls = [];
            const checked = validateV161PostReleaseBaselineInputPreparation(JSON.parse(JSON.stringify(value)));
            const result = await prepareV161PostReleaseMsiLinuxFixture({context: context(), taskRoot: TASK_ROOT,
                artifactRoot: ARTIFACT_ROOT, baselinePreparation: checked},
            testOperations(outputRoot, path.join(root, "generated"), calls));
            assert.equal(Object.isFrozen(result), true);
            assert.equal(result.binding.candidateSourceSha, value.candidateSourceSha);
            assert.equal(result.binding.harnessSourceSha, HARNESS_SHA);
            assert.deepEqual(result.binding.generatedSentinels.map(item => item.sourceRole), ["harness", "harness"]);
            assert.deepEqual(result.hostFixture.files.slice(-2).map(item => item.name),
                ["fixture/populated/destination.sentinel", "fixture/legacy/legacy.sentinel"]);
            assert.equal(result.hostFixture.execution.destinationSentinelSha256,
                result.hostFixture.files.at(-2).sha256);
            assert.equal(result.hostFixture.execution.legacySentinelSha256, result.hostFixture.files.at(-1).sha256);
            assert.equal(result.hostFixture.execution.sourceSha, value.candidateSourceSha);
            assert.deepEqual(validateV161PostReleaseMsiHostFixture(result.hostFixture, context()),
                result.hostFixture);
            assert.deepEqual(validateV161PostReleaseMsiLinuxFixturePreparation(result, {context: context(),
                taskRoot: TASK_ROOT, artifactRoot: ARTIFACT_ROOT, baselinePreparation: checked}), result);
            assert.deepEqual(Object.keys(result.hostFixture.execution.populatedFilesSha256),
                Object.keys(JSON.parse(Buffer.from(result.hostFixture.manifest.bytesBase64, "base64")).populated
                    .filesSha256));
            assert.equal(calls.filter(([operation]) => operation === "create").length, 2);
        } finally { fs.rmSync(root, {recursive: true, force: true}); }
    });

    it("rejects serialized source/order drift and a sentinel operation that does not return the written bytes", async () => {
        const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),
            "myspeed-msi-linux-fixture-reject-")));
        try {
            const {value, outputRoot} = makePreparation(root);
            for (const mutate of [record => { record.files.reverse(); },
                record => { record.files[1].sourceRole = "harness"; },
                record => { record.files[1].relativePath = "fixture/../foreign"; }]) {
                const changed = JSON.parse(JSON.stringify(value)); mutate(changed);
                assert.throws(() => validateV161PostReleaseBaselineInputPreparation(changed));
            }
            const operations = testOperations(outputRoot, path.join(root, "generated"), []);
            const original = operations.createExact; let creates = 0;
            operations.createExact = async request => { const observed = original(request); creates += 1;
                return creates === 1 ? {...observed, bytes: Buffer.from("changed")} : observed; };
            await assert.rejects(prepareV161PostReleaseMsiLinuxFixture({context: context(), taskRoot: TASK_ROOT,
                artifactRoot: ARTIFACT_ROOT, baselinePreparation: value}, operations), /sentinel.*(?:bytes|identity)/u);
            const valid = await prepareV161PostReleaseMsiLinuxFixture({context: context(), taskRoot: TASK_ROOT,
                artifactRoot: ARTIFACT_ROOT, baselinePreparation: value},
            testOperations(outputRoot, path.join(root, "generated-valid"), []));
            for (const mutate of [result => { result.binding.candidateFiles[0].sha256 = "f".repeat(64); },
                result => { result.binding.generatedSentinels[0].sourceRole = "candidate"; },
                result => { result.binding.generatedSentinels[1].sourcePath += "-foreign"; },
                result => { result.hostFixture.files.at(-1).sha256 = "f".repeat(64); }]) {
                const changed = structuredClone(valid); mutate(changed);
                assert.throws(() => validateV161PostReleaseMsiLinuxFixturePreparation(changed, {
                    context: context(), taskRoot: TASK_ROOT, artifactRoot: ARTIFACT_ROOT,
                    baselinePreparation: value}), /fixture|sentinel|binding/i);
            }
        } finally { fs.rmSync(root, {recursive: true, force: true}); }
    });
});
