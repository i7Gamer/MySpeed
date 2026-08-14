import StatisticContainer from "@/pages/Statistics/components/StatisticContainer";
import PanelRow from "@/pages/Statistics/components/PanelRow";
import {t} from "i18next";
import {useContext} from "react";
import {
    faCalendarDay, faCircleExclamation, faClockRotateLeft, faGaugeHigh, faHourglassHalf,
    faLinkSlash, faPingPongPaddleBall, faStopwatch
} from "@fortawesome/free-solid-svg-icons";
import {
    formatDay, formatDuration, formatHour, formatWithUnit, NOT_MEASURED
} from "@/common/utils/FormatUtil";
import {failureRate} from "@/common/utils/TestUtil";
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
 */
const testsPerDay = (total, dateRange) => {
    const days = daysCovered(dateRange);
    if (days === null || days <= 0) return null;

    return {perDay: parseFloat((total / days).toFixed(PER_DAY_DECIMALS)), days};
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

    // Explicitly null for a range in which nothing succeeded, which is a row
    // that does not render rather than "Average latency, between N/A and N/A".
    const ping = props.ping?.avg === null || props.ping?.avg === undefined ? null : props.ping;

    if (ping) items.push({
        icon: faPingPongPaddleBall,
        title: t("latest.ping"),
        description: t("statistics.overview.ping_description",
            {min: formatWithUnit(ping.min, ms), max: formatWithUnit(ping.max, ms)}),
        value: formatWithUnit(ping.avg, ms),
        delta: {current: ping.avg, previous: props.previous?.ping?.avg, higherIsBetter: false}
    });

    // The average duration sits on the card; what it hides is the spread, and a
    // range whose slowest test took ten times its fastest is a range where
    // something was wrong with the line rather than with the schedule.
    if (props.time?.min !== null && props.time?.min !== undefined) items.push({
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
        description: t("statistics.overview.density_description", {days: density.days}),
        value: density.perDay,
        delta: null
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
            value: rate === null ? props.tests.failed : `${props.tests.failed} (${rate}%)`,
            delta: {current: props.tests.failed, previous: previous?.tests?.failed,
                higherIsBetter: false, mode: "absolute"}
        },
        {
            icon: faStopwatch,
            title: t("statistics.overview.average_title"),
            description: t("statistics.overview.average_description"),
            // The server returns an explicit null average when nothing in the
            // range succeeded, which used to render as the literal "nulls".
            value: formatDuration(props.time.avg),
            delta: {current: props.time.avg, previous: previous?.time?.avg,
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
            // packet loss, and no measurement is not a clean line. "%" binds to
            // its number without a space, unlike the spaced units.
            value: typeof props.packetLoss === "number" ? `${props.packetLoss}%` : NOT_MEASURED,
            delta: {current: props.packetLoss, previous: previous?.packetLoss,
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