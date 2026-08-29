import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBodies, withoutHashComments } from "../helpers/source.js";

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
// Read through the environment rather than spliced from `${{ inputs.version }}`.
// That is the rule create_release.yml keeps completely - no workflow expression
// reaches a run: body in it at all, which the last block in this file holds it to
// - and the rule binaryVerification.test.js holds the rest of the chain to for
// the expressions a stranger is in a position to write.
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

/**
 * And the same rule over the whole file, rather than one step at a time.
 *
 * Two steps were pinned individually - the branch guard and the push - and three
 * splices sat between and below them the whole time: the version into
 * `V="${{ steps.get_version.outputs.version }}"`, and the tag and the resolved
 * commit into the `git tag` and `git push` that cut the release. Nothing was
 * looking at them. binaryVerification.test.js holds every workflow in the chain
 * to keeping *untrusted* expressions out of a run: body, and its pattern names
 * `inputs.` and the writable parts of an event payload - a step output is
 * neither.
 *
 * Which is why binding them is uniformity and not urgency: get_version refuses
 * anything that is not three numeric parts before any of the three exists, and
 * the sha comes from `git rev-parse`. But a rule with three exceptions in the
 * very file that states it is a rule no one can check by reading, and the
 * exceptions were in the job holding contents: write - one of them the step that
 * pushes the tag the branch guard exists to protect. So none of them, and the
 * file is held to that rather than to a list of steps somebody remembered.
 *
 * Comments stripped first, or the two sentences in the workflow explaining why
 * `${{` must not appear in a run body are themselves found by the assertion
 * looking for it.
 */
