import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {describe, it} from "node:test";

import {
    buildWindowsBaselineGuestRuntimeBundle,
    validateWindowsBaselineGuestRuntimeBundle
} from "../../scripts/qualification/windows-baseline-guest-runtime-bundle.mjs";

const SOURCE_SHA = "1".repeat(40);
const NONCE = "2".repeat(32);
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const RUNTIME_PATHS = Object.freeze([
    "scripts/qualification/windows-baseline-guest-executor.mjs",
    "scripts/qualification/windows-baseline-guest-runner.mjs",
    "scripts/qualification/windows-baseline-guest-operations.mjs",
    "scripts/qualification/windows-baseline-guest-runtime.mjs",
    "scripts/qualification/windows-baseline-guest-materializer.mjs",
    "scripts/qualification/windows-baseline-guest-candidate-wrapper.ps1",
    "scripts/qualification/windows-native-candidate-controller.ps1",
    "scripts/qualification/windows-clean-stop-controller.ps1",
    "scripts/qualification/check-artifact.mjs",
    "scripts/qualification/safety.mjs",
    "scripts/qualification/fixture.mjs",
    "scripts/qualification/sqlite-check.mjs"
]);

function fixture() {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-baseline-runtime-")));
    const files = RUNTIME_PATHS.map((relativePath, index) => {
        const target = path.join(root, `source-${index}`);
        const bytes = Buffer.from(`${relativePath}\n`);
        fs.writeFileSync(target, bytes, {flag: "wx"});
        return {relativePath, source: {path: target, bytes: String(bytes.length), sha256: sha256(bytes)}};
    });
    return {root, files};
}

describe("Windows baseline guest runtime bundle", () => {
    it("builds and replays the exact fixed runtime tree from retained source handles", () => {
        const value = fixture();
        try {
            const bytes = buildWindowsBaselineGuestRuntimeBundle({sourceSha: SOURCE_SHA, nonce: NONCE,
                files: value.files});
            const observed = validateWindowsBaselineGuestRuntimeBundle(bytes, {sourceSha: SOURCE_SHA, nonce: NONCE});
            assert.deepEqual(observed.files.map(file => file.path), RUNTIME_PATHS);
            assert.deepEqual(observed.files.map(file => Buffer.from(file.bytesBase64, "base64").toString()),
                RUNTIME_PATHS.map(relativePath => `${relativePath}\n`));
            assert.equal(observed.totalBytes, String(RUNTIME_PATHS.reduce((sum, item) => sum + item.length + 1, 0)));
        } finally { fs.rmSync(value.root, {recursive: true, force: true}); }
    });

    it("rejects missing, reordered, aliased, traversing, and altered runtime entries", () => {
        const value = fixture();
        try {
            const original = JSON.parse(buildWindowsBaselineGuestRuntimeBundle({sourceSha: SOURCE_SHA, nonce: NONCE,
                files: value.files}).toString("utf8"));
            const mutations = [
                record => { record.files.pop(); },
                record => { [record.files[0], record.files[1]] = [record.files[1], record.files[0]]; },
                record => { record.files[0].path = record.files[0].path.toUpperCase(); },
                record => { record.files[0].path = "../escape.mjs"; },
                record => { record.files[0].bytesBase64 = Buffer.from("altered").toString("base64"); },
                record => { record.totalBytes = "1"; }
            ];
            for (const mutate of mutations) {
                const changed = structuredClone(original); mutate(changed);
                assert.throws(() => validateWindowsBaselineGuestRuntimeBundle(
                    Buffer.from(`${JSON.stringify(changed)}\n`), {sourceSha: SOURCE_SHA, nonce: NONCE}));
            }
        } finally { fs.rmSync(value.root, {recursive: true, force: true}); }
    });

    it("rejects physical source drift and an unexpected source inventory before producing bytes", () => {
        for (const mutate of [
            value => { value.files[0].relativePath = "unexpected.mjs"; },
            value => { fs.appendFileSync(value.files[0].source.path, "drift"); },
            value => { value.files[0].source.bytes = "0"; }
        ]) {
            const value = fixture();
            try {
                mutate(value);
                assert.throws(() => buildWindowsBaselineGuestRuntimeBundle({sourceSha: SOURCE_SHA, nonce: NONCE,
                    files: value.files}));
            } finally { fs.rmSync(value.root, {recursive: true, force: true}); }
        }
    });
});

