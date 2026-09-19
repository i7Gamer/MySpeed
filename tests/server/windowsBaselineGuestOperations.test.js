import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {runWindowsBaselineGuest} from "../../scripts/qualification/windows-baseline-guest-runner.mjs";
import {createWindowsBaselineGuestOperations} from "../../scripts/qualification/windows-baseline-guest-operations.mjs";

const SHA = character => character.repeat(64);
const SOURCE_SHA = "1".repeat(40);
const EVENT_SHA = "2".repeat(40);
const CANDIDATE_SHA = "9".repeat(40);
const NONCE = "3".repeat(32);
const TASK_ROOT = `C:\\Windows\\Temp\\myspeed-baseline-${NONCE}`;
const SCENARIOS = ["populated-first-boot", "populated-restart", "fresh-no-config-reset"];
const candidatePid = scenario => 100 + SCENARIOS.indexOf(scenario);
const candidateCreationTime = scenario => (SCENARIOS.indexOf(scenario) + 10).toString(16).padStart(16, "0");
const request = () => ({schemaVersion: 1, kind: "myspeed-windows-baseline-guest-request", profile: "baseline-cpu",
    qualifying: false, context: {schemaVersion: 1, repository: "i7Gamer/MySpeed", sourceSha: SOURCE_SHA, eventSha: EVENT_SHA,
    runId: "123", runAttempt: "1", nonce: NONCE, environment: {GITHUB_ACTIONS: "true", CI: "true",
        RUNNER_OS: "Linux", RUNNER_ARCH: "X64", RUNNER_ENVIRONMENT: "github-hosted", ImageOS: "ubuntu24",
        ImageVersion: "20260901.1"}}, candidate: {artifactName: "MySpeed-windows-x64-baseline.exe",
        path: `${TASK_ROOT}\\MySpeed.exe`, sourceSha: CANDIDATE_SHA, bytes: "524288", sha256: SHA("4")}, fixture: {
        path: "D:\\fixture-bundle.json", bytes: "8192", sha256: SHA("5")}, paths: {taskRoot: TASK_ROOT,
        populatedWork: `${TASK_ROOT}\\populated`, resetWork: `${TASK_ROOT}\\reset`},
    scenarios: SCENARIOS.map((scenario, index) => ({scenario, port: 41001 + index}))});

const execution = () => ({schemaVersion: 1, kind: "myspeed-windows-baseline-guest-execution-manifest",
    sourceSha: SOURCE_SHA, eventSha: EVENT_SHA, runId: "123", runAttempt: "1", nonce: NONCE,
    imageVersion: "windows-server-2025-standard-eval", manifestSha256: SHA("6"),
    cpuModel: "Westmere-v2", cpuidProbe: {path: "D:\\cpuid.exe", bytes: "16384", sha256: SHA("9")},
    candidateSource: {path: "D:\\MySpeed.exe", bytes: "524288", sha256: SHA("4")},
    candidateController: {path: "D:\\windows-native-candidate-controller.ps1", bytes: "65536", sha256: SHA("7")},
    cleanStopController: {path: "D:\\windows-clean-stop-controller.ps1", bytes: "65536", sha256: SHA("8")},
    fixtureBundle: {path: "D:\\fixture-bundle.json", bytes: "8192", sha256: SHA("5")}});

