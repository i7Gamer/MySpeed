import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource, runBodies, withoutHashComments } from "../helpers/source.js";
import {parse} from 'yaml';

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
 * its comment gives the reason: a green compile says nothing about whether the
 * binary runs. MySpeed-linux-x64-baseline is now a compatibility alias for the
 * same qualified runtime, but it remains an independently built release asset
 * that install.sh selects on x86_64 hosts without the avx2 flag.
 *
 * Both names therefore have to be executed before upload; an alias name is not
 * evidence that the independently compiled bytes are sound.
 *
 * The shared Node/Bun verifier also runs on ARM, without a PowerShell exemption.
 */
describe("the Linux binaries are proven to boot", () => {
    const linux = jobOf("build-linux");

    it("verifies before uploading, as the Windows job does", () => {
        const verify = linux.indexOf("verify-standalone.mjs");
        const upload = linux.indexOf("Upload verified build");

        assert.notEqual(verify, -1, "the Linux binaries are uploaded without ever having been run");
        assert.ok(verify < upload,
            "the binary is uploaded before it is verified, so the check gates nothing");
    });

    it("verifies the artifact by the name it was renamed to", () => {
        const rename = linux.indexOf("Rename binary");
        const verify = linux.indexOf("verify-standalone.mjs");

        assert.ok(rename < verify, "the check runs against a file the rename has already moved");
    });

    it("says per leg whether it is verified, rather than leaving it implied", () => {
        const flags = [...linux.matchAll(/verify:\s*(true|false)/g)].map(([, value]) => value);

        assert.equal(flags.length, 3, "every Linux leg has to state whether it is verified");
        assert.deepEqual(flags, ['true', 'true', 'true'],
            "every native Linux leg, including ARM, must be verified");
    });

    it("runs the architecture-independent check unconditionally", () => {
        const check = parse(workflow).jobs['build-linux'].steps
            .find(step => step.name === 'Verify binary boots and serves');
        assert.ok(check);
        assert.equal(check.if, undefined);
        assert.match(check.run, /verify-standalone\.mjs/);
        assert.match(readSource('scripts/qualification/verify-standalone.mjs'), /'--network', 'none'/);
    });
});

/**
 * macOS was the platform shipping binaries nobody had started.
 *
 * Windows and Linux both boot theirs between the compile and the upload. This
 * job went compile -> rename -> release, so every fault that shows at startup
 * rather than at compile time reached users first - and it had one waiting.
 *
 * Both architectures were built on one runner, and `macos-latest` is arm64.
 * @resvg/resvg-js resolves a platform-specific .node at require time and ships
 * its bindings as optionalDependencies keyed by os/cpu, so an install on that
 * runner fetches darwin-arm64 and skips darwin-x64 - and MySpeed-macos-x64 was
 * compiled against a binding that had never been on the disk. Nothing in the
 * build could notice: the compiler is happy, and the resolution it would have
 * failed on happens at startup.
 *
 * A runner per architecture is the fix twice over. It puts each target's own
 * bindings on the machine that builds it, and it is what lets the leg be
 * verified at all - a binary can only be booted on the architecture it is for,
 * so a cross-compiled artifact is one no check on that runner could have run.
 */
describe("the macOS binaries are proven to boot", () => {
    const macos = jobOf("build-macos");

    it("verifies before uploading, as the Windows and Linux jobs do", () => {
        const verify = macos.indexOf("verify-binary.ps1");
        const upload = macos.indexOf("Upload verified build");

        assert.notEqual(verify, -1, "the macOS binaries are uploaded without ever having been run");
        assert.ok(verify < upload, "the binary is uploaded before it is verified, so the check gates nothing");
    });

    it("verifies the artifact by the name it was renamed to", () => {
        assert.ok(macos.indexOf("Rename binary") < macos.indexOf("verify-binary.ps1"),
            "the check runs against a file the rename has already moved");
    });

    it("builds each architecture on a runner of that architecture", () => {
        assert.match(macos, /runs-on:\s*\$\{\{\s*matrix\.runner\s*\}\}/,
            "both macOS targets are pinned to one runner again, so one of them is cross-compiled");

        const runners = [...macos.matchAll(/runner:\s*(\S+)/g)].map(([, value]) => value);

        assert.equal(runners.length, 2, "every macOS leg has to name the runner it builds on");
        assert.equal(new Set(runners).size, 2,
            "both legs build on the same runner, so the native addons of one of them are absent");
    });

    it("says per leg whether it is verified, rather than leaving it implied", () => {
        const flags = [...macos.matchAll(/verify:\s*(true|false)/g)].map(([, value]) => value);

        assert.deepEqual(flags, ["true", "true"],
            "a macOS leg that is not verified has to say so, and say why in the matrix comment");
    });

    it("only runs the check on the legs that declare it", () => {
        assert.match(macos, /if:\s*\$\{\{\s*matrix\.verify\s*\}\}/);
    });
});

/**
 * The rule the three jobs above are instances of, asserted once against all of
 * them: a leg that produces a release asset either boots it first or is one of
 * the legs known not to be able to.
 *
 * Linux uses an architecture-independent checker. Windows and macOS still
 * require native runtime evidence beyond their listener-free rehearsal.
 */
