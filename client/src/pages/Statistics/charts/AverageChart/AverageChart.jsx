import StatisticContainer from "@/pages/Statistics/components/StatisticContainer";
import PanelRow from "@/pages/Statistics/components/PanelRow";
import {
    faCompress, faGauge, faGaugeHigh, faMinusCircle, faPlusCircle
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

    const speed = (mbps) => formatWithUnit(convertSpeed(mbps, preferences), speedUnit);

    return (
        <StatisticContainer title={props.title} size="small" center={true} onClick={props.onClick}>
            <div className="value-container">
                {/* Formatted rather than interpolated: the server returns an
                    explicit null for a range in which nothing succeeded, and
                    `{value} {unit}` around that left a bare "Mbps" standing on
                    its own. */}
                <PanelRow icon={faMinusCircle} title={t("statistics.values.min")}
                          value={speed(props.data.min)}/>

                <PanelRow icon={faPlusCircle} title={t("statistics.values.max")}
                          value={speed(props.data.max)}/>

                <PanelRow icon={faGauge} title={t("statistics.values.avg")}
                          /* The delta compares the raw averages, before the unit
                             conversion: a percentage is the same in either unit,
                             and converting first would round twice. Only the
                             average carries one - the min and max of two windows
                             are single outliers, and their difference reads as
                             noise. */
                          value={<>
                              {speed(props.data.avg)}
                              <Delta current={props.data.avg} previous={props.previous?.avg} higherIsBetter={true}/>
                          </>}
                          description={reached !== null && <>
                              {/* Graded by the same three buckets every other
                                  speed on the page is coloured by, so "86%" here
                                  and a green arrow on the overview cannot
                                  disagree about whether the line is meeting its
                                  target. */}
                              <span className={"icon-" + level}>
                                  {t("test.details.of_target", {percent: reached})}
                              </span>

                              {/* Opened, the percentage gets the bar the expanded
                                  test row draws for the same figure, and the
                                  optimum it is measured against gets named - it
                                  lives in a settings dialog nobody has open
                                  while reading this. */}
                              {props.expanded && (
                                  <>
                                      <span className="value-bar">
                                          <span className={"value-bar-fill icon-" + level}
                                                style={{width: `${Math.min(reached, MAX_BAR_PERCENT)}%`}}/>
                                      </span>
                                      <span>
                                          {t("statistics.values.target",
                                              {target: speed(Number(props.target))})}
                                      </span>
                                  </>
                              )}
                          </>}/>

                {/* An average says nothing on its own about whether the line
                    held there or swung either side of it, and the stability
                    card scores that a page away from the numbers it is about.

                    A tight range for the glyph, not the square wave. Both are
                    about variation, but the wave is jitter's - latency moving
                    within a single test - and this is how far throughput swung
                    across every test in the range. The two sit on the same page,
                    so they cannot share a glyph. */}
                {props.expanded && (
                    <PanelRow icon={faCompress} title={t("statistics.values.consistency")}
                              level={consistencyColour(steadiness.consistency)}
                              value={steadiness.consistency === null || steadiness.consistency === undefined
                                  ? NOT_MEASURED : `${steadiness.consistency}%`}
                              description={steadiness.stdDev !== null && steadiness.stdDev !== undefined
                                  && <span>{"±" + speed(steadiness.stdDev)}</span>}/>
                )}

                {props.expanded && measured !== null && (
                    <PanelRow icon={faGaugeHigh} title={t("statistics.values.samples")} value={measured}/>
                )}
            </div>
        </StatisticContainer>
    );

}