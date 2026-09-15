import {describe, it} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";

const SCRIPT = path.resolve("scripts/qualification/windows-msi-guest-containment.ps1");
const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const HASH = "a".repeat(64);
const NONCE = "b".repeat(32);
const powershellAvailable = process.platform === "win32";
const powershellIt = (name, body) => (powershellAvailable ? it : it.skip)(name, body);

const request = () => ({schemaVersion: 1, kind: "myspeed-windows-msi-guest-containment-request",
    productCode: "{00000000-0000-0000-0000-000000000001}", msiPath: "E:\\seed\\old.msi",
    msiSha256: HASH, evidenceRoot: "F:\\output", nonce: NONCE, expectedSerial: NONCE,
    helperPath: "E:\\seed\\containment.ps1", helperSha256: HASH,
    debugger: "\"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -File containment.ps1"});

const invoke = args => spawnSync(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive",
    "-ExecutionPolicy", "Bypass", "-File", SCRIPT, ...args], {encoding: "utf8"});

describe("Windows MSI guest authentic-old containment helper", () => {
    powershellIt("exposes only the exact guest containment modes and remains nonqualifying", () => {
        const result = invoke(["-Mode", "GetContract"]);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), {schemaVersion: 1,
            kind: "myspeed-windows-msi-guest-containment-contract", qualifying: false,
            modes: ["Install", "Remove", "ContainmentStub"], imageName: "MySpeed.exe",
            serviceName: "MySpeed", interceptExitCode: 113, releaseGatesCleared: []});
    });

    powershellIt("validates exact injected request and install/remove state without native calls", () => {
        for (const mode of ["Install", "Remove"]) {
            const value = {mode, request: request(), launches: [], registryExact: mode === "Install",
                productInstalled: true};
            const result = invoke(["-Mode", "TestInjected", "-InputJson", JSON.stringify(value)]);
            assert.equal(result.status, 0, result.stderr);
            assert.deepEqual(JSON.parse(result.stdout), {accepted: true, mode, nonce: NONCE, launchCount: 0});
        }
    });

    powershellIt("rejects mixed request schema, missing registry ownership, and malformed launch arrays", () => {
        const mutations = [
            value => { value.request.pnpDeviceId = "stale"; },
            value => { value.registryExact = false; },
            value => { value.launches = {}; }
        ];
        for (const mutate of mutations) {
            const value = {mode: "Install", request: request(), launches: [], registryExact: true,
                productInstalled: true};
            mutate(value);
            const result = invoke(["-Mode", "TestInjected", "-InputJson", JSON.stringify(value)]);
            assert.equal(result.error, undefined);
            assert.notEqual(result.status, 0);
        }
    });

    it("keeps native effects behind the exact guest guard and binds registry ownership cleanup", () => {
        const source = fs.readFileSync(SCRIPT, "utf8");
        assert.match(source, /requires the exact NIC-free QEMU guest/u);
        assert.match(source, /RegistryView\]::Registry64/u);
        assert.match(source, /Image File Execution Options\\MySpeed\.exe/u);
        assert.match(source, /Containment IFEO collision/u);
        assert.match(source, /FileMode\]::CreateNew/u);
        assert.match(source, /DeleteSubKeyTree\(\$script:IfeoSubkey,\$false\)/u);
        assert.match(source, /MsiQueryProductState/u);
        assert.match(source, /Get-CimInstance Win32_Process -Filter "Name='MySpeed\.exe'"/u);
        assert.match(source, /\/i \$fullMsi \/qn \/norestart REBOOT=ReallySuppress/u);
        assert.doesNotMatch(source, /Win32_Product/u);
    });

    /*
     * The inventory digest is the only thing binding a retained launch history to the history the
     * helper actually saw, so its canonical form is part of the contract and is pinned here.
     *
     * Piping the list into ConvertTo-Json unrolls it: an empty listing produced no output at all and
     * threw on the way into GetBytes, and a single record serialized as a bare object rather than a
     * one-element list. A cleanly contained guest has an empty history, which was exactly the case
     * that could never complete. The form is taken over the array itself instead.
     */
    powershellIt("hashes the launch inventory over the ordered tuple list at every size", () => {
        const tuple = (suffix, bytes, digest) =>
            ({name: `containment-launch-${NONCE}-${suffix}.json`, bytes, sha256: digest});
        const cases = [[], [tuple("1", 101, "b".repeat(64))],
            [tuple("1", 101, "b".repeat(64)), tuple("2", 102, "c".repeat(64))]];
        for (const items of cases) {
            const result = invoke(["-Mode", "TestInventory", "-InputJson", JSON.stringify({items})]);
            assert.equal(result.status, 0, result.stderr);
            const canonical = JSON.stringify(items);
            assert.deepEqual(JSON.parse(result.stdout), {accepted: true, count: items.length, canonical,
                sha256: createHash("sha256").update(Buffer.from(canonical, "utf8")).digest("hex")},
            canonical);
        }
    });
});
