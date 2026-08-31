/**
 * The digest's two pure halves: which windows a run answers for, and the
 * words it says about them.
 *
 * Weekly leans on comparePrevious - previousRange walks back an equal-length
 * span, and for seven days that IS the previous week. Monthly deliberately
 * does not: an equal-length span before March 1st is Jan 29 - Feb 28, wrong
 * for nine of twelve month pairs a year, so the monthly kind carries its own
 * explicit compare month and the caller aggregates it separately.
 *
 * The text is fixed English on purpose - the server has no locale machinery,
 * and every notifier ships the same body. Each line renders only when its
 * figures read, and the whole thing stays far inside the tightest sink cap
 * (pushover's 1024). The largest gap is deliberately not quoted: on an
 * hourly schedule a perfect week reports a one-hour gap, which is the
 * cadence, not a hole.
 */
import { parseDateRange } from "./dateRange.js";
import { localWallClock } from "./timezone.js";

const DAYS_PER_WEEK = 7;
const PERCENT = 100;
const DELTA_DECIMALS = 1;
const RATE_DECIMALS = 1;
const BYTES_PER_GB = 1e9;
const GB_DECIMALS = 1;

// The zone's own calendar parts of an instant - localWallClock shifts the
// instant so its getUTC* reads ARE the wall clock.
const localParts = (zone, now) => {
    const wall = localWallClock(zone, now);

    return {year: wall.getUTCFullYear(), month: wall.getUTCMonth(), day: wall.getUTCDate()};
};

// Date.UTC normalises overflow in either direction, so "day - 7" and
// "month - 2, day 0" land on the right calendar date across month and year
// boundaries without any arithmetic of this module's own.
const dateString = (year, month, day) => {
    const date = new Date(Date.UTC(year, month, day));

    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-`
        + String(date.getUTCDate()).padStart(2, "0");
};

const LAST_OF_PREVIOUS_MONTH = 0;

/**
 * @param kind "weekly" | "monthly"
 * @param now  the tick's instant
 * @param zone the config timezone's zone object
 * @returns {range, compare, comparePrevious} - parsed ranges; weekly carries
 *          no compare of its own and asks listStatistics for the previous
 *          window instead.
 */
export const digestRanges = (kind, now, zone) => {
    const {year, month, day} = localParts(zone, now);

    if (kind === "weekly") {
        const from = dateString(year, month, day - DAYS_PER_WEEK);
        const to = dateString(year, month, day - 1);

        return {
            range: parseDateRange(from, to, {zone}),
            compare: null,
            comparePrevious: true,
            label: `${from} – ${to}`
        };
    }

    const from = dateString(year, month - 1, 1);
    const to = dateString(year, month, LAST_OF_PREVIOUS_MONTH);

    return {
        range: parseDateRange(from, to, {zone}),
        compare: parseDateRange(dateString(year, month - 2, 1),
            dateString(year, month - 1, LAST_OF_PREVIOUS_MONTH), {zone}),
        comparePrevious: false,
        label: `${from} – ${to}`
    };
};

const figure = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;

const signedPercent = (current, previous) => {
    const change = ((current - previous) / previous) * PERCENT;

    return `${change >= 0 ? "+" : ""}${change.toFixed(DELTA_DECIMALS)}%`;
};

// "2026-08-26T14:02:00.000Z" -> the date, the minutes, and the second end
// date-less when it shares the first's day.
const streakSpan = ({from, to}) => {
    const fromDate = String(from).slice(0, 10);
    const fromTime = String(from).slice(11, 16);
    const toDate = String(to).slice(0, 10);
    const toTime = String(to).slice(11, 16);

    return fromDate === toDate
        ? `${fromDate} ${fromTime} – ${toTime} UTC`
        : `${fromDate} ${fromTime} – ${toDate} ${toTime} UTC`;
};

/**
 * @param summary    the digest window's listStatistics payload
 * @param compare    a summary-shaped object for the window compared against -
 *                   weekly passes summary.previous, monthly the earlier
 *                   month's own aggregation; null or empty says nothing
 * @param kind       "weekly" | "monthly"
 * @param rangeLabel the window's dates, already worded
 */
export const digestText = (summary, compare, kind, rangeLabel) => {
    const lines = [`MySpeed ${kind} digest (${rangeLabel})`];
    const total = figure(summary?.tests?.total) ?? 0;

    if (total <= 0) {
        lines.push("No tests ran in this period.");
        return lines.join("\n");
    }

    const failed = figure(summary.tests.failed) ?? 0;
    lines.push(`${total} tests, ${failed} failed (${((failed / total) * PERCENT).toFixed(RATE_DECIMALS)}%)`);

    const down = figure(summary.download?.avg);
    const up = figure(summary.upload?.avg);
    const ping = figure(summary.ping?.avg);
    const speeds = [down === null ? null : `${down} down`, up === null ? null : `${up} up`]
        .filter((part) => part !== null);

    if (speeds.length > 0) {
        lines.push(`Average: ${speeds.join(" / ")} Mbit/s${ping === null ? "" : `, ping ${ping} ms`}`);
    }

    const dataTotal = figure(summary.dataUsed?.total);
    if (dataTotal !== null) lines.push(`Data used: ${(dataTotal / BYTES_PER_GB).toFixed(GB_DECIMALS)} GB`);

    // Comparable means it measured anything at all - the gate the client's
    // hasPreviousData keeps, held here for the same zeros.
    const previousTotal = figure(compare?.tests?.total);
    if (previousTotal !== null && previousTotal > 0) {
        const parts = [`tests ${signedPercent(total, previousTotal)}`];

        for (const [label, current, previous] of [
            ["download", down, figure(compare.download?.avg)],
            ["upload", up, figure(compare.upload?.avg)],
            ["ping", ping, figure(compare.ping?.avg)]
        ]) {
            if (current !== null && previous !== null && previous !== 0)
                parts.push(`${label} ${signedPercent(current, previous)}`);
        }

        lines.push(`vs previous ${kind === "weekly" ? "week" : "month"}: ${parts.join(", ")}`);
    }

    const streak = summary.reliability?.longestFailureStreak;
    if (figure(streak?.count) !== null && streak.count > 0)
        lines.push(`Longest failure streak: ${streak.count} (${streakSpan(streak)})`);

    return lines.join("\n");
};
