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

const toolbar = read("common/components/PageToolbar/PageToolbar.jsx");
const home = read("pages/Home/Home.jsx");
const statistics = read("pages/Statistics/Statistics.jsx");
const header = read("common/components/Header/HeaderComponent.jsx");
const picker = read("common/components/DateRangePicker/DateRangePicker.jsx");

const compiled = sass.compile(
    path.join(CLIENT_SRC, "common/components/PageToolbar/styles.sass"),
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
 * One toolbar above every page of test data: the range it covers, the status
 * of the last run, a way to start another, and a way to take the data away.
 * It began as the overview's own header row and moved to common when the
 * statistics traded their picker-and-export strip for it.
 */
describe("the page toolbar", () => {
    it("carries the range picker, the status bar, the start button and the export", () => {
        assert.match(toolbar, /<DateRangePicker/);
        assert.match(toolbar, /<StatusBarComponent/);
        assert.match(toolbar, /<StartTestButton/);
        assert.match(toolbar, /<ExportButton/);
    });

    // Start sits next to the status it acts on - the two were one panel until
    // the button moved out - and the export trails as the utility of the row.
    it("orders them picker, bar, start, export", () => {
        const order = ["DateRangePicker", "StatusBarComponent", "StartTestButton", "ExportButton"]
            .map(name => toolbar.indexOf(`<${name}`));

        assert.ok(order.every(index => index > 0), "one of the four is not rendered");
        assert.deepEqual([...order].sort((a, b) => a - b), order, "the four are not in left-to-right order");
    });

    it("is what the overview renders", () => {
        assert.match(home, /<PageToolbar/);
        assert.doesNotMatch(home, /<DateRangePicker|<ExportButton|<StatusBarComponent|<StartTestButton/);
    });

    /**
     * The statistics used to carry a strip of their own - picker and export in
     * a .statistics-header - which is exactly the mismatched chrome the toolbar
     * replaced on the overview. Every render path shows it, the failed one
     * included: the toolbar needs nothing from the fetch, and a failed load is
     * exactly when changing the range is the way out.
     */
    it("is what the statistics render, on every path", () => {
        assert.ok((statistics.match(/\{toolbar\}/g) ?? []).length >= 3,
            "a statistics render path is missing the toolbar");
        assert.doesNotMatch(statistics, /statistics-header|<ExportButton|skeleton-picker/);
    });

    /**
     * The picker used to be handed its presets by the page, so that the overview
     * could lead with "All time" while the statistics - which could not draw an
     * unbounded range - kept the bounded list. The statistics now resolve all
     * time to the extent of the tests themselves, so both pages offer the same
     * presets and the prop that told them apart is gone.
     */
    it("hands the picker no presets of its own", () => {
        for (const [name, source] of [["the toolbar", toolbar], ["the overview", home],
            ["the statistics", statistics]])
            assert.doesNotMatch(source, /presets/, `${name} still carries a preset list`);
    });

    /**
     * Three different heights, two corner radii and two background treatments
     * on one line was what made the original row look unresolved - at 92px
     * with a 16px corner the bar was within 3px of a card from the list below.
     *
     * Stretch is what makes them one set: every control takes the height of
     * the bar between them, so no rule has to guess a number that then drifts.
     */
    it("gives every control in the row the same height", () => {
        assert.match(blockOf(".page-toolbar"), /align-items:\s*stretch/);

        // These two sit inside a wrapper, and the wrapper is what stretch
        // resizes - so the control itself has to be told to fill it.
        for (const control of [".date-range-trigger", ".export-button"]) {
            const body = blockOf(`.page-toolbar ${control}`);

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
                .some(one => /\.page-toolbar\s*>?\s*\.start-test\s*$/.test(one.trim()));

            if (targetsButton)
                assert.doesNotMatch(body, /height:\s*100%/, `"${selectors.trim()}" defeats the button's stretch`);
        }
    });

    it("gives them one surface and one corner rather than three", () => {
        assert.match(blockOf(".page-toolbar .date-range-trigger"), /background-color:\s*var\(--glass-bg\)/);
        assert.match(blockOf(".page-toolbar > .status-bar"), /border-radius/);
    });

    // Four controls on one line do not fit a phone: the bar takes a row of its
    // own below the three that bound it.
    it("wraps on a narrow viewport", () => {
        const narrow = compiled.split("@media").slice(1).join("@media");

        assert.match(narrow, /\.page-toolbar\s*\{[^}]*flex-wrap:\s*wrap/);
        assert.match(narrow, /\.page-toolbar\s*>\s*\.status-bar\s*\{[^}]*flex:\s*1 1 100%/);
    });
});

/**
 * With both pages carrying the toolbar, the header's own copies of its controls
 * are gone for good: the timeframe clock and the start gauge each duplicated a
 * control the page below already owns, and two controls for one action only
 * raise the question of which one the page obeys.
 */
describe("the header after the toolbar", () => {
    it("offers no timeframe selector anywhere", () => {
        assert.doesNotMatch(header, /TimeframeSelector/);
        assert.equal(fs.existsSync(path.join(CLIENT_SRC, "common/components/TimeframeSelector")), false,
            "the component itself should be gone, not merely unmounted");
    });

    it("offers no start control", () => {
        assert.doesNotMatch(header, /faGaugeHigh|startSpeedtest|start_tooltip/);
    });
});

/**
 * One list of presets, offered wherever the picker is, and "All time" leads it
 * on both pages.
 */
describe("the date range picker", () => {
    it("offers the shared list, all time included", () => {
        assert.match(picker, /PICKER_TIMEFRAMES\.map/);
    });

    // With all-time selected there are no dates to show, and the trigger used
    // to fall through to "Select date range" - which reads as nothing chosen.
    it("names the selected preset when it has no dates to show", () => {
        assert.match(picker, /PICKER_TIMEFRAMES\.find/);
    });
});
