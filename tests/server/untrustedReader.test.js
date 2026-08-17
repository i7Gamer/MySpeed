import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { isUntrustedReader } from "../../server/util/untrustedReader.js";

/**
 * The one question every redaction on a read route asks.
 *
 * There are two callers an instance does not owe the operator's own details to,
 * and only one of them was ever recognised. `req.viewMode` marks the caller who
 * gave the read-only password. A visitor to a public demo is not marked at all:
 * the password middleware returns early in preview mode without setting the
 * flag, so it stayed undefined - falsy - and `if (req.viewMode)` read that as
 * "this is the operator". Three redactions were skipped in one go, on the one
 * kind of instance whose address is meant to be handed to strangers.
 *
 * Kept apart from `viewMode` rather than folded into it, because that flag is
 * echoed to the client and drives the whole interface; see the route tests.
 */
afterEach(() => {
    delete process.env.PREVIEW_MODE;
});

describe("isUntrustedReader", () => {
    it("recognises the read-only viewer", () => {
        assert.equal(isUntrustedReader({viewMode: true}), true);
    });

    it("lets the operator through", () => {
        assert.equal(isUntrustedReader({viewMode: false}), false);
    });

    /**
     * The case the flag could not express.
     *
     * Undefined is what preview mode leaves behind, and it is indistinguishable
     * from an authenticated operator by truthiness alone - which is the whole
     * of the fault this predicate exists to fix.
     */
    it("treats a demo visitor as untrusted even though no flag was set", () => {
        process.env.PREVIEW_MODE = "true";

        assert.equal(isUntrustedReader({}), true);
        assert.equal(isUntrustedReader({viewMode: undefined}), true);
    });

    // An operator holding the password on a demo is still reading a demo, and
    // the instance has no way to tell them apart from anyone else - preview
    // mode admits every caller without one.
    it("stays untrusted on a demo whatever the flag says", () => {
        process.env.PREVIEW_MODE = "true";

        assert.equal(isUntrustedReader({viewMode: false}), true);
    });

    // The same exact opt-in the rest of preview mode requires. An instance is
    // not a demo by accident.
    it("is not switched on by a stray value", () => {
        for (const value of ["false", "1", "TRUE", ""]) {
            process.env.PREVIEW_MODE = value;

            assert.equal(isUntrustedReader({}), false, `"${value}" made an ordinary instance a demo`);
        }
    });

    // Read per request, not once at import: a container is configured after the
    // module graph is built, and the tests set it.
    it("reads the setting per request", () => {
        assert.equal(isUntrustedReader({}), false);

        process.env.PREVIEW_MODE = "true";
        assert.equal(isUntrustedReader({}), true, "the setting was captured at import");
    });

    // Defensive: the predicate is called from four routes, and one reached for
    // it before the middleware had run at all during development.
    it("survives being asked about nothing", () => {
        assert.equal(isUntrustedReader(undefined), false);
    });
});
