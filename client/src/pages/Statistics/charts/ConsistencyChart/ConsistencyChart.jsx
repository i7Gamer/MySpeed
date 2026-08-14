import { useContext, useMemo } from "react";
import { t } from "i18next";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
    faArrowDown, faArrowUp, faGaugeHigh, faPingPongPaddleBall, faWaveSquare
} from "@fortawesome/free-solid-svg-icons";
import {
    bufferbloatColour, consistencyColour, gradeForIncrease, jitterColour, pingDeviationColour
} from "@/common/utils/TestUtil";
import { formatDateTime } from "@/common/utils/FormatUtil";
import StatisticContainer from "@/pages/Statistics/components/StatisticContainer";
import { PreferencesContext } from "@/common/contexts/Preferences";
import {
    convertSpeed, formatLatency, formatLatencyWithUnit, formatWithUnit, getSpeedUnit, LATENCY_STEP,
    NOT_MEASURED, roundsToZeroLatency
} from "@/common/utils/FormatUtil";
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

    // The thresholds live beside the app's other colour graders, so the value
    // cards can score their own steadiness by the same rule this card does.
    const getConsistencyColor = (value) => "icon-" + consistencyColour(value);

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
    // Trimmed to the one decimal a card prints a latency at: the server sends
    // the two it stores, and this card read "5.23 ms" one panel away from a
    // latest-test card reading "5.2 ms" for the same measurement. The same
    // trim goes on the jitter average and the ping deviation below.
    const latency = (value) => formatLatencyWithUnit(value, t("latest.ping_unit"));

    // Graded from the trimmed figure, not the stored one, exactly as the jitter
    // below is: the row prints one decimal and the thresholds are exact, so
    // grading 1.96 would put a green beside a value reading "±2 ms". One
    // expression for the value and the icon - they said different things about
    // the same measurement for as long as the icon was a constant.
    const pingGrade = "icon-" + pingDeviationColour(formatLatency(data.ping.deviation));

    /**
     * The spread, or the statement that it is smaller than can be shown.
     *
     * The server sends this at two decimals and the row prints one, so anything
     * under 0.05 rounded to a bare "0" - indistinguishable from a line whose
     * latency did not move at all, which on this row is the strongest claim
     * there is. Both readings occur on one instance: a history of whole-
     * millisecond pings really does deviate by exactly nothing, because more
     * than half the tests land on the median, while its newer rows sit a few
     * hundredths apart.
     *
     * The bound rather than a second decimal, so the row keeps the one
     * precision every latency on this card is printed at.
     */
    const pingDeviationText = roundsToZeroLatency(data.ping.deviation)
        ? `±<${LATENCY_STEP} ${t("latest.ping_unit")}`
        : deviation(formatLatency(data.ping.deviation), t("latest.ping_unit"));

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
                        <p className={pingGrade}>{pingDeviationText}</p>
                        <span className="consistency-detail">{t("statistics.consistency.ping_deviation")}</span>
                        {spreads.ping && <span className="consistency-detail">{spreads.ping}</span>}
                    </div>
                    <FontAwesomeIcon icon={faPingPongPaddleBall} className={pingGrade} />
                </div>

                {/* The ping row above says how far apart two tests' latencies
                    were; this one says how far apart the packets of a single
                    test were, which is the figure a call actually stutters on.
                    The server has averaged it over the range since the
                    consistency block existed and nothing has ever shown it. */}
                <div className="consistency-item">
                    <div className="consistency-info">
                        <h2>{t("latest.jitter")}</h2>
                        <p className={"icon-" + jitterColour(formatLatency(data.ping.jitter))}>
                            {formatLatencyWithUnit(data.ping.jitter, t("latest.jitter_unit"))}
                        </p>
                        <span className="consistency-detail">{t("statistics.consistency.jitter_detail")}</span>
                        {spreads.jitter && <span className="consistency-detail">{spreads.jitter}</span>}
                    </div>
                    <FontAwesomeIcon icon={faWaveSquare}
                                     className={"icon-" + jitterColour(formatLatency(data.ping.jitter))} />
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