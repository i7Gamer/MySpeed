import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryRouter, useSearchParams } from "react-router-dom";
import { compile, rules } from "../helpers/sass.mjs";
import { escapeRegExp } from "../helpers/source.js";
import { act, cleanup, click, createElement, render, settle } from "../helpers/renderHarness.js";
import { AlertProvider } from "@/common/contexts/Alert";
import { ConfigContext } from "@/common/contexts/Config";
import { NodeContext } from "@/common/contexts/Node";
import { PreferencesContext } from "@/common/contexts/Preferences";
import { StatusContext } from "@/common/contexts/Status";
import { TargetsContext } from "@/common/contexts/Targets";
import { ToastNotificationContext } from "@/common/contexts/ToastNotification";
import { SpeedtestProvider } from "@/common/contexts/Speedtests/SpeedtestContext.jsx";
import TestArea from "@/pages/Home/components/TestArea/TestAreaComponent.jsx";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const CLIENT_SRC = path.join(ROOT, "client", "src");

const read = (file) => fs.readFileSync(path.join(CLIENT_SRC, file), "utf8");
const english = JSON.parse(
    fs.readFileSync(path.join(ROOT, "client/public/assets/locales/en.json"), "utf8"));

const testArea = read("pages/Home/components/TestArea/TestAreaComponent.jsx");
const statistics = read("pages/Statistics/Statistics.jsx");

/**
 * Both pages render the same sentence - "there are currently no tests
 * available" - whether the instance has never run one or the reader simply
 * picked a quiet week. Now that both carry a range picker, the second case is
 * by far the more common, and the message neither said so nor offered a way
 * back: a dead end reached by a single click.
 */
