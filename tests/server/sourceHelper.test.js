import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import {
    blockEnd, bodyIn, bodyOf, findMounts, listSources, mountText, readSource, unreadableMountCount
} from "../helpers/source.js";

describe("blockEnd", () => {
    it("returns the index of the matching closing brace", () => {
        const source = "{ one(); }";
        assert.equal(blockEnd(source, 0), source.length - 1);
    });

    it("handles nested braces", () => {
        const source = "{ if (x) { deep(); } done(); } extra";
        assert.equal(blockEnd(source, 0), source.indexOf(" extra") - 1);
    });

    it("starts from the given offset", () => {
        const source = "prefix { { inner(); } } suffix";
        const from = source.indexOf("{");
        assert.equal(blockEnd(source, from), source.indexOf(" suffix") - 1);
    });

    it("throws when a block is never closed", () => {
        assert.throws(() => blockEnd("{ unclosed();", 0), /a block is never closed/);
    });

    it("throws when no brace is present", () => {
        assert.throws(() => blockEnd("plain text", 0), /a block is never closed/);
    });
});

/**
 * The helper several tests read source with, which had been written twice.
 *
 * Both copies existed to stop an assertion running past the declaration it was
 * about - the one in tasks/timer.js would otherwise reach runTask, whose own
 * `.catch` would satisfy an assertion about startTimer and hide exactly the
 * thing that assertion was added for. A helper that quietly returns the wrong
 * slice turns every test built on it into one that cannot fail, so it gets
 * tests of its own.
 */
describe("bodyOf", () => {
    it("returns the balanced body of a declaration", () => {
        const source = "const a = () => { one(); };\nconst b = () => { two(); };";

        assert.equal(bodyOf(source, "const a"), "{ one(); }");
    });

    it("keeps nested braces rather than stopping at the first close", () => {
        const source = "const a = () => { if (x) { deep(); } done(); };";

        assert.equal(bodyOf(source, "const a"), "{ if (x) { deep(); } done(); }");
    });

    // The failure the two copies existed to prevent: a slice that runs on into
    // the next function passes assertions that belong to neither.
    it("stops before the declaration that follows", () => {
        const source = "const a = () => { plain(); };\nconst b = () => { caught().catch(noop); };";

        assert.doesNotMatch(bodyOf(source, "const a"), /catch/,
            "the slice ran into the next function, where anything at all can be found");
    });

    it("finds a declaration that is not the first in the file", () => {
        const source = "const a = () => { one(); };\nexport const b = () => { two(); };";

        assert.equal(bodyOf(source, "export const b"), "{ two(); }");
    });

    /**
     * Loud rather than quiet, both ways round. A helper that answered "" for a
     * declaration that has been renamed would leave every assertion built on it
     * passing against nothing.
     */
    it("throws when the declaration is gone", () => {
        assert.throws(() => bodyOf("const a = () => {};", "const gone"), /not in this source/);
    });

    it("throws when the body is never closed", () => {
        assert.throws(() => bodyOf("const a = () => { unclosed();", "const a"), /never closed/);
    });

    /**
     * An arrow whose body is one expression has no braces to balance, and the
     * obvious handling of that is quietly wrong: indexOf answers -1, a walk
     * from there scans the file from its start and balances the first pair it
     * meets - an import's, several declarations above - and then slices from
     * -1, which JavaScript reads as one character from the end. The answer is
     * an empty string, and every assertion made against it passes.
     *
     * This is not hypothetical: isUntrustedReader is one line long, and it
     * behaved exactly this way the moment an import was added above it.
     */
    it("refuses a declaration with no braced body", () => {
        const source = 'import { thing } from "./thing.js";\nexport const a = (x) => x || thing();';

        assert.throws(() => bodyOf(source, "export const a"), /no braced body/,
            "the walker balanced the import's braces and sliced from the end of the file");
    });

    it("does not answer an empty string for one", () => {
        const source = 'import { thing } from "./thing.js";\nexport const a = (x) => x || thing();';

        let answered = "not called";
        try {
            answered = bodyOf(source, "export const a");
        } catch {
            // The throw above is the contract; this only proves it never
            // returns the empty slice that made assertions vacuous.
        }

        assert.equal(answered, "not called");
    });
});

