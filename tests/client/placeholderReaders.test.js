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
 * An import from TestUtil, in the forms this tree actually writes.
 *
 * Two of them, because one pattern cannot cover both: the charts import a named
 * list spread over several lines, which nothing anchored to a single line
 * finds, and everything else is one line - through the build alias
 * `@/common/utils/TestUtil` or a relative path carrying its extension.
 */
const FROM_TEST_UTIL = String.raw`from\s*["'][^"']*TestUtil(?:\.js)?["']`;

const TEST_UTIL_IMPORTS = [
    new RegExp(String.raw`import[^\n]*` + FROM_TEST_UTIL),
    new RegExp(String.raw`import\s*\{[\s\S]*?\}\s*` + FROM_TEST_UTIL)
];

const readsTestUtil = ({code}) => TEST_UTIL_IMPORTS.some((pattern) => pattern.test(code));

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
            assert.ok(carrying.some((line) => pattern.test(line)),
                `${file} carries a -1, but on no line ${pattern} matches - the exemption covers nothing, and the -1 it `
                + "was granted for is unaccounted for");
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

    it("does not read a negative fraction as the placeholder", () => {
        for (const arithmetic of ["const nudge = -1.5;", "const span = -1.25;", "const many = -12;"])
            assert.doesNotMatch(arithmetic, BARE_MINUS_ONE,
                `"${arithmetic}" is a number rather than the placeholder, and firing on it is how an exemption gets `
                + "added that turns off a whole file");
    });

    it("still reads every shape the four found readers had", () => {
        for (const reader of [
            "if (tests.indexOf(row) === -1) return null;",
            "const at = -1;",
            "return index === -1 ? null : index;",
            "value: measured ? figure : -1"
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

    it("reads every import form the tree writes", () => {
        const written = [
            'import {isFailedTest} from "@/common/utils/TestUtil";',
            'import { readableFigure } from "../../../utils/TestUtil.js";',
            'import {\n    bufferbloat,\n    isMeasured\n} from "@/common/utils/TestUtil";'
        ];

        for (const form of written)
            assert.ok(readsTestUtil({code: form}), `this import is invisible to the guard:\n${form}`);

        for (const innocent of [
            'const label = "TestUtil";',
            'import {other} from "./Other.js";'
        ])
            assert.equal(readsTestUtil({code: innocent}), false,
                `"${innocent}" is held to a list it does not belong on`);
    });
});
