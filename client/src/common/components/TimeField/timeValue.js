/**
 * The clock arithmetic behind the app's own time field.
 *
 * A native `<input type="time">` is drawn in the browser's locale, so an en-US
 * machine offered an AM/PM picker for a setting this app - and the server,
 * which formats with hourCycle "h23" - states in 24 hours. Drawing the field
 * means owning the reading of it, which is what this is.
 *
 * Strings throughout: what goes out is the `HH:mm` the configuration stores and
 * the native input used to hand over, so nothing downstream had to change.
 * normaliseTime is held against quietHoursWindow's own reader by
 * tests/client/timeValue - two parsers that disagreed would show a window the
 * scheduler is not keeping.
 */

const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const DIGITS_IN_TIME = 4;
const SEPARATOR = ":";

/** How far apart the minutes the picker offers are. */
export const MINUTE_STEP = 5;

const padded = (n) => String(n).padStart(2, "0");

const series = (count, step = 1) => Array.from({length: count / step}, (_, i) => padded(i * step));

export const HOUR_OPTIONS = series(HOURS_PER_DAY);
export const MINUTE_OPTIONS = series(MINUTES_PER_HOUR, MINUTE_STEP);

/**
 * What the field should show for what was typed into it.
 *
 * Runs on its own output on every keystroke, so it has to be stable: masking a
 * masked value returns it unchanged rather than moving the separator around
 * under the caret.
 *
 * A separator the reader typed is where they said it is. Splitting strictly by
 * position would read "430" as 43:0, which is not what somebody typing half
 * past four meant - and typing the colon is how they say so.
 */
export const maskTime = (raw) => {
    const text = String(raw ?? "");
    const [before, after] = text.includes(SEPARATOR)
        ? [text.slice(0, text.indexOf(SEPARATOR)), text.slice(text.indexOf(SEPARATOR) + 1)]
        : [text, null];

    const digits = (part) => part.replace(/\D/g, "");

    if (after === null) {
        const all = digits(text).slice(0, DIGITS_IN_TIME);

        return all.length > 2 ? `${all.slice(0, 2)}${SEPARATOR}${all.slice(2)}` : all;
    }

    const hour = digits(before).slice(0, 2);
    const minute = digits(after).slice(0, 2);

    // A separator with nothing after it is a backspace in progress, and leaving
    // it would strand the caret behind a colon that cannot be deleted.
    return minute === "" ? hour : `${hour}${SEPARATOR}${minute}`;
};

/**
 * A value as `HH:mm`, or an empty string where it is not a time of day.
 *
 * The empty string rather than null, because that is what the field shows and
 * what the configuration reads as "no window": one spelling of absent.
 */
export const normaliseTime = (value) => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? "").trim());
    if (!match) return "";

    const hours = Number(match[1]);
    const minutes = Number(match[2]);

    if (hours >= HOURS_PER_DAY || minutes >= MINUTES_PER_HOUR) return "";

    return `${padded(hours)}${SEPARATOR}${padded(minutes)}`;
};

/** The two halves of whatever the field holds, complete or not. */
export const partsOf = (value) => {
    const text = String(value ?? "");
    const at = text.indexOf(SEPARATOR);

    return at === -1
        ? {hour: text, minute: ""}
        : {hour: text.slice(0, at), minute: text.slice(at + 1)};
};

/**
 * The value with one half replaced.
 *
 * The other half starts at zero rather than staying empty: a click in the hour
 * column of a fresh field has to produce a time, or the first pick a reader
 * makes appears to do nothing.
 */
export const withPart = (value, part, next) => {
    const {hour, minute} = partsOf(value);
    const chosen = part === "hour"
        ? {hour: next, minute: minute || "00"}
        : {hour: hour || "00", minute: next};

    return `${padded(chosen.hour)}${SEPARATOR}${padded(chosen.minute)}`;
};

/** Which half of the value a caret at this offset sits in. */
export const partAt = (value, caret) => {
    const at = String(value ?? "").indexOf(SEPARATOR);

    return at !== -1 && caret > at ? "minute" : "hour";
};

/**
 * The value after an arrow key on one half of it.
 *
 * Wrapping, because a clock has no ends and stopping at 23 would make the last
 * hour of the day the hard one to reach. A minute that was typed rather than
 * picked snaps onto the column the picker offers - 04:32 up is 04:35, so the
 * key walks the same values the mouse does.
 */
export const stepPart = (value, part, direction) => {
    const complete = normaliseTime(value);

    // Nothing to move: the press means "give me a time to start from", the same
    // thing the stepper's press means on an empty number field. Stepping off
    // an assumed midnight instead would answer the first press with 01:00 and
    // leave midnight itself the one value an arrow key cannot reach.
    if (complete === "") return "00:00";

    const {hour, minute} = partsOf(complete);

    if (part === "hour")
        return withPart(`${hour}${SEPARATOR}${minute}`, "hour",
            padded((Number(hour) + direction + HOURS_PER_DAY) % HOURS_PER_DAY));

    const steps = MINUTES_PER_HOUR / MINUTE_STEP;
    // Rounded away from the direction of travel, so a value between two steps
    // moves to the next one rather than over it.
    const from = direction > 0
        ? Math.floor(Number(minute) / MINUTE_STEP)
        : Math.ceil(Number(minute) / MINUTE_STEP);

    return withPart(`${hour}${SEPARATOR}${minute}`, "minute",
        padded(((from + direction + steps) % steps) * MINUTE_STEP));
};
