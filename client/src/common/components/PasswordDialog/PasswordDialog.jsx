import {Dialog, DialogHeader, DialogBody, DialogFooter} from "@/common/contexts/Dialog";
import {t} from "i18next";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {
    faCheck,
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
import {baseRequest, deleteRequest, login, logout, patchRequest} from "@/common/utils/RequestUtil";
import {ConfigContext} from "@/common/contexts/Config";
import {ToastNotificationContext} from "@/common/contexts/ToastNotification";
import {NodeContext} from "@/common/contexts/Node";
import SelectableOption, {SelectableList} from "@/common/components/SelectableOption";
import {useSyncOnOpen} from "@/common/hooks/useSyncOnOpen";

export const PasswordDialog = ({open, onClose}) => {
    const [config, reloadConfig] = useContext(ConfigContext);
    const updateToast = useContext(ToastNotificationContext);
    const findNode = useContext(NodeContext)[4];
    const updateNodes = useContext(NodeContext)[1];
    const currentNode = useContext(NodeContext)[2];

    const [password, setPassword] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    // Read when the dialog opens, never captured at mount: the mount-time
    // config on a read-level instance omits passwordLevel, and save() compares
    // this against the fresh config to decide whether to write the level - a
    // stale "none" here meant changing the password silently switched
    // read-access off as a side effect. See useSyncOnOpen.
    const [accessLevel, setAccessLevel] = useState("none");

    useSyncOnOpen(open, () => {
        setPassword("");
        setShowPassword(false);
        setAccessLevel(config.passwordLevel || "none");
    });

    const save = async (close) => {
        try {
            if (password) {
                await patchRequest("/config/password", {value: password});
                if (currentNode !== 0) {
                    await baseRequest("/nodes/" + currentNode + "/password", "PATCH", {password});
                    updateNodes();
                } else {
                    // Changing the password revokes every session, this one
                    // included, so the new one is exchanged for a fresh cookie
                    // straight away rather than written to storage.
                    await login(password);
                }
            }

            if (accessLevel !== config.passwordLevel) {
                await patchRequest("/config/passwordLevel", {value: accessLevel});
            }

            reloadConfig();
            updateToast(t("dropdown.changes_applied"), "green", faCheck);
            close();
        } catch (e) {
            updateToast(t("dropdown.changes_unsaved"), "red", faExclamationTriangle);
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
                            <button className="dialog-btn dialog-btn-danger" onClick={() => removePassword(close)}>
                                <FontAwesomeIcon icon={faLockOpen}/>
                                {t("dialog.password.unlock")}
                            </button>
                        )}
                        <button className="dialog-btn" onClick={() => save(close)}>{t("dialog.update")}</button>
                    </DialogFooter>
                </>
            )}
        </Dialog>
    );
};
