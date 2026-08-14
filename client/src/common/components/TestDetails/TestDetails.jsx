import {useContext} from "react";
import {t} from "i18next";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {
    faArrowDown, faArrowRight, faArrowUp, faLinkSlash, faPingPongPaddleBall, faStopwatch, faUpRightFromSquare,
    faWaveSquare
} from "@fortawesome/free-solid-svg-icons";
import {ConfigContext} from "@/common/contexts/Config";
import {PreferencesContext} from "@/common/contexts/Preferences";
import {
    convertSpeed, formatBytes, formatDateTime, formatLatency, formatLatencyWithUnit, getSpeedUnit
} from "@/common/utils/FormatUtil";
import {
    bufferbloat, bufferbloatColour, connectionChange, getIconBySpeed, gradeForIncrease, isMeasured,
    jitterColour, latencyIncrease, packetLossColour
} from "@/common/utils/TestUtil";
import {changeFrom, differenceFromTarget, percentOfTarget, providerName} from "./utils/details";
import {describeError} from "./utils/errors";
import HelpButton from "@/common/components/HelpButton";
import {useMetricInfo} from "@/common/hooks/useMetricInfo";
import {
    downloadInfo, jitterInfo, loadedLatencyInfo, packetLossInfo, pingInfo, uploadInfo
} from "@/common/utils/MetricInfo";
import "./styles.sass";

const RESULT_URL = "https://www.speedtest.net/result/c/";

// The bar would otherwise run off its track on a line that beats its target,
// which is the one case where the number is unambiguously good news.
const MAX_BAR_PERCENT = 100;

const DIRECTION_ICONS = {up: faArrowUp, down: faArrowDown, same: faArrowRight};

/**
 * One measurement, with how it compares to the configured optimum and to the
 * test before it.
 *
 * Two lines carrying two figures each, rather than four carrying one: the value
 * and what the line does beside it, then how far this is from the target
 * against how far it moved since the last test. Stacked, the card ran four
 * lines deep while its widest line used half the track.
 *
 * The icon opens the explanation of what the measurement is, the way the same
 * glyph does on the row that opens this pane - it was decoration here, so
 * expanding a row for more information took the explanations away.
 */
const DetailMetric = ({icon, label, value, unit, level, percent, targetLabel, change, changeUnit, higherIsBetter,
                          info, openInfo, sub = null}) => {
    const improved = change !== null && change.direction !== "same"
        && (change.direction === "up") === higherIsBetter;

    return (
        <div className="detail-metric">
            <div className="detail-metric-head">
                <HelpButton label={label} onOpen={(event) => openInfo(event, info)}>
                    <FontAwesomeIcon icon={icon} className={"detail-metric-icon icon-" + level}/>
                </HelpButton>
                <span className="detail-metric-label">{label}</span>
            </div>

            <div className="detail-metric-value-row">
                <div className="detail-metric-value">
                    {value}<span className="detail-metric-unit">{unit}</span>
                </div>
                {sub}
            </div>

            {percent !== null && (
                <div className="detail-target">
                    <div className="detail-target-track">
                        <div className={"detail-target-fill icon-" + level}
                             style={{width: `${Math.min(percent, MAX_BAR_PERCENT)}%`}}/>
                    </div>
                </div>
            )}

            {/* The change leads and the target label is pushed right by its own
                margin: on the oldest test there is no earlier one to compare
                against, and letting the gap do the alignment would leave the
                label sitting where the change should be. */}
            {(change !== null || (percent !== null && targetLabel)) && (
                <div className="detail-metric-foot">
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
                    {percent !== null && targetLabel && (
                        <span className="detail-target-label">{targetLabel}</span>
                    )}
                </div>
            )}
        </div>
    );
};

/**
 * The link to the provider's own result page.
 *
 * Its own component because it now appears in two places: under the provider's
 * name where one is known, and as a fact of its own on the rows that predate the
 * provider column and have nothing to hang it under.
 */