describe("readSource", () => {
    it("reads a file relative to the repository root", () => {
        assert.match(readSource("package.json"), /"name": "myspeed"/);
    });
});

describe("bodyIn", () => {
    it("reads and slices in one step", () => {
        assert.match(bodyIn("server/util/serialiseQueue.js", "export const createQueue"),
            /tail\.then\(task\)/);
    });

    // The real one-line declaration that found the bug above.
    it("refuses a declaration with no braces to balance", () => {
        assert.throws(() => bodyIn("server/util/untrustedReader.js", "export const isUntrustedReader"),
            /no braced body/);
    });
});

/**
 * One route mount's text, bounded by the mount that follows it.
 *
 * The scans that hold a route to its guard used to slice from the mount to the
 * next `=>` in the file. That is sound only while every handler is an arrow: a
 * route mounted with a named function has no arrow of its own, so the search
 * runs on into the *next* route and the slice comes back carrying that route's
 * middleware. A neighbour's guard then marks an unguarded route as guarded,
 * which is the one direction a security scan must not fail in.
 */
describe("mountText", () => {
    const AT = (source, mount) => source.indexOf(mount);

    it("returns the middleware list up to the handler", () => {
        const source = 'app.get("/a", password(false), async (req, res) => {\n    body();\n});';

        const text = mountText(source, AT(source, "app.get"));

        assert.match(text, /password\(false\)/);
        assert.doesNotMatch(text, /body\(\)/, "the handler body is not the middleware list");
    });

    /**
     * The failure this exists for. /a has a named handler and no arrow, so a
     * search for the next `=>` lands on /b's - and /b is the guarded one.
     */
    it("does not reach into the next mount for a route with no arrow", () => {
        const source = [
            'app.get("/a", password(false), handleA);',
            'app.get("/b", password(false), previewReadOnly.blocking("no"), async (req, res) => {});'
        ].join("\n");

        assert.doesNotMatch(mountText(source, AT(source, 'app.get("/a"')), /blocking/,
            "an unguarded route was handed its neighbour's guard");
    });

    it("still finds the guard on the route that carries it", () => {
        const source = [
            'app.get("/a", password(false), handleA);',
            'app.get("/b", password(false), previewReadOnly.blocking("no"), async (req, res) => {});'
        ].join("\n");

        assert.match(mountText(source, AT(source, 'app.get("/b"')), /blocking/);
    });

    it("handles a mount that spans several lines", () => {
        const source = [
            'app.get("/a", password(false),',
            '    previewReadOnly.blocking("no"),',
            '    async (req, res) => {',
            '        body();',
            '    });'
        ].join("\n");

        const text = mountText(source, AT(source, "app.get"));

        assert.match(text, /blocking/);
        assert.doesNotMatch(text, /body\(\)/);
    });

    // The last route in a file has no mount after it to stop at, so the window
    // runs to the end - asserted through a guard, since the handler itself is
    // the last argument and is deliberately not part of the middleware list.
    it("reads to the end of the file for the final mount", () => {
        const source = 'app.get("/only", previewReadOnly.blocking("no"), handleOnly);\n';

        assert.match(mountText(source, AT(source, "app.get")), /blocking/);
    });

    // A mount indented inside a block is not one this bound recognises, and it
    // must not swallow the rest of the file looking for one that is.
    it("stops at the next mount whatever the verb", () => {
        const source = [
            'app.get("/a", password(false), handleA);',
            'app.delete("/b", password(false), previewReadOnly, handleB);'
        ].join("\n");

        assert.doesNotMatch(mountText(source, AT(source, 'app.get("/a"')), /previewReadOnly/);
    });
});

describe("listSources", () => {
    it("lists the javascript files in a directory under the root", () => {
        const files = listSources("server/routes");

        assert.ok(files.includes("nodes.js"));
        assert.ok(files.every((name) => name.endsWith(".js")));
    });

    // Resolved from this module rather than the working directory, so a runner
    // launched from anywhere finds the same files.
    it("does not depend on the working directory", () => {
        const before = process.cwd();

        process.chdir(os.tmpdir());
        try {
            assert.ok(listSources("server/routes").length >= 8);
        } finally {
            process.chdir(before);
        }
    });
});

