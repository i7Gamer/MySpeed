import i18n, {t} from "i18next";
// The constants module rather than the context barrel: that barrel re-exports a
// React component, which would drag the whole component tree into anything that
// only wanted to know what "mbps" is called.
import {SPEED_UNIT_MBPS, SPEED_UNIT_MBYTES, TIME_FORMAT_12H, TIME_FORMAT_24H} from "@/common/contexts/Preferences/constants";
// The one reading of a stored figure, shared with the graders: a formatter
// that refused the text spelling a legacy-restored history holds printed
// "N/A" beside a colour that graded the same row - and convertSpeed handing a
// string back unconverted left changeFrom comparing Mbit/s against MB/s.
// readableFigure for formatPercent below, the same layered reading the
// graders use.
import {readableFigure, storedFigure} from "@/common/utils/TestUtil";

/**
 * The language the app is set to, for anything Intl formats.
 *
 * Passing undefined means "whatever locale the browser is set to", which
 * ignores the language the user picked in the app - a German UI rendered
 * English month names and a 12-hour clock on an en-US browser.
 *
 * Exported because it was copied instead: lineChartConfig grew an `appLocale`
 * of its own, and three surfaces that had neither - the range picker's trigger,
 * the calendar's month heading and the overview's sticky date pill - went on
 * asking the browser. A calendar headed "August 2026" in English above weekday
 * names that were translated is what one copy too few looks like.
 */
export const appLocale = () => i18n.language || undefined;

const locale = appLocale;

/** ISO numbering, which is what Intl's week info speaks: 1 Monday, 7 Sunday. */
export const WEEK_STARTS_MONDAY = 1;
export const WEEK_STARTS_SUNDAY = 7;

/**
 * The tags this interface ships whose readers start a week on Sunday, read
 * out of the runtime's own week data: English, Indonesian, Japanese, Korean,
 * Portuguese and Traditional Chinese. Mainland Chinese is not among them and
 * neither is Irish, which both surprise, and which is the reason this is a
 * transcription rather than a guess.
 *
 * Whole tags as well as bare languages, because zh-TW parts company with zh.
 */
const SUNDAY_FIRST = new Set(["en", "id", "ja", "ko", "pt", "zh-tw"]);

/**
 * Which day the reader's week begins on.
 *
 * The calendar was Monday-first for everybody: the grid was built from
 * `day === 0 ? 6 : day - 1` and the weekday row was a fixed Mon-Sun list, so a
 * reader in Tokyo or São Paulo got a month laid out the way Berlin reads it.
 *
 * Intl knows the answer per region, and knows it better than any table here
 * can - en-GB starts on Monday where en-US starts on Sunday, and only the tag
 * says which reader this is. It is spelled two ways though (a getWeekInfo()
 * method in Chrome, a weekInfo property elsewhere) and missing altogether in
 * some browsers, so the set above answers when the runtime will not. Monday is
 * the fallback's fallback, which is what the calendar always did.
 */
export const firstWeekday = (localeTag = appLocale()) => {
    const tag = String(localeTag ?? "");

    try {
        const parsed = new Intl.Locale(tag);
        const info = parsed.getWeekInfo?.() ?? parsed.weekInfo;

        if (Number.isInteger(info?.firstDay)) return info.firstDay;
    } catch {
        // An empty or malformed tag. The language below is still readable from
        // it, and an unparseable tag has no region to be right about anyway.
    }

    const lowered = tag.toLowerCase();
    const language = lowered.split(/[-_]/)[0];

    return SUNDAY_FIRST.has(lowered) || SUNDAY_FIRST.has(language)
        ? WEEK_STARTS_SUNDAY : WEEK_STARTS_MONDAY;
};

const toDate = (value) => {
    if (value instanceof Date) return value;

    // new Date(null) is the epoch rather than an invalid date, and the same
    // goes for "" and 0 - so an absent timestamp rendered as 01/01/1970
    // instead of the blank the isNaN guards below were meant to produce.
    if (value === null || value === undefined || value === "") return new Date(NaN);

    return new Date(value);
};

/**
 * A calendar day, in the language the app is set to.
 *
 * For naming a range in prose - "No tests between 12 Jul and 19 Jul" - where
 * the time of day would be noise.
 */
export const formatDay = (value) => {
    const date = toDate(value);
    if (isNaN(date.getTime())) return "";

    return date.toLocaleDateString(locale(), {day: "2-digit", month: "short", year: "numeric"});
};

/**
 * A month and its year, for the calendar's heading.
 *
 * Sits directly above weekday names that come from the translations, so a
 * heading in the browser's language was the one English word in a German
 * calendar.
 */
