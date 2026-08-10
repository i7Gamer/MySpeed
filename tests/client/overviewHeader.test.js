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

// Matches a selector within a group as well as on its own, and joins every
// rule that targets it: grouped selectors compile to one comma-separated block
// so an exact string compare finds nothing, and a selector styled by two rules
// would otherwise be judged on whichever came first.
const blockOf = (selector, css = base) => {
    const bodies = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .filter(([, selectors]) => selectors.split(",").some(one => one.trim() === selector))
        .map(([, , body]) => body);

    return bodies.length > 0 ? bodies.join(";") : null;
};

/**
 * The overview gained the statistics page's two controls, but on one row with
 * the status bar between them rather than in a strip of their own: date range
 * on the left, the bar narrowed to what is left, export on the right.
 */
describe("the overview header row", () => {
    it("carries the range picker, the status bar, the start button and the export", () => {
        assert.match(home, /<DateRangePicker/);
        assert.match(home, /<StatusBarComponent/);
        assert.match(home, /<StartTestButton/);
        assert.match(home, /<ExportButton/);
    });

    // Start sits next to the status it acts on - the two were one panel until
    // the button moved out - and the export trails as the utility of the row.
    it("orders them picker, bar, start, export", () => {
        const order = ["DateRangePicker", "StatusBarComponent", "StartTestButton", "ExportButton"]
            .map(name => home.indexOf(`<${name}`));

        assert.ok(order.every(index => index > 0), "one of the four is not rendered");
        assert.deepEqual([...order].sort((a, b) => a - b), order, "the four are not in left-to-right order");
    });

    it("lays the row out horizontally", () => {
        const row = blockOf(".overview-header");

        assert.notEqual(row, null, "the row has no rule of its own");
        assert.match(row, /display:\s*flex/);
    });

    /**
     * Three different heights, two corner radii and two background treatments
     * on one line was what made this row look unresolved - and at 92px with a
     * 16px corner the bar was within 3px of being a card from the list below,
     * so it read as content with two loose pills stuck to its sides.
     *
     * Stretch is what makes them one set: every control takes the height of the
     * bar between them, so no rule has to guess a number that then drifts.
     */
    it("gives every control in the row the same height", () => {
        assert.match(blockOf(".overview-header"), /align-items:\s*stretch/);

        // These two sit inside a wrapper, and the wrapper is what stretch
        // resizes - so the control itself has to be told to fill it.
        for (const control of [".date-range-trigger", ".export-button"]) {
            const body = blockOf(`.overview-header ${control}`);

            assert.notEqual(body, null, `${control} is not sized to the row`);
            assert.match(body, /height:\s*100%/);
            // Both carry a border, so content-box would make them taller than
            // the height they were just told to take.
            assert.match(body, /box-sizing:\s*border-box/);
        }
    });

    /**
     * The start button is a direct child of the row, so stretch already sizes
     * it. Giving it `height: 100%` as well resolves against a parent whose own
     * height is content-derived, quietly falls back to auto, and leaves the
     * button two pixels short of everything beside it - which is exactly the
     * mismatch this row was rebuilt to remove.
     */
    it("lets stretch size the start button rather than a percentage", () => {
        for (const [, selectors, body] of base.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
            const targetsButton = selectors.split(",")
                .some(one => /\.overview-header\s*>?\s*\.start-test\s*$/.test(one.trim()));

            if (targetsButton)
                assert.doesNotMatch(body, /height:\s*100%/, `"${selectors.trim()}" defeats the button's stretch`);
        }
    });

    it("gives them one surface and one corner rather than three", () => {
        const controls = blockOf(".overview-header .date-range-trigger");

        assert.match(controls, /background-color:\s*var\(--glass-bg\)/);
        assert.match(blockOf(".overview-header > .status-bar"), /border-radius/);
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
