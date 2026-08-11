import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDateRange } from "../../server/util/dateRange.js";
import { resolveTimezone } from "../../server/util/timezone.js";

describe("parseDateRange", () => {
    describe("required parameters", () => {
        it("rejects a missing 'from'", () => {
            const result = parseDateRange(undefined, "2026-08-07");
            assert.equal(result.valid, false);
            assert.match(result.message, /required/i);
        });

        it("rejects a missing 'to'", () => {
            const result = parseDateRange("2026-08-01", undefined);
            assert.equal(result.valid, false);
            assert.match(result.message, /required/i);
        });

        it("rejects an empty string", () => {
            assert.equal(parseDateRange("", "2026-08-07").valid, false);
        });
    });

    describe("format validation", () => {
        it("rejects a non YYYY-MM-DD shape", () => {
            const result = parseDateRange("07.08.2026", "2026-08-07");
            assert.equal(result.valid, false);
            assert.match(result.message, /YYYY-MM-DD/);
        });

        it("rejects a full ISO timestamp", () => {
            assert.equal(parseDateRange("2026-08-07T10:00:00Z", "2026-08-07").valid, false);
        });
    });

    describe("calendar validation", () => {
        // Regression: the old regex-only check accepted these and Date() silently
        // rolled them over into a completely different window.
        it("rejects month 13", () => {
            const result = parseDateRange("2026-13-01", "2026-13-02");
            assert.equal(result.valid, false);
            assert.match(result.message, /not a real calendar date/i);
        });

        it("rejects month 00", () => {
            assert.equal(parseDateRange("2026-00-01", "2026-08-07").valid, false);
        });

        it("rejects day 00", () => {
            assert.equal(parseDateRange("2026-08-00", "2026-08-07").valid, false);
        });

        it("rejects day 32", () => {
            assert.equal(parseDateRange("2026-08-32", "2026-09-01").valid, false);
        });

        it("rejects 31 April", () => {
            assert.equal(parseDateRange("2026-04-31", "2026-05-01").valid, false);
        });

        it("rejects 29 February in a non-leap year", () => {
            assert.equal(parseDateRange("2026-02-29", "2026-03-01").valid, false);
        });

        it("accepts 29 February in a leap year", () => {
            assert.equal(parseDateRange("2024-02-29", "2024-03-01").valid, true);
        });
    });

    describe("ordering", () => {
        it("rejects a range where 'from' is after 'to'", () => {
            const result = parseDateRange("2026-08-07", "2026-08-01");
            assert.equal(result.valid, false);
            assert.match(result.message, /before/i);
        });

        it("accepts a single-day range", () => {
            assert.equal(parseDateRange("2026-08-07", "2026-08-07").valid, true);
        });
    });

    describe("boundaries", () => {
        it("spans the whole first day and the whole last day", () => {
            const { from, to } = parseDateRange("2026-08-01", "2026-08-07");
            assert.equal(from.getHours(), 0);
            assert.equal(from.getMinutes(), 0);
            assert.equal(from.getSeconds(), 0);
            assert.equal(from.getMilliseconds(), 0);
            assert.equal(to.getHours(), 23);
            assert.equal(to.getMinutes(), 59);
            assert.equal(to.getSeconds(), 59);
            assert.equal(to.getMilliseconds(), 999);
        });

        it("returns the parsed calendar fields unchanged", () => {
            const { from, to } = parseDateRange("2026-08-01", "2026-08-07");
            assert.equal(from.getFullYear(), 2026);
            assert.equal(from.getMonth(), 7);
            assert.equal(from.getDate(), 1);
            assert.equal(to.getDate(), 7);
        });
    });

    describe("timezone offset", () => {
        // The client formats a *local* YYYY-MM-DD; without an offset the server
        // would interpret it in *server*-local time (UTC in the Docker image).
        it("shifts the window by the supplied client offset", () => {
            // getTimezoneOffset() is minutes *behind* UTC, so UTC+2 reports -120.
            const { from, to } = parseDateRange("2026-08-07", "2026-08-07", { offsetMinutes: -120 });
            assert.equal(from.toISOString(), "2026-08-06T22:00:00.000Z");
            assert.equal(to.toISOString(), "2026-08-07T21:59:59.999Z");
        });

        it("treats offset 0 as UTC", () => {
            const { from, to } = parseDateRange("2026-08-07", "2026-08-07", { offsetMinutes: 0 });
            assert.equal(from.toISOString(), "2026-08-07T00:00:00.000Z");
            assert.equal(to.toISOString(), "2026-08-07T23:59:59.999Z");
        });

        it("rejects an out-of-range offset", () => {
            assert.equal(parseDateRange("2026-08-01", "2026-08-07", { offsetMinutes: 5000 }).valid, false);
        });

        it("ignores a non-numeric offset and falls back to server-local time", () => {
            const result = parseDateRange("2026-08-01", "2026-08-07", { offsetMinutes: "abc" });
            assert.equal(result.valid, true);
            assert.equal(result.from.getHours(), 0);
        });
    });

    /**
     * A single offset is a snapshot of today, and a range routinely reaches
     * back across a daylight saving change. Anchored to today's offset, the
     * far end of the window lands an hour off its real local midnight - so a
     * "last 90 days" taken in January silently dropped the first hour of the
     * October day it starts on, from every aggregate on the page.
     *
     * The named zone is resolved at each bound instead.
     */
    describe("a named timezone", () => {
        const zoneFor = (tz) => resolveTimezone({tz}).zone;

        it("anchors each end at that end's own offset", () => {
            const { from, to } = parseDateRange("2025-10-17", "2026-01-15",
                { zone: zoneFor("Europe/Berlin") });

            // 17 October is still summer time (UTC+2); 15 January is not (UTC+1).
            assert.equal(from.toISOString(), "2025-10-16T22:00:00.000Z");
            assert.equal(to.toISOString(), "2026-01-15T22:59:59.999Z");
        });

        it("is what a single snapshot offset gets wrong", () => {
            const named = parseDateRange("2025-10-17", "2026-01-15", { zone: zoneFor("Europe/Berlin") });
            // What the client would have sent on 15 January: UTC+1.
            const snapshot = parseDateRange("2025-10-17", "2026-01-15", { offsetMinutes: -60 });

            assert.notEqual(named.from.toISOString(), snapshot.from.toISOString());
            assert.equal(snapshot.from.toISOString(), "2025-10-16T23:00:00.000Z",
                "the snapshot used to start an hour into the first day");
        });

        /**
         * Where a zone puts its clocks back at midnight an hour of the wall
         * clock happens twice, and a range naming that day has to cover both
         * passes of it - the end bound used to settle on the first, dropping
         * the second hour of tests off the end of the range.
         */
        it("covers both passes of an hour the clocks repeated", () => {
            const { from, to } = parseDateRange("2024-04-06", "2024-04-06",
                { zone: zoneFor("America/Santiago") });

            assert.equal(from.toISOString(), "2024-04-06T03:00:00.000Z");
            assert.equal(to.toISOString(), "2024-04-07T03:59:59.999Z");
            // 25 hours, because that day was 25 hours long where it happened.
            assert.equal(to - from, 25 * 60 * 60 * 1000 - 1);
        });

        it("starts at the first pass of a repeated hour", () => {
            const { from } = parseDateRange("2024-11-03", "2024-11-03",
                { zone: zoneFor("America/Havana") });

            assert.equal(from.toISOString(), "2024-11-03T04:00:00.000Z");
        });

        it("takes the whole of a day the clocks change on", () => {
            const { from, to } = parseDateRange("2026-03-29", "2026-03-29",
                { zone: zoneFor("Europe/Berlin") });

            // 23 hours, because that day is 23 hours long where it happened.
            assert.equal(from.toISOString(), "2026-03-28T23:00:00.000Z");
            assert.equal(to.toISOString(), "2026-03-29T21:59:59.999Z");
        });

        it("prefers the zone over an offset supplied beside it", () => {
            const { from } = parseDateRange("2026-08-07", "2026-08-07",
                { zone: zoneFor("Europe/Berlin"), offsetMinutes: 0 });

            assert.equal(from.toISOString(), "2026-08-06T22:00:00.000Z");
        });

        /**
         * Anchoring each bound at its own offset means the span between them is
         * no longer a whole number of days: a window whose ends sit at different
         * offsets measures an hour more or less.
         *
         * The ceiling was compared in milliseconds, so that hour pushed the
         * client's all-time stand-in window - which is deliberately exactly
         * MAX_RANGE_DAYS calendar days wide - over the limit. Every all-time
         * export was refused with "The range must not span more than 10000
         * days" for roughly a third of the year, in any zone whose offset has
         * changed at any point in the window.
         *
         * Counted in calendar days now, which is what the limit was always
         * about and what no offset can move.
         */
        describe("the span limit", () => {
            const berlin = () => ({ zone: zoneFor("Europe/Berlin") });

            // Exactly what resolveAllTime() builds: 10000 days counting both ends.
            it("accepts a window of exactly the maximum span", () => {
                assert.equal(parseDateRange("1998-08-17", "2026-01-01", berlin()).valid, true);
                assert.equal(parseDateRange("1998-10-12", "2026-02-26", berlin()).valid, true);
            });

            it("still refuses one day more", () => {
                const result = parseDateRange("1998-08-16", "2026-01-01", berlin());

                assert.equal(result.valid, false);
                assert.match(result.message, /10000 days/);
            });

            it("measures it the same however the offsets fall", () => {
                for (const tz of ["Europe/Berlin", "America/New_York", "America/Sao_Paulo", "Asia/Tokyo"])
                    assert.equal(parseDateRange("1998-08-17", "2026-01-01", { zone: zoneFor(tz) }).valid, true, tz);
            });
        });

        /**
         * The same arithmetic, the other way round: the statistics echo the
         * window's length so the client can divide by it, and that was computed
         * by taking the ceiling of the span in milliseconds. A range crossing a
         * fall-back measures N days plus 59:59.999 and ceiled to N+1, so a
         * "Last 7 days" selection reported its density over eight.
         */
        describe("the day count it carries", () => {
            const daysFor = (from, to, tz = "Europe/Berlin") =>
                parseDateRange(from, to, { zone: zoneFor(tz) }).days;

            it("counts both of its own days", () => {
                assert.equal(daysFor("2026-08-01", "2026-08-07"), 7);
                assert.equal(daysFor("2026-08-07", "2026-08-07"), 1);
            });

            it("is unmoved by a fall-back inside the range", () => {
                assert.equal(daysFor("2026-10-19", "2026-10-25"), 7);
                assert.equal(daysFor("2026-10-25", "2026-10-25"), 1);
                assert.equal(daysFor("2026-10-01", "2026-10-30"), 30);
            });

            it("is unmoved by a spring-forward inside the range", () => {
                assert.equal(daysFor("2026-03-23", "2026-03-29"), 7);
                assert.equal(daysFor("2026-03-29", "2026-03-29"), 1);
            });

            it("counts a whole year as its calendar days", () => {
                assert.equal(daysFor("2025-11-01", "2026-10-31"), 365);
            });
        });
    });
});
