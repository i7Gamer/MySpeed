import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {runWindowsBaselineGuest} from "../../scripts/qualification/windows-baseline-guest-runner.mjs";

const SHA = character => character.repeat(64);
const SOURCE_SHA = "1".repeat(40);
const EVENT_SHA = "2".repeat(40);
const NONCE = "3".repeat(32);
const SCENARIOS = ["populated-first-boot", "populated-restart", "fresh-no-config-reset"];
const request = () => ({schemaVersion: 1, kind: "myspeed-windows-baseline-guest-request", profile: "baseline-cpu",
    qualifying: false, context: {sourceSha: SOURCE_SHA, eventSha: EVENT_SHA, runId: "123", runAttempt: "1",
        nonce: NONCE}, candidate: {artifactName: "MySpeed-windows-x64-baseline.exe",
        path: "D:\\MySpeed.exe", bytes: "524288", sha256: SHA("4")}, fixture: {
        path: "D:\\fixture-bundle.json", bytes: "8192", sha256: SHA("5")}, paths: {
        taskRoot: `C:\\Windows\\Temp\\myspeed-baseline-${NONCE}`,
        populatedWork: `C:\\Windows\\Temp\\myspeed-baseline-${NONCE}\\populated`,
        resetWork: `C:\\Windows\\Temp\\myspeed-baseline-${NONCE}\\reset`}, scenarios: SCENARIOS.map((scenario,
        index) => ({scenario, port: 41001 + index}))});

function fixture(overrides = {}) {
    const calls = [];
    const closeProof = scenario => ({scenario, controllerLifecyclePassed: true, candidateExited: true,
        candidateExitCode: scenario === "fresh-no-config-reset" ? 113 : 0, forced: false,
        jobActiveProcesses: 0, handlesClosed: true});
    const populatedDatabase = {ping: "123.456", resultId: "qualification-seed-row",
        passwordValueSha256: SHA("6")};
    const operations = {
        async prepareFixture(input) { calls.push(["prepare", input]); return {initialDatabase: populatedDatabase,
            expected: populatedDatabase}; },
        async observeNetwork(input) { calls.push(["network", input]); return {hardwareNics: 0,
            enabledNonLoopbackInterfaces: 0, nonLoopbackRoutes: 0}; },
        async openScenario(input) { calls.push(["open", input.scenario]); return {scenario: input.scenario}; },
        async awaitReady(input) { calls.push(["ready", input.session.scenario]); return {candidatePid: 100,
            candidateCreationTime: "7".repeat(16)}; },
        async checkPopulated(input) { calls.push(["http", input.scenario]); return {elapsedMs: 10}; },
        async closeScenario(input) { calls.push(["close", input.session.scenario]); return closeProof(input.session.scenario); },
        async checkPopulatedDatabase(input) { calls.push(["database", input.scenario]); return populatedDatabase; },
        async checkResetDatabase(input) { calls.push(["reset-database", input.scenario]); return {integrity: "ok",
            configTable: false}; },
        async cleanupFixture(input) { calls.push(["cleanup", input.openAttempted]); return {cleanupProven: true}; },
        ...overrides
    };
    return {calls, operations};
}

describe("Windows baseline guest runner", () => {
    it("runs the exact full-runtime sequence and returns verifier evidence", async () => {
        const value = fixture();
        const result = await runWindowsBaselineGuest(request(), value.operations);
        assert.equal(result.status, "observed", result.failure);
        assert.equal(result.summary.status, "passed");
        assert.deepEqual(result.summary.processes.map(record => record.scenario), SCENARIOS);
        assert.deepEqual(result.summary.databaseChecks.map(record => record.scenario), ["preseeded-input",
            "after-first-shutdown", "after-second-shutdown", "fresh-no-config-reset"]);
        assert.deepEqual(result.summary.openGraphChecks.map(record => record.scenario), SCENARIOS.slice(0, 2));
        assert.deepEqual(result.summary.shutdownProofs.map(record => record.candidateExitCode), [0, 0, 113]);
        assert.deepEqual(value.calls.map(call => call[0]), ["prepare", "network", "open", "ready", "http",
            "close", "database", "open", "ready", "http", "close", "database", "open", "ready", "close",
            "reset-database", "cleanup"]);
    });

    it("closes a partially opened scenario and cleans the fixture before failing", async () => {
        let opens = 0;
        const value = fixture({async awaitReady() { if (++opens === 2) throw new Error("ready failed");
            return {candidatePid: 100, candidateCreationTime: "7".repeat(16)}; }});
        const result = await runWindowsBaselineGuest(request(), value.operations);
        assert.equal(result.status, "failed");
        assert.match(result.failure, /ready failed/u);
        assert.equal(value.calls.filter(call => call[0] === "close").length, 2);
        assert.deepEqual(value.calls.at(-1), ["cleanup", true]);
        assert.equal(result.cleanupProven, true);
    });

    it("never reports cleanup when close or fixture cleanup is incomplete", async () => {
        for (const operations of [
            {async closeScenario(input) { return {scenario: input.session.scenario,
                controllerLifecyclePassed: true, candidateExited: true,
                candidateExitCode: input.session.scenario === "fresh-no-config-reset" ? 113 : 0,
                forced: false, jobActiveProcesses: 0, handlesClosed: false}; }},
            {async cleanupFixture() { return {cleanupProven: false}; }}
        ]) {
            const value = fixture(operations);
            const result = await runWindowsBaselineGuest(request(), value.operations);
            assert.equal(result.status, "failed");
            assert.equal(result.cleanupProven, false);
        }
    });

    it("rejects modern CPU, wrong reset port order, and extra operations before opening", async () => {
        for (const mutate of [
            value => { value.profile = "modern-msi"; },
            value => { value.scenarios[2].port = value.scenarios[1].port; }
        ]) {
            const input = request(); mutate(input); const value = fixture();
            const result = await runWindowsBaselineGuest(input, value.operations);
            assert.equal(result.status, "failed");
            assert.equal(value.calls.length, 0);
        }
        const value = fixture();
        const result = await runWindowsBaselineGuest(request(), {...value.operations, extra: async () => undefined});
        assert.equal(result.status, "failed");
        assert.equal(value.calls.length, 0);
    });

    it("rejects scenario labels without concrete HTTP and SQLite receipts", async () => {
        for (const overrides of [
            {async checkPopulated() { return {}; }},
            {async checkPopulatedDatabase() { return {}; }},
            {async checkResetDatabase() { return {}; }}
        ]) {
            const value = fixture(overrides);
            const result = await runWindowsBaselineGuest(request(), value.operations);
            assert.equal(result.status, "failed");
        }
    });
});

