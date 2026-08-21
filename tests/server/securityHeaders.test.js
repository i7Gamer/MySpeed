import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import securityHeaders from "../../server/middlewares/securityHeaders.js";

/**
 * Node's own bound on what a header value may hold, copied from
 * _http_common.js: res.setHeader throws ERR_INVALID_CHAR for anything outside
 * it. The spy refuses the same characters, so a value that would take the real
 * server down fails here rather than passing as a string nobody looked at.
 */
const HEADER_CHARACTERS = /[^\t\x20-\x7e\x80-\xff]/;

const responseSpy = () => {
    const headers = {};
    return {
        headers,
        setHeader: (name, value) => {
            if (HEADER_CHARACTERS.test(String(value)))
                throw new TypeError(`Invalid character in header content ["${name}"]`);

            headers[name.toLowerCase()] = value;
        }
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

/** The policy split into {directive: [values]}, so a value cannot be matched
 *  against the wrong directive. */
const directives = (req = {}) => Object.fromEntries(
    headersFor(req)["content-security-policy"].split("; ").map((directive) => {
        const [name, ...values] = directive.split(" ");
        return [name, values];
    }));

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

        // The Vite build emits only external modules and vite-plugin-pwa
        // registers the worker from /registerSW.js, so nothing needs inline
        // script execution. Style is a different matter: React writes `style`
        // attributes and FontAwesome injects a <style> element at runtime.
        it("allows no inline script", () => {
            assert.deepEqual(directives()["script-src"], ["'self'"]);
        });

        it("allows inline style, which the app does need", () => {
            assert.deepEqual(directives()["style-src"], ["'self'", "'unsafe-inline'"]);
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

        it("carries a list of several origins through", () => {
            process.env.FRAME_ANCESTORS = "https://dash.example.com https://home.lan:3000";
            assert.deepEqual(directives()["frame-ancestors"],
                ["https://dash.example.com", "https://home.lan:3000"]);
        });
    });

    /**
     * The value is the operator's own, so this is not a way in - it is the way
     * a plausible mistake becomes an outage, or a policy nobody wrote.
     *
     * A semicolon ends the directive: FRAME_ANCESTORS="'self'; sandbox" reads as
     * a complete second directive appended to the policy this module composes,
     * and `sandbox` alone is enough to leave the dashboard unable to run its own
     * scripts. A newline is worse and quieter, because it never reaches a
     * browser at all: res.setHeader refuses the character outright, so the
     * middleware throws on *every* request and the instance answers 500 to
     * everything - including the health endpoint that would say what is wrong.
     *
     * Both come out of ordinary editing. Writing a CSP fragment rather than a
     * bare ancestor list is the first guess at what the variable wants, and a
     * value set from a here-doc or read out of a file keeps its trailing
     * newline.
     */
    describe("an ancestor list that is not one", () => {
        it("does not let a semicolon append a directive", () => {
            process.env.FRAME_ANCESTORS = "'self'; sandbox";

            assert.equal(directives()["sandbox"], undefined,
                "the value ends the directive and writes a policy the operator did not");
        });

        it("keeps the origins either side of one", () => {
            process.env.FRAME_ANCESTORS = "https://dash.example.com; https://home.lan";
            const ancestors = directives()["frame-ancestors"];

            assert.ok(ancestors.includes("https://dash.example.com"), "the first origin was dropped");
            assert.ok(ancestors.includes("https://home.lan"), "the second origin was dropped");
        });

        it("survives a trailing newline", () => {
            process.env.FRAME_ANCESTORS = "https://dash.example.com\n";

            assert.deepEqual(directives()["frame-ancestors"], ["https://dash.example.com"],
                "setHeader refuses the newline, so every request answers 500");
        });

        it("survives a value that is only whitespace", () => {
            process.env.FRAME_ANCESTORS = "   ";

            assert.deepEqual(directives()["frame-ancestors"], ["'none'"],
                "an empty directive is a policy no browser can read");
            assert.equal(headersFor()["x-frame-options"], "DENY",
                "a value that says nothing must leave the default refusal in place");
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
