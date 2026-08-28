import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withoutHashComments } from "../helpers/source.js";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const WORKFLOWS = path.join(ROOT, ".github", "workflows");

const read = (name) => fs.readFileSync(path.join(WORKFLOWS, name), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

const release = read("create_release.yml");
const msi = read("build-msi.yml");
const binaries = read("build-binaries.yml");
const finalize = read("finalize-release.yml");

/**
 * Every asset name a release uploads, read out of the workflows rather than
 * restated here. build-msi.yml counts too - it attaches installers to the same
 * release. The templated ones are the matrices expanding artifact_name and
 * asset_name, which are already collected literally.
 */
const uploadedAssets = () => {
    const names = [binaries, msi]
        .flatMap((workflow) => [...workflow.matchAll(/^\s*(?:artifact_name|asset_name|ASSET_NAME):\s*(\S+)\s*$/gm)])
        .map((match) => match[1])
        .filter((name) => !name.includes("${{"));

    assert.notEqual(names.length, 0, "no release assets could be read out of the build workflows");

    return [...new Set(names)];
};

// The pattern the dispatched version is validated against, taken from the
// workflow rather than restated here - a copy would go on passing after the
// real one was widened.
const validator = () => {
    const found = release.match(/grep -Eq '\^([^']+)\$'/);
    assert.notEqual(found, null, "the release workflow no longer validates the version it was given");

    return new RegExp(`^${found[1]}$`);
};

// What build-msi.yml makes of that version when it writes Product/@Version.
//
// Read through the environment rather than spliced from `${{ inputs.version }}`:
// no workflow expression reaches a script body anywhere in the release chain
// now, which binaryVerification.test.js holds the whole chain to.
const wixVersion = (version) => {
    const template = msi.match(/Version="\$\(\$env:VERSION\)([^"]*)"/);
    assert.notEqual(template, null, "the MSI no longer builds its product version from the release version");

    return version + template[1];
};

/**
 * finalize-release.yml writes the Downloads table every release page opens
 * with, and it names each file as a literal. Adding a build to the matrix
 * therefore uploads an asset that nothing links to: MySpeed-linux-x64-baseline
 * arrived reachable only by scrolling past the table into the raw asset list,
 * and it exists precisely for the people least likely to work out which of the
 * files they need.
 */
describe("the release body links every asset that is uploaded", () => {
    it("names each one in the Downloads table", () => {
        const unlinked = uploadedAssets().filter((asset) => !finalize.includes(asset));

        assert.deepEqual(unlinked, [],
            "these are uploaded by the build workflows and linked nowhere in the release body");
    });
});

/**
 * What `bun build --compile` is given, reduced to the flags that decide what
 * ends up inside the executable. The target and the output name are what the
 * two callers legitimately differ on, so they are dropped before comparing.
 */
const compileFlags = (command) => {
    // `${{ matrix.target }}` holds a space, so it has to stop being an
    // expression before the command can be split on whitespace at all.
    const tokens = command.replace(/\$\{\{[^}]*\}\}/g, "TEMPLATE").trim().split(/\s+/);
    const flags = [];

    for (let index = 0; index < tokens.length; index++) {
        if (tokens[index].startsWith("--target")) continue;
        // --outfile carries its value as the next argument.
        if (tokens[index] === "--outfile") index++;
        else flags.push(tokens[index]);
    }

    return flags;
};

/**
 * package.json's build:binary scripts and the workflow's compile step are the
 * same command written out twice. `--external pg` and `--external pg-hstore`
 * are the load-bearing part: without them the compile pulls in drivers this
 * build does not ship, and the difference does not surface until the binary
 * runs. build:binary:baseline exists so someone on a non-AVX2 CPU can build
 * their own until a release carries one - which is worth nothing if what they
 * build is not what the release would have given them.
 */
