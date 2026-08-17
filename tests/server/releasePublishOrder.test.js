import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORKFLOWS = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", ".github", "workflows");

// Missing files answer empty rather than throwing at import: a workflow that is
// gone should fail the assertion that names what it was for, not take the whole
// file down with a stack trace.
const read = (name) => {
    try {
        return fs.readFileSync(path.join(WORKFLOWS, name), "utf8").replace(/\r/g, "");
    } catch {
        return "";
    }
};

const release = read("create_release.yml");
const dockerBuild = read("build-docker.yml");
const dockerPublish = read("publish-docker.yml");
const deploy = read("deploy_docker_dev.yml");

/**
 * A workflow's jobs, as a name to its block. Jobs sit at two spaces under
 * `jobs:`; the next line at that indent opens the next one.
 */
const jobsOf = (workflow) => {
    const lines = workflow.split("\n");
    const start = lines.findIndex((line) => line === "jobs:");
    assert.notEqual(start, -1, "this workflow declares no jobs");

    const jobs = {};
    let current = null;

    for (const line of lines.slice(start + 1)) {
        const opener = /^ {2}([\w-]+):\s*$/.exec(line);
        if (opener) {
            current = opener[1];
            jobs[current] = [];
        } else if (current) {
            jobs[current].push(line);
        }
    }

    return Object.fromEntries(Object.entries(jobs).map(([name, body]) => [name, body.join("\n")]));
};

/**
 * What a job waits for, in either spelling the release chain uses: `needs: one`
 * and `needs: [a, b]`.
 */
const needsOf = (block) => {
    const declared = /^ {4}needs:\s*(.+)$/m.exec(block);
    if (!declared) return [];

    return declared[1].replace(/[[\]]/g, "").split(",").map((name) => name.trim()).filter(Boolean);
};

const releaseJobs = jobsOf(release);

/**
 * A failed release used to leave Docker Hub ahead of a release that no longer
 * exists.
 *
 * build-docker ran beside build-binaries rather than after it, and it published
 * `:latest` and `:<version>` the moment its own jobs finished. If the binaries
 * then failed, cleanup-on-failure deleted the tag and the draft release - it has
 * no reach into a registry - so `:latest` was left pointing at a version with no
 * GitHub release behind it, and nothing anywhere said so.
 *
 * Not hypothetical: it happened three times on the night 1.3.3 was cut, once per
 * failed attempt, and `docker pull myspeed` resolved to an unreleased build for
 * about four hours.
 *
 * The split that fixes it falls along a line the pipeline already had. The
 * per-arch jobs push by digest, which publishes an untagged blob that nothing
 * resolves to and no one can pull by name; only the manifest merge creates a
 * tag. So the merge moved into publish-docker.yml, held behind the binaries,
 * while the builds - the slow half, and the half that proves the image runs on
 * both architectures - still run beside them.
 *
 * A digest push left behind by a failed release is the deliberate remainder:
 * unreferenced, invisible to `docker pull`, and collectable, which is a
 * different thing from a moved tag.
 */
describe("what a failed release can leave on Docker Hub", () => {
    it("holds the docker tags back until the binaries have succeeded", () => {
        const publisher = Object.entries(releaseJobs)
            .find(([, block]) => block.includes("publish-docker.yml"));

        assert.ok(publisher, "no job in the release chain publishes the docker tags");

        const [name, block] = publisher;
        assert.ok(needsOf(block).includes("build-binaries"),
            `${name} publishes docker tags without waiting for build-binaries, so a binary that fails `
            + "after it leaves :latest on a version whose release and tag are about to be deleted");
    });

    /**
     * The half that keeps the split honest. Everything above is worth nothing if
     * the job running beside the binaries goes back to pushing a tag.
     */
    it("publishes no tag from the job that runs beside the binaries", () => {
        assert.match(dockerBuild, /push-by-digest=true/,
            "the per-arch jobs no longer push by digest, so they publish a name of their own");
        assert.doesNotMatch(dockerBuild, /imagetools create/,
            "the job that runs beside the binaries creates a manifest tag again");

        const buildJob = Object.entries(releaseJobs).find(([, block]) => block.includes("build-docker.yml"));
        assert.ok(buildJob, "the release chain no longer builds images");
        assert.ok(!needsOf(buildJob[1]).includes("build-binaries"),
            "the image builds now wait on the binaries too, which costs the parallelism the split kept");
    });

    it("creates the tags in the workflow that is held back", () => {
        assert.match(dockerPublish, /imagetools create/,
            "publish-docker.yml does not publish anything");
    });

    /**
     * finalize-release is what turns the draft into a release, so it has to come
     * after the tags rather than beside them - otherwise the release can be
     * published while the images it names are still going up.
     */
    it("finalizes the release only once the images carry their tags", () => {
        const finalize = releaseJobs["finalize-release"];
        assert.ok(finalize, "the release chain no longer finalizes");

        const waits = needsOf(finalize);
        assert.ok(waits.includes("publish-docker"),
            "the release is published without waiting for the docker tags it advertises");
    });

    /**
     * The manual deploy goes through the same two workflows, so :latest stays a
     * multi-arch manifest there too - the reason build-docker.yml exists rather
     * than each caller building its own.
     */
    it("keeps the manual deploy on the same two steps", () => {
        assert.match(deploy, /build-docker\.yml/, "the manual deploy no longer builds through the shared workflow");
        assert.match(deploy, /publish-docker\.yml/, "the manual deploy builds images and never tags them");

        const publisher = Object.entries(jobsOf(deploy))
            .find(([, block]) => block.includes("publish-docker.yml"));

        assert.ok(needsOf(publisher[1]).length > 0,
            "the manual deploy tags before its own builds have pushed their digests");
    });
});
