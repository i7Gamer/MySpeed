import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../helpers/source.js";

/**
 * The picker's Escape follows the protocol every other overlay speaks.
 *
 * Its handler sat on the document for as long as the toolbar was mounted -
 * which on the pages that draw one is always - answering every Escape in the
 * app with a state reset for a popover that was not open. And when the popover
 * was open it claimed the key silently: no preventDefault, so nothing else
 * listening on the document could tell the key had been answered. The app's
 * overlays settle exactly this with defaultPrevented - Dialog declines a key
 * whose default is prevented, DropdownSelect prevents when it claims - and the
 * picker was the one control outside the treaty. Not a visible bug today,
 * because the picker never sits inside a modal; the treaty exists so that the
 * day it does is not the day this is discovered.
 *
 * Read as source, the way the picker's sibling components are.
 */
const source = readSource("client/src/common/components/DateRangePicker/DateRangePicker.jsx");

const at = source.indexOf("handleEscape");
const effect = source.slice(source.lastIndexOf("useEffect(", at), source.indexOf("]);", at) + 3);

describe("the picker's Escape handler", () => {
    it("is found where it always was", () => {
        assert.ok(at !== -1, "the picker no longer answers Escape at all");
        assert.match(effect, /addEventListener\("keydown", handleEscape\)/);
    });

    it("listens only while the popover is open", () => {
        assert.match(effect, /if \(!isOpen\) return;/,
            "every Escape in the app resets a picker that is not even open");
        assert.match(effect, /\[isOpen, closePicker\]/,
            "the effect does not re-run when the popover opens, so the guard reads a stale value");
    });

    it("claims the key the way the overlays' treaty says", () => {
        assert.match(effect, /event\.preventDefault\(\)/,
            "the picker closes silently, and a dialog above it would close on the same press");
    });

    it("declines a key something else has already answered", () => {
        assert.match(effect, /event\.defaultPrevented/,
            "a key claimed above the picker still resets it");
    });

    it("still cleans up after itself", () => {
        assert.match(effect, /removeEventListener\("keydown", handleEscape\)/);
    });
});
