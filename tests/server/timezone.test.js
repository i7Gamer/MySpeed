import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    isKnownTimeZone, localHourAt, MAX_OFFSET_MINUTES, resolveTimezone, utcFromLocal
} from "../../server/util/timezone.js";

const zoneOf = (query) => {
    const resolved = resolveTimezone(query);
    assert.equal(resolved.valid, true, `rejected: ${resolved.message}`);
    return resolved.zone;
};

const BERLIN = "Europe/Berlin";

// Berlin is UTC+1 in winter and UTC+2 in summer. getTimezoneOffset counts
// minutes *behind* UTC, so those are -60 and -120.
const WINTER = new Date("2026-01-15T12:00:00.000Z");
const SUMMER = new Date("2026-08-10T12:00:00.000Z");

/**
 * The offset a client sends is a snapshot of *today*, and applying it to a
 * whole range is wrong for every instant on the other side of a daylight
 * saving change inside that range. Both ends of the request suffer: the range
 * bounds are anchored an hour off, silently dropping or adding an hour of
 * tests, and hour-of-day bucketing credits a test to the wrong hour - enough
 * for the overview to name the wrong hour as the slowest.
 *
 * The named zone is resolved per instant, so both follow the transition.
 */
describe("a named zone", () => {
    it("follows the zone's own daylight saving changes", () => {
        const zone = zoneOf({tz: BERLIN});

        assert.equal(zone.offsetAt(WINTER), -60);
        assert.equal(zone.offsetAt(SUMMER), -120);
    });

    it("reports a zone that never shifts as one offset all year", () => {
        const zone = zoneOf({tz: "Asia/Tokyo"});

        assert.equal(zone.offsetAt(WINTER), -540);
        assert.equal(zone.offsetAt(SUMMER), -540);
    });

    it("handles a half-hour zone", () => {
        assert.equal(zoneOf({tz: "Asia/Kolkata"}).offsetAt(WINTER), -330);
    });

    it("handles a zone behind UTC", () => {
        assert.equal(zoneOf({tz: "America/New_York"}).offsetAt(WINTER), 300);
        assert.equal(zoneOf({tz: "America/New_York"}).offsetAt(SUMMER), 240);
    });
});

describe("isKnownTimeZone", () => {
    it("accepts real IANA names", () => {
        for (const name of [BERLIN, "UTC", "America/New_York", "Australia/Eucla"])
            assert.equal(isKnownTimeZone(name), true, `${name} was rejected`);
    });

    it("refuses anything else", () => {
        for (const name of ["Middle/Earth", "", "  ", null, undefined, 42, "Europe/Berlin; DROP TABLE"])
            assert.equal(isKnownTimeZone(name), false, `${JSON.stringify(name)} was accepted`);
    });
});

describe("utcFromLocal", () => {
    const berlin = () => zoneOf({tz: BERLIN});

    it("resolves a summer midnight at the summer offset", () => {
        const instant = utcFromLocal(berlin(), {year: 2025, month: 10, day: 17});

        assert.equal(instant.toISOString(), "2025-10-16T22:00:00.000Z");
    });

    it("resolves a winter midnight at the winter offset", () => {
        const instant = utcFromLocal(berlin(), {year: 2026, month: 1, day: 15});

        assert.equal(instant.toISOString(), "2026-01-14T23:00:00.000Z");
    });

    // The guess that starts the resolution reads the wall clock as if it were
    // UTC, which lands on the other side of the shift for a midnight within a
    // couple of hours of it. One correction pass is what fixes that.
    it("resolves the midnight of the day the clocks go forward", () => {
        const instant = utcFromLocal(berlin(), {year: 2026, month: 3, day: 29});

        assert.equal(instant.toISOString(), "2026-03-28T23:00:00.000Z");
    });

    it("resolves the midnight of the day the clocks go back", () => {
        const instant = utcFromLocal(berlin(), {year: 2026, month: 10, day: 25});

        assert.equal(instant.toISOString(), "2026-10-24T22:00:00.000Z");
    });

    it("carries the end-of-day components", () => {
        const instant = utcFromLocal(berlin(),
            {year: 2026, month: 1, day: 15, hour: 23, minute: 59, second: 59, ms: 999});

        assert.equal(instant.toISOString(), "2026-01-15T22:59:59.999Z");
    });

    it("agrees with a fixed offset when one was supplied instead", () => {
        const instant = utcFromLocal(zoneOf({tzOffset: "-120"}), {year: 2026, month: 8, day: 7});

        assert.equal(instant.toISOString(), "2026-08-06T22:00:00.000Z");
    });
});

