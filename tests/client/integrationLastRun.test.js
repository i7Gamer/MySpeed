import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { cleanup, createElement, render, settle, window } from "../helpers/renderHarness.js";
import { ConfigContext } from "@/common/contexts/Config";
import { IntegrationDialog } from "@/common/components/IntegrationDialog/IntegrationDialog";

/**
 * The card's subtitle is the last-run label glued to a relative time. In
 * English the label was "Last run before ", written for "5 minutes" and
 * read against every answer the clock gives - including "Just now", which
 * made "Last run before Just now". The other locales already end the label
 * with a colon; English now does too.
 */
afterEach(cleanup);

const noop = () => undefined;

const CONFIG = {viewMode: false, previewMode: false};

const DEFINITIONS = {
    webhook: {fields: [{name: "url", type: "text"}]}
};

const answer = (body) => new Response(JSON.stringify(body), {status: 200, headers: {"content-type": "application/json"}});

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

const mountWith = async (active) => {
    globalThis.fetch = async (url) => {
        const path = String(url);
        if (path.endsWith("/integrations/active")) return answer(active);
        if (path.endsWith("/integrations")) return answer(DEFINITIONS);
        return answer({});
    };

    render(createElement(ConfigContext.Provider, {value: [CONFIG, noop, noop]},
        createElement(IntegrationDialog, {open: true, onClose: noop})));
    await settle();

    return window.document.querySelector(".expandable-card");
};

describe("the card's last-run subtitle", () => {
    it("reads as a label and a moment, not a sentence about the moment", async () => {
        const card = await mountWith([{id: 1, name: "webhook", data: {url: "http://x"},
            lastActivity: new Date().toISOString()}]);

        assert.ok(card, "the card did not render");
        assert.match(card.textContent, /Last run: Just now/,
            "the label still reads as a sentence the relative time completes");
        assert.doesNotMatch(card.textContent, /before Just now/);
    });

    it("says so when the integration never ran", async () => {
        const card = await mountWith([{id: 1, name: "webhook", data: {url: "http://x"}, lastActivity: null}]);

        assert.ok(card, "the card did not render");
        assert.doesNotMatch(card.textContent, /Last run/);
    });
});
