import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDateRange, previousRange, truncateToElapsed } from "../../server/util/dateRange.js";
import { resolveTimezone, zoneFromName } from "../../server/util/timezone.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_HOUR = 60 * 60 * 1000;

// UTC+2, the way getTimezoneOffset reports it: minutes behind UTC.
const BERLIN_SUMMER = -120;

const berlin = () => {
    const resolved = resolveTimezone({tz: "Europe/Berlin"});
    assert.equal(resolved.valid, true, "Europe/Berlin did not resolve");
    return resolved.zone;
};

const BERLIN = berlin();

const range = (from, to) => {
    const parsed = parseDateRange(from, to, {zone: BERLIN});
    assert.equal(parsed.valid, true, `${from}..${to} did not parse`);
    return parsed;
};

const previousOf = (current) => {
    const previous = previousRange(current, {zone: BERLIN});
    assert.equal(previous.valid, true, "the previous window did not parse");
    return previous;
};

/**
 * The previous window, cut to what the range has actually lived through.
 *
 * A range that ends today has only run until now while the window before it is
 * complete, so every count compared a part-week against a whole one and read
 * lower on every partial day. The cut is the same calendar position at the
 * same time lived since that day's own local midnight - a wall clock
 * everywhere except the transition days, where the wall clock is the measure
 * that lies - which is what makes "total tests, versus the week before" a
 * claim about two windows of the same length.
 */