describe("localHourAt", () => {
    it("buckets an instant by the zone's wall clock", () => {
        const zone = zoneOf({tz: BERLIN});

        assert.equal(localHourAt(zone, new Date("2026-08-10T18:30:00.000Z")), 20);
        assert.equal(localHourAt(zone, new Date("2026-01-10T18:30:00.000Z")), 19);
    });

    // The whole point: one snapshot offset puts both of these in the same
    // bucket, so a slowdown at 20:00 in summer is reported at 19:00.
    it("does not put a summer and a winter instant in the same bucket", () => {
        const zone = zoneOf({tz: BERLIN});
        const fixed = zoneOf({tzOffset: "-60"});

        assert.notEqual(
            localHourAt(zone, new Date("2026-08-10T18:30:00.000Z")),
            localHourAt(zone, new Date("2026-01-10T18:30:00.000Z")));

        assert.equal(
            localHourAt(fixed, new Date("2026-08-10T18:30:00.000Z")),
            localHourAt(fixed, new Date("2026-01-10T18:30:00.000Z")));
    });

    it("wraps at midnight rather than reporting hour 24", () => {
        assert.equal(localHourAt(zoneOf({tz: BERLIN}), new Date("2026-01-14T23:30:00.000Z")), 0);
    });
});

describe("resolveTimezone", () => {
    it("prefers the named zone when both are sent", () => {
        // Both travel together, because a parent proxies these requests to
        // nodes that may only understand the offset.
        assert.equal(resolveTimezone({tz: BERLIN, tzOffset: "0"}).zone.offsetAt(SUMMER), -120);
    });

    it("refuses a name it does not know", () => {
        const resolved = resolveTimezone({tz: "Middle/Earth"});

        assert.equal(resolved.valid, false);
        assert.match(resolved.message, /tz/);
    });

    it("falls back to the offset when no name was sent", () => {
        assert.equal(resolveTimezone({tzOffset: "-120"}).zone.offsetAt(SUMMER), -120);
    });

    it("refuses an offset no place on earth has", () => {
        for (const tzOffset of [String(MAX_OFFSET_MINUTES + 1), "-5000", "99999999999999"]) {
            const resolved = resolveTimezone({tzOffset});

            assert.equal(resolved.valid, false, `${tzOffset} was accepted`);
            assert.match(resolved.message, /tzOffset/);
        }
    });

    // Long-standing behaviour, kept deliberately: a value that is not a number
    // is not a claim about a timezone, so the server answers on its own clock
    // rather than refusing the request.
    it("answers on the server's own clock for a non-numeric offset", () => {
        for (const tzOffset of ["abc", "1e400"]) {
            const resolved = resolveTimezone({tzOffset});

            assert.equal(resolved.valid, true, `${tzOffset} was refused`);
            assert.equal(resolved.zone.offsetAt(SUMMER), SUMMER.getTimezoneOffset());
        }
    });

    it("answers on the server's own clock when nothing was sent", () => {
        assert.equal(resolveTimezone({}).zone.offsetAt(WINTER), WINTER.getTimezoneOffset());
        assert.equal(resolveTimezone().zone.offsetAt(WINTER), WINTER.getTimezoneOffset());
    });
});
