import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * The dev-mode page is served by app.js with the same security headers as the
 * rest of the app, so it has to obey the same policy the middleware sends. It
 * used to carry an inline <script>, an inline onclick and two imgur images -
 * all three silently blocked, which left its only button permanently hidden.
 *
 * Checked as text rather than in a browser: the page has no logic left to
 * exercise, and what broke it was markup the policy forbids.
 */
const template = fs.readFileSync(
    path.join(process.cwd(), "server", "templates", "env.html"), "utf-8");

/** Attributes that load a subresource, as opposed to <a href>, which only
 *  navigates and is not covered by any of the fetch directives. */
const RESOURCE_TAGS = /<(?:link|img|script|iframe|object|embed)\b[^>]*>/gi;

const resourceUrls = () => (template.match(RESOURCE_TAGS) || [])
    .flatMap((tag) => [...tag.matchAll(/\s(?:src|href)\s*=\s*"([^"]*)"/gi)].map((m) => m[1]));

describe("dev mode template", () => {
    // script-src 'self' - see securityHeaders.js.
    it("carries no script the policy would block", () => {
        assert.doesNotMatch(template, /<script\b/i);
    });

    // Inline event handlers are inline script as far as CSP is concerned, and
    // are not covered by the 'self' source list either.
    it("carries no inline event handler", () => {
        assert.doesNotMatch(template, /\son[a-z]+\s*=\s*"/i);
    });

    // img-src 'self' data: blob:, and the page is served from a checkout with
    // no built client, so 'self' cannot serve files either - data: it is.
    it("loads no off-site resource", () => {
        for (const url of resourceUrls())
            assert.ok(/^data:/.test(url) || !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(url),
                `${url} is not same-origin or a data: URI`);
    });

    // The point of the page: it is the only thing telling a developer where the
    // client actually lives.
    it("still points at the development server", () => {
        assert.match(template, /http:\/\/localhost:5173/);
    });

    // The button was revealed by the blocked script, so it never appeared.
    it("hides nothing behind a class the page cannot remove", () => {
        assert.doesNotMatch(template, /class="hidden"/);
    });
});
