import StatisticContainer from "@/pages/Statistics/components/StatisticContainer";
import {t} from "i18next";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faCircleExclamation, faGaugeHigh, faStopwatch, faWaveSquare} from "@fortawesome/free-solid-svg-icons";
import {formatDay, formatDuration, NOT_MEASURED} from "@/common/utils/FormatUtil";
import {failureRate} from "@/common/utils/TestUtil";
import Delta from "@/common/components/Delta";
import "./styles.sass";

export const OverviewChart = (props) => {
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
    const items = [
        {
            icon: faGaugeHigh,
            title: "statistics.overview.total_title",
            description: "statistics.overview.total_description",
            value: props.tests.total,
            delta: {current: props.tests.total, previous: previous?.tests?.total,
                higherIsBetter: null, mode: "absolute"}
        },
        {
            icon: faCircleExclamation,
            title: "statistics.overview.failed_title",
            description: "statistics.overview.failed_description",
            // A count alone says nothing without the total beside it: 23 is a
            // rounding error across a year and an outage across an afternoon.
            value: rate === null ? props.tests.failed : `${props.tests.failed} (${rate}%)`,
            delta: {current: props.tests.failed, previous: previous?.tests?.failed,
                higherIsBetter: false, mode: "absolute"}
        },
        {
            icon: faStopwatch,
            title: "statistics.overview.average_title",
            description: "statistics.overview.average_description",
            // The server returns an explicit null average when nothing in the
            // range succeeded, which used to render as the literal "nulls".
            value: formatDuration(props.time.avg),
            delta: {current: props.time.avg, previous: previous?.time?.avg,
                higherIsBetter: false}
        },
        {
            icon: faWaveSquare,
            title: "statistics.overview.packet_loss_title",
            description: "statistics.overview.packet_loss_description",
            // Absent when nothing in the range measured it - only Ookla reports
            // packet loss, and no measurement is not a clean line. "%" binds to
            // its number without a space, unlike the spaced units.
            value: typeof props.packetLoss === "number" ? `${props.packetLoss}%` : NOT_MEASURED,
            delta: {current: props.packetLoss, previous: previous?.packetLoss,
                higherIsBetter: false, mode: "absolute", unit: "%"}
        }
    ];

    return (
        <StatisticContainer title={title} size="large" onClick={props.onClick}>
            <div className="overview-items">
                {items.map((item, index) => (
                    <div className="overview-item" key={index}>
                        <div className="info-area">
                            <FontAwesomeIcon icon={item.icon} />
                            <div className="text-area">
                                <h2>{t(item.title)}</h2>
                                <p>{t(item.description)}</p>
                            </div>
                        </div>
                        <h2>{item.value}<Delta {...item.delta}/></h2>
                    </div>
                ))}
            </div>
        </StatisticContainer>
    );

}