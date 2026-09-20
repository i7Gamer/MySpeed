import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {describe, it} from "node:test";
import {fileURLToPath} from "node:url";
import {parse} from "yaml";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = path.join(HERE, "..", "..", ".github", "workflows", "build-binaries.yml");
const WINDOWS_JOB = "build-windows";
const GATED_JOBS = ["build-linux", "build-macos", "build-zip", "build-static"];
const GATE = "${{ !inputs.windows_only }}";

/*
 * The CPU-floor branch workflow builds the Windows executable through this workflow rather than
 * inlining its own bun commands, because the binary it tests has to come from the recipe that
 * ships. It has no use for the Linux, macOS or source artifacts, and a ~50 minute KVM job should
 * not wait on them.
 */
describe("build-binaries windows_only", () => {
    const workflow = parse(fs.readFileSync(WORKFLOW_PATH, "utf8"));

    it("offers windows_only as an optional input that defaults to building everything", () => {
        const input = workflow.on.workflow_call.inputs.windows_only;
        assert.equal(input.type, "boolean");
        assert.equal(input.required, false);
        assert.equal(input.default, false);
    });

    it("gates every non-Windows job on it, and never the Windows one", () => {
        assert.deepEqual(Object.keys(workflow.jobs).sort(), [...GATED_JOBS, WINDOWS_JOB].sort(),
            "a new job must be a deliberate decision about whether windows_only gates it");
        for (const name of GATED_JOBS) assert.equal(workflow.jobs[name].if, GATE, name);
        assert.equal(workflow.jobs[WINDOWS_JOB].if, undefined,
            "the Windows job is the one thing windows_only keeps");
    });

    /*
     * The existing caller passes no windows_only at all. If the default ever flipped, a release
     * would quietly stop producing Linux, macOS and source artifacts.
     */
    it("leaves the release qualification caller building the full set", () => {
        const qualification = parse(fs.readFileSync(
            path.join(HERE, "..", "..", ".github", "workflows", "qualify-release.yml"), "utf8"));
        const caller = Object.values(qualification.jobs)
            .find(job => job.uses === "./.github/workflows/build-binaries.yml");
        assert.ok(caller, "qualify-release.yml must still call build-binaries.yml");
        assert.equal(caller.with?.windows_only, undefined);
        assert.equal(workflow.on.workflow_call.inputs.windows_only.default, false);
    });

    it("still requires the version, ref and Windows stamp it always did", () => {
        const {inputs} = workflow.on.workflow_call;
        for (const name of ["version", "ref", "windows_stamp"]) {
            assert.equal(inputs[name].required, true, name);
        }
    });
});
