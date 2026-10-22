import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {afterEach, beforeEach, describe, it} from "node:test";
import {parse} from "yaml";

import {STAGE3_BUDGET_CONSTANTS} from "../../scripts/qualification/linux-windows-cpu-floor-stage3.mjs";
import {CPU_FLOOR_GUEST_PREPARATION_CONSTANTS} from "../../scripts/release/cpu-floor-guest-preparation.mjs";
import {CPU_FLOOR_ARTIFACTS, inspectWindowsCpuFloorEvidence} from "../../scripts/release/windows-cpu-floor-evidence.mjs";
import {STAGE3_LAUNCHER_CONSTANTS} from "../../scripts/qualification/linux-windows-cpu-floor-stage3-launcher.mjs";
import {pinned} from "../helpers/actionPins.js";
import {readSource} from "../helpers/source.js";
import {buildCpuFloorInspection, CPU_FLOOR_FIXTURE} from "../helpers/windows-cpu-floor-evidence-fixture.mjs";

const WORKFLOW = ".github/workflows/windows-cpu-floor-candidate.yml";
const JOBS = ["guard", "bundle", "seal", "execute"];
const INPUTS = ["caller_job_name", "probe_artifact_digest", "probe_artifact_id", "source_sha",
    "stage3_installer_confirmation", "version", "windows_stamp"];
const READINESS_ARTIFACTS = ["windows-cpu-readiness-closure", "windows-cpu-readiness-evidence"];
const RETENTION_DAYS = 7;
const SECONDS_PER_MINUTE = 60;
const MILLISECONDS_PER_SECOND = 1_000;
const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const RUN_ID = "123456";
const PROBE_ID = "22";
const PROBE_DIGEST = "f".repeat(64);
const PROBE_BYTES = 1024;
const EXECUTE_JOB = "Execute Stage 3 sequence under KVM";

const text = () => readSource(WORKFLOW);
const workflow = () => parse(text());
const step = (job, predicate) => workflow().jobs[job].steps.find(predicate);
const uploads = () => Object.values(workflow().jobs).flatMap(job => (job.steps ?? [])
    .filter(item => item.uses?.startsWith("actions/upload-artifact@")));
const heredoc = (run, marker = "NODE") => {
    const lines = run.split("\n");
    const start = lines.findIndex(line => line.trimEnd().endsWith(`<<'${marker}'`));
    const end = lines.findIndex((line, index) => index > start && line.trim() === marker);
    assert.ok(start >= 0 && end > start, "heredoc must be present");
    return lines.slice(start + 1, end).join("\n");
};

