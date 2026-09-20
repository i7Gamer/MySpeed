import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {describe, it} from "node:test";
import {fileURLToPath} from "node:url";

import {prepareV161PostReleaseCpuFloorGuestFiles} from
    "../../scripts/release/post-release-cpu-floor-guest-preparation.mjs";
import {WINDOWS_BASELINE_RUNTIME_BUNDLE_CONSTANTS} from
    "../../scripts/qualification/windows-baseline-guest-runtime-bundle.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY = path.resolve(HERE, "..", "..");
const CANDIDATE_SHA = "4fa4dd40a89a062735f98bd85d685e0624ff46a8";
const HARNESS_SHA = "dce629fd50ea007221b3a9f2698c32a573bca160";
const NONCE = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const COMMON = ["bin/cfspeedtest.exe", "bin/iperf3.exe", "bin/librespeed-cli.exe", "bin/speedtest.exe",
    "data/servers/librespeed.json", "data/servers/ookla.json"];
const PROBES = [["avx", "avx.exe"], ["avx2", "avx2.exe"], ["cpuid", "cpuid.exe"],
    ["illegal", "illegal.exe"], ["known-bad", "known_bad.exe"], ["known-good", "known_good.exe"],
    ["popcnt", "popcnt.exe"], ["sse42", "sse42.exe"]];
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const identity = target => { const bytes = fs.readFileSync(target); return {path: fs.realpathSync.native(target),
    bytes: String(bytes.length), sha256: hash(bytes)}; };
function tree(root, populated) {
    for (const name of COMMON) { const target = path.join(root, ...name.split("/"));
        fs.mkdirSync(path.dirname(target), {recursive: true}); fs.writeFileSync(target, name); }
    if (populated) fs.writeFileSync(path.join(root, "data", "storage.db"), "sqlite-fixture");
    fs.writeFileSync(path.join(root, ".myspeed-qualification.json"), "owned-marker\n");
}
const inventory = root => Object.fromEntries(fs.readdirSync(root, {recursive: true, withFileTypes: true})
    .filter(entry => entry.isFile()).map(entry => { const target = path.join(entry.parentPath, entry.name);
        return [path.relative(root, target).replaceAll(path.sep, "/"), hash(fs.readFileSync(target))]; })
    .sort(([left], [right]) => left.localeCompare(right)));
