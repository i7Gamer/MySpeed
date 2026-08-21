import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { markPasswordUnset, takePasswordUnsetMark } from "../../client/src/common/utils/PasswordSetup.js";

/**
 * Signing in with the setup token gets the operator in without giving the
 * instance a password, and the next restart issues a different token - so
 * stopping at "you are in" hands back the same lockout with a new credential
 * to hunt for. The note survives the reload that follows and asks the settings
 * dialog to open itself.
 */
describe("the note that outlives a setup-token sign-in", () => {
    const storage = () => {
        const entries = new Map();

        return {
            setItem: (key, value) => entries.set(key, value),
            getItem: (key) => entries.has(key) ? entries.get(key) : null,
            removeItem: (key) => entries.delete(key),
            size: () => entries.size
        };
    };

    it("is not there when nothing left one", () => {
        assert.equal(takePasswordUnsetMark(storage()), false);
    });

    it("is there once it has been left", () => {
        const store = storage();
        markPasswordUnset(store);

        assert.equal(takePasswordUnsetMark(store), true);
    });

    // Left in place it would reopen the dialog on every reload, including the
    // one right after the password was set.
    it("is gone once it has been acted on", () => {
        const store = storage();
        markPasswordUnset(store);
        takePasswordUnsetMark(store);

        assert.equal(takePasswordUnsetMark(store), false);
        assert.equal(store.size(), 0, "nothing of it should be left behind");
    });

    it("survives being read by way of a fresh reader", () => {
        const store = storage();
        markPasswordUnset(store);

        // The page reloads between these two: different execution, same storage.
        assert.equal(takePasswordUnsetMark(store), true);
    });

    it("ignores a value that is not the one it writes", () => {
        const store = storage();
        store.setItem("setPasswordAfterSetupToken", "false");

        assert.equal(takePasswordUnsetMark(store), false);
    });
});

/**
 * And the browser is allowed to refuse the store.
 *
 * Reading `window.sessionStorage` throws a SecurityError rather than answering
 * null when site data is blocked - Chrome and Edge with third-party cookies off,
 * which is Incognito by default, and any browser set to block all site data. The
 * dashboard is embedded in cross-origin iframes on purpose; FRAME_ANCESTORS
 * exists so it can sit in Homepage or Heimdall, and that is exactly where a
 * partitioned or blocked store turns up.
 *
 * These two are read with no argument from a mount effect in
 * DropdownComponent - `if (config.passwordSet === false && takePasswordUnsetMark())`
 * - so the throw came out of a React effect on the dashboard's own header, with
 * only the error boundary beneath it. Not a degraded page: the whole app,
 * replaced by an error screen, on an instance that works perfectly well.
 *
 * Storage.js already carries this for localStorage and says all of it in its own
 * comment. The note is on the same footing as a preference: a blocked store
 * costs it surviving the reload, and nothing else.
 */
const realSessionStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");

const blockSessionStorage = () =>
    Object.defineProperty(globalThis, "sessionStorage", {
        configurable: true,
        get() { throw new DOMException("Access is denied for this document.", "SecurityError"); }
    });

const workingSessionStorage = () => {
    const values = new Map();

    Object.defineProperty(globalThis, "sessionStorage", {
        configurable: true,
        writable: true,
        value: {
            getItem: (key) => values.has(key) ? values.get(key) : null,
            setItem: (key, value) => values.set(key, String(value)),
            removeItem: (key) => values.delete(key)
        }
    });

    return values;
};

afterEach(() => {
    if (realSessionStorage) Object.defineProperty(globalThis, "sessionStorage", realSessionStorage);
    else delete globalThis.sessionStorage;
});

describe("a browser that will not hand over session storage", () => {
    it("does not throw when the mark is read", () => {
        blockSessionStorage();

        assert.equal(takePasswordUnsetMark(), false,
            "the read throws out of a mount effect and takes the dashboard to the error boundary");
    });

    it("does not throw when the mark is left", () => {
        blockSessionStorage();

        markPasswordUnset();
    });

    // Within the page it still works; only surviving the reload is lost, which
    // is the same trade Storage.js makes for a preference.
    it("still carries the mark across the sign-in", () => {
        blockSessionStorage();

        markPasswordUnset();

        assert.equal(takePasswordUnsetMark(), true, "the note is lost even inside the one page");
        assert.equal(takePasswordUnsetMark(), false, "and it still acts only once");
    });

    it("uses the real store when there is one", () => {
        const values = workingSessionStorage();

        markPasswordUnset();

        assert.equal(values.get("setPasswordAfterSetupToken"), "true",
            "the note is kept somewhere the reload cannot read it back");
    });

    it("reads a mark the store already held", () => {
        const values = workingSessionStorage();
        values.set("setPasswordAfterSetupToken", "true");

        assert.equal(takePasswordUnsetMark(), true, "a note left before the reload is not seen after it");
        assert.equal(values.has("setPasswordAfterSetupToken"), false, "the note is left in place to fire again");
    });
});
