import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decodeEmbedPath } from "../../server/util/embedPath.js";

/**
 * The lookup key for an asset baked into the compiled binary.
 *
 * The generated cache is keyed by the filename as it sits on disk, decoded -
 * `/assets/my icon.png`. `req.path` keeps whatever percent-encoding the browser
 * sent, and a browser encodes a space, so the request arrives as
 * `/assets/my%20icon.png` and the lookup misses. In binary mode that miss falls
 * through to the SPA fallback, so the image request is answered with index.html
 * under a text/html content type rather than a 404 - a broken asset that looks
 * like a routing bug.
 *
 * Only anything not ASCII gets encoded, so this reaches every non-English
 * filename in client/public as well as the ones with spaces.
 */
describe("decodeEmbedPath", () => {
    it("leaves a plain path alone", () => {
        assert.equal(decodeEmbedPath("/assets/index-abc123.js"), "/assets/index-abc123.js");
    });

    it("decodes an encoded space", () => {
        assert.equal(decodeEmbedPath("/assets/my%20icon.png"), "/assets/my icon.png");
    });

    it("decodes a non-ascii filename", () => {
        assert.equal(decodeEmbedPath("/assets/logo-caf%C3%A9.png"), "/assets/logo-café.png");
    });

    it("decodes an encoded bracket", () => {
        assert.equal(decodeEmbedPath("/assets/chart%5B1%5D.svg"), "/assets/chart[1].svg");
    });

    /**
     * decodeURIComponent throws URIError on a malformed sequence, and this runs
     * inside the request path - so a crafted url would answer 500 rather than
     * miss the cache and fall through like any other unknown path.
     */
    it("falls back to the raw path rather than throwing on a malformed escape", () => {
        assert.equal(decodeEmbedPath("/assets/%E0%A4%A.png"), "/assets/%E0%A4%A.png");
        assert.equal(decodeEmbedPath("/%"), "/%");
        assert.equal(decodeEmbedPath("/%zz"), "/%zz");
    });

    it("survives a path that is not a string", () => {
        assert.equal(decodeEmbedPath(undefined), undefined);
        assert.equal(decodeEmbedPath(null), null);
    });
});