describe("truncateToElapsed", () => {
    it("leaves a range that is fully in the past alone", () => {
        const current = range("2026-08-04", "2026-08-10");
        const previous = previousOf(current);

        const window = truncateToElapsed(current, previous, new Date("2026-08-15T09:00:00.000Z"));

        assert.equal(window, previous,
            "a complete range needs no cut, and its window must come back untouched");
    });

    it("leaves a range whose last instant is now alone", () => {
        const current = range("2026-08-04", "2026-08-10");
        const previous = previousOf(current);

        assert.equal(truncateToElapsed(current, previous, new Date(current.to)), previous);
    });

    it("answers null before any of the range has happened", () => {
        const current = range("2026-08-04", "2026-08-10");

        assert.equal(truncateToElapsed(current, previousOf(current), new Date("2026-08-01T09:00:00.000Z")), null,
            "nothing has elapsed, so there is nothing a comparison could be about");
    });

    /**
     * And at the range's own first instant, which is the boundary the guard
     * used to let through. Zero days elapsed at a wall clock of midnight put
     * the cut exactly on the window's start: a comparison over no time at all,
     * carried out to the page as zero counts under a partial heading - where
     * the promise above is null, "nothing to compare against yet".
     */
    it("answers null at the range's exact first instant", () => {
        const current = range("2026-08-04", "2026-08-10");

        assert.equal(truncateToElapsed(current, previousOf(current), new Date(current.from.getTime())), null,
            "a window of zero width is not a comparison, it is the absence of one");
    });

    it("cuts at the same wall clock one window earlier", () => {
        // Thursday mid-afternoon, Berlin summer: 14:32:05.123 local.
        const current = range("2026-08-21", "2026-08-27");
        const previous = previousOf(current);
        const now = new Date("2026-08-27T12:32:05.123Z");

        const window = truncateToElapsed(current, previous, now);

        assert.equal(window.partial, true, "a cut window has to say it was cut");
        assert.equal(window.from.toISOString(), "2026-08-13T22:00:00.000Z",
            "the start of the previous window moved");
        assert.equal(window.to.toISOString(), "2026-08-20T12:32:05.123Z",
            "the cut is not the same time of day one week earlier");
        assert.ok(window.to.getTime() <= previous.to.getTime(),
            "the cut ran past the window it was cutting");
        assert.equal(window.days, current.days, "the calendar length the echo reports changed");
    });

    it("compares today against the same hours of yesterday for a single-day range", () => {
        const current = range("2026-08-27", "2026-08-27");

        const window = truncateToElapsed(current, previousOf(current), new Date("2026-08-27T12:32:05.123Z"));

        assert.equal(window.from.toISOString(), "2026-08-25T22:00:00.000Z");
        assert.equal(window.to.toISOString(), "2026-08-26T12:32:05.123Z");
    });

    it("cuts by day position, not on the last day, when the range runs past today", () => {
        // An API-supplied range whose end lies in the future: now is day eight
        // of eleven, so the cut falls on day eight of the previous eleven.
        const current = range("2026-08-20", "2026-08-30");

        const window = truncateToElapsed(current, previousOf(current), new Date("2026-08-27T12:32:05.123Z"));

        assert.equal(window.from.toISOString(), "2026-08-08T22:00:00.000Z");
        assert.equal(window.to.toISOString(), "2026-08-16T12:32:05.123Z");
    });

    it("lands past the hour spring skips, at the elapsed position", () => {
        // Berlin skips 02:00-03:00 on 29 March 2026, so the cut day has only
        // 23 hours. Two and a half hours lived since now's midnight land two
        // and a half hours into that shorter day: 03:30 CEST, on the far side
        // of the gap. The instant is the one the old wall-clock rule also
        // produced - pushing 02:30 through a one-hour gap IS adding the hour -
        // but it is arithmetic on midnights now, not utcFromLocal resolving a
        // time that never was; the gap rule itself is pinned in
        // timezone.test.js, where the primitive lives.
        const current = range("2026-03-30", "2026-04-05");

        const window = truncateToElapsed(current, previousOf(current), new Date("2026-04-05T00:30:00.000Z"));

        assert.equal(window.to.toISOString(), "2026-03-29T01:30:00.000Z");
    });

    it("lands in the first pass of the hour autumn repeats", () => {
        // Berlin repeats 02:00-03:00 on 25 October 2026. Two and a half hours
        // lived since now's midnight land in the FIRST 02:30 of the doubled
        // hour, because that is the instant two and a half hours into the cut
        // day - not because anything chose between two readings of one wall
        // clock; no ambiguous local time is resolved on this path any more,
        // and that tie-break is pinned in timezone.test.js.
        const current = range("2026-10-26", "2026-11-01");
        const previous = previousOf(current);
        const now = new Date("2026-11-01T01:30:00.000Z");

        const window = truncateToElapsed(current, previous, now);

        assert.equal(window.to.toISOString(), "2026-10-25T00:30:00.000Z");
        assert.equal(window.to - previous.from, now - current.from,
            "the two windows no longer cover the same elapsed time");
    });

    /**
     * The transition day itself, from both sides. The cut used to copy now's
     * wall clock onto the earlier day, and a wall clock is only a measure of
     * elapsed time while the offset holds still: with now inside the hour
     * autumn repeats, 02:30 read the same at 3.5 elapsed hours as it had at
     * 2.5, so the previous window was cut an hour short - and once the earlier
     * day was the one carrying the extra hour, the same copy cut it an hour
     * long. Both windows now cover the same time lived since their own local
     * midnights, which is the only sentence that stays true through a shift.
     */
    it("keeps the spans equal while now is inside the doubled hour", () => {
        // 01:30Z on 25 October 2026 is 02:30 CET, the second pass - three and
        // a half hours into the local day, at a wall clock that says two and
        // a half.
        const current = range("2026-10-19", "2026-10-25");
        const previous = previousOf(current);
        const now = new Date("2026-10-25T01:30:00.000Z");

        const window = truncateToElapsed(current, previous, now);

        assert.equal(window.to.toISOString(), "2026-10-18T01:30:00.000Z");
        assert.equal(window.to - previous.from, now - current.from,
            "the two windows no longer cover the same elapsed time");
    });

    it("keeps the spans equal for the rest of the day the doubled hour stretched", () => {
        // 04:00 CET on 1 November: four hours into a plain day. The cut day a
        // week earlier lived 25 hours, so its 04:00 wall clock stands at five
        // elapsed hours - the cut lands at four hours in, 03:00 CET, the shift
        // already behind it.
        const current = range("2026-10-26", "2026-11-01");
        const previous = previousOf(current);
        const now = new Date("2026-11-01T03:00:00.000Z");

        const window = truncateToElapsed(current, previous, now);

        assert.equal(window.to.toISOString(), "2026-10-25T02:00:00.000Z");
        assert.equal(window.to - previous.from, now - current.from,
            "the two windows no longer cover the same elapsed time");
    });

    it("keeps the spans equal for the rest of the day spring shortened", () => {
        // 03:30 CEST on 29 March 2026, half an hour after the skipped hour:
        // two and a half hours into a 23-hour day. Copied as a wall clock onto
        // the plain day a week before it read three and a half.
        const current = range("2026-03-23", "2026-03-29");
        const previous = previousOf(current);
        const now = new Date("2026-03-29T01:30:00.000Z");

        const window = truncateToElapsed(current, previous, now);

        assert.equal(window.to.toISOString(), "2026-03-22T01:30:00.000Z");
        assert.equal(window.to - previous.from, now - current.from,
            "the two windows no longer cover the same elapsed time");
    });

    /**
     * A recorded limitation, asserted at the size it actually is.
     *
     * The three tests above hold the spans equal because in each of them the
     * shift is the cut day's own, or `now`'s. It is not equal when the shift
     * sits between them - earlier in the range, on a day both windows have
     * already passed. The elapsed offset is measured against the day `now` is
     * in and laid onto the cut day, so an hour the calendar dropped between
     * those two days is counted by neither, and the comparison window covers
     * one hour more than the range has lived.
     *
     * Accepted rather than fixed: one hour in a window measured in days, twice
     * a year per zone, against a correction that would have to walk the
     * calendar between the two days to find the shift at all. The number is
     * pinned so that a change here is a decision somebody made rather than a
     * drift - and so the docblock on truncateToElapsed, which says this, has
     * something holding it true.
     */
    it("covers an hour more than the range lived when the shift is behind both days", () => {
        // 12:00 CEST on 30 March 2026, the day after the spring forward. The
        // range started on the 23rd, a week before the shift; the cut lands on
        // 16 March, a week before that, and neither day is the one that moved.
        const current = range("2026-03-23", "2026-04-05");
        const previous = previousOf(current);
        const now = new Date("2026-03-30T10:00:00.000Z");

        const window = truncateToElapsed(current, previous, now);

        const lived = now - current.from;
        const covered = window.to - previous.from;

        assert.equal(lived / MS_PER_HOUR, 179);
        assert.equal(covered / MS_PER_HOUR, 180);
        assert.equal(covered - lived, MS_PER_HOUR,
            "the known one-hour overhang changed size; decide what it should be rather than re-pinning it");
    });

    /**
     * The 25th hour itself, mid-window. Once the fall-back day has lived past
     * 24 hours, the elapsed offset is longer than the plain day it is laid
     * onto - unbounded, it spilled into the next day of the comparison window
     * and the day rollover at local midnight then snapped the cut BACK an
     * hour, so a page refreshed across midnight watched its comparison window
     * shrink. The extra hour has no counterpart: the cut saturates at the end
     * of its own day, exactly where the rollover resumes.
     */
    it("saturates the cut at its day's end while now lives the extra hour", () => {
        const current = range("2026-10-01", "2026-10-31");
        const previous = previousOf(current);

        // 22:30Z is 24.5 hours into Berlin's 25-hour 25 October; the plain
        // 24 September a month back has no 24.5th hour to point into.
        const window = truncateToElapsed(current, previous, new Date("2026-10-25T22:30:00.000Z"));

        assert.equal(window.to.toISOString(), "2026-09-24T22:00:00.000Z",
            "the cut left its own day");
    });

    it("never moves the cut backwards as now crosses local midnight", () => {
        const current = range("2026-10-01", "2026-10-31");
        const previous = previousOf(current);

        let last = null;
        for (const iso of ["2026-10-25T22:59:59.000Z", "2026-10-25T23:00:00.000Z",
            "2026-10-25T23:30:00.000Z"]) {
            const window = truncateToElapsed(current, previous, new Date(iso));

            if (last !== null)
                assert.ok(window.to.getTime() >= last,
                    `the cut moved backwards while now advanced to ${iso}`);
            last = window.to.getTime();
        }
    });

    /**
     * The one anchor the cut still asks utcFromLocal for is midnight itself,
     * and Santiago is the zone the docblock names for why: Chile springs
     * forward AT midnight, so 6 September 2026 has no 00:00 at all. The
     * anchor resolves to the day's first real instant, 01:00 -03, and the
     * lived offset is laid onto that - the same rule the range bounds follow,
     * which is the whole point of resolving both with one function.
     */
    it("anchors on a day whose midnight the shift removed", () => {
        const resolved = resolveTimezone({tz: "America/Santiago"});
        assert.equal(resolved.valid, true, "America/Santiago did not resolve");

        const current = parseDateRange("2026-09-07", "2026-09-13", {zone: resolved.zone});
        const previous = previousRange(current, {zone: resolved.zone});

        // Noon lived on 13 September - 15:00Z at -03 - laid onto a cut day
        // that begins at 01:00 -03 (04:00Z): twelve hours after the day's
        // first real instant, 16:00Z.
        const window = truncateToElapsed(current, previous, new Date("2026-09-13T15:00:00.000Z"));

        assert.equal(window.to.toISOString(), "2026-09-06T16:00:00.000Z");
    });

    it("cuts the same way from a bare offset as from a named zone", () => {
        // A node running an older version sends only tzOffset. A fixed offset
        // has no transitions, so the cut is exactly a week before now.
        const current = parseDateRange("2026-08-21", "2026-08-27", {offsetMinutes: BERLIN_SUMMER});
        const previous = previousRange(current, {offsetMinutes: BERLIN_SUMMER});
        const now = new Date("2026-08-27T12:32:05.123Z");

        const window = truncateToElapsed(current, previous, now);

        assert.equal(window.to.getTime(), now.getTime() - 7 * MS_PER_DAY);
    });
});

