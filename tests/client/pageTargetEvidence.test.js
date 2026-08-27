import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../helpers/source.js";
import { pageTarget, resolveLimits } from "@/common/utils/TargetUtil.js";

const context = readSource("client/src/common/contexts/Targets/TargetsContext.jsx");
const statistics = readSource("client/src/pages/Statistics/Statistics.jsx");
const controller = readSource("server/controller/speedtests.js");

/**
 * The expression that follows `opening`, up to the first `;` or `,` written at
 * the top level of it.
 *
 * The reported bug is a wiring bug: both ends were right and the argument
 * between them was missing, so every assertion about either end passed while
 * the page graded a deleted target's rows against the surviving target's
 * optima. An assertion about wiring has to run the wiring, and the two
 * expressions that are the whole path both live in files node cannot parse -
 * one inside a JSX component body, one inside a useMemo in a provider. Lifting
 * the expression itself out as text and evaluating it with a closure of its own
 * inputs is what loadRaces.test.js already does for the same reason; this
 * carries the expression rather than a braced body, because neither of these is
 * a braced function.
 *
 * Depth is tracked across all three bracket kinds and quotes are skipped, so an
 * argument list or an object literal inside the expression does not end it
 * early - `resolveLimits(pageTargetFor(x), config ?? {})` holds both.
 */
const expressionAfter = (source, opening) => {
    const start = source.indexOf(opening);
    assert.notEqual(start, -1, `"${opening}" is not in this source`);

    const from = start + opening.length;
    let depth = 0;
    let quote = null;

    for (let index = from; index < source.length; index++) {
        const character = source[index];

        if (quote !== null) {
            if (character === "\\") index++;
            else if (character === quote) quote = null;
            continue;
        }

        if (character === '"' || character === "'" || character === "`") quote = character;
        else if ("([{".includes(character)) depth++;
        else if (")]}".includes(character)) depth--;
        else if ((character === ";" || character === ",") && depth === 0)
            return source.slice(from, index);
    }

    throw new Error(`"${opening}" is never closed`);
};

/** That expression, made callable with the names it reads supplied by hand. */
const evaluate = (expression, closure) => {
    const names = Object.keys(closure);
    return new Function(...names, `return (${expression});`)(...names.map((name) => closure[name]));
};

const TARGET = {id: 1, optimalDownload: "500", optimalUpload: "50", optimalPing: "5"};
const GLOBAL = {ping: "25", download: "100", upload: "50"};

/**
 * The page grades against the rows it was actually given.
 *
 * A single-target instance still holds every row of every target it deleted,
 * and every row an import brought back with no target at all, and nothing
 * narrows its query - so "one target is configured" was being read as "every
 * figure on this page is that target's". The fix carries the page's own
 * evidence from the payload to the helper, and the connection between them is
 * exactly two expressions: drop the argument at either end and the whole suite
 * stays green while the bug is fully back. These run those two expressions.
 */
describe("the statistics page grades against the rows it was actually given", () => {
    // The provider's half: the list, the preference and the node are its to
    // answer, the evidence is the caller's.
    const providerSide = expressionAfter(context, "pageTargetFor:");

    const pageTargetForOn = (list, presentTargetIds) => evaluate(providerSide, {
        pageTarget, list, preferences: {}, currentNode: null
    })(presentTargetIds);

    // The page's half, lifted from the component body it is written in.
    const pageSide = expressionAfter(statistics, "const gradeLimits =");

    const gradeLimitsOn = (deferred, inFlight = deferred) => evaluate(pageSide, {
        resolveLimits,
        pageTargetFor: (ids) => pageTargetForOn([TARGET], ids),
        deferredStatistics: deferred,
        statistics: inFlight,
        config: GLOBAL
    });

    it("hands the page's own targets to the helper rather than a finished verdict", () => {
        assert.equal(pageTargetForOn([TARGET], [1, null]), null,
            "a provider that answers a finished pageTarget cannot carry evidence at all, "
            + "which is the shape a revert restores");
        assert.deepEqual(pageTargetForOn([TARGET], [1]), TARGET);
    });

    it("grades a sole target's own rows against that target", () => {
        assert.deepEqual(gradeLimitsOn({targetIds: [1]}),
            {ping: "5", download: "500", upload: "50"});
    });

    it("grades a page holding a deleted target's rows against the global settings", () => {
        assert.deepEqual(gradeLimitsOn({targetIds: [1, null]}), GLOBAL,
            "the reported bug: a 500 Mbit/s average of rows that were never this "
            + "target's read as half of its 940 - drop the argument between these two "
            + "expressions and this is the assertion that comes back");
    });

    it("keeps the shortcut where the payload says nothing", () => {
        assert.deepEqual(gradeLimitsOn({}), {ping: "5", download: "500", upload: "50"},
            "a parent proxying to a node older than the field, and every first render, "
            + "must grade as before rather than flicker");
        assert.deepEqual(gradeLimitsOn(undefined), {ping: "5", download: "500", upload: "50"});
    });

    it("grades the payload the cards are drawn from, not the one in flight", () => {
        assert.deepEqual(gradeLimitsOn({targetIds: [1, null]}, {targetIds: [1]}), GLOBAL,
            "taking the numbers from one answer and the verdict from another is how a "
            + "stale range gets judged by the composition of the range replacing it");
    });

    it("is fed by a payload the server actually answers", () => {
        assert.match(controller, /targetIds: targetsPresent\(entries\),/,
            "the evidence has to leave the server for any of the above to matter");
    });
});
