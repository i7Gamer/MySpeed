import StatisticContainer from "@/pages/Statistics/components/StatisticContainer";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faArrowDown, faArrowUp, faGaugeHigh, faPingPongPaddleBall, faWaveSquare} from "@fortawesome/free-solid-svg-icons";
import "./styles.sass";
import {bufferbloat, bufferbloatColour, getIconBySpeed} from "@/common/utils/TestUtil";
import {useContext} from "react";
import {ConfigContext} from "@/common/contexts/Config";
import {StatusContext} from "@/common/contexts/Status";
import {PreferencesContext} from "@/common/contexts/Preferences";
import {convertSpeed, getSpeedUnit} from "@/common/utils/FormatUtil";
import {t} from "i18next";

export const LatestTestChart = (props) => {

    const [config] = useContext(ConfigContext);
    const [status] = useContext(StatusContext);
    const [preferences] = useContext(PreferencesContext);
    const speedUnit = getSpeedUnit(preferences);

    if (!props.test) return <></>;
    if (config === null) return <></>;

    const hasJitter = props.test.jitter !== null && props.test.jitter !== undefined;

    // A packet loss of zero is a measurement; an absent one is not. Only null
    // and undefined mean the provider never reported it.
    const isMeasured = (value) => value !== null && value !== undefined;
    const hasQuality = isMeasured(props.test.packetLoss) || isMeasured(props.test.downloadLatency);
    const bloat = bufferbloat(props.test);

    return (
        <StatisticContainer title={t("latest.latest")} onClick={props.onClick} running={status.running} expanded={props.expanded}>
            <div className="info-container">
                <div className="test-container">
                    <div className="test-info">
                        <h2>{t("latest.ping")}</h2>
                        <p className={"icon-" + getIconBySpeed(props.test.ping, config.ping, false)}>
                            {(props.test.ping === -1 ? "N/A" : props.test.ping) + " " + t("latest.ping_unit")}
                            {hasJitter && <span className="jitter-value"><FontAwesomeIcon icon={faWaveSquare} className="jitter-icon" />{props.test.jitter}</span>}
                        </p>
                    </div>
                    <FontAwesomeIcon icon={faPingPongPaddleBall}
                                     className={"icon-" + getIconBySpeed(props.test.ping, config.ping, false)}/>
                </div>
                <div className="test-container">
                    <div className="test-info">
                        <h2>{t("latest.up")}</h2>
                        <p className={"icon-" + getIconBySpeed(props.test.upload, config.upload, true)}>
                            {(props.test.upload === -1 ? "N/A" : convertSpeed(props.test.upload, preferences)) + " " + speedUnit}</p>
                    </div>
                    <FontAwesomeIcon icon={faArrowUp}
                                     className={"icon-" + getIconBySpeed(props.test.upload, config.upload, true)}/>
                </div>
                <div className="test-container">
                    <div className="test-info">
                        <h2>{t("latest.down")}</h2>
                        <p className={"icon-" + getIconBySpeed(props.test.download, config.download, true)}>
                            {(props.test.download === -1 ? "N/A" : convertSpeed(props.test.download, preferences)) + " " + speedUnit}</p>
                    </div>
                    <FontAwesomeIcon icon={faArrowDown}
                                     className={"icon-" + getIconBySpeed(props.test.download, config.download, true)}/>
                </div>

                {/* Only for a test that carried them: rows recorded before these
                    were captured, and the providers that cannot measure them,
                    have no value rather than a value of zero. */}
                {hasQuality && (
                    <div className="test-container">
                        <div className="test-info">
                            <h2>{t("latest.quality")}</h2>
                            <p>
                                {/* Both directions are required: they are
                                    measured independently, and interpolating an
                                    absent one renders "12 /  ms latency". */}
                                {isMeasured(props.test.downloadLatency) && isMeasured(props.test.uploadLatency) &&
                                    t("latest.loaded_latency", {
                                        down: props.test.downloadLatency, up: props.test.uploadLatency
                                    })}
                                {isMeasured(props.test.packetLoss) && (
                                    <span className="quality-loss">
                                        {t("latest.packet_loss", {percent: props.test.packetLoss})}
                                    </span>
                                )}
                            </p>
                        </div>
                        {/* The grade takes the icon's place when there is one:
                            it is the readable form of the same measurement. */}
                        {bloat
                            ? <span className={"bufferbloat-grade icon-" + bufferbloatColour(bloat.grade)}
                                    title={t("latest.bufferbloat", {increase: bloat.increase})}>
                                {bloat.grade}
                              </span>
                            : <FontAwesomeIcon icon={faGaugeHigh} className="icon-blue"/>}
                    </div>
                )}
            </div>
        </StatisticContainer>
    );

}