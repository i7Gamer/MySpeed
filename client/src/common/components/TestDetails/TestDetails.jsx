import {useContext} from "react";
import {t} from "i18next";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {
    faArrowDown, faArrowRight, faArrowUp, faPingPongPaddleBall, faUpRightFromSquare
} from "@fortawesome/free-solid-svg-icons";
import {ConfigContext} from "@/common/contexts/Config";
import {PreferencesContext} from "@/common/contexts/Preferences";
import {convertSpeed, formatBytes, formatDateTime, formatWithUnit, getSpeedUnit} from "@/common/utils/FormatUtil";
import {bufferbloat, bufferbloatColour, connectionChange, getIconBySpeed} from "@/common/utils/TestUtil";
import {changeFrom, differenceFromTarget, percentOfTarget, providerName} from "./utils/details";
import {describeError} from "./utils/errors";
import "./styles.sass";

const RESULT_URL = "https://www.speedtest.net/result/c/";

// The bar would otherwise run off its track on a line that beats its target,
// which is the one case where the number is unambiguously good news.
const MAX_BAR_PERCENT = 100;

const DIRECTION_ICONS = {up: faArrowUp, down: faArrowDown, same: faArrowRight};

// A packet loss of zero is a measurement; only null and undefined mean the
// provider never reported one.
const isMeasured = (value) => value !== null && value !== undefined;

/**
 * One measurement, with how it compares to the configured optimum and to the
 * test before it.
 */
const DetailMetric = ({icon, label, value, unit, level, percent, targetLabel, change, changeUnit, higherIsBetter}) => {
    const improved = change !== null && change.direction !== "same"
        && (change.direction === "up") === higherIsBetter;

    return (
        <div className="detail-metric">
            <div className="detail-metric-head">
                <FontAwesomeIcon icon={icon} className={"detail-metric-icon icon-" + level}/>
                <span className="detail-metric-label">{label}</span>
            </div>
            <div className="detail-metric-value">
                {value}<span className="detail-metric-unit">{unit}</span>
            </div>

            {percent !== null && (
                <div className="detail-target">
                    <div className="detail-target-track">
                        <div className={"detail-target-fill icon-" + level}
                             style={{width: `${Math.min(percent, MAX_BAR_PERCENT)}%`}}/>
                    </div>
                    <span className="detail-target-label">{targetLabel}</span>
                </div>
            )}

            {change !== null && (
                <div className={`detail-change detail-change-${improved ? "better" : change.direction === "same" ? "same" : "worse"}`}>
                    <FontAwesomeIcon icon={DIRECTION_ICONS[change.direction]}/>
                    <span>
                        {change.direction === "same"
                            ? t("test.details.unchanged")
                            : `${change.difference > 0 ? "+" : ""}${change.difference} ${changeUnit}`}
                    </span>
                </div>
            )}
        </div>
    );
};

const DetailFact = ({label, children}) => (
    <div className="detail-fact">
        <span className="detail-fact-label">{label}</span>
        <span className="detail-fact-value">{children}</span>
    </div>
);

/**
 * Everything one stored test says about itself.
 *
 * Written against the raw row the API returns rather than against a component's
 * props, so the same pane serves the expandable row on the overview and the
 * enlarged view of the latest test in the statistics - the two used to show
 * wildly different amounts of the same record, and only one of them was worth
 * opening.
 *
 * @param test               the row, exactly as /speedtests returns it
 * @param previous           the chronologically earlier test, for the changes
 * @param previousConnection the nearest earlier test that names a connection,
 *                           for the "changed" marker - see previousConnection()
 * @param className          appended to the root, for the caller's own chrome
 * @param children           rendered below the facts, for caller-owned actions
 */
