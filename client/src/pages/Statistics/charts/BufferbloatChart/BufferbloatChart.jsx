import StatisticContainer from "@/pages/Statistics/components/StatisticContainer";
import {bufferbloatColour, bufferbloatTrend} from "@/common/utils/TestUtil";
import {formatDateTime} from "@/common/utils/FormatUtil";
import {PreferencesContext} from "@/common/contexts/Preferences";
import {useContext} from "react";
import {t} from "i18next";
import "./styles.sass";

/**
 * Its own tile rather than a row squeezed into the latest-test card: every tile
 * shares a fixed content height, and a fourth row plus a trend strip clipped
 * against it. The grade is a first-class measurement now, so it gets what the
 * averages get - a small tile of its own.
 */
export const BufferbloatChart = (props) => {
    const [preferences] = useContext(PreferencesContext);

    const trend = bufferbloatTrend(props.recentTests);

    // Nothing measured, nothing claimed: providers other than Ookla never
    // report loaded latency, and an empty tile would just say "no data" forever.
    if (trend.length === 0) return null;

    const latest = trend.at(-1);

    return (
        <StatisticContainer title={t("statistics.bufferbloat.title")} size="small" center={true}
                            onClick={props.onClick}>
            <div className="bufferbloat-container">
                <span className={"bufferbloat-headline icon-" + bufferbloatColour(latest.grade)}>
                    {latest.grade}
                </span>
                <p className="bufferbloat-caption">
                    {t("test.details.bufferbloat_value", {increase: latest.increase})}
                </p>

                {/* One grade says what the last test did; the trend is where a
                    regression shows. Only once there is something to compare -
                    a "trend" of one entry is just the grade again. */}
                {trend.length > 1 && (
                    <div className="bufferbloat-trend" title={t("latest.bufferbloat_trend")}>
                        {trend.map((entry) => (
                            <span key={entry.created}
                                  className={"bufferbloat-trend-grade icon-" + bufferbloatColour(entry.grade)}
                                  title={formatDateTime(entry.created, preferences) + " · " +
                                      t("latest.bufferbloat", {increase: entry.increase})}>
                                {entry.grade}
                            </span>
                        ))}
                    </div>
                )}
            </div>
        </StatisticContainer>
    );
};
