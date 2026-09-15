import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SCRIPT = path.resolve("scripts/qualification/windows-msi-guest-runner.ps1");
const POWERSHELL = process.platform === "win32"
    ? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : "pwsh";
const PROCESS_TIMEOUT_MS = 30_000;
const HAS_POWERSHELL = spawnSync(POWERSHELL,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"],
{encoding: "utf8", timeout: PROCESS_TIMEOUT_MS}).status === 0;
const powershellIt = (name, fn) => it(name,
    {timeout: PROCESS_TIMEOUT_MS, skip: !HAS_POWERSHELL && "PowerShell unavailable"}, fn);
const HASH = "a".repeat(64);

const request = () => ({
    schemaVersion: 1,
    kind: "myspeed-windows-msi-guest-launch-request",
    qualifying: false,
    sourceSha: "1".repeat(40),
    eventSha: "2".repeat(40),
    runId: "123",
    runAttempt: "1",
    nonce: "3".repeat(32),
    observerSha256: HASH,
    guest: {
        cpuClass: "modern-msi",
        serial: "4".repeat(32),
        cpuEvidenceSha256: "5".repeat(64),
        qemuLaunchSha256: "6".repeat(64),
        seedRoot: "D:\\seed",
        outputRoot: "E:\\output"
    },
    files: {
        node: {path: "D:\\seed\\node.exe", bytes: 50_000_000, sha256: "7".repeat(64)},
        runner: {path: "D:\\seed\\windows-msi-guest-clean-row.mjs", bytes: 20_000, sha256: "8".repeat(64)},
        launcher: {path: "D:\\seed\\media-job-launcher.ps1", bytes: 30_000, sha256: "9".repeat(64)},
        semanticRequest: {path: "D:\\seed\\request.json", bytes: 10_000, sha256: "a".repeat(64)}
    },
    semanticOutputPath: "E:\\output\\result.json",
    launcherOutputPath: "E:\\output\\launcher-result.json",
    wallDeadlineUnixMilliseconds: 2_000_000_000_000,
    maximumDurationMilliseconds: 14_400_000,
    maximumSemanticResultBytes: 1_048_576
});

const semanticOutput = () => ({path: "E:\\output\\result.json", bytes: 512, sha256: "c".repeat(64)});

const launcherResult = () => ({
    schemaVersion: 1,
    kind: "myspeed-owned-job-observed-launch",
    status: "completed",
    authorizesTransfer: false,
    executable: {path: "D:\\seed\\node.exe", expectedSha256: "7".repeat(64),
        beforeSha256: "7".repeat(64), afterSha256: "7".repeat(64)},
    arguments: ["--experimental-sqlite", "D:\\seed\\windows-msi-guest-clean-row.mjs",
        "--request", "D:\\seed\\request.json", "--request-sha256", "a".repeat(64)],
    workingDirectory: "E:\\output",
    creationFlags: 134217732,
    process: {processId: 42, assignedBeforeResume: true, resumed: true,
        retainedHandleThroughExit: true},
    timing: {initialWallUnixMilliseconds: 1, initialMonotonicMilliseconds: 1,
        wallDeadlineUnixMilliseconds: 2_000_000_000_000, monotonicDeadlineMilliseconds: 10,
        lastWallUnixMilliseconds: 2, lastMonotonicMilliseconds: 2,
        postReturnWallUnixMilliseconds: 3, postReturnMonotonicMilliseconds: 3},
    timedOut: false,
    forced: false,
    exitCode: 0,
    processTreeExitProven: true,
    handles: {job: "closed", process: "closed", thread: "closed"},
    observer: {sha256: HASH, tickCount: 1, firstMonotonicMilliseconds: 1,
        lastMonotonicMilliseconds: 2, maximumDurationMilliseconds: 1,
        contextKeys: ["schemaVersion", "tick", "processId", "wallUnixMilliseconds",
            "monotonicMilliseconds", "wallDeadlineUnixMilliseconds", "monotonicDeadlineMilliseconds"],
        lastAction: "observe", lastObservation: "guest-runner", synchronousCancellationProven: false},
    failure: null
});

