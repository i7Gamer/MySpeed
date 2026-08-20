import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    TOAST_HIDDEN, toastClassName
} from "../../client/src/common/contexts/ToastNotification/toastState.js";
import { withoutJsComments } from "../helpers/source.js";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

// Comments stripped before anything is asserted against the source, for the
// reason the shared helper states: an assertion that the code no longer does X
// otherwise matches the sentence saying it used to.
const provider = withoutJsComments(fs.readFileSync(path.join(CLIENT_SRC,
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
     *
     * Asserted as "the handle the timer is stored in is a ref", by name, rather
     * than by the absence of a particular old identifier: a doesNotMatch
     * against the previous spelling passes the moment anyone renames the
     * variable, whether or not it went back into state.
     */
    it("holds its dismissal timer in a ref, not in state", () => {
        const timerHandle = provider.match(/const\s+(\w+)\s*=\s*useRef\(/g) ?? [];

        assert.ok(timerHandle.length > 0, "no ref is declared at all");
        assert.match(provider, /setTimeout\(/, "nothing schedules a dismissal");

        // Whatever holds the setTimeout handle must be a ref, i.e. assigned
        // through `.current`, not through a setState function.
        assert.match(provider, /\.current\s*=\s*setTimeout\(/,
            "the dismissal handle is not stored in a ref, so rapid toasts read a stale one");
        assert.doesNotMatch(provider, /set\w*\(\s*setTimeout\(/,
            "the dismissal handle is still going into state");
    });

    /**
     * Named for the unmount cleanup, so it has to assert the cleanup - that the
     * effect returns something that clears the timer, not merely that the file
     * mentions useEffect somewhere.
     */
    it("clears its timer when it goes away", () => {
        assert.match(provider, /clearTimeout\(/, "the dismissal timer is never cleared anywhere");

        const effect = provider.match(/useEffect\(([\s\S]*?),\s*\[\s*\]\s*\)/);
        assert.notEqual(effect, null, "there is no mount-scoped effect to clean up from");
        assert.match(effect[1], /clear\w*/i,
            "the effect does not return a cleanup that clears the pending timer");
    });

    /**
     * A second toast must reset the countdown rather than inherit the first
     * one's remaining time, which is what a stale handle caused.
     */
    it("clears the previous timer before scheduling the next", () => {
        // The four spaces are the provider's indentation, counted rather than
        // typed out - which is what tells the closing brace of updateToast from
        // the closing brace of anything nested inside it.
        const update = provider.match(/const updateToast[\s\S]*?\n {4}\};/);

        assert.notEqual(update, null, "updateToast is no longer recognisable");
        const cleared = update[0].search(/clear\w*\(/i);
        const scheduled = update[0].search(/setTimeout\(/);

        assert.ok(cleared !== -1, "a new toast does not cancel the pending dismissal");
        assert.ok(cleared < scheduled, "the pending dismissal is cancelled after the new one is armed");
    });
});
