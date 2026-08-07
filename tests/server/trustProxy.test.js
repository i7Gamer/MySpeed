import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseTrustProxy } from "../../server/util/trustProxy.js";

describe("parseTrustProxy", () => {
    // undefined means "do not call app.set at all", which leaves Express on its
    // own default of false. Returning false instead would look identical today
    // but hard-codes a default that is not ours to choose.
    describe("absent", () => {
        for (const [label, value] of [["undefined", undefined], ["null", null], ["empty", ""], ["blank", "   "]])
            it(`leaves the setting alone for ${label}`, () => {
                assert.equal(parseTrustProxy(value), undefined);
            });
    });

    describe("booleans", () => {
        it("reads true", () => assert.equal(parseTrustProxy("true"), true));
        it("reads false", () => assert.equal(parseTrustProxy("false"), false));
        it("tolerates surrounding whitespace", () => assert.equal(parseTrustProxy("  true  "), true));
    });

    describe("hop counts", () => {
        it("reads a single hop", () => assert.equal(parseTrustProxy("1"), 1));
        it("reads several hops", () => assert.equal(parseTrustProxy("3"), 3));

        // Express treats 0 as "trust nothing", which is a legitimate choice and
        // must not be confused with the absent case.
        it("keeps zero as a number rather than dropping it", () => {
            assert.equal(parseTrustProxy("0"), 0);
        });
    });

    describe("everything else is passed through", () => {
        it("keeps a preset", () => assert.equal(parseTrustProxy("loopback"), "loopback"));

        it("keeps an address list", () => {
            assert.equal(parseTrustProxy("127.0.0.1, 10.0.0.0/8"), "127.0.0.1, 10.0.0.0/8");
        });

        // "1.5" is not a hop count; handing it to Express as a string lets it
        // reject the value rather than silently rounding it here.
        it("does not treat a decimal as a hop count", () => {
            assert.equal(parseTrustProxy("1.5"), "1.5");
        });
    });
});
