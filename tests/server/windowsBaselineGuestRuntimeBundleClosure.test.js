import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {isBuiltin} from "node:module";
import {before, describe, it} from "node:test";
import {fileURLToPath} from "node:url";

import {parse} from "espree";

import {WINDOWS_BASELINE_RUNTIME_BUNDLE_CONSTANTS} from
    "../../scripts/qualification/windows-baseline-guest-runtime-bundle.mjs";

/*
 * The guest runtime bundle ships a fixed list of files and nothing else. Inside the guest they run
 * under a pinned node.exe from a temporary directory with no node_modules and no repository, so a
 * file a member reaches that is not in the list fails inside a virtual machine, half an hour into a
 * thirty-five minute sequence, on a host nobody can attach a debugger to.
 *
 * What this suite guarantees, in one sentence: the bundle loads by itself under the guest's layout,
 * and every place a member names a script - or asks where it is, or a controller mentions one - has
 * been approved by a human.
 *
 * "Script" is literal: the pin triggers on .mjs, .js, .cjs, .ps1, .psm1 and .psd1. A member naming a
 * non-script asset is not a site and is not pinned, and members do name them - the materializer's
 * ownership marker, the fixture's bin/ost-cli.exe and data/servers/*.json. Those belong to the
 * request and fixture contracts, which fixtureInventoryParity and the materializer's own suite hold;
 * they are not bundle members and reaching them wrong is not what this test is for.
 *
 * It gets there two ways, neither of which interprets a path.
 *
 * The first is to stop modelling and start running. Four earlier versions of this test each
 * re-implemented part of Node's resolver - matching import syntax, then scanning strings, then
 * resolving path.join arguments - and every one of them had both failure kinds, because a
 * re-implementation always does: a shape it does not model is an escape, and a shape it models too
 * strictly is a false positive that gets the test relaxed. Adversarial review found, across four
 * rounds, an import hidden behind a comment, a regular expression read as code, a filename moved
 * into a constant, an inverted Bun condition, a guard that loaded before it returned - and equally,
 * refusals of the materializer's own correct write and of console.warn("Run repair.ps1").
 *
 * So the bundle is copied into a bare directory laid out the way the guest installer lays it out,
 * and every module is imported by a child Node process with no repository and no node_modules above
 * it. Node's own loader gives the verdict, which is the same loader that will give it in the VM.
 * Three probes then exercise the seams that a load alone cannot reach: the SQLite shim's Node
 * branch, the macOS guard on win32, and the executor reading its own PowerShell wrapper.
 *
 * The second is to pin rather than resolve. Where a module names a script or asks where it is, the
 * source text of that expression is compared against a list a human approved. No semantics, so no
 * semantic mistakes: a change is shown, not judged, and the failure prints the new text to paste.
 * Controller lines are pinned the same way, matched on substrings, because no PowerShell layout can
 * hide a substring on a line.
 *
 * Stated so nobody reads more into a green run than it says:
 * - A path assembled entirely from run-time values, with no file name and no module-location anchor
 *   in the expression, is invisible. The materializer's reads under the task root are of that kind;
 *   they belong to the request contract, and the fixture inventory to fixtureInventoryParity.
 * - A function-local alias of the module directory is pinned where it is introduced, not where it
 *   is later used. Module-level aliases are followed and their uses are pinned.
 * - Nothing inside a scenario runs here. The wrapper hashes the controllers it is handed.
 * - A controller line reaching a script through a value with no extension, no Import-Module and no
 *   script-root variable is invisible to the line pin.
 * - A site is pinned as its whole enclosing statement, so a long one carries text that has nothing to
 *   do with reaching a file. The SQLite adapter is the case in the bundle: its two engine imports pin
 *   the entire openDatabase initialiser, and editing anything inside it asks for a snapshot update.
 *   Splitting the holder finer would hide which condition guards which import, which is the thing
 *   round 3 found worth pinning, so the noisy update is the deliberate trade.
 * - Whitespace is collapsed outside string, template and regular-expression literals and preserved
 *   inside them, so a reformat that moves a line break into a pinned statement asks for a snapshot
 *   update it does not strictly need. Splitting an argument list over lines and spacing out `${ x }`
 *   both cost one. That is the price of never removing whitespace, which is what let an earlier
 *   version read `${root}` and `$ {root}` as the same approved string.
 * - This guards against mistakes, not against a member written to defeat it. A member that writes a
 *   complete forged closure-report.json and exits, or that replaces fs with a facade satisfying both
 *   the probe and its control, would pass. Both need the member to know this file; neither is a shape
 *   anyone reaches by accident, and defending them would buy nothing a reviewer does not already do.
 * - The pin does not judge a site; it makes a change visible. A snapshot updated without looking is
 *   the residual risk, and that is a review risk rather than a parsing one.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY = path.resolve(HERE, "..", "..");
const {RUNTIME_PATHS} = WINDOWS_BASELINE_RUNTIME_BUNDLE_CONSTANTS;
const MEMBERS = RUNTIME_PATHS.filter(name => name.endsWith(".mjs"));
const CONTROLLERS = RUNTIME_PATHS.filter(name => name.endsWith(".ps1"));
const LOAD_TIMEOUT_MILLISECONDS = 60_000;
const REPORT_NAME = "closure-report.json";
const PROBE_SENTINEL = "closure-probe-reached-operations";

/* A string that names a script, and the PowerShell tokens that reach one. */
const NAMES_A_SCRIPT = /\.(?:m?js|cjs|ps1|psm1|psd1)(?![\w])/iu;
const CONTROLLER_TRIGGER =
    /\.(?:ps1|psm1|psd1|m?js|cjs)\b|Import-Module|\$PSScriptRoot|\$PSCommandPath|\$MyInvocation|Invoke-Expression|using module/iu;
