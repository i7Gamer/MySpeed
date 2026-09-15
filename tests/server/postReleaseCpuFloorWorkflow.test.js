import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {describe, it} from "node:test";
import {fileURLToPath} from "node:url";
import {parse} from "yaml";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = path.join(HERE, "..", "..", ".github", "workflows",
    "windows-cpu-floor-post-release-v1.6.1.yml");

describe("Windows CPU floor post-release v1.6.1 workflow", () => {
    it("is manual, read-only, non-publishing, and pinned", () => {
        const text = fs.readFileSync(WORKFLOW_PATH, "utf8");
        const workflow = parse(text);

        assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
        assert.deepEqual(workflow.permissions, {actions: "read", contents: "read"});
        assert.deepEqual(Object.keys(workflow.jobs), ["seal", "execute"]);

        for (const job of Object.values(workflow.jobs)) {
            assert.match(job.if, /github\.repository == 'i7Gamer\/MySpeed'/u);
        }

        for (const match of text.matchAll(/uses: ([^\s@]+)@([^\s]+)/gu)) {
            assert.ok(match[1].startsWith("./") || /^[0-9a-f]{40}$/u.test(match[2]),
                `${match[1]} is not pinned to a 40-char commit SHA: ${match[2]}`);
        }

        assert.doesNotMatch(text, /contents: write|packages: write|gh release/u);
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

    it("closure list uses windows-baseline-guest-bootstrap.mjs not windows-msi-stage2-request.mjs (Finding 2)", () => {
        const text = fs.readFileSync(WORKFLOW_PATH, "utf8");
        assert.doesNotMatch(text, /windows-msi-stage2-request\.mjs/u);
        assert.match(text, /windows-baseline-guest-bootstrap\.mjs/u);
    });

    it("execute job runs real Node sequence invocation not a test-f placeholder (Finding 1)", () => {
        const text = fs.readFileSync(WORKFLOW_PATH, "utf8");
        const workflow = parse(text);
        const executeSteps = workflow.jobs.execute.steps;
        const runSeqStep = executeSteps.find(s => s.id === "run-sequence");
        assert.ok(runSeqStep, "run-sequence step must exist in execute job");
        // Must invoke node, not just test -f
        assert.match(runSeqStep.run, /node.*linux-windows-cpu-floor-stage3-sequence\.mjs/u);
        assert.doesNotMatch(runSeqStep.run, /^[^#]*test -f/mu);
    });

    it("cleanup step reads task-owned pidfiles and does not use global pkill (Finding 5)", () => {
        const text = fs.readFileSync(WORKFLOW_PATH, "utf8");
        const workflow = parse(text);
        const executeSteps = workflow.jobs.execute.steps;
        const cleanupStep = executeSteps.find(s =>
            typeof s.run === "string" && s.run.includes("qemu.pid"));
        assert.ok(cleanupStep, "A cleanup step reading qemu.pid must exist");
        // Must read task-owned pidfiles
        assert.match(cleanupStep.run, /myspeed-windows-cpu-floor-\$nonce[/\\]qemu\.pid/u);
        assert.match(cleanupStep.run, /myspeed-stage3-\$nonce[/\\]baseline-qemu\.pid/u);
        // Must not use global pkill as primary cleanup
        assert.doesNotMatch(cleanupStep.run, /pkill.*qemu-system-x86_64/u);
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
    });
});
