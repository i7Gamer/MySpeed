import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import httpsRedirect from "../../server/middlewares/httpsRedirect.js";

const HTTPS_PORT = 5217;

const request = ({secure = false, remote = "203.0.113.5", headers = {}, url = "/api/config", hostname = "myspeed.example"} = {}) =>
    ({secure, headers, hostname, originalUrl: url, socket: {remoteAddress: remote}});

const response = () => {
    const res = {statusCode: null, location: null, headers: {}};
    res.setHeader = (name, value) => { res.headers[name.toLowerCase()] = value; };
    res.redirect = (status, location) => { res.statusCode = status; res.location = location; };
    return res;
};

const run = (middleware, req) => {
    const res = response();
    let passedThrough = false;

    middleware(req, res, () => { passedThrough = true; });
    return {res, passedThrough};
};

const middleware = ({listening = true, port = HTTPS_PORT} = {}) =>
    httpsRedirect({enabled: () => process.env.HTTPS_REDIRECT !== "false" && listening, port: () => port});

afterEach(() => {
    delete process.env.HTTPS_REDIRECT;
    delete process.env.TRUST_PROXY;
});

describe("httpsRedirect", () => {
    it("sends a network caller to the https listener", () => {
        const {res, passedThrough} = run(middleware(), request());

        assert.equal(passedThrough, false);
        assert.equal(res.location, `https://myspeed.example:${HTTPS_PORT}/api/config`);
    });

    it("preserves the path and query", () => {
        const {res} = run(middleware(), request({url: "/api/speedtests?limit=5&from=2026-08-01"}));
        assert.match(res.location, /\/api\/speedtests\?limit=5&from=2026-08-01$/);
    });

    it("leaves an already-secure request alone", () => {
        assert.equal(run(middleware(), request({secure: true})).passedThrough, true);
    });

    // The container healthcheck talks plain HTTP to 127.0.0.1 and would fail
    // chasing a redirect to a self-signed certificate.
    it("leaves a local caller alone", () => {
        assert.equal(run(middleware(), request({remote: "127.0.0.1"})).passedThrough, true);
    });

    it("can be switched off", () => {
        process.env.HTTPS_REDIRECT = "false";
        assert.equal(run(middleware(), request()).passedThrough, true);
    });

    /**
     * Regression: the redirect was gated on the certificate *files* existing,
     * but index.js opens the listener inside a try/catch - a port clash or an
     * unreadable key logs a warning and carries on. Every network caller was
     * then sent to a port with nothing behind it, leaving the instance
     * unreachable over HTTP without serving anything over HTTPS.
     */
    it("does nothing when the https listener is not actually up", () => {
        assert.equal(run(middleware({listening: false}), request()).passedThrough, true);
    });

    /**
     * Regression: this was a 308, which is cacheable indefinitely, aimed at an
     * internal port number. One wrong redirect and every browser that saw it
     * keeps going somewhere unreachable, with no request to the server that
     * could correct it.
     */
    it("redirects temporarily and uncacheably", () => {
        const {res} = run(middleware(), request());

        assert.equal(res.statusCode, 307, "a permanent redirect cannot be taken back");
        assert.match(res.headers["cache-control"] ?? "", /no-store/);
    });

    it("reads the listener state per request, not once at startup", () => {
        let listening = false;
        const redirect = httpsRedirect({enabled: () => listening, port: () => HTTPS_PORT});

        assert.equal(run(redirect, request()).passedThrough, true);

        listening = true;
        assert.equal(run(redirect, request()).passedThrough, false, "the listener coming up was never noticed");
    });

    // A forwarded request is not local, whatever address it arrived on.
    it("still redirects a forwarded request that arrived on loopback", () => {
        const forwarded = request({remote: "127.0.0.1", headers: {"x-forwarded-for": "203.0.113.5"}});
        assert.equal(run(middleware(), forwarded).passedThrough, false);
    });
});
