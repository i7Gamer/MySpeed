import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {parse} from "yaml";
import {readSource} from "../helpers/source.js";

const WORKFLOW = ".github/workflows/macos-isolation.yml";
const EVENT_CHECKOUT = "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}";
const config = () => parse(readSource(WORKFLOW));
const actionStep = (job, action) => job.steps.find(({uses}) => uses?.startsWith(`${action}@`));

describe("candidate-neutral macOS isolation workflow", () => {
    it("runs on relevant PR changes, default-branch changes and explicit dispatch only", () => {
        const workflow = config();
        assert.deepEqual(Object.keys(workflow.on).sort(), ["pull_request", "push", "workflow_dispatch"]);
        assert.deepEqual(workflow.on.push.branches, ["development"]);
        for (const event of ["pull_request", "push"])
            assert.deepEqual(workflow.on[event].paths, [
                WORKFLOW, "scripts/qualification/macos-isolation.mjs", "tests/server/macosIsolation*.test.js"
            ]);
        assert.equal(workflow.on.workflow_dispatch, null);
        assert.deepEqual(workflow.permissions, {contents: "read"});
    });

    it("covers both native architectures on fixed hosted macOS images with bounded runtime", () => {
        const jobs = config().jobs;
        assert.deepEqual(Object.keys(jobs), ["canary"]);
        assert.equal(jobs.canary["runs-on"], "${{ matrix.runner }}");
        assert.equal(jobs.canary["timeout-minutes"], 10);
        assert.equal(jobs.canary.strategy["fail-fast"], false);
        assert.deepEqual(jobs.canary.strategy.matrix.include, [
            {runner: "macos-15-intel", arch: "x64"}, {runner: "macos-15", arch: "arm64"}
        ]);
    });

    it("pins actions and Node without checking out arbitrary inputs or persisting credentials", () => {
        const job = config().jobs.canary;
        assert.deepEqual(job.steps.filter(({uses}) => uses).map(({uses}) => uses), [
            "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
            "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
            "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"
        ]);
        assert.deepEqual(actionStep(job, "actions/checkout").with, {
            ref: EVENT_CHECKOUT, "persist-credentials": false
        });
        assert.deepEqual(actionStep(job, "actions/setup-node").with, {"node-version": "22.19.0"});
    });

    it("runs only the candidate-neutral canary without installing or launching MySpeed", () => {
        const steps = config().jobs.canary.steps.filter(({run}) => run);
        assert.equal(steps.length, 1);
        assert.equal(steps[0].shell, "bash");
        assert.deepEqual(steps[0].env, {EXPECTED_ARCH: "${{ matrix.arch }}"});
        assert.match(steps[0].run, /node scripts\/qualification\/macos-isolation\.mjs canary/);
        assert.match(steps[0].run, /--expected-arch "\$EXPECTED_ARCH"/);
        assert.match(steps[0].run, /--source-root "\$GITHUB_WORKSPACE"/);
        assert.match(steps[0].run, /--evidence-dir "\$RUNNER_TEMP\/macos-isolation-evidence"/);
        assert.match(steps[0].run, /--source-sentinel package\.json/);
        assert.doesNotMatch(steps[0].run, /\$\{\{|sudo|curl|wget|npm|bun|speedtest|check-artifact|qualification-manifest/);
    });

    it("uploads only the diagnostic profile and evidence, including failed probes", () => {
        const step = actionStep(config().jobs.canary, "actions/upload-artifact");
        assert.equal(step.if, "always()");
        assert.equal(step.with.name, "macos-isolation-${{ matrix.arch }}");
        assert.equal(step.with["if-no-files-found"], "error");
        assert.deepEqual(step.with.path.trim().split("\n"), [
            "${{ runner.temp }}/macos-isolation-evidence/macos-isolation.sb",
            "${{ runner.temp }}/macos-isolation-evidence/macos-isolation.json"
        ]);
    });
});
