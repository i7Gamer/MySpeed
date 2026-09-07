import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource, withoutJsComments } from "../helpers/source.js";
import { cleanup, createElement, render } from "../helpers/renderHarness.js";
import { AlertProvider } from "@/common/contexts/Alert";
import { ConfigContext } from "@/common/contexts/Config";
import { PreferencesContext } from "@/common/contexts/Preferences";
import { TargetsContext } from "@/common/contexts/Targets";
import TestDetails from "@/common/components/TestDetails";

/*
 * The hop table a degraded run left behind, on the detail pane. Rendered
 * rather than pinned: what matters is which rows reach the screen and which
 * of them are marked as the place the route broke, and a text pin cannot see
 * a condition attached to the wrong gate.
 */

const noop = () => {};

const nest = (child, layers) =>
    layers.reduceRight((inner, [Provider, value]) => createElement(Provider, {value}, inner), child);

const mount = (test) => render(nest(createElement(AlertProvider, null, createElement(TestDetails, {test})), [
    [ConfigContext.Provider, [{viewMode: false, previewMode: false, ping: "25", download: "100", upload: "50"}, noop, noop]],
    [PreferencesContext.Provider, [{}, noop]],
    [TargetsContext.Provider, {targets: [], byId: {}, reloadTargets: noop}]
]));

const row = (extra = {}) => ({
    id: 1, ping: 12, jitter: 1, download: 100, upload: 50, time: 10, type: "auto", provider: "ookla",
    created: "2026-09-07T10:00:00.000Z", ...extra
});

const HOPS = [
    {hop: 1, address: "192.168.1.1", rtt: [0.5, 0.6, 0.5], lost: 0},
    {hop: 2, address: null, rtt: [], lost: 3},
    {hop: 3, address: "203.0.113.10", rtt: [11.2], lost: 2}
];

describe("the route section of the detail pane", () => {
    afterEach(cleanup);

    it("is absent from a run that left no table", () => {
        const {container} = mount(row());

        assert.equal(container.querySelector(".detail-route"), null);
    });

    it("is absent from a run whose table is empty", () => {
        const {container} = mount(row({hops: []}));

        assert.equal(container.querySelector(".detail-route"), null);
    });

    it("prints one row per hop, in order", () => {
        const {container} = mount(row({hops: HOPS}));

        const rows = [...container.querySelectorAll(".detail-route tbody tr")];

        assert.equal(rows.length, HOPS.length);
        assert.deepEqual(rows.map((line) => line.querySelector("td").textContent), ["1", "2", "3"]);
    });

    it("prints the address, and says so when a hop never answered", () => {
        const {container} = mount(row({hops: HOPS}));

        const rows = [...container.querySelectorAll(".detail-route tbody tr")];

        assert.match(rows[0].textContent, /192\.168\.1\.1/);
        assert.match(rows[1].textContent, /No reply/);
        assert.doesNotMatch(rows[1].textContent, /null/);
    });

    it("prints every latency the hop answered with, and its unit apart from the figure", () => {
        const {container} = mount(row({hops: HOPS}));

        const first = container.querySelectorAll(".detail-route tbody tr")[0];
        const figures = [...first.querySelectorAll(".detail-route-rtt")];

        assert.equal(figures.length, 3);
        assert.equal(figures[0].querySelector("span")?.textContent, "ms", "the unit is glued to the figure");
    });

    it("marks the hops where probes were lost", () => {
        const {container} = mount(row({hops: HOPS}));

        const marked = [...container.querySelectorAll(".detail-route tbody tr")]
            .map((line) => line.classList.contains("detail-hop-lost"));

        assert.deepEqual(marked, [false, true, true]);
    });

    it("says how many probes a partly answering hop lost", () => {
        const {container} = mount(row({hops: HOPS}));

        const third = container.querySelectorAll(".detail-route tbody tr")[2];

        assert.match(third.textContent, /2 lost/);
    });

    it("names its columns for a reader", () => {
        const {container} = mount(row({hops: HOPS}));

        const headers = [...container.querySelectorAll(".detail-route th")].map((cell) => cell.textContent);

        assert.deepEqual(headers, ["Hop", "Address", "Latency"]);
    });

    // A failed run has a table too - that is the run most worth one - and the
    // pane must not hide it behind the error block.
    it("shows the table of a failed run beside its error", () => {
        const {container} = mount(row({ping: -1, download: -1, upload: -1, error: "Timed out", hops: HOPS}));

        assert.notEqual(container.querySelector(".detail-error"), null);
        assert.equal(container.querySelectorAll(".detail-route tbody tr").length, HOPS.length);
    });
});

/**
 * The switch that turns the trace on, in the dialog that holds the optimum it
 * is judged against.
 */
describe("the trace switch in the optimal values dialog", () => {
    const dialog = withoutJsComments(readSource("client/src/common/components/OptimalValuesDialog/OptimalValuesDialog.jsx"));

    it("reads the setting off the config the way the three figures do", () => {
        assert.match(dialog, /config\.traceroute === "true"/);
    });

    it("writes it through the same patch the figures use, only when it changed", () => {
        assert.match(dialog, /patch\("\/config\/traceroute", traceroute \? "true" : "false"\)/);
    });

    it("is a labelled toggle", () => {
        assert.match(dialog, /<ToggleSwitch id="optimal-values-traceroute"/);
        assert.match(dialog, /label=\{t\("optimal_values\.trace_route"\)}/);
    });
});
