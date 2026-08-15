import {Dialog, DialogHeader, DialogBody, DialogFooter} from "@/common/contexts/Dialog";
import {t} from "i18next";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faCheck, faServer, faNetworkWired, faLink, faHashtag, faExclamationTriangle} from "@fortawesome/free-solid-svg-icons";
import "./styles.sass";
import React, {useContext, useEffect, useState} from "react";
import OoklaImage from "./assets/img/ookla.webp";
import LibreImage from "./assets/img/libre.webp";
import CloudflareImage from "./assets/img/cloudflare.webp";
import {assertOk, jsonRequest, patchRequest} from "@/common/utils/RequestUtil";
import {Trans} from "react-i18next";
import {ConfigContext} from "@/common/contexts/Config";
import {ToastNotificationContext} from "@/common/contexts/ToastNotification";
import SelectableOption, {SelectableList} from "@/common/components/SelectableOption";
import {useSyncOnOpen} from "@/common/hooks/useSyncOnOpen";

export const providers = [
    {id: "ookla", name: "Ookla", image: OoklaImage},
    {id: "libre", name: "LibreSpeed", image: LibreImage},
    {id: "cloudflare", name: "Cloudflare", image: CloudflareImage}
];

export const ProviderDialog = ({open, onClose}) => {
    const [config, reloadConfig] = useContext(ConfigContext);
    const updateToast = useContext(ToastNotificationContext);
    // Read when the dialog opens, not at mount - see useSyncOnOpen. The server
    // id and libre URL keep their own effect below: they also follow provider
    // switches while the dialog is in use.
    const [provider, setProvider] = useState("ookla");
    const [interfaces, setInterfaces] = useState({});
    const [currentInterface, setCurrentInterface] = useState("none");
    const [ooklaServers, setOoklaServers] = useState({});
    const [libreServers, setLibreServers] = useState({});
    const [serverId, setServerId] = useState("none");
    const [libreUrl, setLibreUrl] = useState("none");
    const [acceptedOokla, setAcceptedOokla] = useState(false);

    useSyncOnOpen(open, () => {
        const stored = config.provider || "ookla";

        setProvider(stored);
        setCurrentInterface(config.interface || "none");
        setAcceptedOokla(config.provider === "ookla");
        setServerId(config[stored + "Id"] || "none");
        setLibreUrl(config.libreUrl || "none");
    });

    useEffect(() => {
        if (!open) return;
        jsonRequest("/info/server/ookla").then(setOoklaServers).catch(() => setOoklaServers([]));
        jsonRequest("/info/server/libre").then(setLibreServers).catch(() => setLibreServers([]));
        jsonRequest("/info/interfaces").then(setInterfaces).catch(() => setInterfaces([]));
    }, [open]);

    /**
     * Switching provider inside the dialog re-reads that provider's stored
     * server. Keyed on the provider alone.
     *
     * With `config` in the list too, the only thing that reset these fields was
     * a config reload - which happens on save. So an edit the operator
     * abandoned by closing the dialog survived, was shown on reopen as though
     * it were what is stored, and was then written by the next unrelated save,
     * because it differed from the config. It went both ways: an abandoned
     * "choose automatically" overwrote a stored server id just as readily.
     */
    useEffect(() => {
        if (!open) return;

        setServerId(config[provider + "Id"] || "none");
        // The provider alone, deliberately - see above. `config` here would
        // re-run on every config reload, which is exactly the save that used to
        // overwrite an edit in progress; `open` would reset the field under
        // whoever was typing in it when a reopen re-ran the effect.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [provider]);

    useEffect(() => {
        if (serverId === "") setServerId("none");
    }, [serverId]);

    useEffect(() => {
        if (libreUrl === "") setLibreUrl("none");
    }, [libreUrl]);

    const handleLibreUrlChange = (value) => {
        setLibreUrl(value);
        if (value && value !== "none") setServerId("none");
    };

    const handleServerIdChange = (value) => {
        setServerId(value);
        if (provider === "libre" && value && value !== "none") setLibreUrl("none");
    };

    // Every write is checked: patchRequest hands back the raw response, so a
    // rejected value used to leave the dialog reporting "provider changed" and
    // closing over settings the server had refused.
    const update = async (close) => {
        const patch = async (path, value) => assertOk(await patchRequest(path, {value}), path);

        try {
            await patch("/config/provider", provider);

            if (serverId !== config[provider + "Id"] && provider !== "cloudflare")
                await patch("/config/" + provider + "Id", serverId);

            if (provider === "libre" && libreUrl !== config.libreUrl)
                await patch("/config/libreUrl", libreUrl);

            if (currentInterface !== config.interface)
                await patch("/config/interface", currentInterface);
        } catch (e) {
            updateToast(e.message || t("dropdown.changes_unsaved"), "red", faExclamationTriangle);
            return;
        } finally {
            reloadConfig();
        }

        updateToast(t('dropdown.provider_changed'), "green", faCheck);
        close();
    };

    const isUsingCustomUrl = provider === "libre" && libreUrl && libreUrl !== "none";
    const canUpdate = provider !== "ookla" || acceptedOokla;

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

    return (
        <Dialog open={open} onClose={onClose} className="provider-dialog-wrapper">
            {({close}) => (
                <>
                    <DialogHeader onClose={close}>{t("update.provider_title")}</DialogHeader>
                    <DialogBody>
                        <div className="provider-content">
                            <SelectableList className="provider-list">
                                {providers.map((current) => (
                                    <SelectableOption key={current.id}
                                                      image={{src: current.image, alt: current.name}}
                                                      title={current.name}
                                                      description={t(`dialog.provider.${current.id}_desc`)}
                                                      active={current.id === provider}
                                                      onClick={() => setProvider(current.id)}/>
                                ))}
                            </SelectableList>

                            <div className="provider-settings">
                                <div className="provider-setting">
                                    <div className="provider-setting-label">
                                        <FontAwesomeIcon icon={faNetworkWired}/>
                                        <h3>{t("dialog.provider.interface")}</h3>
                                    </div>
                                    <select className="dialog-input provider-input" value={currentInterface}
                                            onChange={(e) => setCurrentInterface(e.target.value)}>
                                        {interfaces && Object.keys(interfaces).map((current, index) => (
                                            <option key={index} value={current}>{current} ({interfaces[current]})</option>
                                        ))}
                                    </select>
                                </div>

                                {provider !== "cloudflare" && !isUsingCustomUrl && (
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

                                {provider !== "cloudflare" && serverId !== "none" && !isUsingCustomUrl && (
                                    <div className="provider-setting">
                                        <div className="provider-setting-label">
                                            <FontAwesomeIcon icon={faHashtag}/>
                                            <h3>{t("dialog.provider.server_id")}</h3>
                                        </div>
                                        <input type="text" className="dialog-input provider-input"
                                               value={serverId === "none" ? "" : serverId}
                                               onChange={(e) => handleServerIdChange(e.target.value)}/>
                                    </div>
                                )}

                                {provider === "libre" && (
                                    <div className="provider-setting">
                                        <div className="provider-setting-label">
                                            <FontAwesomeIcon icon={faLink}/>
                                            <h3>{t("dialog.provider.custom_url")}</h3>
                                        </div>
                                        <input type="text" className="dialog-input provider-input"
                                               placeholder={t("dialog.provider.custom_url_placeholder")}
                                               value={libreUrl === "none" ? "" : libreUrl}
                                               onChange={(e) => handleLibreUrlChange(e.target.value || "none")}/>
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
                        <button className="dialog-btn" onClick={() => update(close)} disabled={!canUpdate}>{t("dialog.update")}</button>
                    </DialogFooter>
                </>
            )}
        </Dialog>
    );
};