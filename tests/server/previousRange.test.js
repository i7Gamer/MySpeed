import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDateRange, previousRange, shiftedRange } from "../../server/util/dateRange.js";
import { zoneFromName } from "../../server/util/timezone.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// UTC+2, the way getTimezoneOffset reports it: minutes behind UTC.
const BERLIN_SUMMER = -120;

const range = (from, to, offsetMinutes) => {
    const parsed = parseDateRange(from, to, {offsetMinutes});
    assert.equal(parsed.valid, true, `${from}..${to} did not parse`);
    return parsed;
};

/**
 * The window a range is compared against: the same span, immediately before it.
 *
 * Done in calendar days rather than by subtracting milliseconds. A range is
 * inclusive of both its days, so "last 7 days" is 7 calendar days and its
 * predecessor must be the 7 calendar days before that - not "the same number of
 * milliseconds earlier", which drifts by an hour across a daylight saving
 * boundary and compares six days and 23 hours against seven.
 */
describe("previousRange", () => {
    it("ends the instant before the range it precedes", () => {
        const current = range("2026-08-04", "2026-08-10", BERLIN_SUMMER);
        const previous = previousRange(current, {offsetMinutes: BERLIN_SUMMER});

        assert.equal(previous.to.getTime(), current.from.getTime() - 1,
            "the two windows do not meet exactly");
    });

    it("covers the same span as the range it precedes", () => {
        for (const [from, to] of [["2026-08-04", "2026-08-10"], ["2026-08-10", "2026-08-10"], ["2026-01-01", "2026-03-31"]]) {
            const current = range(from, to, BERLIN_SUMMER);
            const previous = previousRange(current, {offsetMinutes: BERLIN_SUMMER});

            assert.equal(previous.to - previous.from, current.to - current.from,
                `${from}..${to} is compared against a window of a different length`);
        }
    });

    it("steps back a whole week for a week", () => {
        const current = range("2026-08-04", "2026-08-10", BERLIN_SUMMER);
        const previous = previousRange(current, {offsetMinutes: BERLIN_SUMMER});
        const expected = range("2026-07-28", "2026-08-03", BERLIN_SUMMER);

        assert.equal(previous.from.getTime(), expected.from.getTime());
        assert.equal(previous.to.getTime(), expected.to.getTime());
    });

    it("compares a single day against the day before it", () => {
        const current = range("2026-08-10", "2026-08-10", BERLIN_SUMMER);
        const previous = previousRange(current, {offsetMinutes: BERLIN_SUMMER});
        const expected = range("2026-08-09", "2026-08-09", BERLIN_SUMMER);

        assert.equal(previous.from.getTime(), expected.from.getTime());
        assert.equal(previous.to.getTime(), expected.to.getTime());
    });

    /**
     * The offset the client sent anchors both windows, exactly as it anchors
     * both ends of the current one. Using the viewer's own midnight matters
     * most here: an off-by-one-day comparison is invisible but wrong.
     */
    it("anchors the earlier window to the viewer's midnight, not the server's", () => {
        const current = range("2026-08-04", "2026-08-10", BERLIN_SUMMER);
        const previous = previousRange(current, {offsetMinutes: BERLIN_SUMMER});

        // 28 July 00:00 in UTC+2 is 27 July 22:00 UTC.
        assert.equal(previous.from.toISOString(), "2026-07-27T22:00:00.000Z");
    });

    // A whole month against the month before it, where the two have different
    // lengths: the span follows the range asked for, not the calendar's idea
    // of a month.
    it("keeps the span it was given rather than snapping to a calendar month", () => {
        const current = range("2026-03-01", "2026-03-31", BERLIN_SUMMER);
        const previous = previousRange(current, {offsetMinutes: BERLIN_SUMMER});
        const days = Math.round((previous.to - previous.from) / MS_PER_DAY);

        assert.equal(days, 31);
    });

    it("works without an offset at all, the way the range parser does", () => {
        const current = range("2026-08-04", "2026-08-10");
        const previous = previousRange(current, {});
        const expected = range("2026-07-28", "2026-08-03");

        assert.equal(previous.from.getTime(), expected.from.getTime());
        assert.equal(previous.to.getTime(), expected.to.getTime());
    });
});

/**
 * A day whose LAST hour is the one the zone skips.
 *
 * Nearly every zone springs forward in the small hours, so a range's end -
 * 23:59:59.999 local - is a time that existed. Greenland's transition is at
 * 23:00, which makes that day's requested end fall inside the gap, and
 * utcFromLocal has no real candidate to return.
 *
 * It answered with the later of the two, which is what a caller asking for a
 * time that never happened wants when it asks for the FIRST such instant - and
 * exactly wrong when it asks for the last. The day's end landed an hour into
 * the next local day, so `previousRange` overlapped the range it is compared
 * against by a full hour and every test in that hour was counted in both
 * windows. `shiftedRange` inherited it, coming out a day and an hour long while
 * echoing the day count it was asked for - the one thing that function exists
 * to prevent.
 *
 * Two zones, thirteen days between 2023 and 2030, and a Greenland browser
 * reaches it: the client sends its own resolved zone name.
 */
describe("a day the zone truncates at its last hour", () => {
    const nuuk = zoneFromName("America/Nuuk");

    it("ends the day at the last instant the day actually had", () => {
        const day = parseDateRange("2026-03-28", "2026-03-28", {zone: nuuk});

        // Local 22:59:59.999, the last reading before the clock jumps to
        // midnight - not 00:59:59.999 the next day.
        assert.equal(day.to.toISOString(), "2026-03-29T00:59:59.999Z",
            "the day's end overshot the gap into the next local day");
    });

    it("leaves no overlap between a range and the window before it", () => {
        const range = parseDateRange("2026-03-29", "2026-03-29", {zone: nuuk});
        const previous = previousRange(range, {zone: nuuk});

        assert.ok(previous.to < range.from,
            `the comparison window ends ${(previous.to - range.from) / 3600000}h inside the range `
            + "it is compared against, so every test in that hour is counted in both");
    });

    // And the length promise holds across it: a month-long window shifted a
    // year back must still be that many days rather than that many days and an
    // hour, which is a reach into one more local day.
    it("keeps a shifted window's length across the truncated day", () => {
        const range = parseDateRange("2026-02-28", "2026-03-29", {zone: nuuk});
        const shifted = shiftedRange(range, 12, {zone: nuuk});

        const span = (window) => (window.to - window.from + 1) / (24 * 60 * 60 * 1000);

        assert.equal(Math.round(span(shifted) * 100) / 100, Math.round(span(range) * 100) / 100,
            "the shifted window is a different length from the range it is compared against");
    });
});
