import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bodyIn, readSource } from "../helpers/source.js";
import { serverZone, zoneFromName, localWallClock } from "../../server/util/timezone.js";
import { isQuietHour, minutesIntoDay } from "../../server/util/quietHours.js";
import { nextRun } from "../../server/tasks/timer.js";
import { validateInput } from "../../server/controller/config.js";

/**
 * The schedule ran on whatever clock the host happened to keep.
 *
 * Upstream #1115 asks for a timezone; #748 is the same complaint arriving from
 * the other side. The Docker image pins TZ=Etc/UTC, so an operator who types
 * "no tests between 23:00 and 07:00" into the pause dialog was describing their
 * own evening and silencing somebody else's - off by however far they live from
 * UTC. The cron had the same fault: "0 3 * * *" meant three in the morning in
 * the container, which is the middle of the afternoon for a third of the world.
 *
 * quietHours.js used to say this was deliberate, and it was right about the
 * reason - "a window read in one timezone and fired in another would silence
 * the wrong hours, and there is no viewer to ask". The answer is not to ask a
 * viewer. It is to let the operator state the zone once.
 */

/**
 * Fixed-offset IANA zones, so nothing here depends on the date or on a daylight
 * saving transition. Spread widely enough that at least one is a long way from
 * whatever clock the test host keeps.
 */
const CANDIDATE_ZONES = ["Etc/GMT+12", "Etc/GMT+8", "Etc/GMT+4", "Etc/GMT-4", "Etc/GMT-8", "Etc/GMT-12"];

const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const MIN_SEPARATION_HOURS = 3;

const hourIn = (zone, instant) =>
    Number(new Intl.DateTimeFormat("en-US", {timeZone: zone, hour: "2-digit", hourCycle: "h23"}).format(instant));

/** How far apart two hours of the day are, the short way round the clock. */
const hoursApart = (a, b) => Math.min((a - b + HOURS_PER_DAY) % HOURS_PER_DAY, (b - a + HOURS_PER_DAY) % HOURS_PER_DAY);

/**
 * A zone whose wall clock is a long way from this host's, so a window built
 * around one reads as outside the other. Chosen at runtime because the test host
 * can be in any zone at all - CI is UTC and a developer's laptop is not.
 */
const foreignZoneName = (instant) => {
    const here = instant.getHours();
    const found = CANDIDATE_ZONES.find((zone) => hoursApart(hourIn(zone, instant), here) >= MIN_SEPARATION_HOURS);

    assert.ok(found, "no candidate zone is far enough from this host's clock");

    return found;
};

const clock = (minutesIntoTheDay) => {
    const wrapped = ((minutesIntoTheDay % (HOURS_PER_DAY * MINUTES_PER_HOUR)) + HOURS_PER_DAY * MINUTES_PER_HOUR)
        % (HOURS_PER_DAY * MINUTES_PER_HOUR);

    return `${String(Math.floor(wrapped / MINUTES_PER_HOUR)).padStart(2, "0")}`
        + `:${String(wrapped % MINUTES_PER_HOUR).padStart(2, "0")}`;
};

/** A window an hour either side of what `zone`'s clock reads at `instant`. */
const windowAround = (zone, instant) => {
    const now = minutesIntoDay(instant, zone);

    return {start: clock(now - MINUTES_PER_HOUR), end: clock(now + MINUTES_PER_HOUR)};
};

describe("zoneFromName", () => {
    const instant = new Date("2026-08-10T12:00:00.000Z");

    it("resolves an IANA name to that zone's own offset", () => {
        assert.equal(zoneFromName("Etc/GMT+8").offsetAt(instant), 8 * MINUTES_PER_HOUR);
    });

    /**
     * "none" is the sentinel every other optional setting uses, and it has to
     * mean the host clock rather than an error: an instance that has never set a
     * timezone must behave exactly as it did before the setting existed.
     */
    it("falls back to the host clock for the off sentinel", () => {
        assert.equal(zoneFromName("none").offsetAt(instant), serverZone.offsetAt(instant));
    });

    /**
     * A stored value can be wrong - written by hand, or left behind by a zone
     * the platform's database has since dropped - and this is read from inside
     * the scheduler. Throwing there would stop every test from running, which
     * is far worse than judging the window on the host clock.
     */
    it("falls back to the host clock for anything unusable", () => {
        for (const bad of ["Mars/Olympus_Mons", "", "  ", null, undefined, 42, {}])
            assert.equal(zoneFromName(bad).offsetAt(instant), serverZone.offsetAt(instant), `accepted ${bad}`);
    });
});