export const formatMonth = (value) => {
    const date = toDate(value);
    if (isNaN(date.getTime())) return "";

    return date.toLocaleDateString(locale(), {month: "long", year: "numeric"});
};

/**
 * A whole date with its weekday spelled out, for the date pill that floats over
 * the test list. The rows beneath it print a clock time, so the pill is the only
 * place the day itself is named at all.
 */
export const formatFullDay = (value) => {
    const date = toDate(value);
    if (isNaN(date.getTime())) return "";

    return date.toLocaleDateString(locale(), {weekday: "long", year: "numeric", month: "long", day: "numeric"});
};

/**
 * A count, grouped the way the app's language groups digits.
 *
 * The downsample note prints two of these in one sentence. A bare
 * toLocaleString() takes the browser's separator, so a German instance read
 * "1,234 of 5,678" among numbers written 1.234 everywhere else on the page.
 */
export const formatCount = (value) => Number(value).toLocaleString(locale());

export const formatTime = (value, preferences) => {
    const date = toDate(value);
    if (isNaN(date.getTime())) return "";

    const use12h = preferences?.timeFormat === TIME_FORMAT_12H;
    return date.toLocaleTimeString(locale(), {
        hour: "2-digit",
        minute: "2-digit",
        hour12: use12h
    });
};

export const formatDateTime = (value, preferences, dateOptions = {}) => {
    const date = toDate(value);
    if (isNaN(date.getTime())) return "";

    const use12h = preferences?.timeFormat === TIME_FORMAT_12H;
    const datePart = date.toLocaleDateString(locale(), dateOptions);
    const timePart = date.toLocaleTimeString(locale(), {
        hour: "2-digit",
        minute: "2-digit",
        hour12: use12h
    });
    return `${datePart} ${timePart}`;
};

