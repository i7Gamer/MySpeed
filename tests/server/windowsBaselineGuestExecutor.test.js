import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {describe, it} from "node:test";

import {executeWindowsBaselineGuest} from "../../scripts/qualification/windows-baseline-guest-executor.mjs";

const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const SOURCE_SHA = "1".repeat(40);
const EVENT_SHA = "2".repeat(40);
const NONCE = "3".repeat(32);
const SCENARIOS = ["populated-first-boot", "populated-restart", "fresh-no-config-reset"];
const WINDOWS_ROOT = `C:\\Windows\\Temp\\myspeed-baseline-${NONCE}`;
const SHA = character => character.repeat(64);

function readPortableJson(identity) {
    const bytes = fs.readFileSync(identity.path);
    if (sha256(bytes) !== identity.sha256) throw new Error("portable fixture SHA differs");
    return JSON.parse(bytes.toString("utf8"));
}

function fixture() {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-baseline-executor-")));
    const request = {schemaVersion: 1, kind: "myspeed-windows-baseline-guest-request", profile: "baseline-cpu",
        qualifying: false, context: {sourceSha: SOURCE_SHA, eventSha: EVENT_SHA, runId: "123", runAttempt: "1",
            nonce: NONCE}, candidate: {}, fixture: {}, paths: {}, scenarios: []};
    const execution = {schemaVersion: 1, kind: "myspeed-windows-baseline-guest-execution-manifest",
        sourceSha: SOURCE_SHA, eventSha: EVENT_SHA, runId: "123", runAttempt: "1", nonce: NONCE,
        imageVersion: "windows-server-2025-standard-eval", manifestSha256: "4".repeat(64), candidateSource: {},
        candidateController: {}, cleanStopController: {}, fixtureBundle: {}};
    const requestBytes = Buffer.from(`${JSON.stringify(request)}\n`);
    const executionBytes = Buffer.from(`${JSON.stringify(execution)}\n`);
    const requestPath = path.join(root, "request.json"); const executionPath = path.join(root, "execution.json");
    fs.writeFileSync(requestPath, requestBytes, {flag: "wx"});
    fs.writeFileSync(executionPath, executionBytes, {flag: "wx"});
    return {root, request, execution, requestPath, executionPath, requestSha256: sha256(requestBytes),
        executionSha256: sha256(executionBytes), resultPath: path.join(root, "result.json")};
}

function actualFactoryFixture() {
    const value = fixture();
    value.request = {schemaVersion: 1, kind: "myspeed-windows-baseline-guest-request", profile: "baseline-cpu",
        qualifying: false, context: {sourceSha: SOURCE_SHA, eventSha: EVENT_SHA, runId: "123", runAttempt: "1",
            nonce: NONCE}, candidate: {artifactName: "MySpeed-windows-x64-baseline.exe",
            path: `${WINDOWS_ROOT}\\MySpeed.exe`, bytes: "524288", sha256: SHA("4")},
        fixture: {path: "D:\\fixture-bundle.json", bytes: "8192", sha256: SHA("5")},
        paths: {taskRoot: WINDOWS_ROOT, populatedWork: `${WINDOWS_ROOT}\\populated`,
            resetWork: `${WINDOWS_ROOT}\\reset`},
        scenarios: SCENARIOS.map((scenario, index) => ({scenario, port: 41001 + index}))};
    value.execution = {schemaVersion: 1, kind: "myspeed-windows-baseline-guest-execution-manifest",
        sourceSha: SOURCE_SHA, eventSha: EVENT_SHA, runId: "123", runAttempt: "1", nonce: NONCE,
        imageVersion: "windows-server-2025-standard-eval", manifestSha256: SHA("6"),
        candidateSource: {path: "D:\\MySpeed.exe", bytes: "524288", sha256: SHA("4")},
        candidateController: {path: "D:\\windows-native-candidate-controller.ps1", bytes: "65536", sha256: SHA("7")},
        cleanStopController: {path: "D:\\windows-clean-stop-controller.ps1", bytes: "65536", sha256: SHA("8")},
        fixtureBundle: {path: "D:\\fixture-bundle.json", bytes: "8192", sha256: SHA("5")}};
    const requestBytes = Buffer.from(`${JSON.stringify(value.request)}\n`);
    const executionBytes = Buffer.from(`${JSON.stringify(value.execution)}\n`);
    fs.writeFileSync(value.requestPath, requestBytes);
    fs.writeFileSync(value.executionPath, executionBytes);
    value.requestSha256 = sha256(requestBytes); value.executionSha256 = sha256(executionBytes);
    return value;
}

function candidateReady(scenario) {
    const index = SCENARIOS.indexOf(scenario);
    return {schemaVersion: 1, kind: "myspeed-windows-native-candidate-ready", nonce: NONCE,
        manifestSha256: SHA("6"), alias: "baseline", scenario,
        artifactLogicalName: "MySpeed-windows-x64-baseline.exe", candidateSha256: SHA("4"),
        candidatePid: 100 + index, candidateCreationTime: (10 + index).toString(16).padStart(16, "0"),
        retainedHandleAuthority: true, jobAssignedBeforeResume: true, handleListConfigured: true};
}

function candidateResult(scenario) {
    const ready = candidateReady(scenario);
    return {schemaVersion: 1, kind: "myspeed-windows-native-candidate-result", status: "completed",
        qualifying: false, releaseGatesCleared: [], alias: "baseline",
        artifactLogicalName: "MySpeed-windows-x64-baseline.exe", scenario,
        stopKind: scenario === "fresh-no-config-reset" ? "observed-exit" : "ctrl-c",
        candidatePid: ready.candidatePid, candidateCreationTime: ready.candidateCreationTime, candidateExited: true,
        exitCode: scenario === "fresh-no-config-reset" ? 113 : 0, forced: false, jobActiveProcesses: 0,
        handleCleanupAttempted: true, handlesClosed: true, processTreeExitProven: true, listenerGone: false,
        elapsedMs: 100, failures: []};
}

