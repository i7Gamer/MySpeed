import {afterEach, describe, it} from "node:test";
import assert from "node:assert/strict";
import {useContext, useState} from "react";
import {MemoryRouter, useSearchParams} from "react-router-dom";
import {Chart} from "chart.js";
import {act, cleanup, click, createElement, render, settle, window} from "../helpers/renderHarness.js";
import {ConfigContext} from "@/common/contexts/Config";
import {NodeContext} from "@/common/contexts/Node";
import {PreferencesContext} from "@/common/contexts/Preferences";
import {StatusContext} from "@/common/contexts/Status";
import {SpeedtestContext, SpeedtestProvider} from "@/common/contexts/Speedtests";
import {TargetsContext} from "@/common/contexts/Targets";
import {ThemeContext} from "@/common/contexts/Theme";
import {ToastNotificationContext} from "@/common/contexts/ToastNotification";
import {AlertProvider} from "@/common/contexts/Alert";
import {Statistics} from "@/pages/Statistics/Statistics.jsx";
import HistoryStorage from "@/common/components/StorageDialog/tabs/Speedtests.jsx";

const noop = () => {};
const FIRST_STAGE_MS = 80;
const SECOND_STAGE_MS = 200;
const LIST_PAGE_SIZE = 30;
const RECENT_PAGE_SIZE = 10;
const originalFetch = globalThis.fetch;
const originalError = console.error;
const originalReader = globalThis.FileReader;
const originalClick = window.HTMLInputElement.prototype.click;
const originalChartUpdate = Chart.prototype.update;
const EMPTY_STATS = {tests: {total: 0}, previous: null};
const POPULATED_STATS = {...EMPTY_STATS, tests: {total: 1, successful: 1, failed: 0},
    time: {min: 1, max: 1, avg: 1}, labels: [], data: {}, downsampled: true,
    download: {min: 100, max: 100, avg: 100}, upload: {min: 20, max: 20, avg: 20}};
const pendingAnswers = [];
const TARGETS = [{id: 1, name: "One"}, {id: 2, name: "Two"}];
const json = (body) => new Response(JSON.stringify(body), {status: 200});
const nest = (child, ...layers) => layers.reduceRight((inner, [Provider, value]) =>
    createElement(Provider, {value}, inner), child);

afterEach(async () => {
    for (const answer of pendingAnswers.splice(0)) answer();
    await settle();
    cleanup();
    globalThis.fetch = originalFetch;
    console.error = originalError;
    globalThis.FileReader = originalReader;
    window.HTMLInputElement.prototype.click = originalClick;
    Chart.prototype.update = originalChartUpdate;
    delete window.document.hidden;
});