/* Asking where you are is how you reach a sibling, so it is pinned like naming one. */
const LOCATION_NAMES = new Set(["__dirname", "__filename", "require", "createRequire"]);
const PROCESS_LOCATION = new Set(["argv", "cwd", "execPath"]);

const sourceOf = member => fs.readFileSync(path.join(REPOSITORY, member), "utf8");

const PROBE = `
import fs from "node:fs"; import path from "node:path"; import {pathToFileURL} from "node:url";
const root = process.cwd(), url = m => pathToFileURL(path.join(root, ...m.split("/"))).href;
const report = {imports: {}, probes: {}};
const brief = e => (e?.code ? e.code + ": " : "") + String(e?.message ?? e).split("\\n")[0];
for (const m of JSON.parse(process.env.BUNDLE_MEMBERS)) {
  try { await import(url(m)); report.imports[m] = "ok"; }
  catch (e) { report.imports[m] = "FAIL " + brief(e); }
}
if (Object.values(report.imports).every(v => v === "ok")) {
  try {
    const {checkResetDatabase} = await import(url("scripts/qualification/sqlite-check.mjs"));
    const v = await checkResetDatabase(":memory:");
    report.probes.sqlite = JSON.stringify(v) === '{"integrity":"ok","configTable":false}'
      ? "ok" : "FAIL " + JSON.stringify(v);
  } catch (e) { report.probes.sqlite = "FAIL " + brief(e); }
  try {
    const {runMacosRuntimeIsolation} = await import(url("scripts/qualification/check-artifact.mjs"));
    let loads = 0;
    const v = await runMacosRuntimeIsolation({platform: "win32"}, {loadIsolationProbe: () => {
      loads += 1; return Promise.reject(new Error("probe loaded on win32")); }});
    report.probes.macos = v === null && loads === 0 ? "ok"
      : "FAIL value=" + JSON.stringify(v) + " loads=" + loads;
  } catch (e) { report.probes.macos = "FAIL " + brief(e); }
  try {
    const {executeWindowsBaselineGuest} =
      await import(url("scripts/qualification/windows-baseline-guest-executor.mjs"));
    const sha = "0".repeat(64), controller = {bytes: "2", sha256: sha};
    const out = await executeWindowsBaselineGuest(
      {requestPath: "request", expectedRequestSha256: sha, executionPath: "execution",
       expectedExecutionSha256: sha, resultPath: "result"},
      {assertGuest: async () => {}, readJson: (i, label) => label.includes("execution")
         ? {candidateController: controller, cleanStopController: controller} : {},
       writeResult: () => {}, createOperations: () => { throw new Error(${JSON.stringify(PROBE_SENTINEL)}); },
       runtimeConfiguration: {powershellPath: "powershell.exe"}});
    report.probes.wrapper = out?.result?.failure === ${JSON.stringify(PROBE_SENTINEL)}
      ? "ok" : "FAIL " + JSON.stringify(out?.result);
  } catch (e) { report.probes.wrapper = "FAIL " + brief(e); }
}
fs.writeFileSync(path.join(root, ${JSON.stringify(REPORT_NAME)}), JSON.stringify(report));
`;