function fixture(overrides = {}) {
    const calls = [];
    const expected = {ping: "123.456", resultId: "qualification-seed-row", passwordValueSha256: SHA("9")};
    const sessions = new Map();
    const dependencies = {
        materialize: input => { calls.push(["materialize", input]); return {expected, initialDatabase: expected}; },
        observeNetwork: () => ({hardwareNics: 0, enabledNonLoopbackInterfaces: 0, nonLoopbackRoutes: 0}),
        inspectCandidate: () => ({volumeSerial: "89abcdef", fileId: "0123456789abcdef"}),
        startController: input => { calls.push(["start", input]); const session = {request: input.request,
            child: {scenario: input.request.scenario}}; sessions.set(input.request.scenario, session); return session; },
        readReady: input => ({schemaVersion: 1, kind: "myspeed-windows-native-candidate-ready", nonce: NONCE,
            manifestSha256: SHA("6"), alias: "baseline", scenario: input.request.scenario,
            artifactLogicalName: "MySpeed-windows-x64-baseline.exe", candidateSha256: SHA("4"),
            candidatePid: candidatePid(input.request.scenario),
            candidateCreationTime: candidateCreationTime(input.request.scenario), retainedHandleAuthority: true,
            jobAssignedBeforeResume: true, handleListConfigured: true}),
        observeOwnedListener: input => ({listenerOwned: true, candidatePid: input.candidatePid,
            candidateCreationTime: input.candidateCreationTime, port: input.port}),
        checkPopulated: input => { calls.push(["http", input.port]); return {elapsedMs: 10}; },
        waitController: input => { calls.push(["wait", input.request.scenario]); return {exitCode: 0, signal: null}; },
        readResult: input => ({schemaVersion: 1, kind: "myspeed-windows-native-candidate-result",
            status: "completed", qualifying: false, releaseGatesCleared: [], alias: "baseline",
            artifactLogicalName: "MySpeed-windows-x64-baseline.exe", scenario: input.request.scenario,
            stopKind: input.request.scenario === "fresh-no-config-reset" ? "observed-exit" : "ctrl-c",
            candidatePid: candidatePid(input.request.scenario),
            candidateCreationTime: candidateCreationTime(input.request.scenario), candidateExited: true,
            exitCode: input.request.scenario === "fresh-no-config-reset" ? 113 : 0, forced: false,
            jobActiveProcesses: 0, handleCleanupAttempted: true, handlesClosed: true,
            processTreeExitProven: true, listenerGone: false, elapsedMs: 100, failures: []}),
        observeListener: input => { calls.push(["listener", input.port]); return {listenerGone: true}; },
        readFailedResult: input => { calls.push(["failed-result", input.request.scenario]); return {result: null,
            resultFailure: "", stdout: "", stderr: "", captureFailure: ""}; },
        stopController: input => { calls.push(["stop-controller", input.request.scenario]); return {killAttempted: true}; },
        writeStop: input => { calls.push(["stop", input.request.scenario, input.value]); },
        checkPopulatedDatabase: () => expected,
        checkResetDatabase: () => ({integrity: "ok", configTable: false}),
        cleanup: input => { calls.push(["cleanup", input]); return {cleanupProven: true}; },
        ...overrides
    };
    return {calls, operations: createWindowsBaselineGuestOperations({request: request(), execution: execution(),
        dependencies})};
}

