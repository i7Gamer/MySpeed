import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    isCurrentMonth, monthBack, monthForward, yearBack, yearForward
} from "../../client/src/common/components/DateRangePicker/calendarNav.js";

// A fixed "now" keeps every expectation deterministic. Local noon avoids any
// chance of the date rolling over under a different machine timezone.
const NOW = new Date(2026, 7, 7, 12, 0, 0);

const view = (year, month) => new Date(year, month, 1);

const label = (date) => `${date.getFullYear()}-${date.getMonth()}`;

/**
 * The calendar used to move only month by month: reaching a window from last
 * spring took a dozen clicks, and walking back out took a dozen more. The year
 * chevrons step twelve months at once - and the arithmetic lives here, pure,
 * because the clamp is where the judgement sits.
 */
describe("stepping the calendar", () => {
    it("steps back a month, across a year boundary included", () => {
        assert.equal(label(monthBack(view(2026, 7))), "2026-6");
        assert.equal(label(monthBack(view(2026, 0))), "2025-11");
    });

    it("steps forward a month, across a year boundary included", () => {
        assert.equal(label(monthForward(view(2026, 6))), "2026-7");
        assert.equal(label(monthForward(view(2025, 11))), "2026-0");
    });

    it("steps back a whole year", () => {
        assert.equal(label(yearBack(view(2026, 7))), "2025-7");
    });

    it("steps forward a whole year", () => {
        assert.equal(label(yearForward(view(2024, 3), NOW)), "2025-3");
    });

    /**
     * The forward clamp: the calendar never shows a month after the current
     * one - there are no future tests - but a hard disable would strand
     * December 2025 eight months short of today with no year jump at all.
     * Overshooting lands on the current month instead, so the button always
     * moves as far as there is anywhere to go.
     */
    it("clamps a forward year jump to the current month", () => {
        assert.equal(label(yearForward(view(2025, 11), NOW)), "2026-7");
    });

    it("keeps a jump that lands exactly on the current month", () => {
        assert.equal(label(yearForward(view(2025, 7), NOW)), "2026-7");
    });

    it("goes nowhere from the current month itself", () => {
        assert.equal(label(yearForward(view(2026, 7), NOW)), "2026-7");
    });

    // Both forward buttons disable on the same judgement, so it lives in one
    // function rather than being derived twice.
    it("knows when the view sits on the current month", () => {
        assert.equal(isCurrentMonth(view(2026, 7), NOW), true);
        assert.equal(isCurrentMonth(view(2026, 6), NOW), false);
        assert.equal(isCurrentMonth(view(2025, 7), NOW), false);
    });

    it("always answers with the first of the month", () => {
        for (const stepped of [monthBack(view(2026, 7)), monthForward(view(2026, 5)),
            yearBack(view(2026, 7)), yearForward(view(2025, 11), NOW)])
            assert.equal(stepped.getDate(), 1);
    });
});
