import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";
import {spawnSync} from "node:child_process";
import {describe, it} from "node:test";

import {
    MAX_GUEST_SHUTDOWN_BYTES,
    RECEIPT_UNAVAILABLE_REASONS,
    SHUTDOWN_OUTCOMES,
    SHUTDOWN_OUTCOME_SOURCE,
    SHUTDOWN_UNAVAILABLE_REASONS,
    canonicalShutdownMarker,
    renderGuestBootstrap,
    validateQemuLaunchDiagnostic,
    validateShutdownDiagnostic
} from "../../scripts/qualification/linux-windows-cpu-floor-stage2.mjs";
import {
    COMMAND_TIMEOUT_MILLISECONDS,
    DIAGNOSTIC_CLEANUP_MINUTES,
    DIAGNOSTIC_EXECUTION_MINUTES,
    DIAGNOSTIC_TIMEOUT_SECONDS,
    PROCESS_CLEANUP_TIMEOUT_MILLISECONDS,
    collectShutdownOutcomeDiagnostic,
    createHostedStage2Operations,
    extractShutdownOutcomeDiagnostic,
    runHostedOwnedProcess
} from "../../scripts/qualification/linux-windows-cpu-floor-stage2-hosted.mjs";
import {buildWindowsMsiSetupCompleteActivation, getCompletedWindowsMsiActivationEvidence} from
    "../../scripts/qualification/windows-msi-post-setup-activation.mjs";

const NONCE = "0123456789abcdef0123456789abcdef";
const OTHER_NONCE = "fedcba9876543210fedcba9876543210";
const POWERSHELL = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
const POWERSHELL_TEST_TIMEOUT_MILLISECONDS = 30_000;
const powershellIt = process.platform === "win32" ? it : it.skip;
/*
 * The stage allowance the optional read is admitted against, derived here from the same declared
 * execution and cleanup intervals the launcher anchors at launch. The command timeout and the
 * post-timeout cleanup grace are imported rather than restated, so a boundary case cannot keep
 * passing against a stale copy of a constant that production has since changed.
 */
const STAGE_COLLECTION_ALLOWANCE_MILLISECONDS =
    DIAGNOSTIC_TIMEOUT_SECONDS * 1_000 + DIAGNOSTIC_CLEANUP_MINUTES * 60 * 1_000;

const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function context() {
    return {schemaVersion: 1, repository: "i7Gamer/MySpeed", sourceSha: "b".repeat(40),
        eventSha: "c".repeat(40), runId: "123", runAttempt: "1", nonce: NONCE,
        environment: {GITHUB_ACTIONS: "true", CI: "true", RUNNER_OS: "Linux", RUNNER_ARCH: "X64",
            RUNNER_ENVIRONMENT: "github-hosted", ImageOS: "ubuntu24", ImageVersion: "20260907.1"}};
}

const activation = () => {
    const value = context();
    return buildWindowsMsiSetupCompleteActivation({repository: value.repository, sourceSha: value.sourceSha,
        eventSha: value.eventSha, runId: value.runId, runAttempt: value.runAttempt, nonce: value.nonce});
};
const activationReceipt = () => getCompletedWindowsMsiActivationEvidence(activation());
const SYSTEM_TOOLS = [
    {role: "msiexec", path: "C:\\Windows\\System32\\msiexec.exe", bytes: "1024", sha256: "8".repeat(64)},
    {role: "sc", path: "C:\\Windows\\System32\\sc.exe", bytes: "2048", sha256: "9".repeat(64)},
    {role: "powershell", path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        bytes: "4096", sha256: "b".repeat(64)}
];

const quoted = value => value.replaceAll("'", "''");

/*
 * The real generated bootstrap, dot-sourced in library mode, with every operation it would perform
 * on the guest replaced by an inert recorder. Nothing here starts a process, touches a volume or
 * invokes a shutdown: `-Shutdown` is whatever the case under test injects.
 */
function runGuestBootstrapHarness(body, {captureRoot = null} = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-stage2-shutdown-"));
    const script = path.join(root, "bootstrap.ps1");
    fs.writeFileSync(script, renderGuestBootstrap(context()));
    const outputRoot = captureRoot === null ? null : fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-stage2-out-"));
    const program = `$ErrorActionPreference='Stop';$script:bootstrapPath='${quoted(script)}';` +
        (outputRoot === null ? "" : `$script:outputRoot='${quoted(outputRoot)}';`) +
        `. '${quoted(script)}' -LibraryMode;${body}`;
    try {
        const result = spawnSync(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", program],
            {encoding: "utf8", timeout: POWERSHELL_TEST_TIMEOUT_MILLISECONDS});
        return {result, outputRoot};
    } finally { fs.rmSync(root, {recursive: true, force: true}); }
}

/*
 * The operations table every guest case starts from: it records each call as an event and hands
 * back the shapes the bootstrap's own validation demands. `write` decides what WriteExclusive does
 * per file name, so a case can fail one write and keep the other real.
 */
function guestOperations({write = "", resolveOutput = "'C:\\Output\\'"} = {}) {
    return `$ops=@{SetErrorMode={param([uint32]$Mode)$events.Add('mode:'+$Mode);if($Mode -eq 3){return [uint32]77}};` +
        `ResolveVolume={param([string]$Label)$events.Add('resolve:'+$Label);` +
        `if($Label -eq 'MYSPEEDSEED'){'C:\\Seed\\'}else{${resolveOutput}}};` +
        `CollectEvidence={param([string]$Seed)$events.Add('collect');[ordered]@{ok=$true}};` +
        `ObserveActivation={$events.Add('activation');'${JSON.stringify(activationReceipt())}'|ConvertFrom-Json};` +
        `ObserveSystemTools={$events.Add('system-tools');'${JSON.stringify(SYSTEM_TOOLS)}'|ConvertFrom-Json};` +
        `WriteExclusive={param([string]$Path,[byte[]]$Bytes)$name=[IO.Path]::GetFileName($Path);` +
        `$events.Add('write:'+$name);$script:written[$name]=[Convert]::ToBase64String($Bytes);${write}}};`;
}

const guestPreamble = `$events=[Collections.Generic.List[string]]::new();$script:written=@{};`;
const guestReport = `[Console]::Out.Write(([ordered]@{events=($events -join ',');written=$script:written}|` +
    `ConvertTo-Json -Compress -Depth 4))`;

function guestObservation(result) {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const observed = JSON.parse(result.stdout);
    return {events: observed.events.split(","),
        written: new Map(Object.entries(observed.written ?? {}).map(([name, value]) =>
            [name, Buffer.from(value, "base64")]))};
}

