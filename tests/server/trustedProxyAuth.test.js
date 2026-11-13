import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
    parseTrustedProxies, isTrustedAddress, trustedProxyUser, resetTrustedProxyAuth
} from "../../server/util/trustedProxyAuth.js";

/**
 * Header authentication for a reverse proxy that has already signed the
 * caller in (upstream #767: Authelia, Authentik, forward-auth generally).
 *
 * Trusting a header is only safe when the request provably came from the
 * proxy that set it - anyone who can reach the port directly can type
 * "Remote-User: admin" - so the feature arms only when BOTH variables are
 * set: the header's name, and the addresses the assertion may come from. The
 * address checked is the socket's, never a forwarded header, because
 * forwarded headers are the caller's to write.
 */

const armed = (header, proxies) => {
    process.env.TRUSTED_AUTH_HEADER = header;
    if (proxies === undefined) delete process.env.TRUSTED_AUTH_PROXIES;
    else process.env.TRUSTED_AUTH_PROXIES = proxies;
};

const request = (remoteAddress, headers = {}) => ({socket: {remoteAddress}, headers});

const saved = {};

beforeEach(() => {
    saved.header = process.env.TRUSTED_AUTH_HEADER;
    saved.proxies = process.env.TRUSTED_AUTH_PROXIES;
    delete process.env.TRUSTED_AUTH_HEADER;
    delete process.env.TRUSTED_AUTH_PROXIES;
    resetTrustedProxyAuth();
});

afterEach(() => {
    if (saved.header === undefined) delete process.env.TRUSTED_AUTH_HEADER;
    else process.env.TRUSTED_AUTH_HEADER = saved.header;
    if (saved.proxies === undefined) delete process.env.TRUSTED_AUTH_PROXIES;
    else process.env.TRUSTED_AUTH_PROXIES = saved.proxies;
    resetTrustedProxyAuth();
    mock.restoreAll();
});

describe("parseTrustedProxies", () => {
    it("reads a single address", () => {
        assert.notEqual(parseTrustedProxies("172.18.0.2"), null);
    });

    it("reads a v4 subnet", () => {
        const proxies = parseTrustedProxies("172.16.0.0/12");

        assert.ok(isTrustedAddress("172.18.0.2", proxies));
        assert.ok(!isTrustedAddress("192.168.1.2", proxies));
    });

    it("reads v6 addresses and subnets", () => {
        const proxies = parseTrustedProxies("fd00::/8, 2001:db8::7");

        assert.ok(isTrustedAddress("fd12::1", proxies));
        assert.ok(isTrustedAddress("2001:db8::7", proxies));
        assert.ok(!isTrustedAddress("2001:db8::8", proxies));
    });

    it("reads a list with whitespace around the commas", () => {
        const proxies = parseTrustedProxies(" 10.0.0.1 , 10.0.0.2 ");

        assert.ok(isTrustedAddress("10.0.0.2", proxies));
    });

    // Fail closed as a whole, not entry by entry: a skipped typo would leave
    // the operator believing the list they wrote is the list in force.
    it("refuses the whole list over one unreadable entry", () => {
        assert.equal(parseTrustedProxies("10.0.0.1, not-an-address"), null);
    });

    it("refuses a prefix that is not a number", () => {
        assert.equal(parseTrustedProxies("10.0.0.0/eight"), null);
    });

    it("refuses a prefix outside the family's range", () => {
        assert.equal(parseTrustedProxies("10.0.0.0/33"), null);
        assert.equal(parseTrustedProxies("fd00::/129"), null);
    });

    it("answers null for nothing configured", () => {
        assert.equal(parseTrustedProxies(undefined), null);
        assert.equal(parseTrustedProxies(""), null);
        assert.equal(parseTrustedProxies(" , "), null);
    });
});

describe("isTrustedAddress", () => {
    const proxies = parseTrustedProxies("172.16.0.0/12");

    it("matches the v4-mapped form a dual-stack socket reports", () => {
        assert.ok(isTrustedAddress("::ffff:172.18.0.2", proxies));
    });

    it("answers false for an address that is not one", () => {
        assert.ok(!isTrustedAddress("bogus", proxies));
        assert.ok(!isTrustedAddress(undefined, proxies));
    });

    it("answers false with no list to trust", () => {
        assert.ok(!isTrustedAddress("172.18.0.2", null));
    });
});

