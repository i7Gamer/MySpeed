import {describe, it} from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {parse} from "yaml";

const WORKFLOW = ".github/workflows/windows-winsw-offline-canary.yml";
const SCRIPT = "scripts/qualification/windows-winsw-offline-canary.ps1";
const HELPER_TEST = "tests/server/windowsWinswOfflineCanary.test.js";
const TEST = "tests/server/windowsWinswOfflineCanaryWorkflow.test.js";
const SOURCE_EXPRESSION = "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}";
const WINSW_URL = "https://github.com/winsw/winsw/releases/download/v3.0.0-alpha.11/WinSW-x64.exe";
const WINSW_SHA256 = "a2daa6a33a9c2b791ae31d9092e7935c339d1e03e89bfb747618ce2f4e819e20";
const WINSW_BYTES = 18_286_774;
const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const SETUP_BUN = "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6";
const BUN_VERSION = "1.4.2";
const DOWNLOAD = "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c";
const UPLOAD = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const RUN_ID = "123456789";
const RUN_ATTEMPT = "2";
const SOURCE_SHA = "a".repeat(40);
const EVENT_SHA = "b".repeat(40);
const NONCE = "0123456789abcdef0123456789abcdef";
const IMAGE_VERSION = "20260907.229.1";
const SHELL_TIMEOUT_MS = 15_000;
const NET_LUID_HEX_LENGTH = 16;
const EXPECTED_ENVIRONMENT = {SERVER_HOST: "127.0.0.1", SERVER_PORT: "43127", HTTPS_REDIRECT: "false",
    DB_TYPE: "sqlite", RUN_TEST_ON_STARTUP: "false", PREVIEW_MODE: "false", ALLOW_NO_PASSWORD: "false",
    ALLOW_LOCAL_NODES: "false"};
const LOOPBACK_ENDPOINTS = [
    {transport: "tcp", addressFamily: "ipv4", address: "127.0.0.1", port: 43_128},
    {transport: "tcp", addressFamily: "ipv6", address: "::1", port: 43_129},
    {transport: "udp", addressFamily: "ipv4", address: "127.0.0.1", port: 43_130},
    {transport: "udp", addressFamily: "ipv6", address: "::1", port: 43_131}
];
const TEST_NET_ENDPOINTS = [
    {transport: "tcp", addressFamily: "ipv4", address: "192.0.2.1", port: 43_132},
    {transport: "tcp", addressFamily: "ipv6", address: "2001:db8::1", port: 43_133},
    {transport: "udp", addressFamily: "ipv4", address: "192.0.2.1", port: 43_134},
    {transport: "udp", addressFamily: "ipv6", address: "2001:db8::1", port: 43_135}
];
const powershell = process.platform === "win32"
    ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : null;
const hasPowerShell = powershell !== null
    && spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"],
        {timeout: SHELL_TIMEOUT_MS}).status === 0;

const source = () => fs.readFileSync(WORKFLOW, "utf8");
const config = () => parse(source());
const action = (job, prefix) => job.steps.find(({uses}) => uses?.startsWith(`${prefix}@`));
const step = (job, id) => job.steps.find(candidate => candidate.id === id);
const inboxEnvironment = additions => {
    const environment = {...process.env, ...additions};
    for (const name of Object.keys(environment))
        if (name.toLowerCase() === "psmodulepath") delete environment[name];
    return environment;
};
const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");

