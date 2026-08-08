import StatisticContainer from "@/pages/Statistics/components/StatisticContainer";
import {t} from "i18next";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faCircleExclamation, faGaugeHigh, faStopwatch} from "@fortawesome/free-solid-svg-icons";
import {formatDuration} from "@/common/utils/FormatUtil";
import {failureRate} from "@/common/utils/TestUtil";
import "./styles.sass";

export const OverviewChart = (props) => {
    const formatDateForTitle = (date) => {
        return date.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
    };

    const title = t("test.overview.title_range", { 
        from: formatDateForTitle(props.dateRange.from), 
        to: formatDateForTitle(props.dateRange.to) 
    });

    const rate = failureRate(props.tests.total, props.tests.failed);

    const items = [
        {
            icon: faGaugeHigh,
            title: "statistics.overview.total_title",
            description: "statistics.overview.total_description",
            value: props.tests.total
        },
        {
            icon: faCircleExclamation,
            title: "statistics.overview.failed_title",
            description: "statistics.overview.failed_description",
            // A count alone says nothing without the total beside it: 23 is a
            // rounding error across a year and an outage across an afternoon.
            value: rate === null ? props.tests.failed : `${props.tests.failed} (${rate}%)`
        },
        {
            icon: faStopwatch,
            title: "statistics.overview.average_title",
            description: "statistics.overview.average_description",
            // The server returns an explicit null average when nothing in the
            // range succeeded, which used to render as the literal "nulls".
            value: formatDuration(props.time.avg)
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
                        <h2>{item.value}</h2>
                    </div>
                ))}
            </div>
        </StatisticContainer>
    );

}