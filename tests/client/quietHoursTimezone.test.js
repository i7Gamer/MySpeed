import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../helpers/source.js";
import { isQuietHour as clientIsQuietHour, firstRunOutsideWindow }
    from "@/common/components/PauseDialog/quietHoursWindow.js";
import { isQuietHour as serverIsQuietHour } from "../../server/util/quietHours.js";
import { zoneFromName } from "../../server/util/timezone.js";

/**
 * The client's copy of the window, now that the server judges it in a configured
 * zone.
 *
 * The copy exists so the dialogs can say what the scheduler is going to do
 * without asking it, and it only works while the two agree. The server reads
 * the `timezone` setting (upstream #1115, #748); a client still reading the
 * browser's clock would preview a different next run from the one the countdown
 * beside it reports - which is the disagreement commit 7f684733 fixed once
 * already, arriving by a new route.
 */

const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const MIN_SEPARATION_HOURS = 3;

const CANDIDATE_ZONES = ["Etc/GMT+12", "Etc/GMT+8", "Etc/GMT+4", "Etc/GMT-4", "Etc/GMT-8", "Etc/GMT-12"];

const partsIn = (zone, instant) => {
    const [hour, minute] = new Intl.DateTimeFormat("en-US",
        {timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23"})
        .format(instant).split(":").map(Number);

    return hour * MINUTES_PER_HOUR + minute;
};

const hoursApart = (a, b) => Math.min((a - b + HOURS_PER_DAY) % HOURS_PER_DAY, (b - a + HOURS_PER_DAY) % HOURS_PER_DAY);

const foreignZone = (instant) => {
    const found = CANDIDATE_ZONES.find((zone) =>
        hoursApart(Math.floor(partsIn(zone, instant) / MINUTES_PER_HOUR), instant.getHours())
            >= MIN_SEPARATION_HOURS);

    assert.ok(found, "no candidate zone is far enough from this host's clock");

    return found;
};

const clock = (minutes) => {
    const day = HOURS_PER_DAY * MINUTES_PER_HOUR;
    const wrapped = ((minutes % day) + day) % day;

    return `${String(Math.floor(wrapped / MINUTES_PER_HOUR)).padStart(2, "0")}`
        + `:${String(wrapped % MINUTES_PER_HOUR).padStart(2, "0")}`;
};

const windowAround = (minutes) => ({start: clock(minutes - MINUTES_PER_HOUR), end: clock(minutes + MINUTES_PER_HOUR)});

describe("the client's quiet window with a timezone", () => {
    const instant = new Date();

    it("reads the window on the named zone's clock", () => {
        const zone = foreignZone(instant);
        const {start, end} = windowAround(partsIn(zone, instant));

        assert.equal(clientIsQuietHour(instant, start, end, zone), true,
            `${start}-${end} is now in ${zone} and the dialog did not read it as quiet`);
        assert.equal(clientIsQuietHour(instant, start, end), false,
            "the browser clock happened to agree, so this proves nothing");
    });

    it("reads the browser clock when no zone is given", () => {
        const {start, end} = windowAround(instant.getHours() * MINUTES_PER_HOUR + instant.getMinutes());

        assert.equal(clientIsQuietHour(instant, start, end), true);
    });

    /**
     * The stored sentinel reaches this straight from the configuration, so it
     * has to mean the browser clock and not a zone named "none".
     */
    it("treats the off sentinel as the browser clock", () => {
        const {start, end} = windowAround(instant.getHours() * MINUTES_PER_HOUR + instant.getMinutes());

        assert.equal(clientIsQuietHour(instant, start, end, "none"), true);
    });

    /**
     * The config is fetched, so this can be anything the server sent - or
     * withheld, which /api/config does for exactly this key. A dialog must not
     * throw over it.
     */
    it("falls back to the browser clock for a zone it cannot use", () => {
        const {start, end} = windowAround(instant.getHours() * MINUTES_PER_HOUR + instant.getMinutes());

        for (const bad of ["Mars/Olympus_Mons", "", undefined, null, 5, {}])
            assert.equal(clientIsQuietHour(instant, start, end, bad), true, `threw or missed on ${bad}`);
    });
});

/**
 * The two halves held against each other, in the zone as well as out of it. The
 * existing parity test compares the sources; this one runs both.
 */
describe("client and server agreeing", () => {
    const instant = new Date();

    it("answers the same in a named zone", () => {
        const zoneName = foreignZone(instant);
        const {start, end} = windowAround(partsIn(zoneName, instant));

        assert.equal(clientIsQuietHour(instant, start, end, zoneName),
            serverIsQuietHour(instant, start, end, zoneFromName(zoneName)),
            "the dialog and the scheduler disagree about the same window in the same zone");
    });

    it("answers the same across the whole day in a named zone", () => {
        const zoneName = "Etc/GMT+8";
        const zone = zoneFromName(zoneName);

        // Every half hour, against a window that wraps midnight - the case a
        // naive comparison gets wrong, and the one operators actually set.
        for (let minutes = 0; minutes < HOURS_PER_DAY * MINUTES_PER_HOUR; minutes += 30) {
            const moment = new Date(Date.UTC(2026, 7, 10, 0, minutes));

            assert.equal(clientIsQuietHour(moment, "23:00", "07:00", zoneName),
                serverIsQuietHour(moment, "23:00", "07:00", zone),
                `they disagree at ${moment.toISOString()}`);
        }
    });
});

describe("stepping over occurrences inside the window", () => {
    it("judges them in the given zone", () => {
        const zoneName = "Etc/GMT+8";
        // 00:00 and 12:00 UTC are 16:00 and 04:00 in Etc/GMT+8, so a window of
        // 23:00-07:00 there covers the second and not the first.
        const occurrences = [new Date("2026-08-10T00:00:00.000Z"), new Date("2026-08-10T12:00:00.000Z")];
        let index = 0;

        const first = firstRunOutsideWindow(() => occurrences[index++], "23:00", "07:00", zoneName);

        assert.equal(first.toISOString(), "2026-08-10T00:00:00.000Z",
            "the first occurrence was skipped, so the window is not being read in the zone");
    });

    it("skips the one the zone puts inside the window", () => {
        const zoneName = "Etc/GMT+8";
        const occurrences = [new Date("2026-08-10T12:00:00.000Z"), new Date("2026-08-10T00:00:00.000Z")];
        let index = 0;

        const first = firstRunOutsideWindow(() => occurrences[index++], "23:00", "07:00", zoneName);

        assert.equal(first.toISOString(), "2026-08-10T00:00:00.000Z",
            "an occurrence inside the window on the zone's clock was announced anyway");
    });
});

/**
 * The dialog that draws the preview has to hand the zone over, or none of the
 * above is reached. Read rather than run: it is JSX.
 */
describe("the frequency dialog", () => {
    const source = readSource("client/src/common/components/FrequencyDialog/FrequencyDialog.jsx");

    it("passes the configured zone into the walk", () => {
        assert.match(source, /config\.timezone/,
            "the preview still walks the schedule on the browser clock");
    });

    it("parses the cron in that zone too", () => {
        // Stepping over the right occurrences is no help if the occurrences
        // themselves came from a cron read on the wrong clock.
        assert.match(source, /CronExpressionParser\.parse\(\s*cron\s*,[\s\S]{0,160}?tz:/,
            "the occurrences are generated on the browser clock and only filtered in the zone");
    });
});
