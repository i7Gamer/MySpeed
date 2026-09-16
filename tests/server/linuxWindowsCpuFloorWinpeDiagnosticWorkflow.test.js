import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {describe, it} from "node:test";
import {fileURLToPath} from "node:url";

import {parse} from "yaml";

import {WINPE_DIAGNOSTIC_JOB_CEILING_MILLISECONDS, WINPE_DIAGNOSTIC_RESERVATION_LABEL} from
    "../../scripts/qualification/linux-windows-cpu-floor-stage2-hosted.mjs";
import {WINPE_DIAGNOSTIC_CLASSIFICATION} from
    "../../scripts/qualification/linux-windows-cpu-floor-stage2.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOWS = path.join(HERE, "..", "..", ".github", "workflows");
const DIAGNOSTIC = path.join(WORKFLOWS, "winpe-answer-file-diagnostic.yml");
const STAGE2 = path.join(WORKFLOWS, "linux-windows-cpu-floor-stage2.yml");
const text = fs.readFileSync(DIAGNOSTIC, "utf8");
const workflow = parse(text);
const step = name => workflow.jobs.execute.steps.find(value => value.name === name);

describe("WinPE answer-file diagnostic workflow", () => {
    it("is dispatch-only, under its own confirmation, and never on a schedule or a push", () => {
        assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
        assert.equal(text.includes("schedule:"), false);
        assert.equal(text.includes("RUN-WINPE-ANSWER-FILE-DIAGNOSTIC"), true);
        assert.match(workflow.jobs.execute.if, /RUN-WINPE-ANSWER-FILE-DIAGNOSTIC/u);
        assert.match(workflow.jobs.execute.if, /i7Gamer\/MySpeed/u);
        assert.deepEqual(workflow.permissions, {actions: "read", contents: "read"});
    });

    it("declares its own ceiling rather than inheriting the Stage 2 template's", () => {
        assert.equal(workflow.jobs.execute["timeout-minutes"],
            WINPE_DIAGNOSTIC_JOB_CEILING_MILLISECONDS / 60_000);
        assert.equal(workflow.jobs.prepare["timeout-minutes"], 10);
        const stage2Ceilings = [...fs.readFileSync(STAGE2, "utf8")
            .matchAll(/^\s*timeout-minutes: (\d+)$/gmu)].map(match => Number(match[1]));
        assert.deepEqual(stage2Ceilings, [10, 300]);
        assert.equal(workflow.jobs.execute["timeout-minutes"], 25);
    });

    it("anchors the budget to authenticated job metadata, with no local-clock fallback", () => {
        const anchor = step("Anchor the diagnostic budget to authenticated job metadata");
        assert.ok(anchor, "the anchor step is required");
        assert.match(anchor.with.script, /listJobsForWorkflowRunAttempt/u);
        assert.match(anchor.with.script, /anchorWinpeDiagnosticJobBudget/u);
        assert.equal(anchor.env.EXECUTE_JOB_NAME, workflow.jobs.execute.name,
            "the anchor has to name the job it is actually running in");
        /* The anchor runs before anything spends the budget it produces. */
        const names = workflow.jobs.execute.steps.map(value => value.name);
        assert.ok(names.indexOf(anchor.name) < names.indexOf("Build the diagnostic request and execute it"));
        const build = step("Build the diagnostic request and execute it");
        assert.equal(build.env.WINPE_WALL_DEADLINE_MILLISECONDS,
            "${{ steps.budget.outputs.deadline_ms }}");
        assert.match(build.run, /winpeDiagnosticBudget: \{label: "winpe-answer-file-diagnostic"/u);
        assert.equal(WINPE_DIAGNOSTIC_RESERVATION_LABEL, "winpe-answer-file-diagnostic");
    });

    it("authorizes the diagnostic explicitly and binds it to this run's nonce", () => {
        const build = step("Build the diagnostic request and execute it");
        assert.match(build.run, /winpeDiagnostic: \{confirmation: "winpe-answer-file-diagnostic-v1",\s*nonce: context\.nonce\}/u);
        /* The boot-input policies are a separate authorization and this workflow requests none. */
        assert.equal(build.run.includes("bootConfirmation"), false);
    });

    it("distinguishes capture-complete, inconclusive and unsafe, and fails on unsafe", () => {
        const bound = step("Bound and classify the retained diagnostic evidence");
        for (const outcome of ["capture-complete", "inconclusive", "unsafe", "no-diagnostic-record",
            "refused-before-launch"])
            assert.ok(bound.run.includes(`"${outcome}"`), `outcome ${outcome} is missing`);
        assert.ok(bound.run.includes(WINPE_DIAGNOSTIC_CLASSIFICATION));
        /* The three flags are necessary but never sufficient on their own. */
        assert.match(bound.run, /flagsCorrect && result\.status === "diagnostic"/u);
        const gate = step("Require a safe, bounded diagnostic record");
        assert.match(gate.run, /capture-complete\|inconclusive\|refused-before-launch\) exit 0/u);
        assert.match(gate.run, /\*\) exit 1/u);
        assert.equal(gate.run.includes("unsafe) exit 0"), false);
    });

    it("uploads only the bounded redacted record, never the controller streams", () => {
        const upload = step("Upload the bounded, redacted diagnostic evidence");
        const uploaded = upload.with.path.split("\n").filter(line => line.trim().length > 0);
        assert.deepEqual(uploaded.map(line => path.posix.basename(line.trim())),
            ["diagnostic-result.json", "transport-summary.json"]);
        assert.equal(upload.with.path.includes("controller.stdout"), false);
        assert.equal(upload.with.path.includes("controller.stderr"), false);
        assert.equal(upload.with.path.includes("serial.log"), false);
        assert.equal(upload.with.path.includes("output.img"), false);
        /* The streams are still measured, so their absence is a decision and not an oversight. */
        const bound = step("Bound and classify the retained diagnostic evidence");
        assert.match(bound.run, /controller\.stdout/u);
        assert.match(bound.run, /never uploaded/u);
    });

    it("seals the same eight-module closure and runs the diagnostic suites before sealing it", () => {
        const tests = workflow.jobs.prepare.steps
            .find(value => value.name === "Run pure and injected closure tests").run;
        for (const suite of ["linuxWindowsCpuFloorWinpeDiagnosticQmp", "linuxWindowsCpuFloorWinpeDiagnosticScript",
            "linuxWindowsCpuFloorWinpeDiagnosticPublication", "linuxWindowsCpuFloorWinpeDiagnosticCollection",
            "linuxWindowsCpuFloorWinpeDiagnosticContract", "linuxWindowsCpuFloorWinpeDiagnosticWorkflow"])
            assert.ok(tests.includes(`tests/server/${suite}.test.js`), `${suite} is not run before sealing`);
        const seal = workflow.jobs.prepare.steps.find(value => value.name === "Seal exact eight-module closure");
        const sealed = [...seal.run.matchAll(/install -m 600 scripts\/qualification\/([a-z0-9-]+\.mjs)/gu)]
            .map(match => match[1]);
        /* Eight closure members plus the two KVM modules staged a second time for the probe. */
        assert.deepEqual([...new Set(sealed)].sort(), [
            "linux-kvm-capability.mjs", "linux-kvm-privileged-capability.mjs",
            "linux-windows-cpu-floor-admission.mjs", "linux-windows-cpu-floor-stage2-controller.mjs",
            "linux-windows-cpu-floor-stage2-hosted.mjs", "linux-windows-cpu-floor-stage2-qmp.mjs",
            "linux-windows-cpu-floor-stage2.mjs", "windows-msi-post-setup-activation.mjs"]);
    });
});
