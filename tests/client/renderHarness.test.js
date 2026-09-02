import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { useState } from "react";
import {
    cleanup, click, createElement, focus, focused, pendingListenerError, render, window
} from "../helpers/renderHarness.js";
import { Counter } from "./fixtures/Counter.jsx";

/**
 * The harness itself, before anything is built on it: a component written as
 * JSX is loaded, rendered, and answers a click - and the document's notion of
 * focus behaves like a browser's on the two rules the real regressions turned
 * on.
 */
afterEach(cleanup);

describe("the render harness", () => {
    /**
     * jsdom reports an exception thrown inside a DOM listener on its own
     * channel and dispatchEvent returns as if nothing happened - so a hook
     * that threw passed every test that drove it, and only a focus assertion
     * that happened to look would have noticed. cleanup() rethrows what the
     * channel recorded, and every suite runs it after each test.
     */
    it("fails the test whose listener threw", () => {
        const {container} = render(createElement("button", null, "x"));
        const button = container.querySelector("button");
        button.addEventListener("click", () => { throw new Error("the listener threw"); });

        click(button);

        assert.ok(pendingListenerError(), "the throw was swallowed");
        assert.throws(() => cleanup(), /the listener threw/);
        assert.equal(pendingListenerError(), false, "the error was reported twice");
    });

    /**
     * There is one document per process and one pair of stores behind it, so
     * whatever a test leaves in them is what the next test in the file starts
     * from. A theme test that stored "light", a preferences test that stored a
     * default timeframe: the next test read it back as the state of a fresh
     * browser, and the order the file happens to be written in decided whether
     * it passed. Same for the attributes ThemeContext stamps on <html>, which
     * nothing else ever removes.
     */
    it("empties the storage and the document a test wrote to", () => {
        window.localStorage.setItem("theme", "light");
        window.sessionStorage.setItem("draft", "half a target");
        window.document.documentElement.setAttribute("data-theme", "light");
        window.document.documentElement.setAttribute("data-palette", "ember");

        cleanup();

        assert.equal(window.localStorage.length, 0, "a stored value outlived the test that wrote it");
        assert.equal(window.sessionStorage.length, 0, "a session value outlived the test that wrote it");
        assert.deepEqual(window.document.documentElement.getAttributeNames(), [],
            "the document root kept the theme a test stamped on it");
    });

    /**
     * And the clearing happens whether or not a listener threw. It used to be
     * the other way round - the throw left the mounts down but the stores and
     * the document untouched, so one failing test handed its state to every
     * test after it and turned one red mark into a cascade.
     */
    it("clears up before it reports a listener that threw", () => {
        const {container} = render(createElement("button", null, "x"));
        const button = container.querySelector("button");
        button.addEventListener("click", () => { throw new Error("the listener threw"); });
        window.localStorage.setItem("theme", "light");

        assert.throws(() => { click(button); cleanup(); }, /the listener threw/);
        assert.equal(window.localStorage.length, 0, "a failing test kept its storage");
    });

    it("loads a component written as JSX and renders it", () => {
        const {container} = render(createElement(Counter));

        assert.equal(container.querySelector("button").textContent, "0");
    });

    it("re-renders on an event dispatched like a reader's", () => {
        const {container} = render(createElement(Counter));
        const button = container.querySelector("button");

        click(button);
        click(button);

        assert.equal(button.textContent, "2");
    });

    // Plain React, no fixture: the hook runs under the real renderer.
    it("runs hooks under the real renderer", () => {
        const Toggle = () => {
            const [on, setOn] = useState(false);
            return createElement("button", {onClick: () => setOn(!on)}, on ? "on" : "off");
        };
        const {container} = render(createElement(Toggle));

        click(container.querySelector("button"));

        assert.equal(container.querySelector("button").textContent, "on");
    });

    /**
     * The two focus rules every shipped focus regression turned on. A disabled
     * control is not a focusable area, so focusing it lands nowhere - which is
     * why ExportButton waits for the export to end before giving focus back.
     * And an element removed from the document takes focus with it, leaving
     * the reader on the body - the state every menu fix exists to prevent.
     */
    it("models focus the way a browser does", () => {
        const {container} = render(createElement("div", null,
            createElement("button", {id: "live"}, "live"),
            createElement("button", {id: "dead", disabled: true}, "dead")));

        focus(container.querySelector("#live"));
        assert.equal(focused()?.id, "live");

        focus(container.querySelector("#dead"));
        assert.equal(focused()?.id, "live", "a disabled button took focus");

        container.querySelector("#live").remove();
        assert.equal(focused(), null, "focus survived the element it was on being removed");
    });
});
