import "./styles.sass";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {
    faArrowDown,
    faArrowUp,
    faCircleNotch,
    faClock,
    faClose,
    faExclamationTriangle,
    faKey,
    faPen,
    faServer,
    faTableTennisPaddleBall,
    faTrash
} from "@fortawesome/free-solid-svg-icons";
import React, {useContext, useEffect, useState} from "react";
import {NodeContext} from "@/common/contexts/Node";
import {useAlert} from "@/common/contexts/Alert";
import {ToastNotificationContext} from "@/common/contexts/ToastNotification";
import {assertOk, baseRequest, patchRequest} from "@/common/utils/RequestUtil";
import {t} from "i18next";
import {Trans} from "react-i18next";
import {getIconBySpeed, isFailedTest} from "@/common/utils/TestUtil";
import {ConfigContext} from "@/common/contexts/Config";
import {PreferencesContext} from "@/common/contexts/Preferences";
import {convertSpeed, getSpeedUnit} from "@/common/utils/FormatUtil";
import {useNavigate} from "react-router-dom";
import ContextMenu from "@/common/components/ContextMenu";

export const NodeContainer = (node) => {
    const updateNodes = useContext(NodeContext)[1];
    const updateCurrentNode = useContext(NodeContext)[3];
    const reloadConfig = useContext(ConfigContext)[1];
    const [preferences] = useContext(PreferencesContext);
    const speedUnit = getSpeedUnit(preferences);
    const updateToast = useContext(ToastNotificationContext);
    const alert = useAlert();
    const [nodeData, setNodeData] = useState(null);
    const [nodeError, setNodeError] = useState(undefined);
    const [contextMenu, setContextMenu] = useState(null);

    const navigate = useNavigate();

    const prefix = node.currentNode ? "" : "/nodes/" + node.id;

    const updateData = async () => {
        const testRequest = await baseRequest(prefix + "/speedtests?limit=1");

        if (testRequest.status === 401) return setNodeError("PASSWORD_CHANGED");
        if (!testRequest.ok) return setNodeError("SERVER_NOT_REACHABLE");
        const tests = await testRequest.json();

        if (tests.length < 0) return setNodeError("SERVER_NOT_REACHABLE");

        const configRequest = await baseRequest(prefix + "/config");

        if (configRequest.status === 401) return setNodeError("PASSWORD_CHANGED");
        if (!configRequest.ok) return setNodeError("SERVER_NOT_REACHABLE");
        const config = await configRequest.json();

        if (config.viewMode) return setNodeError("PASSWORD_CHANGED");

        if (tests[0] === undefined) return setNodeData({pending: true});

        setNodeError(undefined);
        setNodeData({
            // A failed test carries -1 in every column. Printing those as
            // "-1 ms" and "-1 Mbps" presented the placeholders as readings, so
            // the card marks the failure the way the overview does instead.
            failed: isFailedTest(tests[0]),
            ping: tests[0]?.ping,
            download: Math.round(tests[0]?.download),
            upload: Math.round(tests[0]?.upload),
            pingIcon: getIconBySpeed(tests[0]?.ping, config.ping, false),
            downloadIcon: getIconBySpeed(tests[0]?.download, config.download, true),
            uploadIcon: getIconBySpeed(tests[0]?.upload, config.upload, true)
        });
    }

    const updatePassword = async (wrong = false) => {
        const result = await alert.openInput(t("nodes.password_outdated"), {
            inputType: "password",
            description: wrong ?
                <span className="icon-red">{t("dialog.password.wrong")}</span> : t("nodes.update_password"),
            placeholder: t("dialog.password.placeholder"),
            buttonText: t("dialog.update")
        });

        if (result) {
            const res = await (await baseRequest(`/nodes/${node.id}/password`, "PATCH", {password: result})).json();

            if (res.type === "PASSWORD_UPDATED") {
                updateData().catch(() => setNodeError("SERVER_NOT_REACHABLE"));
                updateToast(t("nodes.password_updated"), "green", faKey);
            } else {
                updatePassword(true);
            }
        }
    };

    useEffect(() => {
        updateData().catch(() => setNodeError("SERVER_NOT_REACHABLE"));
        const interval = setInterval(() => updateData().catch(() => setNodeError("SERVER_NOT_REACHABLE")), 10000);
        return () => clearInterval(interval);
    }, []);

    const switchNode = () => {
        if (nodeError || !nodeData) {
            if (nodeError === "PASSWORD_CHANGED") updatePassword();
            return;
        }

        navigate("/");
        updateCurrentNode(node.id);
        reloadConfig();
    }

    const onContext = async (event) => {
        event.preventDefault();
        event.stopPropagation();

        if (node.currentNode) return;

        setContextMenu({x: event.clientX, y: event.clientY});
    };

    const closeContextMenu = () => setContextMenu(null);

    const handleRename = async () => {
        const newName = await alert.openInput(t("nodes.rename.title"), {
            placeholder: t("nodes.rename.placeholder"),
            buttonText: t("dialog.save"),
            value: node.name
        });

        if (newName && newName !== node.name) {
            // Checked before reporting success: the mutating helpers return the
            // raw response, so a refused rename used to show the success toast
            // and leave the old name on screen.
            try {
                await assertOk(await patchRequest(`/nodes/${node.id}/name`, {name: newName}), "rename node");
            } catch (e) {
                updateToast(e.message || t("dropdown.changes_unsaved"), "red", faExclamationTriangle);
                return;
            }

            updateToast(t("nodes.rename.success"), "green", faPen);
            updateNodes();
        }
    };

    const handleDelete = async () => {
        const confirmed = await alert.openConfirm(
            t("nodes.delete.title"),
            <Trans components={{Bold: <span className="dialog-value"/>}}
                   values={node}>nodes.delete.description</Trans>,
            {
                buttonText: t("nodes.delete.yes"),
                danger: true
            }
        );

        if (confirmed) {
            try {
                await assertOk(await baseRequest("/nodes/" + node.id, "DELETE"), "delete node");
            } catch (e) {
                updateToast(e.message || t("dropdown.changes_unsaved"), "red", faExclamationTriangle);
                return;
            }

            updateToast(t("nodes.delete.success"), "green", faServer);
            updateNodes();
        }
    };

    const contextMenuItems = [
        {
            icon: faPen,
            label: t("nodes.rename.title"),
            onClick: handleRename
        },
        {divider: true},
        {
            icon: faTrash,
            label: t("nodes.delete.title"),
            onClick: handleDelete,
            danger: true
        }
    ];

    return (
        <>
            {contextMenu && (
                <ContextMenu
                    items={contextMenuItems}
                    position={contextMenu}
                    onClose={closeContextMenu}
                />
            )}
            <div className={"node-item hover-" + (nodeError ? "red" : (nodeData ? "green" : "orange"))} key={node.id}
                 onClick={switchNode} onContextMenu={onContext}>
                <div className="node-info-area">
                    <FontAwesomeIcon icon={faServer}
                                     className={"icon-" + (nodeError ? "red" : (nodeData ? "green" : "orange"))}/>
                    <div className="node-info">
                        <h1>{node.name}</h1>
                        <p>{node.url.replace(/(^\w+:|^)\/\//, '')}</p>
                    </div>
                </div>
                <div className="speed-area">

                    {nodeError === "SERVER_NOT_REACHABLE" && (<div className="icon-text">
                        <h2>{t("nodes.messages.not_reachable")}</h2>
                        <FontAwesomeIcon icon={faExclamationTriangle} className="speed-icon icon-red"/>
                    </div>)}

                    {nodeError === "PASSWORD_CHANGED" && (<div className="icon-text">
                        <h2>{t("nodes.messages.password_changed")}</h2>
                        <FontAwesomeIcon icon={faKey} className="speed-icon icon-red"/>
                    </div>)}

                    {!nodeError && !nodeData && (
                        <FontAwesomeIcon icon={faCircleNotch} className="speed-icon" spin={true}/>)}

                    {nodeData && nodeData.pending && !nodeError && (<div className="icon-text">
                            <h2>{t("nodes.messages.tests_pending")}</h2>
                            <FontAwesomeIcon icon={faClock} className="speed-icon icon-blue"/>
                        </div>)}

                    {/* The node is answering - it is its last test that failed,
                        so this reads as a result rather than as the node being
                        down, and carries the same X the overview marks a failed
                        test with. */}
                    {nodeData && nodeData.failed && !nodeData.pending && !nodeError && (<div className="icon-text">
                        <h2>{t("test.failed")}</h2>
                        <FontAwesomeIcon icon={faClose} className="speed-icon icon-error"/>
                    </div>)}

                    {nodeData && !nodeData.failed && !nodeData.pending && !nodeError && (
                        <>
                            <div className="speed-item">
                                <FontAwesomeIcon icon={faTableTennisPaddleBall}
                                                 className={"icon-" + nodeData.pingIcon}/>
                                <h1>{nodeData.ping} {t("latest.ping_unit")}</h1>
                            </div>

                            <div className="speed-item">
                                <FontAwesomeIcon icon={faArrowDown}
                                                 className={"icon-" + nodeData.downloadIcon}/>
                                <h1>{convertSpeed(nodeData.download, preferences)} {speedUnit}</h1>
                            </div>

                            <div className="speed-item">
                                <FontAwesomeIcon icon={faArrowUp}
                                                 className={"icon-" + nodeData.uploadIcon}/>
                                <h1>{convertSpeed(nodeData.upload, preferences)} {speedUnit}</h1>
                            </div>
                        </>
                    )}
                </div>

            </div>
        </>
    );
}