const ResultLink = ({resultId}) => (
    <a href={RESULT_URL + resultId} target="_blank" rel="noreferrer"
       onClick={(event) => event.stopPropagation()}>
        {t("test.details.open_result")}
        <FontAwesomeIcon icon={faUpRightFromSquare} className="detail-link-icon"/>
    </a>
);

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
    // Above the early return: a hook cannot be called conditionally, and a pane
    // rendered with no test is the condition.
    const openInfo = useMetricInfo();

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

    // The latency as it is printed, once, for everything that reads it. The card
    // showed formatLatency's one decimal and computed the change, the distance
    // from the target, the percentage and the colour from the two the column
    // stores: 25.44 after 25.36 drew two cards both reading "25.4 ms" with
    // "+0.08 ms" of change between them, and called that displayed 25.4 "0.44 ms
    // over" a target of 25. Both sides of every comparison, or the figure and
    // the sentence under it disagree again.
    //
    // The target is whatever was typed into the settings dialog, i.e. a string -
    // formatLatency hands anything that is not a number back untouched, so it
    // reaches asTarget exactly as it did before, as do the -1 a failed run
    // stores and the null of a provider that measured nothing.
    const ping = formatLatency(test.ping);
    const pingTarget = formatLatency(targets.ping);
    const earlierPing = formatLatency(earlier.ping);

    // A percentage says everything worth saying about throughput. For latency it
    // does not: the plain distance from the target is what the reader wants, and
    // it cannot be read backwards.
    const latencyTargetLabel = () => {
        const distance = differenceFromTarget(ping, pingTarget);
        if (distance === null) return null;
        if (distance.direction === "same") return t("test.details.on_target");

        return t(`test.details.${distance.direction}_target`,
            {amount: distance.difference, unit: t("latest.ping_unit")});
    };

    /**
     * What the line is like before anything is asked of it, beside the latency
     * itself: how much that latency wanders, and how much of the traffic never
     * arrived at all. Three readings of one thing, so they are read in one
     * place - each used to cost a full row of the facts grid below, and jitter
     * was drawn twice over on the overview, beside the ping in the row and
     * again as a fact once the row was opened.
     *
     * Packet loss hangs here rather than on the download and upload cards
     * because there is one figure for the connection: only Ookla measures it,
     * and it measures it once. Repeated under both directions it would read as
     * two measurements, and neither of them was taken.
     */
    const qualityFigures = [
        // Both graded against what a call needs rather than against a configured
        // optimum - there is a setting for the ping above them and none for
        // either of these. The same two gradings the consistency panel and the
        // latest-test card already draw them with, so one figure does not change
        // colour between two views of the same test - which is why the jitter is
        // printed on the trimmed figure and still graded on the stored one. At
        // two decimals it stood beside a ping trimmed to one, the same
        // measurement in the same unit written two ways on one card; grading it
        // on the trimmed figure would move this card's colour away from the
        // overview row's, which is the worse fault of the two.
        isMeasured(test.jitter) && {
            key: "jitter",
            icon: faWaveSquare,
            info: jitterInfo,
            // The printed figure, like the ping above: a stored 4.96 prints
            // "5", and green beside a printed 5 - the number the scale calls
            // orange - is the icon contradicting its own caption. The row and
            // the consistency card grade the same way, so the colour still
            // never changes between two views of one measurement.
            level: jitterColour(formatLatency(test.jitter)),
            text: formatLatencyWithUnit(test.jitter, t("latest.jitter_unit")),
            label: `${t("latest.jitter")} ${formatLatencyWithUnit(test.jitter, t("latest.jitter_unit"))}`
        },
        isMeasured(test.packetLoss) && {
            key: "packetLoss",
            icon: faLinkSlash,
            info: packetLossInfo,
            level: packetLossColour(test.packetLoss),
            text: `${test.packetLoss}%`,
            label: `${t("test.details.packet_loss")} ${test.packetLoss}%`
        }
    ].filter(Boolean);

    /**
     * Beside the latency rather than under it, and each icon explains its own
     * figure - packet loss appears nowhere else in the interface, so this is
     * the only place it can be explained at all.
     *
     * The group used to be one image with one name, because "± 2 ms · 0%" is
     * not a sentence and the icons say which figure is which only to someone
     * who can see them. The name moves onto the buttons: role="img" replaces
     * everything below it with its own label, so a button inside one is a
     * control a screen reader never announces. Only the icon is the button -
     * as button content the value would be swallowed by the label too.
     */
    const quality = qualityFigures.length > 0 && (
        <span className="detail-metric-sub">
            {qualityFigures.map(({key, icon, info, text, level, label}) => (
                <span key={key} className="detail-metric-sub-part">
                    <HelpButton label={label} onOpen={(event) => openInfo(event, info)}>
                        {/* The grade goes on the glyph, not on the group around
                            it. Worn by the whole part it coloured the figure
                            too - and these were then the only numbers on the
                            pane that carried a verdict, beside three cards
                            whose values are all one colour and whose icons do
                            the grading. The row above reads the same way. */}
                        <FontAwesomeIcon icon={icon}
                                         className={"detail-metric-sub-icon" + (level ? " icon-" + level : "")}/>
                    </HelpButton>
                    {text}
                </span>
            ))}
        </span>
    );

    /**
     * The latency that direction showed while it was saturating the line.
     *
     * It was one row of the facts grid for both directions, a paragraph away
     * from the speeds it belongs to, so reading "24 down / 31 up" meant
     * carrying each number back up to its own card. On the card it is what it
     * actually is: a second fact about that direction's transfer.
     *
     * Its own glyph rather than the ping's paddle. It is not the idle ping -
     * that is the whole point of the figure - and one glyph covering two
     * measurements is how the icons went wrong before.
     */
    const loadedLatency = (value) => isMeasured(value) && (
        <span className="detail-metric-sub">
            <span className="detail-metric-sub-part">
                <HelpButton label={`${t("info.loaded_latency.title")} ${formatLatencyWithUnit(value, t("latest.ping_unit"))}`}
                            onOpen={(event) => openInfo(event, loadedLatencyInfo)}>
                    {/* Graded on what this direction alone added over the idle
                        ping, by the same table the grade in the facts below is
                        read from. That one is deliberately the worse of the two
                        directions, so it cannot say which direction is the bad
                        one - and a line that is clean downstream and badly
                        buffered upstream is the usual asymmetry. It was the only
                        figure on the pane with no verdict on it at all. */}
                    <FontAwesomeIcon icon={faStopwatch}
                                     className={"detail-metric-sub-icon icon-"
                                         + bufferbloatColour(gradeForIncrease(latencyIncrease(value, test.ping)))}/>
                </HelpButton>
                {formatLatencyWithUnit(value, t("latest.ping_unit"))}
            </span>
        </span>
    );

    const metrics = [
        {
            key: "ping",
            sub: quality || null,
            icon: faPingPongPaddleBall,
            info: pingInfo,
            label: t("latest.ping"),
            value: ping,
            unit: t("latest.ping_unit"),
            changeUnit: t("latest.ping_unit"),
            level: getIconBySpeed(ping, pingTarget, false),
            percent: percentOfTarget(ping, pingTarget, {higherIsBetter: false}),
            targetLabel: latencyTargetLabel(),
            change: changeFrom(ping, earlierPing),
            higherIsBetter: false
        },
        {
            key: "download",
            sub: loadedLatency(test.downloadLatency) || null,
            icon: faArrowDown,
            info: downloadInfo,
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
            sub: loadedLatency(test.uploadLatency) || null,
            icon: faArrowUp,
            info: uploadInfo,
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

    // What the main line calls the server: the sponsor - which is what Ookla's
    // `serverName` holds - falling back to the city, because "which server"
    // usually means the city rather than the company, and then to whatever
    // answered.
    const serverPrimary = test.serverName || test.serverLocation || test.serverHost;

    // What the name alone does not say: where it is, the address that answered,
    // and the number to pin it by. Any of them may be absent, and on a provider
    // that reports none the whole line is.
    //
    // Whichever of them the main line is already showing is dropped rather than
    // printed twice. The location used to lead this line unconditionally and the
    // address was shown only when there was a name, so a row that reports a city
    // and no sponsor - an imported row, whose columns are barely validated, or
    // any provider that names no server - printed the city on both lines and its
    // host on neither. The host, with the id beside it, is the half that says
    // which of a provider's dozen identically named servers answered.
    const serverDetail = [test.serverLocation, test.serverHost,
        test.serverId ? `#${test.serverId}` : null]
        .filter((part) => part && part !== serverPrimary).join(" · ");

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
                        {metrics.map(({key, ...metric}) =>
                            <DetailMetric key={key} openInfo={openInfo} {...metric}/>)}
                    </div>

                    <div className="detail-facts">
                        <DetailFact label={t("test.details.measured_at")}>
                            {/* No weekday: it was the least informative token in
                                the longest value on the panel. */}
                            {formatDateTime(test.created, preferences,
                                {day: "numeric", month: "short", year: "numeric"})}
                            {/* How long the run took, under when it ran rather
                                than in a row of its own. It hangs here and not
                                off the data used - the other fact about what
                                the run cost - because `created` is always
                                present, where the byte counts are not: there
                                the duration would disappear along with them on
                                every provider that reports none. */}
                            {isMeasured(test.time) && (
                                <span className="detail-secondary">
                                    {t("test.details.seconds", {seconds: test.time})}
                                </span>
                            )}
                        </DetailFact>

                        {/* Which provider measured this. The three do not
                            measure the same things, so this is what tells a
                            reader that a missing packet loss below is a provider
                            that never looked rather than a line that lost
                            nothing. */}
                        {providerName(test.provider) && (
                            <DetailFact label={t("test.details.measured_with")}>
                                {providerName(test.provider)}
                                {/* The provider's own result page hangs under
                                    its name, the way the server's host hangs
                                    under the server's. It had a row to itself
                                    for one short link, and a row in this grid
                                    costs as much as a paragraph. */}
                                {test.resultId && (
                                    <span className="detail-secondary">
                                        <ResultLink resultId={test.resultId}/>
                                    </span>
                                )}
                            </DetailFact>
                        )}

                        {/* Third of the four facts that carry a second line
                            under their value - the duration, the result link,
                            the host, the address below. A grid row is as tall as
                            its tallest cell, so with these scattered through the
                            grid every row had one of them in it and every row
                            was two lines tall, each with a one-line fact beside
                            it sitting in the empty half. Together they cost one
                            tall row and the short facts close up under it.

                            The host used to be shown only when the name was
                            missing, so a named server threw its address away -
                            and the address is which one to pin in the settings
                            to keep measuring against it. See serverDetail for
                            what the second line carries; the id it ends on is
                            gated because zero is the column's default, i.e. a
                            provider that numbers no servers rather than a server
                            numbered zero. */}
                        {serverPrimary && (
                            <DetailFact label={t("test.details.server")}>
                                {serverPrimary}
                                {serverDetail && (
                                    <span className="detail-address detail-secondary">{serverDetail}</span>
                                )}
                            </DetailFact>
                        )}

                        {/* Fourth and last of the two-line facts, and the
                            tallest of them - the address below is a whole line
                            where the others' second lines are smaller type.

                            It used to trail the short facts instead, on the
                            reasoning that three columns hold only three of the
                            four. Measured, the grid is four columns wide from
                            1366px up - `auto-fit` over an 18rem minimum - which
                            is the common desktop case rather than a rare one,
                            and there all four share a row: a 75px row over a
                            37px one, where trailing gave a 55px row over a 75px
                            one. Two columns improve as well, and three come out
                            the same height either way, so nothing pays for it.

                            Who the line is on the internet, and what address it
                            went out from. One fact, not two: connectionChange
                            reads them as a pair, and a reassigned lease or a
                            failover - which is usually why a run of results
                            steps - moves both at once. Two rows made one event
                            read as two coincidences.

                            Either half may be missing. Only Ookla reports both;
                            the other two report what their backend happens to
                            know. */}
                        {(test.isp || test.externalIp) && (
                            <DetailFact label={t("test.details.connection")}>
                                {test.isp && (
                                    <>
                                        {test.isp}
                                        {/* Below the value, not trailing it -
                                            see .detail-changed. A block element
                                            breaks the reading too, so the space
                                            that used to keep this from being
                                            read as "Salt MobileCHANGED" is no
                                            longer carrying anything. */}
                                        {change?.isp &&
                                            <span className="detail-changed">{t("test.details.changed")}</span>}
                                    </>
                                )}
                                {/* A marker each: one for the pair would report
                                    a changed address as a changed provider. */}
                                {test.externalIp && (
                                    <span className="detail-address detail-secondary">
                                        {test.externalIp}
                                        {change?.externalIp &&
                                            <span className="detail-changed">{t("test.details.changed")}</span>}
                                    </span>
                                )}
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

                        {/* The grade is the readable form of the two figures now
                            on the download and upload cards: how much latency
                            the line gains once it is saturated, which is what a
                            call breaking up during an upload actually is.

                            It keeps its row rather than moving to the overview
                            with the rest. This pane is also the expanded latest
                            test on the statistics page, where no overview row
                            surrounds it - dropping the row there would have made
                            opening the card show less than the card itself. */}
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

                        {/* Only for a row that cannot name its provider - every
                            test recorded before that column existed. The link
                            belongs under the provider's name, but those rows
                            have no such fact to hang it under, and losing the
                            link is worse than keeping the row it used to own. */}
                        {test.resultId && !providerName(test.provider) && (
                            <DetailFact label={t("test.details.result")}>
                                <ResultLink resultId={test.resultId}/>
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
