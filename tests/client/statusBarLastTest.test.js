import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoryRouter } from "react-router-dom";
import { cleanup, createElement, render, settle, window } from "../helpers/renderHarness.js";
import { ConfigContext } from "@/common/contexts/Config";
import { PreferencesContext } from "@/common/contexts/Preferences";
import { StatusContext } from "@/common/contexts/Status";
import { SpeedtestContext } from "@/common/contexts/Speedtests";
import StatusBarComponent from "@/common/components/StatusBar/StatusBarComponent";

/**
 * The bar's headline over a list that failed to load.
 *
 * StatusBarComponent falls back to speedtests[0] whenever the status carries
 * no lastTest of its own - the initial state, a failing poll, or an older
 * proxied node - and SpeedtestContext answers a failed fetch with the same
 * empty list an unused instance has, while setting loadError beside it. The
 * bar never read that flag, so "No test has run yet" was printed over an
 * instance the retry button two lines below was already apologising for.
 */
afterEach(cleanup);

const noop = () => undefined;

// An instance in good standing: not read-only, not a preview.
const CONFIG = {viewMode: false, previewMode: false};

const nest = (child, ...layers) =>
    layers.reduceRight((inner, [Provider, value]) => createElement(Provider, {value}, inner), child);

const mount = ({status = {paused: false, running: false}, speedtestContext}) =>
    render(createElement(MemoryRouter, null,
        nest(createElement(StatusBarComponent),
            [ConfigContext.Provider, [CONFIG, noop, noop]],
            [PreferencesContext.Provider, [{}, noop]],
            [StatusContext.Provider, [status, noop, noop]],
            [SpeedtestContext.Provider, speedtestContext])));

const heading = () => window.document.querySelector(".status-text h2")?.textContent;

describe("the status bar's headline when the speedtest list failed to load", () => {
    it("reads the unknown state rather than the never-run line", async () => {
        mount({speedtestContext: {speedtests: [], loadError: "boom"}});

        await settle();

        assert.equal(heading(), "Last test unknown",
            "a failed list load is still reported as an instance that has never tested");
    });

    it("keeps the neutral icon and colour, not the failure triangle", async () => {
        mount({speedtestContext: {speedtests: [], loadError: "boom"}});

        await settle();

        const icon = window.document.querySelector(".status-icon");
        assert.ok(icon, "the bar drew no state icon");
        assert.ok(icon.classList.contains("icon-green"),
            "an unknown last test is coloured as though it were a known failure");
        assert.doesNotMatch(icon.getAttribute("data-icon") ?? "", /triangle-exclamation/,
            "an unknown last test is drawn with the failure triangle");
    });

    it("still reads the never-run line when there is genuinely no error", async () => {
        mount({speedtestContext: {speedtests: [], loadError: null}});

        await settle();

        assert.equal(heading(), "No test has run yet",
            "an instance with no error and no history lost its never-run line");
    });

    it("reads the relative time once a list is in hand", async () => {
        const TEN_MINUTES_AGO = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        mount({speedtestContext: {speedtests: [{created: TEN_MINUTES_AGO, failed: false}], loadError: null}});

        await settle();

        assert.match(heading(), /ago$/,
            "a loaded list no longer sets the bar's relative-time headline");
    });
});
