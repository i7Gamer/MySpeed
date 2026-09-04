import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { useContext } from "react";
import { act, cleanup, click, createElement, render, window } from "../helpers/renderHarness.js";
import { ToastNotificationContext, ToastNotificationProvider } from "@/common/contexts/ToastNotification";
import { TOAST_HIDDEN } from "@/common/contexts/ToastNotification/toastState";
import { readSource } from "../helpers/source.js";

afterEach(cleanup);

/** One indented sass rule: from its selector line to the next line at column 0. */
const bodyOfSass = (source, selector) => {
    const start = source.indexOf(`\n${selector}\n`);
    assert.notEqual(start, -1, `${selector} has no rule`);
    const rest = source.slice(start + selector.length + 2);
    const end = rest.search(/\n\S/);

    return end === -1 ? rest : rest.slice(0, end);
};

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
        return {
            container,
            region: () => window.document.querySelector('[role="status"]'),
            wrapper: () => window.document.querySelector(".toast-notification")
        };
    };

    it("is a polite status region before any toast has fired", () => {
        const {region} = mount();

        assert.ok(region(), "the region is not mounted until a toast fires");
        assert.equal(region().getAttribute("aria-live"), "polite");
        assert.equal(region().getAttribute("aria-atomic"), "true");
    });

    /**
     * On an element that is never hidden. The role first sat on the visual
     * wrapper, which wears `toast-hidden` - `visibility: hidden` - whenever it
     * is idle, and a hidden subtree is out of the accessibility tree exactly
     * as `display: none` is. So the region was not being watched while idle;
     * it appeared and gained its text in one commit, which is the "live
     * region inserted with its content" case readers do not announce. The
     * announcer is its own element, clipped rather than hidden.
     */
    it("announces from an element that is never hidden", async () => {
        const {container, region, wrapper} = mount();

        assert.equal(region().classList.contains(TOAST_HIDDEN), false, "the idle region is visibility: hidden");
        assert.notEqual(region(), wrapper(), "the region is the visual wrapper, which hides itself when idle");
        assert.equal(wrapper().getAttribute("role"), null, "a second status region beside the announcer");

        click(container.querySelector("#fire"));
        await act(() => Promise.resolve());

        assert.equal(region().classList.contains(TOAST_HIDDEN), false);
    });

    it("carries the message inside that region", async () => {
        const {container, region} = mount();

        click(container.querySelector("#fire"));
        await act(() => Promise.resolve());

        assert.match(region().textContent, /Changes applied/);
    });

    // Clipped, not hidden: the rule the announcer relies on.
    it("is clipped out of view rather than hidden from the reader", () => {
        const styles = readSource("client/src/common/contexts/ToastNotification/styles.sass");
        const rule = bodyOfSass(styles, ".toast-announcer");

        assert.match(rule, /clip(-path)?:/, "the announcer is not clipped, so it sits visibly on the page");
        assert.doesNotMatch(rule, /visibility: hidden|display: none/, "the announcer hides itself from the reader");
    });
});
