import assert from "node:assert/strict";
import fs from "node:fs";
import {describe, it} from "node:test";

import {createWindowsHostedMsiPrepareOperations, prepareV161PostReleaseMsiOnWindows,
    validateV161PostReleaseMsiWindowsPreparation} from
    "../../scripts/release/post-release-msi-hosted-prepare.mjs";

const HASH = "a".repeat(64);
const GUIDS = ["{AAAAAAAA-1111-1111-1111-111111111111}",
    "{BBBBBBBB-2222-2222-2222-222222222222}"];
const plan = () => ({files: [
    {bindingId: "candidate-default", role: "msi", destinationPath: "C:\\work\\candidate.msi",
        source: {url: "https://example.invalid/candidate", bytes: 12, sha256: HASH}},
    {bindingId: "node-22.19.0-windows-x64", role: "runtime-archive",
        destinationPath: "C:\\work\\node.zip",
        source: {url: "https://example.invalid/node", bytes: 13, sha256: HASH}}
], runtime: {archiveBindingId: "node-22.19.0-windows-x64", format: "zip",
    member: "node-v22.19.0-win-x64/node.exe", destinationPath: "C:\\work\\node\\node.exe",
    sha256: HASH}, inspection: {bindings: ["candidate-default"],
    properties: ["ProductCode", "ProductVersion", "UpgradeCode"]},
preparation: {repository: "i7Gamer/MySpeed", harnessSourceSha: "b".repeat(40),
    candidateSourceSha: "c".repeat(40), runId: "1", runAttempt: "1", imageVersion: "image",
    nonce: "d".repeat(32)}});

describe("hosted Windows post-release MSI preparation", () => {
    it("downloads the closed plan, extracts Node, and inspects MSI properties read-only", async () => {
        const calls = [];
        const operations = {
            initialize: async root => { calls.push(["initialize", root]); },
            download: async file => { calls.push(["download", file.bindingId]); },
            observe: async file => ({bindingId: file.bindingId, role: file.role,
                path: file.destinationPath, bytes: file.source.bytes, sha256: file.source.sha256}),
            extractZipMember: async value => { calls.push(["extract", value.member]); },
            observeRuntime: async runtime => ({path: runtime.destinationPath, bytes: 99,
                sha256: runtime.sha256}),
            inspectMsi: async file => { calls.push(["inspect", file.bindingId]); return {
                ProductCode: GUIDS[0], ProductVersion: "1.6.1.45", UpgradeCode: GUIDS[1]}; }
        };
        const value = await prepareV161PostReleaseMsiOnWindows(plan(), operations);
        assert.deepEqual(calls, [["initialize", "C:\\work"], ["download", "candidate-default"],
            ["download", "node-22.19.0-windows-x64"],
            ["extract", "node-v22.19.0-win-x64/node.exe"], ["inspect", "candidate-default"]]);
        assert.deepEqual(value.inspections, [{bindingId: "candidate-default",
            local: {path: "C:\\work\\candidate.msi", bytes: 12, sha256: HASH},
            properties: {ProductCode: GUIDS[0], ProductVersion: "1.6.1.45", UpgradeCode: GUIDS[1]}}]);
        assert.equal(value.runtime.local.bytes, 99);
        assert.equal(value.installerExecution, false);
        assert.deepEqual(value.preparation, plan().preparation);
        assert.equal(validateV161PostReleaseMsiWindowsPreparation(
            JSON.parse(JSON.stringify(value)), plan()), true);
    });

    it("rejects changed downloads and malformed MSI metadata", async () => {
        const make = () => ({initialize: async () => {}, download: async () => {},
            observe: async file => ({bindingId: file.bindingId, role: file.role,
                path: file.destinationPath, bytes: file.source.bytes, sha256: file.source.sha256}),
            extractZipMember: async () => {}, observeRuntime: async runtime =>
                ({path: runtime.destinationPath, bytes: 99, sha256: runtime.sha256}),
            inspectMsi: async () => ({ProductCode: GUIDS[0], ProductVersion: "1.6.1.45",
                UpgradeCode: GUIDS[1]})});
        for (const mutate of [
            ops => { ops.observe = async file => ({bindingId: file.bindingId, role: file.role,
                path: file.destinationPath, bytes: file.source.bytes + 1, sha256: file.source.sha256}); },
            ops => { ops.inspectMsi = async () => ({ProductCode: GUIDS[0].toLowerCase(),
                ProductVersion: "1.6.1.45", UpgradeCode: GUIDS[1]}); },
            ops => { ops.inspectMsi = async () => ({ProductCode: GUIDS[0], ProductVersion: "1.6.1.45\n",
                UpgradeCode: GUIDS[1]}); }
        ]) {
            const operations = make(); mutate(operations);
            await assert.rejects(prepareV161PostReleaseMsiOnWindows(plan(), operations));
        }
    });

    it("exposes an explicit hosted PowerShell adapter without running it during construction", async () => {
        const calls = [];
        const spawn = (executable, args, options) => {
            calls.push([executable, args, options]);
            const input = JSON.parse(args.at(-1));
            if (args.includes("Observe")) return {status: 0, stdout: JSON.stringify({path: input.path,
                bytes: input.expectedBytes, sha256: input.expectedSha256}), stderr: ""};
            return {status: 0, stdout: "{}", stderr: ""};
        };
        const operations = createWindowsHostedMsiPrepareOperations({
            powershellPath: "C:\\hostedtoolcache\\pwsh.exe",
            scriptPath: "C:\\repo\\scripts\\release\\post-release-msi-hosted-prepare.ps1", spawn});
        assert.equal(calls.length, 0);
        await operations.download(plan().files[0]);
        const observed = await operations.observe(plan().files[0]);
        assert.equal(observed.bindingId, "candidate-default");
        assert.equal(observed.bytes, 12);
        assert.deepEqual(calls[0][1].slice(0, 7), ["-NoLogo", "-NoProfile", "-NonInteractive",
            "-ExecutionPolicy", "Bypass", "-File",
            "C:\\repo\\scripts\\release\\post-release-msi-hosted-prepare.ps1"]);
        assert.ok(calls[0][1].includes("Download"));
        assert.equal(JSON.parse(calls[0][1].at(-1)).maximumBytes, 12);
        assert.equal(calls[0][2].timeout, 600000);
        const source = fs.readFileSync("scripts/release/post-release-msi-hosted-prepare.ps1", "utf8");
        assert.match(source, /ResponseHeadersRead/);
        assert.match(source, /\[void\]\$response\.EnsureSuccessStatusCode\(\)/);
        assert.match(source, /if \(\$created -and \(Test-Path/);
        assert.match(source, /\$total \+= \$count/);
        assert.doesNotMatch(source, /\.CopyTo\(/);
        assert.match(source, /OpenDatabase\(\$msi, 0\)/);
        assert.match(source, /FileMode\]::CreateNew/);
        assert.doesNotMatch(source, /msiexec|MsiInstallProduct|Win32_Product/i);
        assert.throws(() => createWindowsHostedMsiPrepareOperations({
            powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            scriptPath: "C:\\repo\\prepare.ps1", spawn}), /pwsh/i);
    });
});