describe("Stage 2 guest shutdown outcome marker", () => {
    it("renders one canonical marker literal per outcome and no write before the shutdown call", () => {
        const script = renderGuestBootstrap(context()).toString("utf8");
        for (const outcome of SHUTDOWN_OUTCOMES)
            assert.ok(script.includes(canonicalShutdownMarker(NONCE, outcome).toString("utf8")),
                `rendered bootstrap is missing the canonical ${outcome} marker`);
        /* Inside the bootstrap the marker is named only after the shutdown invocation, never before. */
        const body = script.slice(script.indexOf("function Invoke-MyspeedGuestBootstrap"));
        assert.ok(body.indexOf("& $Shutdown") < body.indexOf("$SHUTDOWN_OUTCOME_NAME"));
        assert.equal(body.match(/\$SHUTDOWN_OUTCOME_NAME/gu).length, 1);
        assert.equal(script.match(/& \$Shutdown/gu).length, 1);
        assert.doesNotMatch(script, /catch\s*\{[^}]*\$Shutdown/u);
    });

    powershellIt("G-1 writes the canonical returned marker after a shutdown that returns", () => {
        const {result} = runGuestBootstrapHarness(`${guestPreamble}${guestOperations()}` +
            `try{Invoke-MyspeedGuestBootstrap -Operations $ops -Shutdown {$events.Add('shutdown')}}` +
            `catch{$events.Add('caught')};${guestReport}`);
        const observed = guestObservation(result);
        assert.deepEqual(observed.events, ["mode:3", "resolve:MYSPEEDSEED", "resolve:MYSPEEDOUT", "collect",
            "activation", "system-tools", "mode:77", "write:result.json", "shutdown",
            "write:shutdown-outcome.json"]);
        assert.deepEqual(observed.written.get(SHUTDOWN_OUTCOME_SOURCE),
            canonicalShutdownMarker(NONCE, "returned"));
    });

    powershellIt("G-2 writes the canonical failed marker and preserves the shutdown exception", () => {
        const {result} = runGuestBootstrapHarness(`${guestPreamble}${guestOperations()}` +
            `try{Invoke-MyspeedGuestBootstrap -Operations $ops -Shutdown {$events.Add('shutdown');` +
            `throw 'shutdown failure'}}catch{$events.Add('caught:'+$_.Exception.Message)};${guestReport}`);
        const observed = guestObservation(result);
        assert.deepEqual(observed.events.slice(-3),
            ["shutdown", "write:shutdown-outcome.json", "caught:shutdown failure"]);
        assert.deepEqual(observed.written.get(SHUTDOWN_OUTCOME_SOURCE),
            canonicalShutdownMarker(NONCE, "failed"));
    });

    powershellIt("G-3 keeps the bootstrap failure when the shutdown returns", () => {
        const {result} = runGuestBootstrapHarness(`${guestPreamble}` +
            guestOperations({write: "if($name -eq 'result.json' -and $script:written.Count -eq 1)" +
                "{throw 'synthetic receipt write failure'}"}) +
            `try{Invoke-MyspeedGuestBootstrap -Operations $ops -Shutdown {$events.Add('shutdown')}}` +
            `catch{$events.Add('caught:'+$_.Exception.Message)};${guestReport}`);
        const observed = guestObservation(result);
        assert.deepEqual(observed.events.slice(-3),
            ["shutdown", "write:shutdown-outcome.json", "caught:synthetic receipt write failure"]);
        assert.deepEqual(observed.written.get(SHUTDOWN_OUTCOME_SOURCE),
            canonicalShutdownMarker(NONCE, "returned"));
    });

    powershellIt("G-4 still lets a shutdown throw supersede a bootstrap failure", () => {
        const {result} = runGuestBootstrapHarness(`${guestPreamble}` +
            guestOperations({write: "if($name -eq 'result.json' -and $script:written.Count -eq 1)" +
                "{throw 'synthetic receipt write failure'}"}) +
            `try{Invoke-MyspeedGuestBootstrap -Operations $ops -Shutdown {$events.Add('shutdown');` +
            `throw 'shutdown failure'}}catch{$events.Add('caught:'+$_.Exception.Message)};${guestReport}`);
        const observed = guestObservation(result);
        assert.deepEqual(observed.events.slice(-3),
            ["shutdown", "write:shutdown-outcome.json", "caught:shutdown failure"]);
        assert.deepEqual(observed.written.get(SHUTDOWN_OUTCOME_SOURCE),
            canonicalShutdownMarker(NONCE, "failed"));
    });

    powershellIt("G-5 writes no marker when the shutdown call does not return", () => {
        /*
         * A call that never returns is modelled by one that leaves the process: the inner finally
         * cannot run, so the absence of the marker is the observable, exactly as on a guest whose
         * machine stops inside Stop-Computer.
         */
        const {result} = runGuestBootstrapHarness(`${guestPreamble}${guestOperations()}` +
            `Invoke-MyspeedGuestBootstrap -Operations $ops -Shutdown {$events.Add('shutdown');` +
            `[Console]::Out.Write(([ordered]@{events=($events -join ',');written=$script:written}|` +
            `ConvertTo-Json -Compress -Depth 4));[Environment]::Exit(0)}`);
        const observed = guestObservation(result);
        assert.equal(observed.events.at(-1), "shutdown");
        assert.equal(observed.written.has(SHUTDOWN_OUTCOME_SOURCE), false);
    });

    powershellIt("G-6 swallows a failing marker write without changing the observed exception", () => {
        const {result} = runGuestBootstrapHarness(`${guestPreamble}` +
            guestOperations({write: "if($name -eq 'shutdown-outcome.json'){throw 'synthetic marker failure'}"}) +
            `try{Invoke-MyspeedGuestBootstrap -Operations $ops -Shutdown {$events.Add('shutdown')};` +
            `$events.Add('returned')}catch{$events.Add('caught:'+$_.Exception.Message)};${guestReport}`);
        const observed = guestObservation(result);
        assert.deepEqual(observed.events.slice(-3), ["shutdown", "write:shutdown-outcome.json", "returned"]);
    });

    powershellIt("G-7 writes the marker even when the receipt write throws", () => {
        const {result} = runGuestBootstrapHarness(`${guestPreamble}` +
            guestOperations({write: "if($name -eq 'result.json'){throw 'synthetic receipt write failure'}"}) +
            `try{Invoke-MyspeedGuestBootstrap -Operations $ops -Shutdown {$events.Add('shutdown')}}` +
            `catch{$events.Add('caught')};${guestReport}`);
        const observed = guestObservation(result);
        assert.deepEqual(observed.events.slice(-4),
            ["write:result.json", "shutdown", "write:shutdown-outcome.json", "caught"]);
        assert.deepEqual(observed.written.get(SHUTDOWN_OUTCOME_SOURCE),
            canonicalShutdownMarker(NONCE, "returned"));
    });

    powershellIt("G-8 attempts no marker write when the output volume never resolved", () => {
        const {result} = runGuestBootstrapHarness(`${guestPreamble}${guestOperations()}` +
            `$ops.ResolveVolume={param([string]$Label)$events.Add('resolve:'+$Label);` +
            `if($Label -eq 'MYSPEEDOUT'){throw 'volume is absent'};'C:\\Seed\\'};` +
            `try{Invoke-MyspeedGuestBootstrap -Operations $ops -Shutdown {$events.Add('shutdown')}}` +
            `catch{$events.Add('caught:'+$_.Exception.Message)};${guestReport}`);
        const observed = guestObservation(result);
        assert.deepEqual(observed.events, ["mode:3", "resolve:MYSPEEDSEED", "resolve:MYSPEEDOUT", "mode:77",
            "shutdown", "caught:volume is absent"]);
        assert.equal(observed.written.size, 0);
    });

    powershellIt("G-9 still invokes shutdown and writes nothing when WriteExclusive is absent", () => {
        const {result} = runGuestBootstrapHarness(`${guestPreamble}${guestOperations()}` +
            `$ops.Remove('WriteExclusive');` +
            `try{Invoke-MyspeedGuestBootstrap -Operations $ops -Shutdown {$events.Add('shutdown')}}` +
            `catch{$events.Add('caught:'+$_.Exception.Message)};${guestReport}`);
        const observed = guestObservation(result);
        /* The pre-flight check refuses the table before any operation runs, and the marker guard
         * re-checks it, so the shutdown still happens and nothing is written. */
        assert.deepEqual(observed.events, ["shutdown", "caught:Guest operation is absent: WriteExclusive"]);
        assert.equal(observed.written.size, 0);
    });

    powershellIt("G-10 neither shuts down nor writes when dot-sourced in library mode", () => {
        const {result} = runGuestBootstrapHarness(`${guestPreamble}` +
            `[Console]::Out.Write(([ordered]@{events='';written=$script:written}|ConvertTo-Json -Compress -Depth 4))`);
        const observed = guestObservation(result);
        assert.equal(observed.written.size, 0);
    });
});

