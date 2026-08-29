import StatisticContainer from "@/pages/Statistics/components/StatisticContainer";
import PanelRow from "@/pages/Statistics/components/PanelRow";
import {t} from "i18next";
import {useContext} from "react";
import {
    faCalendarDay, faCircleExclamation, faClockRotateLeft, faDatabase, faGaugeHigh,
    faHourglassHalf, faLinkSlash, faPingPongPaddleBall, faStopwatch
} from "@fortawesome/free-solid-svg-icons";
import {
    formatBytes, formatDay, formatDuration, formatHour, formatLatencyWithUnit, formatPercent
} from "@/common/utils/FormatUtil";
import {failureRate, readableFigure} from "@/common/utils/TestUtil";
import {PreferencesContext} from "@/common/contexts/Preferences";
import {peakSlowdown} from "@/pages/Statistics/charts/peakHours";
import Delta from "@/common/components/Delta";
import "./styles.sass";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// One decimal: enough to tell four tests a day from four and a half without
// implying the schedule is that precise.
const PER_DAY_DECIMALS = 1;

/**
 * How many whole days the shown window covers.
 *
 * The server counts this over the window it actually answered for and sends it
 * with the bounds, so the divisor here and the dates in the heading above
 * cannot describe different windows. Derived from the bounds only when it was
 * not sent: a parent proxies this request to its nodes, and a node running an
 * older version answers without it.
 *
 * Whole days, not the exact span. An all-time range on a young instance is the
 * extent of its own tests, and three hours of them is one day of testing rather
 * than an eighth of one - dividing by the fraction reports a rate nobody ran.
 */
const daysCovered = (dateRange) => {
    if (typeof dateRange?.days === "number" && Number.isFinite(dateRange.days)) return dateRange.days;

    const span = (new Date(dateRange?.to) - new Date(dateRange?.from)) / MS_PER_DAY;
    if (!Number.isFinite(span) || span <= 0) return null;

    return Math.max(1, Math.ceil(span));
};

/**
 * How densely the range was actually sampled.
 *
 * Divided by the elapsed fraction when the server sent one - a seven-day range
 * at Wednesday noon has been sampled for two and a half days, and dividing by
 * seven understates the rate by the days that have not happened yet. Complete
 * windows, and answers from an older node, carry no fraction and divide by the
 * whole days above.
 */
const testsPerDay = (total, dateRange) => {
    const days = daysCovered(dateRange);
    if (days === null || days <= 0) return null;

    const elapsed = typeof dateRange?.elapsedDays === "number"
        && Number.isFinite(dateRange.elapsedDays) && dateRange.elapsedDays > 0
        ? dateRange.elapsedDays : null;

    return {perDay: parseFloat((total / (elapsed ?? days)).toFixed(PER_DAY_DECIMALS)), days, elapsed};
};

/**
 * The figures only the enlarged view shows.
 *
 * Every one of them is already in the payload the page fetched and was
 * displayed nowhere: latency has no min/max/avg card the way download and
 * upload do, the duration card states only its average, and nothing said how
 * often the schedule actually ran.
 */
