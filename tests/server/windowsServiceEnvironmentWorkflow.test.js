import {describe, it} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {spawnSync} from "node:child_process";
import {parse} from "yaml";
import {readSource} from "../helpers/source.js";

const WORKFLOW = ".github/workflows/windows-service-environment.yml";
const SCRIPT = "scripts/qualification/windows-service-environment.ps1";
const EVENT_SOURCE = "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}";
const JOB_TIMEOUT_MINUTES = 10;
const SHELL_TIMEOUT_MS = 15_000;
const PROBE_NONCE = "123e4567-e89b-42d3-a456-426614174000";
const SOURCE_SHA = "a".repeat(40);
const EVENT_SHA = "b".repeat(40);
const RUN_ID = "123456789";
const RUN_ATTEMPT = "2";
const powershell = process.platform === "win32" ? "pwsh.exe" : "pwsh";
const hasPowerShell = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"],
    {timeout: SHELL_TIMEOUT_MS}).status === 0;
const config = () => parse(readSource(WORKFLOW));
const action = (job, name) => job.steps.find(({uses}) => uses?.startsWith(`${name}@`));

describe("candidate-neutral hosted Windows service environment workflow", () => {
    it("limits triggers and authority without changing the release contract", () => {
        const workflow = config();
        assert.deepEqual(Object.keys(workflow.on).sort(), ["pull_request", "push", "workflow_dispatch"]);
        assert.deepEqual(workflow.on.push.branches, ["development"]);
        for (const event of ["pull_request", "push"])
            assert.deepEqual(workflow.on[event].paths, [WORKFLOW, SCRIPT,
                "tests/server/windowsServiceEnvironment*.test.js"]);
        assert.deepEqual(workflow.permissions, {actions: "read", contents: "read"});
        assert.deepEqual(Object.keys(workflow.jobs), ["prepare", "canary"]);
        assert.match(workflow.jobs.prepare.if, /github.repository == 'i7Gamer\/MySpeed'/);
        assert.match(workflow.jobs.prepare.if, /head.repo.full_name == github.repository/);
    });

    it("checks out only the producer and transfers one immutable tiny closure", () => {
        const {prepare, canary} = config().jobs;
        assert.equal(prepare["runs-on"], "windows-2025");
        assert.equal(canary["runs-on"], "windows-2025");
        assert.equal(prepare["timeout-minutes"], JOB_TIMEOUT_MINUTES);
        assert.equal(canary["timeout-minutes"], JOB_TIMEOUT_MINUTES);
        assert.deepEqual(action(prepare, "actions/checkout").with,
            {ref: EVENT_SOURCE, "persist-credentials": false});
        assert.equal(action(canary, "actions/checkout"), undefined);
        assert.equal(canary.needs, "prepare");
        const download = action(canary, "actions/download-artifact");
        assert.equal(download.with["artifact-ids"], "${{ needs.prepare.outputs.artifact_id }}");
        assert.equal(download.with["merge-multiple"], true);
        assert.equal(download.with.pattern, undefined);
        assert.equal(download.with.name, undefined);
        assert.deepEqual(action(prepare, "actions/upload-artifact").with.path.trim().split("\n"), [
            "${{ runner.temp }}/windows-environment-closure/windows-service-environment.ps1",
            "${{ runner.temp }}/windows-environment-closure/closure.json"
        ]);
    });

    it("binds event and source identity separately without interpolating shell input", () => {
        const workflow = config();
        assert.equal(workflow.env.EXPECTED_SOURCE_SHA, EVENT_SOURCE);
        assert.equal(workflow.env.EXPECTED_EVENT_SHA, "${{ github.sha }}");
        assert.equal(workflow.env.EXPECTED_RUN_ID, "${{ github.run_id }}");
        assert.equal(workflow.env.EXPECTED_RUN_ATTEMPT, "${{ github.run_attempt }}");
        for (const job of Object.values(workflow.jobs)) {
            for (const step of job.steps.filter(({run}) => run)) {
                assert.equal(step.shell, "pwsh");
                assert.doesNotMatch(step.run, /\$\{\{/);
            }
        }
        const invoke = workflow.jobs.canary.steps.find(({id}) => id === "probe");
        for (const argument of ["ExpectedRunId", "ExpectedRunAttempt", "ExpectedSourceSha", "ExpectedEventSha", "Nonce", "ManifestPath", "EvidencePath"])
            assert.ok(invoke.run.includes(`-${argument} `), argument);
    });

    it("validates the downloaded script before invoking the hosted-only mutator", () => {
        const run = config().jobs.canary.steps.find(({id}) => id === "probe").run;
        const hash = run.indexOf("Get-FileHash");
        const invocation = run.indexOf("-Mode InvokeHostedProbe");
        assert.ok(hash >= 0 && invocation > hash);
        for (const check of ["ReparsePoint", "MAX_SCRIPT_BYTES", "MAX_MANIFEST_BYTES", "closure.json",
            "ExpectedSourceSha", "ExpectedEventSha", "ExpectedRunId"])
            assert.ok(run.includes(check), check);
        assert.match(run, /Get-ChildItem -LiteralPath \$closureRoot -Force/);
        assert.match(run, /\.Count -ne 2/);
        assert.doesNotMatch(run, /Disable-Net|Set-Net|msiexec|MySpeed\.exe|check-artifact/);
    });

    it("retains only bounded evidence and requires a following ordinary Actions step", () => {
        const job = config().jobs.canary;
        const probe = job.steps.findIndex(({id}) => id === "probe");
        const continuation = job.steps.findIndex(({name}) => name === "Confirm runner continuation");
        assert.ok(continuation > probe);
        const upload = action(job, "actions/upload-artifact");
        assert.equal(upload.if, "always()");
        assert.equal(upload.with["if-no-files-found"], "error");
        assert.equal(upload.with.path,
            "${{ runner.temp }}/myspeed-service-environment-${{ needs.prepare.outputs.nonce }}/result.json");
        assert.match(readSource(WORKFLOW), /does not qualify|non-qualifying/);
        assert.doesNotMatch(JSON.stringify(job), /continue-on-error|secrets\./);
    });

    it("observes disposable-runner capacity without provisioning or claiming a release gate", () => {
        const step = config().jobs.prepare.steps.find(({name}) => name === "Observe hosted capacity without provisioning");
        assert.ok(step);
        for (const read of ["Get-Volume", "Get-PhysicalDisk", "Get-CimInstance", "Get-Command"])
            assert.ok(step.run.includes(read), read);
        assert.match(step.run, /provisioningAuthorized = \$false/);
        assert.doesNotMatch(step.run, /New-VM|New-VHD|Mount-|Invoke-WebRequest|Start-Process|Remove-|Set-|Install-|& \$/);
    });
});

describe("downloaded Windows closure validation (no native mutation)", {
    skip: !hasPowerShell && "PowerShell 7 unavailable; static workflow boundaries still run"
}, () => {
    const validate = (context, mutate = () => {}) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-closure-validation-"));
        context.after(() => fs.rmSync(root, {recursive: true, force: true}));
        const closure = path.join(root, "windows-environment-closure");
        fs.mkdirSync(closure);
        // This is deliberately not the real canary script. The extracted
        // workflow prefix only hashes files and never invokes any script.
        const script = Buffer.from("throw 'Synthetic closure must never execute'\n");
        const scriptPath = path.join(closure, "windows-service-environment.ps1");
        fs.writeFileSync(scriptPath, script);
        const manifest = {
            schemaVersion: 1, expectedRunId: RUN_ID, expectedRunAttempt: RUN_ATTEMPT, expectedSourceSha: SOURCE_SHA,
            expectedEventSha: EVENT_SHA, nonce: PROBE_NONCE,
            script: {name: path.basename(scriptPath), bytes: script.length,
                sha256: crypto.createHash("sha256").update(script).digest("hex")}
        };
        mutate({root, closure, manifest, scriptPath});
        fs.writeFileSync(path.join(closure, "closure.json"), JSON.stringify(manifest));
        const run = config().jobs.canary.steps.find(({id}) => id === "probe").run;
        const boundary = run.indexOf("$evidenceRoot =");
        assert.ok(boundary > 0);
        const validationOnly = run.slice(0, boundary);
        assert.doesNotMatch(validationOnly, /InvokeHostedProbe|New-Service|Set-Myspeed|& \$scriptPath/);
        return spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
            validationOnly + "\nWrite-Output 'validation-accepted'"], {
            timeout: SHELL_TIMEOUT_MS, encoding: "utf8",
            env: {...process.env, RUNNER_TEMP: root, EXPECTED_SOURCE_SHA: SOURCE_SHA,
                EXPECTED_EVENT_SHA: EVENT_SHA, EXPECTED_RUN_ID: RUN_ID,
                EXPECTED_RUN_ATTEMPT: RUN_ATTEMPT, EXPECTED_NONCE: PROBE_NONCE}
        });
    };

    it("accepts the exact synthetic closure with distinct event and source SHA", context => {
        const result = validate(context);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout.trim(), "validation-accepted");
    });

    const mutations = [
        ["extra file", ({closure}) => fs.writeFileSync(path.join(closure, "unexpected.txt"), "unexpected")],
        ["extra directory", ({closure}) => fs.mkdirSync(path.join(closure, "unexpected"))],
        ["tampered bytes", ({scriptPath}) => fs.appendFileSync(scriptPath, "# drift")],
        ["empty script", ({scriptPath}) => fs.writeFileSync(scriptPath, "")],
        ["wrong source", ({manifest}) => { manifest.expectedSourceSha = EVENT_SHA; }],
        ["wrong event", ({manifest}) => { manifest.expectedEventSha = SOURCE_SHA; }],
        ["wrong nonce", ({manifest}) => { manifest.nonce = crypto.randomUUID(); }],
        ["wrong run", ({manifest}) => { manifest.expectedRunId = "987654321"; }],
        ["stale attempt", ({manifest}) => { manifest.expectedRunAttempt = "1"; }],
        ["extra schema key", ({manifest}) => { manifest.unexpected = true; }],
        ["wrong script name", ({manifest}) => { manifest.script.name = "other.ps1"; }],
        ["malformed hash", ({manifest}) => { manifest.script.sha256 = "x".repeat(64); }],
        ["oversized manifest", ({manifest}) => { manifest.unexpected = "x".repeat(4096); }]
    ];
    for (const [name, mutate] of mutations) {
        it(`rejects ${name} before any service probe executes`, context => {
            const result = validate(context, mutate);
            assert.notEqual(result.status, 0, result.stdout);
            assert.doesNotMatch(result.stdout, /validation-accepted/);
            assert.match(result.stderr, /Closure/);
        });
    }
});