describe("candidate-neutral WinSW offline canary workflow", () => {
    it("is non-publishing, repository-bound, and identity-bound", () => {
        const workflow = config();
        assert.deepEqual(Object.keys(workflow.on).sort(), ["pull_request", "push", "workflow_dispatch"]);
        assert.deepEqual(workflow.on.push.branches, ["development"]);
        for (const event of ["pull_request", "push"])
            assert.deepEqual(workflow.on[event].paths, [WORKFLOW, SCRIPT, HELPER_TEST, TEST]);
        assert.deepEqual(workflow.permissions, {actions: "read", contents: "read"});
        assert.equal(workflow.env.EXPECTED_SOURCE_SHA, SOURCE_EXPRESSION);
        assert.equal(workflow.env.EXPECTED_EVENT_SHA, "${{ github.sha }}");
        assert.equal(workflow.env.EXPECTED_RUN_ID, "${{ github.run_id }}");
        assert.equal(workflow.env.EXPECTED_RUN_ATTEMPT, "${{ github.run_attempt }}");
        assert.match(workflow.jobs.prepare.if, /github\.repository == 'i7Gamer\/MySpeed'/);
        assert.match(workflow.jobs.prepare.if, /head\.repo\.full_name == github\.repository/);
        assert.doesNotMatch(source(), /actions\/create-release|gh\s+release|packages:\s*write|contents:\s*write/i);
    });

    it("installs locked test dependencies without lifecycle scripts before producer tests", () => {
        const {prepare} = config().jobs;
        const setup = action(prepare, "oven-sh/setup-bun");
        assert.ok(setup, "a fresh runner needs the pinned dependency installer");
        assert.equal(setup.uses, SETUP_BUN);
        assert.equal(setup.with["bun-version"], BUN_VERSION);
        const install = prepare.steps.find(({name}) => name === "Install locked canary test dependencies");
        const tests = prepare.steps.find(({name}) => name === "Test pure and injected canary helpers");
        assert.ok(install, "the workflow tests import the locked yaml dependency");
        assert.match(install.run, /bun install --frozen-lockfile --ignore-scripts/u);
        assert.match(install.run, /if \(\$LASTEXITCODE -ne 0\).*throw/u);
        assert.ok(prepare.steps.indexOf(setup) < prepare.steps.indexOf(install));
        assert.ok(prepare.steps.indexOf(install) < prepare.steps.indexOf(tests));
    });

    it("seals only the exact script and pinned WinSW bytes in the producer", () => {
        const {prepare} = config().jobs;
        assert.equal(prepare["runs-on"], "windows-2025");
        const tests = prepare.steps.find(({name}) => name === "Test pure and injected canary helpers");
        assert.match(tests.run, /windowsWinswOfflineCanary\.test\.js/);
        assert.match(tests.run, /windowsWinswOfflineCanaryWorkflow\.test\.js/);
        assert.equal(action(prepare, "actions/checkout").uses, CHECKOUT);
        assert.deepEqual(action(prepare, "actions/checkout").with,
            {ref: SOURCE_EXPRESSION, "persist-credentials": false});
        const acquire = step(prepare, "acquire");
        assert.equal(acquire.env.WINSW_URL, WINSW_URL);
        assert.equal(acquire.env.WINSW_SHA256, WINSW_SHA256);
        assert.match(acquire.run, /Invoke-WebRequest/);
        assert.match(acquire.run, /Get-AuthenticodeSignature/);
        assert.doesNotMatch(acquire.run, /Status -cne 'Valid'|signature is not valid/i);
        assert.match(acquire.run, /Get-FileHash/);
        assert.match(acquire.run, new RegExp(`EXPECTED_WINSW_BYTES = ${WINSW_BYTES}`));
        assert.match(acquire.run, /Length -ne \$EXPECTED_WINSW_BYTES/);
        const seal = step(prepare, "closure");
        assert.match(seal.run, /-Mode EmitClosureManifest/);
        assert.match(seal.run, /\[guid\]::NewGuid\(\)\.ToString\('N'\)/);
        const upload = action(prepare, "actions/upload-artifact");
        assert.equal(upload.uses, UPLOAD);
        assert.deepEqual(upload.with.path.trim().split(/\r?\n/), [
            "${{ runner.temp }}/winsw-offline-closure/windows-winsw-offline-canary.ps1",
            "${{ runner.temp }}/winsw-offline-closure/WinSW-x64.exe",
            "${{ runner.temp }}/winsw-offline-closure/closure.json"
        ]);
        assert.equal(upload.with["if-no-files-found"], "error");
    });

    it("runs the fresh canary without checkout or a network acquisition step", () => {
        const {prepare, canary} = config().jobs;
        assert.equal(canary.needs, "prepare");
        assert.equal(canary["runs-on"], "windows-2025");
        assert.equal(action(canary, "actions/checkout"), undefined);
        const download = action(canary, "actions/download-artifact");
        assert.equal(download.uses, DOWNLOAD);
        assert.equal(download.with["artifact-ids"], "${{ needs.prepare.outputs.artifact_id }}");
        assert.equal(download.with["merge-multiple"], true);
        assert.equal(download.with.pattern, undefined);
        assert.equal(download.with.name, undefined);
        assert.equal(prepare.outputs.artifact_id, "${{ steps.upload.outputs.artifact-id }}");
        const executable = canary.steps.filter(({run}) => run).map(({run}) => run).join("\n");
        assert.doesNotMatch(executable, /Invoke-WebRequest|curl(?:\.exe)?\b|Start-BitsTransfer|git\s+clone|msiexec/i);
    });

    it("validates the exact closure before invoking the hosted-only controller", () => {
        const job = config().jobs.canary;
        const run = step(job, "validate").run;
        for (const required of ["EXPECTED_SOURCE_SHA", "EXPECTED_EVENT_SHA", "EXPECTED_RUN_ID", "EXPECTED_RUN_ATTEMPT",
            "EXPECTED_NONCE", "MAX_SCRIPT_BYTES", "MAX_WINSW_BYTES", "MAX_MANIFEST_BYTES", WINSW_SHA256,
            "ReparsePoint", "Get-FileHash", "-Stream '*'", "LinkType", "closure.json"])
            assert.ok(run.includes(required), required);
        assert.match(run, /\.Count -ne 3/);
        assert.match(run, /\$ancestor = \$root\.Parent/);
        assert.doesNotMatch(run, /InvokeHostedCanary|InvokePostReconnect|Disable-NetAdapter|New-Service/);
        const invoke = step(config().jobs.canary, "canary").run;
        assert.match(invoke, /-Mode InvokeHostedCanary/);
        assert.ok(job.steps.indexOf(step(job, "canary")) > job.steps.indexOf(step(job, "validate")));
    });

    it("always attempts trusted post-reconnect cleanup before continuation and retention", () => {
        const job = config().jobs.canary;
        const cleanup = step(job, "cleanup");
        const continuation = step(job, "continuation");
        const bounds = step(job, "bound_evidence");
        const upload = action(job, "actions/upload-artifact");
        assert.equal(cleanup.if,
            "always() && steps.host.outcome == 'success' && steps.validate.outputs.trusted == 'true'");
        assert.equal(cleanup.shell, "powershell");
        assert.match(cleanup.run, /-Mode InvokePostReconnect/);
        assert.match(cleanup.run, /recovery\.request\.json/);
        assert.ok(job.steps.indexOf(cleanup) > job.steps.indexOf(step(job, "canary")));
        assert.ok(job.steps.indexOf(continuation) > job.steps.indexOf(cleanup));
        assert.ok(job.steps.indexOf(bounds) > job.steps.indexOf(continuation));
        assert.equal(bounds.if, "always()");
        assert.deepEqual(bounds.env, {CLEANUP_OUTCOME: "${{ steps.cleanup.outcome }}"});
        assert.match(bounds.run, /CLEANUP_OUTCOME -cne 'success'/);
        assert.equal(upload.if, "always() && steps.bound_evidence.outputs.safe == 'true'");
        assert.equal(upload.uses, UPLOAD);
        assert.equal(upload.with.path,
            "${{ runner.temp }}/myspeed-winsw-offline-upload-${{ needs.prepare.outputs.nonce }}/");
        assert.match(bounds.run, /MAX_EVIDENCE_FILES/);
        assert.match(bounds.run, /MAX_EVIDENCE_BYTES/);
        assert.match(bounds.run, /ReparsePoint/);
        assert.match(bounds.run, /-Stream '\*'/);
        assert.match(bounds.run, /LinkType/);
    });

    it("independently rejects qualifying or gate-clearing evidence", () => {
        const run = step(config().jobs.canary, "continuation").run;
        assert.equal(step(config().jobs.canary, "continuation").shell, "powershell");
        assert.doesNotMatch(run, /ConvertFrom-Json -AsHashtable/);
        assert.match(run, /qualifying/);
        assert.match(run, /releaseGatesCleared/);
        assert.match(run, /canaryPassed/);
        assert.match(run, /offlineCanaryPassed/);
        assert.match(run, /cleanup\.result\.json/);
        assert.match(run, /awaitingContinuation/);
        assert.match(run, /requestSha256/);
        assert.match(run, /Invoke-PureValidator 'ClassifyBoundary'/);
        assert.match(run, /Invoke-PureValidator 'ValidateProbe'/);
        assert.match(run, /status/);
        assert.match(run, /sourceSha/);
        assert.match(run, /eventSha/);
        assert.match(run, /runId/);
        assert.match(run, /runAttempt/);
        assert.match(run, /nonce/);
        assert.doesNotMatch(run, /continue-on-error/);
    });
});