describe("Windows baseline guest native operations bridge", () => {
    it("materializes exact inputs and binds three controller lifecycles", async () => {
        const value = fixture();
        const result = await runWindowsBaselineGuest(request(), value.operations);
        assert.equal(result.status, "observed", result.failure);
        const starts = value.calls.filter(call => call[0] === "start").map(call => call[1].request);
        assert.deepEqual(starts.map(item => item.scenario), SCENARIOS);
        assert.deepEqual(starts.map(item => item.arguments), [[], [], ["--reset-password"]]);
        assert.ok(starts.every(item => item.alias === "baseline" && item.candidatePath === request().candidate.path));
        assert.ok(starts.every(item => item.taskRoot === TASK_ROOT));
        assert.deepEqual(value.calls.filter(call => call[0] === "stop").map(call => call[1]), SCENARIOS.slice(0, 2));
        assert.deepEqual(value.calls.filter(call => call[0] === "listener").map(call => call[1]),
            [41001, 41002, 41003]);
        assert.equal(value.calls.at(-1)[0], "cleanup");
    });

    it("marks cleanup incomplete when a partially launched controller cannot be proven stopped", async () => {
        const value = fixture({waitController: async () => { throw new Error("controller wait failed"); },
            cleanup: () => ({cleanupProven: false})});
        const result = await runWindowsBaselineGuest(request(), value.operations);
        assert.equal(result.status, "failed");
        assert.equal(result.cleanupProven, false);
        assert.match(result.failure, /controller wait failed/u);
        assert.equal(value.calls.filter(call => call[0] === "stop-controller").length, 1);
    });

    it("retains bounded failed-controller details without treating them as cleanup proof", async () => {
        const value = fixture({waitController: () => ({exitCode: 1, signal: null}),
            readFailedResult: () => ({result: {schemaVersion: 1, kind: "myspeed-windows-native-candidate-result",
                status: "failed", qualifying: false, releaseGatesCleared: [], alias: "baseline",
                artifactLogicalName: "MySpeed-windows-x64-baseline.exe", scenario: SCENARIOS[0],
                stopKind: "ctrl-c", candidatePid: candidatePid(SCENARIOS[0]),
                candidateCreationTime: candidateCreationTime(SCENARIOS[0]), candidateExited: true, exitCode: 1,
                forced: true, jobActiveProcesses: 0, handleCleanupAttempted: true, handlesClosed: true,
                processTreeExitProven: true, listenerGone: false, elapsedMs: 100,
                failures: ["candidate-lifecycle-failed"], failureDetails: [
                    {phase: "lifecycle", failure: "sentinel\ncontroller failure"}
                ]}, resultFailure: "", stdout: "", stderr: "", captureFailure: ""}),
            cleanup: () => ({cleanupProven: false})});
        const result = await runWindowsBaselineGuest(request(), value.operations);
        assert.equal(result.status, "failed");
        assert.equal(result.cleanupProven, false);
        assert.match(result.failure, /sentinel controller failure/u);
    });

    it("retains bounded wrapper stderr when the failed result is absent or malformed", async () => {
        for (const resultValue of [null, {malformed: true}]) {
            const value = fixture({waitController: () => ({exitCode: 1, signal: null}),
                readFailedResult: () => ({result: resultValue, resultFailure: "missing", stdout: "",
                    stderr: `wrapper ${"x".repeat(500)}`, captureFailure: ""}),
                cleanup: () => ({cleanupProven: false})});
            const result = await runWindowsBaselineGuest(request(), value.operations);
            assert.equal(result.status, "failed");
            assert.match(result.failure, /wrapper x/u);
            assert.ok(result.failure.length <= 512);
        }
    });

    it("fails explicitly when ready is missing and never releases the retained session", async () => {
        let retained;
        const value = fixture({readReady: () => { throw new Error("ready missing"); },
            waitController: () => ({exitCode: 0, signal: null}),
            cleanup: input => { retained = input.sessions; return {cleanupProven: false}; }});
        const result = await runWindowsBaselineGuest(request(), value.operations);
        assert.equal(result.status, "failed");
        assert.match(result.failure, /ready missing/u);
        assert.equal(retained.length, 1);
    });

    it("retains a conservative cleanup obligation when controller startup throws", async () => {
        let retained = null;
        const value = fixture({startController: async () => { throw new Error("startup uncertain"); },
            cleanup: input => { retained = input.sessions; return {cleanupProven: false}; }});
        const result = await runWindowsBaselineGuest(request(), value.operations);
        assert.equal(result.status, "failed");
        assert.equal(result.cleanupProven, false);
        assert.match(result.failure, /startup uncertain/u);
        assert.equal(retained.length, 1);
        assert.equal(retained[0].startAttempted, true);
        assert.equal(retained[0].started, null);
    });

    it("rejects resealed ready and lifecycle records that do not bind the shared controller proof", async () => {
        const baseReady = scenario => ({schemaVersion: 1, kind: "myspeed-windows-native-candidate-ready",
            nonce: NONCE, manifestSha256: SHA("6"), alias: "baseline", scenario,
            artifactLogicalName: "MySpeed-windows-x64-baseline.exe", candidateSha256: SHA("4"),
            candidatePid: candidatePid(scenario), candidateCreationTime: candidateCreationTime(scenario),
            retainedHandleAuthority: true, jobAssignedBeforeResume: true, handleListConfigured: true});
        const baseResult = scenario => ({schemaVersion: 1, kind: "myspeed-windows-native-candidate-result",
            status: "completed", qualifying: false, releaseGatesCleared: [], alias: "baseline",
            artifactLogicalName: "MySpeed-windows-x64-baseline.exe", scenario,
            stopKind: scenario === "fresh-no-config-reset" ? "observed-exit" : "ctrl-c",
            candidatePid: candidatePid(scenario), candidateCreationTime: candidateCreationTime(scenario),
            candidateExited: true, exitCode: scenario === "fresh-no-config-reset" ? 113 : 0, forced: false,
            jobActiveProcesses: 0, handleCleanupAttempted: true, handlesClosed: true,
            processTreeExitProven: true, listenerGone: false, elapsedMs: 100, failures: []});
        for (const override of [
            {readReady: input => ({...baseReady(input.request.scenario), nonce: "f".repeat(32)})},
            {readReady: input => ({...baseReady(input.request.scenario), retainedHandleAuthority: false})},
            {readResult: input => ({...baseResult(input.request.scenario), candidatePid: 999})},
            {readResult: input => ({...baseResult(input.request.scenario), processTreeExitProven: false})},
            {readResult: input => ({...baseResult(input.request.scenario), releaseGatesCleared: ["cpu"]})},
            {observeListener: () => ({listenerGone: false})}
        ]) {
            const value = fixture(override);
            const result = await runWindowsBaselineGuest(request(), value.operations);
            assert.equal(result.status, "failed");
            assert.equal(result.cleanupProven, false);
        }
    });
});
