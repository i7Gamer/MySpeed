import StatisticContainer from "@/pages/Statistics/components/StatisticContainer";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {
    faArrowDown, faArrowUp, faLinkSlash, faPingPongPaddleBall, faWaveSquare
} from "@fortawesome/free-solid-svg-icons";
import {bufferbloat, bufferbloatColour, packetLossColour} from "@/common/utils/TestUtil";
import "./styles.sass";
import {getIconBySpeed} from "@/common/utils/TestUtil";
import {useContext} from "react";
import {ConfigContext} from "@/common/contexts/Config";
import {StatusContext} from "@/common/contexts/Status";
import {PreferencesContext} from "@/common/contexts/Preferences";
import {convertSpeed, formatLatency, getSpeedUnit} from "@/common/utils/FormatUtil";
import TestDetails from "@/common/components/TestDetails";
import {t} from "i18next";

export const LatestTestChart = (props) => {

    const [config] = useContext(ConfigContext);
    const [status] = useContext(StatusContext);
    const [preferences] = useContext(PreferencesContext);
    const speedUnit = getSpeedUnit(preferences);

    if (!props.test) return <></>;
    if (config === null) return <></>;

    // Opened, the card becomes the whole record: the three summary rows below
    // are all that fits on a card, and the modal used to render exactly the same
    // three, so there was nothing to open it for. This is the pane the overview
    // shows for any test in its list, over the newest one.
    if (props.expanded) return (
        <StatisticContainer title={t("latest.latest")} expanded>
            <TestDetails test={props.test} previous={props.previous}
                         previousConnection={props.previousConnection}/>
        </StatisticContainer>
    );

    const hasJitter = props.test.jitter !== null && props.test.jitter !== undefined;

    // Absent for tests recorded before the quality columns existed and for the
    // providers that cannot measure them; the row simply does not render then.
    const bloat = bufferbloat(props.test);

    // The same rule, for the same reason: only Ookla reports a loss rate, and a
    // provider that reports none has not measured a clean line. Zero is a
    // measurement, so the check cannot be on truthiness.
    const hasPacketLoss = typeof props.test.packetLoss === "number"
        && Number.isFinite(props.test.packetLoss);

    return (
        <StatisticContainer title={t("latest.latest")} onClick={props.onClick} running={status.running}>
            <div className="info-container">
                <div className="test-container">
                    <div className="test-info">
                        <h2>{t("latest.ping")}</h2>
                        {/* Trimmed to the one decimal every latency in this
                            interface is shown at. The measurement is stored
                            with two, and the card printed both of them while
                            the pane that opens from clicking it printed one -
                            the same reading, twice, in two precisions. */}
                        <p className={"icon-" + getIconBySpeed(props.test.ping, config.ping, false)}>
                            {(props.test.ping === -1 ? "N/A" : formatLatency(props.test.ping)) + " " + t("latest.ping_unit")}
                            {hasJitter && <span className="jitter-value"><FontAwesomeIcon icon={faWaveSquare} className="jitter-icon" />{formatLatency(props.test.jitter)}</span>}
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

                {/* The share of packets that never arrived, which none of the
                    three figures above can show: a line can be fast in both
                    directions and drop one packet in fifty, and that is what a
                    call breaking into fragments actually is. Graded against
                    what a call needs rather than against a configured optimum -
                    there is no setting for it anywhere. */}
                {hasPacketLoss && (
                    <div className="test-container">
                        <div className="test-info">
                            <h2>{t("latest.packet_loss")}</h2>
                            <p className={"icon-" + packetLossColour(props.test.packetLoss)}>
                                {props.test.packetLoss}%
                            </p>
                        </div>
                        {/* The same broken link the overview card uses. A dish
                            says "receiving a signal", which is not what this
                            measures, and it left packet loss drawn two
                            different ways on two cards of the same page. */}
                        <FontAwesomeIcon icon={faLinkSlash}
                                         className={"icon-" + packetLossColour(props.test.packetLoss)}/>
                    </div>
                )}

                {/* The value carries the grade's colour, exactly as the rows
                    above colour theirs by their level, and the grade badge sits
                    where their icons sit. */}
                {bloat && (
                    <div className="test-container">
                        <div className="test-info">
                            <h2>{t("latest.quality")}</h2>
                            <p className={"icon-" + bufferbloatColour(bloat.grade)}>
                                {t("latest.loaded_latency", {
                                    down: formatLatency(props.test.downloadLatency),
                                    up: formatLatency(props.test.uploadLatency)
                                })}
                            </p>
                        </div>
                        <span className={"bufferbloat-grade icon-" + bufferbloatColour(bloat.grade)}
                              title={t("latest.bufferbloat", {increase: bloat.increase})}>
                            {bloat.grade}
                        </span>
                    </div>
                )}
            </div>
        </StatisticContainer>
    );

}