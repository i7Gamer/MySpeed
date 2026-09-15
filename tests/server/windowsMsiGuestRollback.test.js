import {describe, it} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";

const SCRIPT = path.resolve("scripts/qualification/windows-msi-guest-rollback.ps1");
const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const HASH = "a".repeat(64);
const ERROR_CREATING_DESTINATION_FILE = 1310;
const DIFFERENT_ERROR_CODE = 1304;
const powershellAvailable = process.platform === "win32";
const powershellIt = (name, body) => (powershellAvailable ? it : it.skip)(name, body);
const proof = () => ({accepted: true, errorCode: ERROR_CREATING_DESTINATION_FILE, installContextBalanced: true,
    securityRestored: true, predecessorRestored: true, candidateAbsent: true, recordsSha256: HASH});
const invoke = args => spawnSync(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive",
    "-ExecutionPolicy", "Bypass", "-File", SCRIPT, ...args], {encoding: "utf8"});

describe("Windows MSI guest candidate rollback helper", () => {
    powershellIt("publishes the exact nonqualifying real-candidate contract", () => {
        const result = invoke(["-Mode", "GetContract"]);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), {schemaVersion: 1,
            kind: "myspeed-windows-msi-guest-rollback-contract", qualifying: false,
            targetDirectory: "C:\\Program Files\\MySpeed",
            targetFile: "C:\\Program Files\\MySpeed\\MySpeed.exe",
            requiredErrorCode: ERROR_CREATING_DESTINATION_FILE,
            requiredInstallReturns: [1602, 1603], releaseGatesCleared: []});
    });

    powershellIt("accepts only the exact callback, security, and restored-product proof", () => {
        const result = invoke(["-Mode", "TestInjected", "-InputJson", JSON.stringify(proof())]);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), proof());
        for (const mutate of [value => { value.errorCode = DIFFERENT_ERROR_CODE; },
            value => { value.securityRestored = false; }, value => { value.extra = true; }]) {
            const changed = proof(); mutate(changed);
            const rejected = invoke(["-Mode", "TestInjected", "-InputJson", JSON.stringify(changed)]);
            assert.equal(rejected.error, undefined);
            assert.notEqual(rejected.status, 0);
        }
    });

    it("binds the real MSI callback ABI, retained directory handle, and inherited-DACL restoration", () => {
        const source = fs.readFileSync(SCRIPT, "utf8");
        assert.match(source, /delegate int InstallUiHandlerRecord\(IntPtr context,uint messageType,uint recordHandle\)/u);
        assert.match(source, /RequiredMessageFilter=\(1u<<0\)\|\(1u<<1\)\|\(1u<<8\)\|\(1u<<9\)\|\(1u<<26\)\|\(1u<<27\)/u);
        assert.match(source, /UnprotectedDaclSecurityInformation/u);
        assert.match(source, /CreateFileW\(expectedPath,ReadControl\|WriteDac/u);
        assert.match(source, /SetSecurityInfo\(handle,SeFileObject/u);
        assert.match(source, /MsiInstallProductW\(candidateMsi,"REBOOT=ReallySuppress"\)/u);
        assert.match(source, /ErrorInstallUserExit=1602,ErrorInstallFailure=1603/u);
        assert.match(source, /CandidateInstallReturn==ErrorInstallUserExit\|\|output\.CandidateInstallReturn==ErrorInstallFailure/u);
        assert.ok(source.indexOf("output.predecessorRestored=") < source.indexOf("output.accepted="),
            "restored state must be observed before the reviewed return-code gate can accept");
        assert.match(source, /MsiSetExternalUIRecord\(null,0,IntPtr\.Zero,out ignored\)/u);
        assert.match(source, /MsiSetInternalUI\(priorUi,ref owner\)/u);
        assert.match(source, /FileAddFile=2/u);
        assert.match(source, /ErrorCreatingDestinationFile=1310,ExpectedSystemError=0/u);
        assert.match(source, /ExpectedErrorCodeFieldIndex=0/u);
        assert.match(source, /record\.Fields\.Length!=ExpectedErrorFieldCount/u);
        assert.match(source, /record\.Fields\[ExpectedErrorCodeFieldIndex\]!=ErrorCreatingDestinationFile\.ToString/u);
        assert.match(source, /record\.Fields\[ExpectedSystemErrorFieldIndex\]!=ExpectedSystemError\.ToString/u);
        assert.match(source, /!Target\(record\.Fields\[ExpectedTargetFieldIndex\]\)/u);
        assert.match(source, /style!=ErrorRetryCancelStyle/u);
        assert.doesNotMatch(source, /ErrorAbortRetryIgnoreStyle|ResponseAbort/u);
        assert.doesNotMatch(source, /SetNamedSecurityInfo|SetKernelObjectSecurity/u);
    });

    it("keeps native compilation and effects behind the exact NIC-free guest and seed identity guards", () => {
        const source = fs.readFileSync(SCRIPT, "utf8");
        const guard = source.indexOf("Assert-MyspeedGuestRollbackContext");
        const compile = source.lastIndexOf("New-MyspeedGuestRollbackNativeType");
        assert.ok(guard >= 0 && compile > guard);
        assert.match(source, /requires the exact NIC-free QEMU guest/u);
        assert.match(source, /Get-MyspeedGuestRollbackSha256/u);
        assert.match(source, /FileFlagOpenReparsePoint/u);
        assert.doesNotMatch(source, /Win32_Product/u);
    });
});
