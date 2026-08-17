import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../helpers/source.js";

const realLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

const setStorage = (value) =>
    Object.defineProperty(globalThis, "localStorage", {value, configurable: true, writable: true});

/** A store that throws on the property access itself, as a blocked one does. */
const blockedStorage = () =>
    Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        get() { throw new DOMException("Access is denied for this document.", "SecurityError"); }
    });

const workingStorage = () => {
    const values = new Map();

    setStorage({
        getItem: (key) => values.has(key) ? values.get(key) : null,
        setItem: (key, value) => values.set(key, String(value)),
        removeItem: (key) => values.delete(key)
    });

    return values;
};

const { readStored, writeStored, removeStored } =
    await import("../../client/src/common/utils/Storage.js");

afterEach(() => {
    if (realLocalStorage) Object.defineProperty(globalThis, "localStorage", realLocalStorage);
    else delete globalThis.localStorage;
});

describe("stored preferences when the store works", () => {
    let values;

    beforeEach(() => { values = workingStorage(); });

    it("reads and writes through to it", () => {
        writeStored("theme", "dark");

        assert.equal(values.get("theme"), "dark");
        assert.equal(readStored("theme"), "dark");
    });

    it("answers null for a key that was never set", () => {
        assert.equal(readStored("language"), null);
    });

    it("removes a key from it", () => {
        writeStored("currentNode", "3");
        removeStored("currentNode");

        assert.equal(values.has("currentNode"), false);
        assert.equal(readStored("currentNode"), null);
    });
});

/**
 * Reading `window.localStorage` throws rather than answering null when the store
 * is blocked - Chrome and Edge with third-party cookies off, which Incognito is
 * by default, and any browser set to block all site data. The dashboard is put
 * in cross-origin iframes on purpose (FRAME_ANCESTORS exists for Homepage and
 * Heimdall), which is exactly where that turns up.
 *
 * The throw used to land during module evaluation - i18n.js seeded the language
 * at the top level, ThemeContext read the theme in a useState initialiser - so
 * nothing rendered at all. A blank page, with no error boundary above it to say
 * why, because the router carrying the error element had not been built yet.
 */
describe("stored preferences when the store is blocked", () => {
    beforeEach(() => { blockedStorage(); });

    it("reads without throwing", () => {
        assert.doesNotThrow(() => readStored("language"));
    });

    it("writes without throwing", () => {
        assert.doesNotThrow(() => writeStored("language", "de"));
    });

    it("removes without throwing", () => {
        assert.doesNotThrow(() => removeStored("language"));
    });

    // Degraded to the life of the page rather than lost: choosing a language, a
    // theme or a node all still work, they just do not survive a reload.
    it("still remembers a choice for the rest of the session", () => {
        writeStored("theme", "dark");

        assert.equal(readStored("theme"), "dark");
    });

    it("forgets one that was removed", () => {
        writeStored("theme", "dark");
        removeStored("theme");

        assert.equal(readStored("theme"), null);
    });
});

// A store that exists but refuses each call, which is what a quota-exhausted or
// partially-permitted one looks like.
describe("stored preferences when the store refuses each call", () => {
    beforeEach(() => setStorage({
        getItem() { throw new Error("denied"); },
        setItem() { throw new Error("QuotaExceededError"); },
        removeItem() { throw new Error("denied"); }
    }));

    it("falls back rather than throwing", () => {
        assert.doesNotThrow(() => writeStored("theme", "light"));
        assert.equal(readStored("theme"), "light");
    });
});

/**
 * The wrapper only helps where it is used, and the two sites that took the whole
 * app down are the ones that run before React can catch anything.
 */
describe("nothing reaches localStorage directly any more", () => {
    const FILES = [
        "client/src/i18n.js",
        "client/src/common/contexts/Theme/ThemeContext.jsx",
        "client/src/common/contexts/Node/NodeContext.jsx",
        "client/src/common/contexts/Preferences/PreferencesContext.jsx",
        "client/src/common/contexts/Config/ConfigContext.jsx",
        "client/src/common/components/LanguageDialog/LanguageDialog.jsx",
        "client/src/common/components/WelcomeDialog/WelcomeDialog.jsx",
        "client/src/common/utils/RequestUtil.js"
    ];

    for (const file of FILES) {
        it(`${file.split("/").pop()} goes through the guarded wrapper`, () => {
            const source = readSource(file)
                .split("\n")
                .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
                .join("\n");

            assert.doesNotMatch(source, /\blocalStorage\s*\.\s*(getItem|setItem|removeItem)\b/,
                "a blocked or partitioned store throws here rather than answering null");
        });
    }
});