function fixture(root, commit = CANDIDATE_SHA) {
    const populatedRoot = path.join(root, "populated"); const resetRoot = path.join(root, "reset");
    fs.mkdirSync(populatedRoot); fs.mkdirSync(resetRoot); tree(populatedRoot, true); tree(resetRoot, false);
    const manifest = {schemaVersion: 1, source: {commit, bunLockSha256: "1".repeat(64),
        packageSha256: "2".repeat(64)}, populated: {root: "C:\\producer\\populated", nonce: "3".repeat(48),
        markerSha256: hash(fs.readFileSync(path.join(populatedRoot, ".myspeed-qualification.json"))),
        databaseSha256: hash(fs.readFileSync(path.join(populatedRoot, "data", "storage.db"))),
        filesSha256: inventory(populatedRoot)}, reset: {root: "C:\\producer\\reset", nonce: "5".repeat(48),
        markerSha256: hash(fs.readFileSync(path.join(resetRoot, ".myspeed-qualification.json"))),
        filesSha256: inventory(resetRoot)}, expected: {ping: "123.456", resultId: "qualification-seed-row",
        passwordValueSha256: "7".repeat(64)}};
    const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`); const target = path.join(root, "transport.json");
    fs.writeFileSync(target, bytes); return {manifest: identity(target), populatedRoot, resetRoot};
}
function input(root, {candidateSha = CANDIDATE_SHA, provenance = "published-release"} = {}) {
    const node = path.join(root, "node.exe"); fs.writeFileSync(node, "inert-node-runtime");
    const probes = PROBES.map(([role, name]) => { const target = path.join(root, `probe-${name}`);
        fs.writeFileSync(target, role); return {role, name, ...identity(target)}; });
    return {context: {schemaVersion: 1, repository: "i7Gamer/MySpeed", sourceSha: HARNESS_SHA,
        eventSha: HARNESS_SHA, runId: "40000000001", runAttempt: "1", nonce: NONCE,
        environment: {GITHUB_ACTIONS: "true", CI: "true", RUNNER_OS: "Linux", RUNNER_ARCH: "X64",
            RUNNER_ENVIRONMENT: "github-hosted", ImageOS: "ubuntu24", ImageVersion: "20260901.1"}},
    candidate: {provenance, sourceSha: candidateSha, artifactName: "MySpeed-windows-x64-baseline.exe",
        file: {name: "MySpeed.exe", bytes: "111524352", sha256: "8".repeat(64)}}, runtimeNode: identity(node),
    fixture: fixture(root, candidateSha), runtimeSources: WINDOWS_BASELINE_RUNTIME_BUNDLE_CONSTANTS.RUNTIME_PATHS.map(relativePath =>
        ({relativePath, source: identity(path.join(REPOSITORY, ...relativePath.split("/")))})),
    runtimeInstaller: identity(path.join(REPOSITORY,
        "scripts/qualification/windows-baseline-guest-runtime-installer.ps1")), probes,
    imageVersion: "20260901.1", manifestSha256: "9".repeat(64),
    outputRoot: path.join(root, `myspeed-stage3-${NONCE}`, "candidate")};
}

describe("CPU-floor guest preparation for a branch build", () => {
    /*
     * A branch build is produced by the commit running the harness, so the two source SHAs that the
     * published path requires to differ are necessarily one. The fixture bundle is stamped with the
     * candidate SHA and the guest materializer checks it against that same value, so a branch run
     * stamps it with the harness commit and stays self-consistent.
     */
    it("accepts the harness commit as the candidate and stamps the bundle with it", () => {
        const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cpu-floor-branch-prep-")));
        try {
            const value = input(root, {candidateSha: HARNESS_SHA, provenance: "branch-build"});
            fs.mkdirSync(path.dirname(value.outputRoot));
            const result = prepareV161PostReleaseCpuFloorGuestFiles(value,
                {expectedNodeSha256: value.runtimeNode.sha256});
            assert.equal(result.status, "prepared");
            const request = JSON.parse(fs.readFileSync(
                result.files.find(file => file.name === "request.json").path));
            assert.equal(request.candidate.sourceSha, HARNESS_SHA);
            assert.equal(request.candidate.sourceSha, request.context.sourceSha);
            const bundle = JSON.parse(fs.readFileSync(path.join(value.outputRoot, "fixture-bundle.json")));
            assert.equal(bundle.sourceSha, HARNESS_SHA);
        } finally { fs.rmSync(root, {recursive: true, force: true}); }
    });

    it("still refuses a branch candidate that is not the harness commit", () => {
        const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cpu-floor-branch-prep-")));
        try {
            const value = input(root, {candidateSha: CANDIDATE_SHA, provenance: "branch-build"});
            fs.mkdirSync(path.dirname(value.outputRoot));
            assert.throws(() => prepareV161PostReleaseCpuFloorGuestFiles(value,
                {expectedNodeSha256: value.runtimeNode.sha256}), /source roles differ/u);
        } finally { fs.rmSync(root, {recursive: true, force: true}); }
    });

    /* A provenance nobody recognises must not fall through to whichever branch checks less. */
    it("refuses a candidate whose provenance is missing or unknown", () => {
        /* A fresh root per case: the fixture builder creates its own directories. */
        const attempt = prepare => {
            const root = fs.realpathSync.native(
                fs.mkdtempSync(path.join(os.tmpdir(), "cpu-floor-branch-prep-")));
            try {
                const value = input(root, {candidateSha: HARNESS_SHA});
                prepare(value);
                assert.throws(() => prepareV161PostReleaseCpuFloorGuestFiles(value,
                    {expectedNodeSha256: value.runtimeNode.sha256}), /candidate provenance differs/u);
            } finally { fs.rmSync(root, {recursive: true, force: true}); }
        };
        for (const provenance of ["", "released", null]) {
            attempt(value => { value.candidate.provenance = provenance; });
        }
        /* Absent entirely, rather than present and wrong. */
        attempt(value => { delete value.candidate.provenance; });
    });
});

describe("post-release CPU-floor guest preparation", () => {
    it("uses the real fixture, runtime and seed builders to stage the exact inert 14-file closure", () => {
        const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cpu-floor-guest-prep-")));
        try { const value = input(root); fs.mkdirSync(path.dirname(value.outputRoot));
            const result = prepareV161PostReleaseCpuFloorGuestFiles(value,
                {expectedNodeSha256: value.runtimeNode.sha256});
            assert.equal(result.status, "prepared"); assert.equal(result.files.length, 14);
            assert.deepEqual(result.files.map(file => file.name), ["node.exe", "request.json", "execution.json",
                "fixture-bundle.json", "guest-runtime.json", "runtime-installer.ps1", ...PROBES.map(([, name]) => name)]);
            for (const record of result.files) assert.deepEqual(identity(record.path),
                {path: record.path, bytes: record.bytes, sha256: record.sha256});
            const requestRecord = result.files.find(file => file.name === "request.json");
            const request = JSON.parse(fs.readFileSync(requestRecord.path));
            assert.equal(request.candidate.path, `C:\\Windows\\Temp\\myspeed-baseline-task-${NONCE}\\MySpeed.exe`);
            assert.equal(requestRecord.sha256, hash(fs.readFileSync(requestRecord.path)));
            // The request must carry the candidate release SHA (not the harness SHA) so the guest
            // materializer validates the candidate-stamped fixture bundle against a matching identity.
            assert.equal(request.candidate.sourceSha, CANDIDATE_SHA);
            assert.notEqual(request.candidate.sourceSha, request.context.sourceSha);
            const bundle = JSON.parse(fs.readFileSync(path.join(value.outputRoot, "fixture-bundle.json")));
            assert.equal(bundle.sourceSha, request.candidate.sourceSha);
            const runtime = JSON.parse(fs.readFileSync(path.join(value.outputRoot, "guest-runtime.json")));
            assert.ok(runtime.files.some(file => file.path.endsWith("windows-baseline-guest-runner.mjs")));
        } finally { fs.rmSync(root, {recursive: true, force: true}); }
    });

    it("refuses changed identities before creating the output root", () => {
        const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cpu-floor-guest-reject-")));
        try { const value = input(root);
            assert.throws(() => prepareV161PostReleaseCpuFloorGuestFiles(value), /Node runtime digest/u);
            assert.equal(fs.existsSync(value.outputRoot), false);
            value.probes[0].sha256 = "0".repeat(64);
            assert.throws(() => prepareV161PostReleaseCpuFloorGuestFiles(value,
                {expectedNodeSha256: value.runtimeNode.sha256}), /probe avx content identity/u);
            assert.equal(fs.existsSync(value.outputRoot), false);
        } finally { fs.rmSync(root, {recursive: true, force: true}); }
    });

    for (const [label, mutate, pattern] of [
        ["collapsed sources", value => { value.context.sourceSha = CANDIDATE_SHA;
            value.context.eventSha = CANDIDATE_SHA; }, /source roles/u],
        ["malformed context", value => { value.context.nonce = "short"; }, /nonce is invalid/u],
        ["runtime order", value => { value.runtimeSources.reverse(); }, /runtime source order/u],
        ["runtime identity", value => { value.runtimeSources[0].source.sha256 = "0".repeat(64); },
            /runtime source 0 content identity/u],
        ["probe order", value => { [value.probes[0], value.probes[1]] = [value.probes[1], value.probes[0]]; },
            /probe inventory/u],
        ["probe duplicate", value => { value.probes[1] = {...value.probes[0]}; }, /probe inventory/u],
        ["installer identity", value => { value.runtimeInstaller.sha256 = "0".repeat(64); },
            /runtime installer content identity/u]
    ]) it(`refuses ${label} before writing`, () => {
        const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cpu-floor-guest-table-")));
        try { const value = input(root); fs.mkdirSync(path.dirname(value.outputRoot)); mutate(value);
            assert.throws(() => prepareV161PostReleaseCpuFloorGuestFiles(value,
                {expectedNodeSha256: value.runtimeNode.sha256}), pattern);
            assert.equal(fs.existsSync(value.outputRoot), false);
        } finally { fs.rmSync(root, {recursive: true, force: true}); }
    });

    it("refuses a pre-existing output root", () => {
        const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cpu-floor-guest-existing-")));
        try { const value = input(root); fs.mkdirSync(value.outputRoot, {recursive: true});
            assert.throws(() => prepareV161PostReleaseCpuFloorGuestFiles(value,
                {expectedNodeSha256: value.runtimeNode.sha256}), /output root is not fresh/u);
        } finally { fs.rmSync(root, {recursive: true, force: true}); }
    });

    it("refuses a linked Stage 3 parent", () => {
        const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cpu-floor-guest-link-")));
        try { const value = input(root); const target = path.join(root, "real-stage3"); fs.mkdirSync(target);
            fs.symlinkSync(target, path.dirname(value.outputRoot), process.platform === "win32" ? "junction" : "dir");
            assert.throws(() => prepareV161PostReleaseCpuFloorGuestFiles(value,
                {expectedNodeSha256: value.runtimeNode.sha256}), /output root is not fresh/u);
            assert.equal(fs.existsSync(value.outputRoot), false);
        } finally { fs.rmSync(root, {recursive: true, force: true}); }
    });
});