/*
 * Copies the bundle into a bare directory and imports it in one child process. The child gets the
 * runner's own node - which both seal batteries pin to the guest's version - with NODE_OPTIONS and
 * NODE_PATH stripped, no repository, and none of the test harness's loader hooks. That is the guest.
 */
const loadBundle = (omit = null) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-bundle-closure-"));
    try {
        for (const member of RUNTIME_PATHS) {
            if (member === omit) continue;
            const target = path.join(root, ...member.split("/"));
            fs.mkdirSync(path.dirname(target), {recursive: true});
            fs.copyFileSync(path.join(REPOSITORY, member), target);
        }
        /* Includes the filesystem root: a package at / would resolve for the child like any other. */
        for (let ancestor = root; ; ancestor = path.dirname(ancestor)) {
            assert.ok(!fs.existsSync(path.join(ancestor, "node_modules")),
                `${ancestor} has node_modules, so this cannot prove the bundle stands alone`);
            if (ancestor === path.dirname(ancestor)) break;
        }
        const environment = {...process.env, BUNDLE_MEMBERS: JSON.stringify(MEMBERS)};
        delete environment.NODE_OPTIONS;
        delete environment.NODE_PATH;
        const result = spawnSync(process.execPath,
            ["--input-type=module", "--unhandled-rejections=strict",
                "--disable-warning=ExperimentalWarning", "-e", PROBE],
            {cwd: root, env: environment, encoding: "utf8",
                timeout: LOAD_TIMEOUT_MILLISECONDS, killSignal: "SIGKILL"});
        const tail = () => String(result.stderr ?? "").split(/\r?\n/u).slice(-3).join(" | ");
        /*
         * A child that writes a good report and then fails - a nonzero exit, a leaked handle killed
         * at the timeout, a shutdown hook that throws - was accepted before this check. The report
         * is only believable if the process that wrote it finished cleanly.
         */
        assert.equal(result.error, undefined, `the bundle load could not run: ${result.error}`);
        assert.equal(result.signal, null, `the bundle load was killed with ${result.signal}: ${tail()}`);
        assert.equal(result.status, 0, `the bundle load exited ${result.status}: ${tail()}`);
        const reportPath = path.join(root, REPORT_NAME);
        assert.ok(fs.existsSync(reportPath), `the bundle load produced no report: ${tail()}`);
        const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
        /* An empty inventory must not read as "nothing failed". */
        assert.deepEqual(Object.keys(report.imports).sort(),
            MEMBERS.filter(member => member !== omit).sort(),
            "the bundle load did not report on every member");
        return report;
    } finally {
        fs.rmSync(root, {recursive: true, force: true});
    }
};

const treeOf = (source, label) => {
    try {
        return parse(source,
            {ecmaVersion: "latest", sourceType: "module", range: true, comment: true});
    } catch (error) {
        const where = error.lineNumber === undefined ? "" : ` at line ${error.lineNumber}:${error.column}`;
        throw new Error(`${label} could not be parsed${where}: ${error.message}`, {cause: error});
    }
};

const walk = (node, visit, ancestors = []) => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
        for (const child of node) walk(child, visit, ancestors);
        return;
    }
    const inside = typeof node.type === "string" ? (visit(node, ancestors), [...ancestors, node]) : ancestors;
    for (const key of Object.keys(node)) {
        if (key !== "parent" && key !== "comments") walk(node[key], visit, inside);
    }
};

const SITE_HOLDERS = new Set(["Property", "VariableDeclarator", "AssignmentExpression", "AssignmentPattern",
    "ExpressionStatement", "ReturnStatement", "ThrowStatement", "ExportDefaultDeclaration"]);

/*
 * Collapses the whitespace a formatter owns - indentation, line breaks between arguments - and
 * nothing else. An earlier version also stripped spaces around punctuation, which erased the
 * difference between `${root}` and `$ {root}`: one interpolates, the other is a literal dollar and
 * brace, and both normalised to the same approved string. Characters inside a literal are never
 * touched, because a space there is part of the value rather than of the layout.
 */