/**
 * A window the caller named rather than the period immediately before.
 *
 * The cut reads only the two windows' own bounds, so an arbitrary comparison
 * window needs no branch - "1-31 August so far against all of last August"
 * cuts last August at the same calendar position, which is the whole point:
 * fifteen days of tests compared against thirty-one reports every count
 * halved under a heading claiming two comparable months.
 */
describe("truncateToElapsed over a window of another length", () => {
    const BERLIN = {zone: zoneFromName("Europe/Berlin")};

    it("cuts a longer comparison window at the same calendar offset", () => {
        const august = parseDateRange("2026-08-01", "2026-08-31", BERLIN);
        const lastAugust = parseDateRange("2025-08-01", "2025-08-31", BERLIN);
        // Halfway through 15 August, Berlin summer time.
        const now = new Date("2026-08-15T10:20:00.000Z");

        const window = truncateToElapsed(august, lastAugust, now);

        assert.equal(window.partial, true, "a genuinely cut window stopped saying so");
        // Fourteen whole days elapsed, so the cut lands on 15 August 2025 at
        // now's own wall clock - the same position, a year earlier.
        assert.equal(window.to.toISOString(), "2025-08-15T10:20:00.000Z");
    });

    /**
     * And the refinement the arbitrary window makes live: a comparison window
     * that ENDS before the elapsed offset is returned whole, and a whole
     * window is not a partial one. Labelled partial, the page puts "up to the
     * same time of day" under a comparison that covers all of itself.
     */
    it("calls a window it did not actually cut complete", () => {
        const august = parseDateRange("2026-08-01", "2026-08-31", BERLIN);
        // Three days in February, long finished, against a range 14 days in.
        const february = parseDateRange("2026-02-01", "2026-02-03", BERLIN);
        const now = new Date("2026-08-15T10:20:00.000Z");

        const window = truncateToElapsed(august, february, now);

        assert.equal(window.to.getTime(), february.to.getTime(),
            "the whole window was not returned whole");
        assert.notEqual(window.partial, true,
            "a window the cut never reached was labelled as cut, which puts the partial note under a complete comparison");
    });

    // The two rules that do not change: a finished range compares whole, and
    // a range that has not begun has nothing to compare at all.
    it("keeps its answers for a finished and an unstarted range", () => {
        const past = parseDateRange("2026-07-01", "2026-07-31", BERLIN);
        const lastYear = parseDateRange("2025-07-01", "2025-07-31", BERLIN);
        const now = new Date("2026-08-15T10:20:00.000Z");

        assert.equal(truncateToElapsed(past, lastYear, now), lastYear);
        assert.equal(truncateToElapsed(parseDateRange("2026-09-01", "2026-09-30", BERLIN),
            lastYear, now), null);
    });
});

