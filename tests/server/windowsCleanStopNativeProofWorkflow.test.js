import {describe, it} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOW = path.join(ROOT, ".github", "workflows", "windows-clean-stop-native-proof.yml");
const COORDINATOR = path.join(ROOT, "scripts", "qualification", "windows-clean-stop-native-proof.ps1");

describe("Windows clean-stop native proof workflow", () => {
    it("is manual, candidate-neutral, and split across fresh producer and executor jobs", () => {
        const source = fs.readFileSync(WORKFLOW, "utf8");
        assert.match(source, /^on:\s*\r?\n\s+workflow_dispatch:/mu);
        assert.doesNotMatch(source, /^\s+(push|schedule):/mu);
        assert.match(source, /pull_request:\s*\r?\n\s+branches:\s*\[development\]/u);
        assert.match(source, /github\.event_name == 'workflow_dispatch'.*github\.event\.pull_request\.head\.repo\.full_name == github\.repository/u);
        assert.match(source, /permissions:\s*\r?\n\s+contents: read/u);
        assert.equal((source.match(/runs-on: windows-2025/gu) || []).length, 2);
        assert.match(source, /actions\/checkout@[0-9a-f]{40} # v7/u);
        assert.match(source, /persist-credentials: false/u);
        assert.match(source, /ref: \$\{\{ github\.event_name == 'pull_request' && github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/u);
        assert.match(source, /SOURCE_SHA: \$\{\{ github\.event_name == 'pull_request' && github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/u);
        const execution = source.slice(source.indexOf("  execute:"));
        assert.doesNotMatch(execution, /actions\/checkout/u);
        assert.match(execution, /actions\/download-artifact@[0-9a-f]{40} # v8/u);
        assert.match(source, /qualifying=\$false/u);
        assert.doesNotMatch(source, /MySpeed\.exe|msiexec|Disable-NetAdapter|Invoke-WebRequest|curl\.exe/iu);
        assert.ok(execution.indexOf("Validate downloaded transport before script execution")
            < execution.indexOf("Execute inert four-case observation"));
        assert.match(execution, /Downloaded reviewed helper hash differs/u);
    });

    it("seals the exact seven-source transport and reuses reviewed native helpers", () => {
        const source = fs.readFileSync(WORKFLOW, "utf8");
        for (const name of ["windows-clean-stop-native-proof.yml", "windows-clean-stop-controller.ps1",
            "windows-clean-stop-native-proof.ps1", "media-job-launcher.ps1",
            "windows-cpu-tool-child.ps1", "windows-cpu-file-identity.ps1",
            "windows-clean-stop-fixture.cs", "closure.json"])
            assert.ok(source.includes(name), name);
        assert.match(source, /scripts[\\/]qualification[\\/]windows-cpu-tool-child\.ps1/u);
        assert.match(source, /scripts[\\/]qualification[\\/]windows-cpu-file-identity\.ps1/u);
        assert.match(source, /scripts[\\/]qualification[\\/]windows-clean-stop-controller\.ps1/u);
        assert.match(source, /scripts[\\/]qualification[\\/]windows-clean-stop-native-proof\.ps1/u);
        assert.match(source, /scripts[\\/]qualification[\\/]media-job-launcher\.ps1/u);
        assert.match(source, /\.github[\\/]workflows[\\/]windows-clean-stop-native-proof\.yml/u);
        assert.doesNotMatch(source, /'\.qa-release[\\/]/u);
        assert.match(source, /myspeed-cpu-readiness-/u);
        const coordinator = fs.readFileSync(COORDINATOR, "utf8");
        assert.match(coordinator, /compile-clean-stop-fixture\.request\.json/u);
        assert.match(coordinator, /InvokeHostedToolChild/u);
        assert.match(coordinator, /Invoke-OwnedJobProcess/u);
        assert.match(source, /artifact_id: \$\{\{ steps\.upload\.outputs\.artifact-id \}\}/u);
        assert.match(source, /artifact-ids: \$\{\{ needs\.producer\.outputs\.artifact_id \}\}/u);
    });

    it("invokes the guarded proof and retains bounded evidence even on failure", () => {
        const workflow = fs.readFileSync(WORKFLOW, "utf8");
        const coordinator = fs.readFileSync(COORDINATOR, "utf8");
        assert.match(workflow, /-Mode InvokeHostedProof/u);
        for (const input of ["ExpectedRunId", "ExpectedRunAttempt", "ExpectedEventSha", "ExpectedSourceSha",
            "ExpectedImageVersion", "Nonce", "ClosureRoot", "ExpectedClosureSha256", "EvidencePath"])
            assert.ok(workflow.includes(`-${input}`), input);
        assert.match(workflow, /if: always\(\)/u);
        assert.match(workflow, /retention-days: 7/u);
        assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40} # v7/u);
        assert.match(coordinator, /InvokeHostedProof/u);
        assert.match(coordinator, /New-MyspeedNativeFileIdentityOperations/u);
        assert.match(coordinator, /Read-MyspeedVerifiedFileBytes/u);
        assert.match(coordinator, /Assert-MyspeedNoFileIdentityCollisions/u);
        assert.match(coordinator, /Invoke-ObservedOwnedJobProcess/u);
        assert.match(coordinator, /myspeed-windows-clean-stop-evidence-inventory/u);
        assert.match(workflow, /ValidateInventory/u);
        assert.match(workflow, /Inventory path binding differs/u);
        assert.doesNotMatch(workflow, /myspeed-clean-stop-\$\{\{ needs\.producer\.outputs\.nonce \}\}\*/u);
        const confirmation = workflow.slice(workflow.indexOf("      - name: Confirm nonqualifying observation"),
            workflow.indexOf("      - name: Stage exact bounded diagnostic evidence"));
        assert.match(confirmation, /\$inbox = Join-Path \$env:SystemRoot/u);
        assert.match(confirmation, /\$matrixJson \| & \$inbox/u);
        assert.doesNotMatch(confirmation, /-InputJson \$matrixJson/u);
        const staging = workflow.slice(workflow.indexOf("      - name: Stage exact bounded diagnostic evidence"),
            workflow.indexOf("      - name: Upload bounded diagnostic evidence"));
        assert.match(staging, /\n\s+id: stage\r?\n/u);
        assert.match(staging, /\$inventoryJson \| & \$inbox/u);
        assert.doesNotMatch(staging, /-InputJson \$inventoryJson/u);
        assert.match(staging, /Evidence inventory validation failed with exit/u);
        assert.match(staging, /safe=true.*GITHUB_OUTPUT/su);
        const upload = workflow.slice(workflow.indexOf("      - name: Upload bounded diagnostic evidence"));
        assert.match(upload, /if: \$\{\{ always\(\) && steps\.stage\.outputs\.safe == 'true' \}\}/u);
    });
});
