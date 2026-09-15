import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {describe, it} from "node:test";

import {buildWindowsBaselineGuestRuntimeBundle,
    WINDOWS_BASELINE_RUNTIME_BUNDLE_CONSTANTS} from "../../scripts/qualification/windows-baseline-guest-runtime-bundle.mjs";

const SCRIPT = path.resolve("scripts/qualification/windows-baseline-guest-runtime-installer.ps1");
const SOURCE_SHA = "1".repeat(40);
const NONCE = "2".repeat(32);
const PROCESS_TIMEOUT_MILLISECONDS = 30_000;
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const powershell = `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
const hasPowerShell = process.platform === "win32" && fs.existsSync(powershell);
const powershellIt = hasPowerShell ? it : it.skip;

function fixture() {
    const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-runtime-install-")));
    const sourceRoot = path.join(parent, "source"); fs.mkdirSync(sourceRoot);
    const files = WINDOWS_BASELINE_RUNTIME_BUNDLE_CONSTANTS.RUNTIME_PATHS.map((relativePath, index) => {
        const target = path.join(sourceRoot, `source-${index}`); const bytes = Buffer.from(`${relativePath}\n`);
        fs.writeFileSync(target, bytes, {flag: "wx"});
        return {relativePath, source: {path: target, bytes: String(bytes.length), sha256: sha256(bytes)}};
    });
    const bundle = buildWindowsBaselineGuestRuntimeBundle({sourceSha: SOURCE_SHA, nonce: NONCE, files});
    const bundlePath = path.join(parent, "runtime.json"); fs.writeFileSync(bundlePath, bundle, {flag: "wx"});
    return {parent, bundle, bundlePath, root: path.join(parent, `myspeed-baseline-runtime-${NONCE}`)};
}

function invoke(value, mode) {
    return spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", SCRIPT, "-Mode", mode, "-BundlePath", value.bundlePath, "-ExpectedBundleSha256",
        sha256(value.bundle), "-ExpectedSourceSha", SOURCE_SHA, "-ExpectedNonce", NONCE,
        "-DestinationRoot", value.root, "-AllowedParent", value.parent],
    {encoding: "utf8", timeout: PROCESS_TIMEOUT_MILLISECONDS, windowsHide: true});
}

describe("Windows baseline guest runtime installer", () => {
    powershellIt("materializes only the exact sealed repo-relative runtime tree create-new and removes its owned tree", () => {
        const value = fixture();
        try {
            const installed = invoke(value, "TestInstall");
            assert.equal(installed.status, 0, installed.stderr);
            const receipt = JSON.parse(installed.stdout);
            assert.deepEqual(receipt, {installed: true, root: value.root,
                files: WINDOWS_BASELINE_RUNTIME_BUNDLE_CONSTANTS.RUNTIME_PATHS.length});
            for (const relativePath of WINDOWS_BASELINE_RUNTIME_BUNDLE_CONSTANTS.RUNTIME_PATHS)
                assert.equal(fs.readFileSync(path.join(value.root, ...relativePath.split("/")), "utf8"),
                    `${relativePath}\n`);
            const removed = invoke(value, "TestCleanup");
            assert.equal(removed.status, 0, removed.stderr);
            assert.deepEqual(JSON.parse(removed.stdout), {cleanupProven: true});
            assert.equal(fs.existsSync(value.root), false);
        } finally { fs.rmSync(value.parent, {recursive: true, force: true}); }
    });

    powershellIt("rejects a stale destination and altered bundle bytes before writing runtime files", () => {
        for (const mutate of [
            value => fs.mkdirSync(value.root),
            value => fs.appendFileSync(value.bundlePath, "drift")
        ]) {
            const value = fixture();
            try {
                mutate(value); const observed = invoke(value, "TestInstall");
                assert.notEqual(observed.status, 0);
                if (fs.existsSync(value.root))
                    assert.equal(fs.readdirSync(value.root).length, 0);
            } finally { fs.rmSync(value.parent, {recursive: true, force: true}); }
        }
    });

    powershellIt("refuses cleanup when the exact ownership marker drifts", () => {
        const value = fixture();
        try {
            assert.equal(invoke(value, "TestInstall").status, 0);
            fs.writeFileSync(path.join(value.root, ".myspeed-runtime-owned.json"), "{}\n");
            const observed = invoke(value, "TestCleanup");
            assert.notEqual(observed.status, 0);
            assert.equal(fs.existsSync(value.root), true);
        } finally { fs.rmSync(value.parent, {recursive: true, force: true}); }
    });
});
