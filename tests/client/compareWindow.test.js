import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoryRouter, useSearchParams } from "react-router-dom";
import { escapeRegExp, readSource, withoutJsComments } from "../helpers/source.js";
import { compile, rules } from "../helpers/sass.mjs";
import { act, cleanup, createElement, render, settle } from "../helpers/renderHarness.js";
import {
    COMPARE_CHOICES, DEFAULT_COMPARE, compareToParams, parseCompareParams, rangeKey
} from "@/common/utils/TimeframeUtil.js";
import { ConfigContext } from "@/common/contexts/Config";
import { NodeContext } from "@/common/contexts/Node";
import { PreferencesContext } from "@/common/contexts/Preferences";
import { StatusContext } from "@/common/contexts/Status";
import { SpeedtestContext } from "@/common/contexts/Speedtests";
import { TargetsContext } from "@/common/contexts/Targets";
import { ThemeContext } from "@/common/contexts/Theme";
import { ToastNotificationContext } from "@/common/contexts/ToastNotification";
import { AlertProvider } from "@/common/contexts/Alert";
import { Statistics } from "@/pages/Statistics/Statistics.jsx";
import { COMPARE_OFFSETS } from "../../server/routes/speedtests.js";

const params = (query) => new URLSearchParams(query);

/**
 * How far back the statistics compare, when the reader says.
 *
 * An offset rather than a window drawn by hand, and that shape is the whole
 * point: both windows are then the range's own length, so they are comparable
 * by construction. A free pair of dates let "August so far" be compared
 * against all of 2025 - two spans of different lengths, which the server's
 * elapsed cut then answered by quietly comparing against the first fortnight
 * of January, disclosed only in a sentence nobody reads.
 *
 * It travels in the URL like the range does, so "this August against last
 * August" stays a link somebody can keep - and unlike a pair of dates it still
 * means the same thing next spring.
 */
describe("parseCompareParams", () => {
    it("reads the choice the URL carries", () => {
        for (const choice of COMPARE_CHOICES)
            assert.equal(parseCompareParams(params(`range=7d&compare=${choice}`)), choice);
    });

    // The default is a real option rather than the absence of one, which is
    // what removed the reset control beside the old picker: there is no state
    // to get back out of.
    it("answers the default for a URL that names none", () => {
        assert.equal(parseCompareParams(params("")), DEFAULT_COMPARE);
        assert.equal(parseCompareParams(params("range=7d")), DEFAULT_COMPARE);
    });

    /**
     * A value nothing knows falls back rather than travelling on. The server
     * refuses what it cannot read - by name, so a typo is not silence - and a
     * hand-edited bookmark should draw the ordinary page rather than a 400.
     */
    it("falls back for a choice nothing offers", () => {
        for (const query of ["compare=18m", "compare=yesterday", "compare=", "compare=PREVIOUS"])
            assert.equal(parseCompareParams(params(query)), DEFAULT_COMPARE, query);
    });
});

describe("compareToParams", () => {
    it("writes the choice back", () => {
        assert.deepEqual(compareToParams("1y"), {compare: "1y"});
    });

    // Absent, not `compare=previous`: the default belongs in no URL, the way
    // the range's own default does not appear in one either.
    it("writes nothing at all for the default", () => {
        assert.deepEqual(compareToParams(DEFAULT_COMPARE), {});
        assert.deepEqual(compareToParams(null), {});
        assert.deepEqual(compareToParams(undefined), {});
    });

    it("survives the round trip", () => {
        for (const choice of COMPARE_CHOICES)
            assert.equal(
                parseCompareParams(params(new URLSearchParams(compareToParams(choice)).toString())),
                choice);
    });
});

/**
 * The client's list and the server's, held to being the same list.
 *
 * The server refuses an offset it does not know, so a choice the dropdown
 * offers and the route has never heard of is a 400 the moment somebody picks
 * it - and the page would show a blank comparison with the reason only in a
 * network tab.
 */
