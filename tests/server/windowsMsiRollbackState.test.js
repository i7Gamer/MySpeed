import {describe, it} from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";

const SCRIPT = path.resolve("scripts/qualification/windows-msi-rollback-state.ps1");
const POWERSHELL = process.platform === "win32"
    ? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : "pwsh";
const TEST_TIMEOUT_MS = 30_000;
const PROCESS_TIMEOUT_MS = 10_000;
const HAS_POWERSHELL = process.platform === "win32" ||
    childProcess.spawnSync(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"],
        {encoding: "utf8", timeout: PROCESS_TIMEOUT_MS}).status === 0;
const boundedTest = (name, fn) => it(name, {timeout: TEST_TIMEOUT_MS,
    skip: !HAS_POWERSHELL && "PowerShell unavailable"}, fn);
const TARGET_PATH = "C:\\ProgramData\\MyspeedRollbackFixture\\0123456789abcdef0123456789abcdef";
const TARGET_FILE_PATH = `${TARGET_PATH}\\payload.bin`;
const OTHER_PATH = "C:\\ProgramData\\MyspeedRollbackFixture\\fedcba9876543210fedcba9876543210";
const ACE_TAG = "myspeed-rollback-0123456789abcdef0123456789abcdef";
const SECURITY_BYTES = Buffer.from("owned-noninheriting-original-security-descriptor", "utf8");
const SECURITY_SHA = crypto.createHash("sha256").update(SECURITY_BYTES).digest("hex");
const SECURITY_DESCRIPTOR = Object.freeze({ownerSid: "S-1-5-18", groupSid: "S-1-5-18",
    daclSddl: "D:P(A;;FA;;;SY)", controlFlags: 4096, inheritanceProtected: true,
    bytesBase64: SECURITY_BYTES.toString("base64"), sha256: SECURITY_SHA});
const differentSecurityDescriptor = () => {
    const bytes = Buffer.from("different-owned-security-descriptor", "utf8");
    return {...clone(SECURITY_DESCRIPTOR), bytesBase64: bytes.toString("base64"),
        sha256: crypto.createHash("sha256").update(bytes).digest("hex")};
};
const ACTIONSTART_MESSAGE = 0x0800_0000;
const ACTIONDATA_MESSAGE = 0x0900_0000;
const ERROR_RETRY_CANCEL_MESSAGE = 0x0100_0005;
const ERROR_OK_MESSAGE = 0x0100_0000;
const PREDECESSOR_PRODUCT_CODE = "{11111111-2222-3333-4444-555555555555}";
const OBSERVED_CREATE_DESTINATION_ERROR = 1310;
const OBSERVED_SYSTEM_ERROR = "0";
const ERROR_SYSTEM_PARAMETER_INDEX = 0;
const PAYLOAD_BYTES = 4096;

const clone = value => structuredClone(value);
const processFailureDetails = ({status, signal, error}) =>
    `status=${status}; signal=${signal ?? "none"}; error=${error
        ? `${error.code ?? error.name ?? "unknown"}: ${error.message}` : "none"}`;

it("reports status, signal, and spawn error for an interrupted PowerShell helper", () => {
    const details = processFailureDetails({status: null, signal: "SIGTERM",
        error: {code: "ETIMEDOUT", message: "spawnSync pwsh ETIMEDOUT"}});
    assert.match(details, /status=null/);
    assert.match(details, /signal=SIGTERM/);
    assert.match(details, /error=ETIMEDOUT: spawnSync pwsh ETIMEDOUT/);
});

it("reports absent signal and error plus a named spawn error", () => {
    assert.equal(processFailureDetails({status: 1, signal: null, error: undefined}),
        "status=1; signal=none; error=none");
    assert.match(processFailureDetails({status: null, signal: null,
        error: {name: "AbortError", message: "PowerShell aborted"}}),
    /error=AbortError: PowerShell aborted/);
});

const actionStartRecord = () => ({messageTypeCode: ACTIONSTART_MESSAGE, actionName: "InstallFiles",
    description: "Installing files", template: "File: [1], Directory: [9], Size: [6]"});
const removalActionRecord = () => ({messageTypeCode: ACTIONSTART_MESSAGE, actionName: "RemoveExistingProducts",
    description: "Removing applications", template: "Application: [1], Command line: [2]"});
const removalActionDataRecord = () => ({messageTypeCode: ACTIONDATA_MESSAGE,
    productCode: PREDECESSOR_PRODUCT_CODE});
