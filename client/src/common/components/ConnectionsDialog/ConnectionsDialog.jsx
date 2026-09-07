import {Dialog, DialogHeader, DialogBody, DialogFooter} from "@/common/contexts/Dialog";
import {t} from "i18next";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faArrowRight, faExclamationTriangle} from "@fortawesome/free-solid-svg-icons";
import "./styles.sass";
import React, {useContext, useState} from "react";
import {PreferencesContext} from "@/common/contexts/Preferences";
import {TargetsContext} from "@/common/contexts/Targets";
import {formatDateTime} from "@/common/utils/FormatUtil";
import {jsonRequest, RequestError} from "@/common/utils/RequestUtil";
import {ToastNotificationContext} from "@/common/contexts/ToastNotification";
import {useSyncOnOpen} from "@/common/hooks/useSyncOnOpen";

/**
 * When the external address or the provider changed, as the server keeps
 * it: one row per run that saw a change, newest first, each saying only
 * the half that changed and which member's run noticed.
 *
 * Read from the server rather than derived from the history on screen,
 * because the retention sweep forgets tests long before anyone stops
 * caring when the address last rotated.
 */

/** One half of a change: what it was, an arrow, what it is. */
const Change = ({label, from, to}) => (
    <div className="connection-change">
        <span className="connection-change-label">{label}</span>
        <span className="connection-change-from">{from}</span>
        <FontAwesomeIcon icon={faArrowRight} className="connection-change-arrow"/>
        <span className="connection-change-to">{to}</span>
    </div>
);

export const ConnectionsDialog = ({open, onClose}) => {
    const preferences = useContext(PreferencesContext)?.[0];
    const {byId} = useContext(TargetsContext);
    const updateToast = useContext(ToastNotificationContext);

    const [changes, setChanges] = useState([]);

    const load = async () => {
        try {
            setChanges(await jsonRequest("/speedtests/connections"));
        } catch (e) {
            updateToast(e instanceof RequestError ? e.message : t("dropdown.changes_unsaved"),
                "red", faExclamationTriangle);
        }
    };

    useSyncOnOpen(open, load);

    // The member that ran the test, by the name it has now - or a note
    // that it is gone, since the log outlives the targets dialog's edits.
    const memberOf = (row) => row.targetId === null
        ? row.provider
        : (byId?.[row.targetId]?.name ?? t("connections.unknown_target"));

    return (
        <Dialog open={open} onClose={onClose} className="connections-dialog">
            {({close}) => (
                <>
                    <DialogHeader onClose={close}>{t("connections.title")}</DialogHeader>
                    <DialogBody>
                        <div className="connections-content">
                            <p className="connections-description">{t("connections.description")}</p>

                            <div className="connections-list">
                                {changes.length === 0 && (
                                    <p className="connections-empty">{t("connections.empty")}</p>
                                )}
                                {changes.map((row) => (
                                    <div className="connection-row" key={row.id}>
                                        <p className="connection-row-when">
                                            {formatDateTime(row.created, preferences)}
                                            {" · "}
                                            {memberOf(row)}
                                        </p>
                                        {row.ip !== null && row.previousIp !== null && (
                                            <Change label={t("connections.ip")} from={row.previousIp} to={row.ip}/>
                                        )}
                                        {row.isp !== null && row.previousIsp !== null && (
                                            <Change label={t("connections.isp")} from={row.previousIsp} to={row.isp}/>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>
                    </DialogBody>
                    <DialogFooter>
                        <button type="button" className="dialog-btn" onClick={close}>{t("dialog.okay")}</button>
                    </DialogFooter>
                </>
            )}
        </Dialog>
    );
};

export default ConnectionsDialog;
