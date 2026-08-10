import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as sass from "sass";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const STYLESHEET = "pages/Statistics/charts/OverviewChart/styles.sass";

// Stands in for the "@/" alias vite gives the client, which the stylesheets use
// to reach the shared colour definitions.
const aliasImporter = {
    findFileUrl(url) {
        if (!url.startsWith("@/")) return null;
        return pathToFileURL(path.join(CLIENT_SRC, url.slice(2)));
    }
};

const compiled = sass.compile(path.join(CLIENT_SRC, STYLESHEET), {importers: [aliasImporter]}).css;

const MODAL_GUARD = ":not(.chart-modal-body *)";

// Every rule block in the compiled sheet, as {selector, body} pairs. Nested
// media queries only wrap blocks, so a flat scan still sees each one.
const blocks = [...compiled.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(([, selector, body]) => ({selector: selector.trim(), body}));

/**
 * The narrow-viewport rules exist because the *card* loses room as the page
 * grid tightens: they drop the icons and descriptions and clamp the label to a
 * fixed ellipsized width. The modal renders the same markup, so on any laptop
 * under 1400px these rules used to strip the enlarged detail view of exactly
 * the detail it exists to show - while the modal stylesheet kept sizing a
 * description that was display: none.
 *
 * The guard cannot be an ancestor class on the card side, because the modal is
 * rendered inside the same .statistic-area as the cards; the modal body is the
 * only discriminating ancestor, so the card rules exclude it.
 */
describe("the overview chart stylesheet", () => {
    it("hides nothing inside the modal", () => {
        const hiders = blocks.filter(({body}) => /display:\s*none/.test(body));

        assert.ok(hiders.length > 0, "expected the card to hide details on narrow viewports");
        for (const {selector} of hiders)
            assert.ok(selector.includes(MODAL_GUARD), `"${selector}" hides content inside the modal too`);
    });

    it("clamps no label inside the modal", () => {
        const clamps = blocks.filter(({body}) => /text-overflow:\s*ellipsis|width:\s*1[05]rem/.test(body));

        assert.ok(clamps.length > 0, "expected the card to clamp its labels on narrow viewports");
        for (const {selector} of clamps)
            assert.ok(selector.includes(MODAL_GUARD), `"${selector}" clamps the label inside the modal too`);
    });

    it("still trims the card itself on narrow viewports", () => {
        assert.match(compiled, /@media[^{]*max-width:\s*1400px/);
        assert.match(compiled, /\.overview-item:not\(\.chart-modal-body \*\) \.info-area svg\s*\{[^}]*display:\s*none/);
        assert.match(compiled, /\.overview-item:not\(\.chart-modal-body \*\) \.info-area \.text-area p\s*\{[^}]*display:\s*none/);
    });
});
