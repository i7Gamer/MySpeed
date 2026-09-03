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

// Comments describe the intent; they are not the thing being asserted, and a
// requirement satisfied only by a comment that mentions it is not satisfied.
const withoutComments = (source) => source
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

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
        } else if (/^ {2}#/.test(line)) {
            // A comment at the jobs indent introduces the *next* job, and
            // ran on into the previous one's block: checksums-msi came back
            // carrying finalize-release's docblock, so a match anywhere in
            // it could be satisfied by text about a different job.
            current = null;
        } else if (current) {
            jobs[current].push(line);
        }
    }

    return Object.fromEntries(Object.entries(jobs).map(([name, body]) => [name, body.join("\n")]));
};

/**
 * What a job waits for, in the three spellings the release chain uses:
 * `needs: one`, `needs: [a, b]`, and a bracketed list wrapped over two lines.
 *
 * The bracket alternative comes first and is not anchored to the line end,
 * because `.` stops at one: the wrapped list this workflow grew read as far
 * as the comma and dropped finalize-release, so the job that publishes the
 * release looked to this file like something nothing waited for.
 */
const needsOf = (block) => {
    const declared = /^ {4}needs:\s*(\[[^\]]*]|.+)$/m.exec(block);
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

/**
 * SHA256SUMS described everything on the release except the two things Windows
 * installs with.
 *
 * The hashing job lives inside build-binaries.yml and enumerates the assets the
 * release carries *at that moment*; build-msi needs the whole of that workflow,
 * so it necessarily uploads MySpeed-installer.msi and its baseline twin
 * afterwards, and nothing went back to hash them. Not the one-release bootstrap
 * gap - this one never closes on its own, and the installer is the artifact with
 * no install script to verify it on the user's behalf.
 *
 * The second pass appends rather than replacing the first, so a failing MSI leg
 * still leaves the binaries with the checksums they had.
 */
describe("the checksum list and the installers", () => {
    // The block with its prose taken out. A requirement satisfied only by a
    // comment saying the job does it is not satisfied - the sibling suite
    // over build-binaries.yml has carried this for the same reason.
    const appender = withoutComments(releaseJobs["checksums-msi"] ?? "");

    it("hashes the installers after the job that uploads them", () => {
        assert.ok(appender, "nothing hashes the MSI installers");
        assert.ok(needsOf(appender).includes("build-msi"),
            "the second checksum pass can run before the installers exist");
    });

    /**
     * And it does the thing it is named for.
     *
     * Everything else here is about when this job runs and what waits for
     * it, which a job body of `echo nothing` satisfies in full - so the
     * suite went green over a workflow that published no checksum at all.
     * These four are the program: read the release's assets, hash the ones
     * the earlier pass did not, and put the file back under its own name.
     */
    it("reads the release's own assets and hashes them", () => {
        assert.match(appender, /listReleaseAssets/,
            "the job hashes some fixed list rather than what the release carries");
        assert.match(appender, /createHash\('sha256'\)/,
            "nothing in this job computes a digest");
    });

    it("publishes the list under the name the install scripts fetch", () => {
        assert.match(appender, /uploadReleaseAsset\(\{[^}]*name: 'SHA256SUMS'/s,
            "the completed list is uploaded under some other name, or not at all");
        assert.match(appender, /deleteReleaseAsset/,
            "a release cannot carry two assets of one name, so the old list has to go first");
    });

    /**
     * Appended rather than rewritten, which is the whole reason this is a
     * second pass instead of a change to the first: the binaries were hashed
     * from the bytes as uploaded, and re-downloading six of them to reach the
     * same answer is transfer paid for nothing.
     */
    it("keeps the digests the earlier pass already wrote", () => {
        assert.match(appender, /assets\.find\(\(asset\) => asset\.name === 'SHA256SUMS'\)/,
            "the job never looks for the list build-binaries left");
        assert.match(appender, /digests\.has\(asset\.name\)/,
            "every asset is re-hashed, so a failing MSI leg can lose the binaries their checksums");
    });

    /**
     * !cancelled(), because the default is success(): a failed MSI leg would
     * otherwise skip this job and take the whole file's completion with it,
     * which is worse than the state it replaces. always() did that too, and
     * also ran on a cancelled workflow - where the release is being deleted
     * or reported and an upload has nothing to win.
     */
    it("runs even when the MSI legs did not, but not on a cancelled run", () => {
        assert.match(appender, /!cancelled\(\)/,
            "one failing installer leg suppresses the checksum pass entirely");
        assert.doesNotMatch(appender, /always\(\)/,
            "a cancelled release run still uploads to a release being torn down");
    });

    // The failure cleanup-on-failure deletes the whole release over. An
    // upload landing in the middle of that deletion races it for nothing:
    // finalize-release needs build-binaries too, so there is no release left
    // for this file to be published with.
    it("stands down when the binaries themselves failed", () => {
        assert.ok(needsOf(appender).includes("build-binaries"),
            "the checksum pass runs against a release that is being deleted");
        assert.match(appender, /needs\.build-binaries\.result == 'success'/,
            "waiting for build-binaries is not the same as requiring it under !cancelled()");
    });

    /**
     * finalize-release is what turns the draft into a published release, so a
     * release made public ahead of this job hands out installers that nothing
     * can check.
     */
    it("completes the list before the release is published", () => {
        assert.ok(needsOf(releaseJobs["finalize-release"]).includes("checksums-msi"),
            "the release is un-drafted before its checksum list is finished");
    });

    // And a draft left behind says so. The partial-release report is the only
    // thing that explains an unpublished release, and a job that can hold the
    // publish back while leaving no row in that table is a draft nobody can
    // account for.
    it("is named in the report a partial release leaves behind", () => {
        const report = withoutComments(releaseJobs["report-partial-release"] ?? "");

        assert.ok(needsOf(report).includes("checksums-msi"),
            "the report can be written before the job that held the publish back has finished");
        assert.match(report, /needs\.checksums-msi\.result/,
            "the report cannot read the result of the job that held the publish back");

        // The row, not the env line that feeds it. Reading the result into the
        // environment and never printing it satisfied the assertion above while
        // the table said nothing about the job.
        assert.match(report, /echo "\| [^|]*\| \$CHECKSUMS_RESULT \|"/,
            "the table skips the one job that can keep a complete release in draft");
    });
});
