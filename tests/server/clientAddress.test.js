import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { isLoopbackRequest, namesLoopbackHost, namesForeignOrigin } from "../../server/util/clientAddress.js";

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

/**
 * The other half of "local": where the caller thought it was sending the
 * request. A forwarder that terminates on loopback without adding a header -
 * ssh -L, kubectl port-forward, an nginx proxy_pass without proxy_params -
 * hands every remote caller a loopback socket, and isLoopbackRequest cannot
 * tell. Those requests still name the public host.
 */
describe("namesLoopbackHost", () => {
    it("accepts the names the documented local callers use", () => {
        for (const host of ["localhost", "localhost:5216", "127.0.0.1", "127.0.0.1:5216", "127.0.0.53:80",
            "[::1]", "[::1]:5216", "::1", "LOCALHOST", "[::ffff:127.0.0.1]:5216"])
            assert.equal(namesLoopbackHost(request({headers: {host}})), true, `${host} was refused`);
    });

    it("refuses a request addressed to a public name over a loopback socket", () => {
        for (const host of ["myspeed.example.com", "myspeed.example.com:443", "192.168.1.20:5216",
            "[2001:db8::1]:5216", "2001:db8::1", "localhost.example.com", "127.0.0.1.example.com"])
            assert.equal(namesLoopbackHost(request({headers: {host}})), false, `${host} was accepted`);
    });

    // HTTP/1.0 sends none, and so do the requests the tests above build.
    it("allows an absent Host header", () => {
        assert.equal(namesLoopbackHost(request()), true);
    });
});

/**
 * A loopback socket and a loopback Host say where the request arrived, not who
 * made it. Two callers satisfy both without being the operator at the console:
 *
 * A page on any other site, open in the operator's own browser, posting a form
 * at http://127.0.0.1:5216 - the browser is local, the request is not theirs.
 *
 * A remote browser behind a same-host proxy that rewrites Host to the upstream
 * and adds no forwarding header, which is nginx with a bare proxy_pass. The
 * browser still names the public origin in what it sends, and the proxy passes
 * that through untouched.
 *
 * Neither is proof - a caller that is not a browser sends none of these - so
 * this narrows the waiver; it does not make it safe behind such a proxy.
 */
describe("namesForeignOrigin", () => {
    const local = (headers = {}) => request({headers: {host: "127.0.0.1:5216", ...headers}});

    it("is false for a request that names no origin at all", () => {
        assert.equal(namesForeignOrigin(local()), false);
        assert.equal(namesForeignOrigin(request()), false);
    });

    it("is false for the app's own requests and for an address typed or bookmarked", () => {
        for (const site of ["same-origin", "none", "Same-Origin"])
            assert.equal(namesForeignOrigin(local({"sec-fetch-site": site})), false, site);
    });

    // "same-site" is another port on this machine: a different application.
    it("is true when the browser says another site or another port made the request", () => {
        for (const site of ["cross-site", "same-site", "anything-else", ""])
            assert.equal(namesForeignOrigin(local({"sec-fetch-site": site})), true, site);
    });

    it("is false when the Origin is the host that was asked", () => {
        assert.equal(namesForeignOrigin(local({origin: "http://127.0.0.1:5216"})), false);
        assert.equal(namesForeignOrigin(request({headers: {host: "LocalHost:5216", origin: "http://localhost:5216"}})), false);
        assert.equal(namesForeignOrigin(request({headers: {host: "[::1]:5216", origin: "http://[::1]:5216"}})), false);
    });

    it("is true when the Origin is anything else", () => {
        for (const origin of ["https://myspeed.example", "http://127.0.0.1:8080", "http://localhost:5216", "null", "not a url", ""])
            assert.equal(namesForeignOrigin(local({origin})), true, origin);
    });

    // The proxied browser: it believes the request is same-origin, and it is
    // right about the origin it knows - which is not the one that was asked.
    it("believes the Origin over a browser that calls the request same-origin", () => {
        assert.equal(namesForeignOrigin(local({"sec-fetch-site": "same-origin", origin: "https://myspeed.example"})), true);
    });

    // A read carries no Origin; where the page's policy allows a Referer, it
    // says the same thing.
    it("reads a Referer the way it reads an Origin", () => {
        assert.equal(namesForeignOrigin(local({referer: "http://127.0.0.1:5216/statistics"})), false);
        assert.equal(namesForeignOrigin(local({referer: "https://myspeed.example/"})), true);
        assert.equal(namesForeignOrigin(local({referer: "garbage"})), true);
    });

    // No Host is HTTP/1.0, which namesLoopbackHost allows; an origin beside it
    // has nothing to agree with.
    it("is true when an origin is named and no host is", () => {
        assert.equal(namesForeignOrigin(request({headers: {origin: "http://127.0.0.1:5216"}})), true);
    });

    it("ignores a header that is not a single string", () => {
        assert.equal(namesForeignOrigin(local({origin: ["http://127.0.0.1:5216", "https://evil.example"]})), true);
    });
});