/**
 * The middleware list, bounded by the handler rather than by the first arrow.
 *
 * Trimming at the first `=>` is right only while no middleware takes a callback
 * of its own. opengraph mounts `passwordWrapper(true, (req, res) => {...})`
 * before its handler, so the trim landed inside that argument and everything
 * after it - where a guard would sit - was invisible. The handler is the last
 * argument, so the list is everything before the last comma at the mount's own
 * paren depth.
 */
describe("mountText and the argument list", () => {
    const AT = (source, mount) => source.indexOf(mount);

    it("keeps a guard that follows a middleware taking a callback", () => {
        const source = 'app.get("/a", wrapper(true, (req, res) => fallback()), '
            + 'previewReadOnly.blocking("no"), async (req, res) => { body(); });';

        const text = mountText(source, AT(source, "app.get"));

        assert.match(text, /blocking/, "the trim landed inside the wrapper's own callback");
        assert.doesNotMatch(text, /body\(\)/, "the handler body is not the middleware list");
    });

    // The refusal sentences carry commas, and they sit a level down from the
    // list this counts on.
    it("is not fooled by a comma inside a guard's message", () => {
        const source = 'app.get("/a", previewReadOnly.blocking("For security reasons, you can\'t"), '
            + 'async (req, res) => { body(); });';

        const text = mountText(source, AT(source, "app.get"));

        assert.match(text, /blocking/);
        assert.doesNotMatch(text, /body\(\)/);
    });

    it("keeps every middleware when there are several", () => {
        const source = 'app.get("/a", password(false), first(), second(), async (req, res) => { body(); });';

        const text = mountText(source, AT(source, "app.get"));

        for (const each of ["password", "first", "second"]) assert.match(text, new RegExp(each));
        assert.doesNotMatch(text, /body\(\)/);
    });

    it("handles a mount with nothing but a handler", () => {
        const source = 'app.get("/a", async (req, res) => { body(); });';

        assert.doesNotMatch(mountText(source, AT(source, "app.get")), /body\(\)/);
    });
});

/**
 * Where the mounts are, taken from the match rather than searched for again.
 *
 * Both route scans located a mount with source.indexOf(match), which finds the
 * *first* occurrence of that text - so two mounts sharing a matched prefix
 * would both be read at the first one's position, and the second would be
 * judged on the first one's middleware. matchAll already carries the index.
 */
describe("findMounts", () => {
    it("finds every mount of the verbs it is given", () => {
        const source = [
            'app.get("/a", handleA);',
            'app.delete("/b", handleB);',
            'app.post("/c", handleC);'
        ].join("\n");

        assert.deepEqual(findMounts(source, ["get", "delete"]).map(({route}) => route), ["/a", "/b"]);
    });

    it("reports the verb it matched", () => {
        const source = 'app.all("/:id/*rest", handler);';

        assert.equal(findMounts(source, ["get", "all"])[0].verb, "all");
    });

    /**
     * The defect this replaces. Two mounts whose matched text is identical -
     * the capture stops at the route string, so a repeated path is enough -
     * were both read at the first one's offset.
     */
    it("gives each mount its own position", () => {
        const source = [
            'app.get("/same", first, previewReadOnly.blocking("no"), async (req, res) => {});',
            'app.get("/same", second, async (req, res) => {});'
        ].join("\n");

        const [one, two] = findMounts(source, ["get"]);

        assert.notEqual(one.at, two.at, "both mounts were located at the same offset");
        assert.match(one.text, /blocking/);
        assert.doesNotMatch(two.text, /blocking/, "the second mount was handed the first one's guard");
    });

    it("carries each mount's own text", () => {
        const source = [
            'app.get("/a", password(false), handleA);',
            'app.get("/b", previewReadOnly.blocking("no"), handleB);'
        ].join("\n");

        const [a, b] = findMounts(source, ["get"]);

        assert.doesNotMatch(a.text, /blocking/);
        assert.match(b.text, /blocking/);
    });

    it("finds nothing in a file that mounts nothing", () => {
        assert.deepEqual(findMounts("export default app;", ["get", "all"]), []);
    });
});

/**
 * Comments inside a mount's argument list, which this codebase writes.
 *
 * The bound tracked strings and not comments, so one contraction - "don't" -
 * opened a quote state that never closed. The mount's own closing paren was
 * then skipped, the bound collapsed, and the window swallowed the handler body:
 * a scan asking only whether the guard appears somewhere in that text would be
 * satisfied by a comment in the body mentioning it. opengraph already puts a
 * comment inside its argument list, and only the accident that it contains no
 * apostrophe kept this working.
 */
