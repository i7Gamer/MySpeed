import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { withBasePathMeta } from "../../server/util/indexMeta.js";

const HTML = [
    '<meta property="og:image" content="/api/opengraph/image" />',
    '<meta name="twitter:image:src" content="/api/opengraph/image" />',
    '<meta name="twitter:card" content="summary_large_image" />',
    '<link rel="manifest" href="./manifest.json" />'
].join("\n");

describe("withBasePathMeta", () => {
    it("carries the prefix into a rooted meta reference", () => {
        const html = withBasePathMeta(HTML, "/internet_speed");

        assert.match(html, /og:image" content="\/internet_speed\/api\/opengraph\/image"/);
        assert.match(html, /twitter:image:src" content="\/internet_speed\/api\/opengraph\/image"/);
    });

    it("leaves a meta value that is not a path alone", () => {
        assert.match(withBasePathMeta(HTML, "/internet_speed"), /content="summary_large_image"/);
    });

    it("leaves the relative references the bundler already fixed", () => {
        assert.match(withBasePathMeta(HTML, "/internet_speed"), /href="\.\/manifest\.json"/);
    });

    // An instance already names a host there, so there is no prefix to add.
    it("leaves a protocol-relative value alone", () => {
        const html = '<meta property="og:image" content="//cdn.example/x.png" />';
        assert.equal(withBasePathMeta(html, "/internet_speed"), html);
    });

    // The ordinary install, and the one that must stay exactly what vite built.
    it("hands back the same html when no prefix is configured", () => {
        assert.equal(withBasePathMeta(HTML, ""), HTML);
    });
});

/**
 * The reason this exists at all: what the build actually emits. A vite version
 * that starts rewriting meta content, or a template that stops using a rooted
 * path, should retire this file rather than leave it running over nothing.
 */
describe("the built index.html", () => {
    const built = path.join(process.cwd(), "client", "build", "index.html");

    it("still carries a rooted OpenGraph reference the bundler did not rewrite",
        {skip: fs.existsSync(built) ? false : "the client has not been built here"}, () => {
        assert.match(fs.readFileSync(built, "utf-8"), /<meta[^>]*content="\/api\/opengraph\/image"/);
    });
});
