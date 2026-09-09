import {afterEach, describe, it} from "node:test";
import assert from "node:assert/strict";
import {useState} from "react";
import i18n from "i18next";
import german from "../../client/public/assets/locales/de.json" with {type: "json"};
import japanese from "../../client/public/assets/locales/ja.json" with {type: "json"};
import {act, cleanup, click, createElement as h, render, settle, window} from "../helpers/renderHarness.js";
import {IntegrationDialog} from "@/common/components/IntegrationDialog";
import {ConfigContext} from "@/common/contexts/Config";
import {NodeContext} from "@/common/contexts/Node";
const noop = () => {};
const originalFetch = globalThis.fetch;
afterEach(async () => {cleanup(); globalThis.fetch = originalFetch; await i18n.changeLanguage("en");});
const answer = (body, status = 200) => new Response(JSON.stringify(body), {status});
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
const document = window.document;
const definitions = {webhook: {fields: [{name: "url", type: "text"}, {name: "secret", type: "text", secret: true, required: true}]}};
const row = {id: 7, name: "webhook", displayName: "Stored integration", data: {url: "https://example.org", secret: "stored credential"}};
const mount = (mutation, create = false) => {
    let setOpen; const sent = [];
    globalThis.fetch = (url, init) => {
        if (init.method !== "GET") {sent.push(init); return mutation(init);}
        return Promise.resolve(answer(String(url).endsWith("/active") ? create ? [] : [row] : definitions));
    };
    const Harness = () => {const [open, updateOpen] = useState(true); setOpen = updateOpen;
        return h(ConfigContext.Provider, {value: [{previewMode: false}, noop]}, h(NodeContext.Provider, {value: [[], noop, 0]}, h(IntegrationDialog, {open, onClose: noop})));};
    render(h(Harness)); return {sent, open: value => act(() => setOpen(value))};
};
const type = (input, value) => act(() => {Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, value); input.dispatchEvent(new window.Event("input", {bubbles: true}));});
const edit = () => {click(document.querySelector(".expandable-card-header")); type(document.querySelector(".expandable-card-body input"), "My draft");};
const save = () => click(document.querySelector(".save-btn"));
const remove = () => {click(document.querySelector(".delete-btn")); click(document.querySelector(".delete-btn"));};
const createDraft = () => {
    click(document.querySelector(".dropdown-select-btn")); click(document.querySelector(".dropdown-select-item"));
    type(document.querySelector(".expandable-card-body input"), "My draft");
};
const failures = [
    ["invalid", () => Promise.resolve(answer({message: "SECRET"}, 400)), /Check the integration settings/],
    ["unauthorized", () => Promise.resolve(answer({}, 401)), /Sign in again/],
    ["preview", () => Promise.resolve(answer({type: "PREVIEW_READ_ONLY"}, 403)), /demo mode/],
    ["unknown 403", () => Promise.resolve(answer({type: "other"}, 403)), /permission/],
    ["legacy preview 403", () => Promise.resolve(answer({message: "You can't change anything on this instance in preview mode"}, 403)), /permission/],
    ["server", () => Promise.resolve(answer({message: "SECRET"}, 500)), null],
    ["malformed JSON", () => Promise.resolve(new Response("SECRET", {status: 403})), /permission/],
    ["empty JSON", () => Promise.resolve(new Response("", {status: 500})), null],
    ["null JSON", () => Promise.resolve(answer(null, 403)), /permission/],
    ["network", () => Promise.reject(new Error("SECRET")), null]
];
describe("integration mutation feedback", () => {
    for (const [language, translations] of [["de", german], ["ja", japanese]]) it(`renders ${language} feedback without raw keys or lost draft text`, async () => {
        i18n.addResourceBundle(language, "translation", translations); await i18n.changeLanguage(language);
        mount(() => Promise.resolve(answer({type: "PREVIEW_READ_ONLY"}, 403))); await settle(); edit(); save(); await settle();
        assert.equal(document.querySelector('[role="alert"]').textContent, `${translations.integrations.errors.save} ${translations.integrations.errors.preview}`);
        assert.equal(document.querySelector(".expandable-card-body input").value, "My draft");
    });
    for (const operation of ["create", "save", "delete"]) for (const [name, failure, reason] of failures) it(`${operation}: ${name} is announced safely and retains the card and draft`, async () => {
        mount(failure, operation === "create"); await settle(); if (operation === "create") createDraft(); else edit();
        if (operation === "delete") remove(); else save(); await settle();
        const alert = document.querySelector(".integration-mutation-error[role=alert]"); assert.ok(alert, "an error must be announced beyond the red border");
        assert.match(alert.textContent, new RegExp(`Couldn't ${operation === "delete" ? "delete" : "save"} the integration`)); if (reason) assert.match(alert.textContent, reason);
        assert.doesNotMatch(alert.textContent, /SECRET/); assert.equal(document.querySelector(".expandable-card-body input").value, "My draft");
        assert.ok(document.querySelector(".expandable-card"));
    });
    it("shows deletion failure even while the card is collapsed", async () => {
        mount(() => Promise.resolve(answer({}, 500))); await settle(); remove(); await settle();
        assert.equal(document.querySelector(".expandable-card-body"), null); assert.match(document.querySelector('[role="alert"]').textContent, /Couldn't delete/);
    });
    it("retries a refused PATCH while preserving untouched required fields", async () => {
        let calls = 0; const {sent} = mount(() => Promise.resolve(answer({}, ++calls === 1 ? 400 : 200))); await settle(); edit(); save(); await settle();
        assert.ok(document.querySelector('[role="alert"]')); save(); await settle();
        assert.equal(document.querySelector('[role="alert"]'), null); assert.ok(document.querySelector(".success-indicator"));
        assert.equal(sent[1].method, "PATCH"); assert.equal(JSON.parse(sent[1].body).secret, "stored credential");
    });
    it("retries deletion after a refusal and removes the card only on success", async () => {
        let calls = 0; mount(() => Promise.resolve(answer({}, ++calls === 1 ? 403 : 200))); await settle(); remove(); await settle();
        assert.ok(document.querySelector(".expandable-card")); click(document.querySelector(".delete-btn")); await settle();
        assert.equal(document.querySelector(".expandable-card"), null); assert.equal(document.querySelector('[role="alert"]'), null);
    });
    it("identifies a typed preview refusal on creation", async () => {
        mount(() => Promise.resolve(answer({type: "PREVIEW_READ_ONLY"}, 403)), true); await settle();
        click(document.querySelector(".dropdown-select-btn")); click(document.querySelector(".dropdown-select-item"));
        type(document.querySelector(".expandable-card-body input"), "New integration"); save(); await settle();
        assert.match(document.querySelector('[role="alert"]').textContent, /Couldn't save.*demo mode/);
    });
    for (const operation of ["save", "delete"]) it(`ignores ${operation} failure after close/reopen`, async () => {
        const held = deferred(); const view = mount(() => held.promise); await settle(); edit(); if (operation === "save") save(); else remove();
        view.open(false); view.open(true); await settle(); held.resolve(answer({}, 400)); await settle();
        assert.equal(document.querySelector('[role="alert"]'), null); assert.match(document.body.textContent, /Stored integration/);
    });
    it("ignores a save failure after the user has edited its submitted draft", async () => {
        const held = deferred(); mount(() => held.promise); await settle(); edit(); save(); type(document.querySelector(".expandable-card-body input"), "Newer draft");
        held.resolve(answer({}, 400)); await settle(); assert.equal(document.querySelector('[role="alert"]'), null); assert.equal(document.querySelector(".expandable-card-body input").value, "Newer draft");
    });
    it("does not let older save success clear a newer deletion failure", async () => {
        const held = deferred(); mount(init => init.method === "PATCH" ? held.promise : Promise.resolve(answer({}, 403))); await settle(); edit(); save(); remove(); await settle();
        held.resolve(answer({})); await settle(); assert.match(document.querySelector('[role="alert"]').textContent, /Couldn't delete/);
    });
});
