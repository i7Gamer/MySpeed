import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {describe, it} from "node:test";

import {cleanupWindowsBaselineGuestFixture,
    materializeWindowsBaselineGuestFixture} from "../../scripts/qualification/windows-baseline-guest-materializer.mjs";

const SHA = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const SOURCE_SHA = "1".repeat(40);
const NONCE = "3".repeat(32);
const EXPECTED_FILES = ["bin/cfspeedtest.exe", "bin/iperf3.exe", "bin/librespeed-cli.exe",
    "bin/speedtest.exe", "data/servers/librespeed.json", "data/servers/ookla.json"];
const record = (name, contents) => {
    const bytes = Buffer.from(contents);
    return {path: name, bytes: String(bytes.length), sha256: SHA(bytes), bytesBase64: bytes.toString("base64")};
};

function fixture() {
    const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-baseline-materializer-")));
    const root = path.join(parent, `myspeed-baseline-${NONCE}`);
    const seed = path.join(parent, "seed"); fs.mkdirSync(seed);
    const candidateBytes = Buffer.from("candidate\n");
    const controllerBytes = Buffer.from("controller\n");
    fs.writeFileSync(path.join(seed, "candidate.exe"), candidateBytes, {flag: "wx"});
    fs.writeFileSync(path.join(seed, "clean.ps1"), controllerBytes, {flag: "wx"});
    const common = EXPECTED_FILES.map(name => record(name, `${name}\n`));
    const database = record("data/storage.db", "sqlite fixture\n");
    const bundle = {schemaVersion: 1, kind: "myspeed-windows-baseline-fixture-bundle", sourceSha: SOURCE_SHA,
        expected: {ping: "123.456", resultId: "qualification-seed-row", passwordValueSha256: "9".repeat(64)},
        populated: {files: [...common, database].sort((left, right) => left.path.localeCompare(right.path))},
        reset: {files: structuredClone(common).sort((left, right) => left.path.localeCompare(right.path))}};
    const bundleBytes = Buffer.from(`${JSON.stringify(bundle)}\n`);
    fs.writeFileSync(path.join(seed, "fixture.json"), bundleBytes, {flag: "wx"});
    const request = {context: {sourceSha: SOURCE_SHA, nonce: NONCE}, candidate: {
        path: path.join(root, "MySpeed.exe"), bytes: String(candidateBytes.length), sha256: SHA(candidateBytes)},
    paths: {taskRoot: root, populatedWork: path.join(root, "populated"), resetWork: path.join(root, "reset")},
    scenarios: ["populated-first-boot", "populated-restart", "fresh-no-config-reset"].map((scenario, index) =>
        ({scenario, port: 41_001 + index}))};
    const execution = {candidateSource: {path: path.join(seed, "candidate.exe"), bytes: String(candidateBytes.length),
        sha256: SHA(candidateBytes)}, cleanStopController: {path: path.join(seed, "clean.ps1"),
        bytes: String(controllerBytes.length), sha256: SHA(controllerBytes)}, fixtureBundle: {
        path: path.join(seed, "fixture.json"), bytes: String(bundleBytes.length), sha256: SHA(bundleBytes)}};
    return {parent, root, request, execution, bundle};
}

describe("Windows baseline guest fixture materializer", () => {
    it("copies only the sealed candidate, controller, and exact two fixture inventories create-new", async () => {
        const value = fixture();
        try {
            const observed = [];
            const result = await materializeWindowsBaselineGuestFixture({request: value.request,
                execution: value.execution, dependencies: {checkPopulatedDatabase: async (file, expected) => {
                    observed.push([file, expected]); return expected;
                }}});
            assert.deepEqual(result, {expected: value.bundle.expected, initialDatabase: value.bundle.expected});
            assert.equal(fs.readFileSync(value.request.candidate.path, "utf8"), "candidate\n");
            assert.equal(fs.readFileSync(path.join(value.root, "windows-clean-stop-controller.ps1"), "utf8"),
                "controller\n");
            assert.deepEqual(observed, [[path.join(value.request.paths.populatedWork, "data", "storage.db"),
                value.bundle.expected]]);
            for (const scenario of value.request.scenarios)
                assert.equal(fs.statSync(path.join(value.root, `session-${scenario.scenario}`)).isDirectory(), true);
            assert.deepEqual(cleanupWindowsBaselineGuestFixture({request: value.request, sessions: []}),
                {cleanupProven: true});
            assert.equal(fs.existsSync(value.root), false);
        } finally { fs.rmSync(value.parent, {recursive: true, force: true}); }
    });

    it("rejects traversal, stale roots, altered bytes, and an incomplete reset inventory before success", async () => {
        for (const mutate of [
            value => { value.bundle.populated.files[0].path = "../escape"; },
            value => { fs.mkdirSync(value.root); },
            value => { value.bundle.populated.files[0].bytesBase64 = Buffer.from("altered").toString("base64"); },
            value => { value.bundle.reset.files.pop(); }
        ]) {
            const value = fixture();
            try {
                mutate(value);
                if (!fs.existsSync(value.root)) {
                    const bytes = Buffer.from(`${JSON.stringify(value.bundle)}\n`);
                    fs.writeFileSync(value.execution.fixtureBundle.path, bytes);
                    value.execution.fixtureBundle.bytes = String(bytes.length);
                    value.execution.fixtureBundle.sha256 = SHA(bytes);
                }
                await assert.rejects(materializeWindowsBaselineGuestFixture({request: value.request,
                    execution: value.execution, dependencies: {checkPopulatedDatabase: async () => ({})}}));
            } finally { fs.rmSync(value.parent, {recursive: true, force: true}); }
        }
    });

    it("refuses cleanup for uncertain controllers or a drifted ownership marker", async () => {
        for (const mutate of [
            _value => [{startAttempted: true, started: null}],
            _value => [{startAttempted: true, started: {child: {exitCode: 0}}}],
            value => {
                fs.writeFileSync(path.join(value.root, ".myspeed-baseline-owned.json"), "{}\n");
                return [];
            }
        ]) {
            const value = fixture();
            try {
                await materializeWindowsBaselineGuestFixture({request: value.request, execution: value.execution,
                    dependencies: {checkPopulatedDatabase: async (_file, expected) => expected}});
                const sessions = mutate(value);
                assert.deepEqual(cleanupWindowsBaselineGuestFixture({request: value.request, sessions}),
                    {cleanupProven: false});
                assert.equal(fs.existsSync(value.root), true);
            } finally { fs.rmSync(value.parent, {recursive: true, force: true}); }
        }
    });
});