const normalise = (text, protectedRanges = [], offset = 0) => {
    let out = "";
    let whitespace = false;
    for (let index = 0; index < text.length; index += 1) {
        const at = offset + index;
        const inside = protectedRanges.some(([from, to]) => at >= from && at < to);
        if (!inside && /\s/u.test(text[index])) { whitespace = true; continue; }
        if (whitespace && out !== "") out += " ";
        whitespace = false;
        out += text[index];
    }
    return out.trim();
};

/*
 * Module-level constants whose initialiser already names a script or asks where the module is. A
 * filename moved into a constant is ordinary refactoring, so a use of that constant is a site too.
 * Function bodies are not descended into: a local binding is pinned where it is introduced.
 */
const taintedNames = (tree, blanked) => {
    const tainted = new Set();
    let changed = true;
    while (changed) {
        changed = false;
        for (const node of tree.body) {
            const declaration = node.type === "ExportNamedDeclaration" ? node.declaration : node;
            if (declaration?.type !== "VariableDeclaration") continue;
            for (const declarator of declaration.declarations) {
                if (declarator.id.type !== "Identifier" || tainted.has(declarator.id.name)) continue;
                const initialiser = declarator.init;
                if (initialiser === null || initialiser === undefined) continue;
                if (["ArrowFunctionExpression", "FunctionExpression"].includes(initialiser.type)) continue;
                const text = blanked.slice(...initialiser.range);
                if (NAMES_A_SCRIPT.test(text) || /import\s*\.\s*meta/u.test(text)
                    || [...LOCATION_NAMES].some(name => new RegExp(`\\b${name}\\b`, "u").test(text))
                    || [...tainted].some(name => new RegExp(`\\b${name}\\b`, "u").test(text))) {
                    tainted.add(declarator.id.name);
                    changed = true;
                }
            }
        }
    }
    return tainted;
};

/*
 * Comments are blanked, never removed, so ranges stay valid and a comment can never be pinned. The
 * replace is deliberately not unicode-aware: espree measures ranges in UTF-16 code units, and a `u`
 * flag would match an astral character as one unit and blank it to one space, shortening the text
 * and sliding every later range. Line breaks are kept so a line number still means something.
 */
const blankComments = (source, comments) => {
    let blanked = source;
    for (const comment of comments ?? []) {
        blanked = blanked.slice(0, comment.range[0])
            + blanked.slice(...comment.range).replace(/[^\n]/g, " ")
            + blanked.slice(comment.range[1]);
    }
    assert.equal(blanked.length, source.length, "blanking comments moved the source ranges");
    return blanked;
};

/* Every expression that names a script or asks where the module is, as source text. */
const sitesOfSource = (source, label = "source") => {
    const tree = treeOf(source, label);
    const blanked = blankComments(source, tree.comments);
    const tainted = taintedNames(tree, blanked);
    /*
     * A regular expression is a literal too: `/ +/` and `/  +/` turn "a b.ps1" into different file
     * names, and collapsing the space inside them would pin both as the same text.
     */
    const protectedRanges = [];
    walk(tree, node => {
        const literal = node.type === "Literal"
            && (typeof node.value === "string" || node.regex !== undefined);
        if (literal || node.type === "TemplateLiteral") protectedRanges.push(node.range);
    });
    const found = new Map();
    walk(tree, (node, ancestors) => {
        const parent = ancestors.at(-1);
        let triggered = false;
        if (node.type === "Literal" && typeof node.value === "string") {
            /* The loader owns import specifiers; pinning them too would double every change. */
            const owned = ["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"]
                .includes(parent?.type) && parent.source === node;
            /*
             * process["cwd"] reaches the same place as process.cwd, but espree calls the property a
             * string rather than an identifier, so the location check below never sees it.
             */
            const location = parent?.type === "MemberExpression" && parent.computed
                && parent.property === node && parent.object?.name === "process"
                && PROCESS_LOCATION.has(node.value);
            triggered = !owned && (location || NAMES_A_SCRIPT.test(node.value));
        } else if (node.type === "TemplateElement") {
            /*
             * The cooked value is what the file name actually is: `x.ps1` is a .ps1 at run time
             * and matches nothing as written. A string literal is already read cooked; a template is
             * the only place the raw text was being trusted on its own.
             */
            triggered = NAMES_A_SCRIPT.test(node.value.raw)
                || NAMES_A_SCRIPT.test(node.value.cooked ?? "");
        }
        else if (node.type === "MetaProperty") triggered = true;
        else if (node.type === "ImportExpression") {
            /*
             * A dynamic import of a real builtin reaches no file, so pinning it would charge a
             * snapshot update for `import("node:fs")` and teach the next reader that updates are
             * routine. Everything else - a sibling, a package, bun:sqlite - is a site.
             */
            const specifier = node.source.type === "Literal" ? node.source.value : null;
            triggered = typeof specifier !== "string" || !isBuiltin(specifier);
        }
        else if (node.type === "Identifier") {
            const named = parent?.type === "MemberExpression" && parent.property === node && !parent.computed;
            const key = parent?.type === "Property" && parent.key === node && !parent.computed;
            triggered = !named && !key && (LOCATION_NAMES.has(node.name) || tainted.has(node.name));
            if (named && PROCESS_LOCATION.has(node.name) && parent.object?.name === "process") triggered = true;
        }
        if (!triggered) return;
        const holder = [...ancestors].reverse().find(candidate => SITE_HOLDERS.has(candidate.type)
            || /(?:Statement|Declaration)$/u.test(candidate.type)) ?? node;
        const range = holder.type === "IfStatement" || holder.type === "WhileStatement"
            ? [holder.range[0], holder.test.range[1] + 1]
            : holder.range;
        found.set(range[0], normalise(blanked.slice(...range), protectedRanges, range[0]));
    });
    return [...found.entries()].sort(([left], [right]) => left - right).map(([, text]) => text);
};

const sitesOf = member => sitesOfSource(sourceOf(member), member);

/*
 * A controller line is pinned whole and only trimmed. Collapsing runs of whitespace the way a module
 * site is collapsed would read `"$PSScriptRoot\a  b.ps1"` and `"$PSScriptRoot\a b.ps1"` as the same
 * approved line, and there is no AST here to say which spaces are inside a string. Indentation is the
 * only whitespace a PowerShell formatter owns on these lines, and trimming removes exactly that.
 */
const linesOfSource = source => source.split(/\r?\n/u)
    .filter(line => CONTROLLER_TRIGGER.test(line))
    .map(line => line.trim());

const linesOf = controller => linesOfSource(sourceOf(controller));

const compare = (file, actual, expected) => {
    if (JSON.stringify(actual) === JSON.stringify(expected)) return;
    const added = actual.filter(entry => !expected.includes(entry));
    const removed = expected.filter(entry => !actual.includes(entry));
    assert.fail(`${file} changed where it names a script or asks where it is.\n`
        + `${added.map(entry => `  + ${entry}`).join("\n")}\n`
        + `${removed.map(entry => `  - ${entry}`).join("\n")}\n`
        + "If every added entry is correct inside the guest, replace this file's list with:\n"
        + `${JSON.stringify(actual, null, 4)}\n`
        + "Each entry is a place this file names a script or its own location. Look before pasting.");
};

/*
 * Exported so the snapshot can be regenerated with exactly the functions that check it. A generator
 * that drifts from its checker is the oldest way to write a test that proves nothing.
 */
export {blankComments, sitesOf, sitesOfSource, linesOf, linesOfSource};

/* Approved sites, keyed by base name. Regenerate only by reading the diff the failure prints. */
const SITES = Object.freeze(JSON.parse(fs.readFileSync(
    path.join(HERE, "windowsBaselineGuestRuntimeBundleClosure.sites.json"), "utf8")));

