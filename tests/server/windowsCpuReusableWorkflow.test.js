import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {parse} from "yaml";
import {readSource} from "../helpers/source.js";

const WORKFLOW = ".github/workflows/windows-cpu-readiness.yml";
const SOURCE = "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}";
const workflow = () => parse(readSource(WORKFLOW));
const OUTPUTS = {
    closure_artifact_id: "${{ jobs.prepare.outputs.artifact_id }}",
    closure_artifact_digest: "${{ jobs.prepare.outputs.artifact_digest }}",
    probe_artifact_id: "${{ jobs.readiness.outputs.artifact_id }}",
    probe_artifact_digest: "${{ jobs.readiness.outputs.artifact_digest }}",
    nonce: "${{ jobs.prepare.outputs.nonce }}"
};

describe("shared same-run CPU probe producer", () => {
    it("exposes exact artifact identities without accepting caller-selected historical probes", () => {
        const config = workflow();
        const call = config.on.workflow_call;
        assert.ok(call);
        assert.equal(call.inputs, undefined);
        assert.equal(call.secrets, undefined);
        assert.deepEqual(Object.fromEntries(Object.entries(call.outputs).map(([name, value]) =>
            [name, value.value])), OUTPUTS);
        assert.equal(config.env.EXPECTED_SOURCE_SHA, SOURCE);
        assert.equal(config.env.EXPECTED_EVENT_SHA, "${{ github.sha }}");
        assert.equal(config.env.EXPECTED_RUN_ID, "${{ github.run_id }}");
        assert.equal(config.env.EXPECTED_RUN_ATTEMPT, "${{ github.run_attempt }}");
    });

    it("derives workflow outputs from immutable uploads, not input or success flags", () => {
        const {prepare, readiness} = workflow().jobs;
        assert.equal(prepare.outputs.artifact_digest, "${{ steps.upload.outputs.artifact-digest }}");
        assert.deepEqual(readiness.outputs, {
            artifact_id: "${{ steps.evidence.outputs.artifact-id }}",
            artifact_digest: "${{ steps.evidence.outputs.artifact-digest }}"
        });
        const upload = readiness.steps.find(step => step.id === "evidence");
        assert.ok(upload.uses.startsWith("actions/upload-artifact@"));
        assert.equal(upload.with.name, "windows-cpu-readiness-evidence");
        assert.equal(upload.if, "always() && steps.bound_evidence.outcome == 'success'");
        assert.equal(readiness.needs, "prepare");
        assert.equal(readiness["continue-on-error"], undefined);
        assert.ok(readiness.steps.find(step => step.name === "Confirm successful runner continuation"));
    });

    it("retains candidate-neutral isolated execution and read-only authority", () => {
        const config = workflow();
        assert.deepEqual(config.permissions, {actions: "read", contents: "read"});
        assert.ok(Object.hasOwn(config.on, "pull_request"));
        assert.ok(Object.hasOwn(config.on, "push"));
        assert.ok(Object.hasOwn(config.on, "workflow_dispatch"));
        assert.match(config.jobs.prepare.if, /github\.repository == 'i7Gamer\/MySpeed'/);
        const executor = config.jobs.readiness;
        assert.equal(executor["runs-on"], "windows-2025");
        assert.equal(executor.steps.some(step => step.uses?.startsWith("actions/checkout@")), false);
        const download = executor.steps.find(step => step.uses?.startsWith("actions/download-artifact@"));
        assert.equal(download.with["artifact-ids"], "${{ needs.prepare.outputs.artifact_id }}");
        assert.equal(download.with["run-id"], undefined);
        assert.equal(download.with.pattern, undefined);
        assert.doesNotMatch(readSource(WORKFLOW), /contents:\s*write|packages:\s*write|continue-on-error:\s*true/);
    });
});
