import { useContext, useMemo } from "react";
import { t } from "i18next";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
    faArrowDown, faArrowUp, faGaugeHigh, faPingPongPaddleBall, faWaveSquare
} from "@fortawesome/free-solid-svg-icons";
import { bufferbloatColour, gradeForIncrease, jitterColour } from "@/common/utils/TestUtil";
import { formatDateTime } from "@/common/utils/FormatUtil";
import StatisticContainer from "@/pages/Statistics/components/StatisticContainer";
import { PreferencesContext } from "@/common/contexts/Preferences";
import { convertSpeed, formatWithUnit, getSpeedUnit, NOT_MEASURED } from "@/common/utils/FormatUtil";
import "./styles.sass";

export const ConsistencyChart = (props) => {
    const [preferences] = useContext(PreferencesContext);
    const speedUnit = getSpeedUnit(preferences);

    const data = useMemo(() => {
        if (!props.consistency) return null;
        return props.consistency;
    }, [props.consistency]);

    if (!data) return null;

    // Every figure in this panel is taken over the selected range, this one
    // included: it used to be the grade of the single newest test, from a
    // request that carried no range at all.
    const loaded = data.loadedLatency;
    const loadedGrade = gradeForIncrease(loaded?.increase);
    const trend = loaded?.trend ?? [];

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

    /**
     * The two ends the deviation above is a summary of, for the enlarged view.
     *
     * A standard deviation is the honest figure and an unreadable one: nobody
     * has an intuition for ±34 Mbps, and everybody has one for "between 180 and
     * 260". Null for anything not measured, which renders as no line at all
     * rather than as a range ending in "N/A".
     */
    const spread = (range, format = (value) => value) => {
        if (!props.expanded || !range) return null;
        if (range.min === null || range.min === undefined) return null;

        return t("statistics.consistency.range", {min: format(range.min), max: format(range.max)});
    };

    const ranges = props.ranges ?? {};
    const speed = (value) => formatWithUnit(convertSpeed(value, preferences), speedUnit);
    const latency = (value) => formatWithUnit(value, t("latest.ping_unit"));

    const spreads = {
        download: spread(ranges.download, speed),
        upload: spread(ranges.upload, speed),
        ping: spread(ranges.ping, latency),
        jitter: spread(ranges.jitter, latency)
    };

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
                        {spreads.download && <span className="consistency-detail">{spreads.download}</span>}
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
                        {spreads.upload && <span className="consistency-detail">{spreads.upload}</span>}
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
                        {spreads.ping && <span className="consistency-detail">{spreads.ping}</span>}
                    </div>
                    <FontAwesomeIcon icon={faPingPongPaddleBall} className="icon-orange" />
                </div>

                {/* The ping row above says how far apart two tests' latencies
                    were; this one says how far apart the packets of a single
                    test were, which is the figure a call actually stutters on.
                    The server has averaged it over the range since the
                    consistency block existed and nothing has ever shown it. */}
                <div className="consistency-item">
                    <div className="consistency-info">
                        <h2>{t("latest.jitter")}</h2>
                        <p className={"icon-" + jitterColour(data.ping.jitter)}>
                            {formatWithUnit(data.ping.jitter, t("latest.jitter_unit"))}
                        </p>
                        <span className="consistency-detail">{t("statistics.consistency.jitter_detail")}</span>
                        {spreads.jitter && <span className="consistency-detail">{spreads.jitter}</span>}
                    </div>
                    <FontAwesomeIcon icon={faWaveSquare}
                                     className={"icon-" + jitterColour(data.ping.jitter)} />
                </div>

                {/* Bufferbloat is stability under load, so it sits with the
                    other steadiness figures - and like them it is the average
                    over the range, not the last reading. The dots are the
                    recent gradings within that same range. */}
                {loadedGrade !== null && (
                    <div className="consistency-item">
                        <div className="consistency-info">
                            <h2>{t("latest.quality")}</h2>
                            <p className={"icon-" + bufferbloatColour(loadedGrade)}
                               title={t("statistics.consistency.loaded_latency_average",
                                   {increase: loaded.increase, tests: loaded.tests})}>
                                {loadedGrade}
                            </p>
                            {/* One dot per recent test rather than the letters.
                                Grades run together as text - "A+A" splits two
                                ways - where dots read as a history at a glance.
                                role="img" with the grades spelled out in the
                                label, because colour alone is not a reading a
                                screen reader can take. */}
                            <span className="consistency-detail bufferbloat-trend"
                                  role="img"
                                  title={t("latest.bufferbloat_trend")}
                                  aria-label={t("latest.bufferbloat_trend") + ": " +
                                      trend.map((entry) => gradeForIncrease(entry.increase)).join(", ")}>
                                {trend.map((entry) => (
                                    <span key={entry.created}
                                          className={"bufferbloat-trend-dot icon-"
                                              + bufferbloatColour(gradeForIncrease(entry.increase))}
                                          // The grade leads: it is no longer
                                          // written anywhere the pointer is.
                                          title={gradeForIncrease(entry.increase) + " · " +
                                              formatDateTime(entry.created, preferences) + " · " +
                                              t("latest.bufferbloat", {increase: entry.increase})}/>
                                ))}
                            </span>
                            {/* How many tests the average is over. It has only
                                ever been in the title above, where a grade of
                                "A" from three tests and one from three hundred
                                look exactly alike. */}
                            {props.expanded && (
                                <span className="consistency-detail">
                                    {t("statistics.consistency.sample_count", {tests: loaded.tests})}
                                </span>
                            )}
                        </div>
                        <FontAwesomeIcon icon={faGaugeHigh}
                                         className={"icon-" + bufferbloatColour(loadedGrade)} />
                    </div>
                )}
            </div>
        </StatisticContainer>
    );
};