/*
 * The two worker cases. Both run the real generated SetupComplete dispatcher and the real generated
 * bootstrap; only the volume lookup, the drive-letter join and the injected worker scriptblocks are
 * substituted. They exist to pin that `stage: "post-setup-completion"` identifies the writer and
 * never locates execution relative to the shutdown invocation.
 */
function runWorkerHarness(body) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-stage2-worker-"));
    const outputRoot = path.join(root, "out");
    const script = path.join(root, "bootstrap.ps1");
    fs.mkdirSync(outputRoot);
    fs.writeFileSync(script, renderGuestBootstrap(context()));
    const dispatcher = Buffer.from(activation().files.dispatcher.bytesBase64, "base64").toString("base64");
    const program = `$ErrorActionPreference='Stop';$script:outputRoot='${quoted(outputRoot)}';` +
        `$script:bootstrapPath='${quoted(script)}';` +
        `function global:Get-Volume{param([string]$FileSystemLabel)` +
        `[pscustomobject]@{DriveLetter='Q';DriveType='Fixed'}};` +
        `function global:Join-Path{param($Path,$ChildPath)if([string]$Path -ceq 'Q:\\')` +
        `{[IO.Path]::Combine($script:outputRoot,[string]$ChildPath)}` +
        `else{[IO.Path]::Combine([string]$Path,[string]$ChildPath)}};` +
        `$d=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${dispatcher}'));` +
        `. ([scriptblock]::Create($d)) -LibraryMode;${body}`;
    try {
        const result = spawnSync(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", program],
            {encoding: "utf8", timeout: POWERSHELL_TEST_TIMEOUT_MILLISECONDS});
        assert.equal(result.status, 0, result.stderr || result.stdout);
        const written = new Map(fs.readdirSync(outputRoot).map(name =>
            [name, fs.readFileSync(path.join(outputRoot, name))]));
        return {result, written};
    } finally { fs.rmSync(root, {recursive: true, force: true}); }
}

describe("Stage 2 worker receipt does not locate the shutdown invocation", () => {
    powershellIt("G-11 writes a post-setup-completion receipt and no marker when the worker fails before the bootstrap",
        () => {
            const {written} = runWorkerHarness(
                `try{Invoke-MyspeedPostSetupWorker ` +
                `-ReadState {[pscustomobject]@{registry='IMAGE_STATE_COMPLETE';file='IMAGE_STATE_COMPLETE'}} ` +
                `-Sleep {} -EnsureStartupTask {throw 'startup task registration failed'} ` +
                `-MaximumPolls 1}catch{};[Console]::Out.Write('done')`);
            assert.deepEqual([...written.keys()], ["result.json"]);
            const receipt = JSON.parse(written.get("result.json").toString("utf8"));
            assert.equal(receipt.stage, "post-setup-completion");
            assert.equal(receipt.hostNonce, NONCE);
            assert.equal(written.has(SHUTDOWN_OUTCOME_SOURCE), false);
        });

    powershellIt("G-12 writes the same post-setup-completion receipt beside a returned marker after shutdown",
        () => {
            /*
             * The Codex counterexample: the bootstrap's own receipt write fails, the shutdown is
             * invoked and returns, the marker is written, the bootstrap rethrows, and the worker's
             * different write primitive then creates result.json with the identical stage field.
             */
            const {written} = runWorkerHarness(
                `. $script:bootstrapPath -LibraryMode;` +
                guestOperations({write: "if($name -eq 'result.json'){throw 'synthetic receipt write failure'};" +
                    "[IO.File]::WriteAllBytes($Path,$Bytes)",
                resolveOutput: "$script:outputRoot"}) +
                `${guestPreamble.replace("$events=", "$global:events=")}` +
                `try{Invoke-MyspeedPostSetupWorker ` +
                `-ReadState {[pscustomobject]@{registry='IMAGE_STATE_COMPLETE';file='IMAGE_STATE_COMPLETE'}} ` +
                `-Sleep {} -EnsureStartupTask {'ready'} ` +
                `-Dispatch {Invoke-MyspeedGuestBootstrap -Operations $ops -Shutdown {$events.Add('shutdown')}} ` +
                `-MaximumPolls 1}catch{};[Console]::Out.Write(($events -join ','))`);
            assert.deepEqual([...written.keys()].sort(), ["result.json", SHUTDOWN_OUTCOME_SOURCE].sort());
            const receipt = JSON.parse(written.get("result.json").toString("utf8"));
            assert.equal(receipt.stage, "post-setup-completion");
            assert.deepEqual(written.get(SHUTDOWN_OUTCOME_SOURCE), canonicalShutdownMarker(NONCE, "returned"));
        });
});

