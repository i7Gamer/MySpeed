import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {describe, it} from "node:test";

import {prepareV161PostReleaseBaselineInputs, POST_RELEASE_BASELINE_INPUT_CONSTANTS,
    validateV161PostReleaseBaselineInputPreparation} from
    "../../scripts/release/post-release-msi-baseline-input-preparation.mjs";
import {WINDOWS_BASELINE_RUNTIME_BUNDLE_CONSTANTS} from
    "../../scripts/qualification/windows-baseline-guest-runtime-bundle.mjs";

const HARNESS_SHA = "a".repeat(40);
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const write = (root, name, bytes) => { const target = path.join(root, ...name.split("/"));
    fs.mkdirSync(path.dirname(target), {recursive: true}); fs.writeFileSync(target, bytes, {flag: "wx"}); };
const inventory = root => Object.fromEntries(fs.readdirSync(root, {recursive: true, withFileTypes: true})
    .filter(entry => entry.isFile()).map(entry => { const target = path.join(entry.parentPath, entry.name);
        return [path.relative(root, target).replaceAll(path.sep, "/"), sha256(fs.readFileSync(target))]; }));

function fixture(root, includeWal, includeSharedMemory = false) {
    const populatedRoot = path.join(root, "fixture-source", "populated");
    const resetRoot = path.join(root, "fixture-source", "reset");
    fs.mkdirSync(populatedRoot, {recursive: true}); fs.mkdirSync(resetRoot, {recursive: true});
    for (const name of POST_RELEASE_BASELINE_INPUT_CONSTANTS.FIXTURE_COMMON) {
        write(populatedRoot, name, Buffer.from(`populated:${name}`));
        write(resetRoot, name, Buffer.from(`reset:${name}`));
    }
    write(populatedRoot, "data/storage.db", Buffer.from("sqlite"));
    if (includeWal) write(populatedRoot, POST_RELEASE_BASELINE_INPUT_CONSTANTS.OPTIONAL_WAL, Buffer.alloc(0));
    if (includeSharedMemory) write(populatedRoot, "data/storage.db-shm", Buffer.from("sqlite-shared-memory"));
    write(populatedRoot, ".myspeed-qualification.json", Buffer.from("populated-marker"));
    write(resetRoot, ".myspeed-qualification.json", Buffer.from("reset-marker"));
    const manifest = {schemaVersion: 1, source: {commit: POST_RELEASE_BASELINE_INPUT_CONSTANTS.CANDIDATE_SOURCE_SHA,
        bunLockSha256: "1".repeat(64), packageSha256: "2".repeat(64)},
    populated: {root: "C:\\candidate\\populated", nonce: "3".repeat(48),
        markerSha256: inventory(populatedRoot)[".myspeed-qualification.json"],
        databaseSha256: inventory(populatedRoot)["data/storage.db"], filesSha256: inventory(populatedRoot)},
    reset: {root: "C:\\candidate\\reset", nonce: "4".repeat(48),
        markerSha256: inventory(resetRoot)[".myspeed-qualification.json"], filesSha256: inventory(resetRoot)},
    expected: {ping: "123.456", resultId: "qualification-seed-row", passwordValueSha256: "5".repeat(64)}};
    const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
    const manifestPath = path.join(root, "fixture-source", "transport.json");
    fs.writeFileSync(manifestPath, bytes, {flag: "wx"});
    return {manifestPath, populatedRoot, resetRoot};
}

function harness(root) {
    const harnessRoot = path.join(root, "harness");
    for (const name of [...WINDOWS_BASELINE_RUNTIME_BUNDLE_CONSTANTS.RUNTIME_PATHS,
        "scripts/qualification/windows-baseline-guest-runtime-installer.ps1"])
        write(harnessRoot, name, Buffer.from(`harness:${name}`));
    return harnessRoot;
}

