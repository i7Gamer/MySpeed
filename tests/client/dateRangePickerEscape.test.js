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

const bodyOfArrowAt = (src, start) =>
    src.slice(src.indexOf("{", src.indexOf("=>", start)));

const blockEnd = (src, from) => {
    let depth = 0;
    for (let index = from; index < src.length; index++) {
        if (src[index] === "{") depth++;
        else if (src[index] === "}" && --depth === 0) return index;
    }
    assert.fail("a block is never closed");
};

const pickerHandler = (closure) => {
    const start = source.indexOf("const handleEscape");
    assert.notEqual(start, -1, "the picker no longer defines handleEscape");

    const body = bodyOfArrowAt(source, start);
    const names = Object.keys(closure);

    return new Function(...names, `return (event) => ${body.slice(0, blockEnd(body, 0) + 1)};`)(
        ...names.map((name) => closure[name]));
};

describe("behavioral execution of the picker's handleEscape", () => {
    const createHandler = () => {
        let closed = false;
        const closePicker = () => {
            closed = true;
        };
        const handler = pickerHandler({ closePicker });
        return {
            handler,
            isClosed: () => closed
        };
    };

    const keyEvent = (key, defaultPrevented = false) => {
        let prevented = defaultPrevented;
        let preventDefaultCalled = false;
        return {
            key,
            get defaultPrevented() {
                return prevented;
            },
            preventDefault() {
                prevented = true;
                preventDefaultCalled = true;
            },
            get preventDefaultCalled() {
                return preventDefaultCalled;
            }
        };
    };

    it("closes the picker and calls preventDefault on Escape when not prevented", () => {
        const { handler, isClosed } = createHandler();
        const event = keyEvent("Escape", false);

        handler(event);

        assert.equal(isClosed(), true, "Escape should close the picker");
        assert.equal(event.defaultPrevented, true, "Escape should prevent default");
        assert.equal(event.preventDefaultCalled, true, "preventDefault should have been called");
    });

    it("must NOT close picker and must NOT call preventDefault when defaultPrevented is true", () => {
        const { handler, isClosed } = createHandler();
        const event = keyEvent("Escape", true);

        handler(event);

        assert.equal(isClosed(), false, "claimed Escape must not close the picker");
        assert.equal(event.preventDefaultCalled, false, "preventDefault must not be called when already prevented");
    });

    it("must NOT close picker and must NOT call preventDefault on non-Escape keys", () => {
        for (const key of ["Enter", "Tab", "ArrowDown", " ", "a", "EscapeKey"]) {
            const { handler, isClosed } = createHandler();
            const event = keyEvent(key, false);

            handler(event);

            assert.equal(isClosed(), false, `Key "${key}" must not close the picker`);
            assert.equal(event.defaultPrevented, false, `Key "${key}" must not set defaultPrevented`);
            assert.equal(event.preventDefaultCalled, false, `Key "${key}" must not call preventDefault`);
        }
    });
});