/* ---------------------------------------------------------------------------------------------- */

const OK_PROCESS = Object.freeze({exitCode: 0, signal: null, timedOut: false, stdoutOverflow: false,
    stderrOverflow: false, cleanupProven: true, errorObserved: false});

function hostInput() {
    return {
        paths: {root: `/tmp/root-${NONCE}`, outputDisk: `/tmp/root-${NONCE}/output.img`},
        toolchain: {
            runtime: {loader: {path: "/tmp/loader"}, libraryPath: ["/tmp/lib"]},
            mcopy: {path: "/usr/bin/mtools", invocationPath: "/usr/bin/mcopy"}
        }
    };
}

const cleanLaunch = () => ({process: {cleanupProven: true, treeGone: true}});
const safeReceipt = () => ({schemaVersion: 1, status: "unavailable", reason: "receipt-not-retrieved"});
const farDeadline = () => COMMAND_TIMEOUT_MILLISECONDS + PROCESS_CLEANUP_TIMEOUT_MILLISECONDS + 1_000;

/*
 * One extraction, with a clock pinned at zero and the marker read's own stdout as the only source of
 * bytes. `runOwned` is recorded so every case can assert how many commands the collector issued.
 */
async function extractMarker(options = {}) {
    /* `receipt` and `deadline` accept an explicit undefined, so their cases are not silently
     * replaced by a default the collector would then accept. */
    const pick = (name, fallback) => Object.hasOwn(options, name) ? options[name] : fallback;
    const receipt = pick("receipt", safeReceipt());
    const deadline = pick("deadline", farDeadline());
    const launched = pick("launched", cleanLaunch());
    const preLaunchDiskIdentity = pick("preLaunchDiskIdentity", {dev: 1n});
    const now = pick("now", () => 0);
    const validateOutputDisk = pick("validateOutputDisk", () => true);
    const input = pick("input", hostInput());
    const commands = [];
    const io = {
        monotonicMilliseconds: now,
        validateOutputDisk,
        runOwned: async (command, argv, commandOptions) => {
            commands.push({command, argv, options: commandOptions});
            if (options.observed instanceof Error) throw options.observed;
            return options.observed;
        }
    };
    const diagnostic = await extractShutdownOutcomeDiagnostic(io, input, {nonce: NONCE}, launched, null,
        preLaunchDiskIdentity, receipt, deadline);
    return {diagnostic, commands};
}

const okRead = stdout => ({process: OK_PROCESS, stdout, stderr: Buffer.alloc(0)});

