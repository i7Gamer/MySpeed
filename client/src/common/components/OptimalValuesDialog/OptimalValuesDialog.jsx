import {Dialog, DialogHeader, DialogBody, DialogFooter} from "@/common/contexts/Dialog";
import {t} from "i18next";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faArrowDown, faArrowUp, faCheck, faExclamationTriangle, faTableTennis, faWandMagicSparkles} from "@fortawesome/free-solid-svg-icons";
import "./styles.sass";
import React, {useContext, useEffect, useState} from "react";
import {Trans} from "react-i18next";
import {assertOk, jsonRequest, patchRequest, RequestError} from "@/common/utils/RequestUtil";
import {ConfigContext} from "@/common/contexts/Config";
import {ToastNotificationContext} from "@/common/contexts/ToastNotification";
import {useSyncOnOpen} from "@/common/hooks/useSyncOnOpen";
import {isThresholdNumber} from "@/common/utils/TestUtil";

const NOT_ENOUGH_TESTS_STATUS = 501;

export const OptimalValuesDialog = ({open, onClose}) => {
    const [config, reloadConfig] = useContext(ConfigContext);
    const updateToast = useContext(ToastNotificationContext);
    // Read when the dialog opens, not at mount - see useSyncOnOpen.
    const [ping, setPing] = useState("");
    const [download, setDownload] = useState("");
    const [upload, setUpload] = useState("");

    useSyncOnOpen(open, () => {
        setPing(config.ping || "");
        setDownload(config.download || "");
        setUpload(config.upload || "");
    });
    const [recommendations, setRecommendations] = useState(null);
    // Distinguishes "not enough tests yet", which the API reports as 501, from a
    // genuine failure - only the former earns an explanation.
    const [tooFewTests, setTooFewTests] = useState(false);
    // One run at a time. The three PATCHes below take long enough on a slow
    // link for a second click to land, and that second click ran the whole
    // chain again, interleaved with the first.
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!open) return;

        setRecommendations(null);
        setTooFewTests(false);

        jsonRequest("/recommendations")
            .then((result) => setRecommendations(result))
            .catch((error) => setTooFewTests(error?.status === NOT_ENOUGH_TESTS_STATUS));
    }, [open]);

    const applyRecommendations = () => {
        if (recommendations) {
            setPing(recommendations.ping.toString());
            setDownload(recommendations.download.toString());
            setUpload(recommendations.upload.toString());
        }
    };

    const update = async (close) => {
        // The shared rule, not a second copy of it. This asked a negated
        // character class - whether every character was a digit or a dot -
        // which is not what a number is: "1.2.3", ".." and "." all satisfy it.
        // The dialog waved them through to a server that refuses them, and the
        // three fields are patched one after another, so a bad third value
        // arrived only after the first two had been written: an error reported
        // over a change that had partly happened.
        //
        // The class itself is named in the test rather than here, because the
        // assertion that it is gone would otherwise find it in this sentence.
        //
        // Each field is patched below only when it differs from what is stored,
        // so this asks the same question the send does. Validating all three
        // regardless made a malformed value already on the instance - and every
        // MySpeed up to 1.3.4 stored whatever the unanchored check let through -
        // refuse the whole save, including the field that was actually edited.
        // The operator could not even see the culprit: a number input drops a
        // value it cannot parse, so the offending field reads empty.
        const invalid = (value, stored) => value !== stored && value && !isThresholdNumber(value);

        if (invalid(ping, config.ping) || invalid(download, config.download)
            || invalid(upload, config.upload)) {
            updateToast(t("dropdown.invalid"), "red", faExclamationTriangle);
            return;
        }
        // Checked, not assumed: patchRequest hands back the raw Response, and
        // awaiting it alone toasted "changes applied" over a 400 - clearing a
        // field, for one, was refused by the server and reported as saved.
        const patch = async (path, value) => assertOk(await patchRequest(path, {value}), path);

        if (saving) return;
        setSaving(true);

        try {
            if (ping !== config.ping) await patch("/config/ping", ping);
            if (download !== config.download) await patch("/config/download", download);
            if (upload !== config.upload) await patch("/config/upload", upload);
            reloadConfig();
            updateToast(t("dropdown.changes_applied"), "green", faCheck);
            close();
        } catch (e) {
            // The server's refusal says which value it disliked; only a network
            // failure falls back to the generic line.
            updateToast(e instanceof RequestError ? e.message : t("dropdown.changes_unsaved"),
                "red", faExclamationTriangle);
        } finally {
            // However the run ended - a refused value must not leave the
            // dialog locked shut.
            setSaving(false);
        }
    };

    return (
        <Dialog open={open} onClose={onClose} className="optimal-values-dialog">
            {({close}) => (
                <>
                    <DialogHeader onClose={close}>{t("optimal_values.title")}</DialogHeader>
                    <DialogBody>
                        <div className="optimal-values-content">
                            <div className="optimal-values-speeds">
                                <div className="optimal-values-speed">
                                    <div className="optimal-values-speed-header">
                                        <FontAwesomeIcon icon={faTableTennis}/>
                                        <div className="optimal-values-speed-text">
                                            <h2>{t("latest.ping")}</h2>
                                            <p>{t("welcome.ms")}</p>
                                        </div>
                                    </div>
                                    <input type="number" placeholder={recommendations?.ping || ""} className="dialog-input"
                                           value={ping} onChange={(e) => setPing(e.target.value)}/>
                                </div>
                                <div className="optimal-values-speed">
                                    <div className="optimal-values-speed-header">
                                        <FontAwesomeIcon icon={faArrowDown}/>
                                        <div className="optimal-values-speed-text">
                                            <h2>{t("latest.down")}</h2>
                                            <p>{t("welcome.mbps")}</p>
                                        </div>
                                    </div>
                                    <input type="number" placeholder={recommendations?.download || ""} className="dialog-input"
                                           value={download} onChange={(e) => setDownload(e.target.value)}/>
                                </div>
                                <div className="optimal-values-speed">
                                    <div className="optimal-values-speed-header">
                                        <FontAwesomeIcon icon={faArrowUp}/>
                                        <div className="optimal-values-speed-text">
                                            <h2>{t("latest.up")}</h2>
                                            <p>{t("welcome.mbps")}</p>
                                        </div>
                                    </div>
                                    <input type="number" placeholder={recommendations?.upload || ""} className="dialog-input"
                                           value={upload} onChange={(e) => setUpload(e.target.value)}/>
                                </div>
                            </div>

                            {recommendations && (
                                <p className="optimal-values-note">
                                    <Trans components={{Bold: <span className="dialog-value"/>}}
                                           values={{ping: recommendations.ping, down: recommendations.download,
                                               up: recommendations.upload}}>info.recommendations_info</Trans>
                                </p>
                            )}

                            {tooFewTests && (
                                <p className="optimal-values-note">{t("info.recommendations_error")}</p>
                            )}
                        </div>
                    </DialogBody>
                    <DialogFooter>
                        {recommendations && (
                            <button type="button" className="dialog-btn" onClick={applyRecommendations}>
                                <FontAwesomeIcon icon={faWandMagicSparkles}/>
                                <span>{t("optimal_values.use_recommended")}</span>
                            </button>
                        )}
                        <button type="button" className="dialog-btn" onClick={() => update(close)}
                                disabled={saving}>{t("dialog.update")}</button>
                    </DialogFooter>
                </>
            )}
        </Dialog>
    );
};
