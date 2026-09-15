import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import {describe, it} from "node:test";

import {createWindowsBaselineGuestRuntime} from "../../scripts/qualification/windows-baseline-guest-runtime.mjs";

const SHA = character => character.repeat(64);
const NONCE = "3".repeat(32);
const ROOT = `C:\\Windows\\Temp\\myspeed-baseline-${NONCE}`;
const controllerRequest = () => ({expectedRunId: "123", expectedRunAttempt: "1", expectedEventSha: "2".repeat(40),
    expectedSourceSha: "1".repeat(40), expectedImageVersion: "windows-server-2025-standard-eval", nonce: NONCE,
    readyPath: `${ROOT}\\ready.json`, stopRequestPath: `${ROOT}\\stop.json`, resultPath: `${ROOT}\\result.json`,
    normalDeadlineMs: 300_000, hardDeadlineMs: 310_000});

class Child extends EventEmitter {
    constructor() { super(); this.exitCode = null; this.signalCode = null; this.stdout = new EventEmitter();
        this.stderr = new EventEmitter(); this.kills = 0; }
    finish(code = 0) { this.exitCode = code; this.emit("exit", code, null); }
    kill() { this.kills += 1; return true; }
}

describe("Windows baseline guest concrete process runtime", () => {
    it("writes an exact request and invokes only the guest candidate wrapper vector", async () => {
        const child = new Child();
        const calls = [];
        const runtime = createWindowsBaselineGuestRuntime({powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            wrapper: {path: `${ROOT}\\guest-wrapper.ps1`, sha256: SHA("a")},
            candidateController: {path: `${ROOT}\\candidate-controller.ps1`, sha256: SHA("b")},
            cleanStopController: {path: `${ROOT}\\clean-stop.ps1`, sha256: SHA("c")},
            network: {hardwareNics: 0, enabledNonLoopbackInterfaces: 0, nonLoopbackRoutes: 0}, dependencies: {
                writeNewJson: (target, value) => { calls.push(["write", target, value]); return SHA("d"); },
                spawn: (command, argv, options) => { calls.push(["spawn", command, argv, options]); return child; },
                readPublishedJson: async target => ({candidatePid: 100, candidateCreationTime: "e".repeat(16),
                    target}), checkPopulated: async () => ({elapsedMs: 10}), checkPopulatedDatabase: async () => ({}),
                checkResetDatabase: async () => ({}), materialize: async () => ({}), inspectCandidate: async () => ({}),
                cleanup: async () => ({cleanupProven: true})}});
        const request = controllerRequest();
        const started = await runtime.startController({request, requestPath: `${ROOT}\\request.json`});
        assert.equal(started.child, child);
        const argv = calls.find(call => call[0] === "spawn")[2];
        assert.deepEqual(argv.slice(0, 8), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
            "-File", `${ROOT}\\guest-wrapper.ps1`, "-Mode"]);
        assert.equal(argv[8], "InvokeGuestCandidate");
        assert.ok(argv.includes("-ExpectedRequestSha256") && argv.includes(SHA("d")));
        const completion = runtime.waitController({started});
        child.finish();
        assert.deepEqual(await completion, {exitCode: 0, signal: null});
    });

    it("retains a bounded timeout failure instead of accepting a missing controller exit", async () => {
        const child = new Child();
        const runtime = createWindowsBaselineGuestRuntime({powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            wrapper: {path: `${ROOT}\\guest-wrapper.ps1`, sha256: SHA("a")},
            candidateController: {path: `${ROOT}\\candidate-controller.ps1`, sha256: SHA("b")},
            cleanStopController: {path: `${ROOT}\\clean-stop.ps1`, sha256: SHA("c")},
            network: {hardwareNics: 0, enabledNonLoopbackInterfaces: 0, nonLoopbackRoutes: 0}, dependencies: {
                writeNewJson: () => SHA("d"), spawn: () => child, readPublishedJson: async () => ({}),
                checkPopulated: async () => ({}), checkPopulatedDatabase: async () => ({}),
                checkResetDatabase: async () => ({}), materialize: async () => ({}), inspectCandidate: async () => ({}),
                cleanup: async () => ({cleanupProven: false}), setTimer: callback => { callback(); return 1; },
                clearTimer: () => undefined}});
        const started = await runtime.startController({request: controllerRequest(), requestPath: `${ROOT}\\request.json`});
        await assert.rejects(runtime.waitController({started}), /deadline/u);
        assert.deepEqual(await runtime.stopController({started}), {killAttempted: true, failure: ""});
        assert.deepEqual(await runtime.stopController({started}), {killAttempted: true, failure: ""});
        assert.equal(child.kills, 1);
    });

    it("lets an exact published ready receipt beat controller completion and cancels losing polling", async () => {
        const child = new Child(); let polls = 0;
        const runtime = createWindowsBaselineGuestRuntime({powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            wrapper: {path: `${ROOT}\\guest-wrapper.ps1`, sha256: SHA("a")},
            candidateController: {path: `${ROOT}\\candidate-controller.ps1`, sha256: SHA("b")},
            cleanStopController: {path: `${ROOT}\\clean-stop.ps1`, sha256: SHA("c")},
            network: {hardwareNics: 0, enabledNonLoopbackInterfaces: 0, nonLoopbackRoutes: 0}, dependencies: {
                writeNewJson: () => SHA("d"), spawn: () => child,
                readPublishedJson: async (target, deadline, options) => { polls += 1;
                    assert.equal(options.completion instanceof Promise, true);
                    return {candidatePid: 100, candidateCreationTime: "e".repeat(16), target, deadline}; },
                checkPopulated: async () => ({}), checkPopulatedDatabase: async () => ({}),
                checkResetDatabase: async () => ({}), materialize: async () => ({}), inspectCandidate: async () => ({}),
                cleanup: async () => ({cleanupProven: true})}});
        const request = controllerRequest();
        const started = await runtime.startController({request, requestPath: `${ROOT}\\request.json`});
        child.finish(113);
        const ready = await runtime.readReady({request, started});
        assert.equal(ready.candidatePid, 100); assert.equal(polls, 1);
    });

    it("bounds and sanitizes captured wrapper stderr", async () => {
        const child = new Child();
        const runtime = createWindowsBaselineGuestRuntime({powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            wrapper: {path: `${ROOT}\\guest-wrapper.ps1`, sha256: SHA("a")},
            candidateController: {path: `${ROOT}\\candidate-controller.ps1`, sha256: SHA("b")},
            cleanStopController: {path: `${ROOT}\\clean-stop.ps1`, sha256: SHA("c")},
            network: {hardwareNics: 0, enabledNonLoopbackInterfaces: 0, nonLoopbackRoutes: 0}, dependencies: {
                writeNewJson: () => SHA("d"), spawn: () => child, readPublishedJson: async () => ({}),
                checkPopulated: async () => ({}), checkPopulatedDatabase: async () => ({}),
                checkResetDatabase: async () => ({}), materialize: async () => ({}), inspectCandidate: async () => ({}),
                cleanup: async () => ({cleanupProven: false})}});
        const started = await runtime.startController({request: controllerRequest(), requestPath: `${ROOT}\\request.json`});
        child.stderr.emit("data", Buffer.from(`sentinel\u0000\n${"x".repeat(300_000)}`));
        const diagnostic = await runtime.readFailedResult({request: controllerRequest(), started});
        assert.match(diagnostic.stderr, /^sentinel x+/u);
        assert.ok(diagnostic.stderr.length <= 512);
        assert.equal(child.kills, 1);
        child.finish(1);
    });

    it("polls the exact owned listener within the remaining launch deadline", async () => {
        const child = new Child(); const observations = [];
        const runtime = createWindowsBaselineGuestRuntime({powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            wrapper: {path: `${ROOT}\\guest-wrapper.ps1`, sha256: SHA("a")},
            candidateController: {path: `${ROOT}\\candidate-controller.ps1`, sha256: SHA("b")},
            cleanStopController: {path: `${ROOT}\\clean-stop.ps1`, sha256: SHA("c")},
            network: {hardwareNics: 0, enabledNonLoopbackInterfaces: 0, nonLoopbackRoutes: 0}, dependencies: {
                writeNewJson: () => SHA("d"), spawn: () => child, readPublishedJson: async () => ({}),
                observeOwnedListener: input => { observations.push(input); return {listenerOwned: true,
                    candidatePid: input.candidatePid, candidateCreationTime: input.candidateCreationTime,
                    port: input.port}; }, checkPopulated: async () => ({}), checkPopulatedDatabase: async () => ({}),
                checkResetDatabase: async () => ({}), materialize: async () => ({}), inspectCandidate: async () => ({}),
                cleanup: async () => ({cleanupProven: true})}});
        const started = await runtime.startController({request: controllerRequest(), requestPath: `${ROOT}\\request.json`});
        const receipt = await runtime.observeOwnedListener({port: 41001, candidatePid: 123,
            candidateCreationTime: "e".repeat(16), started});
        assert.equal(receipt.listenerOwned, true);
        assert.ok(observations[0].timeoutMs > 0 && observations[0].timeoutMs <= 60_000);
        child.finish();
    });

    it("anchors ready, result, and process deadlines to the original controller launch", async () => {
        const child = new Child();
        const deadlines = [];
        let now = 1_000;
        let timerDelay = null;
        const runtime = createWindowsBaselineGuestRuntime({powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            wrapper: {path: `${ROOT}\\guest-wrapper.ps1`, sha256: SHA("a")},
            candidateController: {path: `${ROOT}\\candidate-controller.ps1`, sha256: SHA("b")},
            cleanStopController: {path: `${ROOT}\\clean-stop.ps1`, sha256: SHA("c")},
            network: {hardwareNics: 0, enabledNonLoopbackInterfaces: 0, nonLoopbackRoutes: 0}, dependencies: {
                writeNewJson: () => SHA("d"), spawn: () => child, now: () => now,
                readPublishedJson: async (target, deadline) => { deadlines.push([target, deadline]); return {}; },
                checkPopulated: async () => ({}), checkPopulatedDatabase: async () => ({}),
                checkResetDatabase: async () => ({}), materialize: async () => ({}), inspectCandidate: async () => ({}),
                cleanup: async () => ({cleanupProven: true}),
                setTimer: (callback, delay) => { timerDelay = delay; return 1; }, clearTimer: () => undefined}});
        const request = controllerRequest();
        const started = await runtime.startController({request, requestPath: `${ROOT}\\request.json`});
        assert.equal(started.startedAt, 1_000);
        assert.equal(timerDelay, 310_000);
        now = 299_999;
        await runtime.readReady({request, started});
        now = 309_999;
        await runtime.readResult({request, started});
        assert.deepEqual(deadlines, [[request.readyPath, 301_000], [request.resultPath, 311_000]]);
        child.finish();
        assert.deepEqual(await runtime.waitController({started}), {exitCode: 0, signal: null});
    });

    it("uses the guest-guarded shared retained-handle seam for the default candidate identity", async () => {
        const calls = [];
        const runtime = createWindowsBaselineGuestRuntime({powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            wrapper: {path: `${ROOT}\\guest-wrapper.ps1`, sha256: SHA("a")},
            candidateController: {path: `${ROOT}\\candidate-controller.ps1`, sha256: SHA("b")},
            cleanStopController: {path: `${ROOT}\\clean-stop.ps1`, sha256: SHA("c")},
            network: {hardwareNics: 0, enabledNonLoopbackInterfaces: 0, nonLoopbackRoutes: 0}, dependencies: {
                spawnSync: (command, argv, options) => { calls.push([command, argv, options]); return {status: 0,
                    signal: null, error: undefined, stdout: JSON.stringify({path: `${ROOT}\\MySpeed.exe`,
                        finalPath: `${ROOT}\\MySpeed.exe`, bytes: 524_288, sha256: SHA("d"),
                        volumeSerial: "89abcdef", fileId: "0123456789abcdef", linkCount: 1,
                        isRegular: true, reparsePoint: false}), stderr: ""}; }
            }});
        const observed = await runtime.inspectCandidate({request: {candidate: {path: `${ROOT}\\MySpeed.exe`,
            bytes: "524288", sha256: SHA("d")}}});
        assert.deepEqual(observed, {volumeSerial: "89abcdef", fileId: "0123456789abcdef"});
        assert.deepEqual(calls[0][1].slice(5, 9), ["-File", `${ROOT}\\guest-wrapper.ps1`, "-Mode",
            "InspectCandidate"]);
        assert.ok(calls[0][1].includes("-MaximumCandidateBytes") && calls[0][1].includes("536870912"));
        assert.equal(calls[0][2].timeout, 30_000);

        const rejected = createWindowsBaselineGuestRuntime({powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            wrapper: {path: `${ROOT}\\guest-wrapper.ps1`, sha256: SHA("a")},
            candidateController: {path: `${ROOT}\\candidate-controller.ps1`, sha256: SHA("b")},
            cleanStopController: {path: `${ROOT}\\clean-stop.ps1`, sha256: SHA("c")},
            network: {hardwareNics: 0, enabledNonLoopbackInterfaces: 0, nonLoopbackRoutes: 0}, dependencies: {
                spawnSync: () => ({status: 0, signal: null, error: undefined, stdout: JSON.stringify({
                    path: `${ROOT}\\MySpeed.exe`, finalPath: `${ROOT}\\other.exe`, bytes: 524_288,
                    sha256: SHA("d"), volumeSerial: "89abcdef", fileId: "0123456789abcdef", linkCount: 1,
                    isRegular: true, reparsePoint: false}), stderr: ""})
            }});
        assert.throws(() => rejected.inspectCandidate({request: {candidate: {path: `${ROOT}\\MySpeed.exe`,
            bytes: "524288", sha256: SHA("d")}}}), /identity output differs/u);
    });

    it("rejects misspelled runtime dependency overrides", () => {
        assert.throws(() => createWindowsBaselineGuestRuntime({
            powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            wrapper: {path: `${ROOT}\\guest-wrapper.ps1`, sha256: SHA("a")},
            candidateController: {path: `${ROOT}\\candidate-controller.ps1`, sha256: SHA("b")},
            cleanStopController: {path: `${ROOT}\\clean-stop.ps1`, sha256: SHA("c")},
            network: {hardwareNics: 0, enabledNonLoopbackInterfaces: 0, nonLoopbackRoutes: 0},
            dependencies: {readPublisedJson: async () => ({})}
        }), /dependencies differ/u);
    });

    it("preserves bounded inspection stderr and spawn errors without accepting failure", () => {
        const maximumFailureCharacters = 512;
        const firstPrintableCharacter = 32;
        const deleteCharacter = 127;
        const cases = [
            {status: 1, signal: null, stderr: "inspection sentinel\u0000\r\nfailed"},
            {status: null, signal: null, stderr: "", error: new Error("spawn sentinel")},
            {status: 1, signal: null, stderr: `oversize sentinel ${"x".repeat(maximumFailureCharacters * 2)}`},
            {status: 0, signal: null, stderr: "unexpected warning"}
        ];
        for (const result of cases) {
            const runtime = createWindowsBaselineGuestRuntime({powershellPath: "unused-test-powershell",
                wrapper: {path: `${ROOT}\\guest-wrapper.ps1`, sha256: SHA("a")},
                candidateController: {path: `${ROOT}\\candidate-controller.ps1`, sha256: SHA("b")},
                cleanStopController: {path: `${ROOT}\\clean-stop.ps1`, sha256: SHA("c")},
                network: {hardwareNics: 0, enabledNonLoopbackInterfaces: 0, nonLoopbackRoutes: 0},
                dependencies: {spawnSync: () => ({stdout: "", ...result})}});
            assert.throws(() => runtime.inspectCandidate({request: {candidate: {path: `${ROOT}\\MySpeed.exe`,
                bytes: "524288", sha256: SHA("d")}}}), error => {
                assert.match(error.message, /^baseline candidate identity process failed: /u);
                assert.ok(error.message.includes((result.stderr || result.error.message).split(" ")[0]));
                assert.ok(error.message.length <= maximumFailureCharacters);
                assert.ok([...error.message].every(character => character.charCodeAt(0) >= firstPrintableCharacter
                    && character.charCodeAt(0) !== deleteCharacter));
                return true;
            });
        }
    });
});