describe("trustedProxyUser", () => {
    it("stays out of the way while nothing is configured", () => {
        assert.equal(trustedProxyUser(request("10.0.0.1", {"remote-user": "timo"})), null);
    });

    it("hands back the asserted user from a trusted socket", () => {
        armed("Remote-User", "10.0.0.1");

        assert.equal(trustedProxyUser(request("10.0.0.1", {"remote-user": "timo"})), "timo");
    });

    // Node lowercases incoming header names; the configured name must reach
    // the lookup the same way whatever case the operator typed.
    it("finds the header whatever case the operator configured", () => {
        armed("REMOTE-USER", "10.0.0.1");

        assert.equal(trustedProxyUser(request("10.0.0.1", {"remote-user": "timo"})), "timo");
    });

    it("refuses the same header from an untrusted socket", () => {
        armed("Remote-User", "10.0.0.1");

        assert.equal(trustedProxyUser(request("203.0.113.9", {"remote-user": "timo"})), null);
    });

    it("refuses a request the proxy sent without the header", () => {
        armed("Remote-User", "10.0.0.1");

        assert.equal(trustedProxyUser(request("10.0.0.1")), null);
    });

    it("refuses an empty assertion", () => {
        armed("Remote-User", "10.0.0.1");

        assert.equal(trustedProxyUser(request("10.0.0.1", {"remote-user": "   "})), null);
    });

    // A duplicated header reaches node as an array or a joined string
    // depending on the header; only the plain single string is an assertion.
    it("refuses a header that is not a single string", () => {
        armed("Remote-User", "10.0.0.1");

        assert.equal(trustedProxyUser(request("10.0.0.1", {"remote-user": ["a", "b"]})), null);
    });

    it("stays off when the header is named but no proxies are", () => {
        armed("Remote-User", undefined);

        assert.equal(trustedProxyUser(request("10.0.0.1", {"remote-user": "timo"})), null);
    });

    it("says so once rather than on every request", () => {
        const warn = mock.method(console, "warn", () => undefined);
        armed("Remote-User", undefined);

        trustedProxyUser(request("10.0.0.1", {"remote-user": "timo"}));
        trustedProxyUser(request("10.0.0.1", {"remote-user": "timo"}));

        assert.equal(warn.mock.callCount(), 1);
    });

    it("follows a proxy list the environment changes underneath it", () => {
        armed("Remote-User", "10.0.0.1");
        assert.equal(trustedProxyUser(request("10.0.0.1", {"remote-user": "timo"})), "timo");

        process.env.TRUSTED_AUTH_PROXIES = "10.0.0.2";
        assert.equal(trustedProxyUser(request("10.0.0.1", {"remote-user": "timo"})), null);
    });
});

/**
 * The proxy vouches for whoever holds its credential, and a browser attaches
 * that credential to requests the page's owner never made: cached Basic auth,
 * or an SSO cookie that is not SameSite. A form on any other site posting to
 * /api/speedtests/run therefore arrived with Remote-User set and was admitted
 * as the operator. The session cookie never had this problem - it is
 * SameSite=Strict - so the header has to be held to the same line by hand.
 */
describe("a write the operator's browser was made to send", () => {
    const PROXY = "172.18.0.2";
    const from = (method, headers = {}) =>
        ({method, socket: {remoteAddress: PROXY}, headers: {"remote-user": "timo", host: "myspeed.example", ...headers}});

    beforeEach(() => armed("Remote-User", PROXY));

    it("is refused when the browser says the request came from another site", () => {
        for (const site of ["cross-site", "same-site"])
            assert.equal(trustedProxyUser(from("POST", {"sec-fetch-site": site})), null, site);
    });

    it("is admitted from the app's own pages and from the address bar", () => {
        for (const site of ["same-origin", "none"])
            assert.equal(trustedProxyUser(from("POST", {"sec-fetch-site": site})), "timo", site);
    });

    it("covers every method that changes something", () => {
        for (const method of ["POST", "PUT", "PATCH", "DELETE"])
            assert.equal(trustedProxyUser(from(method, {"sec-fetch-site": "cross-site"})), null, method);
    });

    // A link followed from another site is how anyone arrives anywhere, and a
    // read changes nothing. Refusing it would break every bookmark and every
    // redirect back from the sign-in page.
    it("leaves a cross-site read alone", () => {
        for (const method of ["GET", "HEAD", "OPTIONS"])
            assert.equal(trustedProxyUser(from(method, {"sec-fetch-site": "cross-site"})), "timo", method);
    });

    describe("from a browser too old to say where it came from", () => {
        it("is refused when the Origin is another site's", () => {
            assert.equal(trustedProxyUser(from("POST", {origin: "https://evil.example"})), null);
        });

        // What a sandboxed frame and a redirected form both send.
        it("is refused when the Origin is opaque", () => {
            assert.equal(trustedProxyUser(from("POST", {origin: "null"})), null);
        });

        it("is refused when the Origin cannot be read at all", () => {
            assert.equal(trustedProxyUser(from("POST", {origin: "not a url"})), null);
        });

        it("is admitted when the Origin is the host that was asked", () => {
            assert.equal(trustedProxyUser(from("POST", {origin: "https://myspeed.example"})), "timo");
            assert.equal(trustedProxyUser(from("POST", {origin: "https://MySpeed.Example"})), "timo");
        });

        // A proxy that rewrites Host to the upstream's says what the browser
        // asked for here instead.
        it("is admitted when the Origin is the host the proxy forwarded for", () => {
            assert.equal(trustedProxyUser(from("POST",
                {host: "myspeed:5216", "x-forwarded-host": "myspeed.example", origin: "https://myspeed.example"})), "timo");
        });

        it("compares the port as well as the name", () => {
            assert.equal(trustedProxyUser(from("POST",
                {host: "myspeed.example:8443", origin: "https://myspeed.example:8443"})), "timo");
            assert.equal(trustedProxyUser(from("POST",
                {host: "myspeed.example:8443", origin: "https://myspeed.example:9000"})), null);
        });
    });

    // curl, a script, a monitoring job behind the same proxy: not a browser,
    // so there is no ambient credential for another site to borrow.
    it("is admitted with neither header, which no browser sends a cross-site write without", () => {
        assert.equal(trustedProxyUser(from("POST")), "timo");
    });

    // The fetch metadata is the browser's own statement and wins over an
    // Origin that happens to match.
    it("believes the fetch metadata over the Origin", () => {
        assert.equal(trustedProxyUser(from("POST",
            {"sec-fetch-site": "cross-site", origin: "https://myspeed.example"})), null);
    });
});