describe("downloaded canary closure validation", {
    skip: !hasPowerShell && "inbox Windows PowerShell 5.1 unavailable; static workflow boundaries still run"
}, () => {
    const validate = (context, mutate = () => {}) => {
        const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-winsw-workflow-"));
        context.after(() => fs.rmSync(runnerTemp, {recursive: true, force: true}));
        const closureRoot = path.join(runnerTemp, "winsw-offline-closure");
        fs.mkdirSync(closureRoot);
        const script = Buffer.from("throw 'synthetic script must never execute'\r\n");
        const winsw = Buffer.from("synthetic WinSW bytes");
        const injectedWinswHash = crypto.createHash("sha256").update(winsw).digest("hex");
        const records = [
            {name: "windows-winsw-offline-canary.ps1", bytes: script.length,
                sha256: crypto.createHash("sha256").update(script).digest("hex")},
            {name: "WinSW-x64.exe", bytes: winsw.length, sha256: injectedWinswHash}
        ];
        fs.writeFileSync(path.join(closureRoot, records[0].name), script);
        fs.writeFileSync(path.join(closureRoot, records[1].name), winsw);
        const manifest = {schemaVersion: 1, kind: "myspeed-winsw-offline-canary-closure",
            expectedRunId: RUN_ID, expectedRunAttempt: RUN_ATTEMPT, expectedSourceSha: SOURCE_SHA,
            expectedEventSha: EVENT_SHA, nonce: NONCE, files: records};
        mutate({runnerTemp, closureRoot, manifest, records});
        fs.writeFileSync(path.join(closureRoot, "closure.json"), JSON.stringify(manifest));
        const run = step(config().jobs.canary, "validate").run
            .replaceAll(WINSW_SHA256, injectedWinswHash)
            .replace("$EXPECTED_WINSW_BYTES = 18286774", `$EXPECTED_WINSW_BYTES = ${winsw.length}`);
        const boundary = run.indexOf("[IO.File]::AppendAllText($env:GITHUB_OUTPUT");
        assert.ok(boundary > 0);
        const validationOnly = run.slice(0, boundary);
        assert.doesNotMatch(validationOnly, /InvokeHostedCanary|InvokePostReconnect|& \$scriptPath/);
        return spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
            `${validationOnly}\nWrite-Output 'validation-accepted'`], {timeout: SHELL_TIMEOUT_MS, encoding: "utf8",
            env: inboxEnvironment({RUNNER_TEMP: runnerTemp, EXPECTED_SOURCE_SHA: SOURCE_SHA,
                EXPECTED_EVENT_SHA: EVENT_SHA, EXPECTED_RUN_ID: RUN_ID, EXPECTED_RUN_ATTEMPT: RUN_ATTEMPT,
                EXPECTED_NONCE: NONCE, GITHUB_OUTPUT: path.join(runnerTemp, "output.txt")})});
    };

    it("accepts an injected ordinary exact closure without executing it", context => {
        const result = validate(context);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /validation-accepted/);
    });

    for (const [name, mutate] of [
        ["unexpected member", ({closureRoot}) => fs.writeFileSync(path.join(closureRoot, "extra"), "x")],
        ["wrong source", ({manifest}) => { manifest.expectedSourceSha = "c".repeat(40); }],
        ["wrong nonce", ({manifest}) => { manifest.nonce = "f".repeat(32); }],
        ["wrong kind", ({manifest}) => { manifest.kind = "other"; }],
        ["array run ID", ({manifest}) => { manifest.expectedRunId = [RUN_ID]; }],
        ["array source SHA", ({manifest}) => { manifest.expectedSourceSha = [SOURCE_SHA]; }],
        ["string schema", ({manifest}) => { manifest.schemaVersion = "1"; }],
        ["double schema", ({manifest}) => { manifest.schemaVersion = 1.5; }],
        ["scalar files", ({manifest}) => { manifest.files = manifest.files[0]; }],
        ["extra manifest field", ({manifest}) => { manifest.extra = true; }],
        ["wrong order", ({manifest}) => { manifest.files.reverse(); }],
        ["array file name", ({manifest}) => { manifest.files[0].name = [manifest.files[0].name]; }],
        ["double file bytes", ({manifest}) => { manifest.files[0].bytes += 0.5; }],
        ["array file hash", ({manifest}) => { manifest.files[0].sha256 = [manifest.files[0].sha256]; }],
        ["wrong script hash", ({manifest}) => { manifest.files[0].sha256 = "d".repeat(64); }],
        ["wrong WinSW identity", ({manifest}) => { manifest.files[1].sha256 = "e".repeat(64); }]
    ]) {
        it(`rejects ${name} before executing closure content`, context => {
            const result = validate(context, mutate);
            assert.notEqual(result.status, 0, result.stdout);
            assert.doesNotMatch(result.stdout, /validation-accepted/);
            assert.match(result.stderr, /Closure|WinSW/);
        });
    }
});

