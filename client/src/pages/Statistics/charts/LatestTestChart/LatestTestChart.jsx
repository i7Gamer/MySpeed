import StatisticContainer from "@/pages/Statistics/components/StatisticContainer";
import PanelRow from "@/pages/Statistics/components/PanelRow";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {
    faArrowDown, faArrowUp, faGaugeHigh, faLinkSlash, faPingPongPaddleBall, faWaveSquare
} from "@fortawesome/free-solid-svg-icons";
import {bufferbloat, bufferbloatColour, packetLossColour} from "@/common/utils/TestUtil";
import "./styles.sass";
import {getIconBySpeed} from "@/common/utils/TestUtil";
import {useContext} from "react";
import {ConfigContext} from "@/common/contexts/Config";
import {StatusContext} from "@/common/contexts/Status";
import {PreferencesContext} from "@/common/contexts/Preferences";
import {
    convertSpeed, formatLatency, formatLatencyWithUnit, getSpeedUnit, NOT_MEASURED
} from "@/common/utils/FormatUtil";
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

    // Trimmed to the one decimal every latency in this interface is shown at.
    // The measurement is stored with two, and the card printed both of them
    // while the pane that opens from clicking it printed one - the same reading,
    // twice, in two precisions. The colour is graded from that same trimmed
    // figure: the pane grades what it prints, and a raw ping that rounds across
    // a bucket boundary would wear a different colour there.
    const ping = formatLatency(props.test.ping);

    // A failed run stores -1 in every numeric column, and "-1 Mbps" reads as a
    // measurement. One place for it, because the three rows had a copy each.
    const measured = (value, text) => value === -1 ? NOT_MEASURED : text;

    return (
        <StatisticContainer title={t("latest.latest")} onClick={props.onClick} running={status.running}>
            <div className="info-container">
                <PanelRow icon={faPingPongPaddleBall} title={t("latest.ping")}
                          level={getIconBySpeed(ping, config.ping, false)}
                          value={measured(props.test.ping, `${ping} ${t("latest.ping_unit")}`)}
                          /* Under the latency rather than hung off it. It is the
                             other half of what the line does at rest, and beside
                             the figure it was a second number in the same unit
                             with no room to say which unit or which measurement
                             it was. */
                          description={hasJitter && (
                              <span>
                                  <FontAwesomeIcon icon={faWaveSquare} className="jitter-icon"/>
                                  {t("latest.jitter")}
                                  {" " + formatLatencyWithUnit(props.test.jitter, t("latest.jitter_unit"))}
                              </span>
                          )}/>

                <PanelRow icon={faArrowUp} title={t("latest.up")}
                          level={getIconBySpeed(props.test.upload, config.upload, true)}
                          value={measured(props.test.upload,
                              `${convertSpeed(props.test.upload, preferences)} ${speedUnit}`)}/>

                <PanelRow icon={faArrowDown} title={t("latest.down")}
                          level={getIconBySpeed(props.test.download, config.download, true)}
                          value={measured(props.test.download,
                              `${convertSpeed(props.test.download, preferences)} ${speedUnit}`)}/>

                {/* The share of packets that never arrived, which none of the
                    three figures above can show: a line can be fast in both
                    directions and drop one packet in fifty, and that is what a
                    call breaking into fragments actually is. Graded against
                    what a call needs rather than against a configured optimum -
                    there is no setting for it anywhere.

                    The glyph is the same broken link the overview card uses. A
                    dish says "receiving a signal", which is not what this
                    measures, and it left packet loss drawn two different ways on
                    two cards of the same page. */}
                {hasPacketLoss && (
                    <PanelRow icon={faLinkSlash} title={t("latest.packet_loss")}
                              level={packetLossColour(props.test.packetLoss)}
                              value={`${props.test.packetLoss}%`}/>
                )}

                {/* The grade is the reading here, so it is what the row states -
                    it used to be a badge off to the side while the two latencies
                    it is derived from took the value's place. Those move under
                    the title, which is where a figure that explains another one
                    belongs. */}
                {bloat && (
                    <PanelRow icon={faGaugeHigh} title={t("latest.quality")}
                              level={bufferbloatColour(bloat.grade)}
                              value={<span title={t("latest.bufferbloat", {increase: bloat.increase})}>
                                  {bloat.grade}
                              </span>}
                              description={<span>{t("latest.loaded_latency", {
                                  down: formatLatency(props.test.downloadLatency),
                                  up: formatLatency(props.test.uploadLatency)
                              })}</span>}/>
                )}
            </div>
        </StatisticContainer>
    );

}