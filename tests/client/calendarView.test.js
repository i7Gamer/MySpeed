import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { monthToShow } from "../../client/src/common/components/DateRangePicker/calendarNav.js";

const PICKER_DIR = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..",
    "client", "src", "common", "components", "DateRangePicker");

const source = fs.readFileSync(path.join(PICKER_DIR, "DateRangePicker.jsx"), "utf8");
const styles = fs.readFileSync(path.join(PICKER_DIR, "styles.sass"), "utf8");

/**
 * Which month the calendar opens on.
 *
 * Regression: the view was seeded once, in a useState initialiser, from
 * whatever range the picker was mounted with. Measured on a running instance:
 * with the URL on a January 2025 range the calendar showed January 2025,
 * then choosing "Last 7 days" moved the range to August 2026 - and reopening
 * the calendar still showed January 2025, nineteen presses of the month arrow
 * away from the range it was describing.
 */
const NOW = new Date(2026, 7, 10);

describe("monthToShow", () => {
    it("shows the month the range ends in", () => {
        assert.deepEqual(monthToShow(new Date(2025, 0, 7), NOW), new Date(2025, 0, 1));
    });

    it("anchors to the first, so a 31st never rolls into the next month", () => {
        assert.deepEqual(monthToShow(new Date(2026, 2, 31), NOW), new Date(2026, 2, 1));
    });

    /**
     * All time selects no dates at all, and the overview opens on it. With
     * nothing to anchor to, the current month is the only useful answer.
     */
    it("falls back to the current month when the range has no end", () => {
        assert.deepEqual(monthToShow(null, NOW), new Date(2026, 7, 1));
        assert.deepEqual(monthToShow(undefined, NOW), new Date(2026, 7, 1));
    });

    it("ignores an unusable date rather than showing an invalid month", () => {
        assert.deepEqual(monthToShow(new Date("nonsense"), NOW), new Date(2026, 7, 1));
    });
});

describe("the picker follows the selected range", () => {
    it("derives the calendar view from `to` rather than seeding it once", () => {
        assert.doesNotMatch(source, /useState\(new Date\(to/,
            "the calendar view is still captured at mount");
        assert.match(source, /monthToShow\(/, "the calendar view is not derived from the range");
    });

    it("re-anchors the view when the range changes", () => {
        assert.match(source, /setCurrentMonth\(monthToShow\(to\)\)/,
            "nothing moves the calendar back onto a newly chosen range");
    });
});

/**
 * On a phone the popover is a centred sheet sized `calc(100vw - 2rem)`, meant
 * to leave a 1rem gutter either side. Only `main > *` gets the border-box
 * reset, so its padding and border were added on top of that width instead:
 * 343 + 32 + 2 = 377px inside a 375px viewport, bleeding a pixel past both
 * edges rather than sitting inside them.
 */
describe("the mobile sheet fits the screen", () => {
    it("sizes the popover by its border box", () => {
        // The rule inside the phone media query, up to whatever selector
        // follows it.
        const block = styles.slice(styles.indexOf("@media screen and (max-width: 600px)"));
        const popover = block.slice(block.indexOf(".date-range-popover"));
        const rule = popover.slice(0, popover.indexOf("\n\n") === -1 ? undefined : popover.indexOf("\n\n"));

        assert.match(rule, /width: calc\(100vw - 2rem\)/, "the sheet is no longer sized against the viewport");
        assert.match(rule, /box-sizing: border-box/,
            "the sheet's padding and border still push it past its own width");
    });
});
