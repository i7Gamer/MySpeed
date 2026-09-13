import {describe, it} from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {parse} from "yaml";

const WORKFLOW = ".github/workflows/windows-msi-rollback-calibration.yml";
const SCRIPT = "scripts/qualification/windows-msi-rollback-calibration.ps1";
const TEST = "tests/server/windowsMsiRollbackCalibration.test.js";
const WORKFLOW_TEST = "tests/server/windowsMsiRollbackCalibrationWorkflow.test.js";
const NATIVE_SCRIPT = "scripts/qualification/windows-msi-rollback-native.ps1";
const NATIVE_TEST = "tests/server/windowsMsiRollbackNative.test.js";
const STATE_SCRIPT = "scripts/qualification/windows-msi-rollback-state.ps1";
const LAUNCHER_SCRIPT = "scripts/qualification/media-job-launcher.ps1";
const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const DOWNLOAD = "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c";
const UPLOAD = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const WIX_URL = "https://github.com/wixtoolset/wix3/releases/download/wix3141rtm/wix314-binaries.zip";
const WIX_SHA256 = "6ac824e1642d6f7277d0ed7ea09411a508f6116ba6fae0aa5f2c7daa2ff43d31";
const SOURCE_EXPRESSION = "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}";
const EVENT_EXPRESSION = "${{ github.sha }}";
const SOURCE_SHA = "a".repeat(40);
const EVENT_SHA = "b".repeat(40);
const RUN_ID = "123456789";
const RUN_ATTEMPT = "2";
const NONCE = "0123456789abcdef0123456789abcdef";
const PACKED_PREDECESSOR_PRODUCT = "006C6171B5C7BC54981F852441021796";
const PACKED_CANDIDATE_PRODUCT = "879E39FF911E84D43BB74248759E052A";
const PACKED_UPGRADE = "D471F68A7A34AAD429E690E7D0A01514";
const POWERSHELL = process.platform === "win32"
    ? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : "pwsh";
const PWSH = "pwsh";
const PROCESS_TIMEOUT_MS = 15_000;
const HAS_POWERSHELL = process.platform === "win32" ||
    childProcess.spawnSync(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"],
        {timeout: PROCESS_TIMEOUT_MS}).status === 0;
const WINDOWS_ONLY = {skip: process.platform !== "win32" &&
    "requires inbox Windows PowerShell and Windows path/stream semantics"};
const CLOSURE_FILES = [
    "windows-msi-rollback-calibration.ps1", "windows-msi-rollback-native.ps1",
    "windows-msi-rollback-state.ps1", "media-job-launcher.ps1", "fixture-definitions.json",
    "predecessor.wxs", "predecessor-payload.txt", "predecessor.msi",
    "candidate.wxs", "candidate-payload.txt", "candidate.msi", "build-provenance.json"
];
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
const quotePowerShell = value => `'${value.replaceAll("'", "''")}'`;

