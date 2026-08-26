import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isAssetPath } from "../../server/util/staticAssets.js";

/**
 * What the SPA fallback refuses to answer for.
 *
 * express.static only answers 404 when something behind it does, and behind it
 * sits the catchall - so /assets/missing.js came back as 200 text/html: the
 * index page wearing a script's name. The browser reports that as a MIME
 * refusal three steps removed from the real problem, and a cache in front is
 * invited to remember the wrong answer.
 */
describe("isAssetPath", () => {
    it("recognises the shapes the build actually emits", () => {
        for (const assetPath of [
            "/assets/index-B3protq2.js",
            "/assets/index-C9hRlUKf.css",
            "/assets/fonts/inter-latin-400.woff2",
            "/assets/logo.png",
            "/favicon.ico",
            "/manifest.webmanifest",
            "/sw.js",
            "/assets/app.v1.2.js",
            "/ASSETS/APP.JS"
        ]) assert.equal(isAssetPath(assetPath), true, `${assetPath} was not treated as an asset`);
    });

    it("leaves every client route to the index page", () => {
        for (const route of [
            "/",
            "/nodes",
            "/statistics",
            // Express matches an optional trailing slash onto the same routes.
            "/statistics/",
            // A dot in a middle segment is not a file extension.
            "/name.with.dots/page"
        ]) assert.equal(isAssetPath(route), false, `${route} would be refused instead of served`);
    });
});

/**
 * And the app actually asks. Read rather than run, because the branch taken at
 * import depends on which client delivery exists in the checkout - a build
 * directory, the embedded bundle, or neither - and only one of them can be
 * exercised per process.
 */
describe("the SPA fallback wiring", () => {
    const root = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
    const source = fs.readFileSync(path.join(root, "server", "app.js"), "utf8");

    // One pin per delivery branch - the built client and the embedded one.
    // The dev-mode branch stays unguarded on purpose: it serves an instruction
    // page, and there is no build whose assets could go missing.
    it("guards both client delivery branches", () => {
        assert.match(source, /isAssetPath/, "app.js no longer consults the asset guard");

        assert.match(source, /app\.get\('\*all', spaFallback\(\(req, res\) => res\.sendFile/,
            "the built client hands index.html to missing assets again");
        assert.match(source, /app\.get\('\*all', spaFallback\(embeddedClient\.createEmbeddedFallback\(\)\)/,
            "the embedded client hands index.html to missing assets again");
    });
});