/**
 * A window the caller named, which is where the early return stopped holding.
 *
 * `if (now >= range.to) return previous` was written when `previous` could only
 * be previousRange's answer - a window immediately before the range, therefore
 * necessarily finished. A caller may now name any window it likes, and nothing
 * upstream refuses one that has not happened: neither parseCompareWindow nor
 * parseDateRange takes a view on the future, and the picker's newest selectable
 * day is today, whose parsed end is tonight.
 *
 * So a finished range compared against today was compared against the whole of
 * today - twelve hours of which had not happened - and reported with no partial
 * flag, so the page printed the plain sentence and every count read about half.
 */
describe("truncateToElapsed against a window that has not finished", () => {
    // A day in the past, so the range itself is fully elapsed and the early
    // return is the branch under test.
    const finished = () => range("2026-07-01", "2026-07-01");

    // Noon Berlin on a day whose window runs to midnight.
    const noonOn = (day) => new Date(`${day}T10:00:00.000Z`);

    it("cuts a comparison window that runs past now", () => {
        const today = range("2026-08-29", "2026-08-29");
        const now = noonOn("2026-08-29");

        const window = truncateToElapsed(finished(), today, now);

        assert.notEqual(window, null, "a window half of which has happened was refused");
        assert.equal(window.to.getTime(), now.getTime(),
            "the comparison ran to the end of a day that has not ended");
        assert.equal(window.partial, true,
            "a window cut at now was reported as covering all of itself");
    });

    // The whole point: a window nothing has happened in cannot be compared
    // against, and answering one of no width would print a sentence naming
    // dates whose counts are all zero.
    it("answers nothing for a window that has not started", () => {
        const nextMonth = range("2026-09-10", "2026-09-20");

        assert.equal(truncateToElapsed(finished(), nextMonth, noonOn("2026-08-29")), null);
    });

    // And a window that finished before now is untouched, which is every
    // comparison this function was originally written for.
    it("leaves a finished window exactly as it is", () => {
        const past = range("2026-06-01", "2026-06-07");
        const window = truncateToElapsed(finished(), past, noonOn("2026-08-29"));

        assert.equal(window, past, "a finished window was copied or cut");
        assert.equal(window.partial, undefined);
    });

    /**
     * The same cap on the running-range path, which has its own cut: a named
     * window whose elapsed-position cut lands in the future must still not
     * claim time that has not happened.
     */
    it("caps the elapsed cut at now as well", () => {
        const running = range("2026-08-25", "2026-09-05");
        const now = noonOn("2026-08-29");
        const window = truncateToElapsed(running, range("2026-08-27", "2026-09-07"), now);

        assert.ok(window.to.getTime() <= now.getTime(),
            `the cut landed ${(window.to.getTime() - now.getTime()) / 3600000}h in the future`);
    });
});
