import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { walkSources, withoutJsComments } from "../helpers/source.js";

/**
 * The tripwire against the next private placeholder reader.
 *
 * Four review rounds in a row found another spelling of "is this the -1 a
 * failed test stores?" hiding in a component - each one a place where a
 * legacy-restored row's text spelling, or the placeholder itself, was judged
 * by a rule the file beside it had already outgrown. The judgement has one
 * home (TestUtil's storedFigure and the readers built on it), so a new bare
 * -1 in the measurement-rendering trees is either a new private reader or a
 * new sentinel - and both belong in that home.
 *
 * Comments are stripped before scanning, so prose about the placeholder stays
 * free. The scan is a budget, not a proof: a reader can still hide behind a
 * named constant or an imported alias. What it does catch is exactly the
 * shape every one of the four found readers actually had - a bare -1 compared
 * or assigned in component code.
 *
 * Two things sharpen it past a list of trees.
 *
 * An exemption names a line rather than a file. Written file-wide, the two
 * entries below turned the budget off over the whole of TestUtil.js and the
 * whole of TestAreaComponent.jsx - and TestUtil is precisely the file a new
 * sentinel is most likely to be added to, since it is the file where sentinels
 * belong. What is exempt now is the construct that was actually granted; a
 * second -1 in either file is still a failure.
 *
 * And the list of trees is held to the import graph instead of to memory. A
 * tree gets added when a review finds a reader in it, so the list is only ever
 * as complete as the last review. The guard at the bottom asks the opposite
 * question - which files read TestUtil at all - and makes every one of them
 * either scanned or written down with a reason.
 */
const CLIENT_SRC = "client/src";

/** Every client source, named the way the lists below name it, raw and stripped. */
const CLIENT_FILES = walkSources(CLIENT_SRC).map(({path, source}) => ({
    file: path.slice(CLIENT_SRC.length + 1),
    source,
    code: withoutJsComments(source)
}));

const filesIn = (tree) => CLIENT_FILES.filter(({file}) => file.startsWith(`${tree}/`));

const fileAt = (name) => CLIENT_FILES.find(({file}) => file === name);

// The trees that render measurements. Dialogs, contexts and generic widgets
// use -1 as an index sentinel all over, legitimately; the budget watches the
// code that reads stored test rows.
const MEASUREMENT_TREES = [
    "pages/Statistics/charts",
    "pages/Home/components",
    "pages/Nodes/components",
    "common/components/TestDetails",
    // Added by the guard at the bottom of this file rather than by a review:
    // the bar reads isFailedTest to colour itself, and was in no tree here.
    "common/components/StatusBar",
    // The renderer every figure-beside-unit goes through. It reads FormatUtil
    // rather than TestUtil, so the import-graph guard below cannot see it -
    // and the one file every measurement renders through is exactly where a
    // private reader must not hide.
    "common/components/FigureWithUnit",
    "common/utils"
];

/**
 * Every allowed -1, as the line it is allowed on and the reason it is allowed
 * there.
 *
 * A new entry needs both: a pattern narrow enough to name one construct, and a
 * reason that is not "it reads a test column", because that reading lives in
 * TestUtil.
 */
const ALLOWED = new Map([
    ["common/utils/TestUtil.js", {
        pattern: /FAILED_TEST = -1/,
        reason: "the sentinel's home: the declaration itself, and the readers built on it"
    }],
    ["pages/Home/components/TestArea/TestAreaComponent.jsx", {
        pattern: /roundIndexById\(targets, test\.targetId\) : -1/,
        reason: "a chart index for a row outside the drawn window"
    }]
]);

/**
 * The files that read TestUtil without drawing a measurement.
 *
 * They are not in the trees above and are not being moved into them: a reason
 * here says what the file does with what it imported, and "renders
 * measurements" is the one thing it cannot say - a file that does belongs in a
 * tree, where the budget can see it.
 */
const NON_RENDERING = new Map([
    ["pages/Statistics/Statistics.jsx",
        "orchestrates the charts and hands previousConnection down to them; draws no figure of its own"],
    ["common/components/OptimalValuesDialog/OptimalValuesDialog.jsx",
        "validates the thresholds an operator types, with isThresholdNumber"],
    ["common/components/WelcomeDialog/welcomeStep.js",
        "decides whether the wizard's threshold step may be left, with the same check"]
]);

