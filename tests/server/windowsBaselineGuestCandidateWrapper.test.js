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
        assert.match(source,
            /function Get-MyspeedBaselineOwnedListener[\s\S]*Get-Process -Id[\s\S]*Get-NetTCPConnection -State Listen[\s\S]*'ObserveOwnedListener' \{Get-MyspeedBaselineOwnedListener/u);
        assert.doesNotMatch(source, /GITHUB_ACTIONS|RUNNER_ENVIRONMENT|InvokeHostedCandidate/u);
    });

    it("detaches the wrapper's own console before the shared lifecycle asserts console-free", () => {
        const source = fs.readFileSync(SCRIPT, "utf8");
        // The guest wrapper is spawned windowsHide (CREATE_NO_WINDOW) with no console to inherit, so Windows
        // hands it a fresh hidden console it solely owns. The shared lifecycle core opens with a bare
        // AssertConsoleFree, so the wrapper must run the same observe -> FreeConsole -> prove detach the hosted
        // path performs, reusing the validated Invoke-MyspeedCleanInitialConsoleCore contract, before the lifecycle.
        assert.match(source, /Export-ModuleMember -Function[^\n]*Invoke-MyspeedCleanInitialConsoleCore/u);
        assert.match(source,
            /ObserveInitialConsole[\s\S]*DetachInitialConsole[\s\S]*Invoke-MyspeedCleanInitialConsoleCore[\s\S]*Invoke-MyspeedCandidateLifecycleCore/u);
    });

    it("cross-checks the native process id against $PID before detaching, matching the hosted path", () => {
        const source = fs.readFileSync(SCRIPT, "utf8");
        // The hosted candidate path proves the native OS process id equals PowerShell's $PID before it detaches the
        // console (Invoke-MyspeedCandidateInitialConsole). The baseline wrapper must apply the same identity guard so
        // it never frees a console it does not own; reuse the hosted 'Native controller PID differs' failure text.
        assert.match(source,
            /CurrentProcessId\(\)[\s\S]*-ne \[int64\]\$PID[\s\S]*'Native controller PID differs'[\s\S]*Invoke-MyspeedCleanInitialConsoleCore/u);
    });

    powershellIt("binds listener ownership to loopback, PID, and process creation time", () => {
        const expected = {process: {pid: 123, creationTime: "a".repeat(16), exited: false},
            listeners: [{address: "127.0.0.1", port: 41001, pid: 123}]};
        const argv = ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", SCRIPT, "-Mode", "TestOwnedListener",
            "-InputJson", JSON.stringify(expected), "-CandidatePid", "123", "-CandidateCreationTime", "a".repeat(16),
            "-CandidatePort", "41001"];
        const accepted = childProcess.spawnSync(POWERSHELL, argv, {encoding: "utf8", timeout: TEST_TIMEOUT_MILLISECONDS});
        assert.equal(accepted.status, 0, accepted.stderr);
        assert.equal(JSON.parse(accepted.stdout).listenerOwned, true);
        for (const mutate of [value => { value.process.creationTime = "b".repeat(16); },
            value => { value.listeners[0].pid = 124; }, value => { value.listeners[0].address = "0.0.0.0"; }]) {
            const changed = structuredClone(expected); mutate(changed); const changedArgv = [...argv];
            changedArgv[changedArgv.indexOf("-InputJson") + 1] = JSON.stringify(changed);
            assert.notEqual(childProcess.spawnSync(POWERSHELL, changedArgv,
                {encoding: "utf8", timeout: TEST_TIMEOUT_MILLISECONDS}).status, 0);
        }
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
