import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {describe, it} from "node:test";
import {fileURLToPath} from "node:url";

import {runV161PostReleaseCpuFloorHostedInputs} from
    "../../scripts/release/post-release-cpu-floor-hosted-inputs.mjs";
import {bindV161PostReleaseTarget} from "../../scripts/release/post-release-target.mjs";
import {WINDOWS_BASELINE_RUNTIME_BUNDLE_CONSTANTS} from
    "../../scripts/qualification/windows-baseline-guest-runtime-bundle.mjs";
import {prepareV161PostReleaseCpuFloorGuestFiles} from
    "../../scripts/release/post-release-cpu-floor-guest-preparation.mjs";
import {targetInput, hostedContext, authenticBaselineSummaryBytes, baselineArtifactRecord, OBSERVED_AT,
    stage3ExecutionPlan} from "../helpers/post-release-cpu-floor-fixture.mjs";

const context = hostedContext();
const REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ARTIFACT_ROOT = `/home/runner/work/_temp/myspeed-windows-msi-${context.nonce}/appassets`;
const STAGE3_ROOT = `/home/runner/work/_temp/myspeed-stage3-${context.nonce}`;
const record = relativePath => ({bindingId: `baseline:${relativePath}`, sourceRole: relativePath.startsWith("runtime/")
    ? "harness" : "candidate", sourceSha: relativePath.startsWith("runtime/") ? context.sourceSha
        : targetInput().tag.commitSha, relativePath, bytes: 10, sha256: "1".repeat(64)});
const baselineFiles = () => [record("qualification-manifest.json"), record("fixture/transport.json"),
    ...WINDOWS_BASELINE_RUNTIME_BUNDLE_CONSTANTS.RUNTIME_PATHS.map(name => record(`runtime/${name}`)),
    record("runtime/scripts/qualification/windows-baseline-guest-runtime-installer.ps1")];
const roots = () => ({stage3: STAGE3_ROOT, candidate: `${STAGE3_ROOT}/candidate`,
    closure: `/home/runner/work/_temp/myspeed-stage3-closure-${context.nonce}`,
    stage2Closure: `/home/runner/work/_temp/myspeed-stage2-closure-${context.nonce}`,
    transport: `/home/runner/work/_temp/myspeed-stage2-transport-${context.nonce}`,
    envelope: `/home/runner/work/_temp/myspeed-stage3-sequence-envelope-${context.nonce}`});
function observedFixture() {
    const target = bindV161PostReleaseTarget(targetInput());
    return {target, baselinePreparation: {files: baselineFiles()}, execution: {root: ARTIFACT_ROOT,
        runtime: {path: `${ARTIFACT_ROOT}/files/node-v22.19.0-win-x64/node.exe`, bytes: 85_268_464,
            sha256: "995a3fb3cefad590cd3f4b321532a4b9582fb9c6575320ed2e3e894caac3e362"}, files: [{
            bindingId: "candidate-baseline", role: "exe", path: `${ARTIFACT_ROOT}/files/candidate-baseline.exe`,
            bytes: 111_524_352, sha256: "bc4eea0a06c890eb5c0da0472a1705b3219aac3f5000383d9847120b5681d154"}]}};
}
const adapterInput = observed => ({observedMsiPreparation: observed, hostedContext: context,
    artifactRoot: ARTIFACT_ROOT, baselineArtifact: baselineArtifactRecord(),
    baselineSummaryBytes: authenticBaselineSummaryBytes(), observedAt: OBSERVED_AT,
    probeArtifact: {sourceSha: targetInput().tag.commitSha}, probes: [], roots: roots(), closureRecords: [],
    stage3Plan: stage3ExecutionPlan()});
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const physicalIdentity = target => { const bytes = fs.readFileSync(target); return {path: fs.realpathSync.native(target),
    bytes: bytes.length, sha256: hash(bytes)}; };
const COMMON_FIXTURE_FILES = ["bin/cfspeedtest.exe", "bin/iperf3.exe", "bin/librespeed-cli.exe", "bin/ost-cli.exe",
    "bin/speedtest.exe", "data/servers/librespeed.json", "data/servers/ookla.json"];
