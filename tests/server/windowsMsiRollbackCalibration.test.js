import {describe, it} from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SCRIPT = path.resolve("scripts/qualification/windows-msi-rollback-calibration.ps1");
const SCRIPT_BYTES = fs.readFileSync(SCRIPT);
const SCRIPT_SHA256 = crypto.createHash("sha256").update(SCRIPT_BYTES).digest("hex");
const POWERSHELL = process.platform === "win32"
    ? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : "pwsh";
const PROCESS_TIMEOUT_MS = 10_000;
const TEST_TIMEOUT_MS = 30_000;
const HAS_POWERSHELL = process.platform === "win32" ||
    childProcess.spawnSync(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"],
        {encoding: "utf8", timeout: PROCESS_TIMEOUT_MS}).status === 0;
const boundedTest = (name, fn) => it(name, {timeout: TEST_TIMEOUT_MS,
    skip: !HAS_POWERSHELL && "PowerShell unavailable"}, fn);
const NONCE = "0123456789abcdef0123456789abcdef";
const ACTIONSTART = 0x08000000;
const ACTIONDATA = 0x09000000;
const INSTALLSTART = 0x1A000000;
const INSTALLEND = 0x1B000000;
const OBSOLETE_INSTALLSTART = 0x10000000;
const OBSOLETE_INSTALLEND = 0x11000000;
const ERROR_RETRY_CANCEL = 0x01000005;
const REQUIRED_CALLBACK_MESSAGE_FILTER = 0x0C000303;
const UINT32_MAX = 0xFFFFFFFF;
const callbackRecords = () => [
    {messageTypeCode: ACTIONSTART, fieldCount: 3,
        fields: ["RemoveExistingProducts", "Removing applications", ""], field1Integer: null},
    {messageTypeCode: ACTIONDATA, fieldCount: 1,
        fields: ["{1716C600-7C5B-45CB-89F1-584214207169}"], field1Integer: null},
    {messageTypeCode: ACTIONSTART, fieldCount: 3,
        fields: ["InstallValidate", "Validating install", ""], field1Integer: null},
    {messageTypeCode: ACTIONSTART, fieldCount: 3,
        fields: ["InstallFiles", "Copying new files", "File: [1]"], field1Integer: null},
    {messageTypeCode: ACTIONDATA, fieldCount: 9,
        fields: ["RollbackPayloadFile", "", "", "", "", "10", "", "", "RollbackRoot"],
        field1Integer: null},
    {messageTypeCode: ERROR_RETRY_CANCEL, fieldCount: 2,
        fields: ["1304", "C:\\ProgramData\\owned\\rollback-payload.txt"], field1Integer: 1304}
];

const invoke = (mode, input) => childProcess.spawnSync(POWERSHELL, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", SCRIPT, "-Mode", mode, "-InputJson", JSON.stringify(input)
], {encoding: "utf8", timeout: PROCESS_TIMEOUT_MS});

const run = (mode, input) => {
    const result = invoke(mode, input);
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return JSON.parse(result.stdout);
};

const simulation = () => ({
    request: {msiPath: "C:\\owned\\candidate.msi", logPath: "C:\\owned\\rollback.log",
        propertyString: "REBOOT=ReallySuppress"},
    facts: {
        setInternalUiNone: {previousLevel: 5, previousOwner: 0, noneApplied: true},
        setExternalHandler: {errorCode: 0, previousHandlerPresent: false, previousHandlerToken: null},
        enableLog: {errorCode: 0},
        installProduct: {returnCode: 1602},
        disableLog: {errorCode: 0},
        restoreExternalHandler: {errorCode: 0, currentHandlerDisabled: true, restoredPreviousContext: true},
        restoreInternalUi: {restored: true},
        callbackEvidence: {
            delegateRetainedThroughInstallCall: true,
            msiOwnedRecordCloseAttempted: false,
            securityRestoredBeforeCancel: true,
            errorSignatureAssumed: false,
            callbackFailure: null,
            records: callbackRecords()
        }
    }
});

