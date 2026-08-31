import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDateRange, shiftedRange } from "../../server/util/dateRange.js";
import { zoneFromName } from "../../server/util/timezone.js";

const BERLIN = {zone: zoneFromName("Europe/Berlin")};

const range = (from, to) => {
    const parsed = parseDateRange(from, to, BERLIN);
    assert.equal(parsed.valid, true, `${from}..${to} did not parse`);
    return parsed;
};

// The local calendar day an instant falls on, which is what these windows are
// anchored to - comparing the instants themselves would only restate the
// arithmetic under test.
const days = (window) => {
    assert.equal(window.valid, true, `the shifted window did not parse: ${window.message}`);

    const day = (at) => new Intl.DateTimeFormat("en-CA",
        {timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit"}).format(at);

    return [day(window.from), day(window.to)];
};

/**
 * The window a comparison is taken against when the reader names an offset
 * rather than the period immediately before.
 *
 * The whole point of the offset shape is that both windows are the same length
 * by construction: the reader chooses how far back to look, never how much to
 * look at. A free pair of dates let "August so far" be compared against all of
 * 2025, which is a question nobody asked and which the elapsed cut then
 * answered by silently comparing against the first fortnight of January.
 *
 * Calendar months, not thirty-day steps, for the reason previousRange walks
 * calendar days: a month is not a fixed number of milliseconds and neither is
 * a year, and a comparison that drifts by a day per quarter stops naming the
 * period a reader picked it for.
 */
describe("shiftedRange", () => {
    it("moves a window back by whole calendar months", () => {
        assert.deepEqual(days(shiftedRange(range("2026-08-10", "2026-08-16"), 1, BERLIN)),
            ["2026-07-10", "2026-07-16"]);
    });

    it("keeps the window exactly as long as it was", () => {
        for (const months of [1, 3, 6, 12, 24]) {
            const [from, to] = days(shiftedRange(range("2026-08-01", "2026-08-31"), months, BERLIN));
            const span = (new Date(to) - new Date(from)) / (24 * 60 * 60 * 1000);

            assert.equal(span, 30, `a ${months}-month shift changed the window's length`);
        }
    });

    it("counts a quarter, a half and a year as the months they are", () => {
        const august = range("2026-08-10", "2026-08-16");

        assert.deepEqual(days(shiftedRange(august, 3, BERLIN)), ["2026-05-10", "2026-05-16"]);
        assert.deepEqual(days(shiftedRange(august, 6, BERLIN)), ["2026-02-10", "2026-02-16"]);
        assert.deepEqual(days(shiftedRange(august, 12, BERLIN)), ["2025-08-10", "2025-08-16"]);
        assert.deepEqual(days(shiftedRange(august, 24, BERLIN)), ["2024-08-10", "2024-08-16"]);
    });

    it("crosses the year boundary", () => {
        assert.deepEqual(days(shiftedRange(range("2026-02-05", "2026-02-08"), 3, BERLIN)),
            ["2025-11-05", "2025-11-08"]);
    });

    /**
     * The thirty-first of March, one month back, is the thirty-first of
     * February. The START clamps to the last day the target month has, which
     * is what every calendar keeps; rolling into March would begin the window
     * in the month after the one the option names.
     */
    it("clamps a start the target month does not have", () => {
        assert.deepEqual(days(shiftedRange(range("2026-03-31", "2026-03-31"), 1, BERLIN)),
            ["2026-02-28", "2026-02-28"]);
    });

    /**
     * And the end is counted forward from that clamped start rather than
     * clamped itself, so the window keeps its length.
     *
     * Clamping both ends is what a first attempt did, and the test above
     * caught it: a whole August six months back became the twenty-eight days
     * of February, so every count compared thirty-one days against
     * twenty-eight and read low - the exact fault the equal length exists to
     * end. Two days that run past the end of February is the honest answer.
     */
    it("counts the end forward rather than clamping it too", () => {
        assert.deepEqual(days(shiftedRange(range("2024-03-30", "2024-03-31"), 1, BERLIN)),
            ["2024-02-29", "2024-03-01"]);

        assert.deepEqual(days(shiftedRange(range("2026-08-01", "2026-08-31"), 6, BERLIN)),
            ["2026-02-01", "2026-03-03"],
            "a whole August lost three days to February's length");
    });

    it("lands on a leap day where the target year has one", () => {
        assert.deepEqual(days(shiftedRange(range("2025-02-28", "2025-02-28"), 12, BERLIN)),
            ["2024-02-28", "2024-02-28"]);
    });

    /**
     * Across a daylight-saving boundary the window still covers the same local
     * days, which is the reason this walks the calendar instead of subtracting
     * milliseconds: 30 days of milliseconds back from a summer date lands an
     * hour off in winter, and the window then starts at 01:00 on the day
     * before the one it names.
     */
    it("covers the same local days across a spring-forward", () => {
        // Berlin springs forward on 2026-03-29; a window in April shifted back
        // one month lands either side of it.
        assert.deepEqual(days(shiftedRange(range("2026-04-10", "2026-04-12"), 1, BERLIN)),
            ["2026-03-10", "2026-03-12"]);
    });

    it("covers the same local days across an autumn fall-back", () => {
        // Berlin falls back on 2026-10-25.
        assert.deepEqual(days(shiftedRange(range("2026-11-01", "2026-11-03"), 1, BERLIN)),
            ["2026-10-01", "2026-10-03"]);
    });

    // The window it answers is a parsed range like any other, so the caller
    // reads its ends the same way and a refusal names itself.
    it("answers a window the range parser built", () => {
        const shifted = shiftedRange(range("2026-08-10", "2026-08-16"), 1, BERLIN);

        assert.equal(shifted.valid, true);
        assert.ok(shifted.from instanceof Date && shifted.to instanceof Date);
        assert.ok(shifted.zone, "the window carries no zone, so the elapsed cut cannot read one");
    });
});