describe("the choices both sides know", () => {
    it("offers exactly what the route accepts", () => {
        assert.deepEqual([...COMPARE_CHOICES].sort(), Object.keys(COMPARE_OFFSETS).sort());
    });

    it("agrees which one is the default", () => {
        assert.equal(COMPARE_OFFSETS[DEFAULT_COMPARE], 0,
            "the client's default is an offset in months rather than the period before");
    });

    // Every other choice is a real distance back, and they are offered in the
    // order they grow: a list that jumped about would read as arbitrary.
    it("orders them by how far back they look", () => {
        const months = COMPARE_CHOICES.map((choice) => COMPARE_OFFSETS[choice]);

        assert.deepEqual(months, [...months].sort((a, b) => a - b));
        assert.equal(new Set(months).size, months.length, "two choices name the same window");
    });
});

/**
 * The pin this whole shape exists for: SpeedtestProvider is mounted above the
 * router outlet, so it is alive on every page, and it rebuilds its query -
 * fetching a page of rows the statistics never show - whenever rangeKey
 * changes. A comparison offset in that key would buy that page of rows on
 * every compare change.
 */
describe("the comparison choice stays out of the range key", () => {
    it("changes nothing about which tests a list holds", () => {
        assert.equal(rangeKey(params("range=7d&compare=1y")), "range=7d",
            "the comparison offset reached the range key, so choosing one re-fetches a page of rows");
    });

    it("still answers for the range itself", () => {
        assert.equal(rangeKey(params("from=2026-08-01&to=2026-08-31&compare=2y")),
            "from=2026-08-01&to=2026-08-31");
    });
});

/**
 * The page's own side of it: which requests carry the choice, and which
 * deliberately do not.
 */
