import StatisticContainer from "@/pages/Statistics/components/StatisticContainer";
import PanelRow from "@/pages/Statistics/components/PanelRow";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {
    faArrowDown, faArrowUp, faGaugeHigh, faLinkSlash, faPingPongPaddleBall, faWaveSquare
} from "@fortawesome/free-solid-svg-icons";
import {bufferbloat, bufferbloatColour, getIconBySpeed, isMeasured, packetLossColour, readableFigure} from "@/common/utils/TestUtil";
import "./styles.sass";
import {useContext} from "react";
import {ConfigContext} from "@/common/contexts/Config";
import {StatusContext} from "@/common/contexts/Status";
import {PreferencesContext} from "@/common/contexts/Preferences";
import {TargetsContext} from "@/common/contexts/Targets";
import {resolveLimits, roundIndexById, targetColour} from "@/common/utils/TargetUtil";
import {
    formatLatency, formatLatencyWithUnit, formatWhole, formatWithUnit, getSpeedUnit, wholeSpeed
} from "@/common/utils/FormatUtil";
import TestDetails from "@/common/components/TestDetails";
import {t} from "i18next";

export const LatestTestChart = (props) => {

    const [config] = useContext(ConfigContext);
    const [status] = useContext(StatusContext);
    const [preferences] = useContext(PreferencesContext);
    const {targets = [], byId, selectedTarget = null} = useContext(TargetsContext);
    const speedUnit = getSpeedUnit(preferences);

    if (!props.test) return <></>;
    if (config === null) return <></>;

    // Graded against the test's own target where it set optima, the global
    // settings otherwise - the same resolution the pane this card opens into
    // makes, so opening it cannot change a colour.
    const limits = resolveLimits(byId?.[props.test.targetId], config);

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

    const hasJitter = isMeasured(props.test.jitter);

    // Absent for tests recorded before the quality columns existed and for the
    // providers that cannot measure them; the row simply does not render then.
    const bloat = bufferbloat(props.test);

    // Only Ookla reports a loss rate, and a provider that reports none has
    // not measured a clean line. Zero is a measurement, so the check cannot
    // be on truthiness - and junk is not one, so it reads through
    // readableFigure: this row prints the stored column raw, and a value the
    // colour beside it grades as never-measured must not print "auto%" or a
    // bare "%" as a reading. The detail pane gates the same column the same
    // way, so a row cannot show on one view and vanish from the other.
    const hasPacketLoss = readableFigure(props.test.packetLoss) !== null;

    // Trimmed to the one decimal every latency in this interface is shown at.
    // The measurement is stored with two, and the card printed both of them
    // while the pane that opens from clicking it printed one - the same reading,
    // twice, in two precisions. The colour is graded from that same trimmed
    // figure: the pane grades what it prints, and a raw ping that rounds across
    // a bucket boundary would wear a different colour there.
    const ping = formatLatency(props.test.ping);

    /**
     * Whole, the way this card's three figures are stated.
     *
     * The card is read at a glance and the pane it opens - TestDetails, above -
     * prints every figure at the precision it was measured at. So the decimals
     * are one click away rather than gone, and the column of readings here is
     * one width rather than five.
     *
     * wholeSpeed rounds ONCE from the raw quotient: rounding the two-decimal
     * conversion again printed every [8n+3.96, 8n+4) band one megabyte high.
     *
     * And through formatWithUnit, never a bare template: the one refusal for
     * everything no reader can read - the -1 a failed run stores in either
     * spelling, junk, and the absent columns of a legacy row, which the old
     * template printed as the literal "null Mbps".
     */
    const speedText = (mbps) => formatWithUnit(wholeSpeed(mbps, preferences), speedUnit);

    /*
     * Which target these three figures were measured against, drawn the way a
     * mixed history list draws it - the same dot, in the same colour, with the
     * name beside it so the colour is not carrying the answer alone.
     *
     * Only where the question arises, which is the history list's pair of gates
     * and its reasons: one target leaves nothing to tell apart, and a chip
     * narrowing the page has already answered it above every card on it. Both
     * cases render the heading exactly as they always have. roundIndexById
     * answers -1 for a target since deleted and for a row from before targets
     * existed, which is the third case that names none.
     */
    const dotIndex = targets.length >= 2 && selectedTarget === null
        ? roundIndexById(targets, props.test.targetId) : -1;

    // The name is the target's own, so no locale carries a key for it - and the
    // dot's tooltip and its accessible name are that same name.
    const title = dotIndex < 0 ? t("latest.latest") : (
        <>
            {t("latest.latest")}
            <span className="latest-target">
                <span className="target-dot" title={targets[dotIndex].name}
                      role="img" aria-label={targets[dotIndex].name}
                      style={{background: targetColour(dotIndex)}}/>
                <span className="latest-target-name">{targets[dotIndex].name}</span>
            </span>
        </>
    );

    return (
        <StatisticContainer title={title} onClick={props.onClick} running={status.running}>
            <div className="info-container">
                <PanelRow icon={faPingPongPaddleBall} title={t("latest.ping")}
                          level={getIconBySpeed(ping, limits.ping, false)}
                          /* Whole, while the colour beside it is graded on the
                             one decimal above - which is what the pane grades
                             and prints, so the two views cannot disagree about
                             a ping that rounds across a bucket boundary. The
                             formatter is the stop for everything unreadable,
                             placeholders in either spelling included. */
                          value={formatWithUnit(formatWhole(props.test.ping), t("latest.ping_unit"))}
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
                          level={getIconBySpeed(props.test.upload, limits.upload, true)}
                          value={speedText(props.test.upload)}/>

                <PanelRow icon={faArrowDown} title={t("latest.down")}
                          level={getIconBySpeed(props.test.download, limits.download, true)}
                          value={speedText(props.test.download)}/>

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