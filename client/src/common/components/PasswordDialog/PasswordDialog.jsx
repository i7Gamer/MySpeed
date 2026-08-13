import {Dialog, DialogHeader, DialogBody, DialogFooter} from "@/common/contexts/Dialog";
import {t} from "i18next";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {
    faCheck,
    faCheckDouble,
    faExclamationTriangle,
    faEye,
    faEyeSlash,
    faKey,
    faShieldHalved,
    faLock,
    faBookOpen,
    faLockOpen
} from "@fortawesome/free-solid-svg-icons";
import "./styles.sass";
import React, {useContext, useState} from "react";
import {assertOk, baseRequest, deleteRequest, login, logout, patchRequest, RequestError} from "@/common/utils/RequestUtil";
import {ConfigContext} from "@/common/contexts/Config";
import {useAlert} from "@/common/contexts/Alert";
import {ToastNotificationContext} from "@/common/contexts/ToastNotification";
import {NodeContext} from "@/common/contexts/Node";
import SelectableOption, {SelectableList} from "@/common/components/SelectableOption";
import {useSyncOnOpen} from "@/common/hooks/useSyncOnOpen";
import {passwordConfirmationProblem} from "@/common/utils/PasswordConfirmation";

export const PasswordDialog = ({open, onClose}) => {
    const [config, reloadConfig] = useContext(ConfigContext);
    const alert = useAlert();
    const updateToast = useContext(ToastNotificationContext);
    const findNode = useContext(NodeContext)[4];
    const updateNodes = useContext(NodeContext)[1];
    const currentNode = useContext(NodeContext)[2];

    const [password, setPassword] = useState("");
    // The whole point of the second box is that it is typed, not pasted from
    // the first, so it keeps its own state and is compared verbatim.
    const [confirmation, setConfirmation] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    // Read when the dialog opens, never captured at mount: the mount-time
    // config on a read-level instance omits passwordLevel, and save() compares
    // this against the fresh config to decide whether to write the level - a
    // stale "none" here meant changing the password silently switched
    // read-access off as a side effect. See useSyncOnOpen.
    const [accessLevel, setAccessLevel] = useState("none");

    useSyncOnOpen(open, () => {
        setPassword("");
        setConfirmation("");
        setShowPassword(false);
        setAccessLevel(config.passwordLevel || "none");
    });

    // Held rather than computed at save time as well, so the mismatch is shown
    // under the box while it is being typed instead of only once it is too
    // late to matter. Silent until the operator has actually typed a
    // confirmation - it must not shout at an untouched box.
    const mismatch = confirmation ? passwordConfirmationProblem(password, confirmation) : null;

    const save = async (close) => {
        // Before the PATCH, not after: the server hashes what it is given and
        // never sees it again, so a typo caught afterwards is already the
        // password. Outside the try because nothing has been attempted yet -
        // the refusal names the mismatch rather than falling into the generic
        // "changes unsaved".
        const problem = passwordConfirmationProblem(password, confirmation);
        if (problem) return updateToast(t(problem), "red", faExclamationTriangle);

        try {
            if (password) {
                // Checked, not assumed: patchRequest hands back the raw
                // Response, and awaiting it alone toasted "changes applied"
                // over a 400 - a password the server refused, under the
                // policy, looked exactly like one it stored.
                await assertOk(await patchRequest("/config/password", {value: password}), "password");
                if (currentNode !== 0) {
                    await assertOk(await baseRequest("/nodes/" + currentNode + "/password", "PATCH", {password}),
                        "node password");
                    updateNodes();
                } else {
                    // Changing the password revokes every session, this one
                    // included, so the new one is exchanged for a fresh cookie
                    // straight away rather than written to storage.
                    await login(password);
                }
            }

            if (accessLevel !== config.passwordLevel) {
                await assertOk(await patchRequest("/config/passwordLevel", {value: accessLevel}), "passwordLevel");
            }

            reloadConfig();
            updateToast(t("dropdown.changes_applied"), "green", faCheck);
            close();
        } catch (e) {
            // The server's refusal names the broken rule; only a network
            // failure falls back to the generic line.
            updateToast(e instanceof RequestError ? e.message : t("dropdown.changes_unsaved"),
                "red", faExclamationTriangle);
        }
    };

    const removePassword = async (close) => {
        try {
            // Its own endpoint rather than a PATCH carrying "none": that
            // sentinel is indistinguishable from someone choosing "none" as
            // their password.
            const response = await deleteRequest("/config/password");
            if (!response.ok) throw new Error(`Removing the password failed with status ${response.status}`);

            if (currentNode !== 0) {
                await baseRequest("/nodes/" + currentNode + "/password", "PATCH", {password: "none"});
                updateNodes();
            } else {
                await logout();
            }

            reloadConfig();
            updateToast(t("update.password_removed"), "green", faCheck);
            close();
        } catch (e) {
            updateToast(t("dropdown.changes_unsaved"), "red", faExclamationTriangle);
        }
    };

    /**
     * Removing the password is the one action here that can lock the operator
     * out of their own instance, and it used to fire on the first click of a
     * button labelled "Unlock" - the same word the login prompt puts on its
     * submit button. Read as "unlock the settings", it instead deleted the
     * password, signed the operator out with it, and left an instance that asks
     * every remote client for a setup token out of the server log.
     *
     * So the button says what it does, and this says what that costs before it
     * is done.
     */
    const confirmRemoval = async (close) => {
        const confirmed = await alert.openConfirm(
            t("update.remove_password_title"),
            t("update.remove_password_desc"),
            {buttonText: t("dialog.unset"), danger: true}
        );

        if (confirmed) await removePassword(close);
    };

    // Answered by the server, not by this browser's own storage: the old check
    // meant an instance with a password looked unprotected on every other
    // device, and protected on this one long after the password was gone.
    const isPasswordSet = currentNode !== 0
        ? findNode(currentNode)?.password
        : config.passwordSet === true;

    return (
        <Dialog open={open} onClose={onClose} className="password-dialog">
            {({close}) => (
                <>
                    <DialogHeader onClose={close}>{t("dropdown.password")}</DialogHeader>
                    <DialogBody>
                        <div className="password-content">
                            <div className="password-section">
                                <div className="password-label">
                                    <FontAwesomeIcon icon={faKey}/>
                                    <h3>{t("update.new_password")}</h3>
                                </div>
                                <div className="password-input-wrapper">
                                    <input
                                        type={showPassword ? "text" : "password"}
                                        className="dialog-input"
                                        placeholder={t("update.password_placeholder")}
                                        value={password}
                                        onChange={(e) => setPassword(e.target.value)}
                                    />
                                    <button
                                        type="button"
                                        className="password-toggle"
                                        onClick={() => setShowPassword(!showPassword)}
                                    >
                                        <FontAwesomeIcon icon={showPassword ? faEyeSlash : faEye}/>
                                    </button>
                                </div>
                            </div>

                            {/* One reveal for both boxes: seeing them together
                                is how an operator settles a mismatch they
                                cannot otherwise explain. */}
                            <div className="password-section">
                                <div className="password-label">
                                    <FontAwesomeIcon icon={faCheckDouble}/>
                                    <h3>{t("update.confirm_password")}</h3>
                                </div>
                                <div className="password-input-wrapper">
                                    <input
                                        type={showPassword ? "text" : "password"}
                                        className="dialog-input"
                                        placeholder={t("update.confirm_password_placeholder")}
                                        value={confirmation}
                                        onChange={(e) => setConfirmation(e.target.value)}
                                    />
                                </div>
                            </div>

                            {mismatch && <span className="password-mismatch icon-red">{t(mismatch)}</span>}

                            <div className="access-section">
                                <div className="access-label">
                                    <FontAwesomeIcon icon={faShieldHalved}/>
                                    <h3>{t("update.level_title")}</h3>
                                </div>
                                <SelectableList>
                                    <SelectableOption icon={faLock}
                                                      title={t("options.level.no_access")}
                                                      description={t("password.no_access_desc")}
                                                      active={accessLevel === "none"}
                                                      onClick={() => setAccessLevel("none")}/>
                                    <SelectableOption icon={faBookOpen}
                                                      title={t("options.level.read_access")}
                                                      description={t("password.read_access_desc")}
                                                      active={accessLevel === "read"}
                                                      onClick={() => setAccessLevel("read")}/>
                                </SelectableList>
                            </div>
                        </div>
                    </DialogBody>
                    <DialogFooter>
                        {isPasswordSet && (
                            <button className="dialog-btn dialog-btn-danger" onClick={() => confirmRemoval(close)}>
                                <FontAwesomeIcon icon={faLockOpen}/>
                                {t("update.remove_password")}
                            </button>
                        )}
                        <button className="dialog-btn" onClick={() => save(close)}>{t("dialog.update")}</button>
                    </DialogFooter>
                </>
            )}
        </Dialog>
    );
};
