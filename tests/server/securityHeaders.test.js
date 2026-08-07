import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import securityHeaders from "../../server/middlewares/securityHeaders.js";

const responseSpy = () => {
    const headers = {};
    return {
        headers,
        setHeader: (name, value) => { headers[name.toLowerCase()] = value; }
    };
};

/** Runs the middleware and hands back the headers it set. */
const headersFor = (req = {}) => {
    const res = responseSpy();
    let passed = false;
    securityHeaders()(req, res, () => { passed = true; });
    assert.equal(passed, true, "the middleware must always continue the chain");
    return res.headers;
};

const originalFrameAncestors = process.env.FRAME_ANCESTORS;

beforeEach(() => { delete process.env.FRAME_ANCESTORS; });

afterEach(() => {
    if (originalFrameAncestors === undefined) delete process.env.FRAME_ANCESTORS;
    else process.env.FRAME_ANCESTORS = originalFrameAncestors;
});

describe("securityHeaders", () => {
    describe("content security policy", () => {
        it("refuses framing by default", () => {
            const headers = headersFor();
            assert.match(headers["content-security-policy"], /frame-ancestors 'none'/);
            assert.equal(headers["x-frame-options"], "DENY");
        });

        it("blocks plugins, base-tag injection and off-site form posts", () => {
            const policy = headersFor()["content-security-policy"];
            assert.match(policy, /object-src 'none'/);
            assert.match(policy, /base-uri 'self'/);
            assert.match(policy, /form-action 'self'/);
        });

        it("keeps network access same-origin", () => {
            assert.match(headersFor()["content-security-policy"], /connect-src 'self'/);
        });

        // The client renders chart canvases and webp assets, and Vite emits the
        // fonts as same-origin files.
        it("still allows the assets the client actually loads", () => {
            const policy = headersFor()["content-security-policy"];
            assert.match(policy, /img-src 'self' data: blob:/);
            assert.match(policy, /font-src 'self' data:/);
        });
    });

    describe("framing opt-out", () => {
        it("honours an explicit ancestor list", () => {
            process.env.FRAME_ANCESTORS = "https://dash.example.com";
            assert.match(headersFor()["content-security-policy"], /frame-ancestors https:\/\/dash\.example\.com/);
        });

        // X-Frame-Options cannot express an origin list, so leaving DENY on
        // would override the CSP the operator just asked for.
        it("drops X-Frame-Options when framing is allowed", () => {
            process.env.FRAME_ANCESTORS = "https://dash.example.com";
            assert.equal(headersFor()["x-frame-options"], undefined);
        });
    });

    describe("transport security", () => {
        it("is absent over plain http, where it would be meaningless", () => {
            assert.equal(headersFor({secure: false})["strict-transport-security"], undefined);
        });

        it("is set over https", () => {
            const value = headersFor({secure: true})["strict-transport-security"];
            assert.match(value, /max-age=\d+/);
            assert.match(value, /includeSubDomains/);
        });

        // Undoing preload takes months, so it must never be a default.
        it("never asks for preload", () => {
            assert.doesNotMatch(headersFor({secure: true})["strict-transport-security"], /preload/);
        });
    });

    describe("always set", () => {
        it("stops content-type sniffing", () => {
            assert.equal(headersFor()["x-content-type-options"], "nosniff");
        });

        it("keeps the referrer off outbound requests", () => {
            assert.equal(headersFor()["referrer-policy"], "no-referrer");
        });
    });
});
