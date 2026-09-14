import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {describe, it} from "node:test";
import {fileURLToPath} from "node:url";

import {parse} from "yaml";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW = path.join(HERE, "..", "..", ".github", "workflows", "linux-windows-cpu-floor-stage2.yml");

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
});