describe("Stage 2 host shutdown marker collection", () => {
    it("H-1 publishes an observed returned marker from the producer's own bytes", async () => {
        const bytes = canonicalShutdownMarker(NONCE, "returned");
        const {diagnostic, commands} = await extractMarker({observed: okRead(bytes)});
        assert.deepEqual(diagnostic, {schemaVersion: 1, status: "observed", outcome: "returned",
            bytes: String(bytes.length), sha256: sha256(bytes)});
        assert.equal(commands.length, 1);
        assert.ok(commands[0].argv.includes(`::${SHUTDOWN_OUTCOME_SOURCE}`));
        assert.equal(commands[0].options.maxStreamBytes, MAX_GUEST_SHUTDOWN_BYTES);
        assert.deepEqual(validateShutdownDiagnostic(diagnostic, NONCE), diagnostic);
    });

    it("H-2 publishes an observed failed marker from the producer's own bytes", async () => {
        const bytes = canonicalShutdownMarker(NONCE, "failed");
        const {diagnostic} = await extractMarker({observed: okRead(bytes)});
        assert.deepEqual(diagnostic, {schemaVersion: 1, status: "observed", outcome: "failed",
            bytes: String(bytes.length), sha256: sha256(bytes)});
        assert.deepEqual(validateShutdownDiagnostic(diagnostic, NONCE), diagnostic);
    });

    it("H-3 reports a non-zero exit with no bytes as not retrieved, never as absent", async () => {
        const {diagnostic} = await extractMarker({observed: {process: {...OK_PROCESS, exitCode: 1},
            stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)}});
        assert.deepEqual(diagnostic, {schemaVersion: 1, status: "not-retrieved"});
        assert.equal(JSON.stringify(diagnostic).includes("absent"), false);
        assert.deepEqual(validateShutdownDiagnostic(diagnostic, NONCE), diagnostic);
    });

    it("H-4 reports a non-zero exit that produced bytes as a partial read", async () => {
        const bytes = canonicalShutdownMarker(NONCE, "returned").subarray(0, 12);
        const {diagnostic} = await extractMarker({observed: {process: {...OK_PROCESS, exitCode: 1},
            stdout: bytes, stderr: Buffer.alloc(0)}});
        assert.deepEqual(diagnostic, {schemaVersion: 1, status: "malformed", reason: "partial-read",
            bytes: String(bytes.length), sha256: sha256(bytes)});
        assert.notEqual(diagnostic.bytes, "0");
        assert.deepEqual(validateShutdownDiagnostic(diagnostic, NONCE), diagnostic);
    });

    it("H-5 reports an overflowing read at exactly the marker cap", async () => {
        const bytes = Buffer.alloc(MAX_GUEST_SHUTDOWN_BYTES, 0x7b);
        const {diagnostic} = await extractMarker({observed: {process: {...OK_PROCESS, stdoutOverflow: true},
            stdout: bytes, stderr: Buffer.alloc(0)}});
        assert.deepEqual(diagnostic, {schemaVersion: 1, status: "malformed", reason: "read-cap-exceeded",
            bytes: String(MAX_GUEST_SHUTDOWN_BYTES), sha256: sha256(bytes)});
        assert.deepEqual(validateShutdownDiagnostic(diagnostic, NONCE), diagnostic);
    });

    it("H-6 rejects canonical bytes built for another nonce", async () => {
        const bytes = canonicalShutdownMarker(OTHER_NONCE, "returned");
        const {diagnostic} = await extractMarker({observed: okRead(bytes)});
        assert.equal(diagnostic.status, "malformed");
        assert.equal(diagnostic.reason, "nonce-mismatch");
        /*
         * This file has one writer and one key for its run. A record keying it as `hostNonce` - the
         * receipt's other writer's spelling - is a different schema, not a mismatched nonce.
         */
        const canonical = JSON.parse(canonicalShutdownMarker(NONCE, "returned").toString("utf8"));
        const foreignKey = {schemaVersion: canonical.schemaVersion, hostNonce: OTHER_NONCE,
            stage: canonical.stage, event: canonical.event};
        const observed = await extractMarker({
            observed: okRead(Buffer.from(JSON.stringify(foreignKey), "utf8"))});
        assert.equal(observed.diagnostic.reason, "schema-invalid");
    });

    it("H-7 rejects every near-miss of the canonical schema", async () => {
        const canonical = JSON.parse(canonicalShutdownMarker(NONCE, "returned").toString("utf8"));
        const variants = [
            {...canonical, event: "rebooted"},
            {...canonical, stage: "guest-bootstrap"},
            {...canonical, extra: 1},
            {schemaVersion: canonical.schemaVersion, stage: canonical.stage, event: canonical.event},
            {event: canonical.event, stage: canonical.stage, nonce: canonical.nonce,
                schemaVersion: canonical.schemaVersion}
        ];
        for (const variant of variants) {
            const bytes = Buffer.from(JSON.stringify(variant), "utf8");
            const {diagnostic} = await extractMarker({observed: okRead(bytes)});
            assert.equal(diagnostic.status, "malformed", JSON.stringify(variant));
            assert.equal(diagnostic.reason, "schema-invalid", JSON.stringify(variant));
        }
    });

    it("H-8 rejects truncated JSON as a syntax error", async () => {
        const bytes = canonicalShutdownMarker(NONCE, "returned").subarray(0, 20);
        const {diagnostic} = await extractMarker({observed: {process: OK_PROCESS, stdout: bytes,
            stderr: Buffer.alloc(0)}});
        assert.equal(diagnostic.status, "malformed");
        assert.equal(diagnostic.reason, "json-syntax-error");
    });

    it("H-9 treats every unsafe extraction state as terminal", async () => {
        const cases = [
            [{timedOut: true}, "extraction-timeout"],
            [{errorObserved: true}, "tool-error"],
            [{stderrOverflow: true}, "extraction-unsafe"],
            [{cleanupProven: false}, "extraction-unsafe"],
            [{signal: "SIGKILL"}, "tool-error"]
        ];
        for (const [overrides, reason] of cases) {
            const {diagnostic} = await extractMarker({observed: {process: {...OK_PROCESS, ...overrides},
                stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)}});
            assert.deepEqual(diagnostic, {schemaVersion: 1, status: "unavailable", reason});
            assert.deepEqual(validateShutdownDiagnostic(diagnostic, NONCE), diagnostic);
        }
    });

    it("H-10 issues no command when cleanup, disk identity or disk validation is unproven", async () => {
        const cases = [
            [{launched: {process: {cleanupProven: false, treeGone: true}}}, "cleanup-unproven"],
            [{launched: {process: {cleanupProven: true, treeGone: false}}}, "cleanup-unproven"],
            [{preLaunchDiskIdentity: null}, "output-disk-unverified"],
            [{validateOutputDisk() { throw new Error("disk identity changed"); }}, "disk-identity-mismatch"]
        ];
        for (const [overrides, reason] of cases) {
            const {diagnostic, commands} = await extractMarker({observed: okRead(Buffer.alloc(0)), ...overrides});
            assert.deepEqual(diagnostic, {schemaVersion: 1, status: "unavailable", reason});
            assert.equal(commands.length, 0);
        }
    });

    it("H-11 reads the marker after a receipt that was safely not retrieved", async () => {
        const bytes = canonicalShutdownMarker(NONCE, "returned");
        const {diagnostic, commands} = await extractMarker({observed: okRead(bytes),
            receipt: {schemaVersion: 1, status: "unavailable", reason: "receipt-not-retrieved"}});
        assert.equal(commands.length, 1);
        assert.equal(diagnostic.status, "observed");
    });

    it("H-12 reads the marker after a valid success receipt without touching it", async () => {
        const receipt = Object.freeze({schemaVersion: 1, status: "valid-success", source: "result.json",
            bytes: "10", sha256: "a".repeat(64)});
        const bytes = canonicalShutdownMarker(NONCE, "returned");
        const {diagnostic, commands} = await extractMarker({observed: okRead(bytes), receipt});
        assert.equal(commands.length, 1);
        assert.equal(diagnostic.status, "observed");
        assert.deepEqual(receipt, {schemaVersion: 1, status: "valid-success", source: "result.json",
            bytes: "10", sha256: "a".repeat(64)});
    });

    it("H-13 issues no command when the reserve leaves less than one execution millisecond", async () => {
        const cases = [0, PROCESS_CLEANUP_TIMEOUT_MILLISECONDS - 1, PROCESS_CLEANUP_TIMEOUT_MILLISECONDS,
            PROCESS_CLEANUP_TIMEOUT_MILLISECONDS + 0.5];
        for (const deadline of cases) {
            const {diagnostic, commands} = await extractMarker({observed: okRead(Buffer.alloc(0)), deadline});
            assert.deepEqual(diagnostic, {schemaVersion: 1, status: "unavailable",
                reason: "extraction-budget-exhausted"}, `deadline ${deadline}`);
            assert.equal(commands.length, 0, `deadline ${deadline}`);
        }
    });

    it("H-14 refuses a clock that has gone backwards without throwing", async () => {
        let call = 0;
        const {diagnostic, commands} = await extractMarker({observed: okRead(Buffer.alloc(0)),
            now: () => (call++ === 0 ? 1_000 : 0), deadline: 1_000 + farDeadline()});
        assert.deepEqual(diagnostic, {schemaVersion: 1, status: "unavailable",
            reason: "extraction-budget-exhausted"});
        assert.equal(commands.length, 0);
    });

    it("H-15 records an internal failure as tool-error rather than throwing", async () => {
        /* A malformed toolchain record reaches the invocation builder past every gate, which is the
         * unanticipated shape the wrapper exists for: it must never displace the launch failure. */
        const input = hostInput();
        input.toolchain.mcopy = {path: "/usr/bin/mtools", invocationPath: "mcopy"};
        const io = {monotonicMilliseconds: () => 0, validateOutputDisk: () => true,
            runOwned: async () => { throw new Error("no command may run"); }};
        const diagnostic = await collectShutdownOutcomeDiagnostic(io, input, {nonce: NONCE}, cleanLaunch(),
            null, {dev: 1n}, safeReceipt(), farDeadline());
        assert.deepEqual(diagnostic, {schemaVersion: 1, status: "unavailable", reason: "tool-error"});
        await assert.rejects(() => extractShutdownOutcomeDiagnostic(io, input, {nonce: NONCE}, cleanLaunch(),
            null, {dev: 1n}, safeReceipt(), farDeadline()), /invocation path is invalid/u);
    });

    it("H-19 rejects out-of-vocabulary statuses, outcomes and reasons at replay", () => {
        const canonical = canonicalShutdownMarker(NONCE, "returned");
        const observed = {schemaVersion: 1, status: "observed", outcome: "returned",
            bytes: String(canonical.length), sha256: sha256(canonical)};
        assert.throws(() => validateShutdownDiagnostic({...observed, status: "captured"}, NONCE), /invalid/u);
        assert.throws(() => validateShutdownDiagnostic({...observed, outcome: "rebooted"}, NONCE), /invalid/u);
        assert.throws(() => validateShutdownDiagnostic({schemaVersion: 1, status: "unavailable",
            reason: "receipt-not-retrieved"}, NONCE), /invalid/u);
        assert.throws(() => validateShutdownDiagnostic({schemaVersion: 2, status: "not-retrieved"}, NONCE),
            /invalid/u);
        assert.equal(SHUTDOWN_UNAVAILABLE_REASONS.includes("receipt-not-retrieved"), false);
        assert.deepEqual([...SHUTDOWN_UNAVAILABLE_REASONS].sort(),
            RECEIPT_UNAVAILABLE_REASONS.filter(reason => reason !== "receipt-not-retrieved").sort());
    });

    it("H-22 rejects an observed record whose outcome was switched without its digest", () => {
        const canonical = canonicalShutdownMarker(NONCE, "returned");
        const record = {schemaVersion: 1, status: "observed", outcome: "returned",
            bytes: String(canonical.length), sha256: sha256(canonical)};
        assert.deepEqual(validateShutdownDiagnostic(record, NONCE), record);
        assert.throws(() => validateShutdownDiagnostic({...record, outcome: "failed"}, NONCE), /invalid/u);
        assert.throws(() => validateShutdownDiagnostic(record, OTHER_NONCE), /invalid/u);
    });

    it("H-21 issues no second command after any unsafe or unproven receipt outcome", async () => {
        const unsafeReceipts = [
            ...RECEIPT_UNAVAILABLE_REASONS.filter(reason => reason !== "receipt-not-retrieved")
                .map(reason => ({schemaVersion: 1, status: "unavailable", reason})),
            {schemaVersion: 1, status: "unknown-status"},
            null,
            undefined
        ];
        for (const receipt of unsafeReceipts) {
            const {diagnostic, commands} = await extractMarker({observed: okRead(Buffer.alloc(0)), receipt});
            assert.deepEqual(diagnostic, {schemaVersion: 1, status: "unavailable", reason: "extraction-unsafe"},
                JSON.stringify(receipt ?? null));
            assert.equal(commands.length, 0, JSON.stringify(receipt ?? null));
        }
        for (const status of ["valid-success", "valid-failure", "malformed"]) {
            const {commands} = await extractMarker({observed: okRead(Buffer.alloc(0)),
                receipt: {schemaVersion: 1, status}});
            assert.equal(commands.length, 1, status);
        }
    });

    it("H-23a admits exactly one clamped command when one execution millisecond remains", async () => {
        const {diagnostic, commands} = await extractMarker({
            deadline: PROCESS_CLEANUP_TIMEOUT_MILLISECONDS + 1,
            observed: {process: {...OK_PROCESS, timedOut: true}, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)}
        });
        assert.equal(commands.length, 1);
        assert.equal(commands[0].options.timeoutMs, 1);
        assert.deepEqual(diagnostic, {schemaVersion: 1, status: "unavailable", reason: "extraction-timeout"});
    });

    it("H-23a the real adapter spends the clamped timeout plus exactly the reserved cleanup grace", async () => {
        /*
         * The real runHostedOwnedProcess with an inert child, injected timers and an injected clock:
         * nothing is spawned, signalled or killed. It pins the interval the optional read reserves -
         * one clamped execution timeout followed by PROCESS_CLEANUP_TIMEOUT_MILLISECONDS - so a
         * reserve taken after the deadline rather than before it would be visible here.
         */
        const child = new EventEmitter();
        child.pid = 4321;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        const timers = [];
        let now = 0;
        const pending = runHostedOwnedProcess("/owned/mcopy", [], {timeoutMs: 1, maxStreamBytes: 4_096}, {
            spawnImpl: () => child,
            setTimer: (callback, delay) => { timers.push({callback, delay, at: now}); return timers.length; },
            clearTimer: () => undefined,
            killGroup: () => undefined,
            isGroupAlive: () => true
        });
        assert.deepEqual(timers.map(timer => timer.delay), [1]);
        now += timers[0].delay;
        timers[0].callback();
        assert.equal(timers.length, 2);
        assert.equal(timers[1].delay, PROCESS_CLEANUP_TIMEOUT_MILLISECONDS);
        now += timers[1].delay;
        timers[1].callback();
        const observation = await pending;
        assert.equal(observation.process.timedOut, true);
        assert.equal(observation.process.cleanupProven, false);
        assert.equal(now, 1 + PROCESS_CLEANUP_TIMEOUT_MILLISECONDS);
        /* That exact observation, fed through the real collector, is a terminal unsafe outcome. */
        const {diagnostic} = await extractMarker({observed: observation,
            deadline: PROCESS_CLEANUP_TIMEOUT_MILLISECONDS + 1});
        assert.deepEqual(diagnostic, {schemaVersion: 1, status: "unavailable", reason: "extraction-timeout"});
    });

    it("H-23b publishes the real classified result of that one clamped command", async () => {
        const bytes = canonicalShutdownMarker(NONCE, "failed");
        const {diagnostic, commands} = await extractMarker({
            deadline: PROCESS_CLEANUP_TIMEOUT_MILLISECONDS + 1, observed: okRead(bytes)
        });
        assert.equal(commands.length, 1);
        assert.equal(commands[0].options.timeoutMs, 1);
        assert.deepEqual(diagnostic, {schemaVersion: 1, status: "observed", outcome: "failed",
            bytes: String(bytes.length), sha256: sha256(bytes)});
    });

    it("H-27 issues no command when no collection deadline could be established", async () => {
        for (const deadline of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, "1000"]) {
            const {diagnostic, commands} = await extractMarker({observed: okRead(Buffer.alloc(0)), deadline});
            assert.deepEqual(diagnostic, {schemaVersion: 1, status: "unavailable",
                reason: "extraction-budget-exhausted"}, String(deadline));
            assert.equal(commands.length, 0, String(deadline));
        }
    });
});