/**
 * A bare -1, and only a bare one.
 *
 * The lookbehind keeps `x-1` and `props.at-1` out, which are arithmetic. The
 * lookahead is the other half and was missing: a word boundary sits after the
 * 1 of -1.5 exactly as readily as after the 1 of -1, so every negative fraction
 * beginning with a one was read as the placeholder. A budget that fires on
 * arithmetic is a budget that gets an entry added to ALLOWED to quieten it, and
 * every entry added for that reason turns off a real file.
 */
const BARE_MINUS_ONE = /(?<![\w.])-1(?![\d.])/;

/**
 * Which modules hold TestUtil's readers, resolved rather than pattern-matched.
 *
 * A path-substring pattern knew only direct imports, so a BARREL - a module
 * re-exporting the readers - handed every one of its importers a specifier
 * the guard could not see. And the two-statement spelling (import on one
 * line, `export {name}` on the next) is exactly the barrel someone would
 * write, invisible to any export-from pattern. So the guard resolves real
 * specifiers now: the reader set starts at TestUtil and grows to a fixpoint
 * over both barrel forms, and "reads TestUtil" means "imports anything that
 * resolves into that set".
 *
 * The stated bound: a re-export through a namespace (`import * as U` then
 * exporting U or its members) or an aliasing assignment (`export const mine =
 * readableFigure`) is out of textual reach. Named-binding barrels - both
 * spellings - are the shapes a tree actually grows, and both fail loudly.
 */
const READER_HOME = "common/utils/TestUtil.js";

const FILE_SET = new Set(CLIENT_FILES.map(({file}) => file));

// Assets and styles are imported by path too; they hold no bindings.
const NON_JS = /\.(?:sass|css|json|webp|png|svg|jpe?g|gif|ico)$/;

/**
 * A specifier as the client file it names, null for packages and assets.
 *
 * Loud for a local js-like specifier that resolves to nothing: that is a
 * moved file, and a guard that silently skips it is a guard with a hole
 * shaped like the next rename.
 */
const resolveSpecifier = (importer, specifier) => {
    const parts = specifier.startsWith("@/")
        ? specifier.slice(2).split("/")
        : (() => {
            if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;

            const stack = importer.split("/").slice(0, -1);
            for (const segment of specifier.split("/")) {
                if (segment === "." || segment === "") continue;
                if (segment === "..") stack.pop();
                else stack.push(segment);
            }
            return stack;
        })();

    if (parts === null) return null;

    const base = parts.join("/");
    for (const candidate of [base, `${base}.js`, `${base}.jsx`, `${base}/index.js`, `${base}/index.jsx`])
        if (FILE_SET.has(candidate)) return candidate;

    if (NON_JS.test(base)) return null;

    throw new Error(`${importer} imports "${specifier}", which resolves to no client source - `
        + "a moved file leaves this guard with a hole shaped like the rename");
};

// Every from-specifier a module writes, import and export-from alike; the
// braces admit no `;` or `}`, so a lazy bridge cannot span statements.
const specifiersOf = (code) => [
    ...code.matchAll(/(?:import|export)[^\n"']*from\s*["']([^"']+)["']/g),
    ...code.matchAll(/(?:import|export)\s*\{[^};]*\}\s*from\s*["']([^"']+)["']/g)
].map((match) => match[1]);

/** Form (a): an export-from whose specifier lands in the reader set. */
const reExportsFrom = ({file, code}, targets) => [
    ...code.matchAll(/export[^\n"']*from\s*["']([^"']+)["']/g),
    ...code.matchAll(/export\s*\{[^};]*\}\s*from\s*["']([^"']+)["']/g)
].some((match) => targets.has(resolveSpecifier(file, match[1])));

/**
 * Form (b): names imported from the reader set that the module exports
 * again - the two-statement barrel. Local bindings (after `as`) on the
 * import side, local halves (before `as`) on the export side: ESM forbids
 * shadowing an imported name, so an overlap IS a re-export.
 */