describe("Windows CPU-floor candidate workflow", () => {
    it("is a read-only reusable workflow with exactly the candidate inputs", () => {
        const value = workflow();
        assert.deepEqual(Object.keys(value.on), ["workflow_call"]);
        assert.deepEqual(Object.keys(value.on.workflow_call.inputs).sort(), INPUTS);
        for (const name of INPUTS) {
            assert.equal(value.on.workflow_call.inputs[name].required, true, name);
            assert.equal(value.on.workflow_call.inputs[name].type, "string", name);
        }
        assert.equal(value.on.workflow_call.secrets, undefined);
        assert.deepEqual(value.permissions, {actions: "read", contents: "read"});
        assert.deepEqual(Object.keys(value.jobs), JOBS);
        for (const [name, job] of Object.entries(value.jobs))
            assert.match(job.if, /github\.repository == 'i7Gamer\/MySpeed'/u, name);
        for (const name of JOBS.slice(1)) assert.ok([value.jobs[name].needs].flat().includes("guard"), name);
        assert.deepEqual(value.jobs.execute.needs, ["guard", "bundle", "seal"]);
        assert.doesNotMatch(text(), /contents: write|packages: write|gh release|secrets\./u);
    });

    it("pins every external action through the repository's single pin source", () => {
        const actions = Object.values(workflow().jobs).flatMap(job => (job.steps ?? []).map(item => item.uses))
            .filter(Boolean);
        assert.ok(actions.length > 0);
        for (const use of actions) assert.equal(use, pinned(use.split("@")[0]), use);
    });

    const executeGuard = async (env) => {
        const script = step("guard", item => item.id === "guard").with.script;
        await vm.runInNewContext(`(async () => {${script}})()`, {process: {env}});
    };

    it("refuses anything but a manual dispatch of the exact candidate commit", async () => {
        const accepted = {EVENT_NAME: "workflow_dispatch", SOURCE_SHA: SHA, GITHUB_SHA: SHA,
            CALLER_JOB_NAME: "Windows CPU floor"};
        await assert.doesNotReject(executeGuard(accepted));
        for (const defect of [
            {EVENT_NAME: "pull_request"}, {EVENT_NAME: "push"}, {EVENT_NAME: "workflow_call"},
            {SOURCE_SHA: OTHER_SHA}, {SOURCE_SHA: SHA.toUpperCase(), GITHUB_SHA: SHA.toUpperCase()},
            {SOURCE_SHA: ""}, {CALLER_JOB_NAME: ""}, {CALLER_JOB_NAME: "Windows CPU floor / nested"},
            {CALLER_JOB_NAME: "${{ secrets.TOKEN }}"}
        ]) await assert.rejects(executeGuard({...accepted, ...defect}), /CPU-floor/u, JSON.stringify(defect));
        const guard = step("guard", item => item.id === "guard");
        assert.equal(guard.env.EVENT_NAME, "${{ github.event_name }}");
        assert.equal(guard.env.SOURCE_SHA, "${{ inputs.source_sha }}");
        assert.equal(guard.env.CALLER_JOB_NAME, "${{ inputs.caller_job_name }}");
    });

    /*
     * The execute job's API name is "<caller job name> / <callee job name>" when it runs under a
     * caller, and the budget anchor matches that name exactly. Taking the prefix from the caller
     * keeps one workflow usable from both the release qualification and the branch workflow.
     */
    it("anchors the job budget to the execute job's name under its caller", () => {
        const value = workflow();
        assert.equal(value.jobs.execute.name, EXECUTE_JOB);
        const budget = step("execute", item => item.id === "budget");
        assert.equal(budget.env.EXECUTE_JOB_NAME, `\${{ inputs.caller_job_name }} / ${EXECUTE_JOB}`);
    });

    it("takes the candidate artifact's identity from the API record of this run, on attempt 1 only", () => {
        const script = step("execute", item => item.id === "candidate-metadata").with.script;
        assert.match(script, /listWorkflowRunArtifacts/u);
        assert.match(script, /workflow_run\?\.id.*GITHUB_RUN_ID/su);
        assert.match(script, /workflow_run\?\.head_sha.*GITHUB_SHA/su);
        assert.match(script, /artifact\.expired !== false/u);
        assert.match(script, /expires_at/u);
        assert.match(script, /matching\.length !== 1/u);
        assert.match(script, /GITHUB_RUN_ATTEMPT !== '1'/u);
    });

    it("authenticates the guest bundle against this run before downloading it", () => {
        const script = step("execute", item => item.id === "bundle-metadata").with.script;
        assert.match(script, /workflow_run\?\.id.*GITHUB_RUN_ID/su);
        assert.match(script, /workflow_run\?\.head_sha.*GITHUB_SHA/su);
        const download = step("execute", item => String(item.name).includes("Download this run's authenticated guest bundle"));
        assert.match(String(download.with["artifact-ids"]), /steps\.bundle-metadata\.outputs\.id/u);
    });

    const executeProbeMetadata = async (artifactOverrides = {}, envOverrides = {}) => {
        const script = step("execute", item => item.id === "probe-metadata").with.script;
        const outputs = {};
        const artifact = {id: Number(PROBE_ID), name: "windows-cpu-readiness-evidence", expired: false,
            size_in_bytes: PROBE_BYTES, digest: `sha256:${PROBE_DIGEST}`,
            workflow_run: {id: Number(RUN_ID), head_sha: SHA}, ...artifactOverrides};
        await vm.runInNewContext(`(async () => {${script}})()`, {
            process: {env: {GITHUB_RUN_ID: RUN_ID, GITHUB_SHA: SHA, PROBE_ARTIFACT_ID: PROBE_ID,
                PROBE_ARTIFACT_DIGEST: PROBE_DIGEST, ...envOverrides}},
            context: {repo: {owner: "i7Gamer", repo: "MySpeed"}},
            core: {setOutput: (name, value) => { outputs[name] = value; }},
            github: {rest: {actions: {getArtifact: async ({artifact_id: id}) => {
                assert.equal(id, Number(envOverrides.PROBE_ARTIFACT_ID ?? PROBE_ID));
                return {data: artifact};
            }}}}
        });
        return outputs;
    };

    /*
     * The readiness probe ran earlier in this same run, so the run itself is still in progress and
     * has no conclusion yet. The readiness job throws unless its calibration passed, and the floor
     * job needs it, which is what the old cross-run conclusion check stood for.
     */
    it("admits only this run's readiness evidence, by its exact upload digest, without a run conclusion", async () => {
        assert.deepEqual(await executeProbeMetadata(), {id: PROBE_ID, bytes: String(PROBE_BYTES), sha256: PROBE_DIGEST});
        for (const [defect, artifact, env] of [
            ["another artifact", {name: "windows-cpu-readiness-closure"}],
            ["an expired artifact", {expired: true}],
            ["another run", {workflow_run: {id: Number(RUN_ID) + 1, head_sha: SHA}}],
            ["another commit", {workflow_run: {id: Number(RUN_ID), head_sha: OTHER_SHA}}],
            ["another digest", {digest: `sha256:${"0".repeat(64)}`}],
            ["an unprefixed digest", {digest: PROBE_DIGEST}],
            ["an empty archive", {size_in_bytes: 0}],
            ["an oversized archive", {size_in_bytes: 256 * 1024 * 1024 + 1}],
            ["another artifact ID", {id: Number(PROBE_ID) + 1}],
            ["a malformed artifact ID input", {}, {PROBE_ARTIFACT_ID: "0"}],
            ["a prefixed digest input", {}, {PROBE_ARTIFACT_DIGEST: `sha256:${PROBE_DIGEST}`}],
            ["an uppercase digest input", {}, {PROBE_ARTIFACT_DIGEST: PROBE_DIGEST.toUpperCase()}]
        ]) await assert.rejects(executeProbeMetadata(artifact, env), /probe/iu, defect);
        const script = step("execute", item => item.id === "probe-metadata").with.script;
        assert.doesNotMatch(script, /conclusion/u);
        const acquire = step("execute", item => String(item.name).includes("Acquire and extract"));
        assert.doesNotMatch(acquire.run, /conclusion|PROBE_RUN_ID|PROBE_SOURCE_SHA/u);
        assert.match(acquire.env.PROBE_ARCHIVE_SHA256, /steps\.probe-metadata\.outputs\.sha256/u);
        assert.match(acquire.env.PROBE_ARCHIVE_BYTES, /steps\.probe-metadata\.outputs\.bytes/u);
    });

    it("uploads every artifact under its fixed name with a seven-day retention", () => {
        const env = workflow().env;
        const names = uploads().map(item => item.with.name.replace(/^\$\{\{ env\.([A-Z_]+) \}\}$/u,
            (_match, name) => env[name]));
        assert.deepEqual([...names].sort(), CPU_FLOOR_ARTIFACTS.filter(name => !READINESS_ARTIFACTS.includes(name)));
        for (const item of uploads()) {
            assert.equal(item.with["retention-days"], RETENTION_DAYS, item.with.name);
            assert.equal(item.with["if-no-files-found"], "error", item.with.name);
        }
        const qualified = uploads().find(item => item.with.name === "qualified-windows-cpu-floor");
        assert.equal(qualified.if, undefined, "the qualified evidence is uploaded only on success");
    });

    it("pins the guest Node runtime to the digest the guest preparation enforces", () => {
        assert.equal(workflow().env.NODE_RUNTIME_SHA256, CPU_FLOOR_GUEST_PREPARATION_CONSTANTS.NODE_RUNTIME_SHA256);
    });

    it("generates the server registries before seeding the fixture", () => {
        const steps = workflow().jobs.bundle.steps.map(item => String(item.name));
        const generate = steps.findIndex(name => name.includes("Generate the server registries"));
        const seed = steps.findIndex(name => name.includes("Stage the guest runtime files"));
        assert.ok(generate >= 0 && generate < seed);
    });

    it("runs the CPU-floor suites, including this gate's, before sealing the closure", () => {
        const run = String(step("seal", item => String(item.name).includes("unit tests")).run);
        const lines = run.split("\n").map(value => value.trim());
        for (const suite of ["prereleaseCpuFloorTarget", "prereleaseCpuFloor", "prereleaseCpuFloorHostedInputs",
            "linuxWindowsCpuFloorStage3CandidateProvenance", "branchCpuFloorWorkflow", "buildBinariesWindowsOnly",
            "fixtureInventoryParity", "windowsBaselineGuestRuntimeBundleClosure", "windowsCpuFloorCandidateWorkflow",
            "windowsCpuFloorEvidence"])
            assert.ok(lines.some(line => /^tests\/server\/[A-Za-z0-9]+\.test\.js( \\)?$/u.test(line)
                && line.includes(`tests/server/${suite}.test.js`)), `${suite} must be its own line in the battery`);
        assert.doesNotMatch(run, /\\n/u);
    });

    /*
     * The anchor reads the Stage 3 constants, so the job's own timeout has to be pinned to the same
     * authority or the hard stop could land after GitHub cancels the job.
     */
    it("pins every budget number to the constants the anchor actually uses", () => {
        const value = workflow();
        assert.equal(value.jobs.execute["timeout-minutes"] * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND,
            STAGE3_BUDGET_CONSTANTS.JOB_CEILING_MILLISECONDS);
        assert.equal(Number(value.env.EXECUTE_JOB_CEILING_SECONDS) * MILLISECONDS_PER_SECOND,
            STAGE3_BUDGET_CONSTANTS.JOB_CEILING_MILLISECONDS);
        assert.equal(Number(value.env.EVIDENCE_RETENTION_RESERVE_SECONDS) * MILLISECONDS_PER_SECOND,
            STAGE3_BUDGET_CONSTANTS.RETENTION_RESERVE_MILLISECONDS);
        assert.equal(Number(value.env.MINIMUM_SEQUENCE_SECONDS) * MILLISECONDS_PER_SECOND,
            STAGE3_BUDGET_CONSTANTS.MINIMUM_SEQUENCE_MILLISECONDS);
        const sequence = step("execute", item => item.id === "run-sequence");
        assert.equal(Number(sequence.env.SEQUENCE_KILL_GRACE_SECONDS) * MILLISECONDS_PER_SECOND,
            STAGE3_BUDGET_CONSTANTS.SEQUENCE_KILL_GRACE_MILLISECONDS);
    });

    it("keeps the guest system disk out of the evidence upload", () => {
        const evidence = uploads().find(item => item.with.name === "windows-cpu-floor-evidence");
        const paths = String(evidence.with.path).split("\n").map(value => value.trim());
        assert.ok(paths.some(value => value.startsWith("!") && value.endsWith("/stage3.qcow2")));
        assert.ok(paths.some(value => !value.startsWith("!") && value.includes("myspeed-stage3-")));
    });

    it("stages the executable by its real name and binds the probe to this run", () => {
        const sequence = step("execute", item => item.id === "run-sequence");
        assert.match(sequence.run, /candidateRoot, "MySpeed\.exe"/u);
        assert.match(sequence.run, /candidateDeclaredSha256/u);
        assert.match(sequence.run, /runId: process\.env\.GITHUB_RUN_ID/u);
        assert.match(sequence.run, /runAttempt: process\.env\.GITHUB_RUN_ATTEMPT/u);
        assert.match(sequence.run, /sourceSha: process\.env\.GITHUB_SHA/u);
        assert.match(sequence.run, /result\.accepted !== true/u);
        assert.equal(sequence.env.CANDIDATE_VERSION ?? workflow().jobs.execute.env.CANDIDATE_VERSION,
            "${{ inputs.version }}");
        assert.equal(workflow().jobs.execute.env.STAGE3_INSTALLER_CONFIRMATION,
            "${{ inputs.stage3_installer_confirmation }}");
    });

    describe("retained qualified evidence", () => {
        let root;
        beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-cpu-floor-retain-")); });
        afterEach(() => fs.rmSync(root, {recursive: true, force: true}));

        /*
         * Runs the workflow's own writer against a synthetic accepted inspection and hands its output
         * to the release inspector, so the record the workflow writes and the one the manifest reads
         * cannot drift apart.
         */
        it("writes exactly the records the release inspector accepts", async () => {
            const retain = step("execute", item => item.id === "retain");
            assert.equal(retain.if, undefined, "retained only after an accepted sequence");
            const transport = path.join(root, "transport");
            const candidate = path.join(root, "candidate");
            const output = path.join(root, "qualified-windows-cpu-floor");
            fs.mkdirSync(transport);
            fs.mkdirSync(candidate);
            const executable = Buffer.from("synthetic CPU-floor executable");
            fs.writeFileSync(path.join(candidate, "MySpeed.exe"), executable);
            const executableSha256 = createHash("sha256").update(executable).digest("hex");
            const candidateArtifact = {id: 11, archiveDigest: `sha256:${"c".repeat(64)}`, archiveSize: 2048};
            const probeArtifact = {id: Number(PROBE_ID), archiveDigest: `sha256:${PROBE_DIGEST}`, archiveSize: PROBE_BYTES};
            const inspection = buildCpuFloorInspection({repository: "i7Gamer/MySpeed", sourceSha: SHA, runId: RUN_ID,
                runAttempt: 1, executableSha256, executableBytes: executable.length, candidateArtifact});
            fs.writeFileSync(path.join(transport, STAGE3_LAUNCHER_CONSTANTS.ACCEPTED_INSPECTION_FILE),
                `${JSON.stringify(inspection)}\n`);
            const env = {...process.env, GITHUB_REPOSITORY: "i7Gamer/MySpeed", GITHUB_SHA: SHA, GITHUB_RUN_ID: RUN_ID,
                GITHUB_RUN_ATTEMPT: "1", EXPECTED_NONCE: CPU_FLOOR_FIXTURE.NONCE,
                BASELINE_ARTIFACT_NAME: CPU_FLOOR_FIXTURE.CANDIDATE_ARTIFACT,
                CANDIDATE_ARTIFACT_ID: String(candidateArtifact.id), CANDIDATE_ARCHIVE_DIGEST: candidateArtifact.archiveDigest,
                CANDIDATE_ARCHIVE_BYTES: String(candidateArtifact.archiveSize), PROBE_ARTIFACT_ID: PROBE_ID,
                PROBE_ARCHIVE_SHA256: PROBE_DIGEST, PROBE_ARCHIVE_BYTES: String(PROBE_BYTES),
                STAGE3_INSTALLER_CONFIRMATION: CPU_FLOOR_FIXTURE.INSTALLER_CONFIRMATION,
                EXPECTED_MANIFEST_SHA256: CPU_FLOOR_FIXTURE.CLOSURE_SHA256};
            for (const name of Object.keys(retain.env ?? {})) assert.ok(name in env, `${name} is provided`);
            const result = spawnSync(process.execPath, ["--input-type=module", "-", transport, candidate, output],
                {input: heredoc(retain.run), env, encoding: "utf8"});
            assert.equal(result.status, 0, result.stderr);
            assert.match(retain.run, /myspeed-stage2-transport-\$EXPECTED_NONCE/u);
            assert.match(retain.run, /myspeed-branch-candidate-\$EXPECTED_NONCE/u);
            assert.match(retain.run, /qualified-windows-cpu-floor/u);
            const record = await inspectWindowsCpuFloorEvidence({directory: output, sourceSha: SHA, runId: RUN_ID,
                runAttempt: 1, repository: "i7Gamer/MySpeed",
                baselineAsset: {name: "MySpeed-windows-x64-baseline.exe", sha256: executableSha256, size: executable.length},
                x64Asset: {name: "MySpeed-windows-x64.exe", sha256: executableSha256, size: executable.length},
                actionsArtifacts: [{name: CPU_FLOOR_FIXTURE.CANDIDATE_ARTIFACT, ...candidateArtifact},
                    {name: CPU_FLOOR_FIXTURE.PROBE_ARTIFACT, ...probeArtifact}]});
            assert.equal(record.status, "passed");
            assert.equal(record.executableSha256, executableSha256);
        });
    });
});
