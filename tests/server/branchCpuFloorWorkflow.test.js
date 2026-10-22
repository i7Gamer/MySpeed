import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {describe, it} from "node:test";
import {fileURLToPath} from "node:url";
import {parse} from "yaml";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = path.join(HERE, "..", "..", ".github", "workflows",
    "windows-cpu-floor-branch.yml");
const JOBS = ["version", "build", "readiness", "floor"];

const text = () => fs.readFileSync(WORKFLOW_PATH, "utf8");
const workflow = () => parse(text());

/*
 * The branch workflow is a thin caller. The guest bundle, the sealed closure and the KVM execution
 * live in windows-cpu-floor-candidate.yml, shared with the release qualification, and are tested in
 * windowsCpuFloorCandidateWorkflow.test.js.
 */
describe("Windows CPU-floor branch workflow", () => {
    it("is manual, read-only, non-publishing, and pinned", () => {
        const value = workflow();
        assert.deepEqual(Object.keys(value.on), ["workflow_dispatch"]);
        assert.deepEqual(value.permissions, {actions: "read", contents: "read"});
        assert.deepEqual(Object.keys(value.jobs), JOBS);

        for (const [name, job] of Object.entries(value.jobs)) {
            assert.match(job.if, /github\.repository == 'i7Gamer\/MySpeed'/u, name);
        }
        for (const match of text().matchAll(/uses: ([^\s@]+)@([^\s]+)/gu)) {
            assert.ok(match[1].startsWith("./") || /^[0-9a-f]{40}$/u.test(match[2]),
                `${match[1]} is not pinned to a 40-char commit SHA: ${match[2]}`);
        }
        assert.doesNotMatch(text(), /contents: write|packages: write|gh release/u);
    });

    /*
     * A branch run carries no release identity at all. If any of these reappear it means the
     * workflow has been pointed back at published artifacts, which is the thing it exists to avoid.
     */
    it("carries no published-release identity and writes no qualification manifest", () => {
        assert.doesNotMatch(text(), /v1\.6\.1|4fa4dd40a89a062735f98bd85d685e0624ff46a8/u);
        assert.doesNotMatch(text(), /QUALIFICATION_RUN_ID|BASELINE_EXE_ASSET_ID|releases\/download/u);
        assert.doesNotMatch(text(), /qualification-manifest/u);
    });

    it("requires the typed confirmation before any job runs", () => {
        const value = workflow();
        assert.equal(value.on.workflow_dispatch.inputs.confirmation.required, true);
        assert.match(value.jobs.version.if, /inputs\.confirmation == 'RUN-WINDOWS-BASELINE-CPU-FLOOR'/u);
        for (const name of JOBS.slice(1)) assert.ok([value.jobs[name].needs].flat().includes("version"), name);
    });

    /*
     * The binary under test has to come from the recipe that ships. Building it inline would test
     * a second recipe that nothing keeps in step with the release.
     */
    it("builds the candidate through the release recipe, Windows only, at the dispatched commit", () => {
        const value = workflow();
        assert.equal(value.jobs.build.uses, "./.github/workflows/build-binaries.yml");
        assert.equal(value.jobs.build.with.windows_only, true);
        assert.match(String(value.jobs.build.with.ref), /github\.sha/u);
        assert.deepEqual(value.jobs.build.needs, ["version"]);
    });

    /*
     * The version has to come from the commit under test. A dispatch input would let a run be told
     * it is testing a version it is not.
     */
    it("reads the candidate version from the dispatched commit, never from an input", () => {
        const value = workflow();
        const inputs = Object.keys(value.on.workflow_dispatch.inputs);
        for (const name of ["version", "candidate_version", "windows_stamp"]) {
            assert.ok(!inputs.includes(name), name);
        }
        const step = value.jobs.version.steps.find(item => item.id === "read");
        assert.match(step.run, /require\("\.\/package\.json"\)\.version/u);
        assert.equal(value.jobs.floor.with.version, "${{ needs.version.outputs.version }}");
        assert.equal(value.jobs.floor.with.windows_stamp, "${{ needs.version.outputs.windows_stamp }}");
    });

    /*
     * The probe now comes from this run's own readiness job, so a dispatcher can no longer point the
     * guest at some earlier run's probe archive.
     */
    it("produces its probe in the same run instead of accepting a prior probe identity", () => {
        const value = workflow();
        assert.deepEqual(Object.keys(value.on.workflow_dispatch.inputs).sort(),
            ["confirmation", "stage3_installer_confirmation"]);
        assert.doesNotMatch(text(), /probe_run_id|probe_run_attempt|probe_source_sha|probe_archive_bytes|probe_archive_sha256/u);
        assert.equal(value.jobs.readiness.uses, "./.github/workflows/windows-cpu-readiness.yml");
        assert.equal(value.jobs.floor.with.probe_artifact_id, "${{ needs.readiness.outputs.probe_artifact_id }}");
        assert.equal(value.jobs.floor.with.probe_artifact_digest, "${{ needs.readiness.outputs.probe_artifact_digest }}");
    });

    it("hands the candidate workflow its own job name so the budget anchor finds the execute job", () => {
        const value = workflow();
        assert.equal(value.jobs.floor.uses, "./.github/workflows/windows-cpu-floor-candidate.yml");
        assert.deepEqual(value.jobs.floor.needs, ["version", "build", "readiness"]);
        assert.equal(value.jobs.floor.with.caller_job_name, value.jobs.floor.name);
        assert.equal(value.jobs.floor.with.source_sha, "${{ github.sha }}");
        assert.equal(value.jobs.floor.with.stage3_installer_confirmation,
            "${{ inputs.stage3_installer_confirmation }}");
        const options = value.on.workflow_dispatch.inputs.stage3_installer_confirmation.options;
        assert.ok(options.includes("cadence-enter-before-setup-v3"));
        assert.equal(value.on.workflow_dispatch.inputs.stage3_installer_confirmation.default, "no-input");
    });
});
