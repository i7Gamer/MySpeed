import {describe, it} from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SCRIPT = path.resolve("scripts/qualification/windows-cpu-file-identity.ps1");
const POWERSHELL = process.platform === "win32"
    ? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : "pwsh";
const PROCESS_TIMEOUT_MILLISECONDS = 10_000;
const POWERSHELL_AVAILABILITY_TIMEOUT_MILLISECONDS = 5_000;
const TEST_CASE_TIMEOUT_MILLISECONDS = 30_000;
const MAXIMUM_FILE_BYTES = 33_554_432;
const FILE_BYTES = 128;
const MAXIMUM_PARSE_BYTES = 2_097_152;
const LAST_WRITE_FILE_TIME = "01dc4c1b9d140000";
const VOLUME_SERIAL = "1234abcd";
const FILE_ID = "0123456789abcdef";
const SHA256 = "a".repeat(64);
const EVENT_SHA = "b".repeat(40);
const SOURCE_SHA = "c".repeat(40);
const NONCE = "d".repeat(32);
const HAS_POWERSHELL = childProcess.spawnSync(POWERSHELL,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"],
    {encoding: "utf8", timeout: POWERSHELL_AVAILABILITY_TIMEOUT_MILLISECONDS}).status === 0;

const invoke = (mode, input = {}, environment = process.env) => childProcess.spawnSync(POWERSHELL, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", SCRIPT, "-Mode", mode, "-InputJson", JSON.stringify(input)
], {encoding: "utf8", timeout: PROCESS_TIMEOUT_MILLISECONDS, env: {...environment}});

const run = (mode, input = {}) => {
    const result = invoke(mode, input);
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return result.stdout.trim() === "" ? null : JSON.parse(result.stdout);
};

const reject = (mode, input, pattern, label = "") => {
    const result = invoke(mode, input);
    assert.equal(result.error, undefined, result.error?.message);
    assert.notEqual(result.status, 0, `expected helper rejection: ${label}`);
    assert.match(`${result.stdout}\n${result.stderr}`, pattern, label);
};

const request = (overrides = {}) => ({
    name: "probe-source",
    path: "C:\\owned\\probe.c",
    allowedRoot: "C:\\owned",
    maximumBytes: 4_096,
    role: "source",
    ...overrides
});

const pathObservation = (overrides = {}) => ({
    volumeRoot: "C:\\",
    driveType: "Fixed",
    entries: [
        {path: "C:\\", kind: "directory", reparsePoint: false},
        {path: "C:\\owned", kind: "directory", reparsePoint: false},
        {path: "C:\\owned\\probe.c", kind: "file", reparsePoint: false}
    ],
    ...overrides
});

const handleFacts = (overrides = {}) => ({
    canonicalPath: "C:\\owned\\probe.c",
    finalPath: "C:\\owned\\probe.c",
    volumeSerial: VOLUME_SERIAL,
    fileId: FILE_ID,
    bytes: FILE_BYTES,
    lastWriteFileTime: LAST_WRITE_FILE_TIME,
    linkCount: 1,
    isRegular: true,
    reparsePoint: false,
    fileVersion: null,
    productVersion: null,
    ...overrides
});

const observation = (overrides = {}) => ({
    request: request(),
    pathBefore: pathObservation(),
    before: handleFacts(),
    hash: {sha256: SHA256, bytesRead: FILE_BYTES},
    after: handleFacts(),
    pathAfter: pathObservation(),
    ...overrides
});

const quotePowerShell = value => `'${String(value).replaceAll("'", "''")}'`;

describe("Windows CPU file identity static contract", () => {
    it("places the hosted guard before the real stable-handle adapter", () => {
        const source = fs.readFileSync(SCRIPT, "utf8");
        const factory = source.indexOf("function New-MyspeedNativeFileIdentityOperations");
        const hostedGuard = source.indexOf("Assert-MyspeedFileIdentityHostedContext", factory);
        const addType = source.indexOf("Add-Type", factory);
        assert.ok(factory >= 0 && hostedGuard > factory && addType > hostedGuard);
        assert.match(source, /FILE_SHARE_READ\s*=\s*0x00000001/);
        assert.match(source, /FILE_FLAG_OPEN_REPARSE_POINT\s*=\s*0x00200000/);
        assert.doesNotMatch(source, /FILE_SHARE_WRITE|FILE_SHARE_DELETE/);
    });
});