describe("sacrificial MSI rollback transport workflow", () => {
    it("is manual, nonpublishing, repository-bound, and candidate-neutral", () => {
        const workflow = config();
        assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch", "pull_request"]);
        assert.deepEqual(workflow.on.pull_request.branches, ["development"]);
        assert.ok(workflow.on.pull_request.paths.includes(WORKFLOW));
        assert.deepEqual(workflow.permissions, {actions: "read", contents: "read"});
        assert.equal(workflow.env.EXPECTED_SOURCE_SHA, SOURCE_EXPRESSION);
        assert.equal(workflow.env.EXPECTED_EVENT_SHA, EVENT_EXPRESSION);
        assert.match(workflow.jobs.prepare.if, /pull_request\.head\.repo\.full_name == github\.repository/);
        assert.doesNotMatch(source(), /MySpeed(?:\.exe|Service)|windowsNative|msiLifecycle.*true/i);
        assert.doesNotMatch(source(), /contents:\s*write|packages:\s*write|gh\s+release|create-release/i);
    });

    it("renders and builds only the two fixed data-only fixtures with pinned WiX", () => {
        const {prepare} = config().jobs;
        assert.equal(prepare["runs-on"], "windows-2025");
        const checkout = action(prepare, "actions/checkout");
        assert.equal(checkout.uses, CHECKOUT);
        assert.deepEqual(checkout.with, {ref: SOURCE_EXPRESSION, "persist-credentials": false});
        const acquire = step(prepare, "acquire_wix");
        assert.equal(acquire.env.WIX_URL, WIX_URL);
        assert.equal(acquire.env.WIX_SHA256, WIX_SHA256);
        assert.match(acquire.run, /Invoke-WebRequest/);
        assert.match(acquire.run, /Get-FileHash/);
        assert.doesNotMatch(acquire.run, /choco|winget|PATH\s*=/i);
        const build = step(prepare, "build_fixtures");
        assert.match(build.run, /-Mode GetFixtures/);
        assert.match(build.run, /WindowsPowerShell\\v1\.0\\powershell\.exe/);
        assert.match(build.run, /& \$inboxPowerShell[^]*?-File \$scriptPath[^\r\n]+-Mode GetFixtures/);
        assert.doesNotMatch(build.run, /\$fixtureJson\s*=\s*& \$scriptPath/);
        assert.match(build.run, /candle\.exe/);
        assert.match(build.run, /light\.exe/);
        assert.match(build.run, /light\.exe'\) @lightArguments/,
            "light must not add an unsealed wixpdb sidecar to the closure");
        assert.match(build.run, /candle\.exe'\) @candleArguments/);
        assert.match(build.run, /foreach \(\$role in @\('predecessor','candidate'\)\)/);
        assert.doesNotMatch(build.run, /if \(Test-Path[^\r\n]+-or Test-Path/,
            "PowerShell must parenthesize each Test-Path expression around -or");
        assert.doesNotMatch(acquire.run, /if \(Test-Path[^\r\n]+-or Test-Path/,
            "PowerShell must parenthesize each Test-Path expression around -or");
        assert.doesNotMatch(build.run, /CustomAction|ServiceInstall|ServiceControl|Registry/i);
        assert.doesNotMatch(build.run, /-sice:|SuppressIces/i);
    });

    it("gets a real child exit code when fixture rendering fails", WINDOWS_ONLY, context => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-msi-fixture-render-"));
        context.after(() => fs.rmSync(root, {recursive: true, force: true}));
        const stub = path.join(root, "fixture renderer.ps1");
        fs.writeFileSync(stub, "Write-Output '{}'; exit 7\n");
        const original = step(config().jobs.prepare, "build_fixtures").run;
        const script = original.replace(
            "[IO.Path]::GetFullPath('scripts/qualification/windows-msi-rollback-calibration.ps1')",
            quotePowerShell(stub));
        const result = childProcess.spawnSync(POWERSHELL,
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
            {encoding: "utf8", timeout: PROCESS_TIMEOUT_MS,
                env: inboxEnvironment({RUNNER_TEMP: root})});
        assert.notEqual(result.status, 0);
        assert.match(`${result.stdout}\n${result.stderr}`, /Fixture rendering failed with exit 7/u);
        assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /LASTEXITCODE.*not been set/u);
    });

    it("renders the real bounded fixture JSON across the PowerShell 7 to inbox 5.1 boundary", WINDOWS_ONLY, () => {
        const build = step(config().jobs.prepare, "build_fixtures").run;
        const start = build.indexOf("$nonce =");
        const end = build.indexOf("[IO.File]::WriteAllBytes");
        assert.ok(start >= 0 && end > start);
        const prefix = build.slice(start, end);
        assert.doesNotMatch(prefix, /candle|light|MsiInstallProduct|msiexec/iu);
        const command = [
            "$MAX_FIXTURE_JSON_BYTES = 262144",
            prefix,
            "[ordered]@{edition=$PSVersionTable.PSEdition;nonce=$nonce;fixtures=@($fixtureDefinitions.fixtures)} | ConvertTo-Json -Depth 12 -Compress"
        ].join("\n");
        const result = childProcess.spawnSync(PWSH,
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
            {encoding: "utf8", timeout: PROCESS_TIMEOUT_MS, cwd: process.cwd()});
        assert.equal(result.status, 0, result.stderr);
        const rendered = JSON.parse(result.stdout);
        assert.equal(rendered.edition, "Core");
        assert.match(rendered.nonce, /^[0-9a-f]{32}$/u);
        assert.deepEqual(rendered.fixtures.map(({role}) => role), ["predecessor", "candidate"]);
    });

    it("renders the exact x64 compiler and source-rooted linker argument vectors", WINDOWS_ONLY, () => {
        const build = step(config().jobs.prepare, "build_fixtures").run;
        const candle = build.match(/\$candleArguments\s*=\s*@\([^\r\n]+\)/)?.[0];
        const light = build.match(/\$lightArguments\s*=\s*@\([^\r\n]+\)/)?.[0];
        assert.ok(candle && light);
        const command = [
            `$stage='C:\\owned path\\predecessor'`,
            `$stageWxs=Join-Path $stage 'predecessor.wxs'`,
            `$wixObject=Join-Path $stage 'predecessor.wixobj'`,
            `$msiPath='C:\\sealed path\\predecessor.msi'`,
            candle, light,
            `@{candle=@($candleArguments);light=@($lightArguments)}|ConvertTo-Json -Compress`
        ].join("\n");
        const result = childProcess.spawnSync(POWERSHELL,
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
            {encoding: "utf8", timeout: PROCESS_TIMEOUT_MS});
        assert.equal(result.status, 0, result.stderr);
        const vectors = JSON.parse(result.stdout);
        assert.deepEqual(vectors.candle, ["-nologo", "-arch", "x64", "-out",
            "C:\\owned path\\predecessor\\predecessor.wixobj",
            "C:\\owned path\\predecessor\\predecessor.wxs"]);
        assert.deepEqual(vectors.light, ["-nologo", "-spdb", "-v", "-b",
            "C:\\owned path\\predecessor", "-out", "C:\\sealed path\\predecessor.msi",
            "C:\\owned path\\predecessor\\predecessor.wixobj"]);
    });

    it("seals one exact same-run closure and transports it only by artifact ID", () => {
        const {prepare, execute} = config().jobs;
        const seal = step(prepare, "seal_closure");
        for (const binding of ["EXPECTED_SOURCE_SHA", "EXPECTED_EVENT_SHA", "EXPECTED_RUN_ID",
            "EXPECTED_RUN_ATTEMPT", "nonce", "Get-FileHash", "FileMode]::CreateNew"])
            assert.ok(seal.run.includes(binding), binding);
        for (const name of CLOSURE_FILES) assert.ok(seal.run.includes(name), name);
        const upload = action(prepare, "actions/upload-artifact");
        assert.equal(upload.uses, UPLOAD);
        assert.equal(upload.with["if-no-files-found"], "error");
        assert.equal(prepare.outputs.artifact_id, "${{ steps.upload.outputs.artifact-id }}");
        assert.equal(execute.needs, "prepare");
        assert.equal(action(execute, "actions/checkout"), undefined);
        const download = action(execute, "actions/download-artifact");
        assert.equal(download.uses, DOWNLOAD);
        assert.equal(download.with["artifact-ids"], "${{ needs.prepare.outputs.artifact_id }}");
        assert.equal(download.with["merge-multiple"], true);
        assert.equal(download.with.pattern, undefined);
        assert.equal(download.with.name, undefined);
    });

    it("validates closure, hosted context, ownership, and registry collisions before the owned native calibration", () => {
        const {execute} = config().jobs;
        assert.equal(execute["runs-on"], "windows-2025");
        const validate = step(execute, "validate_closure");
        const guard = step(execute, "guard_executor");
        const collision = step(execute, "collision_guard");
        const invoke = step(execute, "native_calibration");
        const confirm = step(execute, "confirm_calibration");
        for (const token of ["ReparsePoint", "LinkType", "-Stream '*'", "Get-FileHash", "closure.json",
            "build-provenance.json", "fixture-definitions.json", "EXPECTED_NONCE"])
            assert.ok(validate.run.includes(token), token);
        assert.match(guard.run, /PSEdition.*Desktop/);
        assert.match(guard.run, /WindowsPowerShell\\v1\.0\\powershell\.exe/);
        assert.match(guard.run, /FileMode\]::CreateNew/);
        assert.match(collision.run, /Installer\\UserData\\S-1-5-18\\Products/);
        assert.match(collision.run, /Installer\\Products/);
        assert.match(collision.run, /Installer\\UpgradeCodes/);
        assert.doesNotMatch(collision.run, /Win32_Product|Get-WmiObject|MsiInstallProduct|msiexec/i);
        assert.match(invoke.run, /Invoke-ObservedOwnedJobProcess/);
        assert.match(invoke.run, /windows-msi-rollback-native\.ps1/);
        assert.match(invoke.run, /-Mode','InvokeHostedCalibration/);
        assert.match(invoke.run,
            /schemaVersion=1;status='observed';action='observe';observation='child-running'/u);
        assert.doesNotMatch(invoke.run,
            /\[pscustomobject\]@\{action='observe';observation='child-running'\}/);
        assert.match(invoke.run, /processTreeExitProven/);
        assert.match(confirm.run, /nativeExecutionAttempted/);
        assert.match(confirm.run, /releaseGatesCleared/);
        assert.match(confirm.run, /cleanupFailures/);
        assert.doesNotMatch(execute.steps.map(({run = ""}) => run).join("\n"), /Win32_Product|Get-WmiObject|msiexec/i);
        assert.ok(execute.steps.indexOf(guard) < execute.steps.indexOf(validate));
        assert.ok(execute.steps.indexOf(validate) < execute.steps.indexOf(collision));
        assert.ok(execute.steps.indexOf(collision) < execute.steps.indexOf(invoke));
        assert.ok(execute.steps.indexOf(invoke) < execute.steps.indexOf(confirm));
    });

    it("passes the actual workflow observer through the real launcher protocol validator", {skip: !HAS_POWERSHELL}, () => {
        const invoke = step(config().jobs.execute, "native_calibration");
        const observer = invoke.run.match(/\$observer\s*=\s*([^]*?)\r?\n\s*\$observerSha/u)?.[1];
        assert.ok(observer);
        const command = [
            `$module=New-Module -ScriptBlock {param($source). $source;Export-ModuleMember -Function Assert-MediaJobObserverResult} -ArgumentList ${quotePowerShell(path.resolve(LAUNCHER_SCRIPT))}`,
            `$observer=${observer}`,
            "$observed=& $observer ([pscustomobject]@{})",
            "$accepted=$true;try{& $module {param($value)Assert-MediaJobObserverResult $value} $observed}catch{$accepted=$false}",
            "$oldShapeRejected=$false;try{& $module {param($value)Assert-MediaJobObserverResult $value} ([pscustomobject]@{action='observe';observation='child-running'})}catch{$oldShapeRejected=$true}",
            "[pscustomobject]@{accepted=$accepted;oldShapeRejected=$oldShapeRejected;value=$observed}|ConvertTo-Json -Compress -Depth 4"
        ].join("\n");
        const result = childProcess.spawnSync(POWERSHELL,
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
            {encoding: "utf8", timeout: PROCESS_TIMEOUT_MS});
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), {accepted: true, oldShapeRejected: true,
            value: {schemaVersion: 1, status: "observed", action: "observe", observation: "child-running"}});
    });

    it("retains only bounded nonqualifying executor evidence", () => {
        const {execute} = config().jobs;
        const bounds = step(execute, "bound_evidence");
        const upload = action(execute, "actions/upload-artifact");
        assert.equal(bounds.if, "always()");
        for (const token of ["MAX_EVIDENCE_BYTES", "MAX_EVIDENCE_FILES", "MAX_JSON_BYTES",
            "ReparsePoint", "LinkType", "-Stream '*'"])
            assert.ok(bounds.run.includes(token), token);
        assert.equal(upload.if, "always() && steps.bound_evidence.outputs.safe == 'true'");
        assert.equal(upload.uses, UPLOAD);
        assert.equal(upload.with["if-no-files-found"], "error");
    });

    it("keeps the native result explicitly nonqualifying despite an accepted calibration", () => {
        const confirm = step(config().jobs.execute, "confirm_calibration").run;
        assert.match(confirm, /qualifying/);
        assert.match(confirm, /releaseGatesCleared/);
        assert.match(confirm, /nativeExecutionAttempted/);
        assert.doesNotMatch(confirm, /releaseGatesCleared\s*=\s*\$true/);
    });

    it("keeps the workflow bound to its QA source and tests", () => {
        const workflow = config();
        const tested = step(workflow.jobs.prepare, "test_contracts").run;
        assert.ok(tested.includes(TEST));
        assert.ok(tested.includes(WORKFLOW_TEST));
        assert.ok(tested.includes("tests/server/windowsMsiRollbackState.test.js"));
        assert.ok(tested.includes(NATIVE_TEST));
        assert.ok(step(workflow.jobs.prepare, "build_fixtures").run.includes(SCRIPT));
        assert.ok(step(workflow.jobs.prepare, "build_fixtures").run.includes(path.basename(NATIVE_SCRIPT)));
        assert.ok(step(workflow.jobs.prepare, "build_fixtures").run.includes(path.basename(STATE_SCRIPT)));
        assert.ok(step(workflow.jobs.prepare, "build_fixtures").run.includes(path.basename(LAUNCHER_SCRIPT)));
    });

    it("keeps every inline PowerShell block syntactically valid",
        {skip: !HAS_POWERSHELL && "PowerShell unavailable; static workflow boundaries still run"}, () => {
        for (const job of Object.values(config().jobs)) for (const candidate of job.steps) {
            if (!candidate.run) continue;
            const encoded = Buffer.from(candidate.run, "utf16le").toString("base64");
            const command = `$e=$null;[Management.Automation.Language.Parser]::ParseInput(` +
                `[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}')),[ref]$null,[ref]$e)|Out-Null;` +
                `if($e.Count){$e|ForEach-Object{Write-Error $_.Message};exit 1}`;
            const result = childProcess.spawnSync(POWERSHELL,
                ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
                {encoding: "utf8", timeout: PROCESS_TIMEOUT_MS});
            assert.equal(result.status, 0, `${candidate.name}\n${result.stdout}\n${result.stderr}`);
        }
    });

    it("derives exact packed registry identities without querying this host", WINDOWS_ONLY, () => {
        const collisionScript = step(config().jobs.execute, "collision_guard").run;
        const command = [
            `$script:observed=[Collections.Generic.List[string]]::new()`,
            `function Test-Path { param([string]$LiteralPath);[void]$script:observed.Add($LiteralPath);return $false }`,
            collisionScript,
            `$script:observed|ConvertTo-Json -Compress`
        ].join("\n");
        const result = childProcess.spawnSync(POWERSHELL,
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
            {encoding: "utf8", timeout: PROCESS_TIMEOUT_MS, env: inboxEnvironment({})});
        assert.equal(result.status, 0, result.stderr);
        const paths = JSON.parse(result.stdout);
        assert.equal(paths.length, 7);
        assert.equal(paths.filter(value => value.includes(PACKED_PREDECESSOR_PRODUCT)).length, 2);
        assert.equal(paths.filter(value => value.includes(PACKED_CANDIDATE_PRODUCT)).length, 2);
        assert.equal(paths.filter(value => value.includes(PACKED_UPGRADE)).length, 1);
        assert.equal(paths.filter(value => value.includes("{1716C600-7C5B-45CB-89F1-584214207169}")).length, 1);
        assert.equal(paths.filter(value => value.includes("{FF93E978-E119-4D48-B37B-248457E950A2}")).length, 1);
    });
});
describe("sacrificial MSI closure prefix", WINDOWS_ONLY, () => {
    const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
    const validate = (context, mutate = () => {}) => {
        const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-msi-transport-"));
        context.after(() => fs.rmSync(runnerTemp, {recursive: true, force: true}));
        const closureRoot = path.join(runnerTemp, "msi-rollback-calibration-closure");
        fs.mkdirSync(closureRoot);
        const files = CLOSURE_FILES.map(name => {
            let body = Buffer.from(`synthetic ${name}`);
            if (name === "fixture-definitions.json") body = Buffer.from(JSON.stringify({qualifying: false,
                nativeExecutionAuthorized: false, releaseGatesCleared: []}));
            if (name === "build-provenance.json") body = Buffer.from(JSON.stringify({qualifying: false,
                nativeExecutionAuthorized: false, releaseGatesCleared: []}));
            fs.writeFileSync(path.join(closureRoot, name), body);
            return {name, bytes: body.length, sha256: hash(body)};
        });
        const manifest = {schemaVersion: 1, kind: "myspeed-msi-sacrificial-calibration-transport-closure",
            expectedRunId: RUN_ID, expectedRunAttempt: RUN_ATTEMPT, expectedSourceSha: SOURCE_SHA,
            expectedEventSha: EVENT_SHA, nonce: NONCE, files};
        mutate({closureRoot, manifest, files});
        fs.writeFileSync(path.join(closureRoot, "closure.json"), JSON.stringify(manifest));
        const script = step(config().jobs.execute, "validate_closure").run;
        return childProcess.spawnSync(POWERSHELL,
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `${script}\n'accepted'`],
            {encoding: "utf8", timeout: PROCESS_TIMEOUT_MS, env: inboxEnvironment({RUNNER_TEMP: runnerTemp,
                EXPECTED_NONCE: NONCE, EXPECTED_RUN_ID: RUN_ID, EXPECTED_RUN_ATTEMPT: RUN_ATTEMPT,
                EXPECTED_SOURCE_SHA: SOURCE_SHA, EXPECTED_EVENT_SHA: EVENT_SHA})});
    };

    it("accepts only an ordinary exact same-run synthetic closure without executing it", context => {
        const result = validate(context);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /accepted/);
    });

    for (const [label, mutate] of [
        ["unexpected member", ({closureRoot}) => fs.writeFileSync(path.join(closureRoot, "extra"), "x")],
        ["wrong source", ({manifest}) => { manifest.expectedSourceSha = EVENT_SHA; }],
        ["wrong file digest", ({manifest}) => { manifest.files[0].sha256 = "d".repeat(64); }],
        ["qualifying nested record", ({closureRoot, files}) => {
            const name = "fixture-definitions.json";
            const body = Buffer.from(JSON.stringify({qualifying: true, nativeExecutionAuthorized: false,
                releaseGatesCleared: []}));
            fs.writeFileSync(path.join(closureRoot, name), body);
            Object.assign(files.find(file => file.name === name), {bytes: body.length, sha256: hash(body)});
        }]
    ]) it(`rejects ${label}`, context => {
        const result = validate(context, mutate);
        assert.notEqual(result.status, 0, result.stdout);
        assert.doesNotMatch(result.stdout, /accepted/);
    });
});