export const formatShortTime = (date, preferences) => {
    const use12h = preferences?.timeFormat === TIME_FORMAT_12H;
    if (use12h) {
        let hours = date.getHours();
        const minutes = String(date.getMinutes()).padStart(2, "0");
        const suffix = hours >= 12 ? "PM" : "AM";
        hours = hours % 12;
        if (hours === 0) hours = 12;
        return `${hours}:${minutes} ${suffix}`;
    }
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${hours}:${minutes}`;
};

/**
 * A whole hour of the day, on the clock the reader has chosen.
 *
 * Lived inside the hourly chart until the overview card started naming the
 * fastest and slowest hours of the day: two components writing "20:00" from the
 * same preference is one of them eventually forgetting the 12-hour case.
 */
export const formatHour = (hour, preferences) => {
    if (preferences?.timeFormat !== TIME_FORMAT_12H) return `${String(hour).padStart(2, "0")}:00`;

    const suffix = hour >= 12 ? "PM" : "AM";
    const twelve = hour % 12;

    return `${twelve === 0 ? 12 : twelve}:00 ${suffix}`;
};

export const getSpeedUnit = (preferences) => {
    if (preferences?.speedUnit === SPEED_UNIT_MBYTES) {
        return t("latest.byte_speed_unit", {defaultValue: "MB/s"});
    }
    return t("latest.speed_unit");
};

// The stored latency and the API keep two decimals; the interface shows one.
// The test row is dense - the latency shares it with the jitter, the download
// and the upload - and at a glance the second decimal is noise.
const LATENCY_DECIMALS = 1;

/**
 * A latency as it is shown, rather than as it is stored.
 *
 * The column used to be an INTEGER, so this had nothing to do: every value
 * arrived whole. Now that the measurement keeps its decimals, the ones on
 * screen are trimmed to one - and a whole millisecond stays whole rather than
 * gaining a pointless ".0".
 *
 * A numeric string is read as the number it spells, like every other reader
 * of a stored column - the colour beside the printed figure is graded through
 * the same reading, and a chip was green beside an "N/A" label for exactly
 * that row. What cannot be read at all is handed back untouched, as
 * convertSpeed does: null is the server saying it could not compute one, and
 * a negative is the placeholder a failed test stores - returned as the number,
 * so the interface recognises the failure in either spelling.
 */
export const formatLatency = (ms) => {
    const latency = storedFigure(ms);
    if (latency === null) return ms;
    if (latency < 0) return latency;

    return parseFloat(latency.toFixed(LATENCY_DECIMALS));
};

/** The smallest latency the one decimal above can express. */
export const LATENCY_STEP = 0.1;

/**
 * Whether a latency is real but too small for the interface to print.
 *
 * The trim above is a rounding, and parseFloat then drops the trailing zero,
 * so everything under 0.05 comes out as the bare "0" a genuine zero does. For
 * most latencies that is harmless - nobody reads a 0.03 ms ping as a claim -
 * but the stability card's spread is different: "±0 ms" there is the strongest
 * statement the figure can make, that the line's latency did not move at all
 * between two tests, and a spread merely below the display's resolution must
 * not borrow it.
 *
 * Both readings are real. A history of whole-millisecond pings has a median
 * absolute deviation of exactly zero, because more than half the tests land on
 * the median; the same instance's newer rows, measured to two decimals, sit a
 * few hundredths apart instead.
 */
export const roundsToZeroLatency = (ms) => {
    // storedFigure, like the formatLatency this wraps: a spread spelt as text
    // prints 0 through the formatter, and the predicate deciding whether that
    // 0 needs the ±<0.1 wording has to judge the value the formatter prints.
    const latency = storedFigure(ms);

    return latency !== null && latency > 0 && formatLatency(latency) === 0;
};

const MBITS_PER_MBYTE = 8;

/**
 * The one reading a speed takes before any display: coerced through
 * storedFigure - a numeric string reads as the number it spells, junk passes
 * through untouched, a negative placeholder comes back as the number for the
 * guards to recognise - and converted to the reader's unit as the RAW
 * quotient. The two exported forms round it each to their own display: two
 * decimals for the expanded views, a whole number for the list rows. Both
 * speed readers carried this preamble in full before it lived here;
 * formatLatency and formatWhole keep the guard triple as their own readings,
 * because what they read is not a speed and has no unit to convert.
 */
const rawSpeed = (mbps, preferences) => {
    const speed = storedFigure(mbps);
    if (speed === null) return mbps;
    if (speed < 0) return speed;

    return preferences?.speedUnit === SPEED_UNIT_MBYTES ? speed / MBITS_PER_MBYTE : speed;
};

// Two decimals for a converted speed, as the factor a rounding multiplies
// through - named beside MBITS_PER_MBYTE so neither is a bare number.
const SPEED_ROUNDING = 100;

export const convertSpeed = (mbps, preferences) => {
    // Reading before refusal, in rawSpeed: a numeric string handed back
    // unconverted left changeFrom comparing one operand in Mbit/s against
    // the other in MB/s - a wrong change with a confident direction, where
    // the old refusal at least printed nothing.
    const speed = rawSpeed(mbps, preferences);

    // Two decimals ONLY where a conversion happened. Mbit/s is the unit the
    // column stores, so that figure passes through exact - and junk and the
    // placeholders keep rawSpeed's passthrough contract in either unit. The
    // number-and-sign checks knowingly restate rawSpeed's refusals: rawSpeed
    // hands back one value that is either a quotient or a passthrough, and
    // telling those apart here costs less than a tagged return would.
    if (preferences?.speedUnit !== SPEED_UNIT_MBYTES || typeof speed !== "number" || speed < 0) return speed;

    return Math.round(speed * SPEED_ROUNDING) / SPEED_ROUNDING;
};

/**
 * A measurement as a whole number, for the rows of the overview list.
 *
 * That list is read down its columns rather than across its rows, which is what
 * the fixed grid behind it exists for - and a column reads as a column when its
 * figures are the same width. The latency column stopped being that when the
 * ping started keeping decimals: an "8.4 ms" under a "132.7 ms" under a "9 ms"
 * is three widths in three consecutive rows, with two speed columns beside it
 * carrying up to four digits and a fraction of their own.
 *
 * Nothing is lost by it. The panel a row opens onto prints every figure at the
 * precision it was measured at, and that is where a tenth of a millisecond is
 * worth reading - not at a glance down a hundred tests.
 *
 * Guarded the way formatLatency and convertSpeed are, and for a sharper reason
 * than either: Math.round(null) is 0 and Math.round(undefined) is NaN, so an
 * unguarded rounding would present a figure nobody measured as a reading of
 * zero. -1 is the placeholder a failed test stores in every numeric column,
 * which the interface recognises a failure by.
 */
export const formatWhole = (value) => {
    // The same reading as its two siblings above: without it, a text row's
    // speeds converted and printed while the ping on the same card stayed
    // text and rendered "N/A".
    const figure = storedFigure(value);
    if (figure === null) return value;
    if (figure < 0) return figure;

    return Math.round(figure);
};

// What a value the server could not compute is shown as. The statistics return
// an explicit null - for an average over a range in which nothing succeeded, for
// instance - and concatenating a unit onto that renders the word "null".
export const NOT_MEASURED = "N/A";

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86400;

// Below this, "now" reads better than a number of seconds that is stale by the
// time it is read.
const JUST_NOW_SECONDS = 5;

/**
 * A span of seconds in words - the largest unit that fits, floored.
 *
 * The unit ladder generateRelativeTime has always climbed, extracted so a
 * duration BETWEEN two instants - the largest-gap row - wears the same
 * localized words as a duration ending now. No "Just now" tier here: that is
 * a statement about the clock, which only the caller measuring from it can
 * make, and a three-second span is three seconds.
 */
/**
 * The i18next context a span wears when it sits inside "… ago". Some
 * languages inflect the unit there - German says "7 Tage" on its own and
 * "vor 7 Tagen" behind "vor" - so a locale may carry a `_ago` variant of any
 * unit key, and i18next falls back to the plain one where it does not.
 */
export const AGO_CONTEXT = "ago";

// `options` is unpacked inside the body rather than destructured in the
// signature: the suite reads functions through bodyOf(), which balances the
// first brace after the declaration.
export const spanInWords = (seconds, options = undefined) => {
    const context = options?.context;

    if (seconds < SECONDS_PER_MINUTE) {
        return t("time.seconds", {replace: {seconds: Math.floor(seconds)}, context});
    } else if (seconds < SECONDS_PER_HOUR) {
        return Math.floor(seconds / SECONDS_PER_MINUTE) === 1
            ? t("time.minute", {context})
            : t("time.minutes", {replace: {minutes: Math.floor(seconds / SECONDS_PER_MINUTE)}, context});
    } else if (seconds < SECONDS_PER_DAY) {
        return Math.floor(seconds / SECONDS_PER_HOUR) === 1
            ? t("time.hour", {context})
            : t("time.hours", {replace: {hours: Math.floor(seconds / SECONDS_PER_HOUR)}, context});
    }

    const days = Math.floor(seconds / SECONDS_PER_DAY);
    return days === 1 ? t("time.day", {context}) : t("time.days", {replace: {days: days}, context});
};

/**
 * How long ago something happened, in words.
 *
 * Moved here from the latest-test panel when the status bar replaced it - the
 * integration dialog reads it too, so it outlived the component it was written
 * for.
 */
export function generateRelativeTime(created) {
    let currentDate = new Date().getTime();
    let date = new Date(Date.parse(created)).getTime();

    const diff = (currentDate - date) / 1000;

    if (isNaN(diff)) {
        return NOT_MEASURED;
    }

    if (diff < JUST_NOW_SECONDS) {
        return t("time.now");
    }

    // Every caller puts this behind "ago" - the status bar's "Last test … ago",
    // the integration card's "Last run before …" - so the span wears that
    // context, and a language that inflects the unit there gets its case.
    return spanInWords(diff, {context: AGO_CONTEXT});
}

/**
 * How long ago the last test ran, as a whole sentence.
 *
 * The surrounding phrase is chosen here rather than at the call site because
 * most of what generateRelativeTime returns is a bare duration that reads
 * correctly inside "Last test … ago", while "Just now" is already a complete
 * phrase - wrapping that produced "Last test Just now ago".
 */
export function formatLastTest(created) {
    const seconds = (new Date().getTime() - new Date(Date.parse(created)).getTime()) / 1000;

    if (isNaN(seconds)) return t("status.never_run");
    if (seconds < JUST_NOW_SECONDS) return t("status.last_test_now");

    return t("status.last_test", {time: generateRelativeTime(created)});
}

/**
 * A test's duration with its unit, or the statement that there is none.
 *
 * Through the shared reader, like every formatter beside it - it was the one
 * that neither coerced nor refused, so the overview's duration row printed a
 * proxied node's -1 placeholder as "-1s" with an improvement arrow computed
 * from it, one row above a loss row answering N/A for the identical payload,
 * while an older node's text average was hidden as N/A while being a reading.
 */
export const formatDuration = (seconds) => {
    const duration = readableFigure(seconds);

    return duration === null ? NOT_MEASURED : `${duration}s`;
};

/**
 * Whether a value is a figure the printers below would print.
 *
 * The judgement under formatWithUnit, exported on its own for the printers
 * that carry no unit of their own - the overview row's jitter chip, and
 * FigureWithUnit, whose unit lives in a styled span. Both spelled the
 * refusal around this missing export before, one through readableFigure and
 * one by formatting a string only to compare it against N/A.
 *
 * It judges what a FORMATTER produced, so text spellings are false on
 * purpose: coercion is the formatters' job, and a printer handed a raw
 * column should refuse it loudly rather than print what nothing coerced.
 */
export const printableFigure = (value) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * A measurement with its unit, or a statement that there is none.
 *
 * The statistics return an explicit null for anything they could not compute -
 * every aggregate over a range in which no test succeeded - and rendering
 * `{value} {unit}` around that leaves a bare unit standing on its own.
 *
 * A negative is refused too: the formatters above hand the failure
 * placeholder back as a number so the graders can recognise it, and this is
 * where that number must stop - "-1 ms" beside a blue never-measured chip
 * asserts a latency nobody took. Signed values that ARE readings - the change
 * row's difference - deliberately never come through here; they render their
 * own sign (TestDetails' change line), so nothing legitimate is lost.
 */
export const formatWithUnit = (value, unit) => printableFigure(value) ? `${value} ${unit}` : NOT_MEASURED;

/**
 * A score with its %, or a statement that there is none.
 *
 * The percent rule was written twice in one review round - a chart-local
 * helper and an inline ternary - while a third variant with a null-only gate
 * survived on the sibling card, printing a proxied node's -1 placeholder as
 * "-1%". One home: text spellings coerce and print the number they spell,
 * junk and the placeholders say N/A. "%" binds to its number without a
 * space, unlike the spaced units above.
 */
export const formatPercent = (value) => {
    const figure = readableFigure(value);

    return figure === null ? NOT_MEASURED : `${figure}%`;
};

/**
 * A latency with its unit, at the one decimal every latency is shown at.
 *
 * The two formatters had drifted apart wherever more than one latency is printed
 * at a time: a detail card trimmed the ping through formatLatency and handed the
 * jitter beside it straight to formatWithUnit, so one card claimed two different
 * precisions for two figures measured the same way.
 */
export const formatLatencyWithUnit = (ms, unit) => formatWithUnit(formatLatency(ms), unit);

// The ladder a byte count is stepped down, and the size of a step. Decimal
// rather than binary: the providers state their payloads in decimal - a "100 MB"
// Cloudflare payload is 100 000 000 bytes - so reporting 95.4 MiB for it would
// describe the transfer in a unit nobody involved used.
const BYTE_STEP = 1000;
const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

// One decimal from a kilobyte up. "1.1 GB" is as much precision as the figure
// supports; "1.136 GB" implies a count exact to the megabyte.
const BYTE_DECIMALS = 1;

/**
 * A speed as the whole number a list row prints, rounded ONCE.
 *
 * formatWhole(convertSpeed(x)) rounded twice in MB/s mode - to two decimals,
 * then to a whole - so every band [8n+3.96, 8n+4) printed one megabyte high:
 * 3.96 Mbit/s showed "1 MB/s" where the measurement is 0, and 99.97 showed
 * "13" where it is 12. The bands recur at every multiple of eight; rounding
 * once from the raw quotient is the correct figure at all of them. The
 * expanded views keep convertSpeed, whose two decimals are their display.
 *
 * formatWhole over the RAW quotient, which is the whole definition: the
 * rounding is formatWhole's, the reading and the refusals are rawSpeed's -
 * text spellings read, junk passes through untouched, and a negative comes
 * back as the number for the guards to recognise.
 */
export const wholeSpeed = (mbps, preferences) => formatWhole(rawSpeed(mbps, preferences));

/**
 * A quantity of data in the largest unit that leaves it readable.
 *
 * Whole bytes stay whole - "512 B" rather than "512.0 B" - because under a
 * kilobyte the decimal is noise.
 */
export const formatBytes = (bytes) => {
    // storedFigure, like the formatters above: the traffic row is gated on
    // isMeasured, so a legacy text column rendered the row with "N/A / N/A" -
    // shown and denied at once.
    const count = storedFigure(bytes);
    if (count === null || count < 0) return NOT_MEASURED;

    let value = count;
    let step = 0;

    // The figure as it will actually be printed. The ladder is climbed against
    // this rather than against the raw value: 999 999 999 divides to 999.999999
    // MB, which one decimal rounds to 1000.0 - a number that belongs in the next
    // unit, and printed with this one it reads "1000 MB". A gigabit line's
    // download lands in that band routinely.
    const printed = () => step === 0 ? value : parseFloat(value.toFixed(BYTE_DECIMALS));

    while (printed() >= BYTE_STEP && step < BYTE_UNITS.length - 1) {
        value /= BYTE_STEP;
        step++;
    }

    return `${printed()} ${BYTE_UNITS[step]}`;
};

export {SPEED_UNIT_MBPS, SPEED_UNIT_MBYTES, TIME_FORMAT_12H, TIME_FORMAT_24H};
