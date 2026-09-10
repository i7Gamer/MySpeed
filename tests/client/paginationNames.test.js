import {afterEach, it} from "node:test";
import assert from "node:assert/strict";
import i18n from "i18next";
import {MemoryRouter, useLocation} from "react-router-dom";
import {act, cleanup, click, createElement, focus, focused, render} from "../helpers/renderHarness.js";
import german from "../../client/public/assets/locales/de.json" with {type: "json"};
import {Pagination} from "@/common/components/Header/components/Pagination/Pagination.jsx";

const PAGE_KEYS = ["page.overview", "page.statistics"];
const PAGE_PATHS = ["/", "/statistics"];
i18n.addResourceBundle("de", "translation", german);

afterEach(async () => {
    cleanup();
    await i18n.changeLanguage("en");
});

const Location = () => createElement("output", null, useLocation().pathname);
const mount = (path = PAGE_PATHS[0]) => render(createElement(MemoryRouter, {initialEntries: [path]},
    createElement(Pagination), createElement(Location)));

it("keeps compact navigation named when its visible labels are hidden, including after language changes", async () => {
    const {container} = mount();
    const buttons = [...container.querySelectorAll("button.pagination-item")];
    assert.equal(buttons.length, PAGE_KEYS.length);
    // The narrow stylesheet hides these spans. jsdom has no responsive layout,
    // so reproduce that state explicitly and inspect the independent names.
    for (const button of buttons) button.querySelector("span").style.display = "none";

    for (const language of ["en", "de", "en"]) {
        await act(() => i18n.changeLanguage(language));
        for (const [index, button] of buttons.entries()) {
            assert.equal(button.getAttribute("aria-label"), i18n.t(PAGE_KEYS[index]));
            assert.equal(button.querySelector("span").style.display, "none");
        }
    }
});

for (const initialPath of PAGE_PATHS) {
    it(`retains focusable native buttons and route activation from ${initialPath}`, () => {
        const {container} = mount(initialPath);
        const buttons = [...container.querySelectorAll("button.pagination-item")];
        for (const [index, button] of buttons.entries()) {
            assert.equal(button.type, "button");
            assert.equal(button.tabIndex, 0);
            focus(button);
            assert.equal(focused(), button);
            // Native Enter/Space activation is verified in the browser; jsdom
            // does not synthesize a button's default click from key events.
            click(button);
            assert.equal(container.querySelector("output").textContent, PAGE_PATHS[index]);
            assert.ok(button.classList.contains("page-active"));
        }
    });
}
