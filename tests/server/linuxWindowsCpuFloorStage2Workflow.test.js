import assert from "node:assert/strict";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {describe, it} from "node:test";
import {fileURLToPath} from "node:url";

import {parse} from "yaml";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW = path.join(HERE, "..", "..", ".github", "workflows", "linux-windows-cpu-floor-stage2.yml");
const PROCESS_TIMEOUT_MS = 10_000;
const SOURCE_SHA = "a".repeat(40);
const ARCHIVE_SHA = "b".repeat(64);
const NONCE = "0123456789abcdef0123456789abcdef";
const ROLES = ["avx", "avx2", "cpuid", "illegal", "known-bad", "known-good", "popcnt", "sse42"];
const CLOSURE_FILES = ["linux-windows-cpu-floor-admission.mjs", "linux-windows-cpu-floor-stage2-controller.mjs",
    "linux-windows-cpu-floor-stage2-hosted.mjs", "linux-windows-cpu-floor-stage2.mjs",
    "linux-kvm-capability.mjs", "linux-kvm-privileged-capability.mjs"]
    .map(name => `scripts/qualification/${name}`);
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

const requestBuilder = () => {
    const workflow = parse(fs.readFileSync(WORKFLOW, "utf8"));
    const step = workflow.jobs.execute.steps.find(value => value.name === "Build exact request and execute Stage 2");
    const match = step.run.match(/node - "\$closure_root" "\$input_root" "\$transport_root\/request\.json" <<'NODE'\n([\s\S]*?)\n\s*NODE/u);
    assert.ok(match, "request builder heredoc is missing");
    return match[1];
};

const runRequestBuilder = (context, mutate = () => {}) => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-stage2-request-"));
    context.after(() => fs.rmSync(fixtureRoot, {recursive: true, force: true}));
    const closureRoot = path.join(fixtureRoot, "closure");
    const inputRoot = path.join(fixtureRoot, "input");
    const output = path.join(fixtureRoot, "request.json");
    fs.mkdirSync(closureRoot);
    fs.mkdirSync(inputRoot);
    const closureFiles = CLOSURE_FILES.map(name => {
        const bytes = Buffer.from(`closure-${name}`);
        const target = path.join(closureRoot, name);
        fs.mkdirSync(path.dirname(target), {recursive: true});
        fs.writeFileSync(target, bytes);
        return {name, bytes: bytes.length, sha256: digest(bytes)};
    });
    fs.writeFileSync(path.join(closureRoot, "stage2-closure.json"), JSON.stringify({files: closureFiles}));
    const build = ROLES.map((mode, index) => {
        const name = `${mode.replaceAll("-", "_")}.exe`;
        const bytes = Buffer.from(`probe-${index}-${mode}`);
        fs.writeFileSync(path.join(inputRoot, name), bytes);
        return {mode, executable: {bytes: bytes.length, sha256: digest(bytes)}};
    });
    const evidence = {status: "completed", calibrationPassed: true, sourceSha: SOURCE_SHA,
        runId: "123", runAttempt: "2", observations: {build}};
    mutate(evidence);
    fs.writeFileSync(path.join(inputRoot, "result.json"), JSON.stringify(evidence));
    for (const name of ["ordinary.json", "combined.json", "artifact.zip"])
        fs.writeFileSync(path.join(inputRoot, name), `fixture-${name}`);
    const result = childProcess.spawnSync(process.execPath, ["-", closureRoot, inputRoot, output], {
        input: requestBuilder(), encoding: "utf8", timeout: PROCESS_TIMEOUT_MS, env: {...process.env,
            PROBE_SOURCE_SHA: SOURCE_SHA, PROBE_RUN_ID: "123", PROBE_RUN_ATTEMPT: "2",
            GITHUB_REPOSITORY: "i7Gamer/MySpeed", EXPECTED_SOURCE_SHA: SOURCE_SHA,
            EXPECTED_EVENT_SHA: SOURCE_SHA, EXPECTED_RUN_ID: "456", EXPECTED_RUN_ATTEMPT: "1",
            EXPECTED_NONCE: NONCE, GITHUB_ACTIONS: "true", CI: "true", RUNNER_OS: "Linux",
            RUNNER_ARCH: "X64", RUNNER_ENVIRONMENT: "github-hosted", ImageOS: "ubuntu24",
            ImageVersion: "synthetic", RUNNER_TEMP: fixtureRoot, PROBE_ARTIFACT_ID: "789",
            PROBE_ARCHIVE_BYTES: "20", PROBE_ARCHIVE_SHA256: ARCHIVE_SHA}
    });
    return {result, output};
};

