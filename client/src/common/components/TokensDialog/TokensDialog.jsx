import {Dialog, DialogHeader, DialogBody, DialogFooter} from "@/common/contexts/Dialog";
import {t} from "i18next";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faCheck, faCopy, faExclamationTriangle, faPlus, faTrashCan} from "@fortawesome/free-solid-svg-icons";
import "./styles.sass";
import React, {useContext, useState} from "react";
import {PreferencesContext} from "@/common/contexts/Preferences";
import {formatDateTime, formatDay} from "@/common/utils/FormatUtil";
import {assertOk, localDeleteRequest, localJsonRequest, localPostRequest, RequestError} from "@/common/utils/RequestUtil";
import {useAlert} from "@/common/contexts/Alert";
import {ToastNotificationContext} from "@/common/contexts/ToastNotification";
import {useSyncOnOpen} from "@/common/hooks/useSyncOnOpen";
import {withBasePath} from "@/common/utils/BasePath";

/**
 * The tokens an operator issues so that a script, a router hook or a
 * home-automation platform can start a test without holding the admin
 * password. A token starts a test and reads the live status, nothing else.
 *
 * The secret exists in exactly one answer - the one that issued it - so the
 * dialog shows it once, beside the request a reader pastes into their
 * automation, and the list below never repeats it.
 */

/**
 * The request a token is for, spelled out for pasting. The origin is this
 * page's, since that is the address the operator reached the instance on,
 * and the path carries the base path the way every request here does.
 *
 * Which is also why every request this dialog makes is pinned to this
 * instance rather than routed to the node the dashboard is showing: a token
 * issued through the proxy would belong to that node, and the line printed
 * here would name an instance that does not hold it.
 */
export const triggerExample = (token, origin = window.location.origin) =>
    `curl -X POST -H "Authorization: Bearer ${token}" ${origin}${withBasePath("/api/speedtests/run")}`;