describe("mountText and comments", () => {
    const AT = (source, mount) => source.indexOf(mount);
    const HANDLER = "async (req, res) => { body(); });";

    it("survives a contraction in a line comment", () => {
        const source = `app.get("/a", wrapper(true, (req, res) => {\n`
            + `    // don't redirect here\n`
            + `    fallback();\n`
            + `}), previewReadOnly.blocking("no"), ${HANDLER}`;

        const text = mountText(source, AT(source, "app.get"));

        assert.match(text, /blocking/, "the guard is in the middleware list");
        assert.doesNotMatch(text, /body\(\)/, "the bound collapsed and swallowed the handler");
    });

    it("survives one in a block comment", () => {
        const source = `app.get("/a", /* the operator's own choice */ previewReadOnly.blocking("no"), ${HANDLER}`;

        const text = mountText(source, AT(source, "app.get"));

        assert.match(text, /blocking/);
        assert.doesNotMatch(text, /body\(\)/);
    });

    // A comma in prose is not an argument separator.
    it("does not count a comma inside a comment", () => {
        const source = `app.get("/a", // first, second, third\n    previewReadOnly.blocking("no"), ${HANDLER}`;

        assert.match(mountText(source, AT(source, "app.get")), /blocking/,
            "a comma in the comment was taken for the handler's");
    });

    // Nor a paren in prose the end of the mount.
    it("does not let a comment close the mount", () => {
        const source = `app.get("/a", /* see refuses(message) above */ previewReadOnly.blocking("no"), ${HANDLER}`;

        assert.match(mountText(source, AT(source, "app.get")), /blocking/);
    });

    /**
     * And a comment marker inside a string is not a comment. The refusals carry
     * URLs and paths, and treating one as the start of a comment would swallow
     * the rest of the list.
     */
    it("does not start a comment inside a string", () => {
        const source = `app.get("/a", note("see https://example.invalid/x"), `
            + `previewReadOnly.blocking("no"), ${HANDLER}`;

        const text = mountText(source, AT(source, "app.get"));

        assert.match(text, /blocking/, "the // inside the url was read as a comment");
        assert.doesNotMatch(text, /body\(\)/);
    });

    // The apostrophes the guard messages actually carry, which sit inside a
    // double-quoted string and must stay ordinary characters.
    it("leaves an apostrophe inside a string alone", () => {
        const source = `app.get("/a", previewReadOnly.blocking("you can't do that"), ${HANDLER}`;

        const text = mountText(source, AT(source, "app.get"));

        assert.match(text, /blocking/);
        assert.doesNotMatch(text, /body\(\)/);
    });
});

/**
 * A handler body is full of commas, and none of them separate arguments.
 *
 * Paren depth alone does not say where the argument list ends: once the
 * handler's own parameter list closes, the scan is back at the mount's depth
 * and every comma in the body counts. `const { from, to } = req.query` is one,
 * and it put the bound *inside* the handler - which is how the four speedtest
 * mounts came back carrying most of their own bodies. Braces and brackets have
 * to be tracked as well, so a comma only separates arguments where it can.
 */
