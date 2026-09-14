import assert from "node:assert/strict";
import {execFileSync, spawnSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {describe, it} from "node:test";

import {buildV161PostReleaseMsiFixturePlan, createWindowsHostedMsiFixtureOperations,
    prepareV161PostReleaseMsiFixturesOnWindows,
    validateV161PostReleaseMsiFixturePreparation} from
    "../../scripts/release/post-release-msi-fixture-preparation.mjs";
import {buildV161PostReleaseMsiAcquisitionPlan} from
    "../../scripts/release/post-release-msi-acquisition.mjs";
import {createV161PostReleaseMsiEnvelope} from
    "../../scripts/release/post-release-msi-envelope.mjs";
import {createPostReleaseV161Target} from "../helpers/post-release-v161-target-fixture.mjs";

const HASH = value => value.repeat(64);
const POWERSHELL = process.platform === "win32" ? "pwsh.exe" : "pwsh";
const HAS_POWERSHELL = spawnSync(POWERSHELL,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"],
    {timeout: 10_000, windowsHide: true}).status === 0;
const UPGRADE_CODE = "{A1B2C3D4-5E6F-7890-ABCD-EF1234567890}";
const harness = () => ({repository: "i7Gamer/MySpeed", sourceSha: createPostReleaseV161Target().harness.sourceSha,
    eventSha: createPostReleaseV161Target().harness.sourceSha, runId: "34853700510", runAttempt: "1",
    imageVersion: "20260907.1", nonce: "3".repeat(32)});
const acquisitionPlan = () => buildV161PostReleaseMsiAcquisitionPlan(
    createV161PostReleaseMsiEnvelope(createPostReleaseV161Target(), harness()), harness(), "C:\\prepare");
const PRODUCT_CODES = ["{11111111-1111-4111-8111-111111111111}",
    "{22222222-2222-4222-8222-222222222222}", "{33333333-3333-4333-8333-333333333333}",
    "{44444444-4444-4444-8444-444444444444}", "{55555555-5555-4555-8555-555555555555}"];
const windowsPreparation = plan => ({schemaVersion: 1,
    kind: "myspeed-v1.6.1-post-release-msi-windows-preparation", status: "prepared",
    authority: "windows-hosted-preparation-only", installerExecution: false,
    preparation: structuredClone(plan.preparation), files: plan.files.map(file => ({bindingId: file.bindingId,
        role: file.role, path: file.destinationPath, bytes: file.source.bytes, sha256: file.source.sha256})),
    runtime: {archiveBindingId: plan.runtime.archiveBindingId, local: {path: plan.runtime.destinationPath,
        bytes: 85_268_464, sha256: plan.runtime.sha256}},
    inspections: plan.inspection.bindings.map((bindingId, index) => { const file = plan.files.find(item =>
        item.bindingId === bindingId && item.role === "msi"); return {bindingId,
        local: {path: file.destinationPath, bytes: file.source.bytes, sha256: file.source.sha256},
        properties: {ProductCode: PRODUCT_CODES[index], ProductVersion: index < 2 ? "1.6.1.0" : "1.6.0.0",
            UpgradeCode: UPGRADE_CODE}}; })});
const fixturePlan = () => { const plan = acquisitionPlan(); return buildV161PostReleaseMsiFixturePlan({
    acquisitionPlan: plan, windowsPreparation: windowsPreparation(plan), outputRoot: "C:\\prepare\\fixtures"}); };
const payload = () => ({exe: {bytes: 111_524_352,
    sha256: "bc4eea0a06c890eb5c0da0472a1705b3219aac3f5000383d9847120b5681d154",
    fileVersion: "1.6.1.45", productVersion: "1.6.1.45"},
    configuration: {bytes: 450, sha256: HASH("c")}, wrapper: {bytes: 12_000_000, sha256: HASH("d")},
inventory: [
    {path: "File/MySpeed.exe", bytes: 111_524_352,
        sha256: "bc4eea0a06c890eb5c0da0472a1705b3219aac3f5000383d9847120b5681d154"},
    {path: "File/MySpeedService.exe", bytes: 12_000_000, sha256: HASH("d")},
    {path: "File/MySpeedService.xml", bytes: 450, sha256: HASH("c")},
    {path: "File/WinSW-LICENSE.txt", bytes: 1_000, sha256: HASH("7")}
]});
const predecessorPayload = () => { const value = payload(); value.exe = {bytes: 100_000_000, sha256: HASH("6"),
    fileVersion: "1.6.0.44", productVersion: "1.6.0.44"};
    value.configuration = {bytes: 451, sha256: HASH("4")};
    value.wrapper = {bytes: 11_000_000, sha256: HASH("5")};
    value.inventory[0] = {path: "File/MySpeed.exe", bytes: value.exe.bytes, sha256: value.exe.sha256};
    value.inventory[1] = {path: "File/MySpeedService.exe", bytes: value.wrapper.bytes,
        sha256: value.wrapper.sha256};
    value.inventory[2] = {path: "File/MySpeedService.xml", bytes: value.configuration.bytes,
        sha256: value.configuration.sha256};
    value.inventory = value.inventory.filter(item => item.path !== "File/WinSW-LICENSE.txt");
    return value; };
const baselinePayload = () => { const value = payload(); value.configuration = {bytes: 451, sha256: HASH("8")};
    value.wrapper = {bytes: 12_000_001, sha256: HASH("9")};
    value.inventory[1] = {path: "File/MySpeedService.exe", ...value.wrapper};
    value.inventory[2] = {path: "File/MySpeedService.xml", ...value.configuration}; return value; };

describe("hosted post-release MSI fixture preparation", () => {
    it("builds two deterministic lower-version source clones and retains inspected payload identities", async () => {
        const plan = fixturePlan();
        assert.deepEqual(plan.fixtures.map(item => [item.bindingId, item.productVersion]), [
            ["lower-stamp-fixture", "1.6.0.0"], ["safe-rollback-predecessor", "1.5.0.0"]]);
        assert.equal(new Set(plan.fixtures.map(item => item.productCode)).size, 2);
        assert.equal(plan.fixtures.every(item => item.upgradeCode === UPGRADE_CODE), true);
        assert.deepEqual(plan, fixturePlan());

        const calls = [];
        const result = await prepareV161PostReleaseMsiFixturesOnWindows(plan, {
            initialize: async root => { calls.push(["initialize", root]); },
            inspectPayload: async input => { calls.push(["inspect", input.bindingId]);
                return input.bindingId === "candidate-default" ? payload()
                    : input.bindingId === "candidate-baseline" ? baselinePayload() : predecessorPayload(); },
            buildClone: async input => { calls.push(["build", input.bindingId]); return {
                bindingId: input.bindingId, path: input.destinationPath, bytes: 40_000_000,
                sha256: input.bindingId === "lower-stamp-fixture" ? HASH("e") : HASH("f"),
                properties: {ProductCode: input.productCode, ProductVersion: input.productVersion,
                    UpgradeCode: input.upgradeCode, PackageCode: input.packageCode},
                payload: structuredClone(input.expectedPayload)}; }
        });
        assert.deepEqual(calls, [["initialize", "C:\\prepare\\fixtures"], ["inspect", "candidate-default"],
            ["inspect", "candidate-baseline"],
            ["inspect", "authentic-1.6.0-default-msi"],
            ["build", "lower-stamp-fixture"],
            ["build", "safe-rollback-predecessor"]]);
        assert.equal(result.installerExecution, false);
        assert.equal(result.fixtures[0].configurationSha256, HASH("4"));
        assert.equal(result.fixtures[1].configurationSha256, HASH("4"));
        assert.equal(result.fixtures[1].serviceWrapperSha256, HASH("5"));
        assert.equal(result.fixtures[0].packageCode, plan.fixtures[0].packageCode);
        assert.equal(result.candidatePayload.inventory.length, 4);
        assert.deepEqual(result.candidateBaselinePayload, baselinePayload());
        assert.equal(result.predecessorPayload.inventory.length, 3);
        assert.deepEqual(result.fixtures[1].payloadInventory, predecessorPayload().inventory);
        assert.equal(result.fixtures[0].sourceBindingId, "authentic-1.6.0-default-msi");
        assert.notEqual(result.fixtures[0].exeSha256, result.candidatePayload.exe.sha256);
        assert.equal(result.fixtures[0].exeFileVersion, "1.6.0.44");
        assert.notEqual(result.fixtures[1].exeSha256, result.candidatePayload.exe.sha256);
        assert.equal(validateV161PostReleaseMsiFixturePreparation(JSON.parse(JSON.stringify(result)), plan), true);
        assert.equal(Object.isFrozen(result.fixtures[0]), true);
    });

    it("rejects unbound versions, upgrade codes, product identities, and changed embedded payloads", async () => {
        for (const mutate of [
            value => { value.windowsPreparation.inspections[0].properties.ProductVersion = "1.6.0.0"; },
            value => { value.windowsPreparation.inspections[0].properties.UpgradeCode =
                "{22222222-2222-4222-8222-222222222222}"; },
            value => { value.outputRoot = "relative\\fixtures"; }
        ]) {
            const fixedPlan = acquisitionPlan();
            const input = {acquisitionPlan: fixedPlan, windowsPreparation: windowsPreparation(fixedPlan),
                outputRoot: "C:\\prepare\\fixtures"};
            mutate(input);
            assert.throws(() => buildV161PostReleaseMsiFixturePlan(input));
        }
        const plan = fixturePlan();
        const base = {initialize: async () => {}, inspectPayload: async input =>
            input.bindingId === "candidate-default" ? payload()
                : input.bindingId === "candidate-baseline" ? baselinePayload() : predecessorPayload(),
        buildClone: async input => ({
            bindingId: input.bindingId, path: input.destinationPath, bytes: 10, sha256: HASH("e"),
            properties: {ProductCode: input.productCode, ProductVersion: input.productVersion,
                UpgradeCode: input.upgradeCode, PackageCode: input.packageCode},
            payload: structuredClone(input.expectedPayload)})};
        await assert.rejects(prepareV161PostReleaseMsiFixturesOnWindows(plan, {...base,
            inspectPayload: async () => { const value = payload(); value.exe.sha256 = HASH("8");
                value.inventory[0].sha256 = HASH("8"); return value; }}),
        /published executable/u);
        await assert.rejects(prepareV161PostReleaseMsiFixturesOnWindows(plan, {...base,
            inspectPayload: async input => { if (input.bindingId !== "candidate-baseline")
                return base.inspectPayload(input); const value = baselinePayload(); value.exe.sha256 = HASH("0");
                value.inventory[0].sha256 = HASH("0"); return value; }
        }), /baseline.*published executable/u);
        for (const alter of [
            value => { value.properties.ProductCode = "{33333333-3333-4333-8333-333333333333}"; },
            value => { value.properties.ProductVersion = "1.6.1.0"; },
            value => { value.properties.UpgradeCode = "{22222222-2222-4222-8222-222222222222}"; },
            value => { value.properties.PackageCode = "{22222222-2222-4222-8222-222222222222}"; },
            value => { value.payload.exe.sha256 = HASH("9"); },
            value => { value.payload.inventory.pop(); },
            value => { value.payload.inventory.reverse(); }
        ]) await assert.rejects(prepareV161PostReleaseMsiFixturesOnWindows(plan, {...base,
            buildClone: async input => { const value = await base.buildClone(input); alter(value); return value; }}));
    });

    it("requires explicit injected hosted operations and creates no local native default", async () => {
        const plan = fixturePlan();
        await assert.rejects(prepareV161PostReleaseMsiFixturesOnWindows(plan, {}), /operation/u);
        await assert.rejects(prepareV161PostReleaseMsiFixturesOnWindows(structuredClone(plan), {
            initialize: async () => {}, inspectPayload: async () => payload(), buildClone: async () => {}}),
        /authenticated builder/u);
        const calls = [];
        const operations = createWindowsHostedMsiFixtureOperations({
            powershellPath: "C:\\hostedtoolcache\\pwsh.exe",
            scriptPath: "C:\\repo\\scripts\\release\\post-release-msi-fixture-preparation.ps1",
            inspectionRoot: "C:\\prepare\\inspection",
            wix: {darkPath: "C:\\wix\\dark.exe", candlePath: "C:\\wix\\candle.exe",
                lightPath: "C:\\wix\\light.exe"},
            spawn: (file, args, options) => { calls.push({file, args, options}); return {status: 0,
                stdout: JSON.stringify(payload()), stderr: ""}; }
        });
        assert.equal(calls.length, 0);
        await operations.inspectPayload(plan.candidate);
        assert.equal(calls[0].file, "C:\\hostedtoolcache\\pwsh.exe");
        assert.equal(calls[0].args.includes("InspectPayload"), true);
        assert.equal(calls[0].options.timeout, 600000);
        assert.throws(() => createWindowsHostedMsiFixtureOperations({
            powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            scriptPath: "C:\\repo\\fixture.ps1", inspectionRoot: "C:\\inspect",
            wix: {darkPath: "C:\\wix\\dark.exe", candlePath: "C:\\wix\\candle.exe",
                lightPath: "C:\\wix\\light.exe"}}), /pwsh/u);
        const source = fs.readFileSync("scripts/release/post-release-msi-fixture-preparation.ps1", "utf8");
        assert.match(source, /OpenDatabase\(\$path, 0\)/u);
        assert.match(source, /\[void\]\$view\.Execute\(\)/u);
        assert.match(source, /'WiX decompiler'/u);
        assert.match(source, /'WiX compiler'/u);
        assert.match(source, /'WiX linker'/u);
        assert.match(source, /SetAttribute\('Id',\[string\]\$request\.productCode\)/u);
        assert.match(source, /SetAttribute\('Id',\[string\]\$request\.packageCode\)/u);
        assert.match(source, /\[Array\]::Sort\(\$relativePaths,\[StringComparer\]::Ordinal\)/u);
        assert.match(source, /SelectNodes\('\/\/w:File',\$manager\)/u);
        assert.match(source, /Assert-Descendant \$fileRoot \(\[string\]\$node\.Source\)/u);
        assert.match(source, /\$logicalPath='File\/'\+\$name/u);
        assert.doesNotMatch(source, /\$items \| Where-Object \{\$_.Name -ceq/u);
        assert.doesNotMatch(source, /Sort-Object/u);
        assert.match(source, /@Arguments \*> \$null/u);
        assert.doesNotMatch(source, /msiexec|MsiInstallProduct|Win32_Product/iu);
    });

    it("maps WiX dark File-ID exports through decompiled logical names", {skip: !HAS_POWERSHELL}, () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-msi-dark-map-"));
        try {
            const payloadRoot = path.join(root, "payload"), files = path.join(payloadRoot, "File");
            fs.mkdirSync(files, {recursive: true});
            for (const id of ["MySpeedExe", "ServiceWrapperExe", "ServiceConfig", "WinSWLicense"])
                fs.writeFileSync(path.join(files, id), id);
            fs.mkdirSync(path.join(payloadRoot, "Binary"));
            fs.writeFileSync(path.join(payloadRoot, "Binary", "WixCA"), "extension stream");
            const xmlPath = path.join(root, "decompiled.wxs");
            const script = path.resolve("scripts/release/post-release-msi-fixture-preparation.ps1");
            const quote = value => value.replaceAll("'", "''");
            const definitions = [["MySpeedExe", "MySpeed.exe"],
                ["ServiceWrapperExe", "MySpeedService.exe"], ["ServiceConfig", "MySpeedService.xml"],
                ["WinSWLicense", "WinSW-LICENSE.txt"]];
            const writeXml = values => fs.writeFileSync(xmlPath,
                `<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi"><Fragment>${values.map(
                    ([id, name, sourcePath = path.join(files, id)]) =>
                        `<File Id="${id}" Name="${name}" Source="${sourcePath}" />`).join("")}</Fragment></Wix>`);
            const runMap = () => execFileSync(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive",
                "-Command", `. '${quote(script)}' -Mode Library; `
                    + `$value=Get-MsiPayloadSourceMap '${quote(xmlPath)}' '${quote(payloadRoot)}'; `
                    + "$value.inventory | ConvertTo-Json -Compress"],
            {encoding: "utf8", timeout: 10_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]});
            writeXml(definitions);
            const inventory = JSON.parse(runMap());
            assert.deepEqual(inventory.map(item => item.path), ["File/MySpeed.exe", "File/MySpeedService.exe",
                "File/MySpeedService.xml", "File/WinSW-LICENSE.txt"]);
            writeXml(definitions.map((entry, index) => index === 0 ? [...entry, path.join(root, "outside")] : entry));
            fs.writeFileSync(path.join(root, "outside"), "outside");
            assert.throws(runMap, /Command failed/u);
            writeXml(definitions.map((entry, index) => index === 1 ? [...entry, path.join(files, "MySpeedExe")] : entry));
            assert.throws(runMap, /Command failed/u);
            writeXml(definitions); fs.writeFileSync(path.join(files, "Unexpected"), "extra");
            assert.throws(runMap, /Command failed/u);
        } finally { fs.rmSync(root, {recursive: true, force: false}); }
    });
});
