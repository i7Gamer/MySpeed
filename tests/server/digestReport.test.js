import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../helpers/source.js";
import { digestRanges, digestText } from "../../server/util/digestReport.js";
import { zoneFromName } from "../../server/util/timezone.js";

const BERLIN = zoneFromName("Europe/Berlin");

// A zone object rather than the host machine's own clock, so a test that
// wants "what a UTC caller sees" reads the same on every machine this suite
// runs on, wherever its own TZ happens to be.
const UTC = zoneFromName("Etc/UTC");

const iso = (date) => date.toISOString();

/**
 * The windows a digest answers for, computed on the config zone's own
 * calendar. Weekly is the seven whole days ending yesterday and leans on
 * comparePrevious - previousRange walks back an equal-length span, which for
 * seven days IS the previous week. Monthly deliberately does not: an
 * equal-length span before March 1st is Jan 29 - Feb 28, so the monthly kind
 * carries its own explicit compare month instead.
 */
describe("digestRanges", () => {
    describe("weekly", () => {
        it("covers the seven whole days ending yesterday, comparing by previous", () => {
            // Monday 08:00 Berlin summer time = 06:00Z.
            const {range, compare, comparePrevious} = digestRanges("weekly",
                new Date("2026-08-31T06:00:00.000Z"), BERLIN);

            assert.equal(comparePrevious, true);
            assert.equal(compare, null);
            assert.equal(range.days, 7);
            assert.equal(iso(range.from), "2026-08-23T22:00:00.000Z", "Aug 24 00:00 Berlin");
            assert.equal(iso(range.to), "2026-08-30T21:59:59.999Z", "Aug 30 end-of-day Berlin");
        });

        it("crosses a month boundary on the calendar, not by arithmetic on days", () => {
            const {range} = digestRanges("weekly", new Date("2026-09-02T06:00:00.000Z"), BERLIN);

            assert.equal(iso(range.from), "2026-08-25T22:00:00.000Z", "Aug 26 00:00 Berlin");
            assert.equal(iso(range.to), "2026-09-01T21:59:59.999Z");
        });

        it("crosses the year boundary", () => {
            const {range} = digestRanges("weekly", new Date("2027-01-04T07:00:00.000Z"), BERLIN);

            assert.equal(iso(range.from), "2026-12-27T23:00:00.000Z", "Dec 28 00:00 Berlin winter time");
            assert.equal(iso(range.to), "2027-01-03T22:59:59.999Z");
        });

        it("keeps seven calendar days through the spring-forward week", () => {
            // Fires Monday after the last-Sunday-of-March transition.
            const {range} = digestRanges("weekly", new Date("2026-03-30T06:00:00.000Z"), BERLIN);

            assert.equal(range.days, 7, "the 167-hour week stopped counting as seven days");
            assert.equal(iso(range.from), "2026-03-22T23:00:00.000Z", "Mar 23 00:00, still winter time");
            assert.equal(iso(range.to), "2026-03-29T21:59:59.999Z", "Mar 29 end-of-day, summer time");
        });
    });

    describe("monthly", () => {
        it("covers the previous calendar month against the one before it", () => {
            const {range, compare, comparePrevious} = digestRanges("monthly",
                new Date("2026-03-01T07:00:00.000Z"), BERLIN);

            assert.equal(comparePrevious, false);
            assert.equal(iso(range.from), "2026-01-31T23:00:00.000Z", "Feb 1 00:00 Berlin");
            assert.equal(iso(range.to), "2026-02-28T22:59:59.999Z", "Feb 28 end-of-day");
            assert.equal(iso(compare.from), "2025-12-31T23:00:00.000Z", "Jan 1 00:00");
            assert.equal(iso(compare.to), "2026-01-31T22:59:59.999Z", "Jan 31 end-of-day");
        });

        it("pairs unequal months whole - March against February, never Jan 29 onward", () => {
            const {range, compare} = digestRanges("monthly", new Date("2026-04-01T06:00:00.000Z"), BERLIN);

            assert.equal(range.days, 31, "March lost days");
            assert.equal(compare.days, 28, "February gained days");
            assert.equal(iso(compare.from), "2026-01-31T23:00:00.000Z", "Feb 1 00:00");
        });

        it("crosses the year boundary to December against November", () => {
            const {range, compare} = digestRanges("monthly", new Date("2027-01-01T07:00:00.000Z"), BERLIN);

            assert.equal(iso(range.from), "2026-11-30T23:00:00.000Z", "Dec 1 00:00");
            assert.equal(iso(compare.from), "2026-10-31T23:00:00.000Z", "Nov 1 00:00");
        });
    });
});

/**
 * The words a digest says, fixed English on purpose - the server has no
 * locale machinery, and every notifier ships the same text. Each line
 * renders only when its figures read; the length stays far under the
 * tightest sink cap (pushover's 1024) even fully loaded.
 */
