import {afterEach, it} from "node:test";
import assert from "node:assert/strict";
import i18n from "i18next";
import {act, cleanup, click, createElement, render, settle, window} from "../helpers/renderHarness.js";
import LanguageDialog from "@/common/components/LanguageDialog";
import {ToastNotificationContext} from "@/common/contexts/ToastNotification";
import {readStored, writeStored} from "@/common/utils/Storage";
import english from "../../client/public/assets/locales/en.json" with {type: "json"};
import german from "../../client/public/assets/locales/de.json" with {type: "json"};

let completeLoad;
const requests = [];
const backend = {type: "backend", init() {}, read(language, namespace, callback) {
    requests.push(language);
    completeLoad = callback;
}};

afterEach(async () => {
    cleanup();
    await i18n.changeLanguage("en");
});

const mount = async () => {
    requests.length = 0;
    await i18n.use(backend).init({lng: "en", fallbackLng: "en", supportedLngs: ["en", "de"],
        resources: {en: {translation: english}}, partialBundledLanguages: true,
        interpolation: {escapeValue: false}, maxRetries: 0});
    writeStored("language", "en");
    const toasts = [];
    render(createElement(ToastNotificationContext.Provider, {value: (...args) => toasts.push(args)},
        createElement(LanguageDialog, {open: true, onClose() {}})));
    await settle();
    const germanOption = [...window.document.querySelectorAll('[role="radio"]')]
        .find(option => option.textContent === "de");
    click(germanOption);
    const submit = window.document.querySelector(".language-dialog button.dialog-btn");
    click(submit);
    return {submit, toasts};
};

it("keeps the dialog pending until a locale loads, then confirms in the new language", async () => {
    const {submit, toasts} = await mount();
    assert.equal(toasts.length, 0, "success was announced before the locale arrived");
    assert.equal(submit.disabled, true);
    assert.equal(readStored("language"), "en");
    assert.equal(window.document.querySelector(".language-dialog [data-overlay-dismiss]"), null);
    await act(async () => window.document.dispatchEvent(new window.KeyboardEvent("keydown", {key: "Escape", bubbles: true})));
    assert.equal(window.document.querySelector(".language-dialog").classList.contains("dialog-hidden"), false);
    click(submit);
    assert.deepEqual(requests, ["de"]);
    await act(async () => completeLoad(null, german));
    await settle();
    assert.equal(i18n.language, "de");
    assert.equal(readStored("language"), "de");
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0][0], german.dropdown.language_changed);
    assert.equal(toasts[0][1], "green");
});

it("reports a failed locale load and retains the previous language and saved selection", async () => {
    const {submit, toasts} = await mount();
    await act(async () => completeLoad(new Error("fixture locale unavailable"), false));
    await settle();
    assert.equal(i18n.language, "en");
    assert.equal(readStored("language"), "en");
    assert.equal(submit.disabled, false);
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0][0], english.dropdown.changes_unsaved);
    assert.equal(toasts[0][1], "red");
    click(submit);
    await settle();
    assert.equal(i18n.language, "en", "a cached backend failure must not activate fallback-only content");
    assert.equal(readStored("language"), "en");
    assert.equal(toasts.at(-1)[1], "red");
});

it("switches back to a cached locale without a request", async () => {
    const {submit} = await mount();
    await act(async () => completeLoad(null, german));
    await settle();
    const englishOption = [...window.document.querySelectorAll('[role="radio"]')]
        .find(option => option.textContent === "en");
    click(englishOption);
    click(submit);
    await settle();
    assert.equal(i18n.language, "en");
    assert.equal(readStored("language"), "en");
    assert.deepEqual(requests, ["de"]);
});
