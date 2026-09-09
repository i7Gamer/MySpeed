import {afterEach, beforeEach, it, mock} from "node:test";
import assert from "node:assert/strict";
import i18n from "i18next";
import {act, cleanup, createElement, render, settle, window} from "../helpers/renderHarness.js";
import {Chart} from "chart.js";
import german from "../../client/public/assets/locales/de.json" with {type: "json"};
import {SpeedChart} from "@/pages/Statistics/charts/SpeedChart/SpeedChart.jsx";
import PingChart from "@/pages/Statistics/charts/PingChart.jsx";
import HourlyChart from "@/pages/Statistics/charts/HourlyChart.jsx";
import TargetCompareChart from "@/pages/Statistics/charts/TargetCompareChart/TargetCompareChart.jsx";
import ChartWrapper from "@/common/components/ChartWrapper.jsx";
import {CreateNodeDialog} from "@/pages/Nodes/components/CreateNodeDialog/CreateNodeDialog.jsx";
import {PreferencesContext} from "@/common/contexts/Preferences";
import {ThemeContext} from "@/common/contexts/Theme";
import {NodeContext} from "@/common/contexts/Node";
import {ToastNotificationContext} from "@/common/contexts/ToastNotification";
import {AlertProvider} from "@/common/contexts/Alert";

const noop = () => {};
const originalError = console.error;
i18n.addResourceBundle("de", "translation", german);
// jsdom has no drawing context. Names are DOM behavior; keep real component
// lifecycle while preventing Chart.js from drawing into its null context.
beforeEach(() => mock.method(Chart.prototype, "update", noop));
afterEach(async () => { cleanup(); mock.restoreAll(); console.error = originalError; await i18n.changeLanguage("en"); });
const mount = element => {
    console.error = (...args) => {
        if (args[0] !== "Failed to create chart: can't acquire context from the given item") originalError(...args);
    };
    return render(createElement(PreferencesContext.Provider, {value: [{}, noop]},
        createElement(ThemeContext.Provider, {value: {resolved: "dark", palette: "slate"}}, element)));
};
const LABELS = ["2026-09-09T10:00:00Z"];
const DATA = {download: [100], upload: [20], ping: [10]};
const cases = [
    [SpeedChart, {labels: LABELS, data: DATA, dataKey: "download", titleKey: "latest.down"}, "latest.down"],
    [SpeedChart, {labels: [], data: {}, dataKey: "upload", titleKey: "latest.up"}, "latest.up"],
    [PingChart, {labels: LABELS, data: DATA}, "latest.ping"],
    [PingChart, {labels: [], data: {}}, "latest.ping"],
    [HourlyChart, {hourlyAverages: []}, "statistics.hourly.title"],
    ...["download", "upload", "ping"].map(metric => [TargetCompareChart,
        {targets: [{id: 1, name: "Line"}], statsById: {1: {labels: LABELS, data: DATA}}, fresh: true, metric},
        `statistics.targets.chart.${metric}`])
];

for (const [Component, props, title] of cases) {
    it(`names ${Component.displayName ?? Component.name ?? "chart"} ${title} and follows language changes`, async () => {
        const {container} = mount(createElement(Component, props));
        await settle();
        const canvas = container.querySelector("canvas");
        assert.ok(canvas, "fixture must render the actual chart");
        assert.equal(canvas.getAttribute("role"), "img");
        assert.equal(canvas.getAttribute("aria-label"), i18n.t(title));
        await act(() => i18n.changeLanguage("de"));
        assert.equal(canvas.getAttribute("aria-label"), i18n.t(title));
        assert.ok(canvas.getAttribute("aria-label").trim());
    });
}

for (const fresh of [true, false]) {
    it(`keeps comparison empty/loading text instead of an unnamed graphic (${fresh})`, () => {
        const {container} = mount(createElement(TargetCompareChart,
            {targets: [], statsById: {}, fresh, metric: "download"}));
        assert.equal(container.querySelector("canvas"), null);
        assert.ok(container.querySelector(".target-compare-hint").textContent.trim());
    });
}

for (const accessibleName of [undefined, "", "  ", {}]) {
    it(`protects a missing chart-name contract (${JSON.stringify(accessibleName)}) without throwing`, () => {
        const {container} = mount(createElement(ChartWrapper, {type: "line", data: {datasets: []}, accessibleName}));
        assert.equal(container.querySelector("canvas").getAttribute("aria-label"), i18n.t("page.statistics"));
    });
}

it("associates create-node fields with their visible localized headings", () => {
    mount(createElement(AlertProvider, null,
        createElement(NodeContext.Provider, {value: [[], noop]},
            createElement(ToastNotificationContext.Provider, {value: noop},
                createElement(CreateNodeDialog, {open: true, onClose: noop})))));
    const inputs = [...window.document.querySelectorAll(".server-input")];
    assert.equal(inputs.length, 2);
    for (const [index, key] of ["nodes.group.name", "nodes.group.url"].entries()) {
        const id = inputs[index].getAttribute("aria-labelledby");
        assert.ok(id);
        assert.equal(inputs[index].ownerDocument.getElementById(id).textContent, i18n.t(key));
    }
});