describe("sacrificial MSI rollback calibration harness", () => {
    boundedTest("renders two data-only related MSI fixtures with exact owned identities", () => {
        const value = run("GetFixtures", {nonce: NONCE});
        assert.equal(value.schemaVersion, 1);
        assert.equal(value.qualifying, false);
        assert.equal(value.nativeExecutionAuthorized, false);
        assert.equal(value.fixtures.length, 2);
        assert.deepEqual(value.fixtures.map(({role, version}) => [role, version]),
            [["predecessor", "1.0.0"], ["candidate", "2.0.0"]]);
        assert.equal(new Set(value.fixtures.map(({productCode}) => productCode)).size, 2);
        assert.equal(new Set(value.fixtures.map(({packageCode}) => packageCode)).size, 2);
        assert.equal(new Set(value.fixtures.map(({upgradeCode}) => upgradeCode)).size, 1);
        assert.equal(new Set(value.fixtures.map(({componentCode}) => componentCode)).size, 1);
        assert.equal(new Set(value.fixtures.map(({payload}) => payload.fileName)).size, 1,
            "the stable component key path changed across product versions");
        assert.equal(value.ownedTarget.requiresPreexistingDirectory, true);
        assert.equal(value.ownedTarget.requiresSentinel, true);
        assert.match(value.ownedTarget.relativeDirectory, new RegExp(NONCE));
        assert.equal(value.ownedTarget.payloadFile, value.fixtures[0].payload.fileName);
        assert.notEqual(value.fixtures[0].payload.sha256, value.fixtures[1].payload.sha256);
        for (const fixture of value.fixtures) {
            assert.match(fixture.wixSource, /InstallScope="perMachine"/);
            assert.match(fixture.wixSource, new RegExp(NONCE));
            assert.match(fixture.wixSource, /<File\b[^>]*KeyPath="yes"/);
            assert.doesNotMatch(fixture.wixSource, /CustomAction|ServiceInstall|ServiceControl|Registry/i);
            assert.equal(fixture.payload.encoding, "utf8");
            assert.ok(fixture.payload.text.endsWith("\n"));
            assert.match(fixture.wixSourceSha256, /^[0-9a-f]{64}$/);
            assert.match(fixture.payload.sha256, /^[0-9a-f]{64}$/);
            assert.equal(fixture.payload.bytes, Buffer.byteLength(fixture.payload.text, "utf8"));
            assert.equal(fixture.wixSourceSha256,
                crypto.createHash("sha256").update(fixture.wixSource, "utf8").digest("hex"));
            assert.equal(fixture.payload.sha256,
                crypto.createHash("sha256").update(fixture.payload.text, "utf8").digest("hex"));
        }
        assert.doesNotMatch(value.fixtures[0].wixSource, /<MajorUpgrade/);
        assert.match(value.fixtures[1].wixSource,
            /<MajorUpgrade\b[^>]*Schedule="afterInstallInitialize"/);
    });

    boundedTest("rejects noncanonical fixture nonces without writing files", () => {
        for (const nonce of ["ABC", `${NONCE}0`, [NONCE], "../owned", ""])
            assert.notEqual(invoke("GetFixtures", {nonce}).status, 0);
    });

    boundedTest("recreates quiet, restart-suppressed, flushed verbose logging and restores process UI", () => {
        const result = run("SimulateController", simulation());
        assert.deepEqual(result.operationCalls, ["set-internal-ui-none", "set-external-record-handler",
            "enable-log", "install-product", "disable-log", "restore-external-record-handler",
            "restore-internal-ui"]);
        assert.equal(result.installInvoked, true);
        assert.equal(result.installReturnCode, 1602);
        assert.equal(result.internalUiRestored, true);
        assert.equal(result.externalHandlerRestored, true);
        assert.equal(result.loggingDisabled, true);
        assert.equal(result.callbackReferenceRetainedThroughInstallCall, true);
        assert.deepEqual(result.callbackEvidence, {
            delegateRetainedThroughInstallCall: true,
            msiOwnedRecordCloseAttempted: false,
            securityRestoredBeforeCancel: true,
            errorSignatureAssumed: false,
            callbackFailure: null,
            records: callbackRecords()
        });
        assert.equal(result.callbackTimeline.errorSignatureCalibrated, false);
        assert.equal(result.callbackTimeline.records.length, callbackRecords().length);
        assert.equal(result.qualifying, false);
        assert.equal(result.requestedCallbackMessageFilter, REQUIRED_CALLBACK_MESSAGE_FILTER);
        assert.deepEqual(result.releaseGatesCleared, []);
        assert.deepEqual(result.requestedSemantics, {internalUi: "INSTALLUILEVEL_NONE",
            logModes: ["VERBOSE", "EXTRADEBUG"], logAttributes: ["FLUSHEACHLINE"],
            callbackMessages: ["FATALEXIT", "ERROR", "ACTIONSTART", "ACTIONDATA", "INSTALLSTART", "INSTALLEND"],
            properties: "REBOOT=ReallySuppress"});
    });

    boundedTest("refuses a previous record handler without claiming its unavailable context was restored", () => {
        const input = simulation();
        input.facts.setExternalHandler.previousHandlerPresent = true;
        input.facts.setExternalHandler.previousHandlerToken = 123;
        input.facts.restoreExternalHandler.restoredPreviousContext = false;
        const result = run("SimulateController", input);
        assert.equal(result.installInvoked, false);
        assert.deepEqual(result.operationCalls, ["set-internal-ui-none", "set-external-record-handler",
            "restore-external-record-handler", "restore-internal-ui"]);
        assert.match(result.primaryFailure, /previous external record handler/i);
        assert.equal(result.externalHandlerRestored, false);
        assert.equal(result.calibrationHandlerDisabled, true);
        assert.equal(result.dedicatedProcessExitRequired, true);
        assert.equal(result.internalUiRestored, true);
    });

    boundedTest("preserves primary and cleanup failures and never reports restoration from failed calls", () => {
        const input = simulation();
        input.facts.installProduct.returnCode = 1603;
        input.facts.disableLog.errorCode = 5;
        input.facts.restoreExternalHandler.errorCode = 6;
        input.facts.restoreInternalUi.restored = false;
        const result = run("SimulateController", input);
        assert.match(result.primaryFailure, /install product returned 1603/i);
        assert.deepEqual(result.cleanupFailures, ["disable-log:5", "restore-external-record-handler:6",
            "restore-internal-ui"]);
        assert.equal(result.loggingDisabled, false);
        assert.equal(result.externalHandlerRestored, false);
        assert.equal(result.internalUiRestored, false);
        assert.equal(result.accepted, false);
    });

    boundedTest("rejects an unproven external-handler restoration after an otherwise successful simulation", () => {
        const input = simulation();
        input.facts.restoreExternalHandler.restoredPreviousContext = false;
        const result = run("SimulateController", input);
        assert.equal(result.accepted, false);
        assert.deepEqual(result.cleanupFailures, ["restore-external-record-handler:unproven"]);
        assert.equal(result.externalHandlerRestored, false);
    });

    boundedTest("rejects callback evidence that assumes the uncalibrated native error signature", () => {
        const input = simulation();
        input.facts.callbackEvidence.errorSignatureAssumed = true;
        const result = run("SimulateController", input);
        assert.equal(result.accepted, false);
        assert.match(result.primaryFailure, /callback lifetime, record ownership, or synchronous restoration/i);
        assert.equal(result.externalHandlerRestored, true);
        assert.equal(result.internalUiRestored, true);
    });

    boundedTest("rejects a latched native callback failure regardless of the installer return", () => {
        const input = simulation();
        input.facts.callbackEvidence.callbackFailure = "callback-record-or-observer-failure";
        const result = run("SimulateController", input);
        assert.equal(result.accepted, false);
        assert.match(result.primaryFailure, /callback lifetime, record ownership, or synchronous restoration/i);
        assert.equal(result.installReturnCode, 1602);
    });

    boundedTest("latches callback snapshot and observer failures without crossing the callback boundary", () => {
        const success = run("SimulateCallbackBridge", {failureAt: "none"});
        assert.deepEqual(success, {response: 2, callbackFailure: null, calls: ["snapshot", "observer"]});
        const snapshot = run("SimulateCallbackBridge", {failureAt: "snapshot"});
        assert.deepEqual(snapshot, {response: -1, callbackFailure: "callback-record-or-observer-failure",
            calls: ["snapshot"]});
        const observer = run("SimulateCallbackBridge", {failureAt: "observer"});
        assert.deepEqual(observer, {response: -1, callbackFailure: "callback-record-or-observer-failure",
            calls: ["snapshot", "observer"]});
    });

    boundedTest("does not accept scalar callback claims that omit record ownership or synchronous restoration", () => {
        for (const [name, value] of [
            ["delegateRetainedThroughInstallCall", false],
            ["msiOwnedRecordCloseAttempted", true],
            ["securityRestoredBeforeCancel", false],
            ["errorSignatureAssumed", true]
        ]) {
            const input = simulation();
            input.facts.callbackEvidence[name] = value;
            const result = run("SimulateController", input);
            assert.equal(result.accepted, false, name);
            assert.match(result.primaryFailure, /callback lifetime|record ownership|synchronous restoration/i);
        }
    });

    boundedTest("preserves bounded typed callback records and nested action order without assuming an error signature", () => {
        const records = callbackRecords();
        const value = run("NormalizeTimeline", {records});
        assert.equal(value.qualifying, false);
        assert.equal(value.nativeExecutionAuthorized, false);
        assert.equal(value.errorSignatureCalibrated, false);
        assert.deepEqual(value.records.map(({sequence, messageClass, messageStyle}) =>
            [sequence, messageClass, messageStyle]), [
            [0, "ACTIONSTART", 0], [1, "ACTIONDATA", 0], [2, "ACTIONSTART", 0],
            [3, "ACTIONSTART", 0], [4, "ACTIONDATA", 0], [5, "ERROR", 5]
        ]);
        assert.deepEqual(value.records[5].fields, records[5].fields);
        assert.equal(value.records[5].field1Integer, 1304);
    });

    boundedTest("accepts canonical typed install start/end classes and rejects obsolete fake class values", () => {
        const typed = [
            {messageTypeCode: INSTALLSTART, fieldCount: 1, fields: ["candidate.msi"], field1Integer: null},
            {messageTypeCode: INSTALLEND, fieldCount: 1, fields: ["candidate.msi"], field1Integer: null}
        ];
        const value = run("NormalizeTimeline", {records: typed});
        assert.deepEqual(value.records.map(({messageClass, messageTypeCode}) => [messageClass, messageTypeCode]),
            [["INSTALLSTART", INSTALLSTART], ["INSTALLEND", INSTALLEND]]);
        for (const messageTypeCode of [OBSOLETE_INSTALLSTART, OBSOLETE_INSTALLEND]) {
            assert.notEqual(invoke("NormalizeTimeline", {records: [
                {messageTypeCode, fieldCount: 1, fields: ["candidate.msi"], field1Integer: null}
            ]}).status, 0);
        }
    });

    boundedTest("rejects malformed or oversized callback timelines", () => {
        const valid = {messageTypeCode: ACTIONSTART, fieldCount: 3,
            fields: ["InstallFiles", "Copying", "Template"], field1Integer: null};
        for (const records of [
            [],
            [Object.assign({}, valid, {fieldCount: 2})],
            [Object.assign({}, valid, {messageTypeCode: 0x02000000})],
            [Object.assign({}, valid, {fields: ["x".repeat(4097)], fieldCount: 1})],
            Array.from({length: 257}, () => valid)
        ]) assert.notEqual(invoke("NormalizeTimeline", {records}).status, 0);
    });

    boundedTest("fails closed at each setup stage and restores only acquired process-wide state", () => {
        const uiFailure = simulation();
        uiFailure.facts.setInternalUiNone.noneApplied = false;
        const uiResult = run("SimulateController", uiFailure);
        assert.deepEqual(uiResult.operationCalls, ["set-internal-ui-none", "restore-internal-ui"]);
        assert.equal(uiResult.installInvoked, false);

        const handlerFailure = simulation();
        handlerFailure.facts.setExternalHandler.errorCode = 5;
        const handlerResult = run("SimulateController", handlerFailure);
        assert.deepEqual(handlerResult.operationCalls,
            ["set-internal-ui-none", "set-external-record-handler", "restore-internal-ui"]);

        const logFailure = simulation();
        logFailure.facts.enableLog.errorCode = 87;
        const logResult = run("SimulateController", logFailure);
        assert.deepEqual(logResult.operationCalls, ["set-internal-ui-none", "set-external-record-handler",
            "enable-log", "restore-external-record-handler", "restore-internal-ui"]);
    });

    boundedTest("continues every process-wide restoration after individual cleanup callbacks throw", () => {
        const encoded = Buffer.from(JSON.stringify(simulation()), "utf8").toString("base64");
        const escaped = SCRIPT.replaceAll("'", "''");
        const command = [
            `. '${escaped}'`,
            `$input=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))|ConvertFrom-Json`,
            `$facts=$input.facts`,
            `$operations=[pscustomobject]@{`,
            `setInternalUiNone={return $facts.setInternalUiNone}.GetNewClosure()`,
            `setExternalHandler={param($root)return $facts.setExternalHandler}.GetNewClosure()`,
            `enableLog={param($path,$modes,$attributes)return $facts.enableLog}.GetNewClosure()`,
            `installProduct={param($path,$properties)return $facts.installProduct}.GetNewClosure()`,
            `disableLog={throw 'synthetic disable failure'}`,
            `restoreExternalHandler={throw 'synthetic handler failure'}`,
            `restoreInternalUi={throw 'synthetic UI failure'}`,
            `callbackEvidence=$facts.callbackEvidence}`,
            `Invoke-MyspeedMsiCalibrationController $input.request $operations|ConvertTo-Json -Depth 12 -Compress`
        ].join("\n");
        const invoked = childProcess.spawnSync(POWERSHELL,
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
            {encoding: "utf8", timeout: PROCESS_TIMEOUT_MS});
        assert.equal(invoked.status, 0, `${invoked.stdout}\n${invoked.stderr}`);
        const result = JSON.parse(invoked.stdout);
        assert.deepEqual(result.operationCalls.slice(-3), ["disable-log", "restore-external-record-handler",
            "restore-internal-ui"]);
        assert.deepEqual(result.cleanupFailures, ["disable-log:exception",
            "restore-external-record-handler:exception", "restore-internal-ui:exception"]);
        assert.equal(result.accepted, false);
    });

    boundedTest("rejects the native factory before Add-Type outside the exact hosted context", () => {
        const escaped = SCRIPT.replaceAll("'", "''");
        const command = [
            `$env:GITHUB_ACTIONS='false'`,
            `function global:Add-Type { throw 'ADD_TYPE_REACHED' }`,
            `. '${escaped}'`,
            `$manifest=[pscustomobject]@{schemaVersion=1;kind='myspeed-msi-sacrificial-calibration-closure';`,
            `expectedRunId='1';expectedRunAttempt='1';expectedEventSha=('a'*40);expectedSourceSha=('b'*40);`,
            `nonce=('c'*32);files=@([pscustomobject]@{name='windows-msi-rollback-calibration.ps1';`,
            `bytes=${SCRIPT_BYTES.length};sha256='${SCRIPT_SHA256}'})}`,
            `$expected=[pscustomobject]@{runId='1';runAttempt='1';eventSha=('a'*40);sourceSha=('b'*40);`,
            `nonce=('c'*32);imageVersion='synthetic';manifest=$manifest}`,
            `try { New-MyspeedMsiCalibrationNativeOperations $expected; exit 9 } catch {`,
            `if ($_.Exception.Message -match 'ADD_TYPE_REACHED') { exit 8 }`,
            `if ($_.Exception.Message -notmatch 'fresh hosted context') { exit 7 }`,
            `exit 0 }`
        ].join("; ");
        const result = childProcess.spawnSync(POWERSHELL,
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
            {encoding: "utf8", timeout: PROCESS_TIMEOUT_MS});
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    });

    boundedTest("rejects a valid-looking manifest whose source binding differs before Add-Type", () => {
        const escaped = SCRIPT.replaceAll("'", "''");
        const command = [
            `function global:Add-Type { throw 'ADD_TYPE_REACHED' }`,
            `. '${escaped}'`,
            `$manifest=[pscustomobject]@{schemaVersion=1;kind='myspeed-msi-sacrificial-calibration-closure';`,
            `expectedRunId='1';expectedRunAttempt='1';expectedEventSha=('a'*40);expectedSourceSha=('d'*40);`,
            `nonce=('c'*32);files=@([pscustomobject]@{name='windows-msi-rollback-calibration.ps1';`,
            `bytes=${SCRIPT_BYTES.length};sha256='${SCRIPT_SHA256}'})}`,
            `$expected=[pscustomobject]@{runId='1';runAttempt='1';eventSha=('a'*40);sourceSha=('b'*40);`,
            `nonce=('c'*32);imageVersion='synthetic';manifest=$manifest}`,
            `try { New-MyspeedMsiCalibrationNativeOperations $expected; exit 9 } catch {`,
            `if ($_.Exception.Message -match 'ADD_TYPE_REACHED') { exit 8 }`,
            `if ($_.Exception.Message -notmatch 'manifest binding') { exit 7 }`,
            `exit 0 }`
        ].join("; ");
        const result = childProcess.spawnSync(POWERSHELL,
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
            {encoding: "utf8", timeout: PROCESS_TIMEOUT_MS});
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    });

    it("keeps native ABI construction behind the hosted guard and never closes MSI-owned callback records", () => {
        const source = fs.readFileSync(SCRIPT, "utf8");
        const guard = source.indexOf("Assert-MyspeedMsiCalibrationHostedContext");
        const factory = source.indexOf("function New-MyspeedMsiCalibrationNativeOperations");
        const addType = source.indexOf("Add-Type", factory);
        assert.ok(guard >= 0 && factory > guard && addType > factory);
        for (const api of ["MsiSetExternalUIRecord", "MsiSetInternalUI", "MsiEnableLogW",
            "MsiInstallProductW", "MsiRecordGetFieldCount", "MsiRecordGetStringW", "MsiRecordGetInteger"])
            assert.match(source, new RegExp(`DllImport\\("msi\\.dll"[\\s\\S]*?${api}`));
        assert.doesNotMatch(source, /MsiCloseHandle/);
        assert.match(source, /GC\.KeepAlive/);
        assert.match(source, /MaximumRecordFields/);
        assert.match(source, /MaximumRecordFieldCharacters/);
        assert.match(source, /MsiRecordGetStringW[\s\S]*ErrorMoreData/);
        assert.match(source, /CallbackState[\s\S]*SnapshotRecord/);
        assert.match(source, /CreateRecordCallback[\s\S]*state\.Invoke/);
        assert.match(source, /RequiredMessageFilter/);
        assert.match(source, /CallbackFailureReturn = -1/);
        assert.match(source, /catch[\s\S]*LatchFailure[\s\S]*CallbackFailureReturn/);
        assert.match(source, /\\A\[1-9\]\[0-9\]\*\\z/);
        assert.match(source, /delegate int InstallUiHandlerRecord\(IntPtr context, uint messageType, uint recordHandle\)/);
        assert.match(source, /MsiRecordGetFieldCount\(uint recordHandle\)/);
        assert.match(source, /MsiRecordGetStringW\(uint recordHandle,/);
        assert.match(source, /MsiRecordGetInteger\(uint recordHandle,/);
        assert.match(source, /SnapshotRecord\(uint messageTypeCode, uint recordHandle\)/);
        assert.doesNotMatch(source, /MsiRecordGet(?:FieldCount|StringW|Integer)\(IntPtr recordHandle/);
    });

    boundedTest("passes the full unsigned MSI record-handle domain through the pure callback bridge", () => {
        const escaped = SCRIPT.replaceAll("'", "''");
        const command = [
            `. '${escaped}'`,
            `$seen=[uint32]0`,
            `$context=[pscustomobject]@{callbackFailure=$null}`,
            `$operations=[pscustomobject]@{snapshotRecord={param($messageType,$recordHandle)` +
                `$script:seen=[uint32]$recordHandle;return [pscustomobject]@{value=$recordHandle}};` +
                `observeRecord={param($context,$snapshot)return 2}}`,
            `$response=Invoke-MyspeedMsiCalibrationCallbackBridge $context 0 ([uint32]::MaxValue) $operations`,
            `[pscustomobject]@{seen=$script:seen;response=$response;failure=$context.callbackFailure}|ConvertTo-Json -Compress`
        ].join("; ");
        const result = childProcess.spawnSync(POWERSHELL,
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
            {encoding: "utf8", timeout: PROCESS_TIMEOUT_MS});
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        assert.deepEqual(JSON.parse(result.stdout), {seen: UINT32_MAX, response: 2, failure: null});
    });
});
