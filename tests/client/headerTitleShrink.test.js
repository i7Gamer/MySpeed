import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as sass from "sass";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

// Stands in for the "@/" alias vite gives the client, which the stylesheets use
// to reach the shared colour definitions.
const aliasImporter = {
    findFileUrl(url) {
        if (!url.startsWith("@/")) return null;
        return pathToFileURL(path.join(CLIENT_SRC, url.slice(2)));
    }
};

const compiled = sass.compile(
    path.join(CLIENT_SRC, "common/components/Header/styles.sass"),
    {importers: [aliasImporter]}
).css;

const blockOf = (selector) => {
    for (const [, selectors, body] of compiled.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (selectors.trim() === selector) return body;
    }
    return null;
};

/**
 * The header is a 1fr auto 1fr grid: title, pagination, controls. Around
 * 1000px the pagination still carries its labels while the side columns are
 * down to ~185px - and the title h2 could not shrink, because a flex item's
 * automatic minimum is its full text width. It stuck out of .header-left into
 * the pagination's track and was chopped mid-word exactly on its border.
 *
 * Shrinking needs the whole chain: the h2 released from its automatic minimum,
 * and the title text in a box of its own that trades width for an ellipsis -
 * a raw text node in a flex h2 is an anonymous item nothing can style.
 */
describe("the header title gives way to the pagination", () => {
    it("releases the title h2 from its automatic minimum", () => {
        const h2 = blockOf(".header-main h2");
        assert.notEqual(h2, null, "the title h2 has no rule of its own");
        assert.match(h2, /min-width:\s*0/);
    });

    it("trades title width for an ellipsis instead of a mid-word cut", () => {
        const title = blockOf(".header-title");
        assert.notEqual(title, null, "the title text has no rule of its own");
        assert.match(title, /white-space:\s*nowrap/);
        assert.match(title, /overflow:\s*hidden/);
        assert.match(title, /text-overflow:\s*ellipsis/);
    });

    it("keeps the left column clipping as the last line of defence", () => {
        assert.match(blockOf(".header-left"), /overflow:\s*hidden/);
    });

    // The styled box only exists if the markup actually wraps the title text.
    it("wraps the title text in the styled box", () => {
        const source = fs.readFileSync(
            path.join(CLIENT_SRC, "common/components/Header/HeaderComponent.jsx"), "utf8");
        assert.match(source, /className="header-title"/);
    });

    // Nothing in the header may pay for the squeeze with its size - not the
    // text, not the logo. The inset is the one thing with no size of its own,
    // so the squeeze zone relaxes it and only it; the ellipsis above stays
    // reserved for names too long for any inset to save.
    it("spends the inset on the squeeze, never the title's size", () => {
        assert.match(compiled,
            /@media[^{]*min-width:\s*969px[^{]*max-width:\s*1250px[^{]*\{\s*\.header-main\s*\{[^}]*padding:\s*0\s+3%/);
        assert.doesNotMatch(compiled, /@media[^{]*\{[^@]*\.header-main h2\s*\{[^}]*font-size/,
            "a media query resizes the title text");
        assert.doesNotMatch(compiled, /@media[^{]*\{[^@]*\.header-logo\s*\{[^}]*(width|height)/,
            "a media query resizes the logo");
    });
});
