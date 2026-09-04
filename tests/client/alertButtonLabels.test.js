import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { t } from "i18next";
import { cleanup, click, createElement, render, window } from "../helpers/renderHarness.js";
import { AlertProvider, useAlert } from "@/common/contexts/Alert";

afterEach(cleanup);

/**
 * The buttons an alert falls back to when the caller named none.
 *
 * Seven callers pass a buttonText and one a cancelText; the rest relied on
 * the provider's fallback, which was the literal "OK" and "Cancel" - so the
 * confirm before deleting a target, and the alert explaining a provider, ended
 * in English under every one of the twenty-three locales. Both strings have
 * had keys the whole time: dialog.okay and dialog.close.
 */
describe("an alert's fallback buttons", () => {
    const Opener = ({variant}) => {
        const alert = useAlert();
        const open = () => variant === "confirm"
            ? alert.openConfirm("Title", "Body")
            : alert.openAlert("Title", "Body");
        return createElement("button", {id: "opener", onClick: open}, "open");
    };

    const buttonsOf = (variant) => {
        const {container} = render(createElement(AlertProvider, null, createElement(Opener, {variant})));
        click(container.querySelector("#opener"));

        const dialog = window.document.querySelector(".dialog");
        assert.ok(dialog, "the alert did not open");
        return [...dialog.querySelectorAll(".dialog-btn")].map((button) => button.textContent);
    };

    it("read the locale's okay, not the word OK", () => {
        assert.deepEqual(buttonsOf("alert"), [t("dialog.okay")]);
    });

    it("read the locale's close for the way out of a confirm", () => {
        assert.deepEqual(buttonsOf("confirm"), [t("dialog.close"), t("dialog.okay")]);
    });

    // The double answers the key when no bundle is loaded, and the literal is
    // what the fallback used to be - so this cannot pass by both being "OK".
    it("are keys, not English", () => {
        for (const label of buttonsOf("confirm")) assert.notEqual(["OK", "Cancel"].includes(label), true);
    });
});
