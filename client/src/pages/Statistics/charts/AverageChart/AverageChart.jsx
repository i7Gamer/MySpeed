import StatisticContainer from "@/pages/Statistics/components/StatisticContainer";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {
    faGauge, faGaugeHigh, faMinusCircle, faPlusCircle, faWaveSquare
} from "@fortawesome/free-solid-svg-icons";
import {useContext} from "react";
import {t} from "i18next";
import {PreferencesContext} from "@/common/contexts/Preferences";
import {convertSpeed, formatWithUnit, getSpeedUnit, NOT_MEASURED} from "@/common/utils/FormatUtil";
import {consistencyColour, getIconBySpeed} from "@/common/utils/TestUtil";
import {percentOfTarget} from "@/common/components/TestDetails/utils/details";
import Delta from "@/common/components/Delta";
import "./styles.sass";

// The bar would otherwise run off its track on a line that beats its target,
// which is the one case where the number is unambiguously good news - the same
// rule the expanded test row's bars follow.
const MAX_BAR_PERCENT = 100;

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
    const level = getIconBySpeed(props.data.avg, props.target, true);

    // How steady this metric was, and how many tests all three figures above are
    // over. Both are on the page already and neither is beside the numbers they
    // qualify: a minimum taken over eleven tests and one taken over eleven
    // thousand are the same number and not the same claim.
    const steadiness = props.consistency ?? {};
    const measured = props.tests ? props.tests.total - props.tests.failed : null;

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
                            <span className={"value-target icon-" + level}>
                                {t("test.details.of_target", {percent: reached})}
                            </span>
                        )}

                        {/* Opened, the percentage gets the bar the expanded test
                            row draws for the same figure, and the optimum it is
                            measured against gets named - it lives in a settings
                            dialog nobody has open while reading this. */}
                        {props.expanded && reached !== null && (
                            <>
                                <span className="value-bar">
                                    <span className={"value-bar-fill icon-" + level}
                                          style={{width: `${Math.min(reached, MAX_BAR_PERCENT)}%`}}/>
                                </span>
                                <span className="value-target value-target-muted">
                                    {t("statistics.values.target",
                                        {target: formatWithUnit(convertSpeed(Number(props.target), preferences), speedUnit)})}
                                </span>
                            </>
                        )}
                    </div>
                    <FontAwesomeIcon icon={faGauge}/>
                </div>

                {/* An average says nothing on its own about whether the line
                    held there or swung either side of it, and the stability
                    card scores that a page away from the numbers it is about. */}
                {props.expanded && (
                    <div className="value-item">
                        <div className="value-info">
                            <h2>{t("statistics.values.consistency")}</h2>
                            <p className={"icon-" + consistencyColour(steadiness.consistency)}>
                                {steadiness.consistency === null || steadiness.consistency === undefined
                                    ? NOT_MEASURED : `${steadiness.consistency}%`}
                            </p>
                            {steadiness.stdDev !== null && steadiness.stdDev !== undefined && (
                                <span className="value-target value-target-muted">
                                    {"±" + formatWithUnit(convertSpeed(steadiness.stdDev, preferences), speedUnit)}
                                </span>
                            )}
                        </div>
                        <FontAwesomeIcon icon={faWaveSquare}
                                         className={"icon-" + consistencyColour(steadiness.consistency)}/>
                    </div>
                )}

                {props.expanded && measured !== null && (
                    <div className="value-item">
                        <div className="value-info">
                            <h2>{t("statistics.values.samples")}</h2>
                            <p>{measured}</p>
                        </div>
                        <FontAwesomeIcon icon={faGaugeHigh}/>
                    </div>
                )}
            </div>
        </StatisticContainer>
    );

}