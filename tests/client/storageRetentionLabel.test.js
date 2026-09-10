import {afterEach, it} from "node:test";
import assert from "node:assert/strict";
import i18n from "i18next";
import german from "../../client/public/assets/locales/de.json" with {type: "json"};
import {act, cleanup, createElement, render, window} from "../helpers/renderHarness.js";
import HistoryStorage from "@/common/components/StorageDialog/tabs/Speedtests.jsx";
import {ConfigContext} from "@/common/contexts/Config";
import {SpeedtestContext} from "@/common/contexts/Speedtests";
import {ToastNotificationContext} from "@/common/contexts/ToastNotification";

const noop = () => {};
const PRESET_DAYS = "365";
const CUSTOM_DAYS = "13";

afterEach(async () => {
    cleanup();
    await i18n.changeLanguage("en");
});

for (const language of ["en", "de"]) {
    for (const retentionDays of [PRESET_DAYS, CUSTOM_DAYS]) {
        it(`names custom retention and its unit in ${language} from ${retentionDays} days`, async () => {
            i18n.addResourceBundle("de", "translation", german);
            await i18n.changeLanguage(language);
            const {container} = render(createElement(ConfigContext.Provider,
                {value: [{retentionDays}, noop]}, createElement(SpeedtestContext.Provider,
                    {value: {reloadTests: noop}}, createElement(ToastNotificationContext.Provider,
                        {value: noop}, createElement(HistoryStorage, {tests: 0, close: noop})))));
            const select = container.querySelector("select");
            if (select) act(() => {
                select.value = "custom";
                select.dispatchEvent(new window.Event("change", {bubbles: true}));
            });
            const input = container.querySelector('input[type="number"]');
            assert.ok(input);
            assert.equal(input.getAttribute("aria-label"),
                `${i18n.t("storage.retention")} (${i18n.t("storage.retention_days_suffix")})`);
            assert.equal(input.value, retentionDays);
        });
    }
}