describe("mountText and the handler's own commas", () => {
    const AT = (source, mount) => source.indexOf(mount);

    it("ignores a comma in a destructuring inside the handler", () => {
        const source = 'app.get("/a", previewReadOnly.blocking("no"), async (req, res) => {\n'
            + "    const { from, to } = req.query;\n"
            + "    body(from, to);\n"
            + "});";

        assert.equal(mountText(source, AT(source, "app.get")),
            'app.get("/a", previewReadOnly.blocking("no")',
            "the bound landed inside the handler body");
    });

    it("ignores one in an array inside the handler", () => {
        const source = 'app.get("/a", password(false), async (req, res) => {\n'
            + "    const order = [first, second];\n"
            + "});";

        assert.equal(mountText(source, AT(source, "app.get")), 'app.get("/a", password(false)');
    });

    // An object handed to a middleware is one argument, however many commas it
    // holds - so its commas must not be counted either.
    it("treats an object argument as one argument", () => {
        const source = 'app.get("/a", limit({window: 1, max: 2}), async (req, res) => {\n'
            + "    body();\n"
            + "});";

        assert.equal(mountText(source, AT(source, "app.get")),
            'app.get("/a", limit({window: 1, max: 2})',
            "the object argument was cut in half");
    });

    /**
     * The real mounts, which is where this was found. Nothing in server/routes
     * may come back carrying its own handler, or a scan that asks whether a
     * guard appears somewhere in that text can be satisfied by the body.
     *
     * Recognised by a declaration keyword rather than by counting arrows: a
     * middleware may legitimately carry an arrow of its own - opengraph's
     * fallback does, and its comment even contains the word "return" - but
     * `const`, `let` and `await` belong to a handler body and appear in no
     * argument list. The broken window that started this carried
     * `const { from, to`.
     */
    it("leaves every real route's handler out of its middleware list", () => {
        const VERBS = ["get", "all", "post", "put", "patch", "delete"];
        const BODY = /\b(const|let|await)\s/;

        const carrying = listSources("server/routes").flatMap((name) =>
            findMounts(readSource(`server/routes/${name}`), VERBS)
                .filter(({text}) => BODY.test(text))
                .map(({route}) => `${name} ${route}`));

        assert.deepEqual(carrying, [], "these mounts came back carrying their own handler body");
    });
});

/**
 * What the strict pattern cannot read, said out loud instead of skipped.
 *
 * findMounts needs `app.` at the start of a line and a quoted first argument.
 * Everything derived from it - the whole of previewReadOnly.test.js - is a list
 * of what it found, so a mount it cannot parse is not unguarded or exempt in
 * those scans: it is absent, and no assertion built on the list can see it. The
 * only defence was a floor on the count, and a floor with slack in it cannot
 * notice one route going quiet.
 *
 * That is the one direction a security scan must not fail in, and it is the same
 * failure previewReadOnly exists to end: a rule reproduced by hand is a rule
 * something forgets, and a scan that quietly drops what it cannot parse forgets
 * the same way.
 */
describe("unreadableMountCount", () => {
    const VERBS = ["get", "post", "put", "patch", "delete", "all"];

    it("counts nothing when every mount is in the shape the scan expects", () => {
        const source = [
            `app.get("/", password(false), handler);`,
            `app.delete("/:id", password(false), previewReadOnly, handler);`
        ].join("\n");

        assert.equal(unreadableMountCount(source, VERBS), 0);
        assert.equal(findMounts(source, VERBS).length, 2);
    });

    // Inside an `if`, a loop or a helper - the anchored pattern never matches an
    // indented line.
    it("counts an indented mount, which findMounts cannot see at all", () => {
        const source = [
            `app.get("/", password(false), handler);`,
            `if (process.env.ENABLE_DEBUG) {`,
            `    app.get("/debug/config", handler);`,
            `}`
        ].join("\n");

        assert.equal(findMounts(source, VERBS).length, 1, "the indented mount was somehow found");
        assert.equal(unreadableMountCount(source, VERBS), 1);
    });

    // A path held in a binding rather than written at the call.
    it("counts a mount whose path is not a literal", () => {
        const source = [
            `const RAW_HISTORY = "/tests/history/raw";`,
            `app.get(RAW_HISTORY, password(false), handler);`
        ].join("\n");

        assert.equal(findMounts(source, VERBS).length, 0);
        assert.equal(unreadableMountCount(source, VERBS), 1);
    });

    /**
     * Prose that names a verb without calling it is not a mount. The node proxy's
     * own comment says "`app.all` looks like nothing in particular", and counting
     * that would make this assertion fire on a file that is entirely readable -
     * a scan that cries wolf is turned off, which is worse than one with a gap.
     */
    it("does not count a comment that merely names a verb", () => {
        const source = [
            `// it was missed because \`app.all\` looks like nothing in particular`,
            `app.get("/", handler);`
        ].join("\n");

        assert.equal(unreadableMountCount(source, VERBS), 0);
    });

    it("only counts the verbs it was asked about", () => {
        const source = [
            `app.get("/", handler);`,
            `    app.post("/thing", handler);`
        ].join("\n");

        assert.equal(unreadableMountCount(source, ["get"]), 0, "an indented post was counted against get");
        assert.equal(unreadableMountCount(source, ["get", "post"]), 1);
    });
});
