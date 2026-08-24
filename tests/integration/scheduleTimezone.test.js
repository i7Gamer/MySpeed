import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bootServer, setConfig } from "./helpers/boot.js";

/**
 * The configured timezone, checked where it has to be checked: inside runTask.
 *
 * The unit tests hold the primitives - zoneFromName, minutesIntoDay, isQuietHour
 * with a zone - and every one of them would still pass if the scheduler never
 * passed a zone in, which is the whole fix. Upstream #1115 and #748: the Docker
 * image pins TZ=Etc/UTC, so a window typed as "no tests between 23:00 and 07:00"
 * silenced whichever hours UTC happened to call that.
 *
 * The observable is the speedtests table, the way timerOffsetRun.test.js uses
 * it: the provider is one whose CLI is never reached, so an attempt fails in
 * milliseconds and records one row. A run that goes ahead adds a row and a run
 * that is skipped does not.
 */
let server;
let timer;

const PROVIDER = "cloudflare";
const DISTANT_CRON = "0 3 1 1 *";

const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const MIN_SEPARATION_HOURS = 3;

/**
 * Fixed-offset IANA zones, so nothing here turns on the date or on a daylight
 * saving transition, and spread widely enough that one of them is always a long
 * way from whatever clock the test host keeps - CI is UTC and a laptop is not.
 */
const CANDIDATE_ZONES = ["Etc/GMT+12", "Etc/GMT+8", "Etc/GMT+4", "Etc/GMT-4", "Etc/GMT-8", "Etc/GMT-12"];

before(async () => {
    server = await bootServer();
    timer = await import("../../server/tasks/timer.js");
});

after(async () => {
    timer.stopTimer();
    await server?.close();
});

const countTests = () => server.tests.count();

const partsIn = (zone, instant) => {
    const [hour, minute] = new Intl.DateTimeFormat("en-US",
        {timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23"})
        .format(instant).split(":").map(Number);

    return hour * MINUTES_PER_HOUR + minute;
};

const hoursApart = (a, b) => Math.min((a - b + HOURS_PER_DAY) % HOURS_PER_DAY, (b - a + HOURS_PER_DAY) % HOURS_PER_DAY);

const foreignZone = (instant) => {
    const here = instant.getHours();
    const found = CANDIDATE_ZONES.find((zone) =>
        hoursApart(Math.floor(partsIn(zone, instant) / MINUTES_PER_HOUR), here) >= MIN_SEPARATION_HOURS);

    assert.ok(found, "no candidate zone is far enough from this host's clock");

    return found;
};

const clock = (minutes) => {
    const day = HOURS_PER_DAY * MINUTES_PER_HOUR;
    const wrapped = ((minutes % day) + day) % day;

    return `${String(Math.floor(wrapped / MINUTES_PER_HOUR)).padStart(2, "0")}`
        + `:${String(wrapped % MINUTES_PER_HOUR).padStart(2, "0")}`;
};

const setWindow = async (start, end) => {
    await setConfig(server.config, "quietHoursStart", start);
    await setConfig(server.config, "quietHoursEnd", end);
};

beforeEach(async () => {
    timer.stopTimer();
    await server.tests.destroy({where: {}});
    await setConfig(server.config, "provider", PROVIDER);
    await setConfig(server.config, "scheduleOffset", "false");
    await setWindow("none", "none");
    await setConfig(server.config, "timezone", "none");
});

describe("the timezone setting", () => {
    it("starts out unset, so nothing changes for an existing instance", async () => {
        assert.equal(await server.config.getValue("timezone"), "none");
    });
});

describe("a quiet window with a timezone configured", () => {
    it("silences the hours that zone's clock is in, not the host's", async () => {
        const now = new Date();
        const zone = foreignZone(now);
        const there = partsIn(zone, now);

        await setConfig(server.config, "timezone", zone);
        await setWindow(clock(there - MINUTES_PER_HOUR), clock(there + MINUTES_PER_HOUR));
        timer.startTimer(DISTANT_CRON, zone);

        await timer.runTask();

        assert.equal(await countTests(), 0,
            `it is now inside the window on ${zone}'s clock and the test ran anyway`);
    });

    /**
     * The control, and the half that proves the zone is what did it: the same
     * window, with the setting left off, describes hours the host clock is at
     * least three hours away from.
     */
    it("does not silence them when no timezone is configured", async () => {
        const now = new Date();
        const zone = foreignZone(now);
        const there = partsIn(zone, now);

        await setWindow(clock(there - MINUTES_PER_HOUR), clock(there + MINUTES_PER_HOUR));
        timer.startTimer(DISTANT_CRON);

        await timer.runTask();

        assert.equal(await countTests(), 1,
            "a window that is nowhere near the host clock silenced the run anyway");
    });

    // The mirror image: a window around the *host's* clock must stop mattering
    // once the schedule is judged somewhere else.
    it("stops honouring a window written for the host clock", async () => {
        const now = new Date();
        const zone = foreignZone(now);
        const here = now.getHours() * MINUTES_PER_HOUR + now.getMinutes();

        await setConfig(server.config, "timezone", zone);
        await setWindow(clock(here - MINUTES_PER_HOUR), clock(here + MINUTES_PER_HOUR));
        timer.startTimer(DISTANT_CRON, zone);

        await timer.runTask();

        assert.equal(await countTests(), 1,
            "the window is still being read on the host clock despite a configured zone");
    });
});

/**
 * The countdown the status bar draws, which is computed on the server. Firing in
 * one zone and announcing in another would have the dashboard count down to a
 * moment nothing happens at.
 */
describe("the countdown the status endpoint reports", () => {
    const hourIn = (zone, instant) =>
        Number(new Intl.DateTimeFormat("en-US", {timeZone: zone, hour: "2-digit", hourCycle: "h23"}).format(instant));

    it("names an occurrence on the configured zone's clock", async () => {
        const zone = "Etc/GMT+8";

        await setConfig(server.config, "timezone", zone);
        await setConfig(server.config, "cron", "0 9 * * *");

        const next = timer.nextRun(await server.config.getValue("cron"), null,
            await server.config.getValue("timezone"));

        assert.ok(next, "no next run was reported at all");
        assert.equal(hourIn(zone, new Date(next)), 9);
    });
});

/**
 * Changing the zone has to rebuild the job: node-schedule compiles it against
 * the zone it was given, so an unrestarted schedule keeps every future
 * occurrence on the clock it replaced.
 */
describe("changing the timezone through the API", () => {
    it("rebuilds the running schedule", async () => {
        await setConfig(server.config, "cron", "0 9 * * *");
        timer.startTimer("0 9 * * *", "none");

        const before = timer.scheduleGeneration();

        const response = await fetch(`${server.baseUrl}/api/config/timezone`, {
            method: "PATCH",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({value: "Etc/GMT+8"})
        });

        assert.equal(response.status, 200, await response.text());
        assert.notEqual(timer.scheduleGeneration(), before,
            "the schedule was left compiled against the zone it replaced");
        assert.equal(timer.nextRun(), new Date(timer.nextRun()).toISOString());
    });

    it("refuses a zone it does not know, and leaves the schedule alone", async () => {
        timer.startTimer("0 9 * * *", "none");
        const before = timer.scheduleGeneration();

        const response = await fetch(`${server.baseUrl}/api/config/timezone`, {
            method: "PATCH",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({value: "Mars/Olympus_Mons"})
        });

        assert.equal(response.status, 400);
        assert.equal(timer.scheduleGeneration(), before, "a refused value still tore the schedule down");
    });
});