const expandedItems = (props) => {
    const items = [];
    const ms = t("latest.ping_unit");

    // The average as the shared reader takes it, which decides whether the
    // row exists at all: the null-only gate rendered a proxied node's -1 as
    // an "Average latency, between N/A and N/A" row whose delta was computed
    // from the placeholder, and hid an older node's text average while it
    // was a reading. The parts of the sentence refuse individually through
    // their formatter - a readable average is not hidden because the median
    // beside it is junk.
    const pingAverage = readableFigure(props.ping?.avg);
    const ping = props.ping;

    // Trimmed to one decimal, like every other latency in the app. The server
    // stores these through mapFixed at two, and this pane was the last reader
    // still printing them raw - "23.47 ms" beside a stability card and a detail
    // pane saying 23.5 for the same measurement, which is the fault
    // ConsistencyChart was changed to fix without the twin being applied here.
    if (pingAverage !== null) items.push({
        icon: faPingPongPaddleBall,
        title: t("latest.ping"),
        // The median rides in the description beside the spread: one spike
        // drags the average the row leads with, and the middle value is what
        // says whether the line or the afternoon was slow.
        description: t("statistics.overview.ping_description",
            {min: formatLatencyWithUnit(ping.min, ms), max: formatLatencyWithUnit(ping.max, ms),
                median: formatLatencyWithUnit(ping.median, ms)}),
        value: formatLatencyWithUnit(ping.avg, ms),
        // The delta compares the raw averages, not the printed ones -
        // AverageChart's own stated convention: a percentage is the same in
        // either unit, and rounding both sides first reports a change that
        // is an artefact of the one decimal. The accepted edge: two windows
        // printing the same trimmed figure can show a small arrow, because
        // the measurement moved even though the display did not.
        delta: {current: pingAverage, previous: readableFigure(props.previous?.ping?.avg), higherIsBetter: false}
    });

    // The average duration sits on the card; what it hides is the spread, and a
    // range whose slowest test took ten times its fastest is a range where
    // something was wrong with the line rather than with the schedule. Both
    // ends must read - the spread()'s own rule one card over: a one-end gate
    // printed "2s – N/A", and a placeholder pair "-1s – -1s".
    if (readableFigure(props.time?.min) !== null && readableFigure(props.time?.max) !== null) items.push({
        icon: faHourglassHalf,
        title: t("statistics.overview.span_title"),
        description: t("statistics.overview.span_description"),
        value: `${formatDuration(props.time.min)} – ${formatDuration(props.time.max)}`,
        delta: null
    });

    const density = testsPerDay(props.tests.total, props.dateRange);

    if (density) items.push({
        icon: faCalendarDay,
        title: t("statistics.overview.density_title"),
        // A still-running range names both figures, so a rate over two and a
        // half days is not read as a claim about seven.
        description: density.elapsed
            ? t("statistics.overview.density_description_partial", {elapsed: density.elapsed, days: density.days})
            : t("statistics.overview.density_description", {days: density.days}),
        value: density.perDay,
        delta: null
    });

    // What the testing itself cost in traffic, told in the detail panel's own
    // words - this row states for the whole range what that panel states for
    // one test. Absent when no row measured it: rows from before the transfer
    // columns existed say nothing, not nought. A direction the provider never
    // reported renders as the panel's own N/A rather than as a zero.
    const dataUsed = props.dataUsed;
    // The shared reader, not a typeof: the bare gate rendered a placeholder
    // total as an N/A row with a delta arrow, and hid a text-spelled one.
    const dataTotal = readableFigure(dataUsed?.total);

    if (dataTotal !== null) items.push({
        icon: faDatabase,
        title: t("test.details.data_used"),
        description: t("test.details.data_used_value",
            {down: formatBytes(dataUsed.download), up: formatBytes(dataUsed.upload)}),
        value: formatBytes(dataUsed.total),
        // More traffic is neither good nor bad - it mostly tracks how many
        // tests ran - so the change is worth a word but not a colour.
        delta: {current: dataTotal, previous: readableFigure(props.previous?.dataUsed?.total), higherIsBetter: null}
    });

    return items;
};