describe("a locally built binary is compiled like the released one", () => {
    const workflowCompile = () => {
        const found = binaries.match(/run: (bun build --compile[^\n]*--target=\$\{\{ matrix\.target \}\}[^\n]*)/);
        assert.notEqual(found, null, "the Linux compile step is no longer a bun build this can read");

        return found[1];
    };

    for (const script of ["build:binary", "build:binary:baseline"]) {
        it(`${script} passes the same flags as the workflow`, () => {
            const found = pkg.scripts[script].match(/bun build --compile.*/);
            assert.notEqual(found, null, `${script} no longer compiles with bun build`);

            assert.deepEqual(compileFlags(found[0]), compileFlags(workflowCompile()),
                `${script} and build-binaries.yml no longer produce the same executable`);
        });
    }
});

/**
 * The version is validated once, at the first step, and everything downstream
 * trusts it - so it has to be validated against what the whole pipeline can
 * actually deliver, not against semver in general.
 *
 * It was not. The pattern admitted an optional suffix group, so `1.4.0-rc.1` and
 * `1.4.0.1` both passed, and build-msi.yml splices the version straight into
 * WiX's Product/@Version as `<version>.0` - which must be numeric dotted fields.
 * candle then refused it. By that point create-release has already pushed the
 * tag and the draft, build-binaries has uploaded every asset, and build-docker
 * has pushed `:latest` and `:<version>` to Docker Hub. The MSI job fails,
 * finalize-release is skipped, and cleanup-on-failure deliberately does not fire
 * - leaving `:latest` on Docker Hub silently replaced by a release candidate,
 * which is the part no rollback here undoes.
 *
 * Latent rather than live: every tag in the repo is plain three-part semver, so
 * this waits for the first time someone types a suffixed version. The fix is to
 * refuse it at the step before anything has been published.
 */
describe("the version a release may be dispatched with", () => {
    it("accepts the shape every release so far has used", () => {
        for (const version of ["1.0.3", "1.2.5", "1.3.0", "2.0.0", "10.20.30"])
            assert.match(version, validator(), `${version} is the shape this project actually releases`);
    });

    /**
     * A prerelease suffix is the case worth naming: WiX cannot express it, and
     * `:latest` is hardcoded in the docker tags, so a release candidate that got
     * this far would take over the tag every `docker pull myspeed` resolves to.
     */
    it("refuses a version the MSI cannot express", () => {
        for (const version of ["1.4.0-rc.1", "1.4.0-beta", "1.4.0-beta.2", "1.4.0.1", "1.4.0.1.2"])
            assert.doesNotMatch(version, validator(),
                `${version} passes validation and then fails candle, after the tag and the images are published`);
    });

    it("refuses what is not a version at all", () => {
        for (const version of ["1.4", "1", "", "v1.4.0", "latest", "1.4.0 ", "01.4.0-"])
            assert.doesNotMatch(version, validator(), `${version} should not start a release`);
    });

    /**
     * The property that ties the two together: everything the validator admits
     * has to survive the splice into Product/@Version. Asserted over the
     * accepted shapes rather than over one hardcoded string, so widening the
     * pattern without widening what WiX accepts fails here first.
     */
    it("yields a product version WiX can parse for everything it accepts", () => {
        for (const version of ["1.0.3", "1.3.0", "10.20.30"]) {
            const fields = wixVersion(version).split(".");

            assert.equal(fields.length, 4, `${wixVersion(version)} is not four dotted fields`);
            for (const field of fields)
                assert.match(field, /^[0-9]+$/, `"${field}" in ${wixVersion(version)} is not numeric`);
        }
    });

    // The leading v is stripped before anything downstream sees it, so the MSI
    // never receives one - build-msi takes create-release's normalised output.
    it("passes the normalised version on to the MSI", () => {
        // RAW_VERSION, not VERSION: the dispatch input arrives through env: so
        // that it is never substituted into the shell source before bash parses
        // it. The stripping itself is unchanged.
        assert.match(release, /VERSION="\$\{RAW_VERSION#v}"/,
            "a dispatched 'v1.4.0' keeps its prefix");
        assert.match(release, /version: \$\{\{ needs\.create-release\.outputs\.version }}/,
            "the MSI is handed the raw dispatch input rather than the validated one");
    });
});

