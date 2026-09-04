import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { useContext } from "react";
import { act, cleanup, click, createElement, render, window } from "../helpers/renderHarness.js";
import { ToastNotificationContext, ToastNotificationProvider } from "@/common/contexts/ToastNotification";

afterEach(cleanup);

/**
 * The toast is the app's only channel for the outcome of a mutation - saved,
 * refused, cleared, imported - and it rendered as a bare div: no role, no
 * aria-live, so a screen reader was told nothing when it appeared. Every
 * dialog is announced; the answer that follows closing one was not, and a
 * refusal is the worse half, because the dialog stays open with no reason
 * spoken.
 *
 * The wrapper is in the document from mount, before any toast, which is what
 * makes a static attribute on it a live region the reader is already
 * watching when the text lands.
 */
describe("the toast as a live region", () => {
    const Firer = () => {
        const updateToast = useContext(ToastNotificationContext);
        return createElement("button", {id: "fire", onClick: () => updateToast("Changes applied", "green")}, "fire");
    };

    const mount = () => {
        const {container} = render(createElement(ToastNotificationProvider, null, createElement(Firer)));
        return {container, wrapper: () => window.document.querySelector(".toast-notification")};
    };

    it("is a polite status region before any toast has fired", () => {
        const {wrapper} = mount();

        assert.ok(wrapper(), "the wrapper is not mounted until a toast fires");
        assert.equal(wrapper().getAttribute("role"), "status");
        assert.equal(wrapper().getAttribute("aria-live"), "polite");
        assert.equal(wrapper().getAttribute("aria-atomic"), "true");
    });

    it("carries the message inside that region", async () => {
        const {container, wrapper} = mount();

        click(container.querySelector("#fire"));
        await act(() => Promise.resolve());

        assert.equal(wrapper().getAttribute("role"), "status");
        assert.match(wrapper().textContent, /Changes applied/);
    });
});
