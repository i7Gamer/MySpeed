import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDateRange } from "../../server/util/dateRange.js";

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
});