export const OverviewChart = (props) => {
    const [preferences] = useContext(PreferencesContext);
    // The shared formatter rather than one of its own: that one named a day
    // without its year, which reads as this year for a range that is not - all
    // time spans whatever the instance has - and asked for the browser's
    // language instead of the one the app is set to.
    const title = t("test.overview.title_range", {
        from: formatDay(props.dateRange.from),
        to: formatDay(props.dateRange.to)
    });

    const rate = failureRate(props.tests.total, props.tests.failed);
    const previous = props.previous;

    // Through the shared reader, printer and delta alike: the average is
    // server-fed, and a proxied node can send the -1 placeholder - which the
    // bare typeof gate this replaces printed as "-1%" beside an arrow
    // computed from it - or a text figure an older node's payload spells,
    // which was hidden as N/A while being a reading.
    const packetLoss = readableFigure(props.packetLoss);

    // Each figure's change against the previous window, in the terms that suit
    // it: counts in absolute numbers, the duration as a percentage, packet loss
    // in points of the percentage it already is. The test count carries no
    // judgement either way, so it stays uncoloured.
    //
    // Both strings are resolved here rather than at the point they are rendered:
    // one of them interpolates two clock times, so a row cannot be described by
    // a bare key any more.
    const items = [
        {
            icon: faGaugeHigh,
            title: t("statistics.overview.total_title"),
            description: t("statistics.overview.total_description"),
            // The raw count: total is an array length on the server and
            // cannot be the -1 placeholder a measurement column can hold.
            value: props.tests.total,
            delta: {current: props.tests.total, previous: previous?.tests?.total,
                higherIsBetter: null, mode: "absolute"}
        },
        {
            icon: faCircleExclamation,
            title: t("statistics.overview.failed_title"),
            description: t("statistics.overview.failed_description"),
            // A count alone says nothing without the total beside it: 23 is a
            // rounding error across a year and an outage across an afternoon.
            // Through the shared percent rule: rate is failureRate's output,
            // already a non-negative number or null, so formatPercent prints
            // exactly what the hand-glued % printed - and the scan sees a
            // formatter instead of a raw gluing.
            value: rate === null ? props.tests.failed : `${props.tests.failed} (${formatPercent(rate)})`,
            delta: {current: props.tests.failed, previous: previous?.tests?.failed,
                higherIsBetter: false, mode: "absolute"}
        },
        {
            icon: faStopwatch,
            title: t("statistics.overview.average_title"),
            description: t("statistics.overview.average_description"),
            // The server returns an explicit null average when nothing in the
            // range succeeded, which used to render as the literal "nulls" -
            // and the delta reads like the loss row's, through the shared
            // reader, so a proxied node's placeholder cannot feed the arrow.
            // Optional on time itself: an older node's payload may not carry
            // the block at all, and an N/A row beats a crashed page.
            value: formatDuration(props.time?.avg),
            delta: {current: readableFigure(props.time?.avg), previous: readableFigure(previous?.time?.avg),
                higherIsBetter: false}
        },
        {
            // A broken link, not the square wave: that one means variation -
            // jitter here, standard deviation on the average cards - and this
            // row borrowing it left the same glyph standing for two unrelated
            // measurements on the same page.
            icon: faLinkSlash,
            title: t("statistics.overview.packet_loss_title"),
            description: t("statistics.overview.packet_loss_description"),
            // Absent when nothing in the range measured it - only Ookla reports
            // packet loss, and no measurement is not a clean line. The shared
            // percent rule over the already-coerced figure (idempotent), so
            // the printer and the delta read one column once.
            value: formatPercent(packetLoss),
            delta: {current: packetLoss, previous: readableFigure(previous?.packetLoss),
                higherIsBetter: false, mode: "absolute", unit: "%"}
        }
    ];

    // The one figure the hourly chart makes you eyeball: how far the line falls
    // between its best hour of the day and its worst. Absent for a range too
    // thin to say anything about a day, which is a row that does not render
    // rather than a slowdown of zero. No delta - the previous window's summary
    // does not carry its hourly buckets.
    const peak = peakSlowdown(props.hourlyAverages);

    if (peak) items.push({
        icon: faClockRotateLeft,
        title: t("statistics.overview.peak_title"),
        description: t("statistics.overview.peak_description", {
            slowest: formatHour(peak.slowestHour, preferences),
            fastest: formatHour(peak.fastestHour, preferences)
        }),
        value: `${peak.slowdown}%`,
        delta: null
    });

    // Opened, the card says the rest of what the page has aggregated and never
    // stated. These are deliberately not on the card: five rows is what fits
    // beside two others, and each of these needs its description read to mean
    // anything.
    if (props.expanded) items.push(...expandedItems(props));

    return (
        <StatisticContainer title={title} size="large" onClick={props.onClick}>
            <div className="overview-items">
                {items.map((item, index) => (
                    <PanelRow key={index} icon={item.icon} title={item.title} description={item.description}
                              value={<>{item.value}{item.delta && <Delta {...item.delta}/>}</>}/>
                ))}
            </div>
        </StatisticContainer>
    );

}