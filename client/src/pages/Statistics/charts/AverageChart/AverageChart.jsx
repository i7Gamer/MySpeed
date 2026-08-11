import StatisticContainer from "@/pages/Statistics/components/StatisticContainer";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faGauge, faMinusCircle, faPlusCircle} from "@fortawesome/free-solid-svg-icons";
import {useContext} from "react";
import {t} from "i18next";
import {PreferencesContext} from "@/common/contexts/Preferences";
import {convertSpeed, formatWithUnit, getSpeedUnit} from "@/common/utils/FormatUtil";
import {getIconBySpeed} from "@/common/utils/TestUtil";
import {percentOfTarget} from "@/common/components/TestDetails/utils/details";
import Delta from "@/common/components/Delta";
import "./styles.sass";

export const AverageChart = (props) => {
    const [preferences] = useContext(PreferencesContext);
    const speedUnit = getSpeedUnit(preferences);

    /**
     * How much of the optimum configured in the settings the range reached.
     *
     * Not the same reading as the connection-stability score, which divides the
     * line by itself: a line that steadily delivers a twentieth of what it was
     * sold as scores near 100% there and 5% here. The label says "of your
     * target" for exactly that reason - a bare percentage beside one that means
     * steadiness reads as the same measurement twice.
     *
     * On the average only. The min and max of a range are single tests, and a
     * percentage on the slowest one reads as a verdict on the connection rather
     * than on one bad afternoon - the delta below is left off them for the same
     * reason. Null when no target is set or nothing in the range succeeded,
     * which renders as no line at all.
     *
     * Taken on the raw Mbps, before the unit conversion: the configured target
     * is in Mbps whatever the reader has chosen to see, and a ratio is the same
     * number in either unit anyway.
     */
    const reached = percentOfTarget(props.data.avg, props.target);

    return (
        <StatisticContainer title={props.title} size="small" center={true} onClick={props.onClick}>
            <div className="value-container">
                {/* Formatted rather than interpolated: the server returns an
                    explicit null for a range in which nothing succeeded, and
                    `{value} {unit}` around that left a bare "Mbps" standing on
                    its own. */}
                <div className="value-item">
                    <div className="value-info">
                        <h2>{t("statistics.values.min")}</h2>
                        <p>{formatWithUnit(convertSpeed(props.data.min, preferences), speedUnit)}</p>
                    </div>
                    <FontAwesomeIcon icon={faMinusCircle}/>
                </div>
                <div className="value-item">
                    <div className="value-info">
                        <h2>{t("statistics.values.max")}</h2>
                        <p>{formatWithUnit(convertSpeed(props.data.max, preferences), speedUnit)}</p>
                    </div>
                    <FontAwesomeIcon icon={faPlusCircle}/>
                </div>
                <div className="value-item">
                    <div className="value-info">
                        <h2>{t("statistics.values.avg")}</h2>
                        {/* The delta compares the raw averages, before the
                            unit conversion: a percentage is the same in
                            either unit, and converting first would round
                            twice. Only the average carries one - the min and
                            max of two windows are single outliers, and their
                            difference reads as noise. */}
                        <p>
                            {formatWithUnit(convertSpeed(props.data.avg, preferences), speedUnit)}
                            <Delta current={props.data.avg} previous={props.previous?.avg} higherIsBetter={true}/>
                        </p>
                        {/* Graded by the same three buckets every other speed on
                            the page is coloured by, so "86%" here and a green
                            arrow on the overview cannot disagree about whether
                            the line is meeting its target. */}
                        {reached !== null && (
                            <span className={"value-target icon-" + getIconBySpeed(props.data.avg, props.target, true)}>
                                {t("test.details.of_target", {percent: reached})}
                            </span>
                        )}
                    </div>
                    <FontAwesomeIcon icon={faGauge}/>
                </div>
            </div>
        </StatisticContainer>
    );

}