/* ---------------------------------------------------------------------------------------------- */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG = Buffer.concat([PNG_SIGNATURE, Buffer.from([0x00])]);
const LAUNCH_TIME_MILLISECONDS = 1_000;

function fullPaths() {
    const root = `/home/runner/work/_temp/myspeed-windows-cpu-floor-${NONCE}`;
    return {root, packageRoot: `${root}/packages`, portableRoot: `/tmp/myspeed-windows-cpu-floor-tools-${NONCE}`,
        probeRoot: `${root}/probes`, windowsIso: `${root}/windows.iso`, installWim: `${root}/install.wim`,
        seedIso: `${root}/seed.iso`, outputDisk: `${root}/output.img`, systemDisk: `${root}/system.qcow2`,
        ovmfVars: `${root}/OVMF_VARS.fd`, serialLog: `${root}/serial.log`, qemuPid: `${root}/qemu.pid`};
}

const rootFileIdentity = target => ({path: target, bytes: "4096", sha256: "f".repeat(64),
    ownership: {uid: "0", gid: "0", mode: "555", ordinaryUserWritable: false}});

const toolchainFixture = () => ({
    runtime: {
        loader: rootFileIdentity(`${fullPaths().portableRoot}/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`),
        libraryPath: [`${fullPaths().portableRoot}/lib/x86_64-linux-gnu`]
    },
    qemu: {path: `${fullPaths().portableRoot}/usr/bin/qemu-system-x86_64`,
        invocationPath: "/usr/bin/qemu-system-x86_64", bytes: "4096", sha256: "f".repeat(64),
        ownership: {uid: "0", gid: "0", mode: "555", ordinaryUserWritable: false}},
    mcopy: {path: `${fullPaths().portableRoot}/usr/bin/mtools`, invocationPath: "/usr/bin/mcopy"},
    firmware: {
        searchPath: `${fullPaths().portableRoot}/usr/share/qemu`,
        kvmvapic: rootFileIdentity(`${fullPaths().portableRoot}/usr/share/qemu/kvmvapic.bin`),
        vga: rootFileIdentity(`${fullPaths().portableRoot}/usr/share/seabios/vgabios-stdvga.bin`),
        code: {path: `${fullPaths().portableRoot}/usr/share/OVMF/OVMF_CODE.fd`, bytes: "100",
            sha256: "c".repeat(64)},
        vars: {path: `${fullPaths().portableRoot}/usr/share/OVMF/OVMF_VARS.fd`, bytes: "100",
            sha256: "d".repeat(64)}
    }
});

