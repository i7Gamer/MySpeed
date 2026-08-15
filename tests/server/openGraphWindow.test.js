import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDateRange } from "../../server/util/dateRange.js";
import { openGraphWindow } from "../../server/controller/opengraph.js";

/**
 * The window the OpenGraph image averages over.
 *
 * Two calendar days, named on one clock and then anchored on another: the dates
 * were read off the UTC calendar with `toISOString().split('T')[0]` while
 * `yesterday` was stepped back with local-calendar arithmetic, and
 * parseDateRange - given no zone - resolves to the server's own. The two agree
 * only while the local date and the UTC date are the same, which east of UTC
 * they are not for the first hours of every local day.
 *
 * At 01:30 local in Berlin, 23:30Z the day before, the UTC date was still
 * yesterday's: the window was named for the two days ending yesterday and ran
 * out at local end-of-yesterday, an hour and a half before "now". Every test
 * from the current local day was excluded from the figures on the image.
 */
const at = (iso) => new Date(iso);

describe("openGraphWindow", () => {
    it("names two calendar days", () => {
        const {from, to} = openGraphWindow(at("2026-08-15T12:00:00.000Z"));

        assert.match(from, /^\d{4}-\d{2}-\d{2}$/);
        assert.match(to, /^\d{4}-\d{2}-\d{2}$/);
        assert.ok(from < to, "the window runs backwards");
    });

    it("ends today, not yesterday", () => {
        const now = at("2026-08-15T12:00:00.000Z");
        const {to} = openGraphWindow(now);

        // Whatever zone this runs in, the end of the window is the date `now`
        // falls on locally - the same reading parseDateRange will anchor.
        const localToday = new Intl.DateTimeFormat("en-CA", {
            year: "numeric", month: "2-digit", day: "2-digit"
        }).format(now);

        assert.equal(to, localToday);
    });

    /**
     * The window has to contain the moment it was built for. This is the whole
     * of the fault: with the two clocks mixed, "now" fell outside a window that
     * had already ended.
     */
    it("contains the moment it was built for", () => {
        for (const iso of [
            "2026-08-15T00:30:00.000Z", "2026-08-15T12:00:00.000Z", "2026-08-15T23:30:00.000Z",
            // The hours that broke it: local-early, UTC-still-yesterday east of
            // UTC, and local-late, UTC-already-tomorrow west of it.
            "2026-01-15T23:15:00.000Z", "2026-01-15T00:45:00.000Z"
        ]) {
            const now = at(iso);
            const {from, to} = openGraphWindow(now);
            const range = parseDateRange(from, to);

            assert.equal(range.valid, true, `${iso} produced an unusable range: ${range.message}`);
            assert.ok(range.from <= now, `${iso}: the window starts after the moment it describes`);
            assert.ok(range.to >= now,
                `${iso}: the window ended at ${range.to.toISOString()}, before the moment it describes`);
        }
    });

    // Two days rather than one, so an instance that has tested only since
    // midnight still has something to average.
    it("reaches back a day", () => {
        const now = at("2026-08-15T12:00:00.000Z");
        const range = parseDateRange(...Object.values(openGraphWindow(now)));

        const MS_PER_DAY = 86400000;
        assert.ok(range.to - range.from > MS_PER_DAY, "the window is shorter than the two days it names");
    });
});
