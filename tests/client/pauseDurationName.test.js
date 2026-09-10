import {afterEach, it} from "node:test";
import assert from "node:assert/strict";
import i18n from "i18next";
import {cleanup, click, createElement, render} from "../helpers/renderHarness.js";
import german from "../../client/public/assets/locales/de.json" with {type: "json"};
import {PauseDialog} from "@/common/components/PauseDialog/PauseDialog";
import {ConfigContext} from "@/common/contexts/Config";
import {ToastNotificationContext} from "@/common/contexts/ToastNotification";

const noop = () => {};
i18n.addResourceBundle("de", "translation", german);
afterEach(async () => {cleanup(); await i18n.changeLanguage("en");});

for (const language of ["en", "de"]) {
    it(`names the custom pause duration and retains its step controls in ${language}`, async () => {
        await i18n.changeLanguage(language);
        const {container} = render(createElement(ConfigContext.Provider, {value: [{}, noop, noop]},
            createElement(ToastNotificationContext.Provider, {value: noop},
                createElement(PauseDialog, {open: true, onClose: noop}))));
        click([...container.ownerDocument.querySelectorAll("button")]
            .find(button => button.textContent === i18n.t("pause.custom")));
        const dialog = container.ownerDocument.querySelector(".pause-dialog");
        const input = dialog.querySelector('input[type="number"]');
        assert.equal(input.getAttribute("aria-label"),
            `${i18n.t("pause.custom")} (${i18n.t("update.hours")})`);
        assert.equal(input.tabIndex, 0);
        const stepper = dialog.querySelector(".number-field-step-up");
        click(stepper);
        assert.equal(input.value, input.min);
        assert.equal(stepper.tabIndex, -1);
        assert.equal(stepper.getAttribute("aria-hidden"), "true");
    });
}