describe("Windows CPU file identity PowerShell contract", {
    skip: !HAS_POWERSHELL && "PowerShell unavailable; static adapter checks still run"
}, () => {
    it("is import-safe and rejects local native construction before Add-Type",
        {timeout: TEST_CASE_TIMEOUT_MILLISECONDS}, () => {
        const imported = invoke("Library");
        assert.equal(imported.status, 0, imported.stderr);
        assert.equal(imported.stdout, "");

        const environment = {...process.env};
        for (const name of ["GITHUB_ACTIONS", "CI", "RUNNER_OS", "RUNNER_ARCH", "RUNNER_ENVIRONMENT",
            "GITHUB_REPOSITORY", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_SHA", "ImageOS", "ImageVersion"])
            delete environment[name];
        const local = invoke("InvokeNativeFactory", {
            expectedRunId: "12345", expectedRunAttempt: "1", expectedEventSha: EVENT_SHA,
            expectedSourceSha: SOURCE_SHA, nonce: NONCE
        }, environment);
        assert.notEqual(local.status, 0);
        assert.match(local.stderr, /hosted|context/i);
        assert.doesNotMatch(local.stderr, /Add-Type|native adapter compilation/i);
    });

    it("accepts only normalized local-drive paths and strict descendants",
        {timeout: TEST_CASE_TIMEOUT_MILLISECONDS}, () => {
        assert.equal(run("ValidatePath", {path: "C:\\owned\\probe.c"}).path, "C:\\owned\\probe.c");
        assert.equal(run("ValidatePath", {path: "C:\\owned\\probe.c", root: "C:\\owned"}).path,
            "C:\\owned\\probe.c");
        for (const invalid of [
            "\\\\server\\share\\probe.c", "C:/owned/probe.c", "C:\\owned\\..\\probe.c",
            "C:\\owned\\probe.c:stream", "C:\\owned\\*.c", "C:\\owned\\?.c",
            "C:\\owned\\CON.txt\\probe.c", "C:\\owned\\COM1\\probe.c",
            "C:\\owned\\bad\u0001name\\probe.c", "C:\\owned\\probe.c."
        ]) reject("ValidatePath", {path: invalid}, /path|normalized|device|control|metacharacter/i);
        reject("ValidatePath", {path: ["C:\\owned\\probe.c"]}, /string/i);
        for (const escaped of ["C:\\owner\\probe.c", "D:\\owned\\probe.c", "C:\\owned"])
            reject("ValidatePath", {path: escaped, root: "C:\\owned"}, /descendant|root/i);
    });

    it("accepts one-link owned inputs and records legitimate system-tool hardlinks",
        {timeout: TEST_CASE_TIMEOUT_MILLISECONDS}, () => {
        const owned = run("ValidateObservation", observation());
        assert.deepEqual(owned, {
            schemaVersion: 1, name: "probe-source", role: "source", path: "C:\\owned\\probe.c",
            finalPath: "C:\\owned\\probe.c", volumeSerial: VOLUME_SERIAL, fileId: FILE_ID,
            bytes: FILE_BYTES, lastWriteFileTime: LAST_WRITE_FILE_TIME, linkCount: 1,
            sha256: SHA256, fileVersion: null, productVersion: null
        });

        const toolRequest = request({name: "compiler", path: "C:\\tools\\cl.exe", allowedRoot: "C:\\tools",
            role: "system-tool", maximumBytes: MAXIMUM_FILE_BYTES});
        const toolChain = pathObservation({entries: [
            {path: "C:\\", kind: "directory", reparsePoint: false},
            {path: "C:\\tools", kind: "directory", reparsePoint: false},
            {path: "C:\\tools\\cl.exe", kind: "file", reparsePoint: false}
        ]});
        const toolFacts = handleFacts({canonicalPath: toolRequest.path, finalPath: toolRequest.path,
            linkCount: 3, fileVersion: "14.50.1.0", productVersion: "14.50.1"});
        const tool = run("ValidateObservation", {request: toolRequest, pathBefore: toolChain,
            before: toolFacts, hash: {sha256: SHA256, bytesRead: FILE_BYTES}, after: toolFacts,
            pathAfter: toolChain});
        assert.equal(tool.linkCount, 3);
        assert.equal(tool.fileVersion, "14.50.1.0");
        assert.equal(tool.productVersion, "14.50.1");
    });

    it("rejects path-chain, reparse, leaf, link and size violations",
        {timeout: TEST_CASE_TIMEOUT_MILLISECONDS}, () => {
        for (const index of [0, 1, 2]) {
            const value = structuredClone(observation());
            value.pathBefore.entries[index].reparsePoint = true;
            reject("ValidateObservation", value, /reparse/i);
        }
        for (const mutate of [
            value => { value.pathBefore.driveType = "Network"; },
            value => { value.pathBefore.entries.splice(1, 1); },
            value => { value.pathBefore.entries[2].kind = "directory"; },
            value => { value.before.isRegular = false; value.after.isRegular = false; },
            value => { value.before.linkCount = 2; value.after.linkCount = 2; },
            value => { value.before.bytes = 4_097; value.after.bytes = 4_097; value.hash.bytesRead = 4_097; }
        ]) {
            const value = structuredClone(observation());
            mutate(value);
            reject("ValidateObservation", value, /drive|chain|leaf|regular|link|size|bound/i);
        }
        const escaped = observation({request: request({allowedRoot: "C:\\other"})});
        reject("ValidateObservation", escaped, /root|descendant/i);
        reject("ValidatePath", {path: "C:\\owned\\probe.c", root: "C:\\bad\\..\\root"},
            /root|normalized/i);
    });

    it("rejects unstable handle identity, malformed hashes and scalar coercion",
        {timeout: TEST_CASE_TIMEOUT_MILLISECONDS}, () => {
        for (const [label, mutate] of [
            ["file ID drift", value => { value.after.fileId = "fedcba9876543210"; }],
            ["path-chain drift", value => { value.pathAfter.entries[1].path = "C:\\OWNED"; }],
            ["final-path drift", value => { value.after.finalPath = "C:\\owned\\other.c"; }],
            ["timestamp drift", value => { value.after.lastWriteFileTime = "01dc4c1b9d140001"; }],
            ["short hash read", value => { value.hash.bytesRead -= 1; }],
            ["uppercase hash", value => { value.hash.sha256 = "A".repeat(64); }],
            ["boolean byte count", value => { value.before.bytes = true; }],
            ["fractional maximum", value => { value.request.maximumBytes = 4_096.5; }],
            ["timestamp scalar coercion", value => { value.before.lastWriteFileTime = 0; }],
            ["numeric reparse proof", value => { value.before.reparsePoint = 0; }]
        ]) {
            const value = structuredClone(observation());
            mutate(value);
            reject("ValidateObservation", value,
                /identity|drift|hash|sha-256|bytes|integer|boolean|path|string|time/i, label);
        }
    });

    it("rejects identity collisions by exact named set", {timeout: TEST_CASE_TIMEOUT_MILLISECONDS}, () => {
        const first = run("ValidateObservation", observation());
        const second = {...first, name: "probe-copy", path: "C:\\owned\\copy.c",
            finalPath: "C:\\owned\\copy.c", fileId: "1111111111111111"};
        assert.equal(run("ValidateCollisions", {files: [first, second]}).accepted, true);
        reject("ValidateCollisions", {files: [first, {...second, fileId: FILE_ID}]}, /collision/i);
        reject("ValidateCollisions", {files: [first, {...second, name: first.name}]}, /name|collision/i);
    });

    it("validates only absent create-new leaves beneath a fully plain owned root",
        {timeout: TEST_CASE_TIMEOUT_MILLISECONDS}, () => {
        const valid = {
            path: "C:\\owned\\output\\result.json", ownedRoot: "C:\\owned",
            maximumBytes: 262_144, leafExists: false,
            pathObservation: {
                volumeRoot: "C:\\", driveType: "Fixed", entries: [
                    {path: "C:\\", kind: "directory", reparsePoint: false},
                    {path: "C:\\owned", kind: "directory", reparsePoint: false},
                    {path: "C:\\owned\\output", kind: "directory", reparsePoint: false}
                ]
            }
        };
        assert.equal(run("ValidateOutput", valid).accepted, true);
        for (const mutate of [
            value => { value.leafExists = true; },
            value => { value.pathObservation.entries[1].reparsePoint = true; },
            value => { value.pathObservation.entries.pop(); },
            value => { value.path = "C:\\elsewhere\\result.json"; },
            value => { value.maximumBytes = MAXIMUM_FILE_BYTES + 1; }
        ]) {
            const value = structuredClone(valid);
            mutate(value);
            reject("ValidateOutput", value, /exists|reparse|chain|root|bound/i);
        }
    });

    it("uses the injected stable handle in order and closes it on success and failure",
        {timeout: TEST_CASE_TIMEOUT_MILLISECONDS}, () => {
        const payload = JSON.stringify(observation()).replaceAll("'", "''");
        const body = `
            . ${quotePowerShell(SCRIPT)}
            $value = '${payload}' | ConvertFrom-Json
            $events = [System.Collections.Generic.List[string]]::new()
            $operations = @{
                GetPathObservation = { param($path) if (@($events | Where-Object { $_ -like 'chain-*' }).Count -eq 0) {
                    [void]$events.Add('chain-before'); $value.pathBefore
                } else { [void]$events.Add('chain-after'); $value.pathAfter } }.GetNewClosure()
                OpenStableRead = { param($path) [void]$events.Add('open'); [pscustomobject]@{ tag='handle' } }.GetNewClosure()
                GetHandleFacts = { param($handle) if (@($events)[-1] -ceq 'open') {
                    [void]$events.Add('before'); $value.before
                } else { [void]$events.Add('after'); $value.after } }.GetNewClosure()
                ReadHandleSha256 = { param($handle,$maximumBytes) [void]$events.Add('hash'); $value.hash }.GetNewClosure()
                CloseStableRead = { param($handle) [void]$events.Add('close') }.GetNewClosure()
            }
            $identity = Get-MyspeedVerifiedFileIdentity -Request $value.request -Operations $operations
            [pscustomobject]@{ events=@($events); identity=$identity } | ConvertTo-Json -Compress -Depth 10
        `;
        const success = childProcess.spawnSync(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", body],
            {encoding: "utf8", timeout: PROCESS_TIMEOUT_MILLISECONDS});
        assert.equal(success.status, 0, success.stderr);
        assert.deepEqual(JSON.parse(success.stdout).events,
            ["chain-before", "open", "before", "hash", "after", "chain-after", "close"]);

        const failureBody = `
            . ${quotePowerShell(SCRIPT)}
            $value = '${payload}' | ConvertFrom-Json
            $events = [System.Collections.Generic.List[string]]::new()
            $operations = @{
                GetPathObservation = { param($path) $value.pathBefore }.GetNewClosure()
                OpenStableRead = { param($path) [void]$events.Add('open'); [pscustomobject]@{ tag='handle' } }.GetNewClosure()
                GetHandleFacts = { param($handle) [void]$events.Add('before'); $value.before }.GetNewClosure()
                ReadHandleSha256 = { param($handle,$maximumBytes) [void]$events.Add('hash'); throw 'synthetic read failure' }.GetNewClosure()
                CloseStableRead = { param($handle) [void]$events.Add('close') }.GetNewClosure()
            }
            try { Get-MyspeedVerifiedFileIdentity -Request $value.request -Operations $operations | Out-Null }
            catch { [pscustomobject]@{ error=$_.Exception.Message; events=@($events) } | ConvertTo-Json -Compress }
        `;
        const failure = childProcess.spawnSync(POWERSHELL,
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", failureBody],
            {encoding: "utf8", timeout: PROCESS_TIMEOUT_MILLISECONDS});
        assert.equal(failure.status, 0, failure.stderr);
        const failed = JSON.parse(failure.stdout);
        assert.match(failed.error, /synthetic read failure/);
        assert.deepEqual(failed.events, ["open", "before", "hash", "close"]);
    });

    it("binds parsed bytes and identity to one bounded stable read, including failures",
        {timeout: TEST_CASE_TIMEOUT_MILLISECONDS}, () => {
        const bytes = Buffer.alloc(FILE_BYTES, "x");
        const body = `
            . ${quotePowerShell(SCRIPT)}
            $value = '${JSON.stringify(observation()).replaceAll("'", "''")}' | ConvertFrom-Json
            $bytes = [Convert]::FromBase64String('${bytes.toString("base64")}')
            $sha = [Security.Cryptography.SHA256]::Create()
            try { $hash = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant() }
            finally { $sha.Dispose() }
            $events = [Collections.Generic.List[string]]::new()
            $operations = @{
                GetPathObservation = { param($path) [void]$events.Add('chain'); $value.pathBefore }.GetNewClosure()
                OpenStableRead = { param($path) [void]$events.Add('open'); 'handle' }.GetNewClosure()
                GetHandleFacts = { param($handle) [void]$events.Add('facts'); $value.before }.GetNewClosure()
                ReadHandleSha256 = { throw 'Separate hash read must not occur' }
                ReadHandleBytes = { param($handle,$maximum) [void]$events.Add('bytes');
                    [pscustomobject]@{bytesBase64=[Convert]::ToBase64String($bytes);bytesRead=$bytes.Length;sha256=$hash}
                }.GetNewClosure()
                CloseStableRead = { param($handle) [void]$events.Add('close') }.GetNewClosure()
            }
            $result = Read-MyspeedVerifiedFileBytes $value.request $operations
            $goodEvents = @($events)
            $failures = @()
            foreach ($scenario in @('wrong-hash','wrong-count','malformed-base64','drift','read-failure','oversize','close-only','read-and-close')) {
                $events.Clear()
                $fake = $operations.Clone()
                $request = $value.request | ConvertTo-Json | ConvertFrom-Json
                switch ($scenario) {
                    'wrong-hash' { $fake.ReadHandleBytes = { [pscustomobject]@{bytesBase64=[Convert]::ToBase64String($bytes);bytesRead=$bytes.Length;sha256=('a' * 64)} }.GetNewClosure() }
                    'wrong-count' { $fake.ReadHandleBytes = { [pscustomobject]@{bytesBase64=[Convert]::ToBase64String($bytes);bytesRead=1;sha256=$hash} }.GetNewClosure() }
                    'malformed-base64' { $fake.ReadHandleBytes = { [pscustomobject]@{bytesBase64='!!!';bytesRead=128;sha256=$hash} }.GetNewClosure() }
                    'drift' { $fake.GetHandleFacts = { param($handle)
                        $facts = $value.before | ConvertTo-Json | ConvertFrom-Json
                        if ($events.Contains('bytes')) { $facts.fileId='1111111111111111' }
                        $facts
                    }.GetNewClosure() }
                    'read-failure' { $fake.ReadHandleBytes = { throw 'Synthetic bounded read failure' } }
                    'oversize' { $request.maximumBytes=${MAXIMUM_PARSE_BYTES + 1} }
                    'close-only' { $fake.CloseStableRead = { [void]$events.Add('close'); throw 'Synthetic close failure' }.GetNewClosure() }
                    'read-and-close' {
                        $fake.ReadHandleBytes = { throw 'Synthetic primary read failure' }
                        $fake.CloseStableRead = { [void]$events.Add('close'); throw 'Synthetic close failure' }.GetNewClosure()
                    }
                }
                try { Read-MyspeedVerifiedFileBytes $request $fake | Out-Null; throw 'Invalid read was accepted' }
                catch { $failures += [pscustomobject]@{scenario=$scenario;error=$_.Exception.Message;closed=$events.Contains('close')} }
            }
            $hashOnly = $operations.Clone()
            $hashOnly.ReadHandleSha256 = { [pscustomobject]@{sha256=$hash;bytesRead=$bytes.Length} }.GetNewClosure()
            $hashIdentity = Get-MyspeedVerifiedFileIdentity $value.request $hashOnly
            [pscustomobject]@{result=$result;events=$goodEvents;failures=$failures;hashIdentity=$hashIdentity} | ConvertTo-Json -Compress -Depth 20
        `;
        const outcome = childProcess.spawnSync(POWERSHELL,
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", body],
            {encoding: "utf8", timeout: PROCESS_TIMEOUT_MILLISECONDS});
        assert.equal(outcome.status, 0, outcome.stderr);
        const record = JSON.parse(outcome.stdout);
        assert.equal(record.result.bytesBase64, bytes.toString("base64"));
        assert.equal(record.result.identity.fileId, FILE_ID);
        assert.deepEqual(record.hashIdentity, record.result.identity);
        assert.deepEqual(record.events, ["chain", "open", "facts", "bytes", "facts", "chain", "close"]);
        for (const failure of record.failures) {
            assert.doesNotMatch(failure.error, /Invalid read was accepted/);
            assert.equal(failure.closed, failure.scenario !== "oversize", failure.scenario);
            if (["close-only", "read-and-close"].includes(failure.scenario)) assert.match(failure.error, /Synthetic close failure/);
            if (failure.scenario === "read-and-close") assert.match(failure.error, /Synthetic primary read failure/);
        }
        const source = fs.readFileSync(SCRIPT, "utf8");
        assert.match(source, /ReadHandleBytes/);
        assert.ok(source.indexOf("length > maximumBytes") < source.indexOf("byte[] bytes = new byte["),
            "Native length bound must precede byte allocation");
    });
});
