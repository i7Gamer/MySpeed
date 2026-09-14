import {describe, it} from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRIPT = path.resolve("scripts/qualification/windows-msi-rollback-native.ps1");
const POWERSHELL = process.platform === "win32"
    ? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : "pwsh";
const PROCESS_TIMEOUT_MS = 15_000;
const HAS_POWERSHELL = process.platform === "win32" ||
    childProcess.spawnSync(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"],
        {timeout: PROCESS_TIMEOUT_MS}).status === 0;
const boundedTest = (name, fn) => it(name, {timeout: PROCESS_TIMEOUT_MS,
    skip: !HAS_POWERSHELL && "PowerShell unavailable"}, fn);
const run = (mode, input = {}) => {
    const result = childProcess.spawnSync(POWERSHELL,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT,
            "-Mode", mode, "-InputJson", JSON.stringify(input)],
        {encoding: "utf8", timeout: PROCESS_TIMEOUT_MS});
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return JSON.parse(result.stdout);
};

describe("hosted sacrificial MSI native adapter", () => {
    boundedTest("publishes a nonqualifying exact native contract", () => {
        const contract = run("GetContract");
        assert.equal(contract.schemaVersion, 1);
        assert.equal(contract.kind, "myspeed-msi-sacrificial-native-contract");
        assert.equal(contract.qualifying, false);
        assert.equal(contract.nativeExecutionAuthorized, false);
        assert.equal(contract.requiredInstallReturn, 1602);
        assert.deepEqual(contract.requiredCallbackMessages,
            ["FATALEXIT", "ERROR", "ACTIONSTART", "ACTIONDATA", "INSTALLSTART", "INSTALLEND"]);
        assert.equal(contract.requiredCallbackFilter, 0x0C000303);
        assert.deepEqual(contract.releaseGatesCleared, []);
    });

    it("keeps native construction behind exact hosted and closure guards", () => {
        const source = fs.readFileSync(SCRIPT, "utf8");
        const guard = source.indexOf("Assert-MyspeedRollbackNativeHostedContext");
        const factory = source.indexOf("function New-MyspeedRollbackNativeOperations");
        const addType = source.indexOf("Add-Type", factory);
        assert.ok(guard >= 0 && factory > guard && addType > factory);
        assert.match(source, /expectedSourceSha/);
        assert.match(source, /expectedEventSha/);
        assert.match(source, /expectedRunAttempt/);
        assert.match(source, /windows-msi-rollback-native\.ps1/);
        assert.match(source, /windows-msi-rollback-calibration\.ps1/);
        assert.match(source, /windows-msi-rollback-state\.ps1/);
        assert.match(source, /predecessor\.msi/);
        assert.match(source, /candidate\.msi/);
        assert.match(source, /owner\.marker/);
        assert.match(source, /msi-rollback-calibration-/);
        assert.match(source, /\\A\[a-f0-9\]\{40\}\\z/);
    });

    it("declares the exact Windows Installer record callback ABI and never closes MSI-owned records", () => {
        const source = fs.readFileSync(SCRIPT, "utf8");
        assert.match(source, /delegate\s+int\s+InstallUiHandlerRecord\(IntPtr\s+context,\s*uint\s+messageType,\s*uint\s+recordHandle\)/);
        for (const api of ["MsiSetExternalUIRecord", "MsiSetInternalUI", "MsiEnableLogW", "MsiInstallProductW",
            "MsiConfigureProductExW", "MsiQueryProductStateW", "MsiRecordGetFieldCount", "MsiRecordGetStringW",
            "MsiRecordGetInteger"])
            assert.match(source, new RegExp(`DllImport\\("msi\\.dll"[\\s\\S]*?${api}`));
        assert.doesNotMatch(source, /MsiCloseHandle/);
        assert.match(source, /GC\.KeepAlive/);
        assert.match(source, /CallbackFailureReturn\s*=\s*-1/);
    });

    it("pins an ordinary directory handle and restores its exact descriptor on every path", () => {
        const source = fs.readFileSync(SCRIPT, "utf8");
        assert.match(source, /CreateFileW/);
        assert.match(source, /FileFlagBackupSemantics/);
        assert.match(source, /FileFlagOpenReparsePoint/);
        assert.match(source, /ReadControl/);
        assert.match(source, /WriteDac/);
        assert.match(source, /FileShareRead\s*\|\s*FileShareWrite\s*\|\s*FileShareDelete/);
        assert.match(source, /GetFileInformationByHandle/);
        assert.match(source, /GetFinalPathNameByHandleW/);
        assert.match(source, /GetKernelObjectSecurity/);
        assert.match(source, /SetSecurityInfo/);
        assert.match(source, /SeFileObject\s*=\s*1/);
        assert.match(source, /ProtectedDaclSecurityInformation\s*=\s*0x80000000/);
        assert.match(source, /SecurityDescriptorRelativeHeaderBytes\s*=\s*20/);
        assert.match(source, /DaclOffsetFieldByteOffset\s*=\s*16/);
        assert.match(source, /BitConverter\.ToInt32\(descriptor,DaclOffsetFieldByteOffset\)/);
        assert.match(source, /DaclSecurityInformation\s*\|\s*ProtectedDaclSecurityInformation/);
        assert.match(source, /GCHandle\.Alloc\(descriptor,GCHandleType\.Pinned\)/);
        assert.doesNotMatch(source, /SetKernelObjectSecurity/);
        assert.match(source, /OwnerSecurityInformation\s*\|\s*GroupSecurityInformation\s*\|\s*DaclSecurityInformation/);
        assert.match(source, /FileAddFile\s*=\s*0x00000002/);
        assert.match(source, /AceFlags\.None/);
        assert.match(source, /DenyAttempted\s*=\s*true;[\s\S]*SetFileDacl\(handle,bytes\)/);
        assert.match(source, /finally[\s\S]*RestoreOriginalSecurity/);
    });

    it("records actual callback order and derives cancellation only from the observed error style", () => {
        const source = fs.readFileSync(SCRIPT, "utf8");
        assert.match(source, /RemoveExistingProducts/);
        assert.match(source, /InstallFiles/);
        assert.match(source, /ErrorRetryCancelStyle/);
        assert.match(source, /ErrorAbortRetryIgnoreStyle/);
        assert.match(source, /ResponseCancel/);
        assert.match(source, /ResponseAbort/);
        assert.match(source, /ErrorWritingToFile\s*=\s*1304/);
        assert.match(source, /record\.Field1Integer\s*!=\s*ErrorWritingToFile/,
            "a different target-bound MSI error must not trigger cancellation acceptance");
        assert.doesNotMatch(source, /ExpectedErrorCode\s*=\s*1304|messageTypeCode\s*=\s*0x01000005/);
        assert.match(source, /RestoreOriginalSecurity\(\);[\s\S]*return\s+ErrorResponse/);
        assert.match(source, /if\(SecurityRestoredBeforeCancel\)return ResponseOk/);
        assert.match(source, /if\(DenyInjectionAttempted\)throw[\s\S]*DenyInjectionAttempted=true;[\s\S]*lease\.ApplyDeny\(\)/,
            "the injected failure must be one-way and never re-arm during rollback callbacks");
        assert.match(source, /InstallContextTracker/);
        assert.match(source, /if\(!installContext\.InCandidate\)return ResponseOk/,
            "nested predecessor actions must not arm the candidate failure");
        assert.match(source, /!state\.InstallContextBalanced/,
            "the candidate and nested predecessor install contexts must close exactly");
        assert.doesNotMatch(source, /"RollbackPayloadFile"|"RollbackRoot"/,
            "ACTIONDATA matching must not use authored MSI table identifiers as observed values");
        assert.match(source, /Path\.GetFileName\(targetPath\)/);
        assert.match(source, /NormalizeDirectory\(record\.Fields\[8\]\)/);
        assert.match(source, /FailureStage/);
        assert.match(source, /FailureNativeErrorCode/);
        assert.match(source, /CleanupFailureStage/);
        assert.match(source, /CleanupFailureNativeErrorCode/);
    });

    it("matches the retained hosted InstallFiles ACTIONDATA filename, size, and resolved directory", () => {
        const target = "C:\\ProgramData\\MyspeedRollback-be623b6cfcc34c0fafd3a927bbcbde15\\rollback-payload.txt";
        const retained = ["rollback-payload.txt", "", "", "", "", "10", "", "",
            "C:\\ProgramData\\MyspeedRollback-be623b6cfcc34c0fafd3a927bbcbde15\\"];
        const normalizeDirectory = value => path.win32.resolve(value).replace(/[\\/]+$/u, "");
        const matches = fields => fields.length >= 9
            && fields[0] === path.win32.basename(target)
            && fields[5] === "10"
            && normalizeDirectory(fields[8]).toLowerCase()
                === normalizeDirectory(path.win32.dirname(target)).toLowerCase();
        assert.equal(matches(retained), true);
        for (const mutate of [
            value => { value[0] = "RollbackPayloadFile"; },
            value => { value[5] = "11"; },
            value => { value[8] = "RollbackRoot"; },
            value => { value[8] = "C:\\ProgramData\\Other\\"; }
        ]) {
            const changed = [...retained];
            mutate(changed);
            assert.equal(matches(changed), false);
        }
    });

    it("tracks the retained nested predecessor timeline and rejects malformed install contexts", () => {
        const source = fs.readFileSync(SCRIPT, "utf8");
        const candidate = "{FF93E978-E119-4D48-B37B-248457E950A2}";
        const predecessor = "{1716C600-7C5B-45CB-89F1-584214207169}";
        assert.match(source, /readonly Stack<string> contexts=new Stack<string>\(\)/);
        assert.match(source, /MessageInstallStart=0x1A000000,MessageInstallEnd=0x1B000000/);
        assert.match(source, /messageClass==MessageInstallStart\|\|messageClass==MessageInstallEnd/);
        assert.match(source, /String\.Equals\(contexts\.Peek\(\),productCode,StringComparison\.Ordinal\)/);
        const replay = events => {
            const contexts = [];
            const observations = [];
            let candidateStarted = false;
            let predecessorStarted = false;
            for (const event of events) {
                if (event.type === "start") {
                    if (event.code === candidate) {
                        if (candidateStarted || contexts.length !== 0) throw new Error("candidate context");
                        candidateStarted = true;
                    } else if (event.code === predecessor) {
                        if (predecessorStarted || contexts.at(-1) !== candidate) throw new Error("predecessor context");
                        predecessorStarted = true;
                    } else throw new Error("unknown context");
                    contexts.push(event.code);
                } else if (event.type === "end") {
                    if (contexts.at(-1) !== event.code) throw new Error("unbalanced context");
                    contexts.pop();
                } else observations.push({action: event.action,
                    candidateContext: contexts.length === 1 && contexts[0] === candidate});
            }
            return {contexts, observations};
        };
        const retained = replay([
            {type: "start", code: candidate}, {type: "action", action: "RemoveExistingProducts"},
            {type: "start", code: predecessor}, {type: "action", action: "InstallFiles"},
            {type: "end", code: predecessor}, {type: "action", action: "InstallFiles"},
            {type: "end", code: candidate}
        ]);
        assert.deepEqual(retained.contexts, []);
        assert.deepEqual(retained.observations.map(value => value.candidateContext), [true, false, true]);
        assert.throws(() => replay([{type: "start", code: candidate}, {type: "start", code: candidate}]));
        assert.throws(() => replay([{type: "start", code: candidate}, {type: "end", code: predecessor}]));
        assert.notDeepEqual(replay([{type: "start", code: candidate}, {type: "start", code: predecessor}]).contexts, []);
    });

    it("requires predecessor setup and exact post-return cleanup without product inventory shortcuts", () => {
        const source = fs.readFileSync(SCRIPT, "utf8");
        assert.match(source, /InstallPredecessor/);
        assert.match(source, /InstallCandidate/);
        assert.match(source, /UninstallProduct/);
        assert.match(source, /QueryProductState/);
        assert.match(source, /predecessorPayloadRestored/);
        assert.match(source, /candidateAbsent/);
        assert.match(source, /sentinelPreserved/);
        assert.match(source, /sentinelBytesPreserved/);
        assert.match(source, /predecessorPayloadSha256/);
        assert.match(source, /InstallStateDefault\s*=\s*5/);
        assert.doesNotMatch(source, /InstallStateLocal\s*=\s*3/);
        assert.match(source, /MsiQueryProductStateW\(predecessorCode\)\s*!=\s*InstallStateDefault/);
        assert.match(source, /output\.PredecessorAfterRollback\s*!=\s*InstallStateDefault/);
        assert.match(source, /securityDescriptorBeforeSha256/);
        assert.match(source, /securityDescriptorAfterSha256/);
        assert.match(source, /directoryIdentity/);
        assert.match(source, /cleanupFailures/);
        assert.match(source, /priorUi/);
        assert.match(source, /MsiSetInternalUI\(priorUi/);
        assert.match(source, /observed\s*!=\s*InstallUiLevelNone/);
        assert.doesNotMatch(source, /MsiSetInternalUI\(5/);
        const noneUi = source.indexOf("MsiSetInternalUI(InstallUiLevelNone");
        const predecessorInstall = source.indexOf("MsiInstallProductW(predecessorMsi");
        const predecessorCleanup = source.indexOf("\"predecessor-uninstall\"");
        const restoreUi = source.indexOf("MsiSetInternalUI(priorUi");
        assert.ok(noneUi > 0 && noneUi < predecessorInstall);
        assert.ok(restoreUi > predecessorCleanup, "internal UI must stay NONE through product cleanup");
        assert.match(source, /predecessorInstallAttempted/);
        assert.match(source, /candidateInstallAttempted/);
        assert.match(source, /ownedDirectoryCreated/);
        assert.match(source, /if\(ownedDirectoryCreated\)/);
        assert.match(source, /if\(candidateInstallAttempted\)Attempt\(cleanupFailures,"candidate-uninstall"/);
        assert.match(source, /if\(predecessorInstallAttempted\)Attempt\(cleanupFailures,"predecessor-uninstall"/);
        assert.doesNotMatch(source, /catch\s*\{\s*\}/);
        assert.doesNotMatch(source, /Win32_Product|Get-WmiObject|msiexec/i);
    });

    it("retains nonqualifying bounded evidence on native failure without claiming authorization", () => {
        const source = fs.readFileSync(SCRIPT, "utf8");
        assert.match(source, /status\s*=\s*if\s*\(\$null\s*-eq\s*\$failure\)/);
        assert.match(source, /nativeExecutionAttempted/);
        assert.match(source, /failureCategory/);
        assert.match(source, /FileMode\]::CreateNew/);
        assert.doesNotMatch(source, /nativeExecutionAuthorized\s*=\s*\$true/);
    });

    boundedTest("rejects native construction before Add-Type outside hosted context", () => {
        const escaped = SCRIPT.replaceAll("'", "''");
        const command = [
            `$ErrorActionPreference='Stop'`,
            `$env:GITHUB_ACTIONS='false'`,
            `function global:Add-Type { throw 'ADD_TYPE_REACHED' }`,
            `. '${escaped}'`,
            `try { New-MyspeedRollbackNativeOperations ([pscustomobject]@{}) ; exit 9 } catch {`,
            `if($_.Exception.Message -match 'ADD_TYPE_REACHED'){exit 8};exit 0}`
        ].join("; ");
        const result = childProcess.spawnSync(POWERSHELL,
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
            {encoding: "utf8", timeout: PROCESS_TIMEOUT_MS});
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    });

    boundedTest("rejects an unhosted invocation before native attempt or evidence creation", () => {
        const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-msi-native-guard-"));
        try {
            const evidencePath = path.join(temporaryRoot, "result.json");
            const expected = {
                runId: "1", runAttempt: "1", eventSha: "a".repeat(40), sourceSha: "b".repeat(40),
                nonce: "c".repeat(32), imageVersion: "synthetic", closureRoot: temporaryRoot,
                manifestPath: path.join(temporaryRoot, "closure.json"),
                predecessorMsiPath: path.join(temporaryRoot, "predecessor.msi"),
                candidateMsiPath: path.join(temporaryRoot, "candidate.msi"), evidencePath
            };
            const escaped = SCRIPT.replaceAll("'", "''");
            const json = JSON.stringify(expected).replaceAll("'", "''");
            const command = [
                `$ErrorActionPreference='Stop'`,
                `$env:GITHUB_ACTIONS='false'`,
                `function global:Add-Type { throw 'ADD_TYPE_REACHED' }`,
                `. '${escaped}'`,
                `$expected=ConvertFrom-Json '${json}'`,
                `try { Invoke-MyspeedRollbackHostedCalibration $expected; exit 9 } catch {`,
                `if($_.Exception.Message -match 'ADD_TYPE_REACHED'){exit 8};exit 0}`
            ].join("; ");
            const result = childProcess.spawnSync(POWERSHELL,
                ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
                {encoding: "utf8", timeout: PROCESS_TIMEOUT_MS});
            assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
            assert.equal(fs.existsSync(evidencePath), false);
        } finally {
            fs.rmSync(temporaryRoot, {recursive: true, force: true});
        }
    });
});