describe("Windows baseline guest executable entry", () => {
    it("passes actual runtime factory output through the actual operations and runner consumers", async () => {
        const value = actualFactoryFixture();
        const expected = {ping: "123.456", resultId: "qualification-seed-row", passwordValueSha256: SHA("9")};
        try {
            const output = await executeWindowsBaselineGuest({requestPath: value.requestPath,
                expectedRequestSha256: value.requestSha256, executionPath: value.executionPath,
                expectedExecutionSha256: value.executionSha256, resultPath: value.resultPath}, {
                assertGuest: async () => undefined,
                readJson: readPortableJson,
                runtimeConfiguration: {powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
                    dependencies: {
                        materialize: () => ({expected, initialDatabase: expected}),
                        inspectCandidate: () => ({volumeSerial: "89abcdef", fileId: "0123456789abcdef"}),
                        writeNewJson: () => SHA("a"), spawn: () => ({exitCode: 0, signalCode: null}),
                        readPublishedJson: target => {
                            const scenario = SCENARIOS.find(item => target.includes(`session-${item}`));
                            return target.endsWith("candidate.ready.json") ? candidateReady(scenario) :
                                candidateResult(scenario);
                        },
                        checkPopulated: async () => ({elapsedMs: 10}),
                        checkPopulatedDatabase: () => expected,
                        checkResetDatabase: () => ({integrity: "ok", configTable: false}),
                        observeListener: () => ({listenerGone: true}),
                        cleanup: () => ({cleanupProven: true})
                    }}
            });
            assert.equal(output.exitCode, 0, output.result.failure);
            assert.deepEqual(output.result.summary.processes.map(item => item.scenario), SCENARIOS);
            assert.deepEqual(output.result.summary.shutdownProofs.map(item => item.candidateExitCode), [0, 0, 113]);
            assert.equal(JSON.parse(fs.readFileSync(value.resultPath, "utf8")).status, "observed");
        } finally { fs.rmSync(value.root, {recursive: true, force: true}); }
    });

    it("guards the actual guest before input reads and runs the actual factory chain once", async () => {
        const value = fixture(); const calls = [];
        try {
            const result = await executeWindowsBaselineGuest({requestPath: value.requestPath,
                expectedRequestSha256: value.requestSha256, executionPath: value.executionPath,
                expectedExecutionSha256: value.executionSha256, resultPath: value.resultPath}, {
                assertGuest: async () => { calls.push("guard"); },
                readJson: (identity, label) => { calls.push(`read:${label}`);
                    return JSON.parse(fs.readFileSync(identity.path, "utf8")); },
                createRuntime: configuration => { calls.push(["runtime", configuration]); return {runtime: true}; },
                createOperations: input => { calls.push(["operations", input]); return {operations: true}; },
                runGuest: async (request, operations) => { calls.push(["run", request, operations]); return {
                    schemaVersion: 1, status: "observed", profile: "baseline-cpu", cleanupProven: true, summary: {}}; }
            });
            assert.equal(result.exitCode, 0);
            assert.deepEqual(calls.slice(0, 3), ["guard", "read:baseline guest request",
                "read:baseline guest execution manifest"]);
            assert.equal(JSON.parse(fs.readFileSync(value.resultPath, "utf8")).status, "observed");
        } finally { fs.rmSync(value.root, {recursive: true, force: true}); }
    });

    it("writes a bounded failed result and returns nonzero when execution throws", async () => {
        const value = fixture();
        try {
            const result = await executeWindowsBaselineGuest({requestPath: value.requestPath,
                expectedRequestSha256: value.requestSha256, executionPath: value.executionPath,
                expectedExecutionSha256: value.executionSha256, resultPath: value.resultPath}, {
                assertGuest: async () => undefined,
                readJson: readPortableJson,
                createRuntime: () => ({}), createOperations: () => ({}),
                runGuest: async () => { throw new Error("guest failure\nsecret trailing detail"); }
            });
            assert.equal(result.exitCode, 1);
            assert.deepEqual(JSON.parse(fs.readFileSync(value.resultPath, "utf8")), {schemaVersion: 1,
                status: "failed", profile: "baseline-cpu", cleanupProven: false,
                failure: "guest failure secret trailing detail"});
        } finally { fs.rmSync(value.root, {recursive: true, force: true}); }
    });

    it("rejects changed input bytes and an existing result without overwriting either", async () => {
        for (const mutate of [
            value => fs.appendFileSync(value.requestPath, "drift"),
            value => fs.writeFileSync(value.resultPath, "owned\n", {flag: "wx"})
        ]) {
            const value = fixture();
            try {
                mutate(value);
                const observed = await executeWindowsBaselineGuest({requestPath: value.requestPath,
                    expectedRequestSha256: value.requestSha256, executionPath: value.executionPath,
                    expectedExecutionSha256: value.executionSha256, resultPath: value.resultPath}, {
                    assertGuest: async () => undefined,
                    readJson: readPortableJson,
                    createRuntime: () => ({}), createOperations: () => ({}),
                    runGuest: async () => ({schemaVersion: 1, status: "observed", profile: "baseline-cpu",
                        cleanupProven: true, summary: {}})
                });
                assert.equal(observed.exitCode, 1);
                if (fs.existsSync(value.resultPath) && fs.readFileSync(value.resultPath, "utf8") === "owned\n")
                    assert.equal(fs.readFileSync(value.resultPath, "utf8"), "owned\n");
            } finally { fs.rmSync(value.root, {recursive: true, force: true}); }
        }
    });
});
