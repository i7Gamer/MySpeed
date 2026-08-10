import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as sass from "sass";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

// Stands in for the "@/" alias vite gives the client, which the stylesheets use
// to reach the shared colour and layout definitions.
const aliasImporter = {
    findFileUrl(url) {
        if (!url.startsWith("@/")) return null;
        return pathToFileURL(path.join(CLIENT_SRC, url.slice(2)));
    }
};

const compile = (stylesheet) =>
    sass.compile(path.join(CLIENT_SRC, stylesheet), {importers: [aliasImporter]}).css;

const toolbar = compile("common/components/PageToolbar/styles.sass");
const startButton = compile("common/components/StartTestButton/styles.sass");
const picker = compile("common/components/DateRangePicker/styles.sass");

const fontSizeOf = (selector, css) => {
    for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!selectors.split(",").some(one => one.trim() === selector)) continue;

        const size = body.match(/(?:^|;)\s*font-size:\s*([^;]+)/);
        if (size) return size[1].trim();
    }
    return null;
};

/**
 * The toolbar's three controls set their text independently and drifted: the
 * date range and the export read at 0.95rem beside a 1.1rem start button, so a
 * row built to look like one set of controls announced itself as three.
 *
 * The start button is the reference - it is the tallest control and the one
 * whose size the row's height already follows - and the size is written down
 * once, in the shared layout constants, so the three cannot drift again.
 */
describe("the page toolbar's controls all speak at one size", () => {
    const reference = fontSizeOf(".start-test", startButton);

    it("has a reference size to follow", () => {
        assert.notEqual(reference, null, "the start button declares no font size");
    });

    for (const selector of [".page-toolbar .date-range-text", ".page-toolbar .export-button"]) {
        it(`sizes ${selector} like the start button`, () => {
            assert.equal(fontSizeOf(selector, toolbar), reference);
        });
    }

    /**
     * The picker used to step its text down twice on narrow viewports while the
     * start button beside it kept its size - so the row was consistent only on
     * a desktop. The toolbar rule outranks those by specificity, which makes
     * them dead weight that reads like live behaviour.
     */
    it("leaves no narrow-viewport override behind to contradict it", () => {
        const narrow = picker.split("@media").slice(1).join("@media");

        assert.doesNotMatch(narrow, /\.date-range-text\s*\{[^}]*font-size/,
            "a media query still resizes the range text");
    });

    it("keeps the size out of the toolbar's own media queries too", () => {
        const narrow = toolbar.split("@media").slice(1).join("@media");

        assert.doesNotMatch(narrow, /font-size/, "the toolbar resizes its controls on a narrow viewport");
    });
});