const actionDataRecord = () => ({messageTypeCode: ACTIONDATA_MESSAGE, fileToken: "RollbackPayloadFile",
    directoryToken: "RollbackTargetDir", sizeBytes: PAYLOAD_BYTES});
const errorRecord = () => ({messageTypeCode: ERROR_RETRY_CANCEL_MESSAGE,
    errorCode: OBSERVED_CREATE_DESTINATION_ERROR,
    parameters: [OBSERVED_SYSTEM_ERROR, TARGET_FILE_PATH]});

const validSimulation = () => ({
    request: {
        schemaVersion: 1,
        kind: "myspeed-msi-sacrificial-rollback-state-request",
        targetDirectoryPath: TARGET_PATH,
        targetFilePath: TARGET_FILE_PATH,
        aceTag: ACE_TAG,
        originalSecurity: clone(SECURITY_DESCRIPTOR),
        expectedRemoveActionRecord: removalActionRecord(),
        expectedRemoveActionDataRecord: removalActionDataRecord(),
        expectedActionRecord: actionStartRecord(),
        expectedActionDataRecord: actionDataRecord(),
        expectedErrorRecord: errorRecord()
    },
    events: [
        removalActionRecord(),
        removalActionDataRecord(),
        actionStartRecord(),
        actionDataRecord(),
        errorRecord()
    ],
    operationFacts: {
        observeTarget: {targetPath: TARGET_PATH, removeExistingProductsCompleted: true,
            targetDirectoryPresent: true, targetDirectoryOwned: true, predecessorPresent: false,
            candidatePresent: false, nonInheriting: true, originalSecurity: clone(SECURITY_DESCRIPTOR)},
        applyDenyAce: {targetPath: TARGET_PATH, aceTag: ACE_TAG, applied: true},
        verifyDenyAce: {targetPath: TARGET_PATH, aceTag: ACE_TAG, denyAcePresent: true,
            denyAceCanonical: true, installerWriteDenied: true, originalSecurity: clone(SECURITY_DESCRIPTOR)},
        removeDenyAce: {targetPath: TARGET_PATH, aceTag: ACE_TAG, removed: true},
        verifyOriginalSecurity: {targetPath: TARGET_PATH, aceTag: ACE_TAG, denyAcePresent: false,
            originalSecurity: clone(SECURITY_DESCRIPTOR), ownerRestored: true, groupRestored: true,
            daclRestored: true, controlRestored: true, inheritanceRestored: true}
    },
    completion: {msiReturnCode: 1602, writeFailureObserved: true, controllerCancelIssued: true,
        rollbackObserved: true, predecessorRestored: true, candidateAbsent: true, denyAcePresent: false,
        originalSecurity: clone(SECURITY_DESCRIPTOR), manualCancellation: false}
});

const invoke = input => childProcess.spawnSync(POWERSHELL, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", SCRIPT, "-Mode", "Simulate", "-InputJson", JSON.stringify(input)
], {encoding: "utf8", timeout: PROCESS_TIMEOUT_MS});

const run = input => {
    const result = invoke(input);
    const details = processFailureDetails(result);
    assert.equal(result.error, undefined, details);
    assert.equal(result.status, 0, `${details}\n${result.stdout}\n${result.stderr}`);
    return JSON.parse(result.stdout);
};

const reject = (input, pattern) => {
    const result = invoke(input);
    const details = processFailureDetails(result);
    assert.equal(result.error, undefined, details);
    assert.notEqual(result.status, 0, `expected state helper rejection; ${details}`);
    assert.match(`${result.stdout}\n${result.stderr}`, pattern);
};

