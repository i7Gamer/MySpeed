import {Dialog, DialogHeader, DialogBody, DialogFooter} from "@/common/contexts/Dialog";
import {t} from "i18next";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {
    faCheck, faServer, faLink, faHashtag, faExclamationTriangle, faStopwatch, faTag
} from "@fortawesome/free-solid-svg-icons";
import "./styles.sass";
import React, {useContext, useEffect, useState} from "react";
import {assertOk, jsonRequest, patchRequest, putRequest} from "@/common/utils/RequestUtil";
import {Trans} from "react-i18next";
import {ConfigContext} from "@/common/contexts/Config";
import {TargetsContext} from "@/common/contexts/Targets";
import {ToastNotificationContext} from "@/common/contexts/ToastNotification";
import SelectableOption, {SelectableList} from "@/common/components/SelectableOption";
import ToggleSwitch from "@/common/components/ToggleSwitch";
import Checkbox from "@/common/components/Checkbox";
import {useSyncOnOpen} from "@/common/hooks/useSyncOnOpen";
import {CUSTOM_BACKEND_PLACEHOLDER, IPERF_HOST_PLACEHOLDER} from "@/common/utils/InvariantText";
import {
    baselineAccepted, BASELINE_BOUNDS, BASELINE_PERCENT_DEFAULT, bitrateAccepted,
    durationAccepted, iperfHostAccepted, IPERF_DEFAULTS, providerById, providers,
    requiresEndpoint, streamsAccepted, takesEndpoint, takesServerId, takesTuning,
    tuningAccepted, TUNING_BOUNDS
} from "./providers";
import {optimalAccepted, optimalsAccepted, targetBody, uniqueTargetName} from "./targetBody";

// The rule the door states for a pinned server, kept in step with
// server/controller/targets.js: an id is digits and nothing else.
const SERVER_ID_DIGITS = /^\d+$/;

/**
 * One target's whole shape: its name, its provider, where it measures, whether
 * it alerts, and what it is graded against. The successor of the provider
 * dialog, which edited the same fields as four instance-wide config keys -
 * there is more than one of these now, so the row itself is what is edited.
 *
 * @param target the full row being edited, or null to create one
 */
