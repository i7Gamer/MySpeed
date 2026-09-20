import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {describe, it} from "node:test";
import {fileURLToPath} from "node:url";
import {parse} from "yaml";

import {STAGE3_BUDGET_CONSTANTS} from
    "../../scripts/qualification/linux-windows-cpu-floor-stage3.mjs";
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

    /*
     * Each suite has to be its own continued line, not merely a substring of the step. A literal
     * "\n" pasted into the YAML instead of a line break leaves every name present and the command
     * unrunnable, which a substring match cannot tell apart from a working battery.
     */
    it("runs the branch suites before sealing the closure", () => {
        const step = workflow().jobs.seal.steps.find(item =>
            String(item.name).includes("unit tests"));
        const lines = String(step.run).split("\n").map(value => value.trim());
        for (const suite of ["prereleaseCpuFloorTarget", "prereleaseCpuFloor",
            "prereleaseCpuFloorHostedInputs", "linuxWindowsCpuFloorStage3CandidateProvenance",
            "branchCpuFloorWorkflow",
            /*
             * The run builds through build-binaries with windows_only, and stages a fixture whose
             * inventory three consumers hard-code. Both contracts are this workflow's to rely on,
             * so both are proven before anything is sealed.
             */
            "buildBinariesWindowsOnly", "fixtureInventoryParity"]) {
            assert.ok(lines.some(line =>
                /^(bun test )?tests\/server\/[A-Za-z0-9]+\.test\.js( \\)?$/u.test(line)
                && line.includes(`tests/server/${suite}.test.js`)),
            `${suite} must be its own line in the battery`);
        }
        assert.doesNotMatch(String(step.run), /\\n/u, "no literal backslash-n in the command");
    });

    /*
     * The numbers that actually bound the run are the Stage 3 constants, not these env values - the
     * budget anchor reads the constants. So the job's own timeout has to be pinned to the same
     * authority: lowering timeout-minutes without lowering the constant would leave the anchor
     * computing a hard stop past the point GitHub cancels the job, and the sequence would outlive
     * both evidence uploads. Pinning only "env equals timeout" would not have caught that.
     */
    it("pins every budget number to the constants the anchor actually uses", () => {
        const value = workflow();
        assert.equal(value.jobs.execute["timeout-minutes"] * 60 * 1_000,
            STAGE3_BUDGET_CONSTANTS.JOB_CEILING_MILLISECONDS);
        assert.equal(Number(value.env.EXECUTE_JOB_CEILING_SECONDS) * 1_000,
            STAGE3_BUDGET_CONSTANTS.JOB_CEILING_MILLISECONDS);
        assert.equal(Number(value.env.EVIDENCE_RETENTION_RESERVE_SECONDS) * 1_000,
            STAGE3_BUDGET_CONSTANTS.RETENTION_RESERVE_MILLISECONDS);
        assert.equal(Number(value.env.MINIMUM_SEQUENCE_SECONDS) * 1_000,
            STAGE3_BUDGET_CONSTANTS.MINIMUM_SEQUENCE_MILLISECONDS);
        const step = value.jobs.execute.steps.find(item => item.id === "run-sequence");
        assert.equal(Number(step.env.SEQUENCE_KILL_GRACE_SECONDS) * 1_000,
            STAGE3_BUDGET_CONSTANTS.SEQUENCE_KILL_GRACE_MILLISECONDS);
    });

    /*
     * The guest system disk is tens of gigabytes and nothing extracts evidence from it. Leaving it
     * in makes the upload that matters - the one taken when a sequence stalled - unlikely to finish
     * inside the retention reserve held back for it.
     */
    it("keeps the guest system disk out of the evidence upload", () => {
        const step = workflow().jobs.execute.steps.find(item =>
            String(item.name).includes("Upload non-qualifying evidence"));
        const paths = String(step.with.path).split("\n").map(value => value.trim());
        assert.ok(paths.some(value => value.startsWith("!") && value.endsWith("/stage3.qcow2")),
            "the system disk must be excluded");
        assert.ok(paths.some(value => !value.startsWith("!") && value.includes("myspeed-stage3-")),
            "the rest of the Stage 3 root must still be uploaded");
    });

    it("stages the executable by its real name inside the artifact", () => {
        const step = workflow().jobs.execute.steps.find(item =>
            String(item.name).includes("Run authenticated launcher"));
        assert.match(step.run, /candidateRoot, "MySpeed\.exe"/u);
        assert.match(step.run, /MySpeed\.exe\.sha256/u);
        assert.match(step.run, /candidateDeclaredSha256/u);
    });
});
