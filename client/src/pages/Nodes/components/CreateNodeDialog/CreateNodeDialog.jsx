import {Dialog, DialogHeader, DialogBody, DialogFooter} from "@/common/contexts/Dialog";
import {useAlert} from "@/common/contexts/Alert";
import React, {useContext, useState} from "react";
import "./styles.sass";
import {t} from "i18next";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faCircleInfo, faExclamationTriangle, faServer, faSpinner} from "@fortawesome/free-solid-svg-icons";
import {baseRequest} from "@/common/utils/RequestUtil";
import {promptUntilAccepted} from "@/common/utils/PasswordPrompt";
import {
    describeNodeOutcome, OUTCOME_CREATED, OUTCOME_PASSWORD
} from "@/pages/Nodes/utils/outcome";
import {ToastNotificationContext} from "@/common/contexts/ToastNotification";
import {NodeContext} from "@/common/contexts/Node";

export const CreateNodeDialog = ({open, onClose}) => {
    const alert = useAlert();
    const updateNodes = useContext(NodeContext)[1];
    const updateToast = useContext(ToastNotificationContext);
    // The server's reason, shown under the field: a bare red border said
    // nothing about hosts missing from ALLOWED_NODE_HOSTS, and the empty form
    // used to be answered with nothing at all.
    const [urlError, setUrlError] = useState(null);
    const [serverName, setServerName] = useState("");
    const [serverUrl, setServerUrl] = useState("");
    const [checking, setChecking] = useState(false);

    const created = () => {
        updateNodes();
        updateToast(t("nodes.created"), "green", faServer);
    };

    // The shared ask-again loop rather than a hand-rolled recursion, so this
    // prompt cannot drift apart from the admin login's - see PasswordPrompt.
    const runPasswordProcess = () => promptUntilAccepted(
        (previous) => alert.openInput(t("dialog.password.title"), {
            inputType: "password",
            description: previous
                ? <span className="icon-red">{t("dialog.password.wrong")}</span>
                : t("nodes.password_required"),
            placeholder: t("dialog.password.placeholder"),
            buttonText: t("nodes.create")
        }),
        async (password) => {
            const body = await (await baseRequest("/nodes", "PUT", {
                name: serverName, url: serverUrl, password
            })).json();
            const outcome = describeNodeOutcome(body);

            if (outcome.kind === OUTCOME_CREATED) {
                created();
                return {ok: true};
            }
            if (outcome.kind === OUTCOME_PASSWORD) return {ok: false};

            // The node stopped answering between the two attempts. Another
            // password will not fix that, so the loop ends with the reason on
            // screen rather than asking again.
            updateToast(outcome.message ?? t("nodes.messages.not_reachable"), "red", faExclamationTriangle);
            return {ok: true};
        }
    );

    const createNode = async (close) => {
        setChecking(true);
        setUrlError(null);

        try {
            const response = await (await baseRequest("/nodes", "PUT", {name: serverName, url: serverUrl})).json();
            const outcome = describeNodeOutcome(response);

            if (outcome.kind === OUTCOME_CREATED) {
                created();
                close();
            } else if (outcome.kind === OUTCOME_PASSWORD) {
                close();
                runPasswordProcess();
            } else {
                setUrlError(outcome.message ?? t("nodes.messages.not_reachable"));
            }
        } catch {
            setUrlError(t("nodes.messages.not_reachable"));
        } finally {
            setChecking(false);
        }
    };

    return (
        <Dialog open={open} onClose={onClose} className="create-node-dialog">
            {({close}) => (
                <>
                    <DialogHeader onClose={close}>{t("nodes.add")}</DialogHeader>
                    <DialogBody>
                        <div className="server-dialog">
                            <div className="server-group">
                                <div className="server-label">
                                    <FontAwesomeIcon icon={faCircleInfo}/>
                                    <h3>{t("nodes.group.name")}</h3>
                                </div>
                                <input type="text" className="dialog-input server-input" placeholder={t("nodes.placeholder.name")} value={serverName}
                                       onChange={(e) => setServerName(e.target.value)}/>
                            </div>
                            <div className={"server-group" + (urlError ? " server-error" : "")}>
                                <div className="server-label">
                                    <FontAwesomeIcon icon={faServer}/>
                                    <h3>{t("nodes.group.url")}</h3>
                                </div>
                                <input type="text" className="dialog-input server-input" placeholder={t("nodes.placeholder.url")} value={serverUrl}
                                       onChange={(e) => { setServerUrl(e.target.value); setUrlError(null); }}/>
                                {/* The server's own words: which rule refused
                                    the URL is the difference between fixing a
                                    typo and hunting through the environment. */}
                                {urlError && <p className="icon-red server-error-text">{urlError}</p>}
                            </div>
                        </div>
                    </DialogBody>
                    <DialogFooter>
                        <button className="dialog-btn" disabled={checking} onClick={() => createNode(close)}>
                            {checking && <FontAwesomeIcon icon={faSpinner} spin/>}
                            {t("nodes.create")}
                        </button>
                    </DialogFooter>
                </>
            )}
        </Dialog>
    );
}