const twoStatementBarrelNames = ({file, code}, targets) => {
    const locals = [...code.matchAll(/import\s*\{([^};]*)\}\s*from\s*["']([^"']+)["']/g)]
        .filter((match) => targets.has(resolveSpecifier(file, match[2])))
        .flatMap((match) => match[1].split(","))
        .map((binding) => (binding.split(/\bas\b/)[1] ?? binding).trim())
        .filter(Boolean);

    const exported = [...code.matchAll(/export\s*\{([^};]*)\}(?!\s*from)/g)]
        .flatMap((match) => match[1].split(","))
        .map((binding) => binding.split(/\bas\b/)[0].trim());

    return locals.filter((name) => exported.includes(name));
};

/** The reader set, grown to a fixpoint over both barrel forms. */
const readerSources = (() => {
    const targets = new Set([READER_HOME]);

    let grew = true;
    while (grew) {
        grew = false;
        for (const entry of CLIENT_FILES) {
            if (targets.has(entry.file)) continue;
            if (reExportsFrom(entry, targets) || twoStatementBarrelNames(entry, targets).length > 0) {
                targets.add(entry.file);
                grew = true;
            }
        }
    }

    return targets;
})();

const readsTestUtil = ({file, code}) =>
    specifiersOf(code).some((specifier) => readerSources.has(resolveSpecifier(file, specifier)));

describe("the placeholder is read in one place", () => {
    /**
     * Everything below reads a line at a time, which means something only while
     * the stripper hands back the lines it was given - so it is asked first. A
     * stripper that closed the gaps where the comments had been would move every
     * line under every exemption, and a pattern granted for one construct would
     * quietly start covering another.
     */
    it("is scanned line by line, which the stripper has to keep possible", () => {
        for (const {file, source, code} of CLIENT_FILES)
            assert.equal(code.split("\n").length, source.split("\n").length,
                `${file} comes back from the stripper with a different number of lines, so an exemption granted for `
                + "one line now covers another");
    });

    for (const tree of MEASUREMENT_TREES) {
        it(`${tree} carries no bare -1 outside the allowed lines`, () => {
            const sources = filesIn(tree);

            // A tree that has been renamed or moved walks to nothing, and a
            // budget over no files passes for ever without saying so.
            assert.notEqual(sources.length, 0,
                `${tree} holds no sources; it has been renamed or moved, and the budget over it is silently off`);

            for (const {file, code} of sources) {
                const allowed = ALLOWED.get(file);

                for (const line of code.split("\n")) {
                    if (!BARE_MINUS_ONE.test(line) || allowed?.pattern.test(line)) continue;

                    assert.fail(`${file} carries a bare -1 on "${line.trim()}": a private placeholder reader or a new `
                        + "sentinel, both of which belong in TestUtil - or an index sentinel, which belongs in ALLOWED "
                        + "with the line it sits on and its reason");
                }
            }
        });
    }

    /**
     * An exemption that no longer covers a line has stopped meaning anything,
     * and one whose file has grown a second -1 is worse: it reads as a granted
     * exception while covering a construct nobody granted.
     */
    it("keeps the allowed list honest", () => {
        for (const [file, {pattern}] of ALLOWED) {
            const source = fileAt(file);
            assert.ok(source, `${file} is no longer in the tree; drop it from ALLOWED`);

            const carrying = source.code.split("\n").filter((line) => BARE_MINUS_ONE.test(line));

            assert.notEqual(carrying.length, 0,
                `${file} no longer carries a -1; drop it from ALLOWED so the list stays a list of facts`);
            // Exactly one: an exemption names one construct, and a pattern
            // that has widened to cover a second -1 is a file-wide skip
            // wearing a narrow entry's clothes.
            assert.equal(carrying.filter((line) => pattern.test(line)).length, 1,
                `${file}'s exemption covers ${carrying.filter((line) => pattern.test(line)).length} of its -1 lines `
                + "where one construct was granted - the pattern has widened past what it names");
            assert.doesNotMatch("const somethingElse = -1;", pattern,
                `${file}'s exemption matches a line it was never granted; narrow the pattern to the construct`);
        }
    });

    it("declares the sentinel once", () => {
        for (const tree of MEASUREMENT_TREES)
            for (const {file, code} of filesIn(tree)) {
                if (file === "common/utils/TestUtil.js") continue;

                assert.doesNotMatch(code, /const\s+FAILED_TEST\s*=/,
                    `${file} declares its own FAILED_TEST beside the shared one`);
            }
    });

    // Both halves of the bareness rule, pinned in both directions: the
    // lookbehind keeps subtraction out, the lookahead keeps fractions out,
    // and weakening either turns real code into budget noise - which is how
    // an exemption gets added that turns off a whole file.
    it("does not read arithmetic or a negative fraction as the placeholder", () => {
        for (const arithmetic of [
            "const nudge = -1.5;", "const span = -1.25;", "const many = -12;",
            "const last = width-1;", "const before = arr[at-1];", "const shifted = props.at-1;"
        ])
            assert.doesNotMatch(arithmetic, BARE_MINUS_ONE,
                `"${arithmetic}" is a number rather than the placeholder, and firing on it is how an exemption gets `
                + "added that turns off a whole file");
    });

    it("still reads every shape the four found readers had", () => {
        for (const reader of [
            "if (tests.indexOf(row) === -1) return null;",
            "const at = -1;",
            "return index === -1 ? null : index;",
            "value: measured ? figure : -1",
            "const bounds = [-1];",
            "openAt((-1));"
        ])
            assert.match(reader, BARE_MINUS_ONE, `"${reader}" no longer trips the budget`);
    });
});