describe("hosted Windows CPU-floor Stage 2 workflow", () => {
    it("is manual-only, bounded, read-only and requires explicit media authorization", () => {
        const workflow = parse(fs.readFileSync(WORKFLOW, "utf8"));
        assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
        assert.equal(workflow.permissions.contents, "read");
        assert.equal(workflow.permissions.actions, "read");
        assert.equal(workflow.on.workflow_dispatch.inputs.confirmation.required, true);
        assert.deepEqual(Object.keys(workflow.jobs), ["prepare", "execute"]);
        assert.equal(workflow.jobs.execute["timeout-minutes"], 300);
        assert.match(workflow.jobs.prepare.if, /i7Gamer\/MySpeed/u);
        assert.match(workflow.jobs.execute.if, /RUN-CANDIDATE-NEUTRAL-STAGE2/u);
    });

    it("seals the six runtime modules and executes without a source checkout", () => {
        const workflow = parse(fs.readFileSync(WORKFLOW, "utf8"));
        const prepare = workflow.jobs.prepare.steps.map(step => step.run ?? "").join("\n");
        const execute = workflow.jobs.execute.steps;
        for (const member of ["linux-kvm-capability.mjs", "linux-kvm-privileged-capability.mjs",
            "linux-windows-cpu-floor-admission.mjs", "linux-windows-cpu-floor-stage2.mjs",
            "linux-windows-cpu-floor-stage2-hosted.mjs", "linux-windows-cpu-floor-stage2-controller.mjs"])
            assert.match(prepare, new RegExp(member.replaceAll(".", "\\."), "u"));
        assert.equal(execute.some(step => String(step.uses ?? "").startsWith("actions/checkout@")), false);
        const run = execute.map(step => step.run ?? "").join("\n");
        assert.match(run, /linux-kvm-capability\.mjs" probe/u);
        assert.match(run, /linux-kvm-privileged-capability\.mjs" retry/u);
        assert.match(run, /linux-windows-cpu-floor-stage2-controller\.mjs" run/u);
        assert.match(prepare, /linux-kvm-capability-closure/u);
        assert.match(prepare, /myspeed-stage2-closure-/u);
        assert.match(run, /closure artifact inventory differs/u);
    });

    it("binds the cross-run probe artifact and never uploads media or guest disks", () => {
        const workflow = parse(fs.readFileSync(WORKFLOW, "utf8"));
        const inputs = workflow.on.workflow_dispatch.inputs;
        for (const name of ["probe_artifact_id", "probe_run_id", "probe_run_attempt", "probe_source_sha",
            "probe_archive_bytes", "probe_archive_sha256"]) assert.equal(inputs[name].required, true);
        const execute = workflow.jobs.execute.steps;
        const artifact = execute.find(step => step.name === "Acquire exact prior Windows probe artifact");
        assert.equal(workflow.jobs.execute.env.GH_TOKEN, undefined);
        assert.equal(artifact.env.GH_TOKEN, "${{ github.token }}");
        assert.match(artifact.run, /api\.github\.com\/repos/u);
        assert.match(artifact.run, /PROBE_ARCHIVE_SHA256/u);
        assert.match(artifact.run, /artifact\.size_in_bytes/u);
        assert.match(artifact.run, /AbortController/u);
        assert.match(artifact.run, /unzip -Z1/u);
        assert.match(artifact.run, /\/usr\/bin\/unzip/u);
        assert.match(artifact.run, /ulimit -f 32768/u);
        assert.match(artifact.run, /archive-selection\.tsv/u);
        assert.doesNotMatch(artifact.run, /unzip -q .* -d/u);
        const upload = execute.find(step => String(step.uses ?? "").startsWith("actions/upload-artifact@"));
        assert.match(upload.with.path, /stage2-result\.json/u);
        assert.match(upload.with.path, /transport-summary\.json/u);
        assert.doesNotMatch(upload.with.path, /windows\.iso|system\.qcow2|output\.img|OVMF/u);
        assert.equal(upload.if, "always() && steps.bound.outputs.retain == 'true'");
        const final = execute.find(step => step.name === "Require accepted nonqualifying calibration");
        assert.equal(final.if, "always()");
        assert.match(final.run, /steps\.bound\.outputs\.accepted/u);
    });

    it("builds the request from numeric producer byte identities while retaining string wire bytes", context => {
        const {result, output} = runRequestBuilder(context);
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        const request = JSON.parse(fs.readFileSync(output, "utf8"));
        assert.deepEqual(request.probeArtifact.files.map(file => file.role), ROLES);
        assert.equal(request.probeArtifact.files.every(file => typeof file.bytes === "string"), true);
        assert.deepEqual(request.probeArtifact.files.map(file => file.bytes),
            request.probeStage.files.map(file => String(file.bytes)));
    });

    for (const [name, mutate, pattern] of [
        ["mismatched bytes", evidence => { evidence.observations.build[0].executable.bytes += 1; }, /identity differs/u],
        ["mismatched hash", evidence => { evidence.observations.build[0].executable.sha256 = "0".repeat(64); },
            /identity differs/u],
        ["string bytes", evidence => { evidence.observations.build[0].executable.bytes = "11"; }, /identity is invalid/u],
        ["fractional bytes", evidence => { evidence.observations.build[0].executable.bytes = 1.5; }, /identity is invalid/u],
        ["unsafe bytes", evidence => { evidence.observations.build[0].executable.bytes = Number.MAX_SAFE_INTEGER + 1; },
            /identity is invalid/u],
        ["duplicate role", evidence => { evidence.observations.build[1].mode = ROLES[0]; }, /role is invalid/u],
        ["missing role", evidence => { evidence.observations.build.pop(); }, /role is invalid/u]
    ]) it(`rejects ${name} in producer build evidence`, context => {
        const {result, output} = runRequestBuilder(context, mutate);
        assert.notEqual(result.status, 0);
        assert.match(`${result.stdout}\n${result.stderr}`, pattern);
        assert.equal(fs.existsSync(output), false);
    });
});