const mount = ({hold = [], selectedTarget = null, storage = false, mutationOk = true,
    stats = EMPTY_STATS, list = [], recent = [], viewMode = false} = {}) => {
    // Layout is outside this regression. Chart.js reports jsdom's missing
    // canvas context; retain every other error so component failures remain visible.
    console.error = (...args) => {
        if (args[0] !== "Failed to create chart: can't acquire context from the given item") originalError(...args);
    };
    // No canvas exists to paint or update in jsdom. The rendered page, its
    // dialogs, requests and response-dependent text remain the production components.
    Chart.prototype.update = noop;
    const controls = {};
    const requests = [];
    const heldKinds = new Set(hold);
    let listFailure = false;
    globalThis.fetch = (url, init) => {
        const parsed = new URL(String(url), "http://localhost");
        if (parsed.pathname.endsWith("/storage/tests/history")) {
            requests.push({url: parsed, kind: "mutation", method: init.method});
            return Promise.resolve(new Response(JSON.stringify({imported: 1, skipped: 0}),
                {status: mutationOk ? 200 : 400}));
        }
        const query = parsed.searchParams;
        const kind = parsed.pathname.includes("/statistics/")
            ? query.has("targets") ? "comparison" : query.has("points") ? "detail" : "main"
            : query.get("limit") === String(RECENT_PAGE_SIZE) ? "recent" : "list";
        const body = kind === "main" || kind === "detail" ? stats
            : kind === "comparison" ? {byTarget: {1: EMPTY_STATS, 2: EMPTY_STATS}} : kind === "list" ? list : recent;
        const record = {url: parsed, kind};
        requests.push(record);
        if (kind === "list" && listFailure) return Promise.reject(new Error("list unavailable"));
        if (heldKinds.has(kind)) return new Promise((resolve, reject) => {
            record.answer = (value = body) => resolve(json(value));
            record.reject = reject;
            pendingAnswers.push(record.answer);
        });
        return Promise.resolve(json(body));
    };
    const Driver = () => {
        controls.history = useContext(SpeedtestContext);
        [controls.params, controls.setParams] = useSearchParams();
        return null;
    };
    const Status = ({children}) => {
        const [status, setStatus] = useState({running: false, paused: false});
        controls.setStatus = setStatus;
        return createElement(StatusContext.Provider, {value: [status, noop, noop]}, children);
    };
    const Scope = ({children}) => {
        const [target, setTarget] = useState(selectedTarget);
        const [permission, setPermission] = useState(viewMode);
        controls.setTarget = setTarget;
        controls.setPermission = setPermission;
        return createElement(ConfigContext.Provider, {value: [{viewMode: permission, previewMode: false}, noop, noop]},
            createElement(TargetsContext.Provider, {value: {targets: TARGETS, reloadTargets: noop,
                pageTargetFor: () => null, selectedTarget: target, selectionFor: () => ({})}}, children));
    };
    const view = render(createElement(MemoryRouter, {initialEntries: ["/statistics?range=7d&compare=1y"]},
        nest(createElement(Scope, null, createElement(Status, null, createElement(SpeedtestProvider, null,
            createElement(AlertProvider, null, createElement(Driver), createElement(Statistics),
                storage && createElement("section", {"data-storage": true},
                    createElement(HistoryStorage, {tests: 1, close: noop})))))),
        [ConfigContext.Provider, [{viewMode: false, previewMode: false}, noop, noop]],
        [NodeContext.Provider, [[], noop, 0, noop, () => undefined]],
        [PreferencesContext.Provider, [{fullChartDetail: true}, noop]],
        [ToastNotificationContext.Provider, noop],
        [ThemeContext.Provider, {theme: "dark", palette: "slate", setTheme: noop, setPalette: noop}],
        [TargetsContext.Provider, {targets: TARGETS, reloadTargets: noop, pageTargetFor: () => null,
            selectedTarget, selectionFor: () => ({})}])));
    const ofKind = (kind) => requests.filter(request => request.kind === kind);
    const count = () => Object.fromEntries(["main", "recent", "comparison"].map(kind => [kind, ofKind(kind).length]));
    return {...view, controls, requests, ofKind, count,
        failList: () => { listFailure = true; console.error = noop; },
        holdKind: (kind) => heldKinds.add(kind),
        status: async (value) => { act(() => controls.setStatus(value)); await settle(); }};
};

const ready = async () => {
    await settle(FIRST_STAGE_MS);
    await settle(SECOND_STAGE_MS);
    await settle();
};
const complete = async (rig) => {
    await rig.status({running: true, progress: 0});
    await rig.status({running: false, progress: 100});
};
const assertRefreshed = (rig, before) => {
    assert.deepEqual(rig.count(), Object.fromEntries(Object.entries(before).map(([key, value]) => [key, value + 1])),
        "history changes must refresh the page's independent aggregate, recent-test and target-comparison requests");
};