describe("Windows baseline guest runtime bundle closure", () => {
    let report = null;
    before(() => { report = loadBundle(); });

    it("loads with nothing but the bundle, laid out as the guest lays it out", () => {
        assert.deepEqual(Object.entries(report.imports).filter(([, verdict]) => verdict !== "ok"), []);
    });

    it("opens SQLite through the shim's Node branch", () => assert.equal(report.probes.sqlite, "ok"));

    it("never loads the macOS probe on win32", () => assert.equal(report.probes.macos, "ok"));

    it("reads its PowerShell wrapper from its own directory", () =>
        assert.equal(report.probes.wrapper, "ok"));

    /*
     * The probe above passes when the executor reaches the injected operations, which it would also
     * do if it never opened the wrapper at all. Removing the wrapper from the copied tree is the
     * control that tells those apart: if this still passes, the probe above proves nothing.
     */
    it("fails that read when the wrapper is missing, so the probe is not vacuous", () => {
        const without = loadBundle("scripts/qualification/windows-baseline-guest-candidate-wrapper.ps1");
        /* Every module still loads, so the verdict below is the read and not a collapsed import. */
        assert.deepEqual(Object.entries(without.imports).filter(([, verdict]) => verdict !== "ok"), []);
        assert.match(without.probes.wrapper,
            /^FAIL\b.*\bENOENT\b.*windows-baseline-guest-candidate-wrapper\.ps1/su,
            "the wrapper probe did not fail on the missing wrapper, so it proves nothing");
    });

    /*
     * Every pin is a slice of the blanked source at a range espree measured on the original, so the
     * two must agree on what a position is. Espree counts UTF-16 code units; a unicode-aware replace
     * treats an astral character as one match and blanks it to one space, which shortens the text and
     * slides every later range by one. The pin then comes from the wrong bytes, and a renamed field
     * next to an emoji comment can keep its approved text while the request it builds is broken.
     */
    it("blanks a comment without moving the ranges after it", () => {
        const source = `/* \u{1F680} */\nconst NAME = "windows-clean-stop-controller.ps1";\n`;
        const tree = parse(source,
            {ecmaVersion: "latest", sourceType: "module", range: true, comment: true});
        const blanked = blankComments(source, tree.comments);
        assert.equal(blanked.length, source.length,
            "blanking changed the length, so every range after the comment now reads the wrong bytes");
        assert.equal(blanked.slice(...tree.body[0].declarations[0].init.range),
            `"windows-clean-stop-controller.ps1"`);
        assert.doesNotMatch(blanked, /\u{1F680}/u, "the comment survived blanking");
    });

    /*
     * Approving a site approves its text, so two sources that reach different files must never
     * produce the same text. Both of these differ only in whitespace a literal owns, and both build
     * a different file name from it.
     */
    it("keeps the whitespace a literal owns, so two spellings never share a pin", () => {
        assert.notDeepEqual(
            sitesOfSource(`const name = "a b.ps1".replace(/ +/gu, "_");`),
            sitesOfSource(`const name = "a b.ps1".replace(/  +/gu, "_");`),
            "two regular expressions that build different names share one approved pin");
        assert.notDeepEqual(
            linesOfSource(String.raw`. "$PSScriptRoot\a b.ps1"`),
            linesOfSource(String.raw`. "$PSScriptRoot\a  b.ps1"`),
            "two controller lines that reach different scripts share one approved pin");
    });

    /*
     * Two spellings that reach the same place as a site the suite already sees. A member edited into
     * either of these would drop out of the snapshot silently, because nothing else in the file would
     * change: the escape cooks to a script name only at run time, and the computed property is a
     * string rather than the identifier the location check reads.
     */
    it("sees a location and a script name through the spellings that hide them", () => {
        assert.notDeepEqual(sitesOfSource(`const base = path.join(process["cwd"](), name);`), [],
            "a computed process location reaches the module's directory unpinned");
        assert.notDeepEqual(sitesOfSource(`const first = process["argv"][2];`), [],
            "a computed process argv reaches a caller-supplied path unpinned");
        assert.notDeepEqual(sitesOfSource("const s = `./review-missing.\\u0070s1`;"), [],
            "an escaped script name in a template is invisible until it is read");
    });

    it("names scripts and its own location only at approved sites", () => {
        for (const member of MEMBERS) {
            compare(member, sitesOf(member), SITES.members[member.split("/").at(-1)] ?? []);
        }
    });

    it("mentions scripts in its controllers only on approved lines", () => {
        for (const controller of CONTROLLERS) {
            compare(controller, linesOf(controller), SITES.controllers[controller.split("/").at(-1)] ?? []);
        }
    });

    it("checks every file the bundle declares", () => {
        assert.equal(MEMBERS.length + CONTROLLERS.length, RUNTIME_PATHS.length,
            "the bundle should carry only modules and PowerShell controllers");
        assert.deepEqual(Object.keys(SITES.members).sort(),
            MEMBERS.map(member => member.split("/").at(-1)).sort());
        assert.deepEqual(Object.keys(SITES.controllers).sort(),
            CONTROLLERS.map(controller => controller.split("/").at(-1)).sort());
    });
});
