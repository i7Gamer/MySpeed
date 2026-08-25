import React, {useContext, useEffect, useState} from "react";
import {deleteRequest, downloadRequest, patchRequest, putRequest} from "@/common/utils/RequestUtil";
import {chooseAndReadJson} from "@/common/utils/FileImport";
import {SpeedtestContext} from "@/common/contexts/Speedtests";
import {ConfigContext} from "@/common/contexts/Config";
import {ToastNotificationContext} from "@/common/contexts/ToastNotification";
import {t} from "i18next";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faFileExport, faFileImport, faTrashCan, faChartLine, faClockRotateLeft, faCheck, faArrowLeft} from "@fortawesome/free-solid-svg-icons";
import {EXPORT_FORMATS, RETENTION_DAYS_PLACEHOLDER} from "@/common/utils/InvariantText";

const RETENTION_PRESETS = [
    {id: "week", days: 7},
    {id: "month", days: 30},
    {id: "quarter", days: 90},
    {id: "half_year", days: 180},
    {id: "year", days: 365},
    {id: "forever", days: 0}
];

const matchPreset = (days) => RETENTION_PRESETS.find(p => p.days === days)?.id || "custom";

export default ({tests, close}) => {
    const [deleteWarning, setDeleteWarning] = useState(false);
    // Both actions below replace the history rather than add to it, so neither
    // can be reconciled by a refresh of the newest page: an empty answer used
    // to be read as "nothing to do", and an import appends older rows that page
    // never sees. A full reload is the only honest answer to either.
    const {reloadTests} = useContext(SpeedtestContext);
    const [config, reloadConfig] = useContext(ConfigContext);
    const updateToast = useContext(ToastNotificationContext);

    const initialDays = parseInt(config?.retentionDays ?? "365");
    const [retentionSelected, setRetentionSelected] = useState(matchPreset(initialDays));
    const [retentionCustom, setRetentionCustom] = useState(String(initialDays));
    const [savingRetention, setSavingRetention] = useState(false);

    useEffect(() => {
        const days = parseInt(config?.retentionDays ?? "365");
        setRetentionSelected(matchPreset(days));
        setRetentionCustom(String(days));
    }, [config?.retentionDays]);

    const handleSelectChange = (value) => {
        setRetentionSelected(value);
        if (value === "custom") {
            setRetentionCustom(String(initialDays));
        }
    };

    const exitCustomMode = () => {
        const savedPreset = matchPreset(initialDays);
        const target = savedPreset === "custom" ? "year" : savedPreset;
        setRetentionSelected(target);
        setRetentionCustom(String(initialDays));
    };

    const currentRetentionDays = retentionSelected === "custom"
        ? parseInt(retentionCustom)
        : RETENTION_PRESETS.find(p => p.id === retentionSelected)?.days;

    const isRetentionValid = retentionSelected !== "custom"
        || (!isNaN(currentRetentionDays) && currentRetentionDays >= 0 && currentRetentionDays <= 10000);

    const isRetentionDirty = String(currentRetentionDays) !== String(initialDays);

    const saveRetention = async () => {
        if (!isRetentionValid) return;
        setSavingRetention(true);
        // patchRequest *rejects* on a dropped connection or its ten second
        // abort rather than answering a non-ok response, and the rejection
        // escaped a bare onClick - so the flag was never cleared and no toast
        // appeared. The button sat disabled reading "Saving..." until the tab
        // unmounted, while every sibling mutation here reported the failure.
        const res = await patchRequest("/config/retentionDays",
            {value: String(currentRetentionDays)}).catch(() => null);
        setSavingRetention(false);
        if (res?.ok) {
            updateToast(t("storage.retention_saved"), "green", faCheck);
            reloadConfig();
        } else {
            updateToast(t("dropdown.changes_unsaved"), "red");
        }
    };

    // Every action below answers with a toast either way: the helpers hand
    // back the raw response, and a refused delete used to report "history
    // cleared" over a table the server had left untouched.
    const deleteHistory = () => {
        if (!deleteWarning) {
            setDeleteWarning(true);
            return;
        }

        deleteRequest("/storage/tests/history").then((res) => {
            setDeleteWarning(false);
            if (!res.ok) return updateToast(t("dropdown.changes_unsaved"), "red");

            reloadTests();
            updateToast(t("storage.history_cleared"), "green", faTrashCan);
            close();
        }).catch(() => updateToast(t("dropdown.changes_unsaved"), "red"));
    }

    const downloadHistory = (type) => {
        downloadRequest(`/storage/tests/history/${type}`).then(() => {
            updateToast(t("storage.tests_exported"), "green", faFileExport);
            close();
        }).catch((error) => updateToast(error.message || t("dropdown.changes_unsaved"), "red"));
    }

    const importHistory = async () => {
        // The helper owns the picker and the parse: a truncated backup used to
        // throw uncaught inside reader.onload, and nothing on screen moved.
        let data;
        try {
            data = await chooseAndReadJson();
        } catch {
            return updateToast(t("storage.import_test_error"), "red");
        }

        if (data === null) return;

        const res = await putRequest("/storage/tests/history", data).catch(() => null);

        // The route sends `imported` and `skipped` on purpose - "the counts
        // travel with the message" - and reading only res.ok threw them away, so
        // a file whose rows were nearly all refused answered in the same green as
        // one that restored whole. A partly usable backup is the case an operator
        // most needs told, and it is the one that looked most like success.
        const body = await res?.json().catch(() => null);
        const skipped = Number(body?.skipped) || 0;

        if (res?.ok) {
            updateToast(skipped
                    ? t("storage.tests_imported_partial", {imported: Number(body?.imported) || 0, skipped})
                    : t("storage.tests_imported"),
                skipped ? "orange" : "green", faFileImport);
            reloadTests();
        } else {
            updateToast(t("storage.import_test_error"), "red");
        }
        close();
    }


    return (
        <>
            <div className="storage-row">
                <div className="storage-row-label">
                    <FontAwesomeIcon icon={faChartLine}/>
                    <h3>{t("storage.stored_tests")}</h3>
                </div>
                <p className="storage-row-value">{tests} {t("storage.tests")}</p>
            </div>

            <div className="storage-row">
                <div className="storage-row-label">
                    <FontAwesomeIcon icon={faClockRotateLeft}/>
                    <h3 title={t("storage.retention_desc")}>{t("storage.retention")}</h3>
                </div>
                <div className="storage-row-actions storage-retention-controls">
                    {retentionSelected === "custom" ? (
                        <>
                            <button
                                type="button"
                                className="storage-icon-btn"
                                onClick={exitCustomMode}
                                title={t("storage.retention_back")}
                                aria-label={t("storage.retention_back")}
                            >
                                <FontAwesomeIcon icon={faArrowLeft}/>
                            </button>
                            <div className="storage-input-wrap">
                                <input
                                    type="number"
                                    min="0"
                                    max="10000"
                                    className={`storage-input${!isRetentionValid ? " input-error" : ""}`}
                                    value={retentionCustom}
                                    onChange={(e) => setRetentionCustom(e.target.value)}
                                    placeholder={RETENTION_DAYS_PLACEHOLDER}
                                    autoFocus
                                />
                                <span className="storage-input-suffix">{t("storage.retention_days_suffix")}</span>
                            </div>
                        </>
                    ) : (
                        <div className="storage-retention-select-wrap">
                            <select
                                className="storage-select"
                                value={retentionSelected}
                                onChange={(e) => handleSelectChange(e.target.value)}
                            >
                                {RETENTION_PRESETS.map(p => (
                                    <option key={p.id} value={p.id}>{t(`storage.retention_options.${p.id}`)}</option>
                                ))}
                                <option value="custom">{t("storage.retention_options.custom")}</option>
                            </select>
                        </div>
                    )}
                    <button
                        className="dialog-btn"
                        onClick={saveRetention}
                        disabled={savingRetention || !isRetentionValid || !isRetentionDirty}
                    >
                        {savingRetention ? t("dialog.saving") : t("dialog.save")}
                    </button>
                </div>
            </div>

            <div className="storage-row">
                <div className="storage-row-label">
                    <FontAwesomeIcon icon={faFileExport}/>
                    <h3>{t("storage.export_tests")}</h3>
                </div>
                <div className="storage-row-actions">
                    <button className="dialog-btn" onClick={() => downloadHistory("csv")}>
                        {EXPORT_FORMATS.csv}</button>
                    <button className="dialog-btn" onClick={() => downloadHistory("json")}>
                        {EXPORT_FORMATS.json}</button>
                </div>
            </div>

            <div className="storage-row">
                <div className="storage-row-label">
                    <FontAwesomeIcon icon={faFileImport}/>
                    <h3>{t("storage.import_tests")}</h3>
                </div>
                <div className="storage-row-actions">
                    <button className="dialog-btn" onClick={importHistory}>{t("storage.import")}</button>
                </div>
            </div>

            <div className="storage-row">
                <div className="storage-row-label">
                    <FontAwesomeIcon icon={faTrashCan}/>
                    <h3>{t("storage.clear_history")}</h3>
                </div>
                <div className="storage-row-actions">
                    <button className="dialog-btn dialog-secondary" onClick={deleteHistory}>
                        {deleteWarning ? t("storage.confirm_delete") : t("storage.delete")}</button>
                </div>
            </div>
        </>
    )
}