describe("what reaches a shell in the release workflow", () => {
    it("interpolates no workflow expression into any shell body", () => {
        const bodies = runBodies(release);

        // Or the assertion below is made against nothing at all. The deepest
        // body in the file is the one that pushes the tag; reading it is what
        // says the walk got past the first step.
        assert.ok(bodies.some(({text}) => text.includes("git push origin")),
            "no run: body could be read out of the workflow, so this asserts nothing");

        const spliced = bodies
            .filter(({text}) => text.includes("${{"))
            .map(({lines}) => lines.find((line) => line.includes("${{")).trim());

        assert.deepEqual(spliced, [],
            "these are substituted into the shell source before bash parses them; bind them through env: and read the shell variable instead");
    });

    /**
     * And the same rule for the other interpreter these bodies start.
     *
     * The bump step binds the version through env: exactly as the rule says, and
     * then writes `jq ".version = \"$VERSION\"" package.json` - so the shell
     * expands the variable before jq is executed at all, and what jq parses is a
     * program built out of the value. The care taken one line earlier buys
     * nothing: the language changed, and the rule was kept for bash only.
     *
     * Not live, and that is the point. get_version refuses anything that is not
     * three numeric parts before this step exists, so there is nothing a version
     * can carry by the time it arrives. But the rule is *stated* in this file -
     * twice, in prose, above the steps that follow it - and a rule dropped at the
     * next interpreter on the same line is one nobody can check by reading. jq's
     * --arg binds a value as data, which is what env: does for the shell.
     *
     * The question this asks of a line, in one sentence: does the shell build
     * the program jq runs?
     *
     * Which is a question about quoting, and nothing else. `'.version = $v'` is
     * handed to jq exactly as written, `$v` and all, because single quotes are
     * inert - the `$v` jq reads is jq's own variable, the one --arg bound.
     * `".version = \"$VERSION\""` is not: the shell expands $VERSION and jq is
     * handed whatever it held. So the rule is *not* "does the call bind a value
     * with --arg" - a call can bind one value and splice another on the same
     * line, and did in the version of this scan that asked that - it is "is the
     * program token one the shell expands".
     *
     * Answering that needs the line read the way the shell reads it, so the
     * three helpers below are one tokeniser, one call reader, and one predicate,
     * rather than a regex per defect. The regexes that stood here each answered
     * a piece of it and each was wrong somewhere else: `\bjq\b` split a program
     * that names jq into two calls, `"[^"]*"` ended a string at an escaped
     * quote, and a `#` was a comment only when it began the line.
     */

    /**
     * Characters that end a word and stand on their own.
     *
     * They are what says where one command stops and the next begins, which is
     * the whole of what command position means below. `<` and `>` are here for
     * the other half of that job rather than for this one. A redirection does
     * not end a call - bash lets one stand anywhere in a simple command, so
     * things do stand behind one - but it has to arrive as words of its own
     * before the call reader can recognise one and read on past it. `2>&1` is
     * four of them.
     */
    const OPERATORS = new Set(["|", "&", ";", "(", ")", "`", "<", ">"]);

    /**
     * Words a command may stand behind while still being the command.
     *
     * `if`, `while`, `until`, `then`, `else`, `elif`, `do` and `{` are the
     * shell's own - the first three matter most, since their `then`/`do`
     * halves cannot be reached without them; `sudo`, `env`, `time`, `command`
     * and `xargs` run what follows them, `exec` replaces the shell with what
     * follows it and `nohup` runs it detached, and `!` negates it. Substitutions
     * need no entry here - `$(` and a backtick are operators, so the jq
     * inside one is already the first word of its own command. NAME=value
     * assignment prefixes are handled where the position is judged: the shell
     * strips any number of them before finding the command.
     */
    const COMMAND_PREFIXES = new Set([
        "if", "while", "until", "then", "else", "elif", "do", "{", "!",
        "sudo", "env", "time", "command", "xargs", "exec", "nohup"
    ]);

    // A NAME=value environment prefix, which stands before the command
    // without being it. Judged on the unquoted spelling: a fully
    // single-quoted 'NAME=v' is an argument (`literal` excludes it below),
    // and a shell name cannot be quoted anyway - the remaining
    // approximation, a fully double-quoted "NAME=v" read as a prefix, is a
    // line no workflow has a reason to write.
    const ASSIGNMENT_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=/;

    /**
     * Inside double quotes a backslash is only an escape before one of these.
     * Anywhere else it is a character of its own - `"C:\Users"` holds a
     * backslash, not an escaped U - and reading it as an escape would swallow
     * the character behind it.
     */
    const DOUBLE_QUOTE_ESCAPES = new Set(["$", "`", "\"", "\\"]);

    /**
     * The flags whose value is the token after them, which is exactly what
     * stands between `jq` and its program on the lines this is about.
     *
     * Two apiece for the five that bind a jq variable - the name, then the
     * value bound to it - and one apiece for the three that carry a plain
     * value: `-f` and its long form name the file the program is read from,
     * `--indent` a column count, `-L` a module directory. Everything else jq
     * takes is a switch. `--args` and `--jsonargs` are deliberately absent:
     * they consume no token of their own, they change what the *remaining*
     * positional arguments mean.
     *
     * Leaving one out is not a gap in a corner. Its value is read as the
     * program instead, so `--indent 2` makes the program `2` - which is not a
     * program the shell expands, and so excuses whatever was really written
     * behind it. `--argfile` was the one missing, and it is the deprecated
     * spelling of exactly the flag this rule tells people to reach for.
     */
    const FLAG_ARITY = new Map([
        ["--arg", 2], ["--argjson", 2], ["--slurpfile", 2], ["--rawfile", 2], ["--argfile", 2],
        ["-f", 1], ["--from-file", 1], ["--indent", 1], ["-L", 1]
    ]);

    // The subset that binds its value to a jq variable, which is what the
    // liveness check below looks for: a program reading `$v` is reading data,
    // whichever of them put the value there.
    const BINDING_FLAGS = new Set(["--arg", "--argjson", "--slurpfile", "--rawfile", "--argfile"]);

    /**
     * One line of shell, as the words the shell would make of it.
     *
     * A word is not a quoted run and not a whitespace-delimited run: it is
     * whatever the quoting rules glue together, so `'.version = '"$VERSION"` is
     * one word built from two segments, and `.deps.jq` inside single quotes is
     * part of a word rather than a command. Each word comes back as
     *
     *   plain      - what the shell would hand the command, quotes removed
     *   expandable - whether any part of it outside single quotes carries an
     *                unescaped `$` or an unescaped backtick, either of which
     *                is the shell building the word before the command sees
     *                it - which is the whole predicate this file is
     *                about
     *   literal    - whether every character of it came from inside single
     *                quotes, which is the only way to be sure the shell did not
     *                touch it
     *
     * `expandable` is not `plain.includes("$")`: `".version = \$v"` holds a
     * dollar the shell removes the backslash from and expands nothing for, and
     * reporting that line would demand a change that changes nothing. A
     * backtick asks the same question of the older spelling of `$( )`:
     * unescaped inside double quotes it opens a substitution the shell runs
     * before the command is executed at all, escaped it is a character. `literal`
     * is not `!expandable` either - `".version = \$v"` is inert too, but it is
     * inert by an escape a later edit can drop, and the liveness check wants the
     * shape that cannot be broken that way.
     */
    const tokenise = (line) => {
        const tokens = [];
        let token = null;
        let quote = null;
        let commented = false;

        const open = () => {
            if (token === null) token = {plain: "", expandable: false, literal: true, operator: false};
            return token;
        };
        const add = (character, {expands = false, inert = false} = {}) => {
            open().plain += character;
            if (expands) token.expandable = true;
            if (!inert) token.literal = false;
        };
        const end = () => {
            if (token !== null) tokens.push(token);
            token = null;
        };

        for (let index = 0; index < line.length; index++) {
            const character = line[index];

            // Nothing is special inside single quotes, the closing one aside.
            if (quote === "'") {
                if (character === "'") quote = null;
                else add(character, {inert: true});
                continue;
            }

            if (character === "\\") {
                const escaped = line[index + 1];

                if (escaped === undefined || (quote === "\"" && !DOUBLE_QUOTE_ESCAPES.has(escaped))) {
                    add("\\");
                    continue;
                }

                // The character behind it is data, whatever it is: this is what
                // keeps `\$v` out of the report and `\"` from ending the string.
                add(escaped);
                index++;
                continue;
            }

            if (quote === "\"") {
                if (character === "\"") quote = null;
                else add(character, {expands: character === "$" || character === "`"});
                continue;
            }

            if (character === "'" || character === "\"") {
                open();
                quote = character;
                continue;
            }

            if (/\s/.test(character)) {
                end();
                continue;
            }

            // A comment, and the rest of the line with it - but only where a
            // word begins, because `a#b` is a word and `#` is a character of it.
            // Remembered as well as obeyed: whether the line ended in prose is
            // what continues() needs, and it is only decidable here, where the
            // quoting rules have already run.
            if (character === "#" && token === null) {
                commented = true;
                break;
            }

            if (OPERATORS.has(character)) {
                end();
                tokens.push({plain: character, expandable: false, literal: false, operator: true});
                continue;
            }

            add(character, {expands: character === "$"});
        }

        end();

        return {tokens, commented};
    };

    /**
     * A line the shell would read on into the next one.
     *
     * A backslash immediately before the newline is removed along with it, so a
     * call written across two lines is one call - and a scan that reads the two
     * halves separately finds a jq with no program on the first and no jq at all
     * on the second, which is a splice reported nowhere.
     *
     * An odd number of trailing backslashes, because `\\` is an escaped
     * backslash and ends nothing. Not inside a comment: a comment ends at the
     * newline whatever stands before it, and joining there would swallow the
     * line below into prose - which is why the question "did this line end in
     * a comment" is answered by the tokeniser, whose quoting rules already
     * decide it, rather than by a second pattern that knows only whole-line
     * comments. One approximation stays: a trailing backslash inside single
     * quotes is literal to bash and still joins here - the glue lands inside
     * a word, so a jq on the next line is scanned fused to it rather than
     * missed, which is the direction that merely risks noise.
     */
    const CONTINUES = /(^|[^\\])(\\\\)*\\$/;

    const continues = (line) => !tokenise(line).commented && CONTINUES.test(line);

    const joinContinued = (lines) => lines.reduce((joined, line) => {
        const previous = joined[joined.length - 1];

        if (previous !== undefined && continues(previous)) joined[joined.length - 1] = previous.slice(0, -1) + line;
        else joined.push(line);

        return joined;
    }, []);

    // The two characters a redirection opens with, and the shape of a file
    // descriptor written in front of one.
    const REDIRECTIONS = new Set(["<", ">"]);
    const FILE_DESCRIPTOR = /^[0-9]+$/;

    /**
     * One redirection standing inside a call, answered as the index behind it -
     * or as the index it was asked about, when there is no redirection there.
     *
     * Its shape is `[fd] ('<'|'>')+ ['&'] [target]`, which is the whole of what
     * these lines write. Each `<` and `>` is a token of its own, so `>>` arrives
     * as two and the run is collapsed; `2>&1` puts a file descriptor in front
     * and another behind an `&`, and that `&` is the one place a call does not
     * end at one.
     *
     * A digit-only word standing before a redirect operator is read as the
     * file descriptor - whether or not whitespace separated them, because the
     * tokeniser keeps no positions. That sacrifices `jq 2 > tmp`, whose
     * literal 2-as-argument reading is folded into the redirect; accepted,
     * since a bare digit is no jq program anyone writes, and a digit program
     * is never expandable, so no splice verdict can turn on the difference.
     *
     * Two of the bounds here are wider than any verdict can observe, and are
     * said so rather than dressed as load-bearing. The `while` over the
     * operator run reads `>>` as one redirection; collapsed to a single step,
     * the caller re-enters at the second `>` and reads a second redirection -
     * same tokens consumed, every verdict identical - so the loop is the
     * honest SHAPE, not a difference in behaviour. And of the target word's
     * two conditions, only the undefined half is observable: a redirect at
     * the very end of a line would otherwise read `.operator` off the end of
     * the array and throw (the trailing-redirect row pins that). The
     * `!operator` half IS reachable - `>|`, bash's noclobber override, and a
     * `>(…)` process substitution both put an operator in target position -
     * but callsIn visits every jq token no matter how a neighbour's call was
     * read, so where the target word ends one call cannot hide another, and
     * no verdict turns on the branch either way.
     */
    const readRedirection = (tokens, from) => {
        const operator = (at) => tokens[at] !== undefined && tokens[at].operator;
        const opens = (at) => operator(at) && REDIRECTIONS.has(tokens[at].plain);

        let index = from;

        if (tokens[index] !== undefined && !tokens[index].operator
            && FILE_DESCRIPTOR.test(tokens[index].plain) && opens(index + 1)) index++;

        if (!opens(index)) return from;

        while (opens(index)) index++;

        // `2>&1`: the descriptor behind the `&` belongs to the redirection,
        // rather than being the background operator a call ends at.
        if (operator(index) && tokens[index].plain === "&") index++;

        // The file it names, where one was written.
        if (tokens[index] !== undefined && !tokens[index].operator) index++;

        return index;
    };

    /**
     * One jq call, from the word `jq` to the end of its arguments: the flags it
     * was given, and the program it was handed.
     *
     * The program is the first word that is neither a flag nor a flag's value,
     * and the call ends at the first operator - a pipe, a semicolon, a closing
     * paren - because nothing behind one of those is jq's. A redirection is not
     * one of those: `jq > tmp '.x = $v'` hands jq the same program as
     * `jq '.x = $v' > tmp` does, so the redirect and the file it names are
     * consumed and the reading goes on behind them. Flags are collected
     * past the program as well: a value bound after the program it belongs to is
     * still bound, and the liveness check has no reason to care where it stands.
     */
    const readCall = (tokens, from) => {
        const flags = [];
        let program = null;

        for (let index = from + 1; index < tokens.length; index++) {
            const behind = readRedirection(tokens, index);

            // A redirection is part of the call without being an argument of
            // it, so the reading carries on behind the file it names rather
            // than stopping at the operator that opened it.
            if (behind !== index) {
                index = behind - 1;
                continue;
            }

            if (tokens[index].operator) break;

            const consumed = FLAG_ARITY.get(tokens[index].plain);

            if (consumed !== undefined) {
                flags.push(tokens[index].plain);
                index += consumed;
            } else if (tokens[index].plain.startsWith("-")) flags.push(tokens[index].plain);
            else if (program === null) program = tokens[index];
        }

        return {flags, program};
    };

    /**
     * Every jq call on a line - which is every word that *is* jq, standing where
     * a command can stand.
     *
     * Both halves matter. `jq` has to be the whole word, or `.deps.jq` in a
     * program and `bump.jq` after `-f` each start a call that was never written;
     * and it has to be in command position, or the jq in `apt-get install -y jq`
     * is read as one, with the package behind it for a program. A path counts -
     * `/usr/bin/jq` is the same command - and so does the second half of a
     * pipeline, which is where the writing usually happens.
     */
    /**
     * The flags of the prefix commands that take a value as their next word.
     *
     * `sudo -u root jq …` runs jq: the walk back from jq has to step over the
     * flag AND its value, or `root` stands where the command is looked for
     * and the jq behind it reads as an argument. One flat set across the
     * prefixes, of the spellings a workflow plausibly writes; a value-taking
     * flag not named here leaves its value read as the command - a missed
     * call, the direction this set exists to close, so extend it when a
     * workflow writes one. The flat set's usual cost is noise, not blindness
     * - `xargs -a jq …` names a FILE jq, and reads here as a call - with one
     * carved-out blind corner: an UNLISTED prefix whose value-flag's value is
     * itself a listed word (`foo -u sudo jq …`, quoted or bare) skips two
     * onto `foo` and drops the call, a line no workflow has a reason to
     * write. One structure carries both jobs - the walk asks the keys, and
     * each key maps to the prefix it is real on, from which the matrix below
     * generates a row per flag in both value spellings - so a flag cannot be
     * in the walk and out of the matrix, and a typo or a trimmed map goes
     * red in the generated rows instead of quietly narrowing the walk.
     */
    const VALUE_TAKING_PREFIX_FLAGS = new Map([
        ["-u", "sudo"], ["-g", "sudo"], ["-a", "exec"],
        ["-n", "xargs"], ["-I", "xargs"], ["-L", "xargs"], ["-P", "xargs"],
        ["-s", "xargs"], ["-d", "xargs"], ["-E", "xargs"]
    ]);

    const callsIn = (line) => {
        const {tokens} = tokenise(line);
        const calls = [];

        for (let index = 0; index < tokens.length; index++) {
            const token = tokens[index];
            if (token.operator || !(token.plain === "jq" || token.plain.endsWith("/jq"))) continue;

            // Walk back over what may stand between a command and the start
            // of its simple command: NAME=value assignments, a prefix's
            // flags, and the values those flags consume. One guarded loop,
            // stopped by operators, so a pipe or a semicolon is never
            // crossed - an unbounded skip once walked `sort -u | jq …` onto
            // the LEFT command and dropped the call. Literal-ness is judged
            // per branch rather than at the loop's gate: an assignment or a
            // flag must be unquoted to mean anything to the shell, but the
            // VALUE a flag consumes may be quoted - `sudo -u 'root' jq …`
            // runs jq exactly as the bare spelling does, and a gate on the
            // quoted word left that call unwalked and its splice unreported.
            let at = index - 1;
            while (at >= 0 && !tokens[at].operator) {
                if (!tokens[at].literal && ASSIGNMENT_PREFIX.test(tokens[at].plain)) { at--; continue; }
                if (!tokens[at].literal && tokens[at].plain.startsWith("-")) { at--; continue; }
                if (at >= 1 && !tokens[at - 1].operator && !tokens[at - 1].literal
                    && VALUE_TAKING_PREFIX_FLAGS.has(tokens[at - 1].plain)) { at -= 2; continue; }
                break;
            }

            const before = tokens[at];
            if (at >= 0 && !before.operator && !COMMAND_PREFIXES.has(before.plain)) continue;

            calls.push(readCall(tokens, index));
        }

        return calls;
    };

    // Every line a body actually runs, continuations joined within the body they
    // were written in.
    const shellLines = (source) => runBodies(source).flatMap(({lines}) => joinContinued(lines));

    /**
     * The lines this rule reports: a jq whose program the shell builds.
     *
     * Nothing about --arg. A call that binds a value and splices another is
     * still splicing, and exempting it was how `jq --arg v "$V" ".version =
     * \"$VERSION\""` passed - the fix applied to one value and not to the one
     * beside it.
     */
    const splices = (source) => shellLines(source)
        .filter((line) => callsIn(line).some(({program}) => program !== null && program.expandable))
        .map((line) => line.trim());

    /**
     * And the shape it asks for, so that deleting the rewrite fails here rather
     * than passing quietly: a call that binds a value as data and hands jq a
     * program in single quotes, which the shell cannot have touched.
     *
     * The programs themselves rather than the lines holding them, because that
     * is what the assertions have questions about. A commented-out copy cannot
     * satisfy this - the tokeniser stops at the `#` - which is the point: the
     * check that something still rewrites the version was satisfied by a comment
     * describing a write that had been deleted.
     */
    const boundWrites = (source) => shellLines(source)
        .flatMap((line) => callsIn(line))
        .filter(({flags, program}) => flags.some((flag) => BINDING_FLAGS.has(flag))
            && program !== null && program.literal && program.plain.includes(".version"))
        .map(({program}) => program.plain);

    /**
     * The whole of what this rule answers, written as cases rather than as a
     * handful of examples somebody added the day a defect was found.
     *
     * Every row is one line a run: body could hold, spliced into the real
     * workflow and judged there - so each row also proves the walk reaches an
     * added step, which is what stops the rows expecting nothing from passing
     * because the fixture was never read at all.
     */
    const splice = (name, ...shell) => [
        release,
        `      - name: ${name}`,
        "        run: |",
        ...shell.map((line) => `          ${line}`)
    ].join("\n");

    // Whether the walk reached every line of a row's fixture. Raw body lines,
    // not joined ones: this asks whether the fixture arrived, not what the rule
    // makes of it.
    const walked = (source, shell) => {
        const lines = runBodies(source).flatMap(({lines}) => lines).map((line) => line.trim());

        return shell.every((line) => lines.includes(line.trim()));
    };

    /**
     * The lines this rule has nothing to say about.
     *
     * Half of them are the shapes it is *for* - a value bound with --arg and a
     * program in single quotes, which the shell hands to jq untouched - and the
     * other half are lines that merely name jq. Both directions matter equally:
     * a rule that reports a correct line is one somebody silences, and every
     * one of these was reported by some version of this scan.
     */
    const INERT = [
        {
            name: "the write the workflow performs",
            shell: ["jq --arg v \"$VERSION\" '.version = $v' package.json > tmp && mv tmp package.json"],
            why: "the shape this rule exists to ask for is reported as the thing it is the fix for"
        },
        {
            name: "a read whose file is named by a variable",
            shell: ["jq -r '.version' \"$FILE\""],
            why: "-r is a switch and takes no value of its own; given one it swallows the program, and the file named behind it is read as the program instead"
        },
        {
            name: "a read whose output is redirected behind the program",
            shell: ["jq -r .version package.json > tmp"],
            why: "a redirect standing behind the program is read as something jq was handed, which would report the shape most of these lines are written in"
        },
        {
            name: "a jq that only reads",
            shell: ["jq -r .version package.json"],
            why: "a read is told to bind its value with --arg, which is advice for a program that assigns nothing"
        },
        {
            name: "a jq variable escaped past the shell",
            shell: ["jq --arg v \"$V\" \".version = \\$v\""],
            why: "the shell does not expand \\$, so what jq parses is the variable --arg bound - reporting it demands a change that changes nothing"
        },
        {
            name: "a backtick escaped past the shell",
            shell: ["jq \".version = \\`cat VERSION\\`\" package.json"],
            why: "an escaped backtick is a backtick and nothing else - the shell hands jq the character and runs no command for it, so reporting the line demands a change that changes nothing"
        },
        {
            name: "a program naming jq inside itself",
            shell: ["jq --arg v \"$V\" '.deps.jq = $v' package.json"],
            why: "the word jq inside the program starts a second call that was never on the line"
        },
        {
            name: "a program read from a file",
            shell: ["jq -f bump.jq package.json > tmp"],
            why: "the program is in a file this cannot read, and the path is not it"
        },
        {
            name: "a program file named by a shell variable",
            shell: ["jq -f \"$BUMP\" package.json > tmp"],
            why: "-f's value is read as the program, so a path holding a shell variable is reported as a splice"
        },
        {
            name: "jq called by its full path",
            shell: ["/usr/bin/jq '.x = $v' --arg v \"$V\" package.json"],
            why: "a call written as a path is either missed entirely or read from the wrong token"
        },
        {
            name: "an echo that mentions jq",
            shell: ["echo \"bumped with jq $VERSION\""],
            why: "a quoted mention of jq is read as a call, and the rest of the message as its program"
        },
        {
            name: "jq named as an argument to something else",
            shell: ["apt-get install -y jq $EXTRA_TOOLS"],
            why: "jq standing where a command cannot is read as one, and whatever follows it as its program"
        },
        {
            name: "a call commented out behind a real command",
            shell: ["npm ci # jq \".v=\\\"$V\\\"\" package.json"],
            why: "a line nothing runs is reported as a splice, so the fix offered for it is to delete a comment"
        },
        {
            name: "a comment carrying a separator and a call behind it",
            shell: ["npm ci # bump; jq \".v = \\\"$V\\\"\" package.json"],
            why: "a `#` where a word begins ends the line, and a line read on past one reports a call the shell never runs - the `;` in front of this one is what puts it in command position, which is the reason the two rows above cannot notice the same mistake"
        },
        {
            name: "a call on a line that is nothing but a comment",
            shell: ["# jq \".v=\\\"$V\\\"\" package.json"],
            why: "a line nothing runs is reported as a splice, so the fix offered for it is to delete a comment"
        },
        {
            name: "a redirect whose target the shell builds",
            shell: ["jq > \"tmp.$VERSION.json\" .version package.json"],
            why: "the word behind a redirect is the file the call writes to, not the program it runs - and this is the one line where consuming that word changes a verdict, in the direction of saying nothing about a program jq was never handed"
        },
        {
            name: "an indented output with a bound program",
            shell: ["jq --indent 2 '.x = $v' --arg v \"$V\" package.json"],
            why: "--indent's own value is read as the program, and a column count assigns nothing"
        }
    ];

    /**
     * And the lines it is for: a program the shell builds before jq is executed
     * at all.
     *
     * Every one of these is the same mistake wearing different clothes, which
     * is the point - the rule is about what reaches jq, not about the shape of
     * the line that got it there. A scan that catches only the shape somebody
     * wrote down once catches the next one never.
     */
    const SPLICED = [
        {
            name: "a version expanded into the program",
            shell: ["jq \".version = \\\"$VERSION\\\"\" package.json > tmp"],
            why: "the splice this rule exists to refuse"
        },
        {
            name: "an interpolated read, escaped quotes and all",
            shell: ["jq -e \".targets[\\\"$NAME\\\"]\" targets.json"],
            why: "a program built out of a value is a program built out of a value whether it writes or reads; a name carrying a quote closes the string and the rest is jq's to parse"
        },
        {
            name: "a splice with a binding written after it",
            shell: ["jq \".v = \\\"$V\\\"\" --arg v \"$V\" package.json"],
            why: "a --arg anywhere on the line excuses the program in front of it, which is the one place the value never went"
        },
        {
            name: "a program that binds one value and splices another",
            shell: ["jq --arg v \"$V\" \".version = \\\"$VERSION\\\" | .n = $v\""],
            why: "the call binds a value, so the value it splices is never looked at"
        },
        {
            name: "a splice behind --argfile",
            shell: ["jq --argfile v defaults.json \".x = \\\"$V\\\"\""],
            why: "a flag whose arity is unknown has its own value read as the program, and the program behind it never reached"
        },
        {
            name: "a splice in the second half of a pipeline",
            shell: ["jq . package.json | jq \".v = \\\"$V\\\"\" > tmp"],
            why: "the program is read from the first jq on the line, so a rewrite in the second half is never looked at"
        },
        {
            name: "a splice inside a command substitution",
            shell: ["VERSION=$(jq \".v = \\\"$V\\\"\" package.json)"],
            why: "a call opened by $( is not in command position by the letter of the rule, and is a call by every other measure"
        },
        {
            name: "a splice inside backticks",
            shell: ["V=`jq \".v = \\\"$V\\\"\" package.json`"],
            why: "the older spelling of the same substitution, and the one nobody updates"
        },
        {
            name: "a splice on a continued line",
            shell: ["jq --arg v \"$V\" \\", "\".version = \\\"$VERSION\\\"\" package.json"],
            shows: "\".version = \\\"$VERSION\\\"\" package.json",
            why: "the shell removes a backslash-newline before it parses anything, so a call split across two lines is one call"
        },
        {
            name: "a splice concatenated onto a single-quoted program",
            shell: ["jq '.version = '\"$VERSION\" package.json"],
            why: "the quotes open and close within the word, and the half that carries the value is the unquoted one"
        },
        {
            name: "a splice tested by an if",
            shell: ["if jq \".version = \\\"$VERSION\\\"\" package.json; then echo ok; fi"],
            why: "the word after `if` is the command - a prefix set that knows `then` but not `if` misses the half that must come first"
        },
        {
            name: "a splice driving a while",
            shell: ["while jq \".version = \\\"$VERSION\\\"\" package.json; do sleep 1; done"],
            why: "the word after `while` (and `until`) is the command, exactly as after `if`"
        },
        {
            name: "a splice behind an environment assignment",
            shell: ["JQ_COLORS=1 jq \".version = \\\"$VERSION\\\"\" package.json"],
            why: "NAME=value prefixes are not the command - the shell strips any number of them before finding it"
        },
        {
            name: "a splice from a call written as a path",
            shell: ["/usr/bin/jq \".v = \\\"$V\\\"\" package.json"],
            why: "a call spelled as a path is not read as a call at all, and an absolute path is how a runner that does not trust its own PATH writes one"
        },
        {
            name: "a splice behind sudo",
            shell: ["sudo jq \".v = \\\"$V\\\"\" package.json"],
            why: "a word that runs what follows it is read as the command, and the jq behind it as an argument of that command"
        },
        {
            name: "a splice in the body of a for loop",
            shell: ["for f in *.json; do jq \".v = \\\"$V\\\"\" \"$f\"; done"],
            why: "`do` opens the body of every loop the shell has, and a call standing first in one is the command it runs"
        },
        {
            name: "a splice behind exec",
            shell: ["exec jq \".v = \\\"$V\\\"\" package.json"],
            why: "exec replaces the shell with the command, which is the same command run one process shallower"
        },
        {
            name: "a splice behind nohup",
            shell: ["nohup jq \".v = \\\"$V\\\"\" package.json"],
            why: "nohup runs the command detached, which is the same command with its parent gone"
        },
        {
            name: "a program built by a backtick inside the quotes",
            shell: ["jq \".version = \\\"`cat VERSION`\\\"\" package.json"],
            why: "a backtick inside double quotes is the older spelling of $( ), and the shell runs it before jq is executed at all - so the program is built out of whatever it printed"
        },
        {
            name: "a splice under a line ending in an escaped backslash",
            shell: ["echo a\\\\", "jq \".version = \\\"$VERSION\\\"\" package.json"],
            shows: "jq \".version = \\\"$VERSION\\\"\" package.json",
            why: "`\\\\` is an escaped backslash and continues nothing, so the line under it is a line of its own - joined onto the one above, its jq is glued to the word in front of it and the splice is reported nowhere"
        },
        {
            name: "a splice behind stderr redirected onto stdout",
            shell: ["jq 2>&1 \".version = \\\"$VERSION\\\"\" package.json"],
            why: "the file descriptor in front of the redirect is read as the program, and the program behind it is never reached"
        },
        {
            name: "a splice behind an appending redirect",
            shell: ["jq >> out.json \".version = \\\"$VERSION\\\"\""],
            why: "a redirect is read as the end of the call, so a program written behind one - which bash reads as the same call - is never looked at"
        },
        {
            name: "a splice behind a redirect written before the program",
            shell: ["jq > tmp \".version = \\\"$VERSION\\\"\" package.json"],
            why: "bash lets a redirection stand anywhere in a simple command, so a call that redirects first hands jq the same program as one that redirects last"
        },
        {
            name: "a splice behind a discarded stderr",
            shell: ["jq 2>/dev/null \".version = \\\"$VERSION\\\"\" package.json"],
            why: "the file the redirect names is read as the program, and 2>/dev/null is how a line that expects to fail is written"
        },
        {
            name: "a splice on a line whose redirect names nothing",
            shell: ["jq \".version = \\\"$V\\\"\" package.json >"],
            why: "the program is already read by the time the trailing redirect is - what this row pins is the reader's bounds: without the undefined guard on the target word, a redirect at the very end reads `.operator` off the end of the array and the scan throws instead of answering"
        },
        {
            name: "a splice behind --indent",
            shell: ["jq --indent 2 \".version = \\\"$VERSION\\\"\" package.json > tmp"],
            why: "--indent's own value is read as the program, so the splice standing behind it is never looked at"
        },
        {
            name: "a splice under a comment ending in a backslash",
            shell: ["npm ci # step one \\", "jq \".version = \\\"$VERSION\\\"\" package.json"],
            shows: "jq \".version = \\\"$VERSION\\\"\" package.json",
            why: "a backslash at the end of a comment is prose - the comment runs to its newline - but the join read it as a continuation and swallowed the command below into the comment"
        },
        {
            name: "a splice under a whole-line comment ending in a backslash",
            shell: ["# prepare the bump \\", "jq \".version = \\\"$VERSION\\\"\" package.json"],
            shows: "jq \".version = \\\"$VERSION\\\"\" package.json",
            why: "a line that is nothing but prose ends at its newline whatever it ends in, and joining there hid the command below inside a comment"
        },
        {
            name: "a splice behind sudo with a user flag",
            shell: ["sudo -u root jq \".version = \\\"$V\\\"\" package.json"],
            why: "the flag's value stood where the command is looked for, so the jq behind it read as an argument of `root`"
        },
        {
            name: "a splice behind exec with a name flag",
            shell: ["exec -a myspeed jq \".version = \\\"$V\\\"\" package.json"],
            why: "exec's -a names the process and takes that name as its next word, which is not the command either"
        },
        {
            name: "a splice behind xargs with an attached count",
            shell: ["echo package.json | xargs -n1 jq \".version = \\\"$V\\\"\""],
            why: "a flag with its value attached is one word starting with a dash, and the walk stopped on it"
        },
        {
            name: "a splice behind time with a bare flag",
            shell: ["time -p jq \".version = \\\"$V\\\"\" package.json"],
            why: "a bare flag between the prefix and the command is enough to hide the call"
        },
        {
            name: "a splice behind env with a bare flag",
            shell: ["env -i jq \".version = \\\"$V\\\"\" package.json"],
            why: "env -i empties the environment and runs what follows, which is the same command"
        },
        {
            name: "a splice piped from a command ending in a flag",
            shell: ["sort -u | jq \".version = \\\"$VERSION\\\"\""],
            why: "the walk over a prefix's flags must stop at the pipe: unbounded, it stepped over the operator onto the LEFT command and the call was dropped - a missed splice, the one direction this scan must not fail in"
        },
        {
            name: "a splice behind a quoted flag value",
            shell: ["sudo -u 'root' jq \".version = \\\"$VERSION\\\"\" package.json"],
            why: "the shell strips the quotes before sudo sees its user, so the quoted spelling runs the same jq - but a walk gated on unquoted words stopped at 'root' and the splice went unreported"
        }
    ];

    for (const row of INERT)
        it(`says nothing about ${row.name}`, () => {
            const source = splice(row.name, ...row.shell);

            assert.ok(walked(source, row.shell),
                `${row.name} is not being walked at all, so this asserts nothing`);

            assert.deepEqual(splices(source), [], row.why);
        });

    for (const row of SPLICED)
        it(`reports ${row.name}`, () => {
            const source = splice(row.name, ...row.shell);

            assert.ok(walked(source, row.shell),
                `${row.name} is not being walked at all, so this asserts nothing`);

            const reported = splices(source);

            assert.equal(reported.length, 1, row.why);
            assert.ok(reported[0].includes(row.shows ?? row.shell[0].trim()),
                "some other line was reported, so this one is still going unnoticed");
        });

    /**
     * Every value-taking flag, exercised on the prefix it is real on - in
     * both spellings of its value. Without these, eight of the ten members
     * were decoration: only -u and -a had rows, so a typo or a trimmed map
     * kept all 68 tests green while the walk quietly narrowed. Generated
     * from the same map the walk reads, so membership and exercise cannot
     * drift apart.
     */
    describe("every value-taking prefix flag earns its place", () => {
        /**
         * The map pinned by value, because the matrix is generated FROM the
         * map and so can never disagree with it: a typo'd flag, a deleted
         * one, or one moved to a prefix it is not real on changes the rows
         * in lockstep with the walk, and everything stays green while the
         * walk quietly narrows. This list is the one thing the map is held
         * against.
         */
        it("still walks the flags the workflows write, each on its own prefix", () => {
            assert.deepEqual([...VALUE_TAKING_PREFIX_FLAGS],
                [["-u", "sudo"], ["-g", "sudo"], ["-a", "exec"], ["-n", "xargs"], ["-I", "xargs"],
                    ["-L", "xargs"], ["-P", "xargs"], ["-s", "xargs"], ["-d", "xargs"], ["-E", "xargs"]],
                "a flag left the map, or moved to a prefix it is not real on, so its value once again stands "
                + "where the command is looked for");
        });

        for (const [flag, host] of VALUE_TAKING_PREFIX_FLAGS)
            for (const value of ["v", "'v'"])
                it(`reports a splice behind ${host} ${flag} ${value}`, () => {
                    const shell = [`${host} ${flag} ${value} jq ".version = \\"$VERSION\\"" package.json`];
                    const source = splice(`${host} ${flag} ${value}`, ...shell);

                    assert.ok(walked(source, shell), "the fixture is not being walked at all");
                    assert.equal(splices(source).length, 1,
                        `the ${flag} flag's value stood where the command is looked for, and the call was dropped`);
                });
    });

    /**
     * The rule the two lines in the workflow are held to, stated over what they
     * are rather than over what they are not.
     *
     * Read as programs rather than as lines, because the assertion is about
     * what jq is handed: a value bound with --arg, and a program the shell
     * cannot have touched.
     */
    it("classifies both of the workflow's own writes as bound", () => {
        assert.deepEqual(boundWrites(release), [".version = $v", ".version = $v"],
            "the two version files are no longer bumped by a jq that binds the version as data");
    });

    /**
     * The other half of the reading, which no row in the matrix above can
     * discriminate: every one of those is judged on the program, and a program
     * in single quotes is inert whatever the flags around it do.
     *
     * This one is judged on the flags. A value bound behind the program it
     * belongs to is still bound - jq reads its flags wherever they stand - so
     * the collector has to go on past the program. Stopping there instead
     * leaves a correct write looking like a call that binds nothing, and the
     * liveness check below then reports the workflow's own bump as missing.
     */
    it("counts a binding written behind the program it belongs to", () => {
        const shell = ["jq '.version = $v' --arg v \"$VERSION\" package.json > tmp"];
        const source = splice("a binding written after the program", ...shell);

        assert.ok(walked(source, shell),
            "the row is not being walked at all, so this asserts nothing");

        assert.equal(boundWrites(source).length, boundWrites(release).length + 1,
            "a bound value written behind the program it belongs to is not read as a binding at all");
    });

    it("hands jq the version as an argument rather than as program text", () => {
        assert.notEqual(boundWrites(release).length, 0,
            "nothing rewrites the version files with jq any more");

        assert.deepEqual(splices(release), [],
            "jq is handed a program rather than an argument; bind the value with --arg and read it as a jq variable");

        /**
         * And what those bound programs do, which is the half the rule above
         * cannot see: it asks only that the program is inert and mentions
         * .version, so a call narrowed to `'.version'` - a read - would satisfy
         * it while the release shipped the previous version's number.
         *
         * This is where the old third assertion pointed, and it pointed at the
         * absence of `.version = "$VERSION"` among the reported lines - which
         * the assertion above now covers completely, over every line rather
         * than over one spelling of one splice. So it is turned around: not
         * that no line splices the version, but that the lines which bind it
         * still assign it.
         */
        for (const program of boundWrites(release))
            assert.match(program, /\.version\s*=/,
                `${program} binds the version and assigns nothing, so the bump leaves the file unchanged`);
    });

    /**
     * And only of what is actually run.
     *
     * The walk keeps a `#` line inside a block scalar on purpose: the block is
     * one string, so an expression on a commented line is substituted into it
     * all the same, and the scan written to find that has to see it. This rule
     * asks a different question - what jq is executed with - and a commented-out
     * call is executed with nothing.
     *
     * Counting one costs both directions at once, and the expensive direction is
     * this one: the check that something still rewrites the version is satisfied
     * by a commented-out copy of the write that was deleted, so a release that
     * bumps nothing passes. The other direction is a row in the matrix above.
     */
    const withoutTheRealWrites = () => release.split("\n").filter((line) => !/\bjq\b/.test(line)).join("\n");

    it("does not count a commented-out write as one that still happens", () => {
        const commented = [
            withoutTheRealWrites(),
            "      - name: Bump version files",
            "        run: |",
            "          # jq --arg v \"$VERSION\" '.version = $v' package.json > tmp && mv tmp package.json"
        ].join("\n");

        assert.equal(boundWrites(commented).length, 0,
            "the check that something still rewrites the version is satisfied by a commented-out copy of the write that was deleted");
    });
});
