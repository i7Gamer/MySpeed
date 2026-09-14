import {describe, it} from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import {invokePowerShellScriptBatch} from "../helpers/powershellScriptBatch.js";

const POWERSHELL = "synthetic-powershell";
const SCRIPT = "C:\\synthetic\\fixture.ps1";
const TEMPORARY_DIRECTORY = "C:\\synthetic\\batch";
const PROCESS_TIMEOUT_MS = 10_000;
const SUCCESS_STATUS = 0;
const FAILURE_STATUS = 1;
const NONZERO_STATUS = 9;
const requests = () => [
    {mode: "First", inputJson: "{\"case\":1}"},
    {mode: "Second", inputJson: "{\"case\":2}"}
];

const mockTemporaryFiles = (context, write = () => {}) => {
    const removed = [];
    context.mock.method(fs, "mkdtempSync", () => TEMPORARY_DIRECTORY);
    context.mock.method(fs, "writeFileSync", write);
    context.mock.method(fs, "rmSync", (...arguments_) => removed.push(arguments_));
    return removed;
};

describe("PowerShell script batch test helper", () => {
    it("cleans its temporary directory when request serialization fails", context => {
        const removed = mockTemporaryFiles(context, () => assert.fail("write must not follow serialization failure"));

        assert.throws(() => invokePowerShellScriptBatch({powershell: POWERSHELL, script: SCRIPT,
            requests: [{mode: "First", inputJson: 1n}], timeout: PROCESS_TIMEOUT_MS}), /BigInt/u);
        assert.deepEqual(removed, [[TEMPORARY_DIRECTORY, {recursive: true, force: true}]]);
    });

    it("cleans its temporary directory when the request file write fails", context => {
        const failure = new Error("synthetic write failure");
        const removed = mockTemporaryFiles(context, () => { throw failure; });

        assert.throws(() => invokePowerShellScriptBatch({powershell: POWERSHELL, script: SCRIPT,
            requests: requests(), timeout: PROCESS_TIMEOUT_MS}), failure);
        assert.deepEqual(removed, [[TEMPORARY_DIRECTORY, {recursive: true, force: true}]]);
    });

    it("cleans its temporary directory when the child returns invalid JSON", context => {
        const removed = mockTemporaryFiles(context);
        context.mock.method(childProcess, "spawnSync", () => ({
            error: undefined, status: SUCCESS_STATUS, stdout: "not-json", stderr: ""
        }));

        assert.throws(() => invokePowerShellScriptBatch({powershell: POWERSHELL, script: SCRIPT,
            requests: requests(), timeout: PROCESS_TIMEOUT_MS}), SyntaxError);
        assert.deepEqual(removed, [[TEMPORARY_DIRECTORY, {recursive: true, force: true}]]);
    });

    it("preserves outer spawn errors and nonzero exits", context => {
        const spawnError = new Error("synthetic spawn failure");
        let invocation = 0;
        mockTemporaryFiles(context);
        context.mock.method(childProcess, "spawnSync", () => invocation++ === 0
            ? {error: spawnError, status: null, stdout: "", stderr: ""}
            : {error: undefined, status: NONZERO_STATUS, stdout: "partial", stderr: "failed"});

        const failedSpawn = invokePowerShellScriptBatch({powershell: POWERSHELL, script: SCRIPT,
            requests: requests(), timeout: PROCESS_TIMEOUT_MS});
        assert.equal(failedSpawn.result.error, spawnError);
        assert.equal(failedSpawn.cases, null);
        const failedExit = invokePowerShellScriptBatch({powershell: POWERSHELL, script: SCRIPT,
            requests: requests(), timeout: PROCESS_TIMEOUT_MS});
        assert.equal(failedExit.result.status, NONZERO_STATUS);
        assert.equal(failedExit.result.stderr, "failed");
        assert.equal(failedExit.cases, null);
    });

    it("uses the hardened invocation arguments and preserves per-case order", context => {
        const expectedCases = [
            {status: SUCCESS_STATUS, stdout: "first", stderr: ""},
            {status: FAILURE_STATUS, stdout: "", stderr: "second"}
        ];
        let observedArguments;
        mockTemporaryFiles(context);
        context.mock.method(childProcess, "spawnSync", (_powershell, arguments_) => {
            observedArguments = arguments_;
            return {error: undefined, status: SUCCESS_STATUS, stdout: JSON.stringify(expectedCases), stderr: ""};
        });

        const result = invokePowerShellScriptBatch({powershell: POWERSHELL, script: SCRIPT,
            requests: requests(), timeout: PROCESS_TIMEOUT_MS});
        assert.deepEqual(observedArguments.slice(0, -1), ["-NoLogo", "-NoProfile", "-NonInteractive",
            "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
        assert.deepEqual(result.cases, expectedCases);
    });
});