export const TokensDialog = ({open, onClose}) => {
    const alert = useAlert();
    const preferences = useContext(PreferencesContext)?.[0];
    const updateToast = useContext(ToastNotificationContext);

    const [tokens, setTokens] = useState([]);
    const [name, setName] = useState("");
    // The token just issued, with its secret - cleared when the dialog is
    // opened again, so the secret is never on screen longer than the visit
    // that created it.
    const [issued, setIssued] = useState(null);
    const [saving, setSaving] = useState(false);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState(null);

    const load = async () => {
        setLoading(true);
        setLoadError(null);
        try {
            setTokens(await localJsonRequest("/tokens"));
        } catch (e) {
            console.error("Failed to load the API tokens:", e);
            setLoadError(e);
        } finally {
            setLoading(false);
        }
    };

    useSyncOnOpen(open, () => {
        setIssued(null);
        setName("");
        load();
    });

    const create = async () => {
        if (saving || name.trim() === "") return;
        setSaving(true);

        try {
            const response = await assertOk(await localPostRequest("/tokens", {name: name.trim()}), "tokens");
            setIssued(await response.json());
            setName("");
            await load();
        } catch (e) {
            updateToast(e instanceof RequestError ? e.message : t("dropdown.changes_unsaved"),
                "red", faExclamationTriangle);
        } finally {
            setSaving(false);
        }
    };

    const revoke = async (row) => {
        const confirmed = await alert.openConfirm(
            t("tokens.delete_confirm.title"),
            t("tokens.delete_confirm.description", {name: row.name}),
            {buttonText: t("tokens.delete_confirm.yes"), danger: true}
        );
        if (!confirmed) return;

        try {
            await assertOk(await localDeleteRequest(`/tokens/${row.id}`), "tokens");
            if (issued?.id === row.id) setIssued(null);
            await load();
            updateToast(t("tokens.removed"), "green", faCheck);
        } catch (e) {
            updateToast(e instanceof RequestError ? e.message : t("dropdown.changes_unsaved"),
                "red", faExclamationTriangle);
        }
    };

    const copy = async (text) => {
        try {
            await navigator.clipboard.writeText(text);
            updateToast(t("tokens.copied"), "green", faCheck);
        } catch {
            // No clipboard on this page (plain http, or a browser that
            // refuses); the secret is on screen to select by hand. Nothing
            // was being saved, so the "could not be saved" toast this used
            // to show was a false alarm about a token that is fine.
        }
    };

    return (
        <Dialog open={open} onClose={onClose} className="tokens-dialog">
            {({close}) => (
                <>
                    <DialogHeader onClose={close}>{t("tokens.title")}</DialogHeader>
                    <DialogBody>
                        <div className="tokens-content">
                            <p className="tokens-description">{t("tokens.description")}</p>

                            {issued && (
                                <div className="token-issued">
                                    <h3>{t("tokens.secret_title", {name: issued.name})}</h3>
                                    <p>{t("tokens.secret_once")}</p>
                                    <div className="token-secret-row">
                                        <code className="token-secret">{issued.token}</code>
                                        <button type="button" className="token-action"
                                                aria-label={t("tokens.copy")} title={t("tokens.copy")}
                                                onClick={() => copy(issued.token)}>
                                            <FontAwesomeIcon icon={faCopy}/>
                                        </button>
                                    </div>
                                    <p className="token-example-label">{t("tokens.example")}</p>
                                    <div className="token-secret-row">
                                        <code className="token-example">{triggerExample(issued.token)}</code>
                                        <button type="button" className="token-action"
                                                aria-label={t("tokens.copy")} title={t("tokens.copy")}
                                                onClick={() => copy(triggerExample(issued.token))}>
                                            <FontAwesomeIcon icon={faCopy}/>
                                        </button>
                                    </div>
                                </div>
                            )}

                            <div className="tokens-list">
                                {loadError ? (
                                    <div role="alert">
                                        <p className="icon-red">{loadError.message}</p>
                                        <button type="button" className="dialog-btn" onClick={load}>{t("dialog.retry")}</button>
                                    </div>
                                ) : loading ? (
                                    <div className="lds-ellipsis"><div/><div/><div/></div>
                                ) : tokens.length === 0 && (
                                    <p className="tokens-empty">{t("tokens.empty")}</p>
                                )}
                                {!loadError && !loading && tokens.map((row) => (
                                    <div className="token-row" key={row.id}>
                                        <div className="token-row-text">
                                            <h3>{row.name}</h3>
                                            <p>
                                                {t("tokens.created_at", {date: formatDay(row.created)})}
                                                {" · "}
                                                {/* The label is written for a date, so a token
                                                    with none says so on its own rather than as
                                                    "Last used: Never used". */}
                                                {row.lastUsed
                                                    ? t("tokens.last_used", {date: formatDateTime(row.lastUsed, preferences)})
                                                    : t("tokens.never_used")}
                                            </p>
                                        </div>
                                        <button type="button" className="token-action token-delete"
                                                aria-label={t("tokens.delete_confirm.yes")}
                                                title={t("tokens.delete_confirm.yes")}
                                                onClick={() => revoke(row)}>
                                            <FontAwesomeIcon icon={faTrashCan}/>
                                        </button>
                                    </div>
                                ))}
                            </div>

                            <div className="token-create">
                                <label htmlFor="api-token-name">{t("tokens.name")}</label>
                                <div className="token-create-row">
                                    <input id="api-token-name" type="text" className="dialog-input"
                                           placeholder={t("tokens.name_placeholder")} value={name}
                                           maxLength={64}
                                           onChange={(e) => setName(e.target.value)}
                                           onKeyDown={(e) => { if (e.key === "Enter") create(); }}/>
                                    <button type="button" id="api-token-create" className="dialog-btn"
                                            disabled={saving || name.trim() === ""} onClick={create}>
                                        <FontAwesomeIcon icon={faPlus}/>
                                        <span>{t("tokens.create")}</span>
                                    </button>
                                </div>
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

export default TokensDialog;
