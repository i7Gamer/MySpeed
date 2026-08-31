import {useContext, useMemo} from "react";
import {t} from "i18next";
import StatisticContainer from "@/pages/Statistics/components/StatisticContainer";
import Delta from "@/common/components/Delta";
import {PreferencesContext} from "@/common/contexts/Preferences";
import {
    convertSpeed, formatLatencyWithUnit, formatPercent, formatWithUnit, getSpeedUnit, wholeSpeed
} from "@/common/utils/FormatUtil";
import {targetColour} from "@/common/utils/TargetUtil";
import {targetSummaries} from "./targetCompare";
import "./styles.sass";

// The metric columns, which the "couldn't load" cell has to span along with
// the failure rate beside them - counted rather than written as a number, so a
// column added to the header cannot leave that cell one short.
const METRIC_COLUMNS = 3;

/**
 * The figures the three overlay charts cannot draw: the averages as numbers,
 * their deltas against the previous window, and the failure rate - which has no
 * series at all and would otherwise be visible nowhere.
 *
 * Its own panel, beside the charts rather than inside one of them. It answers
 * for all three metrics at once, so living in the download chart's expansion
 * would have made two thirds of it unreachable from the metric it describes.
 *
 * @param fresh whether statsById answers for the range on screen
 */
export const TargetCompareTable = ({targets, statsById, fresh, expanded, onClick}) => {
    const [preferences] = useContext(PreferencesContext);
    const speedUnit = getSpeedUnit(preferences);

    const rows = useMemo(() => targetSummaries(targets, statsById), [targets, statsById]);

    // Whole numbers on the card, the conversion's decimals in the enlarged
    // view - the value cards' own precision rule, kept so the two surfaces
    // cannot state different figures for one payload.
    const speed = (mbps) => formatWithUnit(
        expanded ? convertSpeed(mbps, preferences) : wholeSpeed(mbps, preferences), speedUnit);

    const table = (
        <table className="target-compare-table">
            <thead>
                <tr>
                    <th scope="col">{t("targets.title")}</th>
                    <th scope="col">{t("latest.down")}</th>
                    <th scope="col">{t("latest.up")}</th>
                    <th scope="col">{t("latest.ping")}</th>
                    <th scope="col">{t("statistics.targets.failure_rate")}</th>
                </tr>
            </thead>
            <tbody>
                {rows.map((row) => (
                    <tr key={row.id}>
                        <th scope="row">
                            <span className="target-dot" style={{background: targetColour(row.colourIndex)}}/>
                            {row.name}
                        </th>
                        {row.unavailable ? (
                            // A failed fetch is not a line that answered with
                            // nothing - it must not wear the honest N/A.
                            <td colSpan={METRIC_COLUMNS + 1} className="target-compare-unavailable">
                                {t("statistics.targets.unavailable")}
                            </td>
                        ) : (
                            /*
                             * The deltas compare the measurements, never the
                             * printed figures: a delta taken from speed()
                             * would move with the reader's unit preference
                             * and differ between this card and its modal,
                             * which is what the shared printer exists to
                             * prevent. The edge that buys, stated: the
                             * collapsed card rounds to whole units, so 899.6
                             * and 904.4 both print "900" with an arrow
                             * between them - wider than the one decimal the
                             * overview already accepts, and wider again in
                             * MB/s, where a whole unit is eight Mbit/s.
                             */
                            <>
                                <td>{speed(row.download)}
                                    <Delta current={row.download} previous={row.previous?.download}
                                           higherIsBetter={true}/></td>
                                <td>{speed(row.upload)}
                                    <Delta current={row.upload} previous={row.previous?.upload}
                                           higherIsBetter={true}/></td>
                                <td>{formatLatencyWithUnit(row.ping, t("latest.ping_unit"))}
                                    <Delta current={row.ping} previous={row.previous?.ping}
                                           higherIsBetter={false}/></td>
                                {/* Points of the percentage it already is,
                                    like the overview's loss row: 5% to 7% is
                                    two points, not forty per cent. */}
                                <td>{formatPercent(row.failureRate)}
                                    <Delta current={row.failureRate} previous={row.previous?.failureRate}
                                           higherIsBetter={false} mode="absolute" unit="%"/></td>
                            </>
                        )}
                    </tr>
                ))}
            </tbody>
        </table>
    );

    return (
        <StatisticContainer title={t("statistics.targets.title")} size="wide" onClick={onClick}>
            <div className="target-compare-panel">
                {fresh ? table
                    : <p className="target-compare-hint">{t("statistics.detail.loading")}</p>}
            </div>
        </StatisticContainer>
    );
};

export default TargetCompareTable;