export const TestDetails = ({test, previous, previousConnection, className = "", children}) => {
    const [config] = useContext(ConfigContext);
    const [preferences] = useContext(PreferencesContext);

    if (!test) return null;

    const speedUnit = getSpeedUnit(preferences);
    // The targets are what the bars are drawn against; without them percentOfTarget
    // returns null for every metric and the bars simply do not render.
    const targets = config ?? {};

    // The panel keeps the raw output appended when there is no translation for
    // it - it is what an issue report needs.
    const reason = describeError(test.error);
    const errorMessage = reason ?? (t("test.unknown_error") + " " + test.error);

    const earlier = previous ?? {};

    // A percentage says everything worth saying about throughput. For latency it
    // does not: the plain distance from the target is what the reader wants, and
    // it cannot be read backwards.
    const latencyTargetLabel = () => {
        const distance = differenceFromTarget(test.ping, targets.ping);
        if (distance === null) return null;
        if (distance.direction === "same") return t("test.details.on_target");

        return t(`test.details.${distance.direction}_target`,
            {amount: distance.difference, unit: t("latest.ping_unit")});
    };

    const metrics = [
        {
            key: "ping",
            icon: faPingPongPaddleBall,
            label: t("latest.ping"),
            value: test.ping,
            unit: t("latest.ping_unit"),
            changeUnit: t("latest.ping_unit"),
            level: getIconBySpeed(test.ping, targets.ping, false),
            percent: percentOfTarget(test.ping, targets.ping, {higherIsBetter: false}),
            targetLabel: latencyTargetLabel(),
            change: changeFrom(test.ping, earlier.ping),
            higherIsBetter: false
        },
        {
            key: "download",
            icon: faArrowDown,
            label: t("latest.down"),
            value: convertSpeed(test.download, preferences),
            unit: speedUnit,
            changeUnit: speedUnit,
            level: getIconBySpeed(test.download, targets.download, true),
            percent: percentOfTarget(test.download, targets.download),
            targetLabel: t("test.details.of_target", {percent: percentOfTarget(test.download, targets.download)}),
            change: changeFrom(convertSpeed(test.download, preferences), convertSpeed(earlier.download, preferences)),
            higherIsBetter: true
        },
        {
            key: "upload",
            icon: faArrowUp,
            label: t("latest.up"),
            value: convertSpeed(test.upload, preferences),
            unit: speedUnit,
            changeUnit: speedUnit,
            level: getIconBySpeed(test.upload, targets.upload, true),
            percent: percentOfTarget(test.upload, targets.upload),
            targetLabel: t("test.details.of_target", {percent: percentOfTarget(test.upload, targets.upload)}),
            change: changeFrom(convertSpeed(test.upload, preferences), convertSpeed(earlier.upload, preferences)),
            higherIsBetter: true
        }
    ];

    const bloat = bufferbloat(test);

    // What the server's name alone does not say: the address that answered, and
    // the number to pin it by. Either may be absent, and on a provider that
    // reports neither the whole line is.
    const serverDetail = [test.serverName ? test.serverHost : null, test.serverId ? `#${test.serverId}` : null]
        .filter(Boolean).join(" · ");

    // Against the nearest earlier test that carries an identity, not simply the
    // row before - see previousConnection.
    const change = connectionChange(test, previousConnection);

    return (
        <div className={`test-details ${className}`.trim()}>
            {test.error ? (
                <div className="detail-error">
                    <h3>{t("test.failed")}</h3>
                    <p>{errorMessage}. {t("test.recheck")}</p>
                    {/* The raw CLI output, once, rather than only the friendly
                        translation - it is what an issue report needs. */}
                    <code className="detail-error-raw">{test.error}</code>
                </div>
            ) : (
                <>
                    <div className="detail-metrics">
                        {metrics.map(({key, ...metric}) => <DetailMetric key={key} {...metric}/>)}
                    </div>

                    <div className="detail-facts">
                        <DetailFact label={t("test.details.measured_at")}>
                            {/* No weekday: it was the least informative token in
                                the longest value on the panel. */}
                            {formatDateTime(test.created, preferences,
                                {day: "numeric", month: "short", year: "numeric"})}
                        </DetailFact>

                        {/* Which provider measured this. The three do not
                            measure the same things, so this is what tells a
                            reader that a missing packet loss below is a provider
                            that never looked rather than a line that lost
                            nothing. */}
                        {providerName(test.provider) && (
                            <DetailFact label={t("test.details.measured_with")}>
                                {providerName(test.provider)}
                            </DetailFact>
                        )}

                        {isMeasured(test.time) && (
                            <DetailFact label={t("test.details.duration")}>
                                {t("test.details.seconds", {seconds: test.time})}
                            </DetailFact>
                        )}

                        {/* What the run cost in traffic. A single Ookla test
                            moves a couple of gigabytes, which is the figure that
                            decides whether testing every fifteen minutes is
                            affordable on a metered line. */}
                        {isMeasured(test.bytesDownloaded) && isMeasured(test.bytesUploaded) && (
                            <DetailFact label={t("test.details.data_used")}>
                                <span className="detail-pair"
                                      role="img"
                                      aria-label={t("test.details.data_used_value",
                                          {down: formatBytes(test.bytesDownloaded),
                                              up: formatBytes(test.bytesUploaded)})}>
                                    <span className="detail-pair-part">
                                        <FontAwesomeIcon icon={faArrowDown} className="detail-pair-icon"/>
                                        {formatBytes(test.bytesDownloaded)}
                                    </span>
                                    <span className="detail-pair-part">
                                        <FontAwesomeIcon icon={faArrowUp} className="detail-pair-icon"/>
                                        {formatBytes(test.bytesUploaded)}
                                    </span>
                                </span>
                            </DetailFact>
                        )}

                        <DetailFact label={t("test.details.trigger")}>
                            {t("test.result." + (test.type === "custom" ? "from_you" : "automatic"))}
                        </DetailFact>

                        {isMeasured(test.jitter) && (
                            <DetailFact label={t("latest.jitter")}>
                                {formatWithUnit(test.jitter, t("latest.jitter_unit"))}
                            </DetailFact>
                        )}

                        {/* Only for a test that carried them. A row recorded
                            before these were captured, or from a provider that
                            cannot measure them, has no value rather than zero -
                            and a packet loss of zero is a result worth showing. */}
                        {isMeasured(test.downloadLatency) && isMeasured(test.uploadLatency) && (
                            <DetailFact label={t("test.details.loaded_latency")}>
                                {/* The same two arrows the speed rows use,
                                    rather than the words "down" and "up". The
                                    sentence stays as the accessible name: an
                                    arrow points somewhere only to someone who
                                    can see it. */}
                                <span className="detail-pair"
                                      role="img"
                                      aria-label={t("test.details.loaded_latency_value",
                                          {down: test.downloadLatency, up: test.uploadLatency})}>
                                    <span className="detail-pair-part">
                                        <FontAwesomeIcon icon={faArrowDown} className="detail-pair-icon"/>
                                        {test.downloadLatency}
                                    </span>
                                    <span className="detail-pair-part">
                                        <FontAwesomeIcon icon={faArrowUp} className="detail-pair-icon"/>
                                        {test.uploadLatency}
                                    </span>
                                    <span className="detail-pair-unit">{t("latest.ping_unit")}</span>
                                </span>
                            </DetailFact>
                        )}

                        {/* The grade is the readable form of the two figures
                            above: how much latency the line gains once it is
                            saturated, which is what a call breaking up during
                            an upload actually is. */}
                        {bloat && (
                            <DetailFact label={t("test.details.bufferbloat")}>
                                <span className={"bufferbloat-grade icon-" + bufferbloatColour(bloat.grade)}>
                                    {bloat.grade}
                                </span>
                                {/* A real space, not only margin: inline spans
                                    create no word break, so the accessible text
                                    read "Aadds 19 ms". */}
                                {" " + t("test.details.bufferbloat_value", {increase: bloat.increase})}
                            </DetailFact>
                        )}

                        {isMeasured(test.packetLoss) && (
                            <DetailFact label={t("test.details.packet_loss")}>
                                {test.packetLoss}%
                            </DetailFact>
                        )}

                        {test.isp && (
                            <DetailFact label={t("test.details.isp")}>
                                {test.isp}
                                {/* Below the value, not trailing it - see
                                    .detail-changed. A block element breaks the
                                    reading too, so the space that used to keep
                                    this from being read as "Salt MobileCHANGED"
                                    is no longer carrying anything. */}
                                {change?.isp && <span className="detail-changed">{t("test.details.changed")}</span>}
                            </DetailFact>
                        )}

                        {/* The address the test went out from. A change here is
                            usually why a run of results steps: a reassigned
                            lease, a failover, a swapped router. */}
                        {test.externalIp && (
                            <DetailFact label={t("test.details.external_ip")}>
                                <span className="detail-address">{test.externalIp}</span>
                                {change?.externalIp && <span className="detail-changed">{t("test.details.changed")}</span>}
                            </DetailFact>
                        )}

                        {/* The host used to be shown only when the name was
                            missing, so a named server threw its address away -
                            and the address, with the id beside it, is the half
                            that says which of a provider's dozen identically
                            named servers answered, and which one to pin in the
                            settings to keep measuring against it. Zero is the
                            column's default, i.e. a provider that numbers no
                            servers, rather than a server numbered zero. */}
                        {(test.serverName || test.serverHost) && (
                            <DetailFact label={t("test.details.server")}>
                                {test.serverName || test.serverHost}
                                {serverDetail && (
                                    <span className="detail-address detail-secondary">{serverDetail}</span>
                                )}
                            </DetailFact>
                        )}

                        {test.resultId && (
                            <DetailFact label={t("test.details.result")}>
                                <a href={RESULT_URL + test.resultId} target="_blank" rel="noreferrer"
                                   onClick={(event) => event.stopPropagation()}>
                                    {t("test.details.open_result")}
                                    <FontAwesomeIcon icon={faUpRightFromSquare} className="detail-link-icon"/>
                                </a>
                            </DetailFact>
                        )}
                    </div>
                </>
            )}

            {children}
        </div>
    );
};

export default TestDetails;