describe("the statistics page and its comparison choice", () => {
    const statistics = readSource("client/src/pages/Statistics/Statistics.jsx");

    // One applier for both request sites, so the page and the comparison card
    // cannot ask different questions of the same window.
    it("asks the same question from one place", () => {
        assert.match(statistics, /const applyCompare = \(query, dateRange, compare\) => \{/);
        assert.match(statistics, /if \(!dateRange\) return query;/,
            "the applier stopped refusing a rangeless request - nothing precedes all time");
        assert.equal((statistics.match(/applyCompare\(query, dateRange, compare\)/g) ?? []).length, 2,
            "the page and the card no longer read the choice through one applier");
    });

    /**
     * The high-resolution series is fetched to draw more points, and a
     * comparison there would be a second table scan for a payload nothing
     * reads.
     */
    it("never compares the detail series", () => {
        const detail = statistics.slice(statistics.indexOf('query.set("points"'),
            statistics.indexOf("}, [wantsDetail, isDownsampled, dateRange, targetFilter, currentNode]);"));

        assert.notEqual(detail.length, 0, "the detail effect moved; re-anchor this lift");
        assert.doesNotMatch(detail, /applyCompare|compare/,
            "the detail fetch buys a comparison nothing on screen reads");
    });

    it("draws the row for any bounded range", () => {
        assert.match(statistics,
            /const compareRow = dateRange \? \(\s*<div className="statistics-compare-row">/);
    });

    /**
     * And the row reaches the page by being handed to the toolbar, not by
     * being drawn under it.
     *
     * Two assertions rather than one, because the failure is silent in both
     * directions: a row built and never passed renders nothing at all, and a
     * row passed while also drawn below would render twice - two controls on
     * one page, both live, disagreeing about the comparison.
     */
    it("hands the row to the toolbar rather than drawing it below", () => {
        const body = withoutJsComments(statistics);

        assert.match(body, /aside=\{compareRow}/,
            "the comparison row is built and never given to anything");
        assert.equal(body.match(/<div className="statistics-compare-row">/g)?.length, 1,
            "the comparison row is rendered from more than one place");
    });

    /**
     * Everything the row reads is declared above it.
     *
     * The row used to be written inline in the returned tree, where every
     * const in the component body is already initialised. Lifting it into a
     * const of its own moved it two hundred lines up - and a const is
     * evaluated where it is written, so it read a `previous` that had not been
     * declared yet and the page threw "Cannot access 'previous' before
     * initialization" the moment it rendered.
     *
     * Nothing caught that. `vite build` compiles it, because it is legal
     * JavaScript; the suite cannot render JSX at all, so no test executed the
     * component; and eslint's no-use-before-define cannot tell an initializer
     * that runs now from a function body that runs later, so turning it on
     * reported fifty deliberate arrow-function references and this one bug
     * together.
     *
     * So it is read here instead, and read for the whole component body rather
     * than for the one name that broke: any const the row reads has to be
     * declared before the row. Arrow bodies inside the JSX are exempt for the
     * same reason eslint's rule is too blunt - `onChange={() => handle(...)}`
     * runs on a click, long after every const exists.
     */
    it("declares everything the row reads above the row", () => {
        const body = withoutJsComments(statistics);

        const rowAt = body.indexOf("const compareRow =");
        assert.notEqual(rowAt, -1, "the comparison row is no longer a const; re-anchor this");

        // The component body's own consts, in the order they are written.
        const declared = [...body.matchAll(/^ {4}const (\w+)\s*=/gm)]
            .map((match) => ({name: match[1], at: match.index}));

        // The row's initializer, and only the parts of it that run at once:
        // an arrow body is a callback, not an initializer.
        const initializer = body.slice(rowAt, body.indexOf("\n    const ", rowAt + 1))
            .replace(/\([^()]*\)\s*=>\s*[^,}]*/g, "");

        const early = declared
            .filter(({at}) => at > rowAt)
            .filter(({name}) => new RegExp(`\\b${name}\\b`).test(initializer));

        assert.deepEqual(early.map(({name}) => name), [],
            "the comparison row reads these before they are declared - a TDZ the moment it renders");
    });

    /**
     * And every reader above the null guard asks optionally.
     *
     * `statistics` opens as null, and the guard that settles it -
     * `if (!deferredStatistics) return` - stands most of the way down the
     * component. Everything above it therefore runs once with nothing in hand
     * on the first render of every visit, which is why gradeLimits and
     * isDownsampled have always spelled it `deferredStatistics?.`.
     *
     * Hoisting `previous` up to sit beside the payload put a bare access back
     * in front of that guard, and the page threw "Cannot read properties of
     * null" on load - the second runtime fault out of one edit that the build
     * compiled and the suite could not render.
     */
    it("reads the payload optionally above the guard that settles it", () => {
        const body = withoutJsComments(statistics);

        const guardAt = body.indexOf("if (!deferredStatistics) return");
        assert.notEqual(guardAt, -1, "the null guard moved or was renamed; re-anchor this");

        // A bare `.` on the payload, anywhere before the guard.
        const bare = [...body.slice(0, guardAt).matchAll(/deferredStatistics\.(\w+)/g)]
            .map((match) => match[1]);

        assert.deepEqual(bare, [],
            "these read the payload before anything says it has arrived - null on the first render");
    });

    /**
     * A dropdown rather than a second date picker.
     *
     * The picker was the wide control that never fit beside the chips, the
     * ambiguous one - two triggers on a page, both reading as a pair of dates
     * - and the one that let two windows of different lengths be compared. It
     * also needed a reset button beside it, because "no window named" was a
     * state rather than a choice.
     */
    it("chooses the offset from a list rather than drawing a second window", () => {
        const body = withoutJsComments(statistics);

        assert.doesNotMatch(body, /DateRangePicker/,
            "the page draws a second date picker again");
        assert.doesNotMatch(body, /statistics-compare-reset/,
            "the reset control is back, so the default is a state rather than an option");
        assert.match(body, /<CompareSelect value=\{compare}/,
            "the page no longer hands the chosen offset to the control that shows it");
    });

    /**
     * And the sentence beside it names the window in both outcomes.
     *
     * It used to render only where there was something to compare against, so
     * choosing an offset the instance holds no tests in removed it - and every
     * arrow on the page vanished at the same moment with nothing left on screen
     * saying why. Which is the one case where a reader most needs the window
     * named: "there is nothing in February" is an answer, and a blank space is
     * not.
     *
     * Two conditions, because either alone still fails silently. The note has
     * to hang off the payload as it arrived - `previous` is the gated one, and
     * hanging off that is exactly the bug - and both wordings have to be
     * literal t("...") calls, since the key scanner cannot see a key built
     * inside a ternary and would not notice either one going missing.
     */
    it("names the compared window whether or not it held anything", () => {
        const body = withoutJsComments(statistics);

        assert.match(body, /\{previousWindow && \(/,
            "the note is drawn from the gated payload, so an empty window says nothing at all");

        // Through the shared escaper rather than a dots-only replace of its
        // own: that one left a backslash in the key unescaped, which is a
        // pattern meaning something other than the text it was built from.
        // These keys carry neither today - it is the next key that would.
        for (const key of ["statistics.compare.note", "statistics.compare.empty"])
            assert.match(body, new RegExp(`t\\("${escapeRegExp(key)}",`),
                `${key} is not a literal call, so nothing checks it against the locales`);
    });

    /**
     * The third silence: a node on an older release. Every ranged request asks
     * for a comparison - DEFAULT_COMPARE is "previous" and applyCompare always
     * sends one - so a current server always answers with the `previous` key,
     * an object or a null. A node from before the compare parameter ignores
     * what it does not know and answers without the key at all, and the page
     * drew no arrows and no sentence: exactly the blank the two-wordings rule
     * above exists to prevent, arriving through a third door.
     *
     * `=== undefined`, not falsy: null is a current server saying "nothing to
     * compare against", which stays silent on purpose - nothing has elapsed,
     * and the heading already names the range. Absent is a server that never
     * understood the question.
     *
     * And asked of a payload that says whether a comparison was asked for,
     * which the describe below drives: the missing key only means "too old"
     * where the request carried the parameter, and the page holds the previous
     * range's payload while the new one is in flight.
     */
    it("says so when the node is too old to answer the comparison", () => {
        const body = withoutJsComments(statistics);

        assert.match(body, /previousWindow === undefined/,
            "an old node's missing key is indistinguishable from a deliberate null");
        assert.match(body, /askedCompare: Boolean\(dateRange\)/,
            "the stored payload no longer records whether its own request asked for a comparison");
        assert.match(body, /askedCompare && previousWindow === undefined/,
            "the sentence is gated on something other than the payload's own tag");
        assert.match(body, new RegExp(`t\\("${escapeRegExp("statistics.compare.unsupported")}"`),
            "the unsupported wording is not a literal call, so nothing checks it against the locales");
    });
});

/*
 * The page mounted, and the scaffolding the two describes below need to do it:
 * every context it reads, the URL it reads its range out of, and the two staged
 * timers it reveals itself through.
 *
 * Shared rather than copied into each, and `targets` is the parameter because
 * that is exactly what the two questions differ on - whether the instance has
 * enough targets for the chip row to draw anything at all.
 */
const noop = () => undefined;

const json = (body) => new Response(JSON.stringify(body),
    {status: 200, headers: {"content-type": "application/json"}});

// The page reveals itself in two staged timers before it asks the server
// anything. Waited for one at a time and with a margin: a single wait
// flushes React once at the end, and the second timer is armed by the
// effect that the first one's render runs.
const FIRST_STAGE_MS = 80;
const SECOND_STAGE_MS = 200;

// The page reads its range out of the URL, so changing the range means
// changing the URL - through the same hook the toolbar's own controls use.
const controls = {};
const Driver = () => {
    [, controls.setParams] = useSearchParams();
    return null;
};

const nest = (child, ...layers) =>
    layers.reduceRight((inner, [Provider, value]) => createElement(Provider, {value}, inner), child);

const mount = (entry, targets = []) => render(createElement(MemoryRouter, {initialEntries: [entry]},
    nest(createElement(AlertProvider, null,
        createElement("div", null, createElement(Driver), createElement(Statistics))),
    [ConfigContext.Provider, [{viewMode: false, previewMode: false}, noop, noop]],
    [NodeContext.Provider, [[], noop, 0, noop, () => undefined]],
    [PreferencesContext.Provider, [{}, noop]],
    [StatusContext.Provider, [{paused: false, running: false}, noop, noop]],
    [ToastNotificationContext.Provider, noop],
    [SpeedtestContext.Provider, {speedtests: [], updateTests: noop}],
    [ThemeContext.Provider, {theme: "dark", palette: "slate", setTheme: noop, setPalette: noop}],
    [TargetsContext.Provider, {targets, reloadTargets: noop, pageTargetFor: () => null,
        selectedTarget: null, selectionFor: () => ({})}])));

const reachTheFirstRequest = async () => {
    await settle(FIRST_STAGE_MS);
    await settle(SECOND_STAGE_MS);
    await settle();
};

/**
 * And the same sentence, driven rather than read.
 *
 * The pin above says the page distinguishes an absent `previous` key from a
 * null one. It cannot say WHICH payload the page asks that of - and the answer
 * was "whichever one is still on screen". `statistics` is never cleared on a
 * range change, so between choosing a bounded range and its answer arriving the
 * page held the all-time payload, which carries no `previous` because all time
 * asks for no comparison. Every current server therefore accused itself of
 * being too old, for as long as the second request took: a sentence about the
 * node's version, appearing and vanishing as a reader stepped through the
 * presets.
 *
 * So the page has to tag the answer with whether a comparison was asked for,
 * the way compareStats stores the key its figures answer for. Read that way the
 * question is about one payload rather than about two, and a payload from
 * before the range change cannot answer it at all.
 *
 * Mounted rather than scanned, because both spellings read identically as text:
 * the fault is entirely in which payload is in hand when the sentence is drawn.
 * The empty-state branch is what makes mounting a page affordable here - it
 * draws the toolbar, and the comparison row inside it, with no chart and so no
 * canvas, which is where jsdom stops being a browser.
 */
describe("the unsupported-comparison sentence, on a page that is loading", () => {
    afterEach(cleanup);

    const realFetch = globalThis.fetch;
    afterEach(() => { globalThis.fetch = realFetch; });

    const STATISTICS_PATH = "/speedtests/statistics/";
    const UNSUPPORTED = "This node runs an older MySpeed and answered without the comparison";

    // No `previous` key at all, which is what a node from before the compare
    // parameter answers - and also what a current node answers for all time,
    // which asks for no comparison. Telling those two apart is the whole point.
    // No tests either, so the page draws its empty state and no chart.
    const WITHOUT_COMPARISON = {tests: {total: 0}};

    /**
     * Every statistics request is held open until the test answers it, which is
     * the state this whole describe is about. Everything else the page asks for
     * - the ten recent tests behind the latest-test card - answers at once with
     * nothing, which is what a fresh instance has.
     */
    const holdTheStatistics = () => {
        const asked = [];

        globalThis.fetch = (url) => {
            const path = String(url);
            if (!path.includes(STATISTICS_PATH)) return Promise.resolve(json([]));

            return new Promise((resolve) => asked.push({path, answer: (body) => resolve(json(body))}));
        };

        return asked;
    };

    const answer = async (request, body) => {
        request.answer(body);
        await settle();
    };

    const notes = (container) => [...container.querySelectorAll(".statistics-compare-note")]
        .map((paragraph) => paragraph.textContent);

    it("does not accuse a current node while its ranged answer is in flight", async () => {
        const asked = holdTheStatistics();
        const {container} = mount("/?range=all");

        await reachTheFirstRequest();
        assert.equal(asked.length, 1, "the page asked for something other than one statistics payload");
        assert.doesNotMatch(asked[0].path, /compare=/, "all time asked for a comparison");
        await answer(asked[0], WITHOUT_COMPARISON);

        act(() => controls.setParams({range: "7d"}));
        await settle();

        assert.equal(asked.length, 2, "the range change asked the server nothing");
        assert.deepEqual(notes(container), [],
            "the page read the all-time payload's missing comparison as the new range's answer");
    });

    /**
     * And it still says so once the answer really is the ranged one. The gate
     * has to distinguish two payloads, not silence itself - a fix that only
     * removed the sentence would take the third silence back with it.
     */
    it("says so once a ranged answer really arrives without a comparison", async () => {
        const asked = holdTheStatistics();
        const {container} = mount("/?range=all");

        await reachTheFirstRequest();
        await answer(asked[0], WITHOUT_COMPARISON);

        act(() => controls.setParams({range: "7d"}));
        await settle();
        assert.match(asked[1].path, /compare=/, "the ranged request asked for no comparison");
        await answer(asked[1], WITHOUT_COMPARISON);

        assert.deepEqual(notes(container), [UNSUPPORTED],
            "a node that answered a ranged request without the comparison said nothing about it");
    });
});

/**
 * The row shares the chip line where there is room for it.
 *
 * The comparison row was a full-width block of its own under the chips: two
 * lines spent on a handful of target names and one sentence, on every ordinary
 * width. They share a line now, and separate on their own where they do not
 * fit - which is what flex-wrap means and why nothing here is measured.
 */
describe("the comparison row beside the target chips", () => {
    afterEach(cleanup);

    const realFetch = globalThis.fetch;
    afterEach(() => { globalThis.fetch = realFetch; });

    const toolbar = compile("common/components/PageToolbar/styles.sass");
    const page = compile("pages/Statistics/styles.sass");
    const chips = compile("common/components/TargetChips/styles.sass");

    // The last block written for a selector, which is what the cascade leaves
    // standing at equal specificity.
    const ruleFor = (css, selector) => rules(css)
        .filter((rule) => rule.selector.trim() === selector)
        .map((rule) => rule.body)
        .at(-1) ?? null;

    const value = (rule, property) => {
        const match = new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`).exec(rule ?? "");
        return match === null ? null : match[1].trim();
    };

    it("gives the pair a wrapping row of their own", () => {
        const row = ruleFor(toolbar, ".toolbar-second-row");

        assert.notEqual(row, null, ".toolbar-second-row is not declared");
        assert.equal(value(row, "display"), "flex");
        assert.equal(value(row, "flex-wrap"), "wrap",
            "the aside cannot drop below the chips, so a long one overflows the page");
        assert.equal(value(row, "width"), "100%",
            "the row is content-sized, so the page summary is drawn up beside it");
    });

    /**
     * Both of them have to give up the full width they claim when they stand
     * alone, or the one that keeps it takes the whole line and the other is
     * pushed onto the row this change exists to save.
     */
    it("takes the full width off both of them inside it", () => {
        assert.equal(value(ruleFor(toolbar, ".toolbar-second-row > .target-chips"), "width"), "auto",
            "the chips still claim the whole line, so the aside can never sit beside them");
        assert.notEqual(value(ruleFor(page, ".statistics-compare-row"), "width"), "100%",
            "the comparison row still claims the whole line");
    });

    // And the chips keep their standalone rule, which the overview and every
    // instance with no aside still renders.
    it("leaves the chips their own width where they stand alone", () => {
        assert.equal(value(ruleFor(chips, ".target-chips"), "width"), "100%",
            "the chip row is content-sized on the page that draws it without an aside");
    });

    /**
     * And the control that sits there is short enough for that to mean
     * something. The date picker it replaced was wide enough that the pair
     * wrapped at every ordinary width, so the row they were meant to share was
     * spent anyway.
     */
    it("keeps the offset control off a line of its own", () => {
        const select = compile("pages/Statistics/components/CompareSelect/styles.sass");
        const choice = ruleFor(select, ".compare-select");

        assert.notEqual(choice, null, ".compare-select is not declared");
        assert.equal(value(choice, "flex"), "0 0 auto",
            "the offset control grows or shrinks, so it no longer sits beside the note");
    });

    /**
     * The button is as wide as its widest possible label, and the menu is
     * exactly as wide as the button.
     *
     * Two faults that read as one. The button sized itself to whatever was
     * chosen, so picking "1 year earlier" after "3 months earlier" shrank it
     * and moved the sentence beside it - a control that changes size when you
     * use it. And the menu asked for `min-width: 100%` under `box-sizing:
     * content-box`, which makes that 100% the CONTENT box: the menu came out
     * its padding and border wider than the button it hangs from, overhanging
     * it on the left by ten pixels.
     *
     * A min-width in rem answers neither. "1 bhliain níos luaithe" is half
     * again as long as "1 year earlier", so one number is either too wide for
     * English or too narrow for Irish - and it would still be a guess about
     * the twenty-three languages nobody measured. The button carries every
     * label instead, stacked in one grid cell behind the chosen one, so its
     * width is the widest of them in whatever language is loaded.
     */
    it("keeps one width whatever is chosen, and gives the menu the same one", () => {
        const sheet = compile("pages/Statistics/components/CompareSelect/styles.sass");
        const source = readSource(
            "client/src/pages/Statistics/components/CompareSelect/CompareSelect.jsx");
        const menu = ruleFor(sheet, ".compare-select-menu");

        assert.match(source, /className="compare-select-sizer" aria-hidden="true"/,
            "the button no longer carries every label, so it resizes as the choice moves");
        // Any rule that names this selector, rather than a rule that names
        // only it: the sizer stacks its children the same way, and saying so
        // once in a selector list is the honest spelling of that.
        const stacked = rules(sheet)
            .filter((rule) => rule.selector.split(",").some((one) => one.trim() === ".compare-select-value > *"))
            .map((rule) => rule.body).join("\n");

        assert.match(stacked, /grid-area:\s*1\s*\/\s*1/,
            "the labels no longer share one cell, so they stack into a column instead of overlapping");

        assert.equal(value(menu, "left"), "0");
        assert.equal(value(menu, "right"), "0",
            "the menu is pinned on one side only, so it takes its own width rather than the button's");
        assert.equal(value(menu, "box-sizing"), "border-box",
            "content-box makes the menu its padding and border wider than the button it hangs from");
        assert.equal(value(menu, "min-width"), null,
            "a width floor is back beside the pinned edges, which can only disagree with them");
    });

    /**
     * And the menu measures itself against the button it drops from, not
     * against the button and its label together.
     *
     * The menu asks for `min-width: 100%`, which means the width of its
     * positioning ancestor. That was the element holding the label as well, so
     * "Compare with" was silently added to the menu's floor: 305px of menu
     * hanging off a 207px button, a hundred pixels of empty gutter beside six
     * short options. Nothing about the translations - the widest option is half
     * that.
     *
     * Read as two halves because either alone is satisfiable while still
     * wrong: an anchor that exists but is not the positioning context measures
     * nothing, and a positioned pair with an anchor inside it is the bug again
     * one level down.
     */
    it("hangs the menu off the button rather than off the labelled pair", () => {
        const sheet = compile("pages/Statistics/components/CompareSelect/styles.sass");
        const source = readSource(
            "client/src/pages/Statistics/components/CompareSelect/CompareSelect.jsx");

        assert.equal(value(ruleFor(sheet, ".compare-select-anchor"), "position"), "relative",
            "nothing between the button and the pair is positioned, so 100% is the pair's width");
        assert.equal(value(ruleFor(sheet, ".compare-select"), "position"), null,
            "the labelled pair is positioned too, and it is the nearer ancestor of the two");

        const at = (marker) => source.indexOf(`"compare-select${marker}"`);

        assert.notEqual(at("-anchor"), -1, "the anchor is styled but never drawn");
        assert.ok(at("-label") < at("-anchor"),
            "the label is inside the box the menu takes its width from");
        assert.ok(at("-anchor") < at("-trigger") && at("-anchor") < at("-menu"),
            "the button and its menu are not both inside the anchor");
    });

    /**
     * And with no chips beside it, the pair takes the two ends of the line
     * rather than bunching at its left.
     *
     * An instance with one target draws no chip row - TargetChips renders
     * nothing below two - so the comparison row is the whole of the toolbar's
     * second line there, and the sentence and the picker sat squeezed against
     * the left margin with the rest of the width empty. Every other control
     * row on the page has something on its right edge, and with two targets
     * the chips already push this one there; one target was the odd case out.
     *
     * space-between rather than an auto margin on the picker, and that is the
     * "as long as they share a row" half of it: the row wraps, and an auto
     * margin would push the picker to the right on whatever line it lands on,
     * including a line of its own under the sentence. A flex line holding one
     * item puts it at the start, so the ends are taken only while the two are
     * on one line - and a row that has no sentence to sit opposite (a server
     * with nothing before the range answers a null, which is silent on
     * purpose) keeps the picker where it has always been.
     */
    it("takes the ends of the line where nothing else shares it", () => {
        const alone = ruleFor(page, ".statistics-compare-row:only-child");
        const beside = ruleFor(page, ".statistics-compare-row");

        assert.notEqual(alone, null, ".statistics-compare-row:only-child is not declared");
        assert.equal(value(alone, "flex"), "1 1 auto",
            "the row is content-sized with no chips beside it, so there is no line to take the ends of");
        assert.equal(value(alone, "justify-content"), "space-between",
            "the pair is packed at the start of a line it has all of");

        assert.equal(value(beside, "flex"), "0 1 auto",
            "the row grows beside the chips, so it no longer sits against them");
        assert.equal(value(beside, "justify-content"), null,
            "the pair is spread apart beside the chips too, which pulls the sentence off the picker");
    });

    /**
     * Which rests on the chip row drawing no element whatever below two
     * targets.
     *
     * `:only-child` counts elements, so a chip row that rendered an empty
     * wrapper - or a toolbar that wrapped the slot in one - would leave the
     * selector matching nothing, with the picker quietly back at the left
     * margin and no stylesheet test able to see it. Both counts are asserted,
     * because a selector that matched in both cases would be the second half
     * of the ask broken instead: with more than one target this row is not
     * alone and nothing about it changes.
     */
    it("leaves the row alone in the second toolbar line only below two targets", async () => {
        globalThis.fetch = (url) => Promise.resolve(json(
            String(url).includes("/speedtests/statistics/") ? {tests: {total: 0}} : []));

        const children = async (targets) => {
            const {container} = mount("/?range=7d", targets);
            await reachTheFirstRequest();

            const row = container.querySelector(".toolbar-second-row");
            assert.notEqual(row, null, "the comparison row is no longer drawn as the toolbar's aside");

            return [...row.children].map((child) => child.className);
        };

        assert.deepEqual(await children([{id: 1, name: "Fibre"}]), ["statistics-compare-row"],
            "something else shares the second line on a single-target instance");

        cleanup();

        assert.deepEqual(await children([{id: 1, name: "Fibre"}, {id: 2, name: "LTE"}]),
            ["target-chips", "statistics-compare-row"],
            "the chips no longer sit beside the comparison row, so it is alone on every instance");
    });
});
