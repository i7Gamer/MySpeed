import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scopedStorageKey } from "../../client/src/common/utils/Storage.js";

/**
 * The seventh-pass finding: two MySpeeds behind different BASE_PATH prefixes on
 * one origin shared `currentNode`, the preferences, the theme, the language and
 * `welcomeShown`, because Storage.js read and wrote the same bare key whatever
 * prefix the instance was serving from.
 *
 * `scopedStorageKey` is exported as a pure function of the prefix - not read
 * off Storage.js's own `basePath` constant, which is fixed to "" for the life
 * of this process the moment the module is first imported (BasePath.js works
 * it out from its own `import.meta.url`, and nothing under this harness ever
 * serves the client from a subdirectory). Driving the derivation directly is
 * what lets this file exercise a second and third prefix without reloading the
 * module - reloading would not even help, since the module being reloaded is
 * not the one whose URL decides the prefix.
 *
 * The isolation, fallback and dual-clear checks below build a tiny read/write/
 * remove wrapper out of nothing but that one exported function and a plain Map
 * standing in for the one real localStorage a browser gives every origin -
 * which is exactly the shape of the bug: one store, many prefixes, sharing
 * whatever they do not each get their own key for.
 */

const read = (map, prefix, key) => {
    const scoped = scopedStorageKey(prefix, key);
    if (map.has(scoped)) return map.get(scoped);
    // The bare-key fallback: an instance already running behind BASE_PATH kept
    // its choices under the bare key before this existed, and has to go on
    // reading them until it next writes.
    return scoped === key ? null : (map.has(key) ? map.get(key) : null);
};

const write = (map, prefix, key, value) => map.set(scopedStorageKey(prefix, key), value);

const remove = (map, prefix, key) => {
    map.delete(scopedStorageKey(prefix, key));
    map.delete(key);
};

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
        const origin = new Map();

        write(origin, "/a", "currentNode", "3");

        assert.equal(read(origin, "/a", "currentNode"), "3");
        assert.equal(read(origin, "/b", "currentNode"), null,
            "a node chosen on one instance sent the other to its Nodes page - the finding this fixes");
    });

    it("reads the bare key when the scoped one has never been written", () => {
        const origin = new Map();

        // What an install already running behind BASE_PATH has: the bare key,
        // written before this scoping existed, and nothing under the scoped
        // name yet.
        origin.set("theme", "dark");

        assert.equal(read(origin, "/a", "theme"), "dark",
            "an upgrading instance lost the theme it already had, rather than reading it until its next write");
    });

    it("prefers the scoped value once one has been written", () => {
        const origin = new Map();

        origin.set("theme", "dark");
        write(origin, "/a", "theme", "light");

        assert.equal(read(origin, "/a", "theme"), "light");
    });

    it("clears both the scoped and the bare key on remove", () => {
        const origin = new Map();

        origin.set("welcomeShown", "true");
        write(origin, "/a", "welcomeShown", "true");

        remove(origin, "/a", "welcomeShown");

        assert.equal(origin.has(scopedStorageKey("/a", "welcomeShown")), false);
        assert.equal(origin.has("welcomeShown"), false,
            "the bare key survived the remove, so the fallback would resurface it on the next read");
    });

    it("does not disturb a different prefix's value when removing this one's", () => {
        const origin = new Map();

        write(origin, "/a", "currentNode", "3");
        write(origin, "/b", "currentNode", "7");

        remove(origin, "/a", "currentNode");

        assert.equal(read(origin, "/b", "currentNode"), "7");
    });
});
