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

    /**
     * While the header is three columns, nothing in it pays for the squeeze
     * with its size - not the text, not the logo. The inset is the one thing
     * with no size of its own, so the squeeze zone relaxes it and only it.
     *
     * The zone used to stop at 969px because the pagination drops its labels
     * below 968 and the inset was thought to fit again from there. Measured, it
     * does not: at 800px the title box wants 227px and the 10% inset left the
     * column 215, so the name was ellipsed some 45px before the pagination
     * moved down at 768 and handed the room back. It now runs to the reflow.
     */
    it("spends the inset on the squeeze, never the title's size", () => {
        assert.match(compiled,
            /@media[^{]*min-width:\s*769px[^{]*max-width:\s*1250px[^{]*\{\s*\.header-main\s*\{[^}]*padding:\s*0\s+3%/);
    });

    /**
     * Below the reflow the invariant above cannot hold, and holding it was
     * costing the thing it was written to protect.
     *
     * The header is two columns there, so the title box gets half the width:
     * 135px of a 338px screen against the 227px it wants at 24pt. No inset can
     * pay that - at a 0% inset the column is still only 169px - so the choice
     * is not "shrink the text or keep it", it is "shrink the text or show
     * `MyS…`". The box gives up its own size instead, and the whole name and
     * the logo both fit.
     */
    it("lets the box give up its size below the reflow, where no inset can pay", () => {
        const narrow = [...compiled.matchAll(/@media([^{]*)\{([\s\S]*?)\n}/g)]
            .filter(([, condition]) => condition.includes("570px"))
            .map(([, , body]) => body);

        assert.ok(narrow.some((body) => /\.header-main h2\s*\{[^}]*font-size/.test(body)),
            "the title still holds 24pt on a phone, where it cannot fit");
    });

    // Above the reflow the rule still stands, and that is where it was written
    // for: a title chopped on the pagination's border is what it prevents.
    it("still resizes nothing while the header is three columns", () => {
        const wide = [...compiled.matchAll(/@media([^{]*)\{([\s\S]*?)\n}/g)]
            .filter(([, condition]) => /1250px|969px|900px/.test(condition))
            .map(([, , body]) => body);

        for (const body of wide) {
            assert.doesNotMatch(body, /\.header-main h2\s*\{[^}]*font-size/,
                "a wide media query resizes the title text");
            assert.doesNotMatch(body, /\.header-logo\s*\{[^}]*(width|height)/,
                "a wide media query resizes the logo");
        }
    });

    // The logo never shrinks at any width. A name can lose a character and
    // still be read; a 30px mark cannot lose 10px and still be itself.
    it("never resizes the logo at any width", () => {
        assert.doesNotMatch(compiled, /@media[^{]*\{[^@]*\.header-logo\s*\{[^}]*(width|height)/,
            "a media query resizes the logo");
    });
});
