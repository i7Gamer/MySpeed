import {afterEach, it} from "node:test";
import assert from "node:assert/strict";
import i18n from "i18next";
import {MemoryRouter} from "react-router-dom";
import {useTranslation} from "react-i18next";
import {act, cleanup, click, createElement, render, settle, window} from "../helpers/renderHarness.js";
import chinese from "../../client/public/assets/locales/zh-tw.json" with {type: "json"};
import Home from "@/pages/Home/Home.jsx";
import Header from "@/common/components/Header/HeaderComponent.jsx";
import {Nodes} from "@/pages/Nodes/Nodes.jsx";
import {AlertProvider} from "@/common/contexts/Alert";
import {ConfigContext} from "@/common/contexts/Config";
import {NodeContext} from "@/common/contexts/Node";
import {PreferencesContext} from "@/common/contexts/Preferences";
import {StatusContext} from "@/common/contexts/Status";
import {SpeedtestContext} from "@/common/contexts/Speedtests";
import {TargetsContext} from "@/common/contexts/Targets";
import {ThemeContext} from "@/common/contexts/Theme";
import {ToastNotificationContext} from "@/common/contexts/ToastNotification";

const noop = () => {};
const originalFetch = globalThis.fetch;
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
const SubscribedParent = ({children}) => {
    useTranslation();
    return children;
};
const TEST = {id: 1, created: "2026-09-09T10:00:00Z", download: 100, upload: 20, ping: 10,
    jitter: 1, packetLoss: 0, type: "auto", targetId: 1};
const CONFIG = {viewMode: false, previewMode: false, ping: "10", download: "100", upload: "20"};
const TARGET = {id: 1, name: "Test target"};
i18n.addResourceBundle("zh-TW", "translation", chinese);

afterEach(async () => {
    cleanup();
    globalThis.fetch = originalFetch;
    if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation);
    else delete globalThis.location;
    await i18n.changeLanguage("en");
});

const mount = (Component) => {
    Object.defineProperty(globalThis, "location", {value: window.location, configurable: true});
    globalThis.fetch = async (url) => {
        const path = String(url);
        const body = path.includes("/statistics/") ? {tests: {total: 0}, previous: null}
            : path.includes("/config") ? CONFIG : path.includes("/targets") ? [TARGET]
                : path.includes("/version") ? {} : [];
        return new Response(JSON.stringify(body));
    };
    const layers = [
        [ConfigContext.Provider, [CONFIG, noop, noop]],
        [NodeContext.Provider, [[], noop, 0, noop, () => undefined]],
        [PreferencesContext.Provider, [{}, noop]],
        [StatusContext.Provider, [{running: false, paused: false}, noop, noop]],
        [SpeedtestContext.Provider, {speedtests: [TEST], loading: false, hasMore: false,
            timeframe: "all", range: null, selectTimeframe: noop, selectRange: noop,
            loadMoreTests: noop, reloadTests: noop, updateTests: noop, deleteTest: noop}],
        [TargetsContext.Provider, {targets: [TARGET], byId: {1: TARGET}, selectedTarget: null,
            confirmedTarget: null, reloadTargets: noop, pageTargetFor: () => null, selectionFor: () => ({})}],
        [ThemeContext.Provider, {theme: "dark", palette: "slate", setTheme: noop, setPalette: noop}],
        [ToastNotificationContext.Provider, noop]
    ];
    // Stable elements and context values reproduce the module-level router:
    // changing language must update the view without a parent render or a poll.
    return render(createElement(MemoryRouter, null,
        layers.reduceRight((child, [Provider, value]) => createElement(Provider, {value}, child),
            createElement(SubscribedParent, null,
                createElement(AlertProvider, null, createElement(Component))))));
};

it("updates overview controls and existing expanded rows without losing state", async () => {
    const {container} = mount(Home);
    await settle();
    const row = container.querySelector(".speedtest");
    click(row);
    const details = container.querySelector(".speedtest-details");
    assert.ok(details);
    await act(() => i18n.changeLanguage("zh-TW"));
    assert.equal(container.querySelector(".start-test").textContent, chinese.status.start);
    assert.equal(container.querySelector(".start-test").getAttribute("aria-label"), chinese.status.start);
    assert.equal(container.querySelector(".speedtest-details"), details, "expanded content was remounted");
    assert.equal(row.getAttribute("aria-expanded"), "true");
    assert.ok(details.textContent.includes(chinese.latest.down));
});

for (const [name, Component, key] of [
    ["header", Header, "dropdown.settings"],
    ["nodes", Nodes, "nodes.add"]
]) {
    it(`updates the stable ${name} view immediately when language changes`, async () => {
        const {container} = mount(Component);
        await settle();
        await act(() => i18n.changeLanguage("zh-TW"));
        const translated = i18n.t(key);
        const matches = container.textContent.includes(translated)
            || [...container.querySelectorAll("[aria-label]")].some(node => node.getAttribute("aria-label") === translated);
        assert.ok(matches, `${name} still shows the previous language`);
    });
}
