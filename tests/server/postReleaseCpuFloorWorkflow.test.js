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
});
