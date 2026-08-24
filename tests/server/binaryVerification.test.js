import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource, withoutHashComments } from "../helpers/source.js";

// Comments stripped before anything is asserted, for the reason the shared
// helper states: a comment naming verify-binary.ps1 is found by an indexOf
// looking for the step that runs it. What is asserted is what the workflow
// runs, not what it says about itself.
const workflow = withoutHashComments(readSource(".github/workflows/build-binaries.yml"));

/**
 * One job's block, bounded by the job that follows it.
 *
 * The search for the next job starts *after* this one's own header line, or it
 * matches that line at offset zero and every assertion is made against an empty
 * string - which passes for anything.
 */
const jobOf = (name) => {
    const start = workflow.indexOf(`\n  ${name}:`);
    assert.notEqual(start, -1, `there is no ${name} job any more`);

    const bodyStart = workflow.indexOf("\n", start + 1) + 1;
    const next = workflow.slice(bodyStart).search(/^ {2}[a-z][\w-]*:$/m);
    const job = workflow.slice(start, next === -1 ? workflow.length : bodyStart + next);

    assert.ok(job.includes("steps:"), `the ${name} job block came back without any steps`);
    return job;
};

/**
 * The boot check is not a Windows-only concern.
 *
 * build-windows runs verify-binary.ps1 between the compile and the upload, and
 * its comment gives the reason: "a green compile says nothing about whether the
 * binary runs, which is the whole premise of the baseline leg". Every word of
 * that applies to MySpeed-linux-x64-baseline, which exists for exactly the same
 * CPUs - and install.sh selects it automatically and silently on any x86_64 host
 * without the avx2 flag, under a Restart=always unit.
 *
 * So the one artifact most likely to be picked up by someone who cannot debug it
 * was the one shipped without ever having been run.
 *
 * arm64 is exempt and says so in the matrix: pwsh is not on the arm runner image.
 */
describe("the Linux binaries are proven to boot", () => {
    const linux = jobOf("build-linux");

    it("verifies before uploading, as the Windows job does", () => {
        const verify = linux.indexOf("verify-binary.ps1");
        const upload = linux.indexOf("Upload to Release");

        assert.notEqual(verify, -1, "the Linux binaries are uploaded without ever having been run");
        assert.ok(verify < upload,
            "the binary is uploaded before it is verified, so the check gates nothing");
    });

    it("verifies the artifact by the name it was renamed to", () => {
        const rename = linux.indexOf("Rename binary");
        const verify = linux.indexOf("verify-binary.ps1");

        assert.ok(rename < verify, "the check runs against a file the rename has already moved");
    });

    it("says per leg whether it is verified, rather than leaving it implied", () => {
        const flags = [...linux.matchAll(/verify:\s*(true|false)/g)].map(([, value]) => value);

        assert.equal(flags.length, 3, "every Linux leg has to state whether it is verified");
        assert.deepEqual(flags.filter((value) => value === "true").length, 2,
            "both x64 legs - the ones install.sh picks between - must be verified");
    });

    it("only runs the check on the legs that declare it", () => {
        assert.match(linux, /if:\s*\$\{\{\s*matrix\.verify\s*\}\}/);
    });
});

/**
 * A workflow expression is substituted into the shell source before bash parses
 * it, so a value that reaches a `run:` body is code rather than data.
 *
 * create_release.yml took the dispatch input that way - `VERSION="${{
 * inputs.version }}"` - eleven lines above the regex that exists precisely
 * because the value is not trusted, in a job holding a contents:write token that
 * actions/checkout has already written into .git/config. Dispatching needs write
 * access, so this is not a privilege boundary being crossed; it is the
 * difference between "can cut a release" and "can run anything inside the
 * release job", and the fix is one line.
 *
 * The cleanup jobs in that same file already do it correctly, with a comment
 * explaining why.
 */
describe("no workflow interpolates untrusted input into a shell body", () => {
    const FILES = [
        "build-binaries.yml", "build-docker.yml", "publish-docker.yml", "create_release.yml",
        "finalize-release.yml", "build-msi.yml", "deploy_docker_dev.yml", "test.yml",
        "merge-dependabot.yml"
    ];

    // The classic injection carriers: a dispatch input, and the parts of an
    // event payload a stranger can write.
    const UNTRUSTED = /\$\{\{\s*(inputs\.|github\.event\.(pull_request|issue|comment|head_commit)\b)/;

    // Every `run:` block, whether folded or inline.
    const runBodies = (source) => {
        const bodies = [];
        const lines = source.split("\n");

        for (let index = 0; index < lines.length; index++) {
            const match = /^(\s*)(?:- )?run:\s*(\|-?|>-?)?\s*(.*)$/.exec(lines[index]);
            if (!match) continue;

            const [, indent, block, inline] = match;
            if (!block) {
                bodies.push(inline);
                continue;
            }

            for (let next = index + 1; next < lines.length; next++) {
                if (lines[next].trim() !== "" && !lines[next].startsWith(indent + "  ")) break;
                bodies.push(lines[next]);
            }
        }

        return bodies;
    };

    for (const file of FILES) {
        it(`${file} keeps it out of every run: body`, () => {
            const offending = runBodies(withoutHashComments(readSource(`.github/workflows/${file}`)))
                .filter((line) => UNTRUSTED.test(line))
                .map((line) => line.trim());

            assert.deepEqual(offending, [],
                "this value is substituted into the shell source before bash parses it; pass it through env: instead");
        });
    }
});

/**
 * And the client is compiled before a release exists, not after.
 *
 * Nothing else in the test workflow builds it. The suite reads the client's
 * modules as text - node cannot parse JSX - and lint parses each file on its
 * own, so neither resolves an import: a component importing a sibling whose
 * filename differs only in case builds on a case-insensitive filesystem and
 * fails on CI, and the failure names the service worker rather than the import
 * that caused it.
 *
 * Until this step existed the only workflow that compiled the client was
 * build-binaries, which runs on `release` - so the first build of the thing
 * every user installs happened after the release was already published.
 */
describe("CI compiles the client", () => {
    const tests = withoutHashComments(readSource(".github/workflows/test.yml"));

    it("builds it", () => {
        assert.match(tests, /working-directory: client\r?\n\s*run: bun run build/,
            "no job compiles the client, so a build-only failure is first seen by whoever installs it");
    });

    // After the suite: the tests are the cheaper signal and the one that says
    // more about a failure, so they should be what fails first.
    it("does so after the tests have run", () => {
        assert.ok(tests.indexOf("npm run test:all") < tests.indexOf("run: bun run build"),
            "the build runs before the suite, so a broken test is reported as a broken build");
    });

    /**
     * And the embed generator runs on what was built, for the same reason the
     * build itself does: it was the one build step left that only ran on
     * `release`, so a generator defect - a new asset type it refuses, an
     * output tree it cannot walk - was first seen while publishing, by the
     * workflow that cannot merge a fix.
     */
    it("packages the build into the embed", () => {
        const embed = tests.indexOf("bun run generate-client-embed");

        assert.notEqual(embed, -1,
            "no PR ever runs the embed generator, so its first run on a change is during the release");
        assert.ok(tests.indexOf("run: bun run build") < embed,
            "the embed step runs before the client is built, so it packages a stale or missing tree");
    });
});
