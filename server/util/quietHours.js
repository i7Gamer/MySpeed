/**
 * The daily window in which no scheduled test runs.
 *
 * A speedtest saturates the line for the half minute it takes, and people would
 * rather it did not do that while they are gaming or asleep - upstream #736 and
 * #837. Pausing already exists but is a one-shot: it has to be set again every
 * evening, which is why neither issue was answered by it.
 *
 * Judged on the server's own clock, because that is the clock the schedule
 * itself runs on. A window read in one timezone and fired in another would
 * silence the wrong hours, and there is no viewer to ask - nobody is
 * necessarily looking when the test is due.
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

export const minutesIntoDay = (date) => date.getHours() * MINUTES_PER_HOUR + date.getMinutes();

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
export const isQuietHour = (date, start, end) => {
    const from = parseTimeOfDay(start);
    const until = parseTimeOfDay(end);

    if (from === null || until === null || from === until) return false;

    const now = ((minutesIntoDay(date) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;

    return from < until
        ? now >= from && now < until
        : now >= from || now < until;
};
