import {afterEach, it} from "node:test";
import assert from "node:assert/strict";
import i18n from "i18next";
import {cleanup, createElement, render, settle, window} from "../helpers/renderHarness.js";
import german from "../../client/public/assets/locales/de.json" with {type: "json"};
import {DataHelper} from "@/common/components/WelcomeDialog/steps/DataHelper/DataHelper.jsx";
import {OptimalValuesDialog} from "@/common/components/OptimalValuesDialog/OptimalValuesDialog.jsx";
import {ConfigContext} from "@/common/contexts/Config";
import {ToastNotificationContext} from "@/common/contexts/ToastNotification";

const noop = () => {};
const LIMITS = {ping: "25", download: "100", upload: "50"};
const LABELS = [["latest.ping", "welcome.ms", "ping"],
    ["latest.down", "welcome.mbps", "download"], ["latest.up", "welcome.mbps", "upload"]];
const originalFetch = globalThis.fetch;
i18n.addResourceBundle("de", "translation", german);

afterEach(async () => {
    cleanup();
    globalThis.fetch = originalFetch;
    await i18n.changeLanguage("en");
});

for (const language of ["en", "de"]) {
    for (const Component of [DataHelper, OptimalValuesDialog]) {
        it(`names every ${Component.name} optimum and its unit in ${language}`, async () => {
            await i18n.changeLanguage(language);
            globalThis.fetch = async () => new Response(JSON.stringify(LIMITS));
            render(createElement(ConfigContext.Provider, {value: [LIMITS, noop]},
                createElement(ToastNotificationContext.Provider, {value: noop},
                    createElement(Component, {...LIMITS, setPing: noop, setDownload: noop,
                        setUpload: noop, open: true, onClose: noop}))));
            await settle();
            const inputs = [...window.document.querySelectorAll('input[type="number"]')];
            assert.equal(inputs.length, LABELS.length);
            for (const [index, [name, unit, field]] of LABELS.entries()) {
                assert.equal(inputs[index].getAttribute("aria-label"), `${i18n.t(name)} ${i18n.t(unit)}`);
                assert.equal(inputs[index].value, LIMITS[field]);
                assert.equal(inputs[index].tabIndex, 0);
            }
        });
    }
}
