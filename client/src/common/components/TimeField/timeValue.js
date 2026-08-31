/**
 * The clock arithmetic behind the app's own time field.
 *
 * A native `<input type="time">` is drawn in the *browser's* locale, which is a
 * different question from the one this app answers everywhere else: preferences
 * carry a `timeFormat`, and FormatUtil puts every other time on screen - the
 * status bar, the chart axes, the next-test line - on the clock the reader
 * chose there. The quiet-hours field was the one control asking the browser, so
 * an en-US machine drew an AM/PM picker for somebody who had picked 24 hours
 * two dialogs away. Drawing the field means owning the reading of it, which is
 * what this is.
 *
 * The stored value never changes shape. `HH:mm` on a 24-hour clock is what
 * leaves here whichever clock is shown, because that is what the configuration
 * holds and what the server reads - and it is what a native time input's DOM
 * value always was, which is why the data was never wrong, only its voice.
 *
 * normaliseTime is held against quietHoursWindow's own reader by
 * tests/client/timeValue: two parsers that disagreed would show a window the
 * scheduler is not keeping.
 */

const HOURS_PER_DAY = 24;
const HOURS_PER_HALF_DAY = 12;
const MINUTES_PER_HOUR = 60;
const DIGITS_IN_TIME = 4;
const SEPARATOR = ":";

/** How far apart the minutes the picker offers are. */
export const MINUTE_STEP = 5;

export const MERIDIEM_OPTIONS = ["AM", "PM"];

const padded = (n) => String(n).padStart(2, "0");

const series = (count, step = 1) => Array.from({length: count / step}, (_, i) => padded(i * step));

export const HOUR_OPTIONS = series(HOURS_PER_DAY);
export const MINUTE_OPTIONS = series(MINUTES_PER_HOUR, MINUTE_STEP);

/**
 * The hours a half-day column offers, which start at twelve rather than at one.
 *
 * Midnight is 12 AM and noon is 12 PM - the two a plain modulo gets wrong, and
 * the reason this is a rotation of the column rather than 1..12.
 */
const HALF_DAY_OPTIONS = [padded(HOURS_PER_HALF_DAY), ...series(HOURS_PER_HALF_DAY).slice(1)];

export const hourOptions = (use12h) => (use12h ? HALF_DAY_OPTIONS : HOUR_OPTIONS);

/**
 * Whether this browser draws a native time control on a 12-hour clock.
 *
 * The one question that decides whether the operating system's own picker can
 * be used at all. A native `<input type="time">` takes its format from the
 * browser's UI locale and from nothing else - `lang` on the element, on an
 * ancestor and on the document were all measured and all ignored - so it cannot
 * be asked to show the other clock. It can only be asked whether it already
 * shows the right one.
 *
 * `hourCycle` is h11/h12 for a 12-hour clock and h23/h24 for a 24-hour one;
 * `hour12` is the older spelling of the same answer. An engine that offers
 * neither is read as 24-hour, which is this app's default and the clock the
 * configuration is written in.
 */
export const browserUses12h = (formatter = typeof Intl === "undefined" ? null : Intl.DateTimeFormat) => {
    try {
        const resolved = new formatter(undefined, {hour: "numeric"}).resolvedOptions();

        if (typeof resolved.hour12 === "boolean") return resolved.hour12;

        return typeof resolved.hourCycle === "string" && resolved.hourCycle.startsWith("h1");
    } catch {
        return false;
    }
};

/** A 24-hour hour as its half-day hour and which half of the day it is in. */
const toHalfDay = (hours) => ({
    hour: padded(hours % HOURS_PER_HALF_DAY === 0 ? HOURS_PER_HALF_DAY : hours % HOURS_PER_HALF_DAY),
    meridiem: hours < HOURS_PER_HALF_DAY ? "AM" : "PM"
});

/** A half-day hour and meridiem back on the 24-hour clock. */
const fromHalfDay = (hour, meridiem) => {
    const half = Number(hour) % HOURS_PER_HALF_DAY;

    return meridiem === "PM" ? half + HOURS_PER_HALF_DAY : half;
};

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
export const maskTime = (raw, use12h = false) => {
    const text = String(raw ?? "");
    const [before, after] = text.includes(SEPARATOR)
        ? [text.slice(0, text.indexOf(SEPARATOR)), text.slice(text.indexOf(SEPARATOR) + 1)]
        : [text, null];

    const digits = (part) => part.replace(/\D/g, "");

    /*
     * The meridiem as it was typed, not as it will end up.
     *
     * Completing a lone "P" to "PM" here would make the string identical after a
     * backspace, so the key would look broken - the reader deletes the M and the
     * mask puts it straight back. normaliseTime accepts the lone letter instead,
     * so a half-typed meridiem is still a usable time.
     */
    const meridiem = use12h
        ? (/[ap]/i.exec(text.slice(text.indexOf(SEPARATOR) + 1)) ?? [""])[0].toUpperCase()
            + (/[ap]m/i.test(text) ? "M" : "")
        : "";

    const suffix = meridiem === "" ? "" : ` ${meridiem}`;

    if (after === null) {
        const all = digits(text).slice(0, DIGITS_IN_TIME);

        return all.length > 2 ? `${all.slice(0, 2)}${SEPARATOR}${all.slice(2)}${suffix}` : all;
    }

    const hour = digits(before).slice(0, 2);
    const minute = digits(after).slice(0, 2);

    // A separator with nothing after it is a backspace in progress, and leaving
    // it would strand the caret behind a colon that cannot be deleted.
    return minute === "" ? hour : `${hour}${SEPARATOR}${minute}${suffix}`;
};

