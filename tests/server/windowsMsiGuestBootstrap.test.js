import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {describe, it} from "node:test";

import {renderWindowsMsiGuestBootstrap, WINDOWS_MSI_GUEST_BOOTSTRAP_CONSTANTS} from
    "../../scripts/qualification/windows-msi-guest-bootstrap.mjs";

const POWERSHELL = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
const PROCESS_TIMEOUT_MILLISECONDS = 30_000;
const powershellAvailable = process.platform === "win32";
const powershellIt = (name, body) => (powershellAvailable ? it : it.skip)(name,
    {timeout: PROCESS_TIMEOUT_MILLISECONDS}, body);
const binding = () => ({nonce: "1".repeat(32), hostNonce: "5".repeat(32), sourceSha: "2".repeat(40),
    eventSha: "6".repeat(40), runId: "123", runAttempt: "2", scenarioIndex: 3,
    scenarioId: "default-upgrade-populated", seedManifestSha256: "3".repeat(64),
    launcherRequestSha256: "4".repeat(64), rowRequestSha256: "7".repeat(64),
    executionManifestSha256: "8".repeat(64)});

describe("modern MSI guest bootstrap", () => {
    it("discovers labeled media and stages the sealed closure into nonce-owned system paths", () => {
        const bytes = renderWindowsMsiGuestBootstrap(binding());
        const source = bytes.toString("utf8");
        assert.ok(source.includes("Get-Volume -FileSystemLabel MYSPEEDSEED"));
        assert.ok(source.includes("Get-Volume -FileSystemLabel MYSPEEDOUT"));
        assert.equal(source.includes("'D:\\"), false);
        assert.equal(source.includes("'E:\\"), false);
        assert.ok(source.includes("C:\\Windows\\Temp\\myspeed-msi-input-"));
        assert.ok(source.includes("C:\\Windows\\Temp\\myspeed-msi-output-"));
        assert.match(source, /Install-MyspeedMsiGuestInputs \$boundary\.seed \$inputRoot \$outputRoot/u);
        assert.match(source, /Read-MyspeedMsiBootstrapJson \(Join-Path \$inputRoot 'launch-request\.json'\)/u);
        assert.match(source, /\$manifest\.eventSha -cne \$EXPECTED_EVENT_SHA[\s\S]*\$manifest\.hostNonce -cne \$EXPECTED_HOST_NONCE/u);
        assert.match(source, /\$manifest\.scenarioIndex -ne \$EXPECTED_SCENARIO_INDEX[\s\S]*\$manifest\.scenarioId -cne \$EXPECTED_SCENARIO_ID/u);
        assert.match(source,
            /'rowRequestSha256','executionManifestSha256'[\s\S]*\$manifest\.rowRequestSha256 -cne/u);
        assert.match(source, /\$manifest\.executionManifestSha256 -cne/u);
        assert.match(source, /\$launch\.sourceSha -cne \$EXPECTED_SOURCE_SHA[\s\S]*\$launch\.nonce -cne \$EXPECTED_NONCE/u);
        assert.match(source, /Remove-MyspeedMsiGuestInputs \$inputRoot \$installed\.names[\s\S]*Write-MyspeedMsiGuestResult/u);
        assert.match(source, /PhysicalAdapter -eq \$true[\s\S]*\$physical\.Count -ne 0/u);
        assert.match(source, /Stop-Computer -Force/u);
        assert.equal(source.replaceAll("\r\n", "").includes("\n"), false);
    });

    it("pins bounded create-new copy, result, cleanup, and failure behavior", () => {
        const source = renderWindowsMsiGuestBootstrap(binding()).toString("utf8");
        assert.match(source, /FileMode\]::CreateNew/u);
        assert.match(source, /sourceStream\.Length -ne \$Bytes[\s\S]*Get-MyspeedMsiBootstrapSha \$sourceStream/u);
        assert.match(source, /targetStream\.Length -ne \$Bytes[\s\S]*Get-MyspeedMsiBootstrapSha \$targetStream/u);
        assert.match(source, /GetFiles\(\$Root,'\*',[\s\S]*ReparsePoint[\s\S]*GetDirectories\(\$Root,'\*',[\s\S]*Delete\(\$Root,\$false\)/u);
        assert.match(source, /MAX_FAILURE_CHARACTERS=256/u);
        assert.match(source, /status='failed';nonce=\$EXPECTED_NONCE;stage='guest-bootstrap'/u);
        assert.match(source, /fixture\/populated\/data\/storage\.db-wal[\s\S]*e3b0c44298fc1c149afbf4c8996fb924/u);
        assert.deepEqual(WINDOWS_MSI_GUEST_BOOTSTRAP_CONSTANTS, {
            LAUNCH_REQUEST_NAME: "launch-request.json", MAX_INPUT_BYTES: 1_048_576,
            MAX_RESULT_BYTES: 1_048_576, MAX_SEED_FILES: 128, MAX_SEED_FILE_BYTES: 1_073_741_824,
            RESULT_NAME: "result.json", SEED_MANIFEST_NAME: "seed-manifest.json"});
    });

    it("rejects malformed bindings", () => {
        for (const mutate of [value => { value.extra = true; }, value => { value.nonce += "0"; },
            value => { value.sourceSha = "g".repeat(40); }, value => { value.eventSha += "\n"; },
            value => { value.runId = "0"; }, value => { value.runAttempt = 2; },
            value => { value.hostNonce = "f".repeat(31); }, value => { value.scenarioIndex = -1; },
            value => { value.scenarioId = "UPPER"; }, value => { value.seedManifestSha256 += "\n"; },
            value => { value.launcherRequestSha256 = 1; }, value => { value.rowRequestSha256 += "\r\n"; },
            value => { value.executionManifestSha256 = "f".repeat(63); }]) {
            const value = binding(); mutate(value);
            assert.throws(() => renderWindowsMsiGuestBootstrap(value));
        }
    });

    powershellIt("parses under the inbox Windows PowerShell grammar", () => {
        const source = renderWindowsMsiGuestBootstrap(binding()).toString("base64");
        const program = `$s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${source}'));` +
            `$tokens=$null;$errors=$null;[void][Management.Automation.Language.Parser]::ParseInput($s,[ref]$tokens,` +
            `[ref]$errors);if($errors.Count-ne 0){$errors|% Message;exit 1}`;
        const result = spawnSync(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", program],
            {encoding: "utf8", timeout: PROCESS_TIMEOUT_MILLISECONDS});
        assert.equal(result.status, 0, result.stderr || result.stdout);
    });
});

/*
 * The containment preflight boots the same sealed base through the same startup task, so it needs a
 * bootstrap - but it is not a matrix row and must not pretend to be one. There is no scenario index
 * it could honestly claim, so the stage is named instead and the seed it accepts is its own.
 */
describe("modern MSI guest bootstrap containment preflight stage", () => {
    const preflight = () => ({stage: "containment-preflight", nonce: "1".repeat(32),
        hostNonce: "5".repeat(32), sourceSha: "2".repeat(40), eventSha: "6".repeat(40), runId: "123",
        runAttempt: "2", seedManifestSha256: "3".repeat(64), launcherRequestSha256: "4".repeat(64),
        preflightRequestSha256: "7".repeat(64), envelopeSha256: "8".repeat(64)});

    /* The row stage is what fourteen rows already run, byte for byte, named or defaulted. */
    it("leaves the matrix row stage exactly as it was", () => {
        const implied = renderWindowsMsiGuestBootstrap(binding());
        const named = renderWindowsMsiGuestBootstrap({...binding(), stage: "matrix-row"});
        assert.deepEqual(named, implied);
        /*
         * Pinned against the script as it stood before the stage existed. The fourteen rows run this
         * byte for byte, so a change here is a change to their guest and has to be deliberate.
         */
        assert.equal(createHash("sha256").update(implied).digest("hex"),
            "e02279a50ccfff148ad420beb3287247ed9dc10e8755dec128c75757a18b3770");
        const source = implied.toString("utf8");
        assert.ok(source.includes("myspeed-windows-msi-lifecycle-row-seed"));
        assert.equal(source.includes("containment-preflight"), false);
        assert.equal(source.includes("EXPECTED_PREFLIGHT_REQUEST_SHA"), false);
    });

    it("binds the preflight seed instead of a scenario it has no right to name", () => {
        const source = renderWindowsMsiGuestBootstrap(preflight()).toString("utf8");
        assert.ok(source.includes("myspeed-windows-msi-containment-preflight-seed"));
        assert.ok(source.includes(`$EXPECTED_PREFLIGHT_REQUEST_SHA='${"7".repeat(64)}'`));
        assert.ok(source.includes(`$EXPECTED_ENVELOPE_SHA='${"8".repeat(64)}'`));
        /* Nothing in it claims a row, a scenario or an execution manifest. */
        for (const absent of ["EXPECTED_SCENARIO_INDEX", "EXPECTED_SCENARIO_ID", "EXPECTED_ROW_REQUEST_SHA",
            "EXPECTED_EXECUTION_MANIFEST_SHA", "myspeed-windows-msi-lifecycle-row-seed", "scenarioIndex"])
            assert.equal(source.includes(absent), false, absent);
        /* And it still reads the same launch request, from the same seed volume, into the same roots. */
        assert.ok(source.includes("Get-Volume -FileSystemLabel MYSPEEDSEED"));
        assert.ok(source.includes(`$EXPECTED_SEED_MANIFEST_SHA='${"3".repeat(64)}'`));
        assert.ok(source.includes(`$EXPECTED_LAUNCH_REQUEST_SHA='${"4".repeat(64)}'`));
    });

    it("rejects a stage that mixes the two binding sets", () => {
        for (const mutate of [value => { value.stage = "matrix-row"; },
            value => { value.stage = "other"; }, value => { value.scenarioIndex = 0; },
            value => { value.rowRequestSha256 = "9".repeat(64); },
            value => { delete value.envelopeSha256; },
            value => { value.preflightRequestSha256 = "f".repeat(63); }]) {
            const value = preflight(); mutate(value);
            assert.throws(() => renderWindowsMsiGuestBootstrap(value), JSON.stringify(value.stage));
        }
        /* A row binding that names the preflight stage is refused from the other direction too. */
        assert.throws(() => renderWindowsMsiGuestBootstrap({...binding(),
            stage: "containment-preflight"}));
    });

    powershellIt("parses the containment preflight stage as PowerShell", () => {
        const encoded = renderWindowsMsiGuestBootstrap(preflight()).toString("base64");
        const program = `$s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));`
            + `$tokens=$null;$errors=$null;[void][Management.Automation.Language.Parser]::ParseInput($s,`
            + `[ref]$tokens,[ref]$errors);if($errors.Count-ne 0){$errors|% Message;exit 1}`;
        const result = spawnSync(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
            program], {encoding: "utf8", timeout: PROCESS_TIMEOUT_MILLISECONDS});
        assert.equal(result.status, 0, result.stderr || result.stdout);
    });
});
