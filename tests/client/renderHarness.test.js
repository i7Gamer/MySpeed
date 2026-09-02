import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { useState } from "react";
import { cleanup, click, createElement, focus, focused, render } from "../helpers/renderHarness.js";
import { Counter } from "./fixtures/Counter.jsx";

/**
 * The harness itself, before anything is built on it: a component written as
 * JSX is loaded, rendered, and answers a click - and the document's notion of
 * focus behaves like a browser's on the two rules the real regressions turned
 * on.
 */
afterEach(cleanup);

describe("the render harness", () => {
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