describe("Statistics follows the shared history's actual invalidation events", () => {
    it("shows a same-target recent result while its aggregate refresh is pending", async () => {
        const test = {id: 1, targetId: 1, download: 111, upload: 22, ping: 3};
        const rig = mount({selectedTarget: 1, stats: POPULATED_STATS, recent: [test]});
        await ready();
        rig.holdKind("main");
        rig.holdKind("recent");
        await complete(rig);
        rig.ofKind("recent").at(-1).answer([{...test, id: 2, download: 777}]);
        await settle();
        assert.match(rig.container.textContent, /777/);
        assert.ok(rig.container.querySelector(".statistic-stale"));
    });

    for (const first of ["recent", "main"]) {
        it(`does not mix target scopes when ${first} responds first`, async () => {
            const oldTest = {id: 1, targetId: 1, download: 111, upload: 22, ping: 3};
            const newTest = {...oldTest, id: 2, targetId: 2, download: 777};
            const rig = mount({selectedTarget: 1, stats: POPULATED_STATS, recent: [oldTest]});
            await ready();
            rig.holdKind("main");
            rig.holdKind("recent");
            act(() => rig.controls.setTarget(2));
            await settle();
            const reply = kind => rig.ofKind(kind).at(-1).answer(kind === "main" ? POPULATED_STATS : [newTest]);
            reply(first);
            await settle();
            const card = [...rig.container.querySelectorAll(".stats-container")]
                .find(element => element.querySelector(".stats-header")?.textContent === "Last test");
            assert.ok(!card, "latest card must wait for the aggregate belonging to the same target");
            assert.ok(rig.container.querySelector(".statistic-stale"), "pending scope must be marked stale");
            reply(first === "main" ? "recent" : "main");
            await settle();
            assert.match(rig.container.textContent, /777/);
            assert.ok(!rig.container.querySelector(".statistic-stale"));
        });
    }

    it("refreshes the page's recent tests on permission changes and rejects old responses", async () => {
        const rig = mount({stats: POPULATED_STATS, hold: ["recent"], viewMode: true});
        await ready();
        assert.equal(rig.ofKind("recent").length, 1);
        act(() => rig.controls.setPermission(false));
        await settle();
        assert.equal(rig.ofKind("recent").length, 2, "sign-in must refetch Statistics' own rows");
        const test = {id: 1, targetId: 1, download: 777, upload: 22, ping: 3};
        rig.ofKind("recent")[1].answer([test]);
        await settle();
        rig.ofKind("recent")[0].answer([{...test, download: 111}]);
        await settle();
        assert.match(rig.container.textContent, /777/);
        act(() => rig.controls.setPermission(true));
        await settle();
        assert.equal(rig.ofKind("recent").length, 3, "sign-out must refetch as well");
        assert.doesNotMatch(rig.container.textContent, /777/, "privileged previous rows must be hidden while reloading");
    });

    it("refreshes for a global newest test while the alert-scoped latest row is unchanged", async () => {
        const rig = mount();
        await ready();
        await rig.status({running: false, lastTest: {id: 1}, latestTestId: 1});
        const before = rig.count();
        const revision = rig.controls.history.historyRevision;
        await rig.status({running: false, lastTest: {id: 1}, latestTestId: 2});
        assertRefreshed(rig, before);
        assert.equal(rig.controls.history.historyRevision, revision + 1);
    });

    it("treats an explicitly empty global history as reset without using the scoped row", async () => {
        const rig = mount();
        await ready();
        await rig.status({running: false, lastTest: {id: 1}, latestTestId: 2});
        const before = rig.count();
        await rig.status({running: false, lastTest: {id: 1}, latestTestId: null});
        assertRefreshed(rig, before);
    });

    for (const listMode of ["successful", "rejected", "pending"]) {
        it(`refreshes all page requests after a completed run with a ${listMode} list refresh`, async () => {
            const rig = mount();
            await ready();
            const before = rig.count();
            assert.deepEqual(before, {main: 1, recent: 1, comparison: 1});
            if (listMode === "rejected") rig.failList();
            if (listMode === "pending") rig.holdKind("list");
            await complete(rig);
            assertRefreshed(rig, before);
            assert.equal(String(rig.controls.params), "range=7d&compare=1y");
            for (const request of rig.ofKind("list")) request.answer?.();
            await settle();
        });
    }

    it("refreshes after the explicit reload used by history import and clear", async () => {
        const rig = mount();
        await ready();
        const before = rig.count();
        act(() => { rig.controls.history.reloadTests(); });
        await settle();
        assertRefreshed(rig, before);
    });

    for (const action of ["import", "clear"]) {
        for (const mutationOk of [true, false]) {
            it(`${mutationOk ? "refreshes after successful" : "does not invalidate after refused"} history ${action}`, async () => {
                const rig = mount({storage: true, mutationOk});
                await ready();
                const before = rig.count();
                globalThis.FileReader = class {
                    readAsText() { this.result = "[]"; this.onload(); }
                };
                window.HTMLInputElement.prototype.click = function () {
                    Object.defineProperty(this, "files", {value: [{}]});
                    this.onchange();
                };
                const button = [...rig.container.querySelectorAll("[data-storage] button")]
                    .find(element => element.textContent === (action === "import" ? "Import" : "Delete"));
                assert.ok(button);
                click(button);
                if (action === "clear") click(button);
                await settle();
                assert.equal(rig.ofKind("mutation").length, 1);
                assert.equal(rig.ofKind("mutation")[0].method, action === "import" ? "PUT" : "DELETE");
                if (mutationOk) assertRefreshed(rig, before);
                else assert.deepEqual(rig.count(), before);
            });
        }
    }

    it("re-fetches an open detail chart even though its query string is unchanged", async () => {
        const rig = mount({stats: POPULATED_STATS, hold: ["detail"]});
        await ready();
        const chart = [...rig.container.querySelectorAll(".chart-container")]
            .find(element => element.querySelector(".chart-title")?.textContent.startsWith("Download"));
        assert.ok(chart, "the populated page must offer the download chart");
        click(chart);
        await settle();
        assert.equal(rig.ofKind("detail").length, 1);
        await complete(rig);
        assert.equal(rig.ofKind("detail").length, 2, "history invalidation must rerun the open detail effect directly");
        assert.equal(String(rig.ofKind("detail")[0].url), String(rig.ofKind("detail")[1].url));
        const CURRENT_POINTS = 237;
        const OLD_POINTS = 119;
        const RAW_POINTS = 1000;
        rig.ofKind("detail")[1].answer({...POPULATED_STATS, dataPoints: CURRENT_POINTS, rawDataPoints: RAW_POINTS});
        await settle();
        rig.ofKind("detail")[0].answer({...POPULATED_STATS, dataPoints: OLD_POINTS, rawDataPoints: RAW_POINTS});
        await settle();
        const note = rig.container.querySelector('[role="dialog"] .chart-downsample-note');
        assert.ok(note);
        assert.match(note.textContent, new RegExp(String(CURRENT_POINTS)));
        assert.doesNotMatch(note.textContent, new RegExp(String(OLD_POINTS)));
    });

    it("catches up when a hidden tab becomes visible, without fetching when hidden", async () => {
        const rig = mount();
        await ready();
        const before = rig.count();
        Object.defineProperty(window.document, "hidden", {value: true, configurable: true});
        act(() => window.document.dispatchEvent(new window.Event("visibilitychange")));
        await settle();
        assert.deepEqual(rig.count(), before);
        Object.defineProperty(window.document, "hidden", {value: false, configurable: true});
        act(() => window.document.dispatchEvent(new window.Event("visibilitychange")));
        await settle();
        assertRefreshed(rig, before);
    });

    it("does not aggregate again for run acceptance, progress, or loading more list rows", async () => {
        const list = Array.from({length: LIST_PAGE_SIZE}, (_, index) =>
            ({id: LIST_PAGE_SIZE - index, created: "2026-09-08T10:00:00.000Z"}));
        const rig = mount({list});
        await ready();
        const before = rig.count();
        await rig.status({running: true, progress: 0});
        await rig.status({running: true, progress: 50});
        act(() => { rig.controls.history.updateTests(); });
        await settle();
        const beforePage = rig.ofKind("list").length;
        act(() => { rig.controls.history.loadMoreTests(); });
        await settle();
        assert.equal(rig.ofKind("list").length, beforePage + 1, "the test must exercise an actual page request");
        assert.deepEqual(rig.count(), before);
        assert.ok(rig.ofKind("list").every(request => request.url.searchParams.get("limit") === String(LIST_PAGE_SIZE)));
    });

    /**
     * The run that is over before anybody looked.
     *
     * The falling edge is a sample of a flag that is only true while a round is
     * in flight: the idle poll is five seconds and the live route is only
     * watched once `running` has been seen true, so a round that begins and
     * ends between two polls is never observed - no edge, no refresh, and every
     * surface hanging off this stays on the previous test until the next run.
     *
     * Reachable, and not only in theory: the live instance's history has four
     * rows whose provider could not read its own configuration, each written
     * within five seconds of the tick that started it, against successful runs
     * of eight to thirty seconds that no five-second poll can miss.
     *
     * So the newest test's identity is watched beside the flag. It is a fact
     * rather than a moment - a poll that missed the whole round still carries
     * it - and the status route has always sent it.
     */
    it("refreshes when a run too short to be sampled leaves a new test behind", async () => {
        const rig = mount();
        await ready();

        await rig.status({running: false, lastTest: {id: 1}});
        const before = rig.count();
        assert.deepEqual(before, {main: 1, recent: 1, comparison: 1},
            "the first status to name a test refetched the page that had just loaded it");

        // No run was ever reported: the round began and ended between two polls
        // and this is the first the client hears of it.
        await rig.status({running: false, lastTest: {id: 2}});
        assertRefreshed(rig, before);
    });

    // The two signals cost one refresh between them. A run that ends the
    // ordinary way reports both in the same answer - the flag has fallen and
    // the row it wrote is named beside it - and a page that asked twice for
    // that would double every request this suite counts.
    it("refreshes once when the run's end and its new row arrive together", async () => {
        const rig = mount();
        await ready();
        await rig.status({running: false, lastTest: {id: 1}});
        const before = rig.count();

        await rig.status({running: true, lastTest: {id: 1}, progress: 0});
        await rig.status({running: false, lastTest: {id: 2}, progress: 100});
        assertRefreshed(rig, before);
    });

    // And the poll that says nothing new says nothing at all: the same test
    // named again is the answer this instance gives every five seconds.
    it("does not refresh while the newest test is the one it already has", async () => {
        const rig = mount();
        await ready();
        await rig.status({running: false, lastTest: {id: 1}});
        const before = rig.count();

        await rig.status({running: false, lastTest: {id: 1}, recentFailures: 1});
        await rig.status({running: false, lastTest: {id: 1}, nextTest: "2026-09-08T15:00:00.000Z"});
        assert.deepEqual(rig.count(), before);
    });

    /**
     * A history emptied somewhere else is a change like any other.
     *
     * null is what the route answers for an instance with no tests, and it has
     * to be told from the key being absent - which is what a node too old to
     * report one sends, and what the placeholder this provider starts on holds
     * before any status has answered. Read as the same thing, the first poll of
     * every page load would refetch the page it had just loaded.
     */
    it("refreshes when the newest test is deleted from another tab", async () => {
        const rig = mount();
        await ready();
        await rig.status({running: false, lastTest: {id: 2}});
        const before = rig.count();

        await rig.status({running: false, lastTest: null});
        assertRefreshed(rig, before);
    });

    it("keeps the selected target when the completed run invalidates its statistics", async () => {
        const SELECTED_TARGET = 2;
        const rig = mount({selectedTarget: SELECTED_TARGET});
        await ready();
        await complete(rig);
        assert.equal(rig.ofKind("main").length, 2);
        assert.equal(rig.ofKind("recent").length, 2);
        assert.equal(rig.ofKind("comparison").length, 0);
        for (const request of [...rig.ofKind("main"), ...rig.ofKind("recent")])
            assert.equal(request.url.searchParams.get("target"), String(SELECTED_TARGET));
    });

    it("ignores a pre-completion statistics error after the new response has arrived", async () => {
        const rig = mount({hold: ["main", "recent", "comparison"]});
        await ready();
        await complete(rig);
        assert.equal(rig.ofKind("main").length, 2, "completion must issue a new generation before the old reply arrives");
        for (const kind of ["main", "recent", "comparison"]) rig.ofKind(kind)[1].answer();
        await settle();
        rig.ofKind("main")[0].reject(new Error("obsolete request failed"));
        rig.ofKind("recent")[0].answer();
        rig.ofKind("comparison")[0].answer();
        await settle();
        assert.doesNotMatch(rig.container.textContent, /obsolete request failed/);
    });

    it("keeps the newer comparison figures when the pre-completion response arrives last", async () => {
        const rig = mount({hold: ["comparison"], stats: POPULATED_STATS});
        await ready();
        await complete(rig);
        assert.equal(rig.ofKind("comparison").length, 2);
        const CURRENT_DOWNLOAD = 987;
        const OLD_DOWNLOAD = 123;
        const comparison = (download) => ({byTarget: {
            1: {...POPULATED_STATS, download: {avg: download}}, 2: POPULATED_STATS
        }});
        rig.ofKind("comparison")[1].answer(comparison(CURRENT_DOWNLOAD));
        await settle();
        rig.ofKind("comparison")[0].answer(comparison(OLD_DOWNLOAD));
        await settle();
        const cell = rig.container.querySelector(".target-compare-table tbody tr td");
        assert.ok(cell);
        assert.match(cell.textContent, new RegExp(String(CURRENT_DOWNLOAD)));
        assert.doesNotMatch(cell.textContent, new RegExp(String(OLD_DOWNLOAD)));
    });
});
