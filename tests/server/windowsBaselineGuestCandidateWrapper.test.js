import assert from "node:assert/strict";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {describe, it} from "node:test";
import {fileURLToPath} from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(ROOT, "../../scripts/qualification/windows-baseline-guest-candidate-wrapper.ps1");
const POWERSHELL = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
const TEST_TIMEOUT_MILLISECONDS = 20_000;
const hasPowerShell = process.platform === "win32" && fs.existsSync(POWERSHELL);
const powershellIt = hasPowerShell ? it : it.skip;
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const guard = () => ({platform: "Win32NT", is64BitProcess: true, psMajor: 5, psMinor: 1,
    profile: "baseline-cpu", seed: {count: 1, driveType: "CD-ROM", label: "MYSPEEDSEED"},
    output: {count: 1, driveType: "Fixed", label: "MYSPEEDOUT"}, network: {hardwareNics: 0,
        enabledNonLoopbackInterfaces: 0, nonLoopbackRoutes: 0}});

const invoke = value => {
    const result = childProcess.spawnSync(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", SCRIPT,
        "-Mode", "TestGuard", "-InputJson", JSON.stringify(value)],
    {encoding: "utf8", timeout: TEST_TIMEOUT_MILLISECONDS});
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return JSON.parse(result.stdout);
};

describe("Windows baseline guest candidate wrapper", () => {
    it("contains a guest-only guard before request I/O and reuses the shared candidate lifecycle", () => {
        const source = fs.readFileSync(SCRIPT, "utf8");
        assert.match(source, /Assert-MyspeedBaselineGuestGuard \(Get-MyspeedBaselineGuestActualGuard\)[\s\S]*Read-MyspeedBaselineGuestJson/u);
        assert.match(source, /Assert-MyspeedCandidateRequest/u);
        assert.match(source, /New-MyspeedCandidateNativeOperations/u);
        assert.match(source, /Invoke-MyspeedCandidateLifecycleCore/u);
        assert.match(source, /Get-MyspeedCleanNativeSource/u);
        assert.match(source,
            /function Get-MyspeedBaselineGuestCandidateIdentity[\s\S]*Assert-MyspeedBaselineGuestGuard \(Get-MyspeedBaselineGuestActualGuard\)[\s\S]*Read-MyspeedBaselineGuestBytes[\s\S]*Get-MyspeedCandidateFileIdentity/u);
        assert.doesNotMatch(source, /GITHUB_ACTIONS|RUNNER_ENVIRONMENT|InvokeHostedCandidate/u);
    });

    powershellIt("accepts only an exact console-free NIC-free baseline guest observation", () => {
        assert.equal(invoke(guard()).accepted, true);
        for (const mutate of [value => { value.profile = "modern-msi"; },
            value => { value.network.hardwareNics = 1; }, value => { value.seed.driveType = "Fixed"; },
            value => { value.output.count = 2; }, value => { value.psMinor = 0; }]) {
            const value = guard(); mutate(value);
            assert.throws(() => invoke(value));
        }
    });

    powershellIt("requires the task-root controller copy to be byte-identical to the trusted seed controller", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-baseline-controller-"));
        try {
            const retained = path.join(root, "retained.ps1");
            const trusted = path.join(root, "trusted.ps1");
            const bytes = Buffer.from("Write-Output 'trusted'\r\n");
            fs.writeFileSync(retained, bytes); fs.writeFileSync(trusted, bytes);
            const argv = ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", SCRIPT, "-Mode",
                "TestControllerBinding", "-RequestPath", retained, "-ExpectedRequestSha256", digest(bytes),
                "-CleanStopControllerPath", trusted, "-ExpectedCleanStopControllerSha256", digest(bytes)];
            const accepted = childProcess.spawnSync(POWERSHELL, argv, {encoding: "utf8",
                timeout: TEST_TIMEOUT_MILLISECONDS});
            assert.equal(accepted.status, 0, accepted.stderr);
            fs.writeFileSync(retained, "Write-Output 'drifted'\r\n");
            const rejected = childProcess.spawnSync(POWERSHELL, argv, {encoding: "utf8",
                timeout: TEST_TIMEOUT_MILLISECONDS});
            assert.notEqual(rejected.status, 0);
        } finally { fs.rmSync(root, {recursive: true, force: true}); }
    });
});

