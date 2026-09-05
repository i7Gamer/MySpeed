import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { backedBy, readStored, scopedStorageKey, writeStored } from "../../client/src/common/utils/Storage.js";

/**
 * The seventh-pass finding: two MySpeeds behind different BASE_PATH prefixes on
 * one origin shared `currentNode`, the preferences, the theme, the language and
 * `welcomeShown`, because Storage.js read and wrote the same bare key whatever
 * prefix the instance was serving from.
 *
 * Storage.js's own `basePath` is fixed to "" for the life of this process the
 * moment the module is first imported (BasePath.js works it out from its own
 * `import.meta.url`, and nothing under this harness serves the client from a
 * subdirectory), so the bound `readStored` and its siblings can only ever
 * speak for the default prefix. `backedBy` takes the prefix as a parameter for
 * exactly this file: every read, write and remove below is the real one, run
 * over a Map standing in for the one localStorage a browser gives an origin -
 * which is the shape of the bug: one store, many prefixes, sharing whatever
 * they do not each get their own key for.
 */

const realLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
let origin;

// The three methods Storage.js calls, over the Map the assertions read.
const fakeStore = (map) => ({
    getItem: (key) => map.has(key) ? map.get(key) : null,
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key)
});

beforeEach(() => {
    origin = new Map();
    Object.defineProperty(globalThis, "localStorage", {value: fakeStore(origin), configurable: true, writable: true});
});

afterEach(() => {
    if (realLocalStorage) Object.defineProperty(globalThis, "localStorage", realLocalStorage);
    else delete globalThis.localStorage;
});

// A MySpeed served behind `prefix`, as far as its stored choices go.
const instance = (prefix) => backedBy("localStorage", prefix);

describe("scopedStorageKey", () => {
    // The literal names every install has used until now. Pinned so the "" case
    // can never drift onto the composed form by accident - that would reset the
    // node, the theme, the language and the welcome-dialog state of every
    // existing install on its next upgrade.
    const TODAYS_KEYS = [
        "currentNode", "theme", "palette", "language",
        "welcomeShown", "preferences", "password", "setPasswordAfterSetupToken"
    ];

    it("answers the bare key, byte for byte, for the default prefix", () => {
        for (const key of TODAYS_KEYS) assert.equal(scopedStorageKey("", key), key);
    });

    it("composes the prefix and the key for a non-empty prefix", () => {
        assert.equal(scopedStorageKey("/a", "theme"), "/a:theme");
        assert.equal(scopedStorageKey("/internet_speed", "currentNode"), "/internet_speed:currentNode");
    });

    it("gives two different prefixes two different keys for the same logical name", () => {
        assert.notEqual(scopedStorageKey("/a", "currentNode"), scopedStorageKey("/b", "currentNode"));
    });
});

describe("a store shared by two prefixes on one origin", () => {
    it("keeps a value written under one prefix invisible to another", () => {
        instance("/a").write("currentNode", "3");

        assert.equal(instance("/a").read("currentNode"), "3");
        assert.equal(instance("/b").read("currentNode"), null,
            "a node chosen on one instance sent the other to its Nodes page - the finding this fixes");
    });

    it("writes under the scoped name, not the bare one", () => {
        instance("/a").write("theme", "light");

        assert.equal(origin.get("/a:theme"), "light");
        assert.equal(origin.has("theme"), false);
    });

    it("reads the bare key when the scoped one has never been written", () => {
        // What an install already running behind BASE_PATH has: the bare key,
        // written before this scoping existed, and nothing under the scoped
        // name yet.
        origin.set("theme", "dark");

        assert.equal(instance("/a").read("theme"), "dark",
            "an upgrading instance lost the theme it already had, rather than reading it until its next write");
    });

    it("prefers the scoped value once one has been written", () => {
        origin.set("theme", "dark");
        instance("/a").write("theme", "light");

        assert.equal(instance("/a").read("theme"), "light");
    });

    it("clears both the scoped and the bare key on remove", () => {
        origin.set("welcomeShown", "true");
        instance("/a").write("welcomeShown", "true");

        instance("/a").remove("welcomeShown");

        assert.equal(origin.has(scopedStorageKey("/a", "welcomeShown")), false);
        assert.equal(origin.has("welcomeShown"), false,
            "the bare key survived the remove, so the fallback would resurface it on the next read");
    });

    it("does not disturb a different prefix's value when removing this one's", () => {
        instance("/a").write("currentNode", "3");
        instance("/b").write("currentNode", "7");

        instance("/a").remove("currentNode");

        assert.equal(instance("/b").read("currentNode"), "7");
    });
});

describe("the default prefix", () => {
    it("reads and writes the bare key, as every install did before", () => {
        instance("").write("theme", "light");

        assert.equal(origin.get("theme"), "light");
        assert.equal(instance("").read("theme"), "light");
    });

    // The bound exports are what the application calls; under this harness
    // their prefix is "", so they must land on the bare key too.
    it("is what the exported readers and writers are bound to here", () => {
        writeStored("language", "de");

        assert.equal(origin.get("language"), "de");
        assert.equal(readStored("language"), "de");
    });
});