describe("post-release MSI baseline input preparation", () => {
    it("retains the exact candidate fixture and harness runtime as a closed 31/32-file subtree", () => {
        for (const includeWal of [false, true]) {
            const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-baseline-input-")));
            try {
                const outputRoot = path.join(root, "output");
                const result = prepareV161PostReleaseBaselineInputs({candidateFixture: fixture(root, includeWal),
                    harnessRoot: harness(root), harnessSourceSha: HARNESS_SHA,
                    manifestPath: fs.realpathSync.native(
                        "tests/fixtures/post-release-native-v1.6.1/qualification-manifest.json"), outputRoot});
                assert.equal(result.files.length, includeWal ? 32 : 31);
                assert.equal(result.files[0].relativePath, "qualification-manifest.json");
                assert.deepEqual(result.files.map(file => file.bindingId),
                    result.files.map(file => `baseline:${file.relativePath}`));
                assert.equal(result.files.filter(file => file.sourceRole === "candidate").length,
                    includeWal ? 18 : 17);
                assert.equal(result.files.filter(file => file.sourceRole === "harness").length, 14);
                assert.equal(result.files.some(file => file.relativePath.includes("ost-cli")), false);
                const wal = result.files.find(file => file.relativePath.endsWith("storage.db-wal"));
                assert.equal(includeWal ? wal.sha256 : wal, includeWal
                    ? POST_RELEASE_BASELINE_INPUT_CONSTANTS.EMPTY_SHA256 : undefined);
                for (const file of result.files) assert.equal(sha256(fs.readFileSync(path.join(outputRoot,
                    ...file.relativePath.split("/")))), file.sha256);
                const validated = validateV161PostReleaseBaselineInputPreparation(
                    JSON.parse(JSON.stringify(result)));
                assert.deepEqual(validated, result);
                assert.equal(Object.isFrozen(result), true); assert.equal(Object.isFrozen(result.files), true);
                assert.equal(Object.isFrozen(result.files[0]), true);
                assert.equal(Object.isFrozen(validated), true); assert.equal(Object.isFrozen(validated.files), true);
                assert.equal(Object.isFrozen(validated.files[0]), true);
            } finally { fs.rmSync(root, {recursive: true, force: true}); }
        }
    });

    it("strictly validates JSON-roundtripped preparation identities and the optional empty WAL", () => {
        const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-baseline-validate-")));
        try {
            const result = prepareV161PostReleaseBaselineInputs({candidateFixture: fixture(root, true),
                harnessRoot: harness(root), harnessSourceSha: HARNESS_SHA,
                manifestPath: fs.realpathSync.native(
                    "tests/fixtures/post-release-native-v1.6.1/qualification-manifest.json"),
                outputRoot: path.join(root, "output")});
            const mutate = change => { const value = JSON.parse(JSON.stringify(result)); change(value);
                assert.throws(() => validateV161PostReleaseBaselineInputPreparation(value)); };
            mutate(value => value.files.reverse());
            mutate(value => { value.files[1].sourceRole = "harness"; });
            mutate(value => { value.files[1].relativePath = "../transport.json"; });
            mutate(value => { value.files[2].bytes = 0; });
            mutate(value => { value.files.find(file => file.relativePath.endsWith("storage.db-wal")).bytes = "0"; });
            mutate(value => { value.files.find(file => file.relativePath.endsWith("storage.db-wal")).sha256
                = "1".repeat(64); });
            mutate(value => { value.harnessSourceSha = value.candidateSourceSha; });
            mutate(value => { value.unexpected = true; });
        } finally { fs.rmSync(root, {recursive: true, force: true}); }
    });

    it("retains a candidate-declared transient SQLite shared-memory sidecar for downstream transport reconstruction", () => {
        const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-baseline-shm-input-")));
        try {
            const outputRoot = path.join(root, "output");
            const result = prepareV161PostReleaseBaselineInputs({candidateFixture: fixture(root, false, true),
                harnessRoot: harness(root), harnessSourceSha: HARNESS_SHA,
                manifestPath: fs.realpathSync.native(
                    "tests/fixtures/post-release-native-v1.6.1/qualification-manifest.json"), outputRoot});
            const sharedMemory = result.files.find(file => file.relativePath === `fixture/populated/${
                POST_RELEASE_BASELINE_INPUT_CONSTANTS.TRANSIENT_SHARED_MEMORY}`);
            assert.ok(sharedMemory);
            const staged = fs.readFileSync(path.join(outputRoot, "fixture", "populated", "data",
                "storage.db-shm"));
            assert.equal(sha256(staged), sharedMemory.sha256);
            assert.equal(staged.toString("utf8"), "sqlite-shared-memory");
        } finally { fs.rmSync(root, {recursive: true, force: true}); }
    });

    it("validates every source before creating the output subtree", () => {
        const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-baseline-input-reject-")));
        try {
            const candidateFixture = fixture(root, false); const harnessRoot = harness(root);
            fs.rmSync(path.join(harnessRoot,
                ...WINDOWS_BASELINE_RUNTIME_BUNDLE_CONSTANTS.RUNTIME_PATHS.at(-1).split("/")));
            const outputRoot = path.join(root, "output");
            assert.throws(() => prepareV161PostReleaseBaselineInputs({candidateFixture, harnessRoot,
                harnessSourceSha: HARNESS_SHA, manifestPath: fs.realpathSync.native(
                    "tests/fixtures/post-release-native-v1.6.1/qualification-manifest.json"), outputRoot}));
            assert.equal(fs.existsSync(outputRoot), false);
        } finally { fs.rmSync(root, {recursive: true, force: true}); }
    });

    it("rejects an oversized ordinary source before reading its contents", () => {
        const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-baseline-oversize-")));
        const oversized = path.join(root, "oversized-manifest.json");
        fs.writeFileSync(oversized, "x", {flag: "wx"});
        fs.truncateSync(oversized, POST_RELEASE_BASELINE_INPUT_CONSTANTS.MAX_FILE_BYTES + 1);
        const originalRead = fs.readSync; let reads = 0;
        fs.readSync = (...args) => { reads += 1; return originalRead(...args); };
        try {
            assert.throws(() => prepareV161PostReleaseBaselineInputs({candidateFixture: {},
                harnessRoot: root, harnessSourceSha: HARNESS_SHA, manifestPath: oversized,
                outputRoot: path.join(root, "output")}), /identity/u);
            assert.equal(reads, 0); assert.equal(fs.existsSync(path.join(root, "output")), false);
        } finally { fs.readSync = originalRead; fs.rmSync(root, {recursive: true, force: true}); }
    });

    it("rejects fixture bytes changed after transport validation but before copying", () => {
        const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-baseline-race-")));
        const candidateFixture = fixture(root, false); const target = path.join(candidateFixture.populatedRoot,
            "bin", "iperf3.exe");
        const originalOpen = fs.openSync; let targetOpens = 0;
        fs.openSync = (value, ...args) => { if (value === target && ++targetOpens === 2) fs.appendFileSync(target, "drift");
            return originalOpen(value, ...args); };
        try {
            const outputRoot = path.join(root, "output");
            assert.throws(() => prepareV161PostReleaseBaselineInputs({candidateFixture,
                harnessRoot: harness(root), harnessSourceSha: HARNESS_SHA, manifestPath: fs.realpathSync.native(
                    "tests/fixtures/post-release-native-v1.6.1/qualification-manifest.json"), outputRoot}),
            /fixture.*identity/u);
            assert.equal(fs.existsSync(outputRoot), false);
        } finally { fs.openSync = originalOpen; fs.rmSync(root, {recursive: true, force: true}); }
    });
});
