import {Dialog, DialogHeader, DialogBody, DialogFooter} from "@/common/contexts/Dialog";
import {t} from "i18next";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {
    faCheck, faChevronDown, faChevronUp, faExclamationTriangle, faNetworkWired, faPen, faPlay,
    faPlus, faTrashCan
} from "@fortawesome/free-solid-svg-icons";
import "./styles.sass";
import React, {useContext, useEffect, useState} from "react";
import {Trans} from "react-i18next";
import {assertOk, deleteRequest, jsonRequest, patchRequest} from "@/common/utils/RequestUtil";
import {ConfigContext} from "@/common/contexts/Config";
import {TargetsContext} from "@/common/contexts/Targets";
import {StatusContext} from "@/common/contexts/Status";
import {SpeedtestContext} from "@/common/contexts/Speedtests";
import {ToastNotificationContext} from "@/common/contexts/ToastNotification";
import {useAlert} from "@/common/contexts/Alert";
import {startSpeedtest} from "@/common/utils/RunUtil";
import {targetColour} from "@/common/utils/TargetUtil";
import ToggleSwitch from "@/common/components/ToggleSwitch";
import {TargetEditor} from "./TargetEditor";
import {providerById} from "./providers";

/**
 * The round, as a list: every target in the order it is measured, with the
 * schedule membership, the manual run and the editor a row away. Where the
 * dropdown's "change provider" used to lead - the instance stopped having one
 * provider, so the setting became a list.
 *
 * The network interface stays down here as an instance-wide setting: every
 * target measures through the same line, which is the thing this instance
 * exists to watch.
 */
