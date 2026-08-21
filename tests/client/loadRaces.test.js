import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { blockEnd, readSource } from "../helpers/source.js";

const statistics = readSource("client/src/pages/Statistics/Statistics.jsx");
const app = readSource("client/src/App.jsx");

/**
 * The arrow function declared at `named`, lifted out and made callable.
 *
 * Both of these faults are about what happens when two things finish in an
 * order nobody planned, which cannot be read off the shape of the source - it
 * has to be run. The JSX around them is the only part node cannot parse; the
 * functions themselves are plain JavaScript. Same approach as escapeTopmost.
 */
const functionAt = (source, named, closure) => {
    const start = source.indexOf(named);
    assert.notEqual(start, -1, `${named} is not in this component`);

    const body = source.slice(source.indexOf("{", source.indexOf("=>", start)));
    const names = Object.keys(closure);

    return new Function(...names, `return () => ${body.slice(0, blockEnd(body, 0) + 1)};`)(
        ...names.map((name) => closure[name]));
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A response for a range the reader has already left used to land anyway.
 *
 * updateStats fired and forgot. Choosing "all time" and then, before it
 * answered, "last 7 days" left the slow query in flight; it resolved second and
 * called setStatistics unconditionally, so the page showed the abandoned range's
 * series and totals underneath the toolbar, URL and heading of the range
 * actually chosen - a wrong number presented as the answer to the question the
 * reader had asked.
 *
 * The error path was the sharper half. An abandoned request that timed out set
 * loadError after the newer one had already cleared it and rendered, replacing a
 * correct page with the full-screen error branch.
 */
describe("statistics answers only the range still being asked about", () => {
    const load = () => {
        const wrote = [];
        const pending = [];

        const updateStats = functionAt(statistics, "const updateStats", {
            rangeQuery: () => new URLSearchParams(),
            dateRange: null,
            startTransition: (run) => run(),
            setLoading: () => undefined,
            setLoadError: (error) => error !== null && wrote.push("error"),
            setStatistics: (stats) => wrote.push(stats.range),
            setRecentTests: () => undefined,
            jsonRequest: () => new Promise((resolve, reject) => pending.push({resolve, reject})),
            RECENT_TESTS: 5,
            requestGeneration: {current: 0},
            console: {error: () => undefined}
        });

        // Each call asks for the statistics and the recent tests together, so a
        // request is two of the promises collected above.
        const answer = async (nth, range) => {
            pending[nth * 2].resolve({range});
            pending[nth * 2 + 1].resolve([]);
            await settle();
        };

        const fail = async (nth) => {
            const timeout = new Error("timeout");
            pending[nth * 2].reject(timeout);
            pending[nth * 2 + 1].reject(timeout);
            await settle();
        };

        return {updateStats, wrote, answer, fail};
    };

    it("keeps the newer range when the abandoned one answers last", async () => {
        const {updateStats, wrote, answer} = load();

        updateStats();
        updateStats();

        await answer(1, "7 days");
        await answer(0, "all time");

        assert.deepEqual(wrote, ["7 days"],
            "the range the reader left was painted over the one they chose");
    });

    it("still renders the newest answer when it arrives last", async () => {
        const {updateStats, wrote, answer} = load();

        updateStats();
        updateStats();

        await answer(0, "all time");
        await answer(1, "7 days");

        assert.deepEqual(wrote, ["7 days"], "the current range never reached the page");
    });

    /**
     * And an abandoned request that fails takes nothing down with it. This is
     * the case that turned a rendered page into the full-screen error: the
     * timeout belonged to a range nobody was looking at any more.
     */
    it("does not raise an error for a range the reader has left", async () => {
        const {updateStats, wrote, answer, fail} = load();

        updateStats();
        updateStats();

        await answer(1, "7 days");
        await fail(0);

        assert.deepEqual(wrote, ["7 days"], "an abandoned request's timeout replaced a page that had rendered");
    });

    // The guard must not swallow a genuine failure of the current request.
    it("still raises an error for the range that is current", async () => {
        const {updateStats, wrote, fail} = load();

        updateStats();

        await fail(0);

        assert.deepEqual(wrote, ["error"], "a failed load of the current range is no longer reported");
    });
});

/**
 * The app could sit on its loading screen for good.
 *
 * The subscription to i18next's `initialized` is registered in an effect, and
 * that effect cannot run until index.jsx has awaited migrateStoredPassword() -
 * so on the upgrade path that migration exists for, and only there, the locale
 * finishes loading while the session request is still doing its bcrypt compare.
 * i18next emits `initialized` once and does not replay it, so the event went to
 * nobody and translationsLoaded stayed false with no second chance.
 *
 * Self-healing after a manual reload, since the legacy key is removed either
 * way - which makes it a broken first load after an upgrade rather than a
 * bricked install, and exactly the load where a user decides whether the
 * upgrade worked.
 */
describe("the app notices translations that arrived before it was listening", () => {
    it("starts from what i18next has already done, not from false", () => {
        assert.match(app, /useState\(i18n\.isInitialized\)/,
            "the loading gate assumes the translations cannot already be ready");
    });

    const subscribe = (isInitialized) => {
        const on = [];
        const off = [];
        const state = {loaded: false, failed: false};

        const cleanup = functionAt(app, "useEffect(() =>", {
            i18n: {
                isInitialized,
                on: (event, handler) => on.push([event, handler]),
                off: (event, handler) => off.push([event, handler])
            },
            setTranslationsLoaded: (value) => state.loaded = value,
            setTranslationError: (value) => state.failed = value
        })();

        return {on, off, state, cleanup};
    };

    it("takes the ready state when the event has already been and gone", () => {
        const {state} = subscribe(true);

        assert.equal(state.loaded, true,
            "the app waits for an event that was emitted before it was listening, and waits for good");
    });

    it("subscribes when there is still something to wait for", () => {
        const {on, state} = subscribe(false);

        assert.deepEqual(on.map(([event]) => event), ["initialized", "failedLoading"]);
        assert.equal(state.loaded, false);
    });

    // The same handlers it registered, or the listener outlives the component
    // that owns the state it writes to.
    it("removes exactly the handlers it added", () => {
        const {on, off, cleanup} = subscribe(false);

        assert.equal(typeof cleanup, "function", "the subscription is never cleaned up");
        cleanup();

        assert.deepEqual(off, on, "a different handler is removed than the one that was added");
    });
});