const directoryIdentity = target => ({path: target, dev: "1", ino: target === "/tmp" ? "1" : "2", uid: "0",
    gid: "0", mode: target === "/tmp" ? "1777" : "755", ordinaryUserWritable: target === "/tmp",
    sticky: target === "/tmp"});

/*
 * The production call chain with an injected clock. Time is advanced only where the launcher itself
 * spends it - inside the monitored run and inside each verified frame read - and then inside each
 * extraction command, so a deadline anchored anywhere later than the launch instant is visible as an
 * admitted timeout that is too large.
 */
async function runLaunchChain({launcherMilliseconds, frameMilliseconds, receiptMilliseconds,
    diagnostic = true, uncleanLaunch = true, markerBytes = canonicalShutdownMarker(NONCE, "returned"),
    qmpShutdownEvent = null} = {}) {
    const pths = fullPaths();
    let now = LAUNCH_TIME_MILLISECONDS;
    const commands = [];
    const adapter = createHostedStage2Operations({
        context: {...context(), nonce: NONCE},
        paths: pths,
        dependencies: {
            monotonicMilliseconds: () => now,
            pathExists: () => false,
            inspectOwned: target => target === pths.outputDisk ?
                ({path: target, bytes: "67108864", sha256: "a".repeat(64),
                    ownership: {uid: "1001", gid: "1001", mode: "600", ordinaryUserWritable: false}}) :
                rootFileIdentity(target),
            inspectDirectory: directoryIdentity,
            validateOutputDisk: () => ({dev: 1n, ino: 2n, uid: 1001n, gid: 1001n, size: 67_108_864n}),
            readOwnedVerified: target => {
                now += frameMilliseconds;
                return {bytes: PNG, identity: {path: target, bytes: String(PNG.length), sha256: sha256(PNG)}};
            },
            runMonitoredQemu: async () => {
                now += launcherMilliseconds;
                return {
                    observation: {
                        process: {exitCode: uncleanLaunch ? 1 : 0, signal: null, timedOut: false,
                            cleanupProven: true, treeGone: true, stdoutOverflow: false, stderrOverflow: false,
                            errorObserved: false},
                        stdout: Buffer.alloc(0), stderr: Buffer.from("qemu terminated\n")
                    },
                    identity: {pid: 2345, startTicks: "77",
                        executablePath: `${pths.portableRoot}/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2`,
                        processGroupId: 2300},
                    absentAfter: true, processGroupGone: true, terminationReason: "deadline",
                    ...(qmpShutdownEvent === null ? {} : {qmpShutdownEvent}),
                    qmp: {version: {major: 8, minor: 2, micro: 2}, status: "running", running: true,
                        screenshotPaths: [`${pths.root}/early-boot-1.png`, `${pths.root}/early-boot-2.png`],
                        inputSent: false}
                };
            },
            runOwned: async (command, argv, options) => {
                commands.push({argv, options, atMilliseconds: now});
                now += receiptMilliseconds;
                if (argv.includes(`::${SHUTDOWN_OUTCOME_SOURCE}`))
                    return {process: OK_PROCESS, stdout: markerBytes, stderr: Buffer.alloc(0)};
                return {process: {...OK_PROCESS, exitCode: 1}, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)};
            }
        }
    });
    const launch = await adapter.launchOwnedQemu({
        toolchain: toolchainFixture(), paths: pths, argv: [], privilegeMode: "ordinary-kvm",
        ...(diagnostic ? {deadlines: {executionMinutes: DIAGNOSTIC_EXECUTION_MINUTES,
            cleanupMinutes: DIAGNOSTIC_CLEANUP_MINUTES}} : {}),
        ...(qmpShutdownEvent === null ? {} : {midWindowFrames: true})
    });
    return {launch, commands,
        markerCommand: commands.find(entry => entry.argv.includes(`::${SHUTDOWN_OUTCOME_SOURCE}`)) ?? null};
}

const stageDeadline = () => LAUNCH_TIME_MILLISECONDS + STAGE_COLLECTION_ALLOWANCE_MILLISECONDS;

