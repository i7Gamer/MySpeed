import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as sass from "sass";
import fs from "node:fs";
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

const read = (file) => fs.readFileSync(path.join(CLIENT_SRC, file), "utf8");

const home = read("pages/Home/Home.jsx");
const header = read("common/components/Header/HeaderComponent.jsx");
const picker = read("common/components/DateRangePicker/DateRangePicker.jsx");

const compiled = sass.compile(
    path.join(CLIENT_SRC, "pages/Home/styles.sass"),
    {importers: [aliasImporter]}
).css;

const base = compiled.split("@media")[0];

const blockOf = (selector, css = base) => {
    for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (selectors.trim() === selector) return body;
    }
    return null;
};

/**
 * The overview gained the statistics page's two controls, but on one row with
 * the status bar between them rather than in a strip of their own: date range
 * on the left, the bar narrowed to what is left, export on the right.
 */
describe("the overview header row", () => {
    it("carries the range picker, the status bar and the export button", () => {
        assert.match(home, /<DateRangePicker/);
        assert.match(home, /<StatusBarComponent/);
        assert.match(home, /<ExportButton/);
    });

    it("orders them picker, bar, export", () => {
        const order = ["DateRangePicker", "StatusBarComponent", "ExportButton"]
            .map(name => home.indexOf(`<${name}`));

        assert.ok(order.every(index => index > 0), "one of the three is not rendered");
        assert.deepEqual([...order].sort((a, b) => a - b), order, "the three are not in left-to-right order");
    });

    it("lays the row out horizontally", () => {
        const row = blockOf(".overview-header");

        assert.notEqual(row, null, "the row has no rule of its own");
        assert.match(row, /display:\s*flex/);
        assert.match(row, /align-items:\s*center/);
    });

    // The bar takes what the two controls leave; they keep their own width.
    it("shrinks the status bar to what the two controls leave", () => {
        assert.match(blockOf(".overview-header > .status-bar"), /flex:\s*1 1 auto/);
        assert.match(blockOf(".overview-header > .status-bar"), /min-width:\s*0/);
        assert.match(blockOf(".overview-header > .export-button-container"), /flex:\s*0 0 auto/);
    });

    // The bar was a block of its own with margins above and below it; inside a
    // row those margins would push the two controls out of line with it.
    it("drops the bar's standalone margins inside the row", () => {
        const bar = blockOf(".overview-header > .status-bar");

        assert.match(bar, /margin-top:\s*0/);
        assert.match(bar, /margin-bottom:\s*0/);
    });

    // Three controls on one line do not fit a phone.
    it("wraps on a narrow viewport", () => {
        const narrow = compiled.split("@media").slice(1).join("@media");

        assert.match(narrow, /\.overview-header\s*\{[^}]*flex-wrap:\s*wrap/);
    });
});

/**
 * The header's clock icon opens the same presets and always lands on the
 * statistics page. On the overview that now sits beside a picker that means
 * something different - the range of the list right below it - so the header
 * one is not offered there.
 */
describe("the header timeframe selector", () => {
    it("is hidden on the route that carries its own picker", () => {
        assert.match(header, /showsStatusBar\(location\.pathname\)[^}]*<TimeframeSelector|!showsStatusBar\(location\.pathname\)\s*&&\s*<TimeframeSelector/);
    });

    it("still renders everywhere else", () => {
        assert.match(header, /<TimeframeSelector\s*\/>/);
    });
});

/**
 * The picker offers whatever presets its page hands it, so the overview can add
 * "All time" without the statistics page or the header selector gaining an
 * option that means "no range at all".
 */
describe("the date range picker", () => {
    it("takes its presets from the page rather than the shared list", () => {
        assert.match(picker, /presets\s*=\s*TIMEFRAMES/);
        assert.match(picker, /presets\.map/);
    });

    // With all-time selected there are no dates to show, and the trigger used
    // to fall through to "Select date range" - which reads as nothing chosen.
    it("names the selected preset when it has no dates to show", () => {
        assert.match(picker, /presets\.find/);
    });
});
