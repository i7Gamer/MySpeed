import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    TOAST_HIDDEN, toastClassName
} from "../../client/src/common/contexts/ToastNotification/toastState.js";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

/**
 * Comments stripped before anything is asserted against the source.
 *
 * These files explain the bug they were fixed for in prose sitting right beside
 * the fix, so an assertion that the code no longer does X matches the sentence
 * saying it used to. What is being asserted is what the module does, not what
 * it says about itself.
 */
const withoutComments = (source) => source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const provider = withoutComments(fs.readFileSync(path.join(CLIENT_SRC,
    "common/contexts/ToastNotification/ToastNotificationContext.jsx"), "utf8"));

const RED_TOAST = {text: "Something failed", color: "red"};
const GREEN_TOAST = {text: "Saved", color: "green"};

/**
 * Why a toast could go permanently invisible.
 *
 * close() reached past React and added `toast-hidden` to the live DOM node,
 * while the same element's className was also being computed from state on
 * every render. React diffs a prop against the value it last rendered, not
 * against the DOM - so when the next toast arrived before the moveOut
 * animation had finished, the className it computed was identical to the one
 * React believed was already there, React skipped the write, and the
 * hand-added `toast-hidden` survived. The toast fired, the timer ran, the
 * state was right, and nothing appeared on screen.
 *
 * The class list is state's to compute, so there is one writer rather than two.
 */
describe("toastClassName", () => {
    it("always carries the base class", () => {
        assert.match(toastClassName(RED_TOAST, true), /\btoast-notification\b/);
        assert.match(toastClassName(null, false), /\btoast-notification\b/);
    });

    it("shows a visible toast", () => {
        const className = toastClassName(RED_TOAST, true);

        assert.doesNotMatch(className, new RegExp(`\\b${TOAST_HIDDEN}\\b`));
        assert.match(className, /\btoast-red\b/);
    });

    it("hides a toast that has been closed", () => {
        assert.match(toastClassName(RED_TOAST, false), new RegExp(`\\b${TOAST_HIDDEN}\\b`));
    });

    it("hides the element when there is no toast at all", () => {
        assert.match(toastClassName(null, true), new RegExp(`\\b${TOAST_HIDDEN}\\b`));
    });

    it("carries the colour it was given", () => {
        assert.match(toastClassName(GREEN_TOAST, true), /\btoast-green\b/);
    });

    /**
     * The old expression appended `" toast-" + toast?.color` unconditionally,
     * so an empty element carried a `toast-undefined` that matches no rule.
     */
    it("does not invent a colour class for an empty element", () => {
        assert.doesNotMatch(toastClassName(null, false), /toast-undefined/);
    });

    /**
     * Reopening is the case that was broken: the same toast shown again, after
     * a close, has to come back visible.
     */
    it("comes back visible after a close", () => {
        const closed = toastClassName(RED_TOAST, false);
        const reopened = toastClassName(RED_TOAST, true);

        assert.notEqual(closed, reopened, "a reopened toast renders identically to a closed one");
        assert.doesNotMatch(reopened, new RegExp(`\\b${TOAST_HIDDEN}\\b`));
    });
});

describe("the toast provider", () => {
    it("computes its class list rather than reaching into the DOM", () => {
        assert.doesNotMatch(provider, /classList/,
            "the provider still mutates the live node behind React's back");
    });

    it("uses the shared class list", () => {
        assert.match(provider, /toastClassName/);
    });

    /**
     * The pending timer lived in useState, so updateToast closed over whatever
     * value its own render had - two toasts raised in the same tick left the
     * first timer running, and it closed the second one early.
     */
    it("holds its dismissal timer in a ref, not in state", () => {
        assert.doesNotMatch(provider, /useState\(\s*null\s*\)[^\n]*\n?[^\n]*timeOut/i);
        assert.match(provider, /useRef/);
        assert.doesNotMatch(provider, /setTimeOutId/,
            "the timer is still state, so rapid toasts read a stale handle");
    });

    it("clears its timer when it goes away", () => {
        assert.match(provider, /useEffect/,
            "nothing cancels the pending timer on unmount");
    });
});
