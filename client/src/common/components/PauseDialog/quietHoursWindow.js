/**
 * The two ends of the daily quiet window, as the dialogs handle them.
 *
 * The window is a pair of configuration values rather than one, which makes
 * three things go wrong quietly unless they are handled here: half a window
 * does nothing at all on the server, clearing one end leaves the other looking
 * like part of a setting, and the stored "switched off" sentinel is not a time
 * a time input can be handed.
 *
 * The window test itself lives here too, mirroring server/util/quietHours.js:
 * a dialog that announces the next test has to skip the occurrences the
 * scheduler will, and it cannot ask the scheduler while the operator is still
 * typing. tests/client/quietHoursParity keeps the two copies in step.
 */

/** The sentinel the configuration stores for "no window", as everywhere else. */
export const QUIET_HOURS_OFF = "none";

export const CONFIG_KEYS = {start: "quietHoursStart", end: "quietHoursEnd"};

const TIME_OF_DAY = /^([0-9]{1,2}):([0-9]{2})$/;

const MINUTES_PER_HOUR = 60;

/**
 * How many scheduled occurrences firstRunOutsideWindow steps over before giving
 * up. Mirrors the server's own limit for the same reason: a window can swallow a
 * long run of them - a minutely cron under an eight-hour window is 480 - and a
 * pair that swallows every one must end the search rather than walk the schedule
 * forever.
 */
const MAX_QUIET_OCCURRENCES = 1500;

/**
 * A stored value as a `<input type="time">` value.
 *
 * The sentinel and anything unparseable both become an empty field: the input
 * would otherwise be handed a string it cannot represent, and browsers differ
 * on whether that shows as blank or as the previous value.
 */
export const storedTimeToInput = (stored) => {
    const match = typeof stored === "string" ? TIME_OF_DAY.exec(stored.trim()) : null;
    if (!match) return "";

    const hours = Number(match[1]);
    const minutes = Number(match[2]);

    if (hours > 23 || minutes > 59) return "";

    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
};

/**
 * What is wrong with the window as it stands, or null.
 *
 * Both ends empty is a window switched off, which is fine. One end is not a
 * window - the server reads it as none - so saving it would report success for
 * a setting that never applies. Two ends on the same minute is a window of no
 * length, which the server also reads as off.
 *
 * @returns "start" | "end" | "same" | null
 */
export const windowProblem = (start, end) => {
    const from = storedTimeToInput(start);
    const until = storedTimeToInput(end);

    if (from === "" && until === "") return null;
    if (from === "") return "start";
    if (until === "") return "end";
    if (from === until) return "same";

    return null;
};

/**
 * The configuration writes that put this window into effect.
 *
 * Always both keys: clearing only the end would leave a start sitting in the
 * configuration, which reads as half a setting to anyone who looks at it later
 * and does nothing at all to the schedule.
 */
export const quietHoursUpdates = (start, end) => {
    const from = storedTimeToInput(start);
    const until = storedTimeToInput(end);
    const complete = from !== "" && until !== "" && from !== until;

    return [
        {key: CONFIG_KEYS.start, value: complete ? from : QUIET_HOURS_OFF},
        {key: CONFIG_KEYS.end, value: complete ? until : QUIET_HOURS_OFF}
    ];
};

/**
 * Whether a configuration payload actually carries the window.
 *
 * The dialog re-reads the configuration after a refused save, through a helper
 * that hands back the parsed body without looking at the status. A refusal
 * therefore arrives looking like a config with no keys in it, and reading a
 * window out of that would show both ends empty - saying the window is off at
 * the very moment the server may be holding a pair nobody set. A payload the
 * window was withheld from is refused for the same reason.
 */
export const carriesWindow = (config) =>
    typeof config?.[CONFIG_KEYS.start] === "string" && typeof config?.[CONFIG_KEYS.end] === "string";

/** One end of the window as minutes into the day, or null. */
const parseTimeOfDay = (value) => {
    const time = storedTimeToInput(value);
    if (time === "") return null;

    const [hours, minutes] = time.split(":").map(Number);

    return hours * MINUTES_PER_HOUR + minutes;
};

/**
 * Whether this instant falls inside the configured window.
 *
 * The client's copy of server/util/quietHours.js, so a dialog can say what the
 * scheduler is going to do without asking it - and it has to agree with the
 * scheduler exactly, which is what tests/client/quietHoursParity is for.
 *
 * Half-open, so "until 08:00" resumes testing at 08:00 rather than a minute
 * later. The wrap-around is the case the feature exists for: "no tests between
 * 23:00 and 08:00" has an end smaller than its start. Two ends on the same
 * minute describe a window of no length, read here - as on the server - as no
 * window at all rather than as one covering the whole day.
 */
export const isQuietHour = (date, start, end) => {
    const from = parseTimeOfDay(start);
    const until = parseTimeOfDay(end);

    if (from === null || until === null || from === until) return false;

    const now = date.getHours() * MINUTES_PER_HOUR + date.getMinutes();

    return from < until
        ? now >= from && now < until
        : now >= from || now < until;
};

/**
 * The first occurrence a scheduled test would actually run on, or null.
 *
 * `nextOccurrence` hands back one occurrence per call, so this knows nothing
 * about cron expressions - the caller owns the schedule and this owns the
 * window. Occurrences inside the window are stepped over rather than reported,
 * because the scheduler refuses them: announcing one meant naming a test that
 * was never going to happen, which is the bug commit 7f684733 fixed for the
 * status bar and this fixes for the dialogs.
 */
export const firstRunOutsideWindow = (nextOccurrence, start, end) => {
    for (let stepped = 0; stepped < MAX_QUIET_OCCURRENCES; stepped++) {
        const occurrence = nextOccurrence();

        if (!isQuietHour(occurrence, start, end)) return occurrence;
    }

    return null;
};

/**
 * Applies a window key by key, putting back whatever it managed to write if a
 * later key is refused.
 *
 * There is no endpoint that takes both keys at once, so the pair is briefly
 * half-written on every save. A refusal on the second write - a session that
 * expired between the two - used to make that state permanent: a new start
 * against the old end, e.g. 22:00-08:00 after editing 23:00-08:00 to 22:00-07:00.
 * The scheduler honours any unequal pair, so it then silenced a band nobody
 * configured.
 *
 * `stored` is the configuration as it was before the edit. A key it does not
 * carry is left alone rather than guessed at, and the undo's own failure is
 * swallowed: whatever refused the write will very likely refuse the undo too,
 * and the caller re-reads the configuration either way - so what ends up on
 * screen is what the server holds rather than what this hoped for.
 */
export const writeQuietHours = async (write, start, end, stored) => {
    const written = [];

    try {
        for (const {key, value} of quietHoursUpdates(start, end)) {
            await write(key, value);
            written.push({key, value});
        }
    } catch (e) {
        for (const {key, value} of written) {
            const previous = stored?.[key];
            if (typeof previous !== "string" || previous === value) continue;

            try {
                await write(key, previous);
            } catch {
                // Reported through the original failure below, which is the one
                // the operator can do something about.
            }
        }

        throw e;
    }
};
