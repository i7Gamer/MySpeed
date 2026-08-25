import React, {useContext, useState} from "react";
import {deleteRequest, downloadRequest, putRequest} from "@/common/utils/RequestUtil";
import {chooseAndReadJson} from "@/common/utils/FileImport";
import {ToastNotificationContext} from "@/common/contexts/ToastNotification";
import {ConfigContext} from "@/common/contexts/Config";
import {t} from "i18next";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import ToggleSwitch from "@/common/components/ToggleSwitch";
import {faClockRotateLeft, faFileExport, faFileImport} from "@fortawesome/free-solid-svg-icons";

export default ({close}) => {
    const [deleteWarning, setDeleteWarning] = useState(false);
    const updateConfig = useContext(ConfigContext)[1];
    const updateToast = useContext(ToastNotificationContext);

    // Off by default, and stated rather than assumed: a plain export is safe to
    // attach to a bug report, while the one that restores an instance verbatim
    // carries node passwords, integration tokens and the admin password hash.
    const [includeSecrets, setIncludeSecrets] = useState(false);

    // Every action below answers with a toast either way: the helpers hand
    // back the raw response, and a refused reset used to report "completed"
    // over a configuration the server had left untouched.
    const exportConfig = () => {
        downloadRequest(`/storage/config${includeSecrets ? "?includeSecrets=true" : ""}`).then(() => {
            updateToast(t("storage.settings_exported"), "green", faFileExport);
            close();
        }).catch((error) => updateToast(error.message || t("dropdown.changes_unsaved"), "red"));
    }

    const importConfig = async () => {
        // The helper owns the picker and the parse: a truncated backup used to
        // throw uncaught inside reader.onload, and nothing on screen moved.
        let data;
        try {
            data = await chooseAndReadJson();
        } catch {
            return updateToast(t("storage.import_config_error"), "red");
        }

        if (data === null) return;

        const res = await putRequest("/storage/config", data).catch(() => null);

        // A restore is abandoned whole on the first value it cannot read, and the
        // route names that value. Reading only res.ok left the operator holding a
        // file that would not go back and every stored key to bisect by hand -
        // which is exactly what the server had already worked out and sent.
        const body = res?.ok ? null : await res?.json().catch(() => null);

        if (res?.ok) {
            updateToast(t("storage.settings_imported"), "green", faFileImport);
            updateConfig();
        } else {
            updateToast(body?.key
                ? t("storage.import_config_error_key", {key: body.key})
                : t("storage.import_config_error"), "red");
        }
        close();
    }

    const factoryReset = () => {
        if (!deleteWarning) {
            setDeleteWarning(true);
            return;
        }

        deleteRequest("/storage/config").then((res) => {
            setDeleteWarning(false);
            if (!res.ok) return updateToast(t("dropdown.changes_unsaved"), "red");

            updateToast(t("storage.factory_reset_completed"), "green", faClockRotateLeft);
            updateConfig();
            close();
        }).catch(() => updateToast(t("dropdown.changes_unsaved"), "red"));
    }

    return (
        <>
            <div className="storage-row">
                <div className="storage-row-label">
                    <FontAwesomeIcon icon={faFileExport}/>
                    <h3>{t("storage.export_settings")}</h3>
                    <p className="storage-row-hint">
                        {t(includeSecrets ? "storage.export_with_secrets_desc" : "storage.export_redacted_desc")}
                    </p>
                </div>
                <div className="storage-row-actions">
                    <label className="storage-row-toggle">
                        <span>{t("storage.include_secrets")}</span>
                        <ToggleSwitch checked={includeSecrets} onChange={setIncludeSecrets}
                                      label={t("storage.include_secrets")}/>
                    </label>
                    <button className="dialog-btn" onClick={exportConfig}>{t("storage.export")}</button>
                </div>
            </div>

            <div className="storage-row">
                <div className="storage-row-label">
                    <FontAwesomeIcon icon={faFileImport}/>
                    <h3>{t("storage.import_settings")}</h3>
                </div>
                <div className="storage-row-actions">
                    <button className="dialog-btn" onClick={importConfig}>{t("storage.import")}</button>
                </div>
            </div>

            <div className="storage-row">
                <div className="storage-row-label">
                    <FontAwesomeIcon icon={faClockRotateLeft}/>
                    <h3>{t("storage.factory_reset")}</h3>
                </div>
                <div className="storage-row-actions">
                    <button className="dialog-btn dialog-secondary" onClick={factoryReset}>
                        {deleteWarning ? t("storage.confirm_reset") : t("storage.reset")}</button>
                </div>
            </div>
        </>
    )
}