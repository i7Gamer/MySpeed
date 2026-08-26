import {Dialog, DialogHeader, DialogBody, DialogFooter} from "@/common/contexts/Dialog";
import {t} from "i18next";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {
    faCheck, faServer, faLink, faHashtag, faExclamationTriangle, faTag
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
import {useSyncOnOpen} from "@/common/hooks/useSyncOnOpen";
import {CUSTOM_BACKEND_PLACEHOLDER, IPERF_HOST_PLACEHOLDER} from "@/common/utils/InvariantText";
import {providers, requiresEndpoint, takesEndpoint, takesServerId} from "./providers";
import {targetBody} from "./targetBody";

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
    const {reloadTargets} = useContext(TargetsContext);
    const updateToast = useContext(ToastNotificationContext);
    // Read when the dialog opens, not at mount - see useSyncOnOpen. The server
    // id and endpoint keep their own effect below: they also follow provider
    // switches while the dialog is in use.
    const [name, setName] = useState("");
    const [provider, setProvider] = useState("ookla");
    const [serverId, setServerId] = useState("none");
    const [endpoint, setEndpoint] = useState("none");
    const [alerts, setAlerts] = useState(true);
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
        setName(target?.name ?? "");
        setProvider(target?.provider ?? "ookla");
        setServerId(target?.serverId ?? "none");
        setEndpoint(target?.endpoint ?? "none");
        // sqlite hands the flag back as 0/1 under the global raw:true.
        setAlerts(target ? Boolean(target.alerts) : true);

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
            ? (target?.endpoint ?? "none") : "none");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [provider]);

    useEffect(() => {
        if (serverId === "") setServerId("none");
    }, [serverId]);

    useEffect(() => {
        if (endpoint === "") setEndpoint("none");
    }, [endpoint]);

    const handleEndpointChange = (value) => {
        setEndpoint(value);
        if (value && value !== "none") setServerId("none");
    };

    const handleServerIdChange = (value) => {
        setServerId(value);
        if (provider === "libre" && value && value !== "none") setEndpoint("none");
    };

    // Checked, not assumed: put/patchRequest hand back the raw Response, so a
    // refused save must not report the target as saved and close over it.
    const save = async (close) => {
        if (saving) return;
        setSaving(true);

        // Built by targetBody, which owns the three sentinels the fields carry.
        const body = targetBody({name, provider, serverId, endpoint, alerts, ownOptimals,
            optimalPing, optimalDownload, optimalUpload});

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
    const isUsingCustomUrl = provider === "libre" && endpoint && endpoint !== "none";
    // An iperf3 target with no host has nothing to measure against, and the
    // server refuses one. Said here as a button that will not press, rather
    // than as a red toast after the fact.
    const hasEndpoint = !requiresEndpoint(provider) || (endpoint && endpoint !== "none"
        && endpoint.trim() !== "");
    // What makes the row saveable at all; the in-flight lock is its own term
    // on the button, so the two reasons for a dead button stay legible apart.
    const canSave = name.trim() !== "" && hasEndpoint && (provider !== "ookla" || acceptedOokla);

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
                                <input type="text" className="dialog-input provider-input"
                                       placeholder={t("targets.name_placeholder")}
                                       value={name} maxLength={64}
                                       onChange={(e) => setName(e.target.value)}/>
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
                                        <select className="dialog-input provider-input" value={serverId}
                                                onChange={(e) => handleServerIdChange(e.target.value)}>
                                            <option value="none">{t("dialog.provider.choose_automatically")}</option>
                                            {provider === "ookla" && Object.keys(ooklaServers).map((current, index) => (
                                                <option key={index} value={current}>{formatServerLabel(ooklaServers[current])}</option>
                                            ))}
                                            {provider === "libre" && Object.keys(libreServers).map((current, index) => (
                                                <option key={index} value={current}>{formatServerLabel(libreServers[current])}</option>
                                            ))}
                                        </select>
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
                                        <input type="text" className="dialog-input provider-input"
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
                                        <input type="text" className="dialog-input provider-input"
                                               placeholder={isIperf ? IPERF_HOST_PLACEHOLDER
                                                   : CUSTOM_BACKEND_PLACEHOLDER}
                                               value={endpoint === "none" ? "" : endpoint}
                                               onChange={(e) => handleEndpointChange(e.target.value || "none")}/>
                                    </div>
                                )}

                                <div className="provider-setting">
                                    <div className="provider-setting-label">
                                        <h3>{t("targets.alerts")}</h3>
                                    </div>
                                    <ToggleSwitch checked={alerts} onChange={setAlerts}
                                                  label={t("targets.alerts")}/>
                                </div>

                                <div className="provider-setting">
                                    <div className="provider-setting-label">
                                        <h3>{t("targets.own_optimals")}</h3>
                                    </div>
                                    <ToggleSwitch checked={ownOptimals} onChange={setOwnOptimals}
                                                  label={t("targets.own_optimals")}/>
                                </div>

                                {ownOptimals && (
                                    <div className="target-optimals">
                                        {optimalFields.map(({label, unit, value, set, placeholder}) => (
                                            <label key={label} className="target-optimal">
                                                <span className="target-optimal-label">
                                                    {label} <span className="target-optimal-unit">({unit})</span>
                                                </span>
                                                <input type="number" className="dialog-input" min="0"
                                                       placeholder={placeholder || ""}
                                                       value={value} onChange={(e) => set(e.target.value)}/>
                                            </label>
                                        ))}
                                    </div>
                                )}
                            </div>

                            {provider === "ookla" && (
                                <label className="provider-license">
                                    <input
                                        type="checkbox"
                                        checked={acceptedOokla}
                                        onChange={(e) => setAcceptedOokla(e.target.checked)}
                                    />
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
