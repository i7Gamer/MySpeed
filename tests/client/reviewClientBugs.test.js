import {afterEach, describe, it} from "node:test";
import assert from "node:assert/strict";
import {useState} from "react";
import {Chart} from "chart.js";
import {cleanup, createElement, focus, keydown, render, settle, window} from "../helpers/renderHarness.js";
import RouteTable from "@/common/components/TestDetails/RouteTable.jsx";
import {login} from "@/common/utils/RequestUtil";
import {connectionChange} from "@/common/utils/TestUtil";
import {maskTime} from "@/common/components/TimeField/timeValue";
import SelectableOption, {SelectableList} from "@/common/components/SelectableOption";
import PingChart from "@/pages/Statistics/charts/PingChart.jsx";
import {PreferencesContext} from "@/common/contexts/Preferences";
import {ThemeContext} from "@/common/contexts/Theme";

const originalFetch = globalThis.fetch;
const originalError = console.error;
const noop = () => {};
afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    console.error = originalError;
});

describe("review client regressions", () => {
    it("ignores malformed hop addresses without removing sibling content", () => {
        const hops = [{hop: 1, address: {evil: true}, rtt: [1], lost: 0},
            {hop: 2, address: [], rtt: [1], lost: 0},
            {hop: 3, address: "192.0.2.1", rtt: [1], lost: 0},
            {hop: 4, address: null, rtt: [], lost: 1}];
        const {container} = render(createElement("main", null,
            createElement("p", null, "Still here"), createElement(RouteTable, {hops})));
        assert.match(container.textContent, /Still here/);
        assert.equal(container.querySelectorAll("tbody tr").length, 2);
    });

    for (const error of [new DOMException("Aborted", "AbortError"), new TypeError("Network failed")]) {
        it(`reports ${error.name} as an unreachable login`, async () => {
            globalThis.fetch = async () => {throw error;};
            assert.deepEqual(await login("secret"), {ok: false, unreachable: true});
        });
    }

    it("preserves success and credential rejection login outcomes", async () => {
        globalThis.fetch = async () => new Response("{}", {status: 200});
        assert.deepEqual(await login("secret"), {ok: true});
        globalThis.fetch = async () => new Response(JSON.stringify({type: "password"}), {status: 401});
        assert.deepEqual(await login("secret"), {ok: false, type: "password"});
    });

    it("does not badge IPv4 and IPv6 alternation as a changed address", () => {
        const ipv4 = {externalIp: "192.0.2.1", isp: "Same"};
        const ipv6 = {externalIp: "2001:db8::1", isp: "Same"};
        assert.equal(connectionChange(ipv4, ipv6), null);
        assert.equal(connectionChange(ipv6, ipv4), null);
        assert.deepEqual(connectionChange({...ipv6, isp: "New"}, ipv4), {isp: true, externalIp: false});
    });

    it("keeps meridiem while only the hour has been typed", () => {
        for (const [input, expected] of [["9p", "9 P"], ["12a", "12 A"], ["9PM", "9 PM"]]) {
            assert.equal(maskTime(input, true), expected);
            assert.equal(maskTime(expected, true), expected);
        }
        assert.equal(maskTime("9p", false), "9");
        assert.equal(maskTime("04:30p", true), "04:30 P");
        assert.equal(maskTime("9", true), "9");
    });

    it("uses one radio tab stop and moves selection with arrows, Home and End", () => {
        const choices = ["One", "Two", "Three"];
        const Group = () => {
            const [value, setValue] = useState("Two");
            return createElement(SelectableList, null, choices.map(title => createElement(SelectableOption,
                {key: title, title, active: value === title, onClick: () => setValue(title)})));
        };
        const {container} = render(createElement(Group));
        const radios = [...container.querySelectorAll('[role="radio"]')];
        assert.deepEqual(radios.map(row => row.tabIndex), [-1, 0, -1]);
        focus(radios[1]);
        keydown(radios[1], "ArrowDown");
        assert.equal(window.document.activeElement, radios[2]);
        assert.equal(radios[2].getAttribute("aria-checked"), "true");
        keydown(radios[2], "ArrowRight");
        assert.equal(window.document.activeElement, radios[0]);
        keydown(radios[0], "End");
        assert.equal(window.document.activeElement, radios[2]);
        keydown(radios[2], "Home");
        assert.equal(window.document.activeElement, radios[0]);
        keydown(radios[0], "Tab");
        assert.equal(radios[0].getAttribute("aria-checked"), "true");
    });

    it("keeps an unmatched radio value reachable and a lone radio navigable", () => {
        const {container} = render(createElement(SelectableList, null,
            createElement(SelectableOption, {title: "Only", onClick: noop})));
        const radio = container.querySelector('[role="radio"]');
        assert.equal(radio.tabIndex, 0);
        focus(radio);
        keydown(radio, "ArrowLeft");
        assert.equal(window.document.activeElement, radio);
    });

    it("plots the older-node zero ping sentinel as a gap", async () => {
        console.error = (...args) => {
            if (args[0] !== "Failed to create chart: can't acquire context from the given item") originalError(...args);
        };
        const labels = ["2026-09-01T01:00:00Z", "2026-09-01T02:00:00Z"];
        render(createElement(PreferencesContext.Provider, {value: [{}, noop]},
            createElement(ThemeContext.Provider, {value: {theme: "dark", palette: "slate"}},
                createElement(PingChart, {labels, data: {ping: [0, 12]}}))));
        await settle();
        const chart = Object.values(Chart.instances).find(instance => instance.data.labels === labels);
        assert.ok(chart, "the actual chart configuration must be constructed");
        assert.deepEqual(chart.data.datasets[0].data.map(point => point.y), [null, 12]);
    });
});
