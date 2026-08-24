import { localWallClock, serverZone } from './timezone.js';

/**
 * The daily window in which no scheduled test runs.
 *
 * A speedtest saturates the line for the half minute it takes, and people would
 * rather it did not do that while they are gaming or asleep - upstream #736 and
 * #837. Pausing already exists but is a one-shot: it has to be set again every
 * evening, which is why neither issue was answered by it.
 *
 * Judged on the zone the operator configured, falling back to the host's own
 * clock when none is - which is what this used to do unconditionally. The old
 * reasoning was sound as far as it went ("a window read in one timezone and
 * fired in another would silence the wrong hours, and there is no viewer to ask
 * - nobody is necessarily looking when the test is due") and the conclusion
 * followed only while there was nowhere to state the zone. The Docker image pins
 * TZ=Etc/UTC, so for anybody not on UTC the window silenced hours nobody chose:
 * upstream #1115 and #748. The answer is not to ask a viewer, it is to be told
 * once - so the zone is passed in, by the scheduler that reads the setting.
 *
 * Only the scheduled runs are held to it. A test started by hand is someone
 * asking for one now, and refusing that would be a fault rather than a
 * courtesy.
 */

/** The sentinel every other optional setting in the configuration uses. */
export const QUIET_HOURS_OFF = "none";

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;

const TIME_OF_DAY = /^([0-9]{1,2}):([0-9]{2})$/;

/**
 * A "HH:MM" string as minutes into the day, or null.
 *
 * Null for the disabled sentinel and for anything unparseable alike: both mean
 * there is no window here, and a caller that cannot tell them apart cannot get
 * the answer wrong.
 */
export const parseTimeOfDay = (value) => {
    if (typeof value !== "string") return null;

    const match = TIME_OF_DAY.exec(value.trim());
    if (!match) return null;

    const hours = Number(match[1]);
    const minutes = Number(match[2]);

    if (hours > 23 || minutes > 59) return null;

    return hours * MINUTES_PER_HOUR + minutes;
};

/** Whether the configuration would accept this as one end of the window. */
export const isValidTimeOfDay = (value) => value === QUIET_HOURS_OFF || parseTimeOfDay(value) !== null;

/**
 * How far into the day an instant falls, on `zone`'s wall clock.
 *
 * Defaulted to the host clock so that every caller which has no zone to offer -
 * and every test written before there was one - reads exactly what it read
 * before: serverZone's offset *is* getTimezoneOffset, so the shifted UTC fields
 * below are the same numbers getHours and getMinutes answer.
 */
export const minutesIntoDay = (date, zone = serverZone) => {
    const wall = localWallClock(zone, date);

    return wall.getUTCHours() * MINUTES_PER_HOUR + wall.getUTCMinutes();
};

/**
 * Whether this instant falls inside the configured window.
 *
 * Half-open - it includes the minute it starts on and excludes the one it ends
 * on - so "until 08:00" resumes testing at 08:00 rather than a minute later.
 *
 * The wrap-around is the case the feature exists for: "no tests between 23:00
 * and 08:00" has an end smaller than its start, and a plain `start <= now <
 * end` matches nothing at all for exactly the window everyone wants.
 *
 * Two ends on the same minute describe a window of no length. Reading them the
 * other way - as one covering the whole day - would let a mistyped pair silence
 * every scheduled test for good while the interface showed an ordinary setting,
 * so the harmless reading is the one taken.
 */
export const isQuietHour = (date, start, end, zone = serverZone) => {
    const from = parseTimeOfDay(start);
    const until = parseTimeOfDay(end);

    if (from === null || until === null || from === until) return false;

    const now = ((minutesIntoDay(date, zone) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;

    return from < until
        ? now >= from && now < until
        : now >= from || now < until;
};
