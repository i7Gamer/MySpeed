import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {buildWindowsBaselineGuestSeedDocuments} from "../../scripts/qualification/windows-baseline-guest-seed-documents.mjs";
import {createWindowsBaselineGuestOperations} from "../../scripts/qualification/windows-baseline-guest-operations.mjs";
import {runWindowsBaselineGuest} from "../../scripts/qualification/windows-baseline-guest-runner.mjs";

const SOURCE_SHA = "1".repeat(40);
const EVENT_SHA = "2".repeat(40);
const CANDIDATE_SHA = "a".repeat(40);
const NONCE = "3".repeat(32);
const SHA = character => character.repeat(64);
const CONTEXT = {sourceSha: SOURCE_SHA, eventSha: EVENT_SHA, runId: "123", runAttempt: "2", nonce: NONCE};

const input = () => ({context: {...CONTEXT}, imageVersion: "windows-server-2025-standard-eval",
    manifestSha256: SHA("4"), candidate: {artifactName: "MySpeed-windows-x64-baseline.exe",
        sourceSha: CANDIDATE_SHA, bytes: "524288", sha256: SHA("5")}, fixtureBundle: {bytes: "8192", sha256: SHA("6")},
    candidateController: {bytes: "65536", sha256: SHA("7")},
    cleanStopController: {bytes: "131072", sha256: SHA("8")}});

const noopDependencies = () => Object.fromEntries(["checkPopulated", "checkPopulatedDatabase",
    "checkResetDatabase", "cleanup", "inspectCandidate", "materialize", "observeListener", "observeNetwork",
    "observeOwnedListener", "readFailedResult", "readReady", "readResult", "startController", "stopController",
    "waitController", "writeStop"].map(name => [name, () => {
    throw new Error(`unused ${name}`);
}]));

describe("Windows baseline guest seed documents", () => {
    it("builds canonical documents that the actual request and execution consumers accept", async () => {
        const value = buildWindowsBaselineGuestSeedDocuments(input());
        assert.equal(value.requestRecord.name, "request.json");
        assert.equal(value.executionRecord.name, "execution.json");
        assert.equal(value.request.candidate.path,
            `C:\\Windows\\Temp\\myspeed-baseline-task-${NONCE}\\MySpeed.exe`);
        // The request carries the candidate release SHA so the guest materializer can validate the
        // candidate-stamped fixture bundle against it rather than the harness context SHA.
        assert.equal(value.request.candidate.sourceSha, CANDIDATE_SHA);
        assert.notEqual(value.request.candidate.sourceSha, value.request.context.sourceSha);
        assert.equal(value.execution.candidateSource.path,
            `C:\\Windows\\Temp\\myspeed-baseline-input-${NONCE}\\MySpeed.exe`);
        assert.equal(value.execution.fixtureBundle.path,
            `C:\\Windows\\Temp\\myspeed-baseline-input-${NONCE}\\fixture-bundle.json`);
        assert.match(value.execution.candidateController.path,
            new RegExp(`myspeed-baseline-runtime-${NONCE}\\\\scripts\\\\qualification\\\\windows-native-candidate-controller\\.ps1$`, "u"));
        createWindowsBaselineGuestOperations({request: value.request, execution: value.execution,
            dependencies: noopDependencies()});
        const operations = {
            prepareFixture: async () => ({expected: {ping: "123.456", resultId: "qualification-seed-row",
                passwordValueSha256: SHA("9")}, initialDatabase: {ping: "123.456",
                resultId: "qualification-seed-row", passwordValueSha256: SHA("9")}}),
            observeNetwork: async () => ({hardwareNics: 0, enabledNonLoopbackInterfaces: 0, nonLoopbackRoutes: 0}),
            openScenario: async ({scenario}) => ({scenario}),
            awaitReady: async () => ({candidatePid: 42, candidateCreationTime: "a".repeat(16)}),
            awaitOwnedListener: async ({ready, port}) => ({listenerOwned: true,
                candidatePid: ready.candidatePid, candidateCreationTime: ready.candidateCreationTime, port}),
            checkPopulated: async () => ({elapsedMs: 1}),
            closeScenario: async ({scenario}) => ({scenario, controllerLifecyclePassed: true, candidateExited: true,
                candidateExitCode: scenario === "fresh-no-config-reset" ? 113 : 0, forced: false,
                jobActiveProcesses: 0, handlesClosed: true}),
            checkPopulatedDatabase: async () => ({ping: "123.456", resultId: "qualification-seed-row",
                passwordValueSha256: SHA("9")}),
            checkResetDatabase: async () => ({integrity: "ok", configTable: false}),
            cleanupFixture: async () => ({cleanupProven: true})
        };
        const result = await runWindowsBaselineGuest(value.request, operations);
        assert.equal(result.status, "observed");
        assert.equal(result.cleanupProven, true);
    });

    it("rejects cross-run identities and unbounded input files before emitting bytes", () => {
        for (const mutate of [
            value => { value.candidate.artifactName = "MySpeed-windows-x64.exe"; },
            value => { value.fixtureBundle.bytes = "67108865"; },
            value => { value.context.runAttempt = "0"; },
            value => { value.manifestSha256 = `${SHA("4")}\n`; },
            value => { value.candidate.sourceSha = SOURCE_SHA; },
            value => { value.candidate.sourceSha = "not-a-sha"; },
            value => { delete value.candidate.sourceSha; }
        ]) {
            const value = input(); mutate(value);
            assert.throws(() => buildWindowsBaselineGuestSeedDocuments(value));
        }
    });
});