/**
 * The other value the first step of a release compares, on the same terms.
 *
 * Dispatch carries no branch restriction, so the guard that refuses a release
 * from a feature branch is what stops a run pushing that branch's HEAD onto the
 * default one - and it read the ref by splicing `${{ github.ref_name }}` into
 * its own shell body. A workflow expression is substituted into the source
 * before bash parses it, and git refnames admit `"`, `;`, backticks and `$()`:
 * a branch named to carry any of those turns the guard into a command of the
 * attacker's choosing, in a job holding contents: write.
 *
 * The same file already states the rule ten lines below, beside the dispatch
 * input, and the cleanup jobs at the bottom follow it. This is the step that did
 * not - and it is the one step that runs before checkout, which is to say the
 * one that exists to stop everything after it.
 *
 * Comments stripped first, or the sentence in the workflow explaining why `${{`
 * must not appear in a run body is itself found by the assertion looking for it.
 */
describe("the branch a release may be dispatched from", () => {
    const steps = withoutHashComments(release);

    // The guard step, bounded by the step that follows it.
    const guard = (() => {
        const at = steps.indexOf("- name: Refuse to release from a non-default branch");
        assert.notEqual(at, -1, "nothing refuses a release dispatched from a feature branch");

        const next = steps.indexOf("\n      - name:", at);
        return steps.slice(at, next === -1 ? steps.length : next);
    })();

    const body = () => {
        const at = guard.indexOf("run:");
        assert.notEqual(at, -1, "the guard step runs nothing");

        return guard.slice(at);
    };

    /**
     * Position is half of what the guard is worth: actions/checkout writes a
     * contents:write token into .git/config, so a refusal after it has already
     * handed the token over is a refusal in name only.
     */
    it("refuses before the checkout hands a write token to the workspace", () => {
        assert.ok(steps.indexOf("- name: Refuse to release from a non-default branch")
            < steps.indexOf("- name: Checkout project"),
            "the branch is checked after the token is already in .git/config");
    });

    it("interpolates no workflow expression into its shell body", () => {
        assert.doesNotMatch(body(), /\$\{\{/,
            "the ref reaches bash as source rather than as data, so a branch named `\"; curl … #` runs inside a job that can push to the default branch");
    });

    it("compares the two names it binds through env", () => {
        const bound = [...guard.slice(0, guard.indexOf("run:")).matchAll(/^\s+([A-Z][A-Z0-9_]*):\s*\$\{\{/gm)]
            .map((match) => match[1]);

        assert.deepEqual(bound.length, 2,
            `the step binds ${bound.length} values through env:, where the ref and the branch it is compared against are two`);

        for (const name of bound)
            assert.match(body(), new RegExp(`\\$\\{?${name}\\b`),
                `${name} is bound through env: and never read, so the comparison is made against something else`);
    });

    /**
     * The push step obeys the same rule. It splices the version into a commit
     * message and the default branch into the ref it pushes to - the identical
     * shape the guard above was fixed for, one step further down, in the one
     * step that actually performs the push the guard exists to protect.
     */
    it("pushes through env-bound names, never spliced ones", () => {
        const at = steps.indexOf("- name: Commit and push version bump");
        assert.notEqual(at, -1, "the version bump is no longer pushed by a step this can find");

        const next = steps.indexOf("\n      - name:", at);
        const step = steps.slice(at, next === -1 ? steps.length : next);

        assert.doesNotMatch(step.slice(step.indexOf("run:")), /\$\{\{/,
            "a workflow expression reaches the push's shell as source rather than as data");
    });
});
