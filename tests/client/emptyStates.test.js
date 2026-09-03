import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { useContext } from "react";
import { MemoryRouter, useSearchParams } from "react-router-dom";
import { compile, rules } from "../helpers/sass.mjs";
import { escapeRegExp } from "../helpers/source.js";
import { act, cleanup, click, createElement, render, settle, window } from "../helpers/renderHarness.js";
import { AlertProvider } from "@/common/contexts/Alert";
import { ConfigContext } from "@/common/contexts/Config";
import { NodeContext } from "@/common/contexts/Node";
import { PreferencesContext } from "@/common/contexts/Preferences";
import { StatusContext } from "@/common/contexts/Status";
import { TargetsContext } from "@/common/contexts/Targets";
import { ToastNotificationContext } from "@/common/contexts/ToastNotification";
import { SpeedtestContext, SpeedtestProvider } from "@/common/contexts/Speedtests/SpeedtestContext.jsx";
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

        // And what the provider is holding, which the page cannot be asked
        // for: the error branch returns above the list, so counting rendered
        // rows says nothing about whether any were kept - it reads zero
        // either way. Two reviewers found the same vacuity here.
        const held = useContext(SpeedtestContext);

        controls.tests = held.speedtests;
        controls.hasMore = held.hasMore;
        controls.loadError = held.loadError;
        controls.reloadTests = held.reloadTests;

        // The reference as it was on the first render, which is what a caller
        // that awaits something before using it is holding. RunUtil does
        // exactly that: await the status, await the run, then updateTests().
        controls.firstUpdate ??= held.updateTests;
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
        assert.equal(controls.tests.length, 0,
            "the previous range's rows are still in hand under the new range's failure");
        assert.equal(container.querySelectorAll(".speedtest").length, 0);
        assert.match(shown(container), new RegExp(escapeRegExp(SERVER_MESSAGE)));
    });

    /**
     * And the error comes down when the rows arrive by some other route.
     *
     * The retry is not the only thing that reloads this list. A refresh
     * fires when the tab is looked at again, when a run finishes, and from
     * updateTests() after a delete - and not one of them is the failed
     * load's generation, so nothing about that failure supersedes them. The
     * first sketch cleared loadError in the two loads only, which left a
     * page that had answered its rows still showing the error branch on top
     * of them, with no way past it but the retry.
     *
     * The rows underneath are why that is not merely a stale sentence.
     * Every one of TestArea's hooks runs above the early return, so the
     * scroll listener is live behind the error page and fires
     * loadMoreTests() on `hasMore && speedtests.length > 0` - the same
     * invisible paging that keeping the list on a failure would have
     * caused, reached from the other side.
     */
    /**
     * A fetch that answers nothing until it is told to, so a test can settle
     * two requests in an order the page never chooses for itself.
     */
    const deferred = () => {
        const pending = [];
        const asked = [];

        globalThis.fetch = (url) => {
            const path = String(url);
            asked.push(path);

            // Paging never answers at all. TestArea checks on a timer whether
            // the list already reaches the bottom of the window, so whether it
            // asks for a second page is the machine's decision rather than the
            // test's - and every way of answering changes what is being
            // measured: a full page doubles the row count, an empty one sets
            // hasMore false and fakes the very state under test, and a queued
            // one shifts the indices. Left in flight it changes nothing, which
            // is what a test about the cursor needs.
            if (path.includes("after=")) return new Promise(() => {});

            return new Promise((resolve, reject) => pending.push({resolve, reject}));
        };

        /**
         * The nth request, once it has actually been made.
         *
         * Indexing straight into the queue after a fixed number of settles is a
         * bet on how many turns of the loop a render takes, and the whole suite
         * running at once is where that bet loses: this file passed five times
         * over on its own and failed inside `npm test`. Waiting for the request
         * is the same assertion without the bet.
         */
        const queued = async (index) => {
            for (let attempt = 0; attempt < SETTLE_ATTEMPTS && pending.length <= index; attempt++)
                await settle();

            assert.ok(pending[index], `request ${index} was never made - ${JSON.stringify(asked)}`);
            return pending[index];
        };

        return {asked, pending, queued};
    };

    // Enough turns for a render and its effects on a loaded machine, and few
    // enough that something that never happens still fails rather than hangs.
    const SETTLE_ATTEMPTS = 40;

    /**
     * Settles until the page has caught up, then asserts that it has.
     *
     * A fixed pair of settles after each step is a bet on how many turns a
     * render and its effects take, and the bet loses exactly where it costs
     * most: this file passed on its own and failed inside `npm test`, where
     * eleven hundred other files are competing for the same machine. Waiting
     * for the state is the same assertion without the bet - and still an
     * assertion, because a state that never arrives runs the attempts out.
     */
    const settleUntil = async (holds, message) => {
        for (let attempt = 0; attempt < SETTLE_ATTEMPTS && !holds(); attempt++) await settle();

        assert.ok(holds(), message);
    };

    const PAGE_SIZE = 30;

    const page = (from = 1) => Array.from({length: PAGE_SIZE}, (unused, index) => ({
        id: from + index, targetId: null, ping: 12, download: 940, upload: 480,
        created: new Date(Date.UTC(2026, 7, 1, 0, from + index)).toISOString()
    }));

    /**
     * A refresh that was already in flight when the load failed answers the
     * question the load could not - and must leave the list able to page.
     *
     * It shares the failed load's generation, by construction: it reads the
     * counter at call time and the load bumped it before starting, so nothing
     * supersedes it. What it does *not* share is the list - it closed over the
     * rows that were on screen when it was called, while the failure cleared
     * them and reset the cursor and hasMore with them. Deciding merge-or-replace
     * from that closure answered "merge", which put the rows back and left the
     * cursor at null and hasMore at false: thirty rows under "No more tests to
     * load" on an instance with years of them, and loadMoreTests dead for the
     * life of the page. The error page it replaced at least had a retry.
     */
    it("leaves the list able to page when a refresh lands on a failed load", async () => {
        const {queued} = deferred();
        mount();

        (await queued(0)).resolve(json(page()));
        await settleUntil(() => controls.tests.length === PAGE_SIZE, "the first page never arrived");
        assert.equal(controls.hasMore, true, "a full page has to leave something to page to");

        // A reload starts and bumps the generation; the refresh joins it and
        // reads that same generation, so neither supersedes the other.
        act(() => { controls.reloadTests(); });
        await settle();
        await act(async () => { window.document.dispatchEvent(new window.Event("visibilitychange")); });
        await settle();

        (await queued(1)).reject(new Error("the database is locked"));
        await settleUntil(() => controls.tests.length === 0, "the failed load kept the previous query's rows");

        // And the refresh answers, with a page overlapping the rows it closed
        // over - which is what makes its stale decision "merge".
        (await queued(2)).resolve(json(page()));
        await settleUntil(() => controls.tests.length === PAGE_SIZE, "the refresh answered nothing onto the page");

        assert.equal(controls.hasMore, true,
            "the rows came back with the failure's cursor, so the list says there are no more");
    });

    /**
     * A 200 carrying something that is not a list is not an answer.
     *
     * applyRefresh hands back what it was given and calls that a merge, so
     * nothing below can use it - and clearing the error over it took down the
     * one thing on screen that was true, leaving "There are currently no tests
     * available" on an instance with years of them.
     */
    it("keeps the error when a refresh answers with something that is not a list", async () => {
        const {queued} = deferred();
        mount();

        (await queued(0)).reject(new Error(SERVER_MESSAGE));
        await settle();
        await settle();

        await act(async () => { window.document.dispatchEvent(new window.Event("visibilitychange")); });
        (await queued(1)).resolve(json({message: "maintenance"}));
        await settle();
        await settle();

        assert.notEqual(controls.loadError, null,
            "a body the page cannot use took the error down with it");
        assert.equal(controls.tests.length, 0, "a body the page cannot use was drawn as rows");
    });

    /**
     * And a reference held across an await asks the query the page is on.
     *
     * RunUtil holds one: it awaits the status, awaits the run, and only then
     * calls updateTests() - so on a page whose range changed in between, the
     * reference is from a render before the change and its closure spells the
     * old query. That answer used to be merged in under the new range's heading;
     * now it would also clear the error, which is what makes the wrong rows
     * visible rather than hidden behind a retry.
     */
    it("asks the range the page is on, not the one the caller was holding", async () => {
        // `controls` outlives a test, so the reference a previous mount left
        // there would be answered instead of this one - and it belongs to an
        // unmounted provider that was never on a range at all.
        delete controls.firstUpdate;

        const {asked, queued} = deferred();
        mount("/?from=2026-08-01&to=2026-08-02");

        (await queued(0)).resolve(json([]));
        await settleUntil(() => controls.firstUpdate !== undefined, "the provider never rendered");

        const held = controls.firstUpdate;
        act(() => controls.setParams({from: "2026-08-25", to: "2026-08-31"}));
        await settle();

        const before = asked.length;
        await act(async () => { held(); });
        await settleUntil(() => asked.length > before, "the held reference asked for nothing");
        assert.match(asked[asked.length - 1], /from=2026-08-25/,
            `a reference held across an await asks the range the reader has left: ${JSON.stringify(asked)}`);
    });

    it("takes the error down when a refresh answers what the load could not", async () => {
        const asked = serve(refusal, () => json([{
            id: 1, targetId: null, ping: 12, download: 940, upload: 480,
            created: "2026-08-01T10:00:00.000Z"
        }]));
        const {container} = await seeTheList();

        assert.match(shown(container), new RegExp(escapeRegExp(SERVER_MESSAGE)), "nothing failed to begin with");

        // The refresh a tab getting focus again fires, which is the one
        // route to this list that asks for no click at all.
        await act(async () => { window.document.dispatchEvent(new window.Event("visibilitychange")); });
        await settle();
        await settle();

        assert.equal(asked.length, 2, "the refresh asked the server nothing");
        assert.doesNotMatch(shown(container), new RegExp(escapeRegExp(SERVER_MESSAGE)),
            "the rows are on screen behind an error page that cannot be dismissed");
        assert.equal(container.querySelectorAll(".speedtest").length, 1,
            "the refreshed row never reached the page");
    });
});
