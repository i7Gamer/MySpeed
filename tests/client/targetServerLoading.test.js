import {afterEach, describe, it} from "node:test";
import assert from "node:assert/strict";
import {useState} from "react";
import i18n from "i18next";
import german from "../../client/public/assets/locales/de.json" with {type: "json"};
import japanese from "../../client/public/assets/locales/ja.json" with {type: "json"};
import {act, cleanup, click, createElement as h, render, settle, window} from "../helpers/renderHarness.js";
import {TargetEditor} from "@/common/components/TargetsDialog/TargetEditor.jsx";
import {ConfigContext} from "@/common/contexts/Config";
import {TargetsContext} from "@/common/contexts/Targets";
import {ToastNotificationContext} from "@/common/contexts/ToastNotification";
const noop = () => {};
const originalFetch = globalThis.fetch;
afterEach(async () => {cleanup(); globalThis.fetch = originalFetch; await i18n.changeLanguage("en");});
const answer = body => new Response(JSON.stringify(body));
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
const document = window.document;
const mount = () => {
    let setOpen;
    const Harness = () => {const [open, updateOpen] = useState(true); setOpen = updateOpen;
        return h(ConfigContext.Provider, {value: [{}, noop]}, h(TargetsContext.Provider, {value: {targets: [], reloadTargets: noop}},
            h(ToastNotificationContext.Provider, {value: noop}, h(TargetEditor, {open, onClose: noop, target: {id: 1, name: "Stored", provider: "ookla", serverId: "999"}}))));};
    render(h(Harness)); return value => act(() => setOpen(value));
};
const switchProvider = name => click([...document.querySelectorAll('[role="radio"]')].find(row => row.textContent.includes(name)));
const input = key => document.querySelector(`[aria-label="${i18n.t(key)}"]`);
const type = (element, value) => act(() => {Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(element, value); element.dispatchEvent(new window.Event("input", {bubbles: true}));});

describe("target server list outcomes", () => {
    for (const [language, translations] of [["de", german], ["ja", japanese]]) it(`renders the ${language} error and retry without raw keys`, async () => {
        i18n.addResourceBundle(language, "translation", translations); await i18n.changeLanguage(language);
        globalThis.fetch = () => Promise.reject(new Error("offline")); mount(); await settle();
        assert.equal(document.querySelector('[role="alert"] span').textContent, translations.targets.server_list_error);
        assert.equal(document.querySelector('[role="alert"] button').textContent, translations.dialog.retry);
    });
    it("distinguishes failed and empty providers, retries only the failure, and preserves the draft", async () => {
        let ookla = 0, libre = 0; const held = deferred();
        globalThis.fetch = url => String(url).endsWith("ookla") ? (++ookla === 1 ? Promise.reject(new Error("offline")) : held.promise) : (libre++, Promise.resolve(answer({})));
        mount(); await settle();
        assert.match(document.querySelector('[role="alert"]').textContent, /Couldn't load the server list/);
        assert.equal(input("dialog.provider.server").value, "999");
        type(input("targets.name"), "My draft"); type(input("dialog.provider.server_id"), "123");
        switchProvider("LibreSpeed"); assert.equal(document.querySelector('[role="alert"]'), null);
        switchProvider("Ookla");
        const retry = document.querySelector(".target-server-feedback button"); click(retry); click(retry);
        assert.equal(retry.disabled, true); assert.equal(ookla, 2); assert.equal(libre, 1);
        held.resolve(answer({123: "Recovered server"})); await settle();
        assert.equal(document.querySelector('[role="alert"]'), null);
        assert.match(input("dialog.provider.server").textContent, /Recovered server/);
        assert.equal(input("targets.name").value, "My draft");
        assert.equal(input("dialog.provider.server_id").value, "999");
    });
    it("does not erase a typed server ID or name while retrying", async () => {
        let calls = 0;
        globalThis.fetch = url => String(url).endsWith("ookla") && ++calls === 1 ? Promise.reject(new Error("offline")) : Promise.resolve(answer({}));
        mount(); await settle(); type(input("targets.name"), "Draft"); type(input("dialog.provider.server_id"), "123");
        click(document.querySelector(".target-server-feedback button")); await settle();
        assert.equal(input("targets.name").value, "Draft"); assert.equal(input("dialog.provider.server_id").value, "123");
        assert.equal(input("dialog.provider.server").value, "123");
    });
    for (const fails of [false, true]) it(`ignores obsolete ${fails ? "failure" : "success"} after reopening`, async () => {
        const old = deferred(); let calls = 0;
        globalThis.fetch = url => String(url).endsWith("ookla") ? ++calls === 1 ? old.promise : Promise.resolve(answer({7: "Fresh server"})) : Promise.resolve(answer({}));
        const open = mount(); open(false); open(true); await settle();
        if (fails) old.reject(new Error("OLD")); else old.resolve(answer({8: "Old server"})); await settle();
        assert.match(input("dialog.provider.server").textContent, /Fresh server/); assert.doesNotMatch(document.body.textContent, /Old server/);
        assert.equal(document.querySelector('[role="alert"]'), null);
    });
});