describe("the empty state names the range that emptied it", () => {
    it("has a sentence that carries the range", () => {
        assert.equal(typeof english.test.not_available_in_range, "string");
        assert.match(english.test.not_available_in_range, /\{\{from}}/);
        assert.match(english.test.not_available_in_range, /\{\{to}}/);
    });

    it("keeps the range-less sentence for an instance with no tests at all", () => {
        assert.equal(typeof english.test.not_available, "string");
        assert.doesNotMatch(english.test.not_available, /\{\{/);
    });

    it("uses the range sentence on the overview", () => {
        assert.match(testArea, /test\.not_available_in_range/);
        assert.match(testArea, /test\.not_available"/, "the no-tests-at-all case lost its own sentence");
    });

    it("uses the range sentence on the statistics", () => {
        assert.match(statistics, /test\.not_available_in_range/);
    });

    // All time has no dates to name, and the window it reaches the server with
    // is a stand-in - "No tests between 26 Mar 1999 and today" reads as a
    // strangely specific request rather than as an empty instance.
    it("keeps the range-less sentence for all time on the statistics", () => {
        assert.match(statistics, /test\.not_available"/);
    });
});

/**
 * Both pages can show every test they have, so both can offer the way back from
 * a range that emptied them - a dead end otherwise reached by a single click.
 */
describe("the way back from an empty range", () => {
    it("offers all time on the overview", () => {
        assert.equal(typeof english.test.show_all_time, "string");
        assert.match(testArea, /test\.show_all_time/);
        assert.match(testArea, /TIMEFRAME_ALL/, "the button selects something other than all time");
    });

    it("offers it on the statistics too", () => {
        assert.match(statistics, /test\.show_all_time/);
        assert.match(statistics, /TIMEFRAME_ALL/, "the button selects something other than all time");
    });

    for (const [page, source] of [["overview", testArea], ["statistics", statistics]]) {
        it(`only offers it on the ${page} when a range is what emptied the page`, () => {
            // The button hangs off the same branch as the range sentence, so an
            // instance with no tests at all is not told to widen a range it
            // never narrowed.
            const rangeBranch = source.slice(source.indexOf("not_available_in_range"));
            const plainBranch = source.slice(0, source.indexOf("not_available_in_range"));

            assert.match(rangeBranch, /show_all_time/);
            assert.doesNotMatch(plainBranch, /show_all_time/);
        });
    }
});

/**
 * The empty statistics page, whose sentence and button were touching.
 *
 * `.statistics-empty` is a centred flex row holding a `<p>` and a `.dialog-btn`
 * as siblings, and it declared no gap - so "No tests between Aug 25 and Aug 31"
 * ran straight into "Show all time" with nothing between them. Measured in the
 * browser rather than guessed: the paragraph's right edge and the button's left
 * edge were both at 658.06px.
 *
 * The row is what the block was drawn as - centred, with 6rem of vertical
 * padding - so this gives it the gap it was missing rather than restacking it.
 * The wrap is the other half of the same fault: the sentence carries two
 * formatted dates and is the longest string on the page, and a row that cannot
 * wrap puts it and the button through the same squeeze on a narrow screen.
 */
describe("the empty statistics page", () => {
    const css = compile("pages/Statistics/styles.sass");
    const empty = rules(css).find((rule) => rule.selector === ".statistics-empty");

    it("keeps its sentence off its button", () => {
        assert.ok(empty, ".statistics-empty has no rule");
        assert.match(empty.body, /gap:\s*[^;0]/,
            "the sentence and the button are touching, which is how they shipped");
    });

    it("lets the two wrap rather than squeezing them", () => {
        assert.match(empty.body, /flex-wrap:\s*wrap/,
            "a long translated sentence and the button share one unwrappable row");
    });
});

/**
 * The sentence neither page should ever say about a request that failed.
 *
 * SpeedtestContext wrote the empty answer for every failure - the list, the
 * cursor and the "no more pages" flag - and exposed nothing about why. The
 * overview then drew "There are currently no tests available" as a bare
 * heading with no control on it, because all time is the default and there is
 * no range to widen. Any 500, dropped connection or ten second RequestUtil
 * timeout on the first page therefore reported an empty instance over one with
 * years of history, and the only way out was to change the range or leave the
 * tab and come back.
 *
 * Driven rather than read, because the fault is entirely in which of three
 * branches is reached with which state in hand: the empty state and the error
 * state render the same component with the same list.
 */
describe("a first page of the overview that failed", () => {
    afterEach(cleanup);

    const realFetch = globalThis.fetch;
    afterEach(() => { globalThis.fetch = realFetch; });

    const noop = () => undefined;

    // Non-empty, because TestArea draws nothing at all until the config has
    // landed - the same guard every graded view carries.
    const CONFIG = {ping: "10", download: "1000", upload: "500", viewMode: false};

    // What the server says when it refuses, which is the sentence the reader
    // should be shown rather than a guess written on the client.
    const SERVER_MESSAGE = "The database is locked";

    const json = (body, status = 200) => new Response(JSON.stringify(body),
        {status, headers: {"content-type": "application/json"}});

    const refusal = () => json({message: SERVER_MESSAGE}, 500);

    /**
     * The list endpoint, answering the queued replies in order and repeating
     * the last one after that - so a test says "fail, then succeed" and the
     * retry is what reaches the second answer.
     */
    const serve = (...answers) => {
        const asked = [];

        globalThis.fetch = (url) => {
            asked.push(String(url));
            return Promise.resolve(answers[Math.min(asked.length - 1, answers.length - 1)]());
        };

        return asked;
    };

    const nest = (child, ...layers) =>
        layers.reduceRight((inner, [Provider, value]) => createElement(Provider, {value}, inner), child);

    // The range lives in the URL, so changing it means changing the URL -
    // through the same hook the picker's own controls use.
    const controls = {};
    const Driver = () => {
        [, controls.setParams] = useSearchParams();
        return null;
    };

    const mount = (entry = "/") => render(createElement(MemoryRouter, {initialEntries: [entry]},
        nest(createElement(AlertProvider, null,
            createElement(SpeedtestProvider, null,
                createElement("div", null, createElement(Driver), createElement(TestArea)))),
        [ConfigContext.Provider, [CONFIG, noop]],
        [NodeContext.Provider, [[], noop, 0, noop, () => undefined]],
        [PreferencesContext.Provider, [{}, noop]],
        [StatusContext.Provider, [{paused: false, running: false}, noop, noop]],
        [ToastNotificationContext.Provider, noop],
        [TargetsContext.Provider,
            {targets: [], byId: {}, selectedTarget: null, reloadTargets: noop, pageTargetFor: () => null}])));

    const seeTheList = async (entry) => {
        const mounted = mount(entry);
        await settle();
        await settle();
        return mounted;
    };

    const shown = (container) => container.textContent;

    const retryButton = (container) => [...container.querySelectorAll("button")]
        .find((button) => button.textContent === english.dialog.retry);

    it("does not report an empty instance when the request was refused", async () => {
        serve(refusal);
        const {container} = await seeTheList();

        assert.doesNotMatch(shown(container), new RegExp(escapeRegExp(english.test.not_available)),
            "a request that failed was rendered as an instance with no tests in it");
    });

    it("says what the server said, and offers to ask again", async () => {
        serve(refusal);
        const {container} = await seeTheList();

        assert.match(shown(container), new RegExp(escapeRegExp(SERVER_MESSAGE)),
            "the reason the page is empty is only in the console");
        assert.ok(retryButton(container), "the failed page is the dead end it always was");
    });

    /**
     * And the retry is the query the page is actually showing, not a bare
     * reload: reloadTests rebuilds it from the range in the URL and the chip in
     * hand, the way the statistics page's own retry does.
     */
    it("asks again for the range the page is on", async () => {
        const asked = serve(refusal, () => json([]));
        const {container} = await seeTheList("/?from=2026-08-25&to=2026-08-31");

        click(retryButton(container));
        await settle();
        await settle();

        assert.equal(asked.length, 2, "the retry asked for nothing");
        assert.match(asked[1], /from=2026-08-25/, "the retry dropped the range the page is showing");
        assert.doesNotMatch(shown(container), new RegExp(escapeRegExp(SERVER_MESSAGE)),
            "the error survived a load that succeeded");
    });

    /**
     * The half of this the first sketch got wrong, and which the statistics
     * page has already litigated: the rows are still dropped on a failure, and
     * the error branch is returned before anything can draw them.
     *
     * Keeping them would be worse here than there. SpeedtestContext does not
     * clear its list on a range or target change, and every one of TestArea's
     * hooks runs above its early returns - so the scroll listener stays live in
     * the error branch and fires loadMoreTests() on `hasMore &&
     * speedtests.length > 0`, paging the new range's rows onto the tail of the
     * old range's list from a cursor into a result set nobody is showing. The
     * status bar reads speedtests[0] as its own last-test fallback and has no
     * error branch at all, so it would leak past this page too.
     */
    it("shows no rows from the range whose load failed", async () => {
        const asked = serve(() => json([{
            id: 1, targetId: null, ping: 12, download: 940, upload: 480,
            created: "2026-08-01T10:00:00.000Z"
        }]), refusal);
        const {container} = await seeTheList();

        assert.equal(container.querySelectorAll(".speedtest").length, 1, "the first page never rendered");

        act(() => controls.setParams({from: "2026-08-25", to: "2026-08-31"}));
        await settle();
        await settle();

        assert.equal(asked.length, 2, "the range change asked the server nothing");
        assert.equal(container.querySelectorAll(".speedtest").length, 0,
            "the previous range's rows are on screen under the new range's failure");
        assert.match(shown(container), new RegExp(escapeRegExp(SERVER_MESSAGE)));
    });
});
