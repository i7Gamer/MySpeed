import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {describe, it} from "node:test";
import {fileURLToPath} from "node:url";
import {parse} from "yaml";

import {POST_RELEASE_CPU_FLOOR_GUEST_PREPARATION_CONSTANTS} from
    "../../scripts/release/post-release-cpu-floor-guest-preparation.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = path.join(HERE, "..", "..", ".github", "workflows",
    "windows-cpu-floor-branch.yml");
const JOBS = ["version", "build", "bundle", "seal", "execute"];

const text = () => fs.readFileSync(WORKFLOW_PATH, "utf8");
const workflow = () => parse(text());

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
    it("carries no published-release identity", () => {
        assert.doesNotMatch(text(), /v1\.6\.1|4fa4dd40a89a062735f98bd85d685e0624ff46a8/u);
        assert.doesNotMatch(text(), /QUALIFICATION_RUN_ID|BASELINE_EXE_ASSET_ID|releases\/download/u);
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
        assert.deepEqual(value.jobs.execute.needs, JOBS.slice(0, 4));
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
    });

    /*
     * Every field the binding trusts has to be GitHub's record of this run. Hashing the downloaded
     * file locally would prove the bytes are self-consistent and nothing about their origin.
     */
    it("takes the candidate artifact's identity from the API record of this run", () => {
        const value = workflow();
        const step = value.jobs.execute.steps.find(item => item.id === "candidate-metadata");
        assert.match(step.with.script, /listWorkflowRunArtifacts/u);
        assert.match(step.with.script, /workflow_run\?\.id.*GITHUB_RUN_ID/su);
        assert.match(step.with.script, /workflow_run\?\.head_sha.*GITHUB_SHA/su);
        assert.match(step.with.script, /artifact\.expired !== false/u);
        assert.match(step.with.script, /expires_at/u);
        assert.match(step.with.script, /matching\.length !== 1/u);
    });

    it("authenticates the guest bundle against this run before downloading it", () => {
        const value = workflow();
        const step = value.jobs.execute.steps.find(item => item.id === "bundle-metadata");
        assert.match(step.with.script, /workflow_run\?\.id.*GITHUB_RUN_ID/su);
        assert.match(step.with.script, /workflow_run\?\.head_sha.*GITHUB_SHA/su);
        const download = value.jobs.execute.steps.find(item =>
            String(item.name).includes("Download this run's authenticated guest bundle"));
        assert.match(String(download.with["artifact-ids"]), /steps\.bundle-metadata\.outputs\.id/u);
    });

    /*
     * The workflow pins the Windows Node runtime it puts in the guest. The guest preparation module
     * pins the same digest and refuses anything else, so a drift between the two would fail only
     * inside a VM, late in a fifty-minute run.
     */
    it("pins the guest Node runtime to the digest the guest preparation enforces", () => {
        assert.equal(workflow().env.NODE_RUNTIME_SHA256,
            POST_RELEASE_CPU_FLOOR_GUEST_PREPARATION_CONSTANTS.NODE_RUNTIME_SHA256);
    });

    /*
     * Both registries are generated rather than committed, and the fixture seeding imports them.
     * Without this step the handoff fails on a fresh checkout with ERR_MODULE_NOT_FOUND, which no
     * unit test can reach because every test fixture builds the inventory by hand.
     */
    it("generates the server registries before seeding the fixture", () => {
        const steps = workflow().jobs.bundle.steps.map(item => String(item.name));
        const generate = steps.findIndex(name => name.includes("Generate the server registries"));
        const seed = steps.findIndex(name => name.includes("Stage the guest runtime files"));
        assert.ok(generate >= 0, "the registries must be generated");
        assert.ok(generate < seed, "they must be generated before the handoff that imports them");
        const step = workflow().jobs.bundle.steps[generate];
        assert.match(step.run, /generate-migrations\.js/u);
        assert.match(step.run, /generate-integrations\.js/u);
    });

    /*
     * The artifact API does not report which attempt produced an artifact, so a re-run that skips
     * the build job would bind an attempt-1 artifact and label it attempt 2.
     */
    it("refuses to bind evidence on a re-run attempt", () => {
        const step = workflow().jobs.execute.steps.find(item => item.id === "candidate-metadata");
        assert.match(step.with.script, /GITHUB_RUN_ATTEMPT !== '1'/u);
    });

    it("requires the complete prior probe artifact identity at dispatch", () => {
        const inputs = workflow().on.workflow_dispatch.inputs;
        for (const name of ["probe_artifact_id", "probe_run_id", "probe_run_attempt",
            "probe_source_sha", "probe_archive_bytes", "probe_archive_sha256"]) {
            assert.equal(inputs[name].required, true, name);
        }
    });

    it("runs the branch suites before sealing the closure", () => {
        const step = workflow().jobs.seal.steps.find(item =>
            String(item.name).includes("unit tests"));
        for (const suite of ["prereleaseCpuFloorTarget", "prereleaseCpuFloor",
            "prereleaseCpuFloorHostedInputs", "linuxWindowsCpuFloorStage3CandidateProvenance",
            "branchCpuFloorWorkflow"]) {
            assert.match(step.run, new RegExp(`tests/server/${suite}\\.test\\.js`, "u"), suite);
        }
    });

    /*
     * The evidence budget is derived from the execute job's own ceiling. Two numbers that must
     * agree but are written twice are two numbers that eventually disagree.
     */
    it("derives the sequence budget from the job ceiling it actually runs under", () => {
        const value = workflow();
        assert.equal(Number(value.env.EXECUTE_JOB_CEILING_SECONDS),
            value.jobs.execute["timeout-minutes"] * 60);
        assert.ok(Number(value.env.EVIDENCE_RETENTION_RESERVE_SECONDS) > 0);
        assert.ok(Number(value.env.MINIMUM_SEQUENCE_SECONDS)
            < Number(value.env.EXECUTE_JOB_CEILING_SECONDS));
    });

    it("stages the executable by its real name inside the artifact", () => {
        const step = workflow().jobs.execute.steps.find(item =>
            String(item.name).includes("Run authenticated launcher"));
        assert.match(step.run, /candidateRoot, "MySpeed\.exe"/u);
        assert.match(step.run, /MySpeed\.exe\.sha256/u);
        assert.match(step.run, /candidateDeclaredSha256/u);
    });
});