describe("independent post-reconnect evidence consumer", {
    skip: !hasPowerShell && "inbox Windows PowerShell 5.1 unavailable; static workflow boundaries still run"
}, () => {
    const makeBoundary = () => ({
        schemaVersion: 1,
        offlineTiming: {clock: "QueryUnbiasedInterruptTime100ns", start100ns: "100000000",
            end100ns: "550000000", watchdogDeadline100ns: "700000000", elapsedMilliseconds: 45_000},
        providers: {adapters: true, ipInterfaces: true, ipAddresses: true, routes: true},
        adapters: [
            {interfaceGuid: "{11111111-1111-1111-1111-111111111111}", netLuid: "0006000001000000",
                hidden: false, loopback: false, enabled: false, status: "Disabled"},
            {interfaceGuid: "{22222222-2222-2222-2222-222222222222}", netLuid: "0018000001000000",
                hidden: true, loopback: true, enabled: true, status: "Up"}
        ],
        ipState: ["interface", "address", "route"].map(kind =>
            ({kind, compartmentId: 1, loopback: true, routable: false})),
        loopback: LOOPBACK_ENDPOINTS.map(endpoint => ({...endpoint, passed: true, ownerPid: 101})),
        testNet: ["controller", "child"].flatMap(actor => TEST_NET_ENDPOINTS.map(endpoint =>
            ({actor, ...endpoint, outcome: "denied"})))
    });
    const makeConfiguration = (nonce = NONCE) => {
        const bytes = Buffer.from(["<service>", `  <id>MySpeedOfflineCanary-${nonce}</id>`,
            `  <name>MySpeed Offline Canary ${nonce}</name>`,
            "  <description>Candidate-neutral WinSW inheritance canary</description>",
            "  <executable>inert-child.exe</executable>", "  <startmode>Manual</startmode>",
            "  <stoptimeout>5 sec</stoptimeout>", "</service>", ""].join("\r\n"));
        return {bytes, record: {bytesBase64: bytes.toString("base64"), sha256: sha256(bytes)}};
    };
    const runContinuation = (context, mutate = () => {}) => {
        const lexicalRunnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-winsw-consumer-"));
        const runnerTemp = fs.realpathSync.native(lexicalRunnerTemp);
        context.after(() => fs.rmSync(runnerTemp, {recursive: true, force: true}));
        const closureRoot = path.join(runnerTemp, "winsw-offline-closure");
        const root = path.join(runnerTemp, `myspeed-winsw-offline-${NONCE}`);
        fs.mkdirSync(closureRoot);
        fs.mkdirSync(root);
        const wrapper = Buffer.from("synthetic pinned WinSW copy");
        const wrapperHash = sha256(wrapper);
        const scriptPath = path.join(closureRoot, "windows-winsw-offline-canary.ps1");
        const script = fs.readFileSync(SCRIPT, "utf8").replaceAll(WINSW_SHA256, wrapperHash);
        fs.writeFileSync(scriptPath, script);
        assert.equal(scriptPath, fs.realpathSync.native(scriptPath),
            `consumer fixture path must be canonical before serialization; lexical=${lexicalRunnerTemp}; canonical=${runnerTemp}`);
        const sourcePath = path.join(root, "inert-child.cs");
        const childPath = path.join(root, "inert-child.exe");
        const serviceExecutablePath = path.join(root, `MySpeedOfflineCanary-${NONCE}.exe`);
        const serviceXmlPath = path.join(root, `MySpeedOfflineCanary-${NONCE}.xml`);
        const sourceBytes = Buffer.from("synthetic inert source");
        const childBytes = Buffer.from("synthetic inert child");
        const configuration = makeConfiguration();
        fs.writeFileSync(sourcePath, sourceBytes);
        fs.writeFileSync(childPath, childBytes);
        fs.writeFileSync(serviceExecutablePath, wrapper);
        fs.writeFileSync(serviceXmlPath, configuration.bytes);
        const compilerPath = path.join(process.env.SystemRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
        assert.ok(fs.existsSync(compilerPath), "inbox compiler fixture must exist");
        const compilerHash = sha256(fs.readFileSync(compilerPath));
        const winswStatus = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
            `(Get-AuthenticodeSignature -LiteralPath '${serviceExecutablePath.replaceAll("'", "''")}').Status`],
        {encoding: "utf8", env: inboxEnvironment({})}).stdout.trim();
        const request = {
            schemaVersion: 1, kind: "myspeed-winsw-offline-recovery-request", expectedRunId: RUN_ID,
            expectedRunAttempt: RUN_ATTEMPT, expectedEventSha: EVENT_SHA, expectedSourceSha: SOURCE_SHA,
            expectedImageVersion: IMAGE_VERSION, nonce: NONCE, scriptPath, scriptSha256: sha256(Buffer.from(script)), root,
            taskRoot: root, lockPath: path.join(root, "recovery.lock"), cancelPath: path.join(root, "recovery.cancel"),
            readyPath: path.join(root, "recovery.ready.json"), recoveryResultPath: path.join(root, "recovery.result.json"),
            cleanupResultPath: path.join(root, "cleanup.result.json"), ownershipPath: path.join(root, "service.ownership.json"),
            taskName: `MySpeedOfflineRecovery-${NONCE}`, serviceName: `MySpeedOfflineCanary-${NONCE}`,
            serviceExecutablePath, serviceXmlPath, childPath, environment: {...EXPECTED_ENVIRONMENT},
            adapters: [{interfaceGuid: "{11111111-1111-1111-1111-111111111111}",
                netLuid: "0006000001000000"}],
            offlineStart100ns: "100000000", watchdogDeadline100ns: "700000000"
        };
        delete request.root;
        const probe = {
            schemaVersion: 1, nonce: NONCE, serviceName: request.serviceName, wrapperPid: 100, childPid: 101,
            parentPid: 100, wrapperCreationFileTime: "0000000000000001", childCreationFileTime: "0000000000000002",
            sid: "S-1-5-18", environment: {...EXPECTED_ENVIRONMENT}, forbiddenNames: [], configuration: configuration.record,
            endpoints: LOOPBACK_ENDPOINTS.map(endpoint => ({...endpoint, ownerPid: 101})), winswSha256: wrapperHash,
            childSha256: sha256(childBytes)
        };
        const build = {sourcePath, sourceSha256: sha256(sourceBytes), compiler: {path: compilerPath,
            sha256: compilerHash, fileVersion: fs.statSync(compilerPath).isFile() ?
                spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
                    `[Diagnostics.FileVersionInfo]::GetVersionInfo('${compilerPath.replaceAll("'", "''")}').FileVersion`],
                {encoding: "utf8", env: inboxEnvironment({})}).stdout.trim() : ""},
        childPath, childSha256: sha256(childBytes),
        configurationSha256: configuration.record.sha256, winswAuthenticodeStatus: winswStatus};
        const operation = (file, args, processId) => ({file, arguments: args, processId, exitCode: 0,
            jobAssignedBeforeResume: true, processTreeExitProven: true, outputCaptured: false});
        const result = {
            schemaVersion: 1, kind: "myspeed-winsw-offline-canary", status: "completed", qualifying: false,
            canaryPassed: false, offlineCanaryPassed: true, sourceSha: SOURCE_SHA, eventSha: EVENT_SHA, runId: RUN_ID,
            runAttempt: RUN_ATTEMPT, imageVersion: IMAGE_VERSION, nonce: NONCE,
            preDisable: {providers: {adapters: true, ipInterfaces: true, ipAddresses: true, routes: true},
                adapters: [
                    {interfaceGuid: "{11111111-1111-1111-1111-111111111111}", netLuid: "0006000001000000",
                        hidden: false, loopback: false, enabled: true, status: "Up"},
                    {interfaceGuid: "{22222222-2222-2222-2222-222222222222}", netLuid: "0018000001000000",
                        hidden: true, loopback: true, enabled: true, status: "Up"}
                ], ipState: ["interface", "address", "route"].map(kind =>
                    ({kind, compartmentId: 1, loopback: kind !== "route", routable: kind === "route"}))},
            boundary: makeBoundary(), probe,
            recovery: {schemaVersion: 1, classification: "awaitingContinuation", emergencyRestore: false,
                serviceTeardownProven: true, adapterRestoreProven: true, recoveryTaskGoneProven: true,
                environmentRestoredProven: true, continuationObserved: false, cleanupAfterReconnectProven: false,
                phaseOrder: ["teardownService", "restoreAdapters", "disarmRecovery", "restoreEnvironment"]},
            events: ["prepare", "armRecovery", "disableAdapters", "verifyOffline", "startService", "probe",
                "teardownService", "restoreAdapters", "disarmRecovery", "restoreEnvironment"], failures: [], build,
            operations: [
                operation(compilerPath, ["/nologo", "/target:exe", "/platform:x64", "/optimize+",
                    `/out:${childPath}`, sourcePath], 200),
                ...["install", "start", "stop", "uninstall"].map((command, index) =>
                    operation(serviceExecutablePath, [command], 201 + index))
            ], releaseGatesCleared: []
        };
        const requestPath = path.join(root, "recovery.request.json");
        fs.writeFileSync(requestPath, JSON.stringify(request));
        const cleanup = {schemaVersion: 1, status: "completed", classification: "completed", qualifying: false,
            canaryPassed: true, emergencyRestore: false, serviceTeardownProven: true, adapterRestoreProven: true,
            recoveryTaskGoneProven: true, environmentRestoredProven: true, continuationObserved: true,
            cleanupAfterReconnectProven: true, requestSha256: sha256(fs.readFileSync(requestPath)), sourceSha: SOURCE_SHA,
            eventSha: EVENT_SHA, runId: RUN_ID, runAttempt: RUN_ATTEMPT, nonce: NONCE, releaseGatesCleared: []};
        mutate({runnerTemp, root, request, requestPath, result, cleanup});
        fs.writeFileSync(requestPath, JSON.stringify(request));
        if (cleanup.requestSha256 !== "preserve") cleanup.requestSha256 = sha256(fs.readFileSync(requestPath));
        fs.writeFileSync(path.join(root, "result.json"), JSON.stringify(result));
        fs.writeFileSync(path.join(root, "cleanup.result.json"), JSON.stringify(cleanup));
        const run = step(config().jobs.canary, "continuation").run.replaceAll(WINSW_SHA256, wrapperHash);
        return spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", run], {
            timeout: SHELL_TIMEOUT_MS, encoding: "utf8", env: inboxEnvironment({RUNNER_TEMP: runnerTemp,
                EXPECTED_NONCE: NONCE, EXPECTED_SOURCE_SHA: SOURCE_SHA, EXPECTED_EVENT_SHA: EVENT_SHA,
                EXPECTED_RUN_ID: RUN_ID, EXPECTED_RUN_ATTEMPT: RUN_ATTEMPT, ImageVersion: IMAGE_VERSION})
        });
    };

    it("accepts only the exact main and post-reconnect evidence pair", context => {
        const result = runContinuation(context);
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    });

    for (const [name, mutate, expected] of [
        ["a pre-continuation pass claim", ({result}) => { result.canaryPassed = true; }, /pass flag/i],
        ["a missing offline pass", ({result}) => { result.offlineCanaryPassed = false; }, /offline pass/i],
        ["an unproven cleanup", ({cleanup}) => { cleanup.cleanupAfterReconnectProven = false; }, /cleanupAfterReconnect/i],
        ["a forged cleanup request digest", ({cleanup}) => { cleanup.requestSha256 = "preserve"; }, /requestSha256|request digest/i],
        ["an emergency recovery file", ({root}) => fs.writeFileSync(path.join(root, "recovery.result.json"), "{}"), /Emergency/i],
        ["a string schema", ({result}) => { result.schemaVersion = "1"; }, /schema/i],
        ["an array source identity", ({result}) => { result.sourceSha = [SOURCE_SHA]; }, /sourceSha/i],
        ["a valid but differently bound recovery request", ({request}) => { request.expectedRunId = "987654321"; },
            /Recovery request expectedRunId/i],
        ["a malformed offline boundary", ({result}) => { result.boundary.providers.routes = false; }, /Boundary|provider/i],
        ["a valid but differently timed boundary", ({result, request}) => {
            result.boundary.offlineTiming.start100ns = "200000000";
            result.boundary.offlineTiming.end100ns = "650000000";
            result.boundary.offlineTiming.watchdogDeadline100ns = "800000000";
            request.offlineStart100ns = "100000000";
            request.watchdogDeadline100ns = "700000000";
        }, /Boundary offline start/i],
        ["an unbound pre-disable snapshot", ({result}) => {
            result.preDisable.adapters[0].netLuid = "0006000003000000";
        },
            /pre-disable|Recovery adapter/i],
        ["an uppercase pre-disable LUID", ({result}) => {
            result.preDisable.adapters[0].netLuid = "000600000A000000";
        }, /pre-disable|Recovery adapter/i],
        ["a stale PnP adapter schema", ({result}) => {
            const adapter = result.preDisable.adapters[0];
            adapter.pnpDeviceId = adapter.netLuid;
            delete adapter.netLuid;
        }, /Pre-disable adapter schema/i],
        ["a mixed PnP and LUID schema", ({result}) => {
            result.preDisable.adapters[0].pnpDeviceId = result.preDisable.adapters[0].netLuid;
        }, /Pre-disable adapter schema/i],
        ["a stale display-description schema", ({result}) => {
            const adapter = result.preDisable.adapters[0];
            adapter.interfaceDescription = adapter.netLuid;
            delete adapter.netLuid;
        }, /Pre-disable adapter schema/i],
        ["a mixed display-description and LUID schema", ({result}) => {
            result.preDisable.adapters[0].interfaceDescription = result.preDisable.adapters[0].netLuid;
        }, /Pre-disable adapter schema/i],
        ["a zero LUID", ({result}) => {
            result.preDisable.adapters[0].netLuid = "0".repeat(NET_LUID_HEX_LENGTH);
        }, /Pre-disable adapter identity/i],
        ["a missing LUID", ({result}) => {
            delete result.preDisable.adapters[0].netLuid;
        }, /Pre-disable adapter schema/i],
        ["a null LUID", ({result}) => {
            result.preDisable.adapters[0].netLuid = null;
        }, /Pre-disable adapter identity/i],
        ["a blank LUID", ({result}) => {
            result.preDisable.adapters[0].netLuid = "   ";
        }, /Pre-disable adapter identity/i],
        ["a control-bearing LUID", ({result}) => {
            result.preDisable.adapters[0].netLuid = "Synthetic\nEthernet";
        }, /Pre-disable adapter identity/i],
        ["a non-hexadecimal LUID", ({result}) => {
            result.preDisable.adapters[0].netLuid = `Synthetic${String.fromCharCode(0xad)} Ethernet 0`;
        }, /pre-disable|Recovery adapter/i],
        ["an oversized LUID", ({result}) => {
            result.preDisable.adapters[0].netLuid = "x".repeat(NET_LUID_HEX_LENGTH + 1);
        }, /Pre-disable adapter identity/i],
        ["a duplicate LUID", ({result}) => {
            result.preDisable.adapters[1].netLuid = result.preDisable.adapters[0].netLuid;
        }, /duplicated/i],
        ["a malformed LocalSystem probe", ({result}) => { result.probe.sid = "S-1-5-19"; }, /Probe|LocalSystem/i],
        ["a valid but differently bound probe", ({result}) => {
            const otherNonce = "fedcba9876543210fedcba9876543210";
            result.probe.nonce = otherNonce;
            result.probe.serviceName = `MySpeedOfflineCanary-${otherNonce}`;
            result.probe.configuration = makeConfiguration(otherNonce).record;
        }, /Probe nonce/i],
        ["an unassigned operation", ({result}) => { result.operations[0].jobAssignedBeforeResume = false; }, /Job proof/i]
    ]) {
        it(`rejects ${name}`, context => {
            const result = runContinuation(context, mutate);
            assert.notEqual(result.status, 0, result.stdout);
            assert.match(`${result.stdout}\n${result.stderr}`, expected);
        });
    }
});