export const TargetsDialog = ({open, onClose}) => {
    const [config, reloadConfig] = useContext(ConfigContext);
    const {targets, reloadTargets} = useContext(TargetsContext);
    const [status, updateStatus, setRunning] = useContext(StatusContext);
    const {updateTests} = useContext(SpeedtestContext);
    const updateToast = useContext(ToastNotificationContext);
    const alert = useAlert();
    const [interfaces, setInterfaces] = useState({});
    const [editorOpen, setEditorOpen] = useState(false);
    // The row being edited, held apart from the open flag so the closing
    // animation does not blank the form under itself.
    const [editing, setEditing] = useState(null);
    // A reorder in flight. move() computes the id sequence from `targets`,
    // and that state only changes once reloadTargets settles - so two quick
    // clicks computed two swaps from the same pre-move list, and the later
    // PATCH won with an order the operator never asked for.
    const [moving, setMoving] = useState(false);

    useEffect(() => {
        if (!open) return;
        jsonRequest("/info/interfaces").then(setInterfaces).catch(() => setInterfaces({}));
    }, [open]);

    const openEditor = (target) => {
        setEditing(target);
        setEditorOpen(true);
    };

    const failed = (e) => updateToast(e.message || t("dropdown.changes_unsaved"),
        "red", faExclamationTriangle);

    // Every write is checked - patch/deleteRequest hand back the raw Response,
    // and a refused change must not redraw the list as though it had happened.
    const setScheduled = async (target, enabled) => {
        try {
            await assertOk(await patchRequest(`/targets/${target.id}`, {enabled}), "target");
        } catch (e) {
            return failed(e);
        }

        reloadTargets();
    };

    const move = async (index, direction) => {
        if (moving) return;

        const ids = targets.map((target) => target.id);
        const swap = index + direction;
        if (swap < 0 || swap >= ids.length) return;

        [ids[index], ids[swap]] = [ids[swap], ids[index]];

        setMoving(true);
        try {
            await assertOk(await patchRequest("/targets/order", {ids}), "target order");
            // Inside the lock, because the stale window is the reload, not
            // the PATCH: until the list state holds the new order, a second
            // click computes its swap from the old one.
            await reloadTargets();
        } catch (e) {
            return failed(e);
        } finally {
            setMoving(false);
        }
    };

    const remove = async (target) => {
        const confirmed = await alert.openConfirm(
            t("targets.delete_confirm.title"),
            // Named, because the question is worth nothing if the reader
            // cannot tell which row it is about.
            <Trans components={{Bold: <span className="dialog-value"/>}}
                   values={{name: target.name}}>targets.delete_confirm.description</Trans>,
            {buttonText: t("targets.delete_confirm.yes"), danger: true}
        );

        if (!confirmed) return;

        try {
            await assertOk(await deleteRequest(`/targets/${target.id}`), "target");
        } catch (e) {
            return failed(e);
        }

        updateToast(t("targets.removed"), "green", faTrashCan);
        reloadTargets();
    };

    // The same run path as the toolbar button, aimed at one row - and the only
    // way a target outside the schedule runs at all.
    const runNow = (target) => startSpeedtest({
        updateStatus, setRunning, updateTests, alert, targetId: target.id
    });

    const changeInterface = async (value) => {
        try {
            await assertOk(await patchRequest("/config/interface", {value}), "interface");
        } catch (e) {
            return failed(e);
        }

        reloadConfig();
        updateToast(t("dropdown.changes_applied"), "green", faCheck);
    };

    // What the select is controlled on - the stored setting, with the sentinel
    // the server stores for "let the instance choose".
    const selectedInterface = config.interface || "none";

    // What the name alone does not say: who measures it, and where. A pinned
    // server by its id, a custom backend by its address, otherwise the
    // automatic choice the provider makes per run.
    const rowDetail = (target) => [
        providerById(target.provider)?.name ?? target.provider,
        target.serverId ? `#${target.serverId}` : null,
        target.endpoint || null
    ].filter(Boolean).join(" · ");

    return (
        <>
            <TargetEditor open={editorOpen} onClose={() => setEditorOpen(false)} target={editing}/>
            <Dialog open={open} onClose={onClose} className="targets-dialog-wrapper">
                {({close}) => (
                    <>
                        <DialogHeader onClose={close}>{t("targets.title")}</DialogHeader>
                        <DialogBody>
                            <div className="targets-content">
                                <p className="targets-description">{t("targets.description")}</p>

                                <div className="targets-list">
                                    {targets.map((target, index) => (
                                        <div className="target-row" key={target.id}>
                                            <span className="target-dot"
                                                  style={{background: targetColour(index)}}/>
                                            <div className="target-row-text">
                                                <h3>{target.name}</h3>
                                                <p>{rowDetail(target)}</p>
                                            </div>
                                            <div className="target-row-actions">
                                                <div className="target-reorder">
                                                    <button className="target-action" disabled={index === 0 || moving}
                                                            aria-label={t("targets.move_up")}
                                                            onClick={() => move(index, -1)}>
                                                        <FontAwesomeIcon icon={faChevronUp}/>
                                                    </button>
                                                    <button className="target-action"
                                                            disabled={index === targets.length - 1 || moving}
                                                            aria-label={t("targets.move_down")}
                                                            onClick={() => move(index, 1)}>
                                                        <FontAwesomeIcon icon={faChevronDown}/>
                                                    </button>
                                                </div>
                                                <ToggleSwitch checked={Boolean(target.enabled)}
                                                              onChange={(value) => setScheduled(target, value)}
                                                              label={t("targets.scheduled")}/>
                                                <button className="target-action" disabled={status.running}
                                                        aria-label={t("targets.run_now")}
                                                        title={t("targets.run_now")}
                                                        onClick={() => runNow(target)}>
                                                    <FontAwesomeIcon icon={faPlay}/>
                                                </button>
                                                <button className="target-action"
                                                        aria-label={t("targets.edit_title")}
                                                        title={t("targets.edit_title")}
                                                        onClick={() => openEditor(target)}>
                                                    <FontAwesomeIcon icon={faPen}/>
                                                </button>
                                                <button className="target-action target-action-danger"
                                                        aria-label={t("targets.delete_confirm.yes")}
                                                        title={t("targets.delete_confirm.yes")}
                                                        onClick={() => remove(target)}>
                                                    <FontAwesomeIcon icon={faTrashCan}/>
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                </div>

                                <div className="provider-settings">
                                    <div className="provider-setting">
                                        <div className="provider-setting-label">
                                            <FontAwesomeIcon icon={faNetworkWired}/>
                                            <h3>{t("dialog.provider.interface")}</h3>
                                        </div>
                                        <span className="select-wrap provider-input-wrap">
                                            {/* Named, like the server picker beside it in
                                                TargetEditor: the heading above lives in a sibling
                                                div, which associates it with nothing, and there is
                                                no placeholder to fall back on - so a reader tabbing
                                                onto this heard the adapter's name and nothing about
                                                what it was set on. */}
                                            <select className="dialog-input select-field provider-input"
                                                    value={selectedInterface}
                                                    aria-label={t("dialog.provider.interface")}
                                                    onChange={(e) => changeInterface(e.target.value)}>
                                                {/* The stored choice, kept visible when the list does
                                                    not carry it: a controlled select with no matching
                                                    option paints blank, which reads as "nothing
                                                    configured" while something very much is. "none"
                                                    survives a boot that found no usable adapter, an
                                                    adapter can be renamed, and the fetch can fail.
                                                    Disabled, because it is a fact rather than a choice
                                                    - any real pick PATCHes instantly. */}
                                                {!Object.hasOwn(interfaces ?? {}, selectedInterface) && (
                                                    <option value={selectedInterface} disabled>
                                                        {selectedInterface}
                                                    </option>
                                                )}
                                                {interfaces && Object.keys(interfaces).map((current, index) => (
                                                    <option key={index} value={current}>
                                                        {current} ({interfaces[current]})
                                                    </option>
                                                ))}
                                            </select>
                                        </span>
                                    </div>
                                </div>
                            </div>
                        </DialogBody>
                        <DialogFooter>
                            <button className="dialog-btn" onClick={() => openEditor(null)}>
                                <FontAwesomeIcon icon={faPlus}/>
                                <span>{t("targets.add")}</span>
                            </button>
                        </DialogFooter>
                    </>
                )}
            </Dialog>
        </>
    );
};
