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

const SHEETS = {
    ".date-range-trigger": compile("common/components/DateRangePicker/styles.sass"),
    ".export-button": compile("common/components/ExportButton/styles.sass"),
    ".start-test": compile("common/components/StartTestButton/styles.sass")
};

// Every vertical padding a selector is ever given, base rules and media queries
// alike - the narrow-viewport rules are exactly where these drifted apart.
const verticalPaddingsOf = (selector, css) => {
    const values = new Set();

    for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!selectors.split(",").some(one => one.trim() === selector)) continue;

        const padding = body.match(/(?:^|;)\s*padding:\s*([\d.]+)rem/);
        if (padding) values.add(padding[1]);
    }

    return values;
};

/**
 * The toolbar wraps on a narrow viewport, and a flex line is only as tall as
 * its own tallest item - so once the controls sit on different lines, stretch
 * stops equalising them and each one falls back to its natural height.
 *
 * The picker then rendered 39px against the start button's 45px, because its
 * narrow-viewport rule cut the vertical padding while the button's kept it.
 * With one text size across the row, equal vertical padding is what makes the
 * three measure the same by construction, wrapped or not - rather than a
 * min-height propping up an arithmetic that happens to disagree.
 */
describe("the page toolbar's controls are built to one height", () => {
    const reference = verticalPaddingsOf(".start-test", SHEETS[".start-test"]);

    it("gives the start button one vertical padding at every width", () => {
        assert.equal(reference.size, 1,
            `the start button uses ${reference.size} different vertical paddings: ${[...reference]}`);
    });

    for (const selector of [".date-range-trigger", ".export-button"]) {
        it(`gives ${selector} that same padding at every width`, () => {
            const paddings = verticalPaddingsOf(selector, SHEETS[selector]);

            assert.equal(paddings.size, 1,
                `${selector} uses ${paddings.size} different vertical paddings: ${[...paddings]}`);
            assert.deepEqual([...paddings], [...reference]);
        });
    }

    // Horizontal room is the scarce thing on a phone, and tightening it costs
    // no height - so the narrow-viewport rules must still be doing something.
    it("still lets the controls tighten horizontally on a phone", () => {
        const narrow = SHEETS[".date-range-trigger"].split("@media").slice(1).join("@media");

        assert.match(narrow, /\.date-range-trigger\s*\{[^}]*padding:/,
            "the picker no longer tightens on a narrow viewport at all");
    });
});
