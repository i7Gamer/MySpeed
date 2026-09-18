import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {describe, it} from "node:test";
import {fileURLToPath} from "node:url";
import {parse} from "yaml";

import {STAGE3_BUDGET_CONSTANTS} from "../../scripts/qualification/linux-windows-cpu-floor-stage3.mjs";
import {POST_RELEASE_CPU_FLOOR_CONSTANTS} from "../../scripts/release/post-release-cpu-floor.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = path.join(HERE, "..", "..", ".github", "workflows",
    "windows-cpu-floor-post-release-v1.6.1.yml");

describe("Windows CPU floor post-release v1.6.1 workflow", () => {
    it("is manual, read-only, non-publishing, and pinned", () => {
        const text = fs.readFileSync(WORKFLOW_PATH, "utf8");
        const workflow = parse(text);

        assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
        assert.deepEqual(workflow.permissions, {actions: "read", contents: "read"});
        assert.deepEqual(Object.keys(workflow.jobs), ["prepare", "seal", "execute"]);

        for (const job of Object.values(workflow.jobs)) {
            assert.match(job.if, /github\.repository == 'i7Gamer\/MySpeed'/u);
        }

        for (const match of text.matchAll(/uses: ([^\s@]+)@([^\s]+)/gu)) {
            assert.ok(match[1].startsWith("./") || /^[0-9a-f]{40}$/u.test(match[2]),
                `${match[1]} is not pinned to a 40-char commit SHA: ${match[2]}`);
        }

        assert.doesNotMatch(text, /contents: write|packages: write|gh release/u);
    });

    it("uses the reusable Windows producer and authenticates its same-run artifact before download", () => {
        const workflow = parse(fs.readFileSync(WORKFLOW_PATH, "utf8"));
        assert.equal(workflow.jobs.prepare.uses, "./.github/workflows/post-release-msi-prepare.yml");
        assert.deepEqual(workflow.jobs.execute.needs, ["prepare", "seal"]);
        const metadata = workflow.jobs.execute.steps.find(step => step.id === "preparation-metadata");
        assert.match(metadata.with.script, /workflow_run\?\.id.*GITHUB_RUN_ID/su);
        assert.match(metadata.with.script, /workflow_run\?\.head_sha.*GITHUB_SHA/su);
        assert.match(metadata.with.script, /artifact\.expired !== false/u);
        const download = workflow.jobs.execute.steps.find(step =>
            String(step.name).includes("Download authenticated same-run Windows preparation"));
        assert.match(String(download.with["artifact-ids"]), /needs\.prepare\.outputs\.artifact_id/u);
        assert.equal(download.with["merge-multiple"], true);
    });

    it("requires the complete prior probe artifact identity at dispatch", () => {
        const workflow = parse(fs.readFileSync(WORKFLOW_PATH, "utf8"));
        for (const name of ["probe_artifact_id", "probe_run_id", "probe_run_attempt", "probe_source_sha",
            "probe_archive_bytes", "probe_archive_sha256"])
            assert.equal(workflow.on.workflow_dispatch.inputs[name].required, true);
    });

    it("repeats ordinary and reviewed privileged KVM observations from the verified closure", () => {
        const workflow = parse(fs.readFileSync(WORKFLOW_PATH, "utf8"));
        const step = workflow.jobs.execute.steps.find(value => value.name ===
            "Stage and observe the verified KVM capability pair");
        assert.match(step.run, /linux-kvm-capability\.mjs" emit-manifest/u);
        assert.match(step.run, /linux-kvm-capability\.mjs" probe/u);
        assert.match(step.run, /linux-kvm-privileged-capability\.mjs" retry/u);
        assert.match(step.run, /privileged-result\.json/u);
    });

    it("surfaces the Stage 3 failure reason to the CI log and step summary without an artifact download", () => {
        const workflow = parse(fs.readFileSync(WORKFLOW_PATH, "utf8"));
        const step = workflow.jobs.execute.steps.find(value => value.name ===
            "Run authenticated launcher from sealed closure");
        // On a non-zero sequence exit the step must read the retained result, echo the reason and a
        // controller.stderr tail to the CI log, write them to the step summary, and still exit with the
        // real code so the diagnostics never depend on downloading the multi-gigabyte evidence bundle.
        assert.match(step.run, /if \[ "\$sequence_exit" -ne 0 \]; then/u);
        assert.match(step.run, /stage3-sequence-result\.json/u);
        assert.match(step.run, /::error::Stage 3 sequence failed/u);
        assert.match(step.run, /tail -n 40 "\$log_root\/controller\.stderr"/u);
        assert.match(step.run, />> "\$GITHUB_STEP_SUMMARY"/u);
        assert.match(step.run, /exit "\$sequence_exit"/u);
        // The reason must retain status and stage even when failure is empty (not collapse to status alone).
        assert.match(step.run, /r\.status \?\? "unknown"/u);
        assert.match(step.run, /\(stage \$\{r\.stage\}\)/u);
        assert.match(step.run, /: \$\{r\.failure\}/u);
        // The retained launch diagnostic's classification and raw termination reason ride along, so a
        // deadline kill is distinguishable from a firmware shell fallback straight from the CI log.
        assert.match(step.run, /const q=r\.qemuLaunch;/u);
        assert.match(step.run, /\[launch \$\{q\.classification \?\? "unclassified"\}/u);
        assert.match(step.run, /q\.terminationReason==="string"/u);
        // The workflow-command message must escape %, CR and LF so Actions parsing cannot be broken or truncated.
        assert.match(step.run, /escaped_reason=\$\{failure_reason\/\/'%'\/'%25'\}/u);
        assert.match(step.run, /\$'\\r'\/'%0D'/u);
        assert.match(step.run, /\$'\\n'\/'%0A'/u);
        assert.match(step.run, /::error::Stage 3 sequence failed \(exit \$sequence_exit\): \$escaped_reason/u);
    });

    it("authenticates and safely extracts the exact prior probe artifact", () => {
        const workflow = parse(fs.readFileSync(WORKFLOW_PATH, "utf8"));
        const step = workflow.jobs.execute.steps.find(value => value.name ===
            "Acquire and extract the exact prior Windows probe artifact");
        assert.match(step.run, /artifact\.expired !== false/u);
        assert.match(step.run, /run\.conclusion !== "success"/u);
        assert.match(step.run, /digest\.digest\("hex"\) !== process\.env\.PROBE_ARCHIVE_SHA256/u);
        assert.match(step.run, /unzip -Z1/u);
        assert.match(step.run, /member is duplicated/u);
        assert.match(step.run, /ulimit -f 32768/u);
    });

    it("freshly authenticates baseline artifact retention without redownloading its archive", () => {
        const workflow = parse(fs.readFileSync(WORKFLOW_PATH, "utf8"));
        const step = workflow.jobs.execute.steps.find(value => value.id === "baseline-metadata");
        assert.match(step.with.script, /artifact\.digest !== process\.env\.BASELINE_ARCHIVE_DIGEST/u);
        assert.match(step.with.script, /Date\.parse\(observedAt\) >= Date\.parse\(artifact\.expires_at\)/u);
        assert.match(step.with.script, /run\.conclusion !== 'success'/u);
        assert.doesNotMatch(step.with.script, /downloadArtifact|archive_download_url/u);
    });

    it("checks out only in the seal job and executes without checkout", () => {
        const text = fs.readFileSync(WORKFLOW_PATH, "utf8");
        const workflow = parse(text);

        const checkouts = step => String(step.uses ?? "").includes("actions/checkout");
        assert.equal(workflow.jobs.seal.steps.filter(checkouts).length, 1);
        assert.equal(workflow.jobs.execute.steps.some(checkouts), false);
    });

    it("binds historical candidate v1.6.1 SHA and baseline artifact constants", () => {
        const text = fs.readFileSync(WORKFLOW_PATH, "utf8");
        const workflow = parse(text);

        assert.equal(workflow.env.CANDIDATE_TAG_NAME, "v1.6.1");
        assert.equal(workflow.env.CANDIDATE_SOURCE_SHA, "4fa4dd40a89a062735f98bd85d685e0624ff46a8");
        assert.equal(workflow.env.BASELINE_ARTIFACT_ID, 10341896645);
        assert.equal(workflow.env.BASELINE_EXE_ASSET_ID, 563103679);
        assert.equal(workflow.env.QUALIFICATION_RUN_ID, 34829932391);
        assert.equal(workflow.env.QUALIFICATION_RUN_ATTEMPT, 1);
    });

    it("requires explicit dispatch confirmation", () => {
        const text = fs.readFileSync(WORKFLOW_PATH, "utf8");
        const workflow = parse(text);

        assert.ok(workflow.on.workflow_dispatch.inputs.confirmation);
        assert.equal(workflow.on.workflow_dispatch.inputs.confirmation.required, true);
        assert.match(workflow.on.workflow_dispatch.inputs.confirmation.description,
            /RUN-WINDOWS-BASELINE-CPU-FLOOR/);
    });

    it("binds confirmation via env var, not direct Bash interpolation (Finding 6)", () => {
        const text = fs.readFileSync(WORKFLOW_PATH, "utf8");
        // Must NOT contain the raw interpolation inside a Bash string comparison
        assert.doesNotMatch(text, /\[\[ "\$\{\{ github\.event\.inputs\.confirmation \}\}"/u);
        // Confirmation step must declare INPUT_CONFIRMATION as an env var
        assert.match(text, /INPUT_CONFIRMATION:\s*\$\{\{ github\.event\.inputs\.confirmation \}\}/u);
        // Bash comparison must use the env var
        assert.match(text, /\[\[ "\$\{INPUT_CONFIRMATION\}" != "\$\{WORKFLOW_CONFIRMATION\}"/u);
    });

    it("seals the full imported graph and verifies the bootstrap before importing it", () => {
        const text = fs.readFileSync(WORKFLOW_PATH, "utf8");
        const workflow = parse(text);
        const seal = workflow.jobs.seal.steps.find(step => step.id === "seal").run;
        const verify = workflow.jobs.execute.steps.find(step => step.id === "verify-closure").run;
        assert.match(seal, /sealStage3ExecutionClosure/u);
        assert.match(workflow.jobs.seal.outputs.bootstrap_sha256, /steps\.seal\.outputs\.bootstrap_sha256/u);
        assert.ok(verify.indexOf('!== digest') < verify.indexOf('await import('));
        assert.match(verify, /verifyStage3ExecutionClosure\(/u);
        const tests = workflow.jobs.seal.steps.find(step => String(step.name).includes("unit tests")).run;
        for (const name of ["linuxWindowsCpuFloorStage2Closure.test.js",
            "linuxWindowsCpuFloorStage3Cleanup.test.js",
            "linuxWindowsCpuFloorStage3Closure.test.js", "postReleaseCpuFloorGuestPreparation.test.js",
            "postReleaseCpuFloorHostedInputs.test.js", "postReleaseCpuFloorWorkflow.test.js"])
            assert.match(tests, new RegExp(name.replaceAll(".", "\\."), "u"));
    });

    it("execute job runs the authenticated hosted-input launcher under an external bound", () => {
        const text = fs.readFileSync(WORKFLOW_PATH, "utf8");
        const workflow = parse(text);
        const executeSteps = workflow.jobs.execute.steps;
        const runSeqStep = executeSteps.find(s => s.id === "run-sequence");
        assert.ok(runSeqStep, "run-sequence step must exist in execute job");
        assert.match(runSeqStep.run, /runV161PostReleaseCpuFloorHostedInputs/u);
        assert.match(runSeqStep.run, /observeV161PostReleaseMsiPreparation/u);
        assert.doesNotMatch(runSeqStep.run, /^[^#]*test -f/mu);
        assert.match(runSeqStep.run, /exit "\$sequence_exit"/u,
            "failed launcher execution must fail the job");
        assert.match(runSeqStep.run, /timeout --signal=TERM --kill-after=/u,
            "a dead controller must be bounded outside Node");
        assert.doesNotMatch(runSeqStep.run, /install -m 600 \/dev\/null "\$transport_root/u,
            "sequence requires an empty fresh transport root, not precreated log files");
    });

    it("offers exactly the three supported Stage 3 installer policies and defaults to no input", () => {
        const workflow = parse(fs.readFileSync(WORKFLOW_PATH, "utf8"));
        const input = workflow.on.workflow_dispatch.inputs.stage3_installer_confirmation;
        assert.equal(input.required, true);
        assert.equal(input.type, "choice");
        assert.equal(input.default, POST_RELEASE_CPU_FLOOR_CONSTANTS.STAGE3_NO_INPUT);
        assert.deepEqual(input.options, [...POST_RELEASE_CPU_FLOOR_CONSTANTS.STAGE3_INSTALLER_CONFIRMATIONS]);
        assert.ok(input.options.includes("single-enter-after-first-frame-v2"));
        const runSeqStep = workflow.jobs.execute.steps.find(step => step.id === "run-sequence");
        assert.match(runSeqStep.run,
            /installerConfirmation: process\.env\.STAGE3_INSTALLER_CONFIRMATION/u);
    });

    it("derives the sequence bound from what is left of the same 90-minute ceiling", () => {
        const workflow = parse(fs.readFileSync(WORKFLOW_PATH, "utf8"));
        assert.equal(workflow.jobs.execute["timeout-minutes"] * 60,
            Number(workflow.env.EXECUTE_JOB_CEILING_SECONDS));
        assert.equal(Number(workflow.env.EXECUTE_JOB_CEILING_SECONDS) * 1_000,
            STAGE3_BUDGET_CONSTANTS.JOB_CEILING_MILLISECONDS);
        assert.equal(Number(workflow.env.EVIDENCE_RETENTION_RESERVE_SECONDS) * 1_000,
            STAGE3_BUDGET_CONSTANTS.RETENTION_RESERVE_MILLISECONDS);
        assert.equal(Number(workflow.env.MINIMUM_SEQUENCE_SECONDS) * 1_000,
            STAGE3_BUDGET_CONSTANTS.MINIMUM_SEQUENCE_MILLISECONDS);
        const runSeqStep = workflow.jobs.execute.steps.find(step => step.id === "run-sequence");
        assert.equal(Object.hasOwn(runSeqStep.env, "SEQUENCE_TIMEOUT_SECONDS"), false,
            "a fixed bound would outlive the ceiling once the steps above it ran long");
        assert.match(runSeqStep.run, /remaining_seconds=\$\(\( \(SEQUENCE_DEADLINE_MILLISECONDS - now_ms\) \/ 1000 \)\)/u);
        assert.match(runSeqStep.run, /--kill-after="\$\{SEQUENCE_KILL_GRACE_SECONDS\}s" "\$\{remaining_seconds\}s"/u);
        assert.match(runSeqStep.run, /remaining_seconds" -lt "\$MINIMUM_SEQUENCE_SECONDS/u);
    });

    it("anchors that ceiling to authenticated job metadata, never to the clock of the step reading it", () => {
        const workflow = parse(fs.readFileSync(WORKFLOW_PATH, "utf8"));
        const steps = workflow.jobs.execute.steps;
        const budgetStep = steps.find(step => step.id === "budget");
        const script = budgetStep.with.script;

        assert.match(budgetStep.uses, /^actions\/github-script@[0-9a-f]{40}$/u);
        assert.equal(budgetStep.env.EXECUTE_JOB_NAME, workflow.jobs.execute.name,
            "the anchor matches this job by its display name, so a rename must not orphan it");
        assert.match(script, /listJobsForWorkflowRunAttempt/u);
        assert.match(script, /anchorStage3JobBudget/u);
        assert.match(script, /runnerName: process\.env\.RUNNER_NAME/u);
        assert.match(script, /AbortSignal\.timeout/u);
        // The helper is the sealed one, and there is no second path that could answer instead of it.
        assert.match(script, /myspeed-stage3-closure-\$\{nonce\}/u);
        assert.doesNotMatch(script, /catch|GITHUB_JOB\b|run_started_at/u,
            "an unavailable or ambiguous anchor must fail the run, not fall back");
        assert.doesNotMatch(budgetStep.with.script, /date -u/u);

        const indexOf = id => steps.indexOf(steps.find(step => step.id === id));
        assert.ok(indexOf("verify-closure") < indexOf("budget"),
            "the anchor helper is imported from the verified closure");
        assert.ok(indexOf("budget") < indexOf("run-sequence"));
    });

    it("charges the outer timeout's kill grace so the hard stop stays inside the retention reserve", () => {
        const workflow = parse(fs.readFileSync(WORKFLOW_PATH, "utf8"));
        const runSeqStep = workflow.jobs.execute.steps.find(step => step.id === "run-sequence");

        assert.equal(Number(runSeqStep.env.SEQUENCE_KILL_GRACE_SECONDS) * 1_000,
            STAGE3_BUDGET_CONSTANTS.SEQUENCE_KILL_GRACE_MILLISECONDS);
        assert.equal(runSeqStep.env.SEQUENCE_DEADLINE_MILLISECONDS, "${{ steps.budget.outputs.deadline_ms }}");
        assert.equal(runSeqStep.env.SEQUENCE_HARD_STOP_MILLISECONDS, "${{ steps.budget.outputs.hard_stop_ms }}");
        // TERM at the declared deadline, KILL one grace later, and that hard stop is what the anchor
        // held the retention reserve back from - so the two numbers have to differ by exactly the grace.
        assert.match(runSeqStep.run,
            /grace_ms=\$\(\( SEQUENCE_HARD_STOP_MILLISECONDS - SEQUENCE_DEADLINE_MILLISECONDS \)\)/u);
        assert.match(runSeqStep.run, /"\$grace_ms" -ne "\$\(\( SEQUENCE_KILL_GRACE_SECONDS \* 1000 \)\)"/u);
    });

    it("declares the same wall deadline to the production request builder", () => {
        const workflow = parse(fs.readFileSync(WORKFLOW_PATH, "utf8"));
        const runSeqStep = workflow.jobs.execute.steps.find(step => step.id === "run-sequence");
        assert.equal(runSeqStep.env.SEQUENCE_DEADLINE_MILLISECONDS, "${{ steps.budget.outputs.deadline_ms }}");
        assert.match(runSeqStep.run,
            /wallDeadlineUnixMilliseconds: Number\(process\.env\.SEQUENCE_DEADLINE_MILLISECONDS\)/u);
    });

    it("binds the runtime-derived hosted source SHA to the dispatched harness SHA", () => {
        const workflow = parse(fs.readFileSync(WORKFLOW_PATH, "utf8"));

        assert.equal(workflow.jobs.execute.env.MYSPEED_SOURCE_SHA, "${{ github.sha }}",
            "the sealed controllers derive sourceSha from MYSPEED_SOURCE_SHA, not GITHUB_SHA directly");
    });

    it("uses the MSI controller's exact nonce-bound task root for its preparation artifact", () => {
        const workflow = parse(fs.readFileSync(WORKFLOW_PATH, "utf8"));
        const download = workflow.jobs.execute.steps.find(step =>
            String(step.name).includes("Download authenticated same-run Windows preparation"));
        const launcher = workflow.jobs.execute.steps.find(step => step.id === "run-sequence");

        assert.match(String(download.with.path), /myspeed-windows-msi-\$\{\{ needs\.seal\.outputs\.nonce \}\}/u);
        assert.match(launcher.run, /myspeed-windows-msi-\$\{nonce\}/u);
    });

    it("cleanup never signals a PID merely because it was read from a pidfile", () => {
        const text = fs.readFileSync(WORKFLOW_PATH, "utf8");
        const workflow = parse(text);
        const executeSteps = workflow.jobs.execute.steps;
        const cleanupStep = executeSteps.find(s => s.name === "Verify task-owned process cleanup");
        assert.ok(cleanupStep);
        assert.match(cleanupStep.if, /steps\.run-sequence\.outcome != 'skipped'/u);
        assert.doesNotMatch(cleanupStep.run, /kill -9 "\$pid"/u);
        assert.match(cleanupStep.run, /cleanupTaskOwnedCpuProcesses/u);
        assert.match(cleanupStep.run, /createHostedCpuFloorCleanupOperations/u);
        assert.match(cleanupStep.run, /cleanupProven/u);
        assert.doesNotMatch(cleanupStep.run, /pkill.*qemu-system-x86_64/u);
        // Pre-existing and deliberately retained: without a retained receipt the step refuses rather
        // than signalling a PID it cannot prove it owns. See the follow-up result's native caveat.
        assert.match(cleanupStep.run, /refusing PID-only signalling/u);
    });

    it("evidence is uploaded from stage2 transport root not stage3 transport root (Finding 3)", () => {
        const text = fs.readFileSync(WORKFLOW_PATH, "utf8");
        const workflow = parse(text);
        const executeSteps = workflow.jobs.execute.steps;
        const uploadStep = executeSteps.find(s =>
            String(s.uses ?? "").includes("upload-artifact") &&
            String(s.with?.name ?? "").includes("evidence"));
        assert.ok(uploadStep, "evidence upload step must exist");
        assert.match(String(uploadStep.with.path), /myspeed-stage2-transport-/u);
        assert.doesNotMatch(String(uploadStep.with.path), /myspeed-stage3-transport-/u);
        assert.match(String(uploadStep.with.path), /myspeed-stage3-logs-/u);
        assert.equal(uploadStep.with["if-no-files-found"], "error");
    });

    it("uploads diagnostics separately before bulky candidate evidence", () => {
        const workflow = parse(fs.readFileSync(WORKFLOW_PATH, "utf8"));
        const steps = workflow.jobs.execute.steps;
        const diagnostic = steps.find(step => step.with?.name === "windows-cpu-floor-post-release-v1.6.1-diagnostics");
        const evidence = steps.find(step => step.with?.name === "windows-cpu-floor-post-release-v1.6.1-evidence");
        assert.ok(diagnostic);
        assert.equal(diagnostic.if, "always()");
        assert.equal(diagnostic.with["if-no-files-found"], "error");
        const prefix = "${{ runner.temp }}";
        const nonce = "${{ needs.seal.outputs.nonce }}";
        assert.deepEqual(diagnostic.with.path.trim().split("\n").map(line => line.trim()), [
            `${prefix}/myspeed-stage2-transport-${nonce}/*.json`,
            `${prefix}/myspeed-stage3-sequence-envelope-${nonce}/request.json`,
            `${prefix}/myspeed-stage3-logs-${nonce}/controller.stderr`,
            `${prefix}/myspeed-stage3-logs-${nonce}/controller.stdout`
        ]);
        assert.ok(steps.indexOf(diagnostic) < steps.indexOf(evidence));
    });

    it("uses verified repository-standard commit SHAs for all external actions", () => {
        const text = fs.readFileSync(WORKFLOW_PATH, "utf8");
        const workflow = parse(text);
        const STANDARD_PINS = Object.freeze({
            "actions/checkout": "3d3c42e5aac5ba805825da76410c181273ba90b1",
            "actions/setup-node": "820762786026740c76f36085b0efc47a31fe5020",
            "oven-sh/setup-bun": "0c5077e51419868618aeaa5fe8019c62421857d6",
            "actions/upload-artifact": "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
            "actions/download-artifact": "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
            "actions/github-script": "3a2844b7e9c422d3c10d287c895573f7108da1b3"
        });

        const actionUses = [];
        for (const job of Object.values(workflow.jobs)) {
            for (const step of job.steps ?? []) {
                if (step.uses && !step.uses.startsWith("./")) {
                    actionUses.push(step.uses);
                }
            }
        }

        assert.ok(actionUses.length > 0, "workflow must contain external action steps");
        for (const use of actionUses) {
            const [action, sha] = use.split("@");
            assert.ok(action in STANDARD_PINS, `Unknown action ${action} in workflow`);
            assert.equal(sha, STANDARD_PINS[action],
                `Action ${action} does not use standard verified pin ${STANDARD_PINS[action]}, found ${sha}`);
        }
    });
});
