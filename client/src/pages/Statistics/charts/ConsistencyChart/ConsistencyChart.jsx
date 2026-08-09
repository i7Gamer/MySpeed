import { useContext, useMemo } from "react";
import { t } from "i18next";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowDown, faArrowUp, faGaugeHigh, faPingPongPaddleBall } from "@fortawesome/free-solid-svg-icons";
import { bufferbloatColour, bufferbloatTrend } from "@/common/utils/TestUtil";
import { formatDateTime } from "@/common/utils/FormatUtil";
import StatisticContainer from "@/pages/Statistics/components/StatisticContainer";
import { PreferencesContext } from "@/common/contexts/Preferences";
import { convertSpeed, getSpeedUnit, NOT_MEASURED } from "@/common/utils/FormatUtil";
import "./styles.sass";

export const ConsistencyChart = (props) => {
    const [preferences] = useContext(PreferencesContext);
    const speedUnit = getSpeedUnit(preferences);

    const data = useMemo(() => {
        if (!props.consistency) return null;
        return props.consistency;
    }, [props.consistency]);

    const trend = bufferbloatTrend(props.recentTests);

    if (!data) return null;

    /**
     * Neutral when there is no score, rather than red.
     *
     * A range in which every test failed has no consistency to report, and the
     * worst possible colour is as wrong an answer as the best one - it says the
     * line is unstable when nothing was measured.
     */
    const getConsistencyColor = (value) => {
        if (value === null || value === undefined) return 'icon-blue';
        if (value >= 90) return 'icon-green';
        if (value >= 70) return 'icon-orange';
        return 'icon-red';
    };

    const percentage = (value) => value === null || value === undefined ? NOT_MEASURED : `${value}%`;

    const deviation = (value, unit) =>
        value === null || value === undefined ? NOT_MEASURED : `±${value} ${unit}`;

    return (
        <StatisticContainer title={t("statistics.consistency.title")} onClick={props.onClick}>
            <div className="consistency-container">
                <div className="consistency-item">
                    <div className="consistency-info">
                        <h2>{t("latest.down")}</h2>
                        <p className={getConsistencyColor(data.download.consistency)}>
                            {percentage(data.download.consistency)}
                        </p>
                        <span className="consistency-detail">
                            {deviation(convertSpeed(data.download.stdDev, preferences), speedUnit)}
                        </span>
                    </div>
                    <FontAwesomeIcon icon={faArrowDown} className={getConsistencyColor(data.download.consistency)} />
                </div>

                <div className="consistency-item">
                    <div className="consistency-info">
                        <h2>{t("latest.up")}</h2>
                        <p className={getConsistencyColor(data.upload.consistency)}>
                            {percentage(data.upload.consistency)}
                        </p>
                        <span className="consistency-detail">
                            {deviation(convertSpeed(data.upload.stdDev, preferences), speedUnit)}
                        </span>
                    </div>
                    <FontAwesomeIcon icon={faArrowUp} className={getConsistencyColor(data.upload.consistency)} />
                </div>

                <div className="consistency-item">
                    <div className="consistency-info">
                        <h2>{t("latest.ping")}</h2>
                        <p className={data.ping.stdDev === null ? "icon-blue" : "icon-orange"}>
                            {deviation(data.ping.stdDev, t("latest.ping_unit"))}
                        </p>
                        <span className="consistency-detail">{t("statistics.consistency.ping_variance")}</span>
                    </div>
                    <FontAwesomeIcon icon={faPingPongPaddleBall} className="icon-orange" />
                </div>

                {/* Bufferbloat is stability under load, so its grade sits with
                    the other steadiness figures, and the recent grades are its
                    detail line - the trend is where a regression shows. */}
                {trend.length > 0 && (
                    <div className="consistency-item">
                        <div className="consistency-info">
                            <h2>{t("latest.quality")}</h2>
                            <p className={"icon-" + bufferbloatColour(trend.at(-1).grade)}
                               title={t("latest.bufferbloat", {increase: trend.at(-1).increase})}>
                                {trend.at(-1).grade}
                            </p>
                            <span className="consistency-detail bufferbloat-trend"
                                  title={t("latest.bufferbloat_trend")}>
                                {trend.map((entry) => (
                                    <span key={entry.created}
                                          className={"bufferbloat-trend-grade icon-" + bufferbloatColour(entry.grade)}
                                          title={formatDateTime(entry.created, preferences) + " · " +
                                              t("latest.bufferbloat", {increase: entry.increase})}>
                                        {entry.grade}
                                    </span>
                                ))}
                            </span>
                        </div>
                        <FontAwesomeIcon icon={faGaugeHigh}
                                         className={"icon-" + bufferbloatColour(trend.at(-1).grade)} />
                    </div>
                )}
            </div>
        </StatisticContainer>
    );
};