import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { COARSE_QUERY, hasCoarsePointer } from "@/common/hooks/useCoarsePointer.js";
import { readSource, withoutJsComments } from "../helpers/source.js";

/**
 * Which pointer is on the machine, and therefore which picker the reader gets.
 *
 * Touch keeps the operating system's wheel: it is a better time picker than
 * anything drawn in a page, and replacing it would be a downgrade dressed as
 * consistency. A mouse gets the app's, because the one the browser draws there
 * is a popup in the OS's voice that no stylesheet can reach.
 *
 * `(pointer: coarse)` and not a width breakpoint, which is the tempting wrong
 * answer: a tablet has a coarse pointer at desktop width and wants the wheel,
 * and a narrow desktop window has a fine pointer and wants the drawn one.
 */

describe("the pointer query", () => {
    it("asks about the pointer, not about the window", () => {
        assert.equal(COARSE_QUERY, "(pointer: coarse)");
    });
});

describe("hasCoarsePointer", () => {
    const machine = (matches) => ({matchMedia: (query) => ({matches: query === COARSE_QUERY && matches})});

    it("reads the machine's answer", () => {
        assert.equal(hasCoarsePointer(machine(true)), true);
        assert.equal(hasCoarsePointer(machine(false)), false);
    });

    /**
     * A browser with no matchMedia gets the drawn picker.
     *
     * The same engines ThemeContext already guards for - old webviews, the sort
     * a wall-mounted dashboard runs. Defaulting to the native control there
     * would put an unstyled picker on a desktop; the drawn one is buttons, and
     * works under a finger as well as under a mouse. So the fallback is the one
     * that is merely not ideal rather than the one that is wrong.
     */
    it("falls back to the drawn picker where the machine cannot be asked", () => {
        assert.equal(hasCoarsePointer(undefined), false);
        assert.equal(hasCoarsePointer({}), false);
    });
});

describe("useCoarsePointer", () => {
    const source = withoutJsComments(readSource("client/src/common/hooks/useCoarsePointer.js"));

    it("subscribes through the shim rather than addEventListener directly", () => {
        // Safari before 14 has only addListener, and subscribing directly threw
        // out of the provider's effect and took the tree down. One shim, already
        // written and already pinned by mediaQueryWatch.
        assert.match(source, /watchMediaQuery/);
        assert.doesNotMatch(source, /addEventListener/,
            "the hook subscribes on its own again, on engines that have no such method");
    });

    it("reads the first answer during render, not in an effect", () => {
        // An effect runs after the children have rendered, so the first frame
        // would draw the wrong picker and swap it - which on touch means the
        // OS wheel appearing a frame after a text field the reader already
        // tapped.
        assert.match(source, /useState\(\(\) =>/);
    });

    it("unsubscribes when it goes away", () => {
        assert.match(source, /return watchMediaQuery/,
            "the hook keeps its listener after unmount");
    });
});
