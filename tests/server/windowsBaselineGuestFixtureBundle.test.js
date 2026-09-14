import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {describe, it} from "node:test";

import {buildWindowsBaselineGuestFixtureBundle} from "../../scripts/qualification/windows-baseline-guest-fixture-bundle.mjs";
import {materializeWindowsBaselineGuestFixture} from "../../scripts/qualification/windows-baseline-guest-materializer.mjs";

const SOURCE_SHA = "a".repeat(40);
const NONCE = "b".repeat(32);
const EXPECTED_FILES = Object.freeze(["bin/cfspeedtest.exe", "bin/iperf3.exe", "bin/librespeed-cli.exe",
    "bin/speedtest.exe", "data/servers/librespeed.json", "data/servers/ookla.json"]);
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

const writeTree = (root, populated, includeWal = false, sharedMemory = null) => {
    for (const name of EXPECTED_FILES) {
        const target = path.join(root, ...name.split("/"));
        fs.mkdirSync(path.dirname(target), {recursive: true});
        fs.writeFileSync(target, Buffer.from(`${name}\n`), {flag: "wx"});
    }
    if (populated) fs.writeFileSync(path.join(root, "data", "storage.db"), "sqlite-fixture", {flag: "wx"});
    if (includeWal) fs.writeFileSync(path.join(root, "data", "storage.db-wal"), Buffer.alloc(0), {flag: "wx"});
    if (sharedMemory !== null)
        fs.writeFileSync(path.join(root, "data", "storage.db-shm"), sharedMemory, {flag: "wx"});
    fs.writeFileSync(path.join(root, ".myspeed-qualification.json"), "owned-marker\n", {flag: "wx"});
};

const inventory = root => Object.fromEntries(fs.readdirSync(root, {recursive: true, withFileTypes: true})
    .filter(entry => entry.isFile()).map(entry => {
        const target = path.join(entry.parentPath, entry.name);
        return [path.relative(root, target).replaceAll(path.sep, "/"), sha256(fs.readFileSync(target))];
    }).sort(([left], [right]) => left.localeCompare(right)));

const createTransport = (root, includeWal = false, sharedMemory = null) => {
    const populatedRoot = path.join(root, "transport-populated");
    const resetRoot = path.join(root, "transport-reset");
    fs.mkdirSync(populatedRoot); fs.mkdirSync(resetRoot);
    writeTree(populatedRoot, true, includeWal, sharedMemory); writeTree(resetRoot, false);
    const manifest = {schemaVersion: 1, source: {commit: SOURCE_SHA, bunLockSha256: "1".repeat(64),
        packageSha256: "2".repeat(64)}, populated: {root: "C:\\producer\\populated", nonce: "3".repeat(48),
        markerSha256: sha256(fs.readFileSync(path.join(populatedRoot, ".myspeed-qualification.json"))),
        databaseSha256: sha256(fs.readFileSync(path.join(populatedRoot,
            "data", "storage.db"))), filesSha256: inventory(populatedRoot)},
    reset: {root: "C:\\producer\\reset", nonce: "5".repeat(48),
        markerSha256: sha256(fs.readFileSync(path.join(resetRoot, ".myspeed-qualification.json"))),
        filesSha256: inventory(resetRoot)}, expected: {ping: "123.456", resultId: "qualification-seed-row",
        passwordValueSha256: "7".repeat(64)}};
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
    const manifestPath = path.join(root, "transport.json");
    fs.writeFileSync(manifestPath, manifestBytes, {flag: "wx"});
    return {manifestPath, manifestBytes, populatedRoot, resetRoot};
};

