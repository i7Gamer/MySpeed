import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {act, cleanup, click, createElement as h, render, window} from "../helpers/renderHarness.js";
import {useState} from "react";
import {t} from "i18next";
import {AlertProvider} from "@/common/contexts/Alert";
import {ConfigContext} from "@/common/contexts/Config";
import {PreferencesContext} from "@/common/contexts/Preferences";
import {SpeedtestContext} from "@/common/contexts/Speedtests";
import {TargetsContext} from "@/common/contexts/Targets";
import {ToastNotificationContext} from "@/common/contexts/ToastNotification";
import {formatDateTime} from "@/common/utils/FormatUtil";
import SpeedtestComponent from "@/pages/Home/components/Speedtest/SpeedtestComponent";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

const locale = (code) => JSON.parse(
    fs.readFileSync(path.join(ROOT, "client", "public", "assets", "locales", `${code}.json`), "utf8"));

const originalFetch = globalThis.fetch;
const FADE_MS = 300;
const BEFORE_FADE_MS = FADE_MS - 1;
const ENTRY = {
    id: 42, created: "2026-09-07T10:00:00.000Z", ping: 12, download: 100, upload: 50,
    type: "auto", provider: "ookla"
};
const noop = () => {};
const response = (status = 200) => new Response(JSON.stringify({message: "Deletion refused"}), {
    status, headers: {"content-type": "application/json"}
});

afterEach(() => { globalThis.fetch = originalFetch; cleanup(); });

const mountRow = (reply = async () => response()) => {
    const requests = [], toasts = [], removed = [];
    globalThis.fetch = async (url, init) => {
        requests.push({url: String(url), method: init.method});
        return reply();
    };
    // A stateful context consumer proves the row's deletion callback updates
    // its host list; the production provider's paging rules have their own tests.
    const List = () => {
        const [entries, setEntries] = useState([ENTRY]);
        const deleteTest = id => {
            removed.push(id);
            setEntries(current => current.filter(entry => entry.id !== id));
        };
        return h(SpeedtestContext.Provider, {value: {deleteTest}}, entries.map(entry =>
            h(SpeedtestComponent, {...entry, key: entry.id, test: entry, time: entry.created,
                down: entry.download, up: entry.upload})));
    };
    const view = render(h(AlertProvider, null,
        h(ConfigContext.Provider, {value: [{viewMode: false, previewMode: false}, noop, noop]},
            h(PreferencesContext.Provider, {value: [{}, noop]},
                h(TargetsContext.Provider, {value: {targets: [], byId: {}}},
                    h(ToastNotificationContext.Provider, {value: (...args) => toasts.push(args)}, h(List)))))));
    assert.equal(view.container.querySelector(".detail-delete"), null, "details start collapsed");
    click(view.container.querySelector(".speedtest"));
    click(view.container.querySelector(".detail-delete"));
    const dialog = window.document.querySelector(".dialog");
    assert.ok(dialog, "clicking Delete must open its real confirmation");
    return {...view, dialog, requests, toasts, removed};
};

const answerConfirmation = async (dialog, confirmed) => {
    const buttons = [...dialog.querySelectorAll(".dialog-btn")];
    const label = t(confirmed ? "test.delete_confirm.yes" : "dialog.close");
    click(buttons.find(button => button.textContent === label));
    // AlertProvider resolves only when the CSS fade finishes; jsdom has no CSS animation.
    await act(async () => dialog.dispatchEvent(new window.AnimationEvent("animationend", {
        bubbles: true, animationName: "fadeOut"
    })));
};

describe("the rendered delete confirmation", () => {
    it("identifies the destructive action and leaves a pending/cancelled deletion untouched", async () => {
        const view = mountRow();
        assert.equal(view.dialog.querySelector(".dialog-danger").textContent, t("test.delete_confirm.yes"));
        assert.ok(view.dialog.textContent.includes(t("test.delete_confirm.title")));
        assert.ok(view.dialog.textContent.includes(formatDateTime(ENTRY.created, {})));
        assert.deepEqual(view.requests, []);
        assert.deepEqual(view.toasts, []);
        assert.equal(view.container.querySelector(".speedtest-hidden"), null);
        await answerConfirmation(view.dialog, false);
        assert.deepEqual(view.requests, [], "cancelling must never send DELETE");
        assert.deepEqual(view.toasts, []);
        assert.deepEqual(view.removed, []);
        assert.equal(view.container.querySelector(".speedtest-hidden"), null);
        assert.ok(view.container.querySelector(".speedtest-entry"));
    });

    it("waits for the server, then fades and removes the confirmed row after its delay", async context => {
        let finish;
        const pending = new Promise(resolve => { finish = resolve; });
        const view = mountRow(() => pending);
        context.mock.timers.enable({apis: ["setTimeout"]});
        await answerConfirmation(view.dialog, true);
        assert.deepEqual(view.requests, [{url: "/api/speedtests/42", method: "DELETE"}]);
        assert.deepEqual(view.toasts, []);
        assert.equal(view.container.querySelector(".speedtest-hidden"), null);
        await act(async () => finish(response()));
        assert.ok(view.container.querySelector(".speedtest-hidden"));
        assert.equal(view.toasts.length, 1);
        assert.equal(view.toasts[0][0], t("test.deleted"));
        assert.equal(view.toasts[0][1], "green");
        act(() => context.mock.timers.tick(BEFORE_FADE_MS));
        assert.deepEqual(view.removed, []);
        assert.ok(view.container.querySelector(".speedtest-entry"));
        act(() => context.mock.timers.tick(FADE_MS - BEFORE_FADE_MS));
        assert.deepEqual(view.removed, [ENTRY.id]);
        assert.equal(view.container.querySelector(".speedtest-entry"), null);
    });

    for (const [name, reply] of [
        ["server refusal", async () => response(403)],
        ["network failure", async () => { throw new Error("Network unavailable"); }]
    ]) it(`keeps the row and reports a ${name}`, async () => {
        const view = mountRow(reply);
        await answerConfirmation(view.dialog, true);
        assert.deepEqual(view.requests, [{url: "/api/speedtests/42", method: "DELETE"}]);
        assert.deepEqual(view.removed, []);
        assert.equal(view.toasts.length, 1);
        assert.equal(view.toasts[0][1], "red");
        assert.equal(view.container.querySelector(".speedtest-hidden"), null);
        assert.ok(view.container.querySelector(".speedtest-entry"));
    });
});

describe("what the confirmation says", () => {
    const KEYS = ["title", "description", "yes"];

    for (const code of ["en", "de"]) {
        it(`${code}.json carries the confirmation`, () => {
            const strings = locale(code).test?.delete_confirm;

            assert.notEqual(strings, undefined, `${code}.json has no test.delete_confirm`);

            for (const key of KEYS)
                assert.equal(typeof strings[key], "string", `test.delete_confirm.${key} is missing from ${code}.json`);
        });
    }

    // The row a misdirected click lands on is the one being read, so the
    // question has to name the test rather than asking about "this item".
    it("names the test it is about to delete", () => {
        assert.match(locale("en").test.delete_confirm.description, /\{\{date}}/,
            "the question does not say which test it means");
    });

    it("says the deletion cannot be undone", () => {
        assert.match(locale("en").test.delete_confirm.description, /cannot be undone/i);
    });

});
