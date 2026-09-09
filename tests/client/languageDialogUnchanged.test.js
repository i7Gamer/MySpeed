import {afterEach, describe, it} from "node:test";
import assert from "node:assert/strict";
import i18n from "i18next";
import {cleanup, click, createElement, render, settle, window} from "../helpers/renderHarness.js";
import LanguageDialog from "@/common/components/LanguageDialog";
import {languages} from "@/i18n";
import {ToastNotificationContext} from "@/common/contexts/ToastNotification";
import {readStored, writeStored, removeStored} from "@/common/utils/Storage";

const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const noop = () => {};
afterEach(async () => {
    for (const key of ["language", "preferences", "currentNode"]) removeStored(key);
    Object.defineProperty(globalThis, "localStorage", storageDescriptor);
    cleanup();
    await i18n.changeLanguage("en");
});

describe("saving an unchanged language selection", () => {
    for (const blocked of [false, true]) it(`preserves the language and other preferences with ${blocked ? "blocked" : "available"} storage`, async () => {
        if (blocked) Object.defineProperty(globalThis, "localStorage", {configurable: true, get() {throw new Error("Storage blocked");}});
        const preferences = JSON.stringify({timeFormat: "12h", range: "week", showIp: true});
        writeStored("language", "de"); writeStored("preferences", preferences); writeStored("currentNode", "3");
        await i18n.changeLanguage("de");
        render(createElement(ToastNotificationContext.Provider, {value: noop}, createElement(LanguageDialog, {open: true, onClose: noop})));
        await settle();
        assert.equal(window.document.querySelector('[role="radio"][aria-checked="true"]').textContent,
            languages.find(language => language.code === "de").name);
        click(window.document.querySelector(".language-dialog button.dialog-btn")); await settle();
        assert.equal(readStored("language"), "de"); assert.equal(i18n.language, "de");
        assert.equal(readStored("preferences"), preferences); assert.equal(readStored("currentNode"), "3");
    });
});