describe("Windows MSI guest owned-Job runner", () => {
    powershellIt("accepts only the exact modern-CPU MSI command and truthful launcher proof", () => {
        const result = invoke("TestInjected", {request: request(), launcher: launcherResult(),
            semanticOutput: semanticOutput()});
        assert.equal(result.status, "completed");
        assert.equal(result.guestRunnerPassed, true);
        assert.equal(result.qualifying, false);
        assert.equal(result.cpuClass, "modern-msi");
        assert.deepEqual(result.releaseGatesCleared, []);
        const wrongCpu = {request: request(), launcher: launcherResult(), semanticOutput: semanticOutput()};
        wrongCpu.request.guest.cpuClass = "westmere-v2";
        assert.throws(() => invoke("TestInjected", wrongCpu));
        for (const mutate of [
            value => { value.launcher.arguments[0] = ""; },
            value => { value.launcher.process.assignedBeforeResume = false; },
            value => { value.launcher.processTreeExitProven = false; },
            value => { value.launcher.handles.job = "open"; },
            value => { value.launcher.exitCode = 1; },
            value => { value.launcher.executable.afterSha256 = HASH; },
            value => { value.launcher.observer.sha256 = "b".repeat(64); },
            value => { value.launcher.process.extra = true; },
            value => { value.launcher.process.processId = 0; },
            value => { value.launcher.observer.tickCount = 0; },
            value => { value.launcher.timing.wallDeadlineUnixMilliseconds -= 1; },
            value => { value.launcher.timing.postReturnMonotonicMilliseconds = 1; },
            value => { value.semanticOutput.path = "E:\\output\\other.json"; },
            value => { value.semanticOutput.bytes = 1_048_577; }
        ]) assert.equal(invoke("TestInjected", mutateAndReturn({request: request(),
            launcher: launcherResult(), semanticOutput: semanticOutput()}, mutate)).guestRunnerPassed, false);
    });

    powershellIt("retains a bounded failure without claiming a semantic or release result", () => {
        const input = {request: request(), launcher: launcherResult(), semanticOutput: null};
        input.launcher.status = "failed";
        input.launcher.failure = {stage: "wait", message: "bounded"};
        input.launcher.exitCode = null;
        const result = invoke("TestInjected", input);
        assert.equal(result.status, "failed");
        assert.equal(result.guestRunnerPassed, false);
        assert.equal(result.semanticResultAccepted, false);
        assert.deepEqual(result.releaseGatesCleared, []);
    });

    it("puts every native-capable operation behind the guest guard", () => {
        const source = fs.readFileSync(SCRIPT, "utf8");
        const guard = source.indexOf("Assert-MyspeedMsiGuestContext");
        const launcher = source.indexOf("Invoke-ObservedOwnedJobProcess", guard);
        const addType = source.indexOf(". $Request.files.launcher.path", guard);
        assert.ok(guard >= 0 && launcher > guard && addType > guard);
        assert.match(source, /CpuClass='modern-msi'/u);
        assert.match(source, /Get-NetAdapter -IncludeHidden -ErrorAction Stop/u);
        assert.match(source, /releaseGatesCleared=@\(\)/u);
    });
});

function mutateAndReturn(value, mutate) {
    mutate(value);
    return value;
}

function invoke(mode, value) {
    const input = Buffer.from(JSON.stringify(value), "utf8").toString("base64");
    const program = `$json=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${input}')); & '${quote(SCRIPT)}' -Mode ${mode} -InputJson $json`;
    const result = spawnSync(POWERSHELL,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", program],
        {encoding: "utf8", timeout: PROCESS_TIMEOUT_MS});
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1));
}

function quote(value) {
    return value.replaceAll("'", "''");
}