describe("digestText", () => {
    const RANGE_LABEL = "2026-08-24 – 2026-08-30";

    const summary = (over = {}) => ({
        tests: {total: 512, failed: 3},
        download: {avg: 230.14},
        upload: {avg: 42.31},
        ping: {avg: 8.43},
        dataUsed: {download: 160010429622, upload: 75712241529, total: 235722671151},
        reliability: {
            longestFailureStreak: {count: 3, from: "2026-08-26T14:02:00.000Z", to: "2026-08-26T15:40:00.000Z"},
            lastFailureAt: "2026-08-26T15:40:00.000Z",
            largestGap: {seconds: 3600, from: "x", to: "y"}
        },
        ...over
    });

    it("says the whole story when everything measured", () => {
        const text = digestText(summary(), summary({tests: {total: 500, failed: 8},
            download: {avg: 233.4}, upload: {avg: 42.1}, ping: {avg: 8.02}}), "weekly", RANGE_LABEL, UTC);

        assert.match(text, /^MySpeed weekly digest \(2026-08-24 – 2026-08-30\)/);
        assert.match(text, /512 tests, 3 failed \(0\.6%\)/);
        assert.match(text, /230\.14 down \/ 42\.31 up Mbit\/s, ping 8\.43 ms/);
        assert.match(text, /Data used: 235\.7 GB/);
        assert.match(text, /vs previous week: tests \+2\.4%, download -1\.4%, upload \+0\.5%, ping \+5\.1%/);
        assert.match(text, /Longest failure streak: 3 \(2026-08-26 14:02 – 15:40\)/);
    });

    // Settles TECH_DEBT #8: streakSpan used to slice the raw ISO strings and
    // always append " UTC", regardless of the window it sat under - a streak
    // could print a calendar date the label above it never claimed. Berlin is
    // two hours ahead of the stored UTC instants, so a failure at 22:05-22:20Z
    // on the 23rd reads as the small hours of the 24th on the zone's own
    // calendar, the same calendar digestRanges already built the label from.
    it("dates a failure streak on the zone's own calendar, not UTC's", () => {
        const text = digestText(summary({reliability: {
            longestFailureStreak: {
                count: 2, from: "2026-08-23T22:05:00.000Z", to: "2026-08-23T22:20:00.000Z"
            },
            lastFailureAt: "2026-08-23T22:20:00.000Z",
            largestGap: null
        }}), null, "weekly", RANGE_LABEL, BERLIN);

        assert.match(text, /Longest failure streak: 2 \(2026-08-24 00:05 – 00:20\)/);
    });

    // The fifth parameter defaults to serverZone rather than requiring every
    // caller to pass one. Pinned on the signature rather than on the output:
    // on a machine whose clock is UTC, a default of UTC and a default of
    // serverZone print the same streak, so comparing the two calls proved
    // nothing on the box most likely to run it - CI.
    it("defaults the streak's zone to serverZone", () => {
        assert.ok(readSource("server/util/digestReport.js")
            .includes("export const digestText = (summary, compare, kind, rangeLabel, zone = serverZone) =>"));
    });

    it("skips the compare line without a comparable window", () => {
        for (const absent of [null, undefined, {tests: {total: 0, failed: 0}}])
            assert.doesNotMatch(digestText(summary(), absent, "weekly", RANGE_LABEL), /vs previous/,
                `a compare line rendered against ${JSON.stringify(absent?.tests)}`);
    });

    it("says a clean week has no failures rather than omitting the count", () => {
        const text = digestText(summary({tests: {total: 512, failed: 0},
            reliability: {longestFailureStreak: null, lastFailureAt: null, largestGap: null}}),
        null, "weekly", RANGE_LABEL);

        assert.match(text, /512 tests, 0 failed/);
        assert.doesNotMatch(text, /streak/i, "a streak line rendered with no streak to name");
    });

    it("says when nothing ran at all", () => {
        const text = digestText({tests: {total: 0, failed: 0}}, null, "weekly", RANGE_LABEL);

        assert.match(text, /No tests ran/);
        assert.doesNotMatch(text, /Mbit\/s/, "averages rendered over nothing");
    });

    it("skips what the range never measured, line by line", () => {
        const text = digestText(summary({dataUsed: {download: null, upload: null, total: null},
            ping: {avg: null}}), null, "weekly", RANGE_LABEL);

        assert.doesNotMatch(text, /Data used/);
        assert.doesNotMatch(text, /ping/, "an unmeasured ping printed");
        assert.match(text, /230\.14 down/);
    });

    it("names the monthly kind and its own compare wording", () => {
        const text = digestText(summary(), summary(), "monthly", "2026-07-01 – 2026-07-31");

        assert.match(text, /^MySpeed monthly digest/);
        assert.match(text, /vs previous month:/);
    });

    // The digest deliberately skips the largest gap: on an hourly schedule a
    // perfect week reports a one-hour gap, which is the cadence, not a hole.
    it("never quotes the largest gap", () => {
        assert.doesNotMatch(digestText(summary(), null, "weekly", RANGE_LABEL), /gap/i);
    });

    it("stays inside the tightest sink's cap and plain ASCII", () => {
        const text = digestText(summary(), summary(), "weekly", RANGE_LABEL);

        assert.ok(text.length < 900, `the fully loaded digest is ${text.length} chars`);
        // The en dash in the range label is the one deliberate non-ASCII
        // character; ntfy's header filter never sees the body, and every
        // other sink takes UTF-8 bodies.
        assert.doesNotMatch(text.replaceAll("–", "-"), /[^\x20-\x7E\n]/,
            "a character outside plain ASCII slipped into the digest body");
    });
});
