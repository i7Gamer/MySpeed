import { describe, it } from "node:test";
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