/**
 * And the list of trees, held to the import graph rather than to memory.
 *
 * Every tree above was added because a review found a reader in it, which makes
 * the list exactly as complete as the last review. So this asks the other
 * question: which files read TestUtil at all? Each of them either sits in a
 * scanned tree or is written down with a reason - and the next component that
 * imports isFailedTest fails this until someone decides which it is, instead of
 * quietly joining the budget's blind spot.
 *
 * The blind spot was not hypothetical. StatusBar reads isFailedTest to colour
 * the bar and sat in no tree the budget walked.
 *
 * Read from the stripped source, for the reason everything else here is: a file
 * that names TestUtil only in a comment - explaining why it does not read one -
 * would otherwise be held to a list it does not belong on.
 */
describe("every reader of TestUtil is either scanned or accounted for", () => {
    it("places each of them in a tree or in the non-rendering list", () => {
        const unplaced = CLIENT_FILES
            .filter(readsTestUtil)
            .map(({file}) => file)
            .filter((file) => !MEASUREMENT_TREES.some((tree) => file.startsWith(`${tree}/`))
                && !NON_RENDERING.has(file));

        assert.deepEqual(unplaced, [],
            "these files import from TestUtil and sit in no tree the budget walks: add the tree to MEASUREMENT_TREES "
            + "if the file draws a measurement, or the file to NON_RENDERING with what it does with what it imported");
    });

    /**
     * Honest in both directions. An entry that has stopped importing from
     * TestUtil exempts nothing and should go; an entry whose reason says it
     * renders measurements is describing a file that belongs in a tree, and the
     * list would then be the hand-maintained thing it was written to replace.
     */
    it("keeps the non-rendering list honest", () => {
        for (const [file, reason] of NON_RENDERING) {
            const source = fileAt(file);
            assert.ok(source, `${file} is no longer in the tree; drop it from NON_RENDERING`);

            assert.ok(readsTestUtil(source),
                `${file} no longer imports from TestUtil, so listing it exempts nothing`);
            assert.doesNotMatch(reason, /render/i,
                `${file} is excused on the grounds that it draws nothing, and its own reason says it renders: it `
                + "belongs in MEASUREMENT_TREES");
        }
    });

    it("reads every import form the tree writes, and the export forms it could grow", () => {
        // Realistic homes, because the resolver walks real paths: the
        // relative spelling is details.js's own, three directories up to
        // common/utils.
        const written = [
            'import {isFailedTest} from "@/common/utils/TestUtil";',
            {file: "common/components/TestDetails/utils/details.js",
                code: 'import { readableFigure } from "../../../utils/TestUtil.js";'},
            'import {\n    bufferbloat,\n    isMeasured\n} from "@/common/utils/TestUtil";',
            'import * as TestUtil from "@/common/utils/TestUtil";',
            'import TestUtil from "@/common/utils/TestUtil";',
            'export {readableFigure} from "@/common/utils/TestUtil";',
            'export * from "@/common/utils/TestUtil";'
        ];

        for (const form of written) {
            const entry = typeof form === "string" ? {file: "pages/Probe/Probe.jsx", code: form} : form;
            assert.ok(readsTestUtil(entry), `this import is invisible to the guard:\n${entry.code}`);
        }

        for (const innocent of [
            'const label = "TestUtil";',
            'import {other} from "@/common/utils/TargetUtil";',
            // The lazy bridge this pins against: an unrelated export's brace
            // must not reach across statements to a TestUtil import's quote.
            'export {helper};\nconst x = from("TestUtil");'
        ])
            assert.equal(readsTestUtil({file: "pages/Probe/Probe.jsx", code: innocent}), false,
                `"${innocent}" is held to a list it does not belong on`);
    });

    /**
     * And nothing between a component and TestUtil holds the readers at all:
     * the reader set, grown to its fixpoint, is TestUtil alone. A barrel in
     * either spelling - an export-from, or an import re-exported on the next
     * line - hands every importer a specifier the old pattern guard could
     * not see, and the fixpoint is what makes both fail here instead.
     */
    it("finds no barrel for importers to hide behind", () => {
        assert.deepEqual([...readerSources], [READER_HOME],
            "these modules re-export TestUtil's readers, so their importers escape every scan above - "
            + "import directly, or the budget's trees and this guard must learn the barrel in the same change");
    });

    // Both barrel forms, proven on fixtures rather than trusted: the
    // two-statement spelling was the probe that walked straight through the
    // export-from pattern this fixpoint replaced.
    it("detects both barrel spellings", () => {
        const targets = new Set([READER_HOME]);

        assert.ok(reExportsFrom({file: "common/utils/Barrel.js",
            code: 'export {readableFigure} from "@/common/utils/TestUtil";'}, targets));

        assert.deepEqual(twoStatementBarrelNames({file: "common/utils/Barrel.js",
            code: 'import {readableFigure} from "@/common/utils/TestUtil";\nexport {readableFigure};'},
        targets), ["readableFigure"]);

        // The alias travels: what is re-exported is the LOCAL binding.
        assert.deepEqual(twoStatementBarrelNames({file: "common/utils/Barrel.js",
            code: 'import {readableFigure as reader} from "@/common/utils/TestUtil";\nexport {reader};'},
        targets), ["reader"]);

        // Exporting something else entirely is a module, not a barrel.
        assert.deepEqual(twoStatementBarrelNames({file: "common/utils/Own.js",
            code: 'import {isMeasured} from "@/common/utils/TestUtil";\nconst gate = 1;\nexport {gate};'},
        targets), []);
    });

    // The resolver's own contract, at its edges: packages and assets are
    // nobody's reader, and a moved file fails loudly rather than leaving a
    // rename-shaped hole.
    it("resolves specifiers the way the bundler does, and refuses a dangling one", () => {
        assert.equal(resolveSpecifier("pages/Probe/Probe.jsx", "react"), null);
        assert.equal(resolveSpecifier("pages/Probe/Probe.jsx", "./styles.sass"), null);
        assert.equal(resolveSpecifier("pages/Probe/Probe.jsx", "@/common/utils/TestUtil"), READER_HOME);
        assert.equal(resolveSpecifier("common/components/TestDetails/utils/details.js",
            "../../../utils/TestUtil.js"), READER_HOME);
        assert.equal(resolveSpecifier("pages/Probe/Probe.jsx", "@/common/components/TestDetails"),
            "common/components/TestDetails/index.js", "a directory import no longer lands on its barrel");

        assert.throws(() => resolveSpecifier("pages/Probe/Probe.jsx", "./Moved.js"), /resolves to no client source/);
    });
});
