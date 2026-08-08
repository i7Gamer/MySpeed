import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { isLoopbackRequest } from "../../server/util/clientAddress.js";

/**
 * This is the gate that decides whether a password-less instance answers a
 * stranger unchallenged, so every uncertain case has to resolve to false.
 */
const request = ({remote = "127.0.0.1", headers = {}, ip} = {}) => ({
    headers, ip, socket: {remoteAddress: remote}
});

const withTrustProxy = (value, run) => {
    const previous = process.env.TRUST_PROXY;

    if (value === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = value;

    try {
        return run();
    } finally {
        if (previous === undefined) delete process.env.TRUST_PROXY;
        else process.env.TRUST_PROXY = previous;
    }
};

afterEach(() => {
    delete process.env.TRUST_PROXY;
});

describe("isLoopbackRequest", () => {
    it("accepts a request that arrived on loopback", () => {
        assert.equal(isLoopbackRequest(request({remote: "127.0.0.1"})), true);
        assert.equal(isLoopbackRequest(request({remote: "127.0.0.53"})), true);
        assert.equal(isLoopbackRequest(request({remote: "::1"})), true);
        assert.equal(isLoopbackRequest(request({remote: "::ffff:127.0.0.1"})), true);
    });

    it("refuses a request that arrived from the network", () => {
        for (const remote of ["203.0.113.5", "192.168.1.20", "10.0.0.4", "2001:db8::1"])
            assert.equal(isLoopbackRequest(request({remote})), false, `accepted ${remote}`);
    });

    it("refuses a request with no usable transport address", () => {
        assert.equal(isLoopbackRequest({headers: {}, socket: {}}), false);
        assert.equal(isLoopbackRequest({headers: {}}), false);
    });

    /**
     * Regression: the address checked was req.ip, which Express resolves from
     * X-Forwarded-For as soon as a proxy is trusted - so the caller supplied
     * the very value the gate was testing.
     */
    it("ignores req.ip entirely", () => {
        assert.equal(isLoopbackRequest(request({remote: "203.0.113.5", ip: "127.0.0.1"})), false,
            "a forged req.ip was treated as local");

        assert.equal(isLoopbackRequest(request({remote: "127.0.0.1", ip: "203.0.113.5"})), true,
            "a genuinely local request was refused because req.ip disagreed");
    });

    describe("forwarded requests", () => {
        it("refuses anything carrying a forwarding header", () => {
            for (const header of ["x-forwarded-for", "forwarded", "x-real-ip", "x-client-ip"])
                assert.equal(isLoopbackRequest(request({headers: {[header]: "203.0.113.5"}})), false,
                    `${header} did not disqualify the request`);
        });

        /**
         * Regression: the header check was skipped whenever TRUST_PROXY was
         * merely defined. Both of these values mean "do not resolve through a
         * proxy", so they turned the guard off while turning nothing on.
         */
        it("still refuses a forwarded request when proxy trust is switched off", () => {
            for (const value of ["false", "0", ""])
                withTrustProxy(value, () => {
                    assert.equal(isLoopbackRequest(request({headers: {"x-forwarded-for": "203.0.113.5"}})), false,
                        `TRUST_PROXY=${JSON.stringify(value)} let a forwarded request through`);
                });
        });

        it("refuses a forwarded request when proxy trust is switched on", () => {
            withTrustProxy("1", () => {
                assert.equal(isLoopbackRequest(request({headers: {"x-forwarded-for": "203.0.113.5"}})), false);
            });
        });
    });

    /**
     * Regression: a reverse proxy that forwards without adding a header made
     * every remote caller arrive on loopback looking local. Once the operator
     * has said a proxy is in front, a loopback socket is that proxy.
     */
    it("refuses a bare loopback request once a proxy is declared", () => {
        for (const value of ["1", "true", "loopback", "10.0.0.1"])
            withTrustProxy(value, () => {
                assert.equal(isLoopbackRequest(request({remote: "127.0.0.1"})), false,
                    `TRUST_PROXY=${value} still treated the proxy as a local caller`);
            });
    });

    it("keeps working for a genuinely local caller when no proxy is declared", () => {
        withTrustProxy(undefined, () => {
            assert.equal(isLoopbackRequest(request({remote: "127.0.0.1"})), true);
        });

        // "do not trust a proxy" must not also mean "there is one".
        for (const value of ["false", "0"])
            withTrustProxy(value, () => {
                assert.equal(isLoopbackRequest(request({remote: "127.0.0.1"})), true,
                    `TRUST_PROXY=${value} broke local access`);
            });
    });
});
