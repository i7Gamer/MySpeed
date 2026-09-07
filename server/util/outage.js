/**
 * When a run of failed tests becomes an outage, and when it ends.
 *
 * A single failure already leaves as testFailed, and on the default hourly
 * schedule a line that is really down is then a message an hour saying so -
 * while a provider that hiccupped once is a message about nothing. Neither is
 * the thing an operator wants to hear, which is "the line has now failed N
 * times in a row" once, and "it is back" once.
 *
 * Both are edges. The outage is announced on the one failure that makes the
 * streak exactly as long as the recipient asked for, and the recovery on the
 * first success after a streak at least that long - so a recipient who set
 * three is told nothing about a two-failure blip, at either end. Read from the
 * stored rows rather than a remembered flag, for the reason baselineAlert.js
 * gives: a restart between two bad tests is exactly when somebody is looking.
 *
 * Nearly a leaf, like connectionChange.js: the integration modules, the
 * dispatcher, the task and the payload all read these names, and the module
 * that owns them must not import any of them back. What it does import is
 * the two catalogues below everything - the phrases and the clock - for the
 * summary at the bottom, which is composed here rather than beside
 * connectionSummary because notificationLocale.js is evaluated on its own by
 * its test and must import nothing of the tree.
 */

import { phrase } from './notificationLocale.js';
import { localDateTime } from './timezone.js';

/** The two events, in the order they happen. */
export const OUTAGE_EVENT = "outageStarted";
export const RECOVERED_EVENT = "connectionRestored";

/** One switch for both - being told a line is down and not that it is back is half a message. */
export const SEND_OUTAGE_FIELD = "send_outage";

/** How many failures in a row this recipient calls an outage. */
export const OUTAGE_AFTER_FIELD = "outage_after";

export const OUTAGE_MESSAGE_FIELD = "outage_message";
export const RECOVERED_MESSAGE_FIELD = "recovered_message";

/** The payload key the streak length travels on, read by the gate. */
export const FAILURES_IN_ROW = "failuresInRow";

/**
 * The passage that says how long the line has been down, or what it came back
 * from - filled in per recipient by the dispatcher in that integration's
 * language and on the instance's clock, the same arrangement as the alert and
 * connection summaries. Empty, never null, for the same reason those are.
 *
 * Named here rather than beside the other two summaries in
 * notificationPayload.js, because the locale module composes it and the
 * payload module lists it, and the payload module already imports the locale
 * module's neighbour - a name both read has to live in a leaf below both.
 */
export const OUTAGE_SUMMARY = "outageSummary";

/**
 * The streak length for a recipient that chose none.
 *
 * Two rather than one, because one is what testFailed already announces, and
 * the whole point of a second event is to be quiet about the single failure a
 * rate-limited provider or a busy line produces. Not larger, because on the
 * hourly default every extra failure is another hour before anyone hears.
 */
export const DEFAULT_OUTAGE_AFTER = 2;

/** One is allowed: an operator who wants every failure counted as an outage may say so. */
export const OUTAGE_AFTER_MIN = 1;

const MS_PER_MINUTE = 60_000;

/**
 * A whole number at or above the floor, or null.
 *
 * A number or the text of one, and nothing else: Number(true) is 1, and a
 * restored configuration - importConfig writes integration rows without
 * validateInput - could carry a boolean where the count belongs, which read
 * as "announce on the first failure".
 */
const wholeNumber = (value) => {
    if (typeof value !== "number" && typeof value !== "string") return null;
    if (value === "") return null;

    const number = Number(value);

    return Number.isInteger(number) && number >= OUTAGE_AFTER_MIN ? number : null;
};

/**
 * The streak length this recipient calls an outage.
 *
 * Read loosely, the way limitOf reads a threshold: the value is JSON a form
 * wrote, and a blank, a zero or a fraction all mean "the default" rather than
 * something to act on. A zero read as a length would announce an outage on no
 * failure at all, which is a gate that never fires.
 */
export const outageAfter = (data) => wholeNumber(data?.[OUTAGE_AFTER_FIELD]) ?? DEFAULT_OUTAGE_AFTER;

/**
 * The streak a payload carries, or null when it carries none.
 *
 * Strictly a whole number: the payload may have been written by a node as
 * JSON, so "3" is a count, while a null or a word is not - and a payload with
 * no count must never announce anything.
 */
const streakOf = (payload) => {
    const count = payload?.[FAILURES_IN_ROW];
    if (typeof count !== "number" && typeof count !== "string") return null;
    if (count === "") return null;

    const number = Number(count);

    return Number.isInteger(number) && number >= 0 ? number : null;
};

/** Whether this failure is the one that makes the streak this recipient's length. */
export const announcesOutage = (payload, data) => streakOf(payload) === outageAfter(data);

/** Whether the streak that just ended was long enough for this recipient to have heard of it. */
export const announcesRecovery = (payload, data) => {
    const streak = streakOf(payload);

    return streak !== null && streak > 0 && streak >= outageAfter(data);
};

/**
 * A stored streak as the three keys the payload carries.
 *
 * @param streak {count, since} - how many failures sit newest-first at the top
 *               of a target's history, and the first of them
 * @param now    the clock the downtime is measured to
 */
export const describeStreak = (streak, now = new Date()) => {
    const count = Number(streak?.count);
    const since = streak?.since === null || streak?.since === undefined ? NaN : new Date(streak.since).getTime();

    if (!Number.isInteger(count) || count <= 0 || !Number.isFinite(since))
        return {[FAILURES_IN_ROW]: 0, downSince: null, downtimeMinutes: null};

    return {
        [FAILURES_IN_ROW]: count,
        downSince: new Date(since).toISOString(),
        // Never negative: a clock that was set back between the first failure
        // and now would otherwise report a downtime of minus a day.
        downtimeMinutes: Math.max(0, Math.round((now.getTime() - since) / MS_PER_MINUTE))
    };
};

/**
 * How long the line has been failing, or what it just came back from, as the
 * one passage a template prints through %outageSummary% - filled in per
 * recipient at the dispatch point, the way connectionSummary is, because the
 * language is the integration's own setting.
 *
 * On the instance's clock rather than as the ISO text the payload carries:
 * "since 2026-08-13T09:15:00.000Z" is a timestamp, and "since 2026-08-13
 * 11:15" is a time somebody reads at breakfast - the same reason the digest
 * prints its failure streak this way. Empty for a payload that carries no
 * streak, and for an event this does not describe, so a template can end on
 * it the way the shipped ones end on the alert summary.
 *
 * The two phrase keys are literals, as every phrase the server asks for is:
 * the locale test scans the source for them.
 *
 * @param eventName  OUTAGE_EVENT or RECOVERED_EVENT
 * @param payload    the event's payload, carrying failuresInRow and downSince
 * @param language   the integration's own setting
 * @param zone       the instance's clock, as triggerEvent resolves it
 */
export const outageSummary = (eventName, payload, language, zone) => {
    const streak = describeStreak({count: payload?.[FAILURES_IN_ROW], since: payload?.downSince});
    if (streak[FAILURES_IN_ROW] === 0) return "";

    const {date, time} = localDateTime(zone, streak.downSince);
    const values = {count: streak[FAILURES_IN_ROW], since: `${date} ${time}`};

    if (eventName === OUTAGE_EVENT) return phrase(language, "outage_summary", values);
    if (eventName === RECOVERED_EVENT) return phrase(language, "recovered_summary", values);

    return "";
};
