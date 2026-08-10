import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as sass from "sass";
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

const compile = (stylesheet) =>
    sass.compile(path.join(CLIENT_SRC, stylesheet), {importers: [aliasImporter]}).css;

const picker = compile("common/components/DateRangePicker/styles.sass");
const settingsOptions = compile("common/components/SelectableOption/styles.sass");

const fontSizeOf = (css, selector) => {
    for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (selectors.trim() !== selector) continue;
        const size = body.match(/font-size:\s*([^;]+);/);
        if (size) return size[1].trim();
    }
    return null;
};

// The settings dialog's rows set the scale: SelectableOption is what its whole
// body is built from.
const primary = fontSizeOf(settingsOptions, ".selectable-option-text h3");
const secondary = fontSizeOf(settingsOptions, ".selectable-option-text p");

/**
 * The date range popover set every piece of its text a notch smaller than the
 * settings dialog (0.75-0.95rem against 1rem/0.85rem), so the two read as
 * different applications side by side. The popover follows the settings scale
 * now: option-like and heading text at the settings title size, captions at
 * the settings description size. Asserting against the compiled SelectableOption
 * sheet rather than a literal keeps the two from drifting apart again.
 */
describe("the date range popover follows the settings dialog text scale", () => {
    it("has a scale to follow", () => {
        assert.notEqual(primary, null, "the settings option title size was not found");
        assert.notEqual(secondary, null, "the settings option description size was not found");
        assert.notEqual(primary, secondary, "the settings scale lost its two tiers");
    });

    for (const selector of [".timeframe-preset", ".current-month", ".day-btn"]) {
        it(`sizes ${selector} like a settings option title`, () => {
            assert.equal(fontSizeOf(picker, selector), primary);
        });
    }

    for (const selector of [".calendar-selecting", ".weekday"]) {
        it(`sizes ${selector} like a settings option description`, () => {
            assert.equal(fontSizeOf(picker, selector), secondary);
        });
    }

    // The settings dialog keeps its sizes on a phone, so a media query quietly
    // shrinking the popover's text would undo the alignment exactly where the
    // two dialogs are most often compared.
    it("keeps the scale on narrow viewports", () => {
        const mediaTail = picker.split("@media").slice(1).join("@media");
        for (const selector of ["timeframe-preset", "current-month", "day-btn", "calendar-selecting", "weekday"]) {
            const override = new RegExp(`\\.${selector}[^{}]*\\{[^}]*font-size`);
            assert.doesNotMatch(mediaTail, override, `.${selector} changes size in a media query`);
        }
    });
});