describe("Windows baseline guest fixture bundle builder", () => {
    it("converts the exact retained handoff into a bundle accepted by the real guest materializer", async () => {
        const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-baseline-fixture-bundle-")));
        try {
            const transport = createTransport(root, true);
            const bytes = buildWindowsBaselineGuestFixtureBundle({sourceSha: SOURCE_SHA,
                manifest: {path: transport.manifestPath, bytes: String(transport.manifestBytes.length),
                    sha256: sha256(transport.manifestBytes)}, populatedRoot: transport.populatedRoot,
                resetRoot: transport.resetRoot});
            const bundlePath = path.join(root, "fixture-bundle.json");
            const candidatePath = path.join(root, "candidate.exe");
            const controllerPath = path.join(root, "controller.ps1");
            fs.writeFileSync(bundlePath, bytes, {flag: "wx"});
            fs.writeFileSync(candidatePath, "candidate", {flag: "wx"});
            fs.writeFileSync(controllerPath, "controller", {flag: "wx"});
            const taskRoot = path.join(root, "guest-task");
            const identity = target => { const value = fs.readFileSync(target); return {path: target,
                bytes: String(value.length), sha256: sha256(value)}; };
            const request = {context: {sourceSha: SOURCE_SHA, nonce: NONCE}, candidate: identity(candidatePath),
                paths: {taskRoot, populatedWork: path.join(taskRoot, "populated"),
                    resetWork: path.join(taskRoot, "reset")}, scenarios: ["populated-first-boot",
                    "populated-restart", "fresh-no-config-reset"].map((scenario, index) => ({scenario,
                    port: 43_101 + index}))};
            request.candidate.path = path.join(taskRoot, "MySpeed.exe");
            const execution = {candidateSource: identity(candidatePath), cleanStopController: identity(controllerPath),
                fixtureBundle: identity(bundlePath)};
            const observed = await materializeWindowsBaselineGuestFixture({request, execution,
                dependencies: {checkPopulatedDatabase: async () => ({verified: true})}});
            assert.deepEqual(observed.initialDatabase, {verified: true});
            assert.equal(observed.expected.ping, "123.456");
        } finally { fs.rmSync(root, {recursive: true, force: true}); }
    });

    it("rejects changed, linked, extra, missing, and source-mismatched transport files", () => {
        for (const mutation of [
            value => fs.appendFileSync(path.join(value.populatedRoot, "bin", "iperf3.exe"), "drift"),
            value => fs.writeFileSync(path.join(value.resetRoot, "extra.txt"), "extra"),
            value => fs.rmSync(path.join(value.resetRoot, "bin", "iperf3.exe")),
            value => { const manifest = JSON.parse(value.manifestBytes); manifest.source.commit = "f".repeat(40);
                const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`); fs.writeFileSync(value.manifestPath, bytes);
                value.manifestBytes = bytes; },
            value => { const target = path.join(value.resetRoot, "bin", "iperf3.exe"); const linked = `${target}.linked`;
                fs.linkSync(target, linked); }
        ]) {
            const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),
                "myspeed-baseline-fixture-reject-")));
            try {
                const transport = createTransport(root); mutation(transport);
                assert.throws(() => buildWindowsBaselineGuestFixtureBundle({sourceSha: SOURCE_SHA,
                    manifest: {path: transport.manifestPath, bytes: String(transport.manifestBytes.length),
                        sha256: sha256(transport.manifestBytes)}, populatedRoot: transport.populatedRoot,
                    resetRoot: transport.resetRoot}));
            } finally { fs.rmSync(root, {recursive: true, force: true}); }
        }
    });

    it("accepts the producer's optional exact empty SQLite WAL but rejects non-empty WAL bytes", () => {
        const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-baseline-wal-")));
        try {
            const transport = createTransport(root, true);
            assert.doesNotThrow(() => buildWindowsBaselineGuestFixtureBundle({sourceSha: SOURCE_SHA,
                manifest: {path: transport.manifestPath, bytes: String(transport.manifestBytes.length),
                    sha256: sha256(transport.manifestBytes)}, populatedRoot: transport.populatedRoot,
                resetRoot: transport.resetRoot}));
            fs.writeFileSync(path.join(transport.populatedRoot, "data", "storage.db-wal"), "not-empty");
            assert.throws(() => buildWindowsBaselineGuestFixtureBundle({sourceSha: SOURCE_SHA,
                manifest: {path: transport.manifestPath, bytes: String(transport.manifestBytes.length),
                    sha256: sha256(transport.manifestBytes)}, populatedRoot: transport.populatedRoot,
                resetRoot: transport.resetRoot}), /WAL|identity|inventory/u);
        } finally { fs.rmSync(root, {recursive: true, force: true}); }
    });

    it("validates the candidate's transient SQLite shared-memory sidecar without copying it into the guest bundle", () => {
        const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-baseline-shm-")));
        try {
            const sharedMemory = Buffer.from("candidate-sqlite-shared-memory");
            const transport = createTransport(root, false, sharedMemory);
            const bytes = buildWindowsBaselineGuestFixtureBundle({sourceSha: SOURCE_SHA,
                manifest: {path: transport.manifestPath, bytes: String(transport.manifestBytes.length),
                    sha256: sha256(transport.manifestBytes)}, populatedRoot: transport.populatedRoot,
                resetRoot: transport.resetRoot});
            const bundle = JSON.parse(bytes);
            assert.equal(bundle.populated.files.some(file => file.path === "data/storage.db-shm"), false);
            fs.writeFileSync(path.join(transport.populatedRoot, "data", "storage.db-shm"), "drift");
            assert.throws(() => buildWindowsBaselineGuestFixtureBundle({sourceSha: SOURCE_SHA,
                manifest: {path: transport.manifestPath, bytes: String(transport.manifestBytes.length),
                    sha256: sha256(transport.manifestBytes)}, populatedRoot: transport.populatedRoot,
                resetRoot: transport.resetRoot}), /identity/u);
        } finally { fs.rmSync(root, {recursive: true, force: true}); }
    });
});