export const TargetEditor = ({open, onClose, target}) => {
    const [config] = useContext(ConfigContext);
    // The list as well as the reload: a new target's seeded name has to be one
    // no other target already wears, which is what the server refuses on.
    const {targets: targetList, reloadTargets} = useContext(TargetsContext);
    const updateToast = useContext(ToastNotificationContext);
    // Read when the dialog opens, not at mount - see useSyncOnOpen. The server
    // id and endpoint keep their own effect below: they also follow provider
    // switches while the dialog is in use.
    const [name, setName] = useState("");
    /**
     * Whether the name is the operator's rather than the editor's.
     *
     * The seed follows the provider while nobody has said otherwise, so
     * switching from Ookla to iperf3 before typing renames the target with it.
     * The moment the field is typed in it stops following - a name somebody
     * chose must survive a change of mind about the provider - and a row being
     * edited counts as touched from the start, since its name is already
     * theirs.
     */
    const [nameTouched, setNameTouched] = useState(false);
    const [provider, setProvider] = useState("ookla");
    const [serverId, setServerId] = useState("none");
    // Plain text with "" for untyped, unlike the server select above: the
    // sentinel is also a well-formed hostname, so holding it in the same
    // state as what the operator types blanked the field the moment a typed
    // host equalled it - "none.local" erased itself four characters in.
    // targetBody maps "" to null on the way out.
    const [endpoint, setEndpoint] = useState("");
    const [alerts, setAlerts] = useState(true);
    // How the run itself is shaped, for the one provider that lets a target
    // say. Blank is not a value: the column is nullable and null is what the
    // runner reads as "the registry's own default".
    const [iperfDuration, setIperfDuration] = useState("");
    const [iperfStreams, setIperfStreams] = useState("");
    // Datagrams instead of a stream, which is a different measurement rather
    // than a louder one - and the only run that reports the jitter and packet
    // loss the row has columns for. The rate is not optional beside it: the
    // CLI's own default is 1 Mbit/s and says nothing about being one.
    const [iperfUdp, setIperfUdp] = useState(false);
    const [iperfBitrate, setIperfBitrate] = useState("");
    // What "slower than usual" means for this target. Derived from the column
    // rather than stored beside it, the way ownOptimals is: null is the whole
    // of how a target says it has no baseline, and a flag beside it would
    // invent a switched-on-with-no-percentage row nothing else here has.
    const [baselineAlerts, setBaselineAlerts] = useState(false);
    const [baselinePercent, setBaselinePercent] = useState("");
    const [ownOptimals, setOwnOptimals] = useState(false);
    const [optimalPing, setOptimalPing] = useState("");
    const [optimalDownload, setOptimalDownload] = useState("");
    const [optimalUpload, setOptimalUpload] = useState("");
    const [ooklaServers, setOoklaServers] = useState({});
    const [libreServers, setLibreServers] = useState({});
    const [acceptedOokla, setAcceptedOokla] = useState(false);
    // One run at a time - a second click on a slow link must not save twice.
    const [saving, setSaving] = useState(false);

    useSyncOnOpen(open, () => {
        // A new target opens on a name that already works: the provider's own,
        // numbered past the ones in use. The row being edited keeps its own,
        // and counts as touched so nothing below seeds over it.
        setName(target?.name ?? uniqueTargetName(providerById("ookla")?.name, targetList));
        setNameTouched(target != null);
        setProvider(target?.provider ?? "ookla");
        setServerId(target?.serverId ?? "none");
        setEndpoint(target?.endpoint ?? "");
        // sqlite hands the flag back as 0/1 under the global raw:true.
        setAlerts(target ? Boolean(target.alerts) : true);
        setIperfDuration(target?.iperfDuration != null ? String(target.iperfDuration) : "");
        setIperfStreams(target?.iperfStreams != null ? String(target.iperfStreams) : "");
        // sqlite hands this one back as 0/1 too, under the same raw:true.
        setIperfUdp(Boolean(target?.iperfUdp));
        setIperfBitrate(target?.iperfBitrate != null ? String(target.iperfBitrate) : "");

        setBaselineAlerts(target?.baselinePercent != null);
        setBaselinePercent(target?.baselinePercent != null ? String(target.baselinePercent) : "");

        const hasOwn = target != null
            && (target.optimalPing ?? target.optimalDownload ?? target.optimalUpload) != null;
        setOwnOptimals(hasOwn);
        setOptimalPing(target?.optimalPing != null ? String(target.optimalPing) : "");
        setOptimalDownload(target?.optimalDownload != null ? String(target.optimalDownload) : "");
        setOptimalUpload(target?.optimalUpload != null ? String(target.optimalUpload) : "");
        // An existing Ookla target was consented to when it was created.
        setAcceptedOokla(target?.provider === "ookla");
    });

    useEffect(() => {
        if (!open) return;
        jsonRequest("/info/server/ookla").then(setOoklaServers).catch(() => setOoklaServers([]));
        jsonRequest("/info/server/libre").then(setLibreServers).catch(() => setLibreServers([]));
    }, [open]);

    /**
     * Switching provider inside the dialog re-reads that provider's stored
     * server - the row's own when the switch returns to the row's provider,
     * a clean slate otherwise. Keyed on the provider alone, deliberately:
     * `open` here would reset the field under whoever is typing in it when a
     * reopen re-runs the effect, and the row prop would re-run on every list
     * reload - which is exactly the save that used to overwrite an edit in
     * progress in the dialog this replaces.
     */
    useEffect(() => {
        setServerId(provider === target?.provider ? (target?.serverId ?? "none") : "none");
        // The same rule for the endpoint, and asked of whichever providers
        // take one: switching away and back must restore the row's own
        // address, not silently clear a host the operator never edited.
        setEndpoint(takesEndpoint(provider) && provider === target?.provider
            ? (target?.endpoint ?? "") : "");
        // And the seeded name follows the provider it was seeded from, until
        // the operator types one of their own - switching provider before
        // that is still choosing what this target is, and "Ookla" left over
        // on an iperf3 target is a name nobody picked.
        if (!target && !nameTouched)
            setName(uniqueTargetName(providerById(provider)?.name, targetList));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [provider]);

    useEffect(() => {
        if (serverId === "") setServerId("none");
    }, [serverId]);

    const handleEndpointChange = (value) => {
        setEndpoint(value);
        if (value) setServerId("none");
    };

    const handleServerIdChange = (value) => {
        setServerId(value);
        if (provider === "libre" && value && value !== "none") setEndpoint("");
    };

    // Checked, not assumed: put/patchRequest hand back the raw Response, so a
    // refused save must not report the target as saved and close over it.
    const save = async (close) => {
        if (saving) return;
        setSaving(true);

        // Built by targetBody, which owns the three sentinels the fields carry.
        const body = targetBody({name, provider, serverId, endpoint, alerts, ownOptimals,
            optimalPing, optimalDownload, optimalUpload, iperfDuration, iperfStreams,
            iperfUdp, iperfBitrate, baselineAlerts, baselinePercent});

        try {
            if (target) await assertOk(await patchRequest(`/targets/${target.id}`, body), "target");
            else await assertOk(await putRequest("/targets", body), "target");
        } catch (e) {
            updateToast(e.message || t("dropdown.changes_unsaved"), "red", faExclamationTriangle);
            return;
        } finally {
            // However the run ended - a refused value must not leave the
            // dialog locked shut.
            setSaving(false);
        }

        reloadTargets();
        updateToast(t("targets.saved"), "green", faCheck);
        close();
    };

    const isIperf = provider === "iperf3";
    // The value as targetBody will send it - the gate and the body have to
    // judge the same text, or " none" walks past one and is dropped by the
    // other.
    const typedEndpoint = endpoint.trim();
    // "none" is a well-formed hostname *and* the word targetBody sends as no
    // endpoint at all - so a save carrying it would silently drop what was
    // typed: on libre it went out as null behind a green "saved" toast, with
    // the server select hidden by the very text being dropped. Refused for
    // every provider that takes an endpoint.
    const sentinelTyped = takesEndpoint(provider) && typedEndpoint === "none";
    const isUsingCustomUrl = provider === "libre" && Boolean(typedEndpoint) && !sentinelTyped;
    // An iperf3 target with no host has nothing to measure against, and the
    // server refuses one - as it refuses a host it cannot dial, so the same
    // rule it applies is asked here. Said as a button that will not press,
    // rather than as a red toast after the fact.
    const hasEndpoint = !requiresEndpoint(provider) || iperfHostAccepted(endpoint);
    // Typed and wrong, which is not the same as not typed yet: iperfHostAccepted
    // refuses an empty host too, so marking on hasEndpoint alone would paint a
    // fresh iperf3 target red before its operator had touched the field. The
    // dead Update button already says a host is needed; red says this one is
    // not a host.
    const badEndpoint = requiresEndpoint(provider) && endpoint.trim() !== "" && !hasEndpoint;
    /*
     * The same rule the door states, asked here.
     *
     * The id goes out as null when it is empty or the automatic sentinel - see
     * targetBody - so only something actually typed has to be digits. It was
     * not asked at all: "abc" left the button green, went out, and came back a
     * 400 naming a value the operator was looking at, which is the shape this
     * editor answers everywhere else with a button that will not press.
     */
    const serverIdAccepted = !takesServerId(provider) || !serverId || serverId === "none"
        || SERVER_ID_DIGITS.test(serverId);
    // What makes the row saveable at all; the in-flight lock is its own term
    // on the button, so the two reasons for a dead button stay legible apart.
    const canSave = name.trim() !== "" && hasEndpoint && !sentinelTyped && serverIdAccepted
        && (provider !== "ookla" || acceptedOokla)
        && optimalsAccepted({ownOptimals, optimalPing, optimalDownload, optimalUpload})
        // Said as a button that will not press rather than as a red toast
        // after the fact, the rule this file already keeps for the host and
        // the optimals: the door refuses these bounds, and the field that
        // breaks them marks itself below.
        //
        // Asked of the whole run shape rather than field by field, because
        // which of these fields is on the screen depends on the provider and
        // the mode - and a field the dialog is not drawing must not be able to
        // hold the button down. See tuningAccepted.
        && tuningAccepted({provider, iperfDuration, iperfStreams, iperfUdp, iperfBitrate})
        && baselineAccepted(baselinePercent, baselineAlerts);

    const formatServerLabel = (entry) => {
        if (!entry) return "";
        if (typeof entry === "string") return entry;
        const location = [entry.name, entry.country].filter(Boolean).join(", ");
        const head = entry.sponsor || location || entry.host || "";
        const parts = [];
        if (head) parts.push(head);
        if (entry.sponsor && location) parts.push(location);
        const main = parts.join(" - ");
        const distance = (entry.distance || entry.distance === 0) ? ` (${entry.distance} km)` : "";
        return main + distance;
    };

    // The three grading fields, drawn identically; the placeholders are the
    // global values the blank field would inherit.
    const optimalFields = [
        {label: t("latest.ping"), unit: t("welcome.ms"), value: optimalPing,
            set: setOptimalPing, placeholder: config.ping},
        {label: t("latest.down"), unit: t("welcome.mbps"), value: optimalDownload,
            set: setOptimalDownload, placeholder: config.download},
        {label: t("latest.up"), unit: t("welcome.mbps"), value: optimalUpload,
            set: setOptimalUpload, placeholder: config.upload}
    ];

    return (
        <Dialog open={open} onClose={onClose} className="provider-dialog-wrapper">
            {({close}) => (
                <>
                    <DialogHeader onClose={close}>
                        {target ? t("targets.edit_title") : t("targets.add")}
                    </DialogHeader>
                    <DialogBody>
                        <div className="provider-content">
                            <div className="provider-setting target-name-setting">
                                <div className="provider-setting-label">
                                    <FontAwesomeIcon icon={faTag}/>
                                    <h3>{t("targets.name")}</h3>
                                </div>
                                {/* input-error while the name is what holds the
                                    button down, the rule the optimal fields
                                    below already follow: a greyed Add with
                                    every field looking fine names nothing, and
                                    the name is the one field somebody can
                                    empty by hand. */}
                                {/* The heading beside it is the field's name,
                                    but nothing ties the two together - no
                                    label, no htmlFor - so a reader tabbing
                                    straight to the input heard "edit text" and
                                    the placeholder. Said on the input instead,
                                    from the key the heading already renders. */}
                                <input type="text"
                                       aria-label={t("targets.name")}
                                       className={`dialog-input provider-input${name.trim() === "" ? " input-error" : ""}`}
                                       placeholder={t("targets.name_placeholder")}
                                       value={name} maxLength={64}
                                       onChange={(e) => {
                                           setNameTouched(true);
                                           setName(e.target.value);
                                       }}/>
                            </div>

                            <SelectableList className="provider-list">
                                {providers.map((current) => (
                                    <SelectableOption key={current.id}
                                                      icon={current.icon}
                                                      image={current.image
                                                          ? {src: current.image, alt: current.name} : undefined}
                                                      title={current.name}
                                                      description={t(`dialog.provider.${current.id}_desc`)}
                                                      active={current.id === provider}
                                                      onClick={() => setProvider(current.id)}/>
                                ))}
                            </SelectableList>

                            <div className="provider-settings">
                                {takesServerId(provider) && !isUsingCustomUrl && (
                                    <div className="provider-setting">
                                        <div className="provider-setting-label">
                                            <FontAwesomeIcon icon={faServer}/>
                                            <h3>{t("dialog.provider.server")}</h3>
                                        </div>
                                        <span className="select-wrap provider-input-wrap">
                                            <select className="dialog-input select-field provider-input" value={serverId}
                                                    aria-label={t("dialog.provider.server")}
                                                    onChange={(e) => handleServerIdChange(e.target.value)}>
                                                <option value="none">{t("dialog.provider.choose_automatically")}</option>
                                                {provider === "ookla" && Object.keys(ooklaServers).map((current, index) => (
                                                    <option key={index} value={current}>{formatServerLabel(ooklaServers[current])}</option>
                                                ))}
                                                {provider === "libre" && Object.keys(libreServers).map((current, index) => (
                                                    <option key={index} value={current}>{formatServerLabel(libreServers[current])}</option>
                                                ))}
                                            </select>
                                        </span>
                                    </div>
                                )}

                                {/* Not gated on a server having been chosen already,
                                    which is upstream #1455. The list above is the
                                    twenty speedtest.net returns for the *instance's*
                                    address, so a server in another country is not in
                                    it - and this input, the one way to name one, was
                                    drawn only once something had been picked from
                                    the list it is there to escape. The two conditions
                                    that remain are real: cloudflare has one endpoint
                                    and no id, and a custom LibreSpeed URL is itself
                                    the server. */}
                                {takesServerId(provider) && !isUsingCustomUrl && (
                                    <div className="provider-setting">
                                        <div className="provider-setting-label">
                                            <FontAwesomeIcon icon={faHashtag}/>
                                            <h3>{t("dialog.provider.server_id")}</h3>
                                        </div>
                                        {/* Red beside the dead button, the way the
                                            endpoint and the optimals mark themselves:
                                            the door takes digits and nothing else. */}
                                        <input type="text"
                                               aria-label={t("dialog.provider.server_id")}
                                               className={`dialog-input provider-input${serverIdAccepted ? "" : " input-error"}`}
                                               placeholder={t("dialog.provider.server_id_placeholder")}
                                               value={serverId === "none" ? "" : serverId}
                                               onChange={(e) => handleServerIdChange(e.target.value)}/>
                                    </div>
                                )}

                                {takesEndpoint(provider) && (
                                    <div className="provider-setting">
                                        <div className="provider-setting-label">
                                            <FontAwesomeIcon icon={isIperf ? faServer : faLink}/>
                                            {/* Two names for one field: a
                                                LibreSpeed backend is a URL,
                                                and an iperf3 server is a host
                                                and port. */}
                                            <h3>{t(isIperf ? "dialog.provider.iperf_host"
                                                : "dialog.provider.custom_url")}</h3>
                                        </div>
                                        {/* input-error beside the dead button, the way a refused
                                            optimal marks itself: "none" is the one host a save
                                            would silently drop, and a greyed Update with every
                                            field looking fine names nothing. */}
                                        <input type="text"
                                               aria-label={t(isIperf ? "dialog.provider.iperf_host"
                                                   : "dialog.provider.custom_url")}
                                               className={`dialog-input provider-input${sentinelTyped || badEndpoint ? " input-error" : ""}`}
                                               placeholder={isIperf ? IPERF_HOST_PLACEHOLDER
                                                   : CUSTOM_BACKEND_PLACEHOLDER}
                                               value={endpoint}
                                               onChange={(e) => handleEndpointChange(e.target.value)}/>
                                    </div>
                                )}

                                {/* How long the run lasts and how many streams
                                    it opens - the two knobs a self-hosted
                                    server's operator actually turns. Left
                                    blank they store null, which is the
                                    runner's own default: a target nobody
                                    tuned runs exactly as it did before these
                                    existed. Only for the provider that lets a
                                    target say; the other three decide their
                                    own run. */}
                                {takesTuning(provider) && (
                                    <div className="provider-setting target-tuning-setting">
                                        <div className="provider-setting-label">
                                            <FontAwesomeIcon icon={faStopwatch}/>
                                            <h3>{t("dialog.provider.iperf_advanced")}</h3>
                                        </div>
                                        <div className="target-tuning-fields">
                                            {/* input-error beside the dead button, like the
                                                optimals: a spinner steps past the bounds the
                                                door holds these to, and a greyed Add with
                                                every field looking fine names nothing. */}
                                            <label className="target-tuning-field">
                                                <span>{t("dialog.provider.iperf_duration")}</span>
                                                <input type="number"
                                                       className={`dialog-input${durationAccepted(iperfDuration) ? "" : " input-error"}`}
                                                       min={TUNING_BOUNDS.duration.min}
                                                       max={TUNING_BOUNDS.duration.max}
                                                       placeholder={String(IPERF_DEFAULTS.duration)}
                                                       value={iperfDuration}
                                                       onChange={(e) => setIperfDuration(e.target.value)}/>
                                            </label>
                                            {/* One field or the other, never both.
                                                A UDP run carries a single stream on
                                                the build this downloads, so a stream
                                                count under it is a control that does
                                                nothing - and the rate takes its place
                                                because a UDP run must name one. */}
                                            {iperfUdp ? (
                                                <label className="target-tuning-field">
                                                    <span>{t("dialog.provider.iperf_bitrate")}</span>
                                                    <input type="number"
                                                           className={`dialog-input${bitrateAccepted(iperfBitrate, iperfUdp) ? "" : " input-error"}`}
                                                           min={TUNING_BOUNDS.bitrate.min}
                                                           max={TUNING_BOUNDS.bitrate.max}
                                                           placeholder={String(TUNING_BOUNDS.bitrate.min)}
                                                           value={iperfBitrate}
                                                           onChange={(e) => setIperfBitrate(e.target.value)}/>
                                                </label>
                                            ) : (
                                                <label className="target-tuning-field">
                                                    <span>{t("dialog.provider.iperf_streams")}</span>
                                                    <input type="number"
                                                           className={`dialog-input${streamsAccepted(iperfStreams) ? "" : " input-error"}`}
                                                           min={TUNING_BOUNDS.streams.min}
                                                           max={TUNING_BOUNDS.streams.max}
                                                           placeholder={String(IPERF_DEFAULTS.streams)}
                                                           value={iperfStreams}
                                                           onChange={(e) => setIperfStreams(e.target.value)}/>
                                                </label>
                                            )}
                                        </div>
                                        {/* Not a provider-setting-switch: those are
                                            whole rows and draw their own border, and
                                            this one lives inside the bordered row above
                                            rather than beside it. */}
                                        <div className="target-tuning-switch">
                                            <h3>{t("dialog.provider.iperf_udp")}</h3>
                                            <ToggleSwitch checked={iperfUdp} onChange={setIperfUdp}
                                                          label={t("dialog.provider.iperf_udp")}/>
                                        </div>
                                    </div>
                                )}

                                {/* -switch on both of these: a toggle brings no
                                    border of its own, so the row draws one to
                                    tie the pill to the words it answers to.
                                    The rows above end in a field, which has an
                                    edge already. */}
                                <div className="provider-setting provider-setting-switch">
                                    <div className="provider-setting-label">
                                        <h3>{t("targets.alerts")}</h3>
                                    </div>
                                    <ToggleSwitch checked={alerts} onChange={setAlerts}
                                                  label={t("targets.alerts")}/>
                                </div>

                                <div className="provider-setting provider-setting-switch">
                                    <div className="provider-setting-label">
                                        <h3>{t("targets.own_optimals")}</h3>
                                    </div>
                                    <ToggleSwitch checked={ownOptimals} onChange={setOwnOptimals}
                                                  label={t("targets.own_optimals")}/>
                                </div>

                                {/* Directly under the switch that reveals them.
                                    Written after the baseline block below, the
                                    three inputs arrived two switches down the
                                    dialog with the baseline's own field in
                                    between - so pressing "Own optimal values"
                                    opened fields under somebody else's
                                    heading. */}
                                {ownOptimals && (
                                    <div className="target-optimals">
                                        {optimalFields.map(({label, unit, value, set, placeholder}) => (
                                            <label key={label} className="target-optimal">
                                                <span className="target-optimal-label">
                                                    {/* No brackets of our own: welcome.ms is "(in ms)"
                                                        and welcome.mbps is "(in Mbps)" - the locale
                                                        writes the parenthetical whole, because where
                                                        the bracket goes is part of the translation.
                                                        Adding a pair here read "Ping ((in ms))" in all
                                                        twenty-three languages. */}
                                                    {label} <span className="target-optimal-unit">{unit}</span>
                                                </span>
                                                {/* input-error beside the dead button: min="0" lets
                                                    the spinner step to a 0 the save then refuses, and
                                                    a greyed Update with every other field looking
                                                    fine names nothing. The pause dialog marks its own
                                                    "above zero" rule the same way. */}
                                                <input type="number"
                                                       className={`dialog-input${optimalAccepted(value) ? "" : " input-error"}`}
                                                       min="0" placeholder={placeholder || ""}
                                                       value={value} onChange={(e) => set(e.target.value)}/>
                                            </label>
                                        ))}
                                    </div>
                                )}

                                {/* Every provider, unlike the run settings
                                    above: a baseline is about what a target
                                    measures rather than how it measures it.
                                    Switching it on fills the field, because
                                    the column IS the switch - an empty field
                                    stores null, which is how a target says it
                                    has no baseline, so a toggle that switched
                                    on to nothing would not do what it says. */}
                                <div className="provider-setting provider-setting-switch">
                                    <div className="provider-setting-label">
                                        <h3>{t("targets.baseline_alerts")}</h3>
                                    </div>
                                    <ToggleSwitch checked={baselineAlerts}
                                                  onChange={(on) => {
                                                      setBaselineAlerts(on);
                                                      if (on && baselinePercent === "")
                                                          setBaselinePercent(String(BASELINE_PERCENT_DEFAULT));
                                                  }}
                                                  label={t("targets.baseline_alerts")}/>
                                </div>

                                {baselineAlerts && (
                                    <div className="target-baseline">
                                        <label className="target-optimal">
                                            <span className="target-optimal-label">
                                                {t("targets.baseline_percent")}
                                            </span>
                                            <input type="number"
                                                   className={`dialog-input${baselineAccepted(baselinePercent, baselineAlerts) ? "" : " input-error"}`}
                                                   min={BASELINE_BOUNDS.min} max={BASELINE_BOUNDS.max}
                                                   placeholder={String(BASELINE_PERCENT_DEFAULT)}
                                                   value={baselinePercent}
                                                   onChange={(e) => setBaselinePercent(e.target.value)}/>
                                        </label>
                                        <p className="target-baseline-note">{t("targets.baseline_desc")}</p>
                                    </div>
                                )}
                            </div>

                            {provider === "ookla" && (
                                <label className="provider-license">
                                    {/* No `label` here on purpose: the <label>
                                        this sits inside names the input with
                                        the licence sentence beside it, and an
                                        aria-label would replace that with
                                        something shorter and worse. */}
                                    <Checkbox checked={acceptedOokla} onChange={setAcceptedOokla}/>
                                    <span>
                                        <Trans components={{
                                            Eula: <a href="https://www.speedtest.net/about/eula" target="_blank" rel="noreferrer"/>,
                                            GDPR: <a href="https://www.speedtest.net/about/privacy" target="_blank" rel="noreferrer"/>,
                                            TOS: <a href="https://www.speedtest.net/about/terms" target="_blank" rel="noreferrer"/>
                                        }}>dialog.provider.ookla_license</Trans>
                                    </span>
                                </label>
                            )}
                        </div>
                    </DialogBody>
                    <DialogFooter>
                        <button className="dialog-btn" onClick={() => save(close)}
                                disabled={!canSave || saving}>
                            {target ? t("dialog.update") : t("targets.add")}
                        </button>
                    </DialogFooter>
                </>
            )}
        </Dialog>
    );
};
