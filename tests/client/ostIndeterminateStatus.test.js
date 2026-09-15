import {afterEach, it} from "node:test";
import assert from "node:assert/strict";
import {useState} from "react";
import {MemoryRouter} from "react-router-dom";
import i18n from "i18next";
import {act, cleanup, createElement as h, render, window} from "../helpers/renderHarness.js";
import {ConfigContext} from "@/common/contexts/Config";
import {PreferencesContext} from "@/common/contexts/Preferences";
import {StatusContext} from "@/common/contexts/Status";
import {SpeedtestContext} from "@/common/contexts/Speedtests";
import StatusBar from "@/common/components/StatusBar/StatusBarComponent";

const noop = () => {};
const ELAPSED_SECONDS = 32;
const MILLISECONDS_PER_SECOND = 1000;
afterEach(cleanup);

it("shows an honest animated indeterminate OST run until completion", context => {
    const started = Date.parse("2026-09-14T12:00:00Z");
    let now = started;
    context.mock.method(Date, "now", () => now);
    context.mock.method(globalThis, "setInterval", () => 0);
    let update;
    const Harness = () => {
        const [status, setStatus] = useState({running: true, paused: false, provider: "openspeedtest",
            phase: "start", progress: null, speed: null, startedAt: new Date(started).toISOString()});
        update = setStatus;
        return h(MemoryRouter, null,
            h(ConfigContext.Provider, {value: [{viewMode: false}, noop]},
                h(PreferencesContext.Provider, {value: [{}, noop]},
                    h(StatusContext.Provider, {value: [status, noop]},
                        h(SpeedtestContext.Provider, {value: {speedtests: [], loadError: null}}, h(StatusBar))))));
    };
    render(h(Harness));
    const document = window.document;
    assert.equal(document.querySelector(".status-text h2").textContent, i18n.t("status.phase.measuring"));
    assert.ok(document.querySelector(".status-progress-indeterminate"));
    assert.equal(document.querySelector('[role="progressbar"]').hasAttribute("aria-valuenow"), false);
    assert.equal(document.querySelector(".status-speed"), null);
    now += ELAPSED_SECONDS * MILLISECONDS_PER_SECOND;
    act(() => document.dispatchEvent(new window.Event("visibilitychange")));
    assert.ok(document.body.textContent.includes(i18n.t("status.elapsed", {seconds: ELAPSED_SECONDS})));
    assert.equal(document.querySelector('[role="progressbar"]').hasAttribute("aria-valuenow"), false);
    act(() => update({running: false, paused: false, lastTest: {created: new Date(now).toISOString(), failed: false}}));
    assert.equal(document.querySelector('[role="progressbar"]'), null);
});