describe("Stage 2 launch-anchored collection deadline", () => {
    it("H-25 charges launcher, frame and receipt time against the launch-anchored allowance", async () => {
        /*
         * 1,740,000 ms inside the monitored run, 10,000 ms across the two frame reads and 30,000 ms
         * across the two receipt attempts leaves the optional read well under its own command
         * timeout. A deadline sampled after the launcher returned would admit the full timeout.
         */
        const {markerCommand, launch} = await runLaunchChain({launcherMilliseconds: 1_740_000,
            frameMilliseconds: 5_000, receiptMilliseconds: 15_000});
        assert.ok(markerCommand);
        const expected = Math.min(COMMAND_TIMEOUT_MILLISECONDS,
            Math.floor(stageDeadline() - markerCommand.atMilliseconds - PROCESS_CLEANUP_TIMEOUT_MILLISECONDS));
        assert.equal(markerCommand.options.timeoutMs, expected);
        assert.ok(expected < COMMAND_TIMEOUT_MILLISECONDS,
            "the fixture must consume enough time for the anchor to matter");
        assert.equal(launch.failureDiagnostic.shutdown.status, "observed");
        assert.equal(launch.failureDiagnostic.shutdown.outcome, "returned");
        validateQemuLaunchDiagnostic(launch.failureDiagnostic, launch.process, NONCE);
    });

    it("H-25 admits the full command timeout only when the allowance is barely touched", async () => {
        const {markerCommand} = await runLaunchChain({launcherMilliseconds: 1_000,
            frameMilliseconds: 0, receiptMilliseconds: 0});
        assert.ok(markerCommand);
        assert.equal(markerCommand.options.timeoutMs, COMMAND_TIMEOUT_MILLISECONDS);
    });

    it("H-25 issues no marker command once the launcher has consumed the allowance", async () => {
        const {markerCommand, launch} = await runLaunchChain({
            launcherMilliseconds: STAGE_COLLECTION_ALLOWANCE_MILLISECONDS - 1_000,
            frameMilliseconds: 0, receiptMilliseconds: 0});
        assert.equal(markerCommand, null);
        assert.deepEqual(launch.failureDiagnostic.shutdown,
            {schemaVersion: 1, status: "unavailable", reason: "extraction-budget-exhausted"});
    });

    it("H-17 issues no marker command and publishes no shutdown key on the Stage 3 launcher shape", async () => {
        const {markerCommand, launch} = await runLaunchChain({launcherMilliseconds: 1_000,
            frameMilliseconds: 0, receiptMilliseconds: 0, diagnostic: false});
        assert.equal(markerCommand, null);
        assert.equal(Object.hasOwn(launch.failureDiagnostic, "shutdown"), false);
    });

    it("H-16 issues no marker command when the launch produced no failure diagnostic", async () => {
        const qmpShutdownEvent = {schemaVersion: 1, status: "captured", guest: true,
            reason: "guest-shutdown", offsetMs: 600_000};
        const {markerCommand, launch} = await runLaunchChain({launcherMilliseconds: 1_000,
            frameMilliseconds: 0, receiptMilliseconds: 0, uncleanLaunch: false, qmpShutdownEvent});
        assert.equal(markerCommand, null);
        assert.equal(launch.failureDiagnostic, undefined);
        assert.equal(Object.hasOwn(launch, "qmpShutdownEvent"), false);
    });

    it("H-20 keeps every marker state non-qualifying beside an unclean stop", async () => {
        for (const outcome of [...SHUTDOWN_OUTCOMES, null]) {
            const bytes = outcome === null ? Buffer.alloc(0) : canonicalShutdownMarker(NONCE, outcome);
            const {launch} = await runLaunchChain({launcherMilliseconds: 1_000, frameMilliseconds: 0,
                receiptMilliseconds: 0, markerBytes: bytes});
            assert.equal(launch.guest, null);
            assert.ok(launch.failureDiagnostic);
            assert.notEqual(launch.process.terminationReason, null);
            validateQemuLaunchDiagnostic(launch.failureDiagnostic, launch.process, NONCE);
        }
    });
});

describe("Stage 2 shutdown diagnostic replay", () => {
    function launchProcessFixture() {
        return {exitCode: 1, signal: null, timedOut: true, cleanupProven: true, treeGone: true,
            qemuPid: 2345, qemuStartTicks: "77", launcherExecutablePath: "/tmp/loader", processGroupId: 2300,
            qemuPidAbsentAfter: true, terminationReason: "deadline"};
    }

    function launchDiagnosticFixture() {
        return {schemaVersion: 1, kind: "qemu-launch-failure-diagnostic", process: launchProcessFixture(),
            processFlags: {errorObserved: false, stderrOverflow: false, stdoutOverflow: false},
            monitorFailure: null,
            stderr: {bytes: "0", sha256: sha256(Buffer.alloc(0)), bytesBase64: ""},
            receipt: {schemaVersion: 1, status: "unavailable", reason: "receipt-not-retrieved"}};
    }

    it("H-18 replays a historical record that carries no shutdown key", () => {
        const value = launchDiagnosticFixture();
        const replayed = validateQemuLaunchDiagnostic(value, launchProcessFixture(), NONCE);
        assert.equal(Object.hasOwn(replayed, "shutdown"), false);
    });

    it("H-24 publishes a worker receipt beside a missing marker without any ordering claim", () => {
        const value = {...launchDiagnosticFixture(),
            receipt: {schemaVersion: 1, status: "valid-failure", source: "result.json",
                receipt: {schemaVersion: 1, status: "failed", nonce: NONCE, stage: "post-setup-completion",
                    failure: "Windows setup did not complete within the bounded observation interval"}},
            shutdown: {schemaVersion: 1, status: "not-retrieved"}};
        const replayed = validateQemuLaunchDiagnostic(value, launchProcessFixture(), NONCE);
        assert.equal(replayed.receipt.receipt.stage, "post-setup-completion");
        assert.deepEqual(replayed.shutdown, {schemaVersion: 1, status: "not-retrieved"});
    });

    it("H-26 publishes a worker receipt beside a returned marker built from the producer's bytes", () => {
        const canonical = canonicalShutdownMarker(NONCE, "returned");
        const value = {...launchDiagnosticFixture(),
            receipt: {schemaVersion: 1, status: "valid-failure", source: "result.json",
                receipt: {schemaVersion: 1, status: "failed", nonce: NONCE, stage: "post-setup-completion",
                    failure: "MSI bootstrap result is absent"}},
            shutdown: {schemaVersion: 1, status: "observed", outcome: "returned",
                bytes: String(canonical.length), sha256: sha256(canonical)}};
        const replayed = validateQemuLaunchDiagnostic(value, launchProcessFixture(), NONCE);
        assert.equal(replayed.receipt.receipt.stage, "post-setup-completion");
        assert.equal(replayed.shutdown.outcome, "returned");
        assert.throws(() => validateQemuLaunchDiagnostic(
            {...value, shutdown: {...value.shutdown, outcome: "failed"}}, launchProcessFixture(), NONCE),
        /invalid/u);
    });
});
