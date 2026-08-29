import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { escapeRegExp, readLocale } from "../helpers/source.js";
import { flatten } from "../../scripts/localeGaps.js";

/**
 * The gluing rule's blind half: a value glued to its % or unit INSIDE a
 * locale string, where no source pattern can look.
 *
 * rawValueRendering holds the components to formatters, but a string like
 * "{{down}} / {{up}} ms latency" does the gluing in the translation file -
 * and that exact key is the shipped "12 /  ms latency" bug the scan's own
 * docblock lists. This file makes every such string a reviewed decision: a
 * glued interpolation must sit in the INVENTORY below with the reason its
 * call sites are safe, so the next one fails until someone has looked.
 *
 * English only, and honestly so: parity holds the other locales to en's KEY
 * set and interpolation names, never to their punctuation - Turkish writes
 * its percent before the value - and en is where a new string enters, since
 * every translation starts from it. What a translator does around the
 * interpolation is importFeedback's per-locale grammar territory, not this
 * file's.
 *
 * The stated bound: an inventory reviews the strings, not the call sites. A
 * component can still hand a raw column to a reviewed key - the reasons
 * below name the gates that make today's call sites safe, and holding those
 * gates in place is the source suites' job.
 */
const en = readLocale("en");

const strings = Object.entries(flatten(en)).filter(([, value]) => typeof value === "string");

// The unit spellings, read out of the file's own *_unit keys so a renamed
// unit cannot leave this alternation naming a word nothing spells - plus the
// bare "s" two duration strings glue inline.
const unitWords = [...new Set(strings
    .filter(([key]) => key.endsWith("_unit"))
    .map(([, value]) => value))];

const PERCENT_ADJACENT = /\{\{\w+\}\}\s?%/;
const UNIT_ADJACENT = new RegExp(`\\{\\{\\w+\\}\\}\\s?(?:${[...unitWords, "s"].map(escapeRegExp).join("|")})\\b`);
// A value glued to an INTERPOLATED unit - the pane's own spelling.
const UNIT_INTERPOLATION = /\{\{\w+\}\}\s?\{\{unit\}\}/;

const GLUED = [PERCENT_ADJACENT, UNIT_ADJACENT, UNIT_INTERPOLATION];

/**
 * Every glued string, and why its call sites are safe. A reason names the
 * gate, because "it renders a measurement" is the one thing it cannot say.
 */
const INVENTORY = new Map([
    ["test.details.of_target",
        "percentOfTarget's output, behind the percent !== null gates in TestDetails and AverageChart"],
    ["test.details.over_target",
        "differenceFromTarget's difference with its unit interpolated, behind the sentence's null gate"],
    ["test.details.under_target",
        "the same construct as over_target, in the other direction"],
    ["latest.bufferbloat",
        "a tooltip fed the already-coerced increase, behind a grade gate"],
    ["latest.loaded_latency",
        "the shipped '12 /  ms latency' shape, kept as a reviewed decision: both directions read through "
        + "the loaded-latency gates before this sentence is asked for"],
    ["info.recommendations_info",
        "recommendation prose over server-computed optima, not stored columns"],
    ["test.details.seconds",
        "rendered behind isMeasured(test.time) in the detail pane"],
    ["test.details.bufferbloat_value",
        "rendered only when bufferbloat() returned a grade"],
    ["statistics.consistency.loaded_latency_average",
        "a tooltip whose increase is coerced at the card's boundary and whose tests is a computed count"],
    ["status.elapsed",
        "a live tick counter - the only no-space UNIT gluing in the file (of_target's percent is the "
        + "no-space other), and never a stored column"]
]);

describe("a locale string that glues a value to its unit is a reviewed decision", () => {
    // A moved locale directory or an empty parse would switch this file off
    // without a word - the floor localeParity keeps, kept here too.
    it("reads the source locale", () => {
        assert.ok(strings.length > 500,
            `en.json flattened to ${strings.length} strings where hundreds exist - the read or the flatten broke`);
        // Exact, like every floor in these suites: a retired *_unit key
        // updates it in the same change rather than silently narrowing the
        // adjacency alternation.
        assert.equal(unitWords.length, 3,
            "the *_unit keys stopped yielding the three unit spellings, so the adjacency pattern drifted");
    });

    it("holds every glued string to the inventory", () => {
        const glued = strings
            .filter(([, value]) => GLUED.some((pattern) => pattern.test(value)))
            .map(([key]) => key);

        for (const key of glued)
            assert.ok(INVENTORY.has(key),
                `"${key}" glues a value to its %% or unit inside the locale string, where no source scan can `
                + "see it: route the value through a formatter and interpolate the result, or add the key here "
                + "with the gate that makes its call sites safe");
    });

    // Honest in both directions, like every inventory in these suites: an
    // entry that stopped gluing - or stopped existing - reviews nothing.
    it("keeps the inventory a list of facts", () => {
        const byKey = new Map(strings);

        for (const [key, reason] of INVENTORY) {
            const value = byKey.get(key);

            assert.ok(value !== undefined, `"${key}" is no longer in en.json; drop it from the inventory`);
            assert.ok(GLUED.some((pattern) => pattern.test(value)),
                `"${key}" no longer glues anything; drop it so the inventory stays a list of facts`);
            assert.ok(reason.length > 0, `"${key}" carries no reason`);
        }
    });

    // The patterns held to the shapes they exist to catch, and to the ones
    // they must leave alone.
    it("recognises the glued shapes and only the glued shapes", () => {
        assert.match("{{percent}}% of your target", PERCENT_ADJACENT);
        assert.match("{{down}} / {{up}} ms latency", UNIT_ADJACENT);
        assert.match("{{seconds}}s elapsed", UNIT_ADJACENT);
        assert.match("{{amount}} {{unit}} over your target", UNIT_INTERPOLATION);

        for (const clean of ["{{percent}} of your target", "Takes {{seconds}} seconds",
            "100% ready", "{{count}} tests", "{{name}} settings"])
            assert.ok(!GLUED.some((pattern) => pattern.test(clean)),
                `"${clean}" glues nothing, and flagging it is how the inventory becomes a list of everything`);
    });
});