/**
 * A value as the stored `HH:mm`, or an empty string where it is not a time.
 *
 * The empty string rather than null, because that is what the field shows and
 * what the configuration reads as "no window": one spelling of absent.
 *
 * `use12h` says which clock the *text* is on, not which clock comes back: a
 * 12-hour entry is converted here, so everything downstream of this function
 * sees the one 24-hour shape it always saw.
 */
export const normaliseTime = (value, use12h = false) => {
    const text = String(value ?? "").trim();

    if (use12h) {
        const match = /^(\d{1,2}):(\d{2})\s*([AP])M?$/i.exec(text);
        if (!match) return "";

        const hours = Number(match[1]);
        const minutes = Number(match[2]);

        // A 12-hour clock has no hour 0 and no hour 13: both mean the reader is
        // half-way through typing something else.
        if (hours < 1 || hours > HOURS_PER_HALF_DAY || minutes >= MINUTES_PER_HOUR) return "";

        return `${padded(fromHalfDay(hours, match[3].toUpperCase() + "M"))}${SEPARATOR}${padded(minutes)}`;
    }

    const match = /^(\d{1,2}):(\d{2})$/.exec(text);
    if (!match) return "";

    const hours = Number(match[1]);
    const minutes = Number(match[2]);

    if (hours >= HOURS_PER_DAY || minutes >= MINUTES_PER_HOUR) return "";

    return `${padded(hours)}${SEPARATOR}${padded(minutes)}`;
};

/** A stored `HH:mm` as the field shows it on the reader's chosen clock. */
export const displayTime = (stored, use12h) => {
    const complete = normaliseTime(stored);
    if (complete === "" || !use12h) return complete;

    const {hour, minute} = partsOf(complete);
    const half = toHalfDay(Number(hour));

    return `${half.hour}${SEPARATOR}${minute} ${half.meridiem}`;
};

/** Which row each column should mark, on the clock being shown. */
export const chosenParts = (stored, use12h) => {
    const complete = normaliseTime(stored);
    if (complete === "") return {hour: "", minute: "", meridiem: ""};

    const {hour, minute} = partsOf(complete);
    if (!use12h) return {hour, minute, meridiem: ""};

    return {...toHalfDay(Number(hour)), minute};
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
export const withPart = (value, part, next, use12h = false) => {
    const {hour, minute} = partsOf(value);

    if (part === "minute") return `${padded(hour || "00")}${SEPARATOR}${padded(next)}`;

    // On a half-day column the hour is only half the answer: which half of the
    // day the value is already in decides the rest, and picking the meridiem
    // moves the hour across without the reader touching it.
    if (use12h) {
        const now = toHalfDay(Number(hour || 0));
        const chosen = part === "meridiem"
            ? {hour: now.hour, meridiem: next}
            : {hour: next, meridiem: now.meridiem};

        return `${padded(fromHalfDay(chosen.hour, chosen.meridiem))}${SEPARATOR}${padded(minute || "00")}`;
    }

    return `${padded(next)}${SEPARATOR}${padded(minute || "00")}`;
};

/** Which part of the value a caret at this offset sits in. */
export const partAt = (value, caret) => {
    const text = String(value ?? "");
    const at = text.indexOf(SEPARATOR);

    if (at === -1 || caret <= at) return "hour";

    const space = text.indexOf(" ", at);

    return space !== -1 && caret > space ? "meridiem" : "minute";
};

/**
 * The value after an arrow key on one half of it.
 *
 * Wrapping, because a clock has no ends and stopping at 23 would make the last
 * hour of the day the hard one to reach. A minute that was typed rather than
 * picked snaps onto the column the picker offers - 04:32 up is 04:35, so the
 * key walks the same values the mouse does.
 */
export const stepPart = (value, part, direction, use12h = false) => {
    const complete = normaliseTime(value);

    // Nothing to move: the press means "give me a time to start from", the same
    // thing the stepper's press means on an empty number field. Stepping off
    // an assumed midnight instead would answer the first press with 01:00 and
    // leave midnight itself the one value an arrow key cannot reach.
    if (complete === "") return "00:00";

    const {hour, minute} = partsOf(complete);

    // Half a day either way, which is the only move a two-row column has.
    if (part === "meridiem")
        return `${padded((Number(hour) + HOURS_PER_HALF_DAY) % HOURS_PER_DAY)}${SEPARATOR}${minute}`;

    // The hour steps around the clock rather than around the column: 11 AM up
    // is 12 PM on both, because what the reader is moving is the time.
    if (part === "hour" && use12h)
        return `${padded((Number(hour) + direction + HOURS_PER_DAY) % HOURS_PER_DAY)}${SEPARATOR}${minute}`;

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
