import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDateRange, previousRange, truncateToElapsed } from "../../server/util/dateRange.js";
import { resolveTimezone } from "../../server/util/timezone.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

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
 * lower on every partial day. The cut is the same calendar position at now's
 * own wall clock, which is what makes "total tests, versus the week before" a
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

    it("resolves a cut in the hour spring skips the way the range bounds do", () => {
        // Berlin skips 02:00-03:00 on 29 March 2026. Now's wall clock is
        // 02:30 and the cut day is the transition day, so the cut names a
        // moment that never happened there. utcFromLocal answers what every
        // date library answers for a time that never was: the arithmetic
        // pushed past the gap, 03:30 CEST.
        const current = range("2026-03-30", "2026-04-05");

        const window = truncateToElapsed(current, previousOf(current), new Date("2026-04-05T00:30:00.000Z"));

        assert.equal(window.to.toISOString(), "2026-03-29T01:30:00.000Z");
    });

    it("takes the first reading of the hour autumn repeats", () => {
        // Berlin repeats 02:00-03:00 on 25 October 2026. The first reading
        // keeps the doubled hour counted once - the current window has lived
        // that wall clock once too - so the two elapsed spans stay equal.
        const current = range("2026-10-26", "2026-11-01");
        const previous = previousOf(current);
        const now = new Date("2026-11-01T01:30:00.000Z");

        const window = truncateToElapsed(current, previous, now);

        assert.equal(window.to.toISOString(), "2026-10-25T00:30:00.000Z");
        assert.equal(window.to - previous.from, now - current.from,
            "the two windows no longer cover the same elapsed time");
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
