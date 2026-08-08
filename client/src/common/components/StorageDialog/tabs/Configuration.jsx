import React, {useContext, useState} from "react";
import {deleteRequest, downloadRequest, putRequest} from "@/common/utils/RequestUtil";
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

    const exportConfig = () => {
        downloadRequest(`/storage/config${includeSecrets ? "?includeSecrets=true" : ""}`).then(() => {
            updateToast(t("storage.settings_exported"), "green", faFileExport);
            close();
        });
    }

    const importConfig = () => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json";

        input.onchange = () => {
            const file = input.files[0];
            const reader = new FileReader();
            reader.readAsText(file);

            reader.onload = () => {
                const data = JSON.parse(reader.result);
                putRequest("/storage/config", data).then((res) => {
                    if (res.ok) {
                        updateToast(t("storage.settings_imported"), "green", faFileImport);
                        updateConfig();
                        close();
                    } else {
                        updateToast(t("storage.import_config_error"), "red");
                        close();
                    }
                });
            }
            input.remove();
        }

        input.click();
    }

    const factoryReset = () => {
        if (!deleteWarning) {
            setDeleteWarning(true);
            return;
        }

        deleteRequest("/storage/config").then(() => {
            setDeleteWarning(false);
            updateToast(t("storage.factory_reset_completed"), "green", faClockRotateLeft);
            updateConfig();
            close();
        });
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
                        <ToggleSwitch checked={includeSecrets} onChange={setIncludeSecrets}/>
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