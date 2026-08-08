import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseTrustProxy, trustsProxy } from "../../server/util/trustProxy.js";

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
        /**
         * "true" is Express's trust-all mode, where req.ip becomes the leftmost
         * X-Forwarded-For entry - a value the caller writes. Every per-IP
         * control here keys on req.ip, so honouring it would hand anyone a way
         * past the throttles. It is read as the intent instead: one proxy.
         */
        it("reads true as a single proxy rather than trust-all", () => {
            assert.equal(parseTrustProxy("true"), 1);
        });

        it("reads false", () => assert.equal(parseTrustProxy("false"), false));

        it("tolerates surrounding whitespace", () => assert.equal(parseTrustProxy("  true  "), 1));

        it("never returns Express's trust-all setting", () => {
            for (const value of ["true", " true ", "1", "3", "loopback", "10.0.0.1"])
                assert.notEqual(parseTrustProxy(value), true, `${value} resolved to trust-all`);
        });
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

describe("trustsProxy", () => {
    /**
     * Regression: the loopback gate tested whether TRUST_PROXY was *defined*,
     * not what it meant. Both of these values say "do not resolve through a
     * proxy", so treating them as "a proxy is present" turned the guard off
     * while turning nothing on.
     */
    it("is false for the values that disable proxy resolution", () => {
        for (const value of [undefined, "", "  ", "false", "0"])
            assert.equal(trustsProxy(value), false, `${JSON.stringify(value)} was read as a declared proxy`);
    });

    it("is true once a proxy is actually declared", () => {
        for (const value of ["true", "1", "3", "loopback", "10.0.0.1", "uniquelocal"])
            assert.equal(trustsProxy(value), true, `${value} was not read as a declared proxy`);
    });
});