describe("the wall clock in a zone", () => {
    it("reads the hour that zone's clock reads", () => {
        const instant = new Date("2026-08-10T12:00:00.000Z");

        assert.equal(localWallClock(zoneFromName("Etc/GMT+8"), instant).getUTCHours(), 4);
        assert.equal(localWallClock(zoneFromName("Etc/GMT-4"), instant).getUTCHours(), 16);
    });

    it("counts minutes into the day on that clock", () => {
        const instant = new Date("2026-08-10T12:30:00.000Z");

        assert.equal(minutesIntoDay(instant, zoneFromName("Etc/GMT+8")), 4 * MINUTES_PER_HOUR + 30);
    });

    // Every existing caller passes no zone, and must keep getting the host clock.
    it("defaults to the host clock when no zone is given", () => {
        const instant = new Date("2026-08-10T12:30:00.000Z");

        assert.equal(minutesIntoDay(instant), instant.getHours() * MINUTES_PER_HOUR + instant.getMinutes());
    });
});

describe("the quiet window in a configured zone", () => {
    const instant = new Date();

    it("is judged on that zone's clock rather than the host's", () => {
        const zoneName = foreignZoneName(instant);
        const zone = zoneFromName(zoneName);
        const {start, end} = windowAround(zone, instant);

        assert.equal(isQuietHour(instant, start, end, zone), true,
            `${start}-${end} is now in ${zoneName} and was not read as quiet`);
        assert.equal(isQuietHour(instant, start, end, serverZone), false,
            "the host clock happened to agree, so this proves nothing");
    });

    it("still reads the host clock when no zone is configured", () => {
        const {start, end} = windowAround(serverZone, instant);

        assert.equal(isQuietHour(instant, start, end), true);
    });

    // The sentinel has to reach isQuietHour meaning "the host clock", not
    // meaning "some zone three hours away".
    it("treats the off sentinel as the host clock", () => {
        const {start, end} = windowAround(serverZone, instant);

        assert.equal(isQuietHour(instant, start, end, zoneFromName("none")), true);
    });
});

describe("the next scheduled run", () => {
    /**
     * The countdown on the status endpoint is computed here, so a cron read in
     * the wrong zone is not only fired at the wrong time - it is also *announced*
     * at the wrong time, and the two would disagree.
     */
    it("resolves a daily cron at that hour in the configured zone", () => {
        const zoneName = "Etc/GMT+8";
        const answered = nextRun("0 9 * * *", null, zoneName);

        assert.ok(answered, "no next run was answered at all");
        assert.equal(hourIn(zoneName, new Date(answered)), 9);
    });

    it("resolves it on the host clock when no zone is configured", () => {
        const answered = nextRun("0 9 * * *");

        assert.ok(answered);
        assert.equal(new Date(answered).getHours(), 9);
    });

    // An unusable stored zone must not take the countdown away.
    it("still answers when the stored zone is unusable", () => {
        assert.ok(nextRun("0 9 * * *", null, "Mars/Olympus_Mons"));
    });
});

describe("the stored setting", () => {
    it("accepts an IANA zone", async () => {
        assert.deepEqual(await validateInput("timezone", "Europe/Berlin"), {value: "Europe/Berlin"});
    });

    it("accepts the off sentinel", async () => {
        assert.deepEqual(await validateInput("timezone", "none"), {value: "none"});
    });

    /**
     * Refused rather than quietly ignored. The scheduler falls back to the host
     * clock for an unusable value, which is the right behaviour for a row that
     * is already stored - but accepting one at the door would report a saved
     * timezone that never applies, which is the fault the optimal values had in
     * 1.3.5.
     */
    it("refuses anything that is not a zone", async () => {
        for (const bad of ["Mars/Olympus_Mons", "UTC+2", "Berlin", "", "  "])
            assert.equal(typeof await validateInput("timezone", bad), "string", `accepted ${JSON.stringify(bad)}`);
    });

    it("refuses a value that is not a string", async () => {
        for (const bad of [{}, [], 5, true])
            assert.equal(typeof await validateInput("timezone", bad), "string", `accepted ${JSON.stringify(bad)}`);
    });
});

/**
 * The wiring, read rather than run: firing it needs a live schedule and a clock
 * to move, and what is being asserted is that the zone reaches the scheduler at
 * all.
 */
describe("the wiring", () => {
    it("hands the zone to node-schedule rather than only to the window", () => {
        assert.match(bodyIn("server/tasks/timer.js", "export const startTimer"), /tz:/,
            "the quiet hours honour the zone but the cron still fires on the host clock");
    });

    it("restarts the schedule when the timezone is changed", () => {
        const patch = bodyIn("server/routes/config.js", 'app.patch("/:key"');

        assert.match(patch, /timezone/,
            "changing the timezone leaves the running schedule on the old one until a restart");
    });

    it("reports the countdown in the configured zone", () => {
        assert.match(readSource("server/routes/speedtests.js"), /getValue\("timezone"\)/,
            "the schedule fires in the configured zone and the countdown names the host clock");
    });
});