describe("sacrificial MSI rollback callback state", () => {
    boundedTest("applies and verifies the one-shot deny before IDOK, then restores before a supported cancel", () => {
        const result = run(validSimulation());
        assert.deepEqual(result.operationCalls, ["observeTarget", "applyDenyAce", "verifyDenyAce",
            "removeDenyAce", "verifyOriginalSecurity"]);
        assert.deepEqual(result.callbacks.map(({accepted, response, phase}) => ({accepted, response, phase})), [
            {accepted: true, response: "IDOK", phase: "remove-existing-products-started"},
            {accepted: true, response: "IDOK", phase: "predecessor-removal-observed"},
            {accepted: true, response: "IDOK", phase: "deny-active"},
            {accepted: true, response: "IDOK", phase: "write-target-correlated"},
            {accepted: true, response: "IDCANCEL", phase: "cancel-requested"}
        ]);
        assert.deepEqual(result.state.timeline, ["remove-existing-products-started",
            "predecessor-productcode-observed", "installfiles-verified", "deny-applied-and-verified",
            "actiondata-target-correlated", "expected-write-error", "original-security-restored",
            "rollback-completion-verified"]);
        assert.equal(result.state.denyAceMayBeActive, false);
        assert.equal(result.state.expectedErrorSeen, true);
        assert.equal(result.completion.accepted, true);
        assert.equal(result.completion.qualifying, false);
        assert.equal(result.completion.classification, "controller-cancelled-after-expected-write-error");
        assert.deepEqual(result.completion.releaseGatesCleared, []);
    });

    boundedTest("handles well-formed irrelevant action notifications without changing trigger state", () => {
        const input = validSimulation();
        input.events.unshift(
            {messageTypeCode: ACTIONSTART_MESSAGE, actionName: "CostInitialize",
                description: "Computing space requirements", template: "Costing"},
            {messageTypeCode: ACTIONDATA_MESSAGE, recordFields: ["synthetic progress"]}
        );
        const result = run(input);
        assert.equal(result.callbacks.length, 7);
        assert.ok(result.callbacks.every(({accepted}) => accepted));
        assert.equal(result.completion.accepted, true);
        assert.deepEqual(result.operationCalls, ["observeTarget", "applyDenyAce", "verifyDenyAce",
            "removeDenyAce", "verifyOriginalSecurity"]);
    });

    boundedTest("rejects an error before InstallFiles and duplicate callback records without operations", () => {
        for (const events of [
            [errorRecord()],
            [removalActionRecord(), removalActionDataRecord(), actionStartRecord(), actionStartRecord()]
        ]) {
            const input = validSimulation();
            input.events = events;
            delete input.completion;
            const result = run(input);
            assert.equal(result.callbacks.at(-1).accepted, false);
            assert.equal(result.callbacks.at(-1).response, "UNAUTHORIZED");
            assert.ok(["failed", "cleanup-required"].includes(result.state.phase));
        }
        const premature = validSimulation();
        premature.events = [premature.events[4]];
        delete premature.completion;
        assert.deepEqual(run(premature).operationCalls, []);
    });

    boundedTest("rejects wrong action, record, target, error, or unsupported abort before mutation", () => {
        const mutations = [
            input => { input.events[1].productCode = "{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}"; },
            input => { input.events[2].description = "different"; },
            input => { input.events[3].fileToken = "OtherFile"; },
            input => { input.events[3].directoryToken = "OtherDirectory"; },
            input => { input.events[3].sizeBytes += 1; },
            input => { input.events[4].errorCode += 1; },
            input => { input.events[4].parameters[ERROR_SYSTEM_PARAMETER_INDEX] = "OtherFile"; }
        ];
        for (const mutate of mutations) {
            const input = validSimulation();
            mutate(input);
            delete input.completion;
            const result = run(input);
            assert.equal(result.callbacks.at(-1).accepted, false);
            assert.equal(result.callbacks.at(-1).response, "UNAUTHORIZED");
        }
    });

    boundedTest("does not apply the ACE unless removal and target state are proven", () => {
        for (const mutate of [
            facts => { facts.removeExistingProductsCompleted = false; },
            facts => { facts.targetDirectoryPresent = false; },
            facts => { facts.targetDirectoryOwned = false; },
            facts => { facts.predecessorPresent = true; },
            facts => { facts.candidatePresent = true; },
            facts => { facts.nonInheriting = false; },
            facts => { facts.targetPath = OTHER_PATH; },
            facts => { facts.originalSecurity = differentSecurityDescriptor(); }
        ]) {
            const input = validSimulation();
            input.events = input.events.slice(0, 3);
            delete input.completion;
            mutate(input.operationFacts.observeTarget);
            const result = run(input);
            assert.deepEqual(result.operationCalls, ["observeTarget"]);
            assert.equal(result.callbacks.at(-1).response, "UNAUTHORIZED");
            assert.equal(result.state.denyAceMayBeActive, false);
        }
    });

    boundedTest("conservatively requires cleanup after partial or unverifiable ACE application", () => {
        for (const mutate of [
            facts => { facts.applyDenyAce.applied = false; },
            facts => { facts.verifyDenyAce.denyAcePresent = false; },
            facts => { facts.verifyDenyAce.denyAceCanonical = false; },
            facts => { facts.verifyDenyAce.installerWriteDenied = false; }
        ]) {
            const input = validSimulation();
            input.events = input.events.slice(0, 3);
            delete input.completion;
            mutate(input.operationFacts);
            const result = run(input);
            assert.equal(result.callbacks.at(-1).accepted, false);
            assert.equal(result.callbacks.at(-1).response, "UNAUTHORIZED");
            assert.equal(result.state.phase, "cleanup-required");
            assert.equal(result.state.denyAceMayBeActive, true);
        }
    });

    boundedTest("never authorizes abort when ACE removal or original security proof fails", () => {
        const cases = [
            facts => { facts.removed = false; },
            (_, facts) => { facts.denyAcePresent = true; },
            (_, facts) => { facts.ownerRestored = false; },
            (_, facts) => { facts.groupRestored = false; },
            (_, facts) => { facts.daclRestored = false; },
            (_, facts) => { facts.controlRestored = false; },
            (_, facts) => { facts.inheritanceRestored = false; },
            (_, facts) => { facts.originalSecurity = differentSecurityDescriptor(); }
        ];
        for (const mutate of cases) {
            const input = validSimulation();
            delete input.completion;
            mutate(input.operationFacts.removeDenyAce, input.operationFacts.verifyOriginalSecurity);
            const result = run(input);
            assert.equal(result.callbacks[4].accepted, false);
            assert.equal(result.callbacks[4].response, "UNAUTHORIZED");
            assert.notEqual(result.state.phase, "cancel-requested");
        }
    });

    boundedTest("requires a genuine nonzero rollback and restored predecessor/security completion", () => {
        const mutations = [
            completion => { completion.msiReturnCode = 0; },
            completion => { completion.msiReturnCode = 1641; },
            completion => { completion.msiReturnCode = 3010; },
            completion => { completion.msiReturnCode = 1604; },
            completion => { completion.writeFailureObserved = false; },
            completion => { completion.controllerCancelIssued = false; },
            completion => { completion.rollbackObserved = false; },
            completion => { completion.predecessorRestored = false; },
            completion => { completion.candidateAbsent = false; },
            completion => { completion.denyAcePresent = true; },
            completion => { completion.originalSecurity = differentSecurityDescriptor(); },
            completion => { completion.manualCancellation = true; }
        ];
        for (const mutate of mutations) {
            const input = validSimulation();
            mutate(input.completion);
            const result = run(input);
            assert.equal(result.completion.accepted, false);
            assert.equal(result.completion.qualifying, false);
            assert.deepEqual(result.completion.releaseGatesCleared, []);
        }
    });

    boundedTest("accepts the observed fatal install return only with the full rollback proof", () => {
        const observed = validSimulation();
        observed.completion.msiReturnCode = 1603;
        assert.equal(run(observed).completion.accepted, true);

        for (const mutate of [
            completion => { completion.writeFailureObserved = false; },
            completion => { completion.controllerCancelIssued = false; },
            completion => { completion.rollbackObserved = false; },
            completion => { completion.predecessorRestored = false; },
            completion => { completion.candidateAbsent = false; },
            completion => { completion.denyAcePresent = true; },
            completion => { completion.originalSecurity = differentSecurityDescriptor(); },
            completion => { completion.manualCancellation = true; }
        ]) {
            const input = validSimulation();
            input.completion.msiReturnCode = 1603;
            mutate(input.completion);
            assert.equal(run(input).completion.accepted, false);
        }
    });

    boundedTest("fails closed on malformed or coercible request, event, fact, and completion shapes", () => {
        for (const mutate of [
            input => { input.request.schemaVersion = "1"; },
            input => { input.request.extra = true; },
            input => { input.request.originalSecurity = "ABC"; },
            input => { input.request.targetFilePath = OTHER_PATH; },
            input => { input.request.expectedErrorRecord.errorCode = 25_001; },
            input => { input.request.expectedErrorRecord.parameters[ERROR_SYSTEM_PARAMETER_INDEX] = "5"; },
            input => { input.request.expectedErrorRecord.parameters.pop(); },
            input => { input.events[0].messageTypeCode = "134217728"; },
            input => { input.events[4].messageTypeCode = ERROR_OK_MESSAGE; },
            input => { input.events[4].parameters = "RollbackPayloadFile"; },
            input => { input.operationFacts.applyDenyAce.applied = "true"; },
            input => { input.operationFacts.verifyOriginalSecurity.extra = true; },
            input => { input.completion.msiReturnCode = 1602.5; },
            input => { input.completion.rollbackObserved = 1; }
        ]) {
            const input = validSimulation();
            mutate(input);
            reject(input, /exact|invalid|must/i);
        }
    });
});