describe("bounded canary evidence retention", {
    skip: !hasPowerShell && "inbox Windows PowerShell 5.1 unavailable; static workflow boundaries still run"
}, () => {
    const runBounds = (context, {cleanupOutcome = "success", arrange = () => {}} = {}) => {
        const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-winsw-evidence-"));
        context.after(() => fs.rmSync(runnerTemp, {recursive: true, force: true}));
        const root = path.join(runnerTemp, `myspeed-winsw-offline-${NONCE}`);
        const uploadRoot = path.join(runnerTemp, `myspeed-winsw-offline-upload-${NONCE}`);
        arrange({runnerTemp, root, uploadRoot});
        const output = path.join(runnerTemp, "output.txt");
        const run = step(config().jobs.canary, "bound_evidence").run;
        const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", run], {
            timeout: SHELL_TIMEOUT_MS, encoding: "utf8", env: inboxEnvironment({RUNNER_TEMP: runnerTemp,
                EXPECTED_NONCE: NONCE, EXPECTED_SOURCE_SHA: SOURCE_SHA, EXPECTED_EVENT_SHA: EVENT_SHA,
                EXPECTED_RUN_ID: RUN_ID, EXPECTED_RUN_ATTEMPT: RUN_ATTEMPT,
                CLEANUP_OUTCOME: cleanupOutcome, GITHUB_OUTPUT: output})
        });
        return {result, root, uploadRoot, output};
    };

    it("creates only a bounded nonqualifying diagnostic when the controller produced no result", context => {
        const {result, uploadRoot, output} = runBounds(context);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(fs.readFileSync(output, "utf8"), "safe=true\n");
        const entries = fs.readdirSync(uploadRoot);
        assert.deepEqual(entries, ["workflow-diagnostic.json"]);
        const diagnostic = JSON.parse(fs.readFileSync(path.join(uploadRoot, entries[0]), "utf8"));
        assert.equal(diagnostic.qualifying, false);
        assert.equal(diagnostic.sourceSha, SOURCE_SHA);
        assert.equal(diagnostic.eventSha, EVENT_SHA);
        assert.equal(diagnostic.runId, RUN_ID);
        assert.equal(diagnostic.runAttempt, RUN_ATTEMPT);
        assert.equal(diagnostic.nonce, NONCE);
    });

    it("retains only a fixed diagnostic when post-reconnect cleanup is unproven", context => {
        const {result, uploadRoot, output} = runBounds(context, {cleanupOutcome: "failure", arrange: ({root}) => {
            fs.mkdirSync(root);
            fs.mkdirSync(path.join(root, "must-not-be-inspected"));
        }});
        assert.equal(result.status, 0, result.stderr);
        assert.equal(fs.readFileSync(output, "utf8"), "safe=true\n");
        const entries = fs.readdirSync(uploadRoot);
        assert.deepEqual(entries, ["workflow-diagnostic.json"]);
        const diagnostic = JSON.parse(fs.readFileSync(path.join(uploadRoot, entries[0]), "utf8"));
        assert.equal(diagnostic.reason, "post-reconnect-cleanup-not-proven");
        assert.equal(diagnostic.qualifying, false);
    });

    it("quarantines an unsafe native evidence tree and retains only a fixed diagnostic", context => {
        const {result, uploadRoot} = runBounds(context, {arrange: ({root}) => {
            fs.mkdirSync(root);
            fs.mkdirSync(path.join(root, "unexpected"));
        }});
        assert.equal(result.status, 0, result.stderr);
        const entries = fs.readdirSync(uploadRoot);
        assert.deepEqual(entries, ["workflow-diagnostic.json"]);
        const diagnostic = JSON.parse(fs.readFileSync(path.join(uploadRoot, entries[0]), "utf8"));
        assert.equal(diagnostic.reason, "native-evidence-physical-validation-failed");
        assert.equal(diagnostic.qualifying, false);
    });

    it("never copies native executables into the bounded upload root", context => {
        const {result, uploadRoot} = runBounds(context, {arrange: ({root}) => {
            fs.mkdirSync(root);
            fs.writeFileSync(path.join(root, "result.json"), "{}");
            fs.writeFileSync(path.join(root, "inert-child.exe"), "synthetic native bytes");
        }});
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(fs.readdirSync(uploadRoot), ["result.json"]);
    });
});