function writeFixtureTree(root, populated) {
    for (const name of COMMON_FIXTURE_FILES) { const target = path.join(root, ...name.split("/"));
        fs.mkdirSync(path.dirname(target), {recursive: true}); fs.writeFileSync(target, name); }
    if (populated) fs.writeFileSync(path.join(root, "data", "storage.db"), "sqlite-fixture");
    fs.writeFileSync(path.join(root, ".myspeed-qualification.json"), "owned-marker\n");
}
const inventory = root => Object.fromEntries(fs.readdirSync(root, {recursive: true, withFileTypes: true})
    .filter(entry => entry.isFile()).map(entry => { const target = path.join(entry.parentPath, entry.name);
        return [path.relative(root, target).replaceAll(path.sep, "/"), hash(fs.readFileSync(target))]; })
    .sort(([left], [right]) => left.localeCompare(right)));

describe("post-release CPU-floor hosted input adapter", () => {
    it("maps the authenticated preparation into real consumer bindings and the launcher contract", async () => {
        const observed = observedFixture(); const {target} = observed;
        const staged = []; let preparedInput; let launcherInput; let stage2ClosureInput;
        const summary = authenticBaselineSummaryBytes(); const manifest = targetInput().manifestBytes;
        const probes = [{role: "avx", name: "avx.exe", path: "/probe/avx.exe", bytes: 5,
            sha256: "2".repeat(64)}];
        const result = await runV161PostReleaseCpuFloorHostedInputs({observedMsiPreparation: observed,
            hostedContext: context, artifactRoot: ARTIFACT_ROOT, baselineArtifact: baselineArtifactRecord(),
            baselineSummaryBytes: summary, observedAt: OBSERVED_AT, probeArtifact: {sourceSha: target.candidate.sourceSha},
            probes, roots: roots(), closureRecords: [{name: "sealed"}], stage3Plan: stage3ExecutionPlan()}, {
            readOwned: (_identity, label) => label === "qualification manifest" ? manifest : Buffer.from("candidate"),
            makeDirectory: targetPath => assert.equal(targetPath, STAGE3_ROOT),
            prepareGuest: value => { preparedInput = value; return {files: [{name: "node.exe"}]}; },
            stageFile: (targetPath, bytes) => staged.push({targetPath, bytes}),
            makeStage2Closure: (...value) => { stage2ClosureInput = value; },
            launch: async value => { launcherInput = value; return {accepted: true, qualifying: false}; }
        });
        assert.equal(result.accepted, true);
        assert.equal(preparedInput.runtimeSources.length,
            WINDOWS_BASELINE_RUNTIME_BUNDLE_CONSTANTS.RUNTIME_PATHS.length);
        assert.equal(preparedInput.runtimeNode.bytes, "85268464");
        assert.equal(preparedInput.probes[0].bytes, "5");
        assert.equal(preparedInput.outputRoot, `${STAGE3_ROOT}/candidate`);
        assert.deepEqual(stage2ClosureInput, [roots().closure, roots().stage2Closure]);
        assert.equal(launcherInput.binding.candidate.sourceSha, target.candidate.sourceSha);
        assert.equal(launcherInput.acquired.summary.sha256,
            "e8e8106aa6584fe99382a205842d78dbf83d21ae9fe8b4edafc6156cf2f29ddd");
        assert.deepEqual(launcherInput.guestFiles, [{name: "node.exe"}]);
        assert.deepEqual(launcherInput.plan, stage3ExecutionPlan());
        assert.deepEqual(staged.map(value => path.basename(value.targetPath)),
            ["MySpeed.exe", "qualification-summary.json", "qualification-manifest.json"]);
        assert.equal(staged[1].bytes.equals(summary), true);
        assert.equal(staged[2].bytes.equals(manifest), true);
    });

    it("composes numeric observer identities into the real physical guest preparation", async () => {
        const temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cpu-hosted-compose-")));
        try {
            const artifactRoot = path.join(temporary, "appassets");
            const baselineRoot = path.join(artifactRoot, "files", "baseline");
            const populatedRoot = path.join(baselineRoot, "fixture", "populated");
            const resetRoot = path.join(baselineRoot, "fixture", "reset");
            fs.mkdirSync(populatedRoot, {recursive: true}); fs.mkdirSync(resetRoot);
            writeFixtureTree(populatedRoot, true); writeFixtureTree(resetRoot, false);
            const fixtureManifest = {schemaVersion: 1, source: {commit: targetInput().tag.commitSha,
                bunLockSha256: "1".repeat(64), packageSha256: "2".repeat(64)},
            populated: {root: "C:\\producer\\populated", nonce: "3".repeat(48),
                markerSha256: hash(fs.readFileSync(path.join(populatedRoot, ".myspeed-qualification.json"))),
                databaseSha256: hash(fs.readFileSync(path.join(populatedRoot, "data", "storage.db"))),
                filesSha256: inventory(populatedRoot)}, reset: {root: "C:\\producer\\reset",
                nonce: "5".repeat(48), markerSha256: hash(fs.readFileSync(path.join(resetRoot,
                    ".myspeed-qualification.json"))), filesSha256: inventory(resetRoot)},
            expected: {ping: "123.456", resultId: "qualification-seed-row",
                passwordValueSha256: "7".repeat(64)}};
            fs.writeFileSync(path.join(baselineRoot, "fixture", "transport.json"),
                `${JSON.stringify(fixtureManifest)}\n`);
            fs.writeFileSync(path.join(baselineRoot, "qualification-manifest.json"), targetInput().manifestBytes);
            for (const relativePath of WINDOWS_BASELINE_RUNTIME_BUNDLE_CONSTANTS.RUNTIME_PATHS) {
                const target = path.join(baselineRoot, "runtime", ...relativePath.split("/"));
                fs.mkdirSync(path.dirname(target), {recursive: true});
                fs.copyFileSync(path.join(REPOSITORY, ...relativePath.split("/")), target);
            }
            const installerRelative = "scripts/qualification/windows-baseline-guest-runtime-installer.ps1";
            const installer = path.join(baselineRoot, "runtime", ...installerRelative.split("/"));
            fs.mkdirSync(path.dirname(installer), {recursive: true});
            fs.copyFileSync(path.join(REPOSITORY, ...installerRelative.split("/")), installer);
            const nodePath = path.join(artifactRoot, "files", "node-v22.19.0-win-x64", "node.exe");
            fs.mkdirSync(path.dirname(nodePath), {recursive: true}); fs.writeFileSync(nodePath, "inert-node");
            const probeRoot = path.join(temporary, "probes"); fs.mkdirSync(probeRoot);
            const probePairs = [["avx", "avx.exe"], ["avx2", "avx2.exe"], ["cpuid", "cpuid.exe"],
                ["illegal", "illegal.exe"], ["known-bad", "known_bad.exe"],
                ["known-good", "known_good.exe"], ["popcnt", "popcnt.exe"], ["sse42", "sse42.exe"]];
            const probes = probePairs.map(([role, name]) => { const target = path.join(probeRoot, name);
                fs.writeFileSync(target, role); return {role, name, ...physicalIdentity(target)}; });
            const files = [physicalIdentity(path.join(baselineRoot, "qualification-manifest.json")),
                physicalIdentity(path.join(baselineRoot, "fixture", "transport.json")),
                ...WINDOWS_BASELINE_RUNTIME_BUNDLE_CONSTANTS.RUNTIME_PATHS.map(relativePath =>
                    physicalIdentity(path.join(baselineRoot, "runtime", ...relativePath.split("/")))),
                physicalIdentity(installer)];
            const relativePaths = ["qualification-manifest.json", "fixture/transport.json",
                ...WINDOWS_BASELINE_RUNTIME_BUNDLE_CONSTANTS.RUNTIME_PATHS.map(name => `runtime/${name}`),
                `runtime/${installerRelative}`];
            const baseline = files.map((file, index) => ({bindingId: `baseline:${relativePaths[index]}`,
                sourceRole: relativePaths[index].startsWith("runtime/") ? "harness" : "candidate",
                sourceSha: relativePaths[index].startsWith("runtime/") ? context.sourceSha
                    : targetInput().tag.commitSha, relativePath: relativePaths[index], bytes: file.bytes,
                sha256: file.sha256}));
            const observed = observedFixture(); observed.execution.root = artifactRoot;
            observed.execution.runtime = physicalIdentity(nodePath); observed.baselinePreparation.files = baseline;
            const localStage3 = path.join(temporary, `myspeed-stage3-${context.nonce}`);
            const value = adapterInput(observed); value.artifactRoot = artifactRoot; value.probes = probes;
            let prepared;
            await runV161PostReleaseCpuFloorHostedInputs(value, {
                readOwned: (identity, label) => label === "candidate executable" ? Buffer.from("candidate")
                    : fs.readFileSync(identity.path),
                makeDirectory: () => fs.mkdirSync(localStage3),
                prepareGuest: guestInput => { prepared = prepareV161PostReleaseCpuFloorGuestFiles(
                    {...guestInput, outputRoot: path.join(localStage3, "candidate")},
                    {expectedNodeSha256: guestInput.runtimeNode.sha256}); return prepared; },
                stageFile: () => {}, makeStage2Closure: () => {}, launch: async () => ({accepted: true})
            });
            assert.equal(prepared.files.length, 14);
            assert.equal(prepared.files.find(file => file.name === "node.exe").bytes, String("inert-node".length));
            assert.equal(prepared.files.find(file => file.name === "avx.exe").bytes, String("avx".length));
        } finally { fs.rmSync(temporary, {recursive: true, force: true}); }
    });

    it("fails before staging when the observed artifact root is not the authenticated root", async () => {
        await assert.rejects(() => runV161PostReleaseCpuFloorHostedInputs({observedMsiPreparation: {
            target: bindV161PostReleaseTarget(targetInput()), execution: {root: "/different"}},
        hostedContext: context, artifactRoot: ARTIFACT_ROOT, baselineArtifact: baselineArtifactRecord(),
        baselineSummaryBytes: authenticBaselineSummaryBytes(), observedAt: OBSERVED_AT, probeArtifact: {}, probes: [],
        roots: roots(), closureRecords: [], stage3Plan: stage3ExecutionPlan()}), /preparation binding differs/u);
    });

    for (const [label, mutate, pattern] of [
        ["a missing candidate", value => { value.observedMsiPreparation.execution.files = []; },
            /candidate executable is missing/u],
        ["invalid roots", value => { value.roots.transport = "/wrong"; }, /Stage 3 roots differ/u],
        ["a missing baseline manifest", value => { value.observedMsiPreparation.baselinePreparation.files =
            value.observedMsiPreparation.baselinePreparation.files.filter(file =>
                file.relativePath !== "qualification-manifest.json"); }, /baseline file is missing/u],
        ["an expired summary artifact", value => { value.baselineArtifact = {...value.baselineArtifact,
            expiresAt: "2026-09-15T13:28:32Z"}; }, /lapsed/u]
    ]) it(`refuses ${label} before staging`, async () => {
        const value = adapterInput(observedFixture()); mutate(value); let staged = false;
        await assert.rejects(() => runV161PostReleaseCpuFloorHostedInputs(value, {
            readOwned: (_identity, name) => name === "qualification manifest" ? targetInput().manifestBytes
                : Buffer.from("candidate"), makeDirectory: () => { staged = true; },
            stageFile: () => { staged = true; }
        }), pattern);
        assert.equal(staged, false);
    });

    it("refuses a hosted input that declares no Stage 3 execution plan", async () => {
        const value = adapterInput(observedFixture());
        delete value.stage3Plan;
        await assert.rejects(() => runV161PostReleaseCpuFloorHostedInputs(value, {}),
            /hosted CPU-floor input schema differs/u);
    });

    it("refuses a non-accepted launcher result", async () => {
        const value = adapterInput(observedFixture());
        await assert.rejects(() => runV161PostReleaseCpuFloorHostedInputs(value, {
            readOwned: (_identity, name) => name === "qualification manifest" ? targetInput().manifestBytes
                : Buffer.from("candidate"), makeDirectory: () => {},
            prepareGuest: () => ({files: []}), stageFile: () => {}, makeStage2Closure: () => {},
            launch: async () => ({accepted: false})
        }), /did not accept/u);
    });
});