describe("every binary leg", () => {
    it("executes its artifact before qualification handoff", () => {
        const unverified = ["build-windows", "build-linux", "build-macos"].flatMap((name) => {
            const job = jobOf(name);
            const legs = [...job.matchAll(/artifact_name:\s*(\S+)/g)].map(([, value]) => value);
            const verified = /verify-binary\.ps1|verify-standalone\.mjs/.test(job);

            return legs
                .filter(() => !verified);
        });

        assert.deepEqual(unverified, [],
            "these artifacts are attached to a release without ever having been started");
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
        "finalize-release.yml", "build-msi.yml", "test.yml",
        "merge-dependabot.yml", "qualify-release.yml"
    ];

    // The classic injection carriers: a dispatch input, and the parts of an
    // event payload a stranger can write.
    const UNTRUSTED = /\$\{\{\s*(inputs\.|github\.event\.(pull_request|issue|comment|head_commit)\b)/;

    const splicedInto = (source) => runBodies(source)
        .flatMap(({lines}) => lines)
        .filter((line) => UNTRUSTED.test(line))
        .map((line) => line.trim());

    for (const file of FILES) {
        it(`${file} keeps it out of every run: body`, () => {
            assert.deepEqual(splicedInto(readSource(`.github/workflows/${file}`)), [],
                "this value is substituted into the shell source before bash parses it; pass it through env: instead");
        });
    }

    /**
     * And a `#` is not a hiding place, which is the one shape this scan could
     * not see.
     *
     * A block scalar is one string. The expression on a commented line is
     * substituted into it before bash reads the `#` in front of it, so the line
     * is a splice like any other - and a title carrying `"; curl … #` is exactly
     * the payload a pull request can write. The walk feeding this scan stripped
     * those lines as though they were YAML's own comments, so the carrier
     * nobody would think to look for came back clean.
     *
     * Asserted against a synthetic workflow rather than waiting for one in the
     * tree: the files above are correct today, so the loop passes either way,
     * which is the whole reason the gap survived.
     */
    it("sees one written as a shell comment inside a body", () => {
        const synthetic = [
            "jobs:",
            "  build:",
            "    steps:",
            "      - name: Build",
            "        run: |",
            "          # title: ${{ github.event.pull_request.title }}",
            "          echo building"
        ].join("\n");

        assert.deepEqual(splicedInto(synthetic),
            ["# title: ${{ github.event.pull_request.title }}"],
            "a comment inside a run body is stripped before the scan reads it, so an expression spliced into one is reported as clean");
    });
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

    /**
     * The suite runs under coverage, dealt across four runners: 444 files in
     * their own processes on four cores ran three minutes on one. The shard
     * goes in through NODE_OPTIONS, because node reads --test-shard only ahead
     * of the file globs and `npm run` can only append - appended, the flag is
     * taken for a file name and every shard runs everything, silently.
     */
    it("runs the whole suite under coverage, in shards", () => {
        assert.notEqual(tests.indexOf("run: npm run test:coverage"), -1, "no step runs the suite under coverage");
        assert.match(tests, /fail-fast: false\r?\n\s*matrix:\r?\n\s*shard: \[1, 2, 3, 4\]/,
            "the suite is not sharded, or a failing shard cancels the others");
        assert.match(tests, /NODE_OPTIONS: --test-shard=\$\{\{ matrix\.shard \}\}\/\$\{\{ strategy\.job-total \}\}/,
            "the shard is not handed to node through NODE_OPTIONS");
    });

    // Beside the shards rather than after them, in a job of its own: the two
    // were one job once, with the build after the suite so a broken test was
    // reported as a broken test - which a job per signal now says on its own.
    // Within that job lint goes first, for the same reason.
    it("lints before it builds", () => {
        const lint = tests.indexOf("run: npm run lint");
        const build = tests.indexOf("run: bun run build");
        assert.notEqual(lint, -1, "no step lints");
        assert.notEqual(build, -1, "no step builds the client");
        assert.ok(lint < build,
            "the build runs before lint, so a re-exported name that binds nothing is reported as a broken build");
    });

    /**
     * And the embed generator runs on what was built, for the same reason the
     * build itself does: it was the one build step left that only ran on
     * `release`, so a generator defect - a new asset type it refuses, an
     * output tree it cannot walk - was first seen while publishing, by the
     * workflow that cannot merge a fix.
     */
    it("packages the build into the embed", () => {
        const jobs = Object.values(parse(tests).jobs);
        const generators = jobs.filter(job => job.steps?.some(step => step.run?.includes('generate-client-embed')));
        assert.ok(generators.length, 'CI must exercise the actual client embed generator');
        for (const job of generators) {
            const commands = job.steps.map(step => step.run ?? '').join('\n');
            const build = commands.search(/\bbun(?: --cwd client)? run build\b/);
            const embed = commands.indexOf('bun run generate-client-embed');
            assert.ok(build >= 0 && build < embed, 'The job must build its own fresh client assets before embedding');
        }
    });
});
