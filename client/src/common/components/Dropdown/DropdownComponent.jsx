import React, {useContext, useEffect, useRef, useState} from "react";
import "./styles.sass";
import {
    faCircleNodes,
    faClock,
    faGlobeEurope,
    faInfo,
    faKey,
    faPause,
    faPlay,
    faSliders,
    faHardDrive,
    faGauge,
    faUserGear,
    faExclamationTriangle
} from "@fortawesome/free-solid-svg-icons";
import {ConfigContext} from "@/common/contexts/Config";
import {takePasswordUnsetMark} from "@/common/utils/PasswordSetup";
import {useClickOutside} from "@/common/hooks/useClickOutside";
import {StatusContext} from "@/common/contexts/Status";
import {ToastNotificationContext} from "@/common/contexts/ToastNotification";
import {useAlert} from "@/common/contexts/Alert";
import {assertOk, postRequest} from "@/common/utils/RequestUtil";
import {t} from "i18next";
import {Trans} from "react-i18next";
import {INSTALL_URL} from "@/index";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {IntegrationDialog} from "@/common/components/IntegrationDialog";
import LanguageDialog from "@/common/components/LanguageDialog";
import ProviderDialog from "@/common/components/ProviderDialog";
import StorageDialog from "@/common/components/StorageDialog";
import OptimalValuesDialog from "@/common/components/OptimalValuesDialog";
import FrequencyDialog from "@/common/components/FrequencyDialog";
import PasswordDialog from "@/common/components/PasswordDialog";
import PauseDialog from "@/common/components/PauseDialog";
import PreferencesDialog from "@/common/components/PreferencesDialog";

const DropdownComponent = ({isOpen, switchDropdown}) => {
    const [config] = useContext(ConfigContext);
    const [status, updateStatus] = useContext(StatusContext);
    const updateToast = useContext(ToastNotificationContext);
    const alert = useAlert();
    const [showIntegrationDialog, setShowIntegrationDialog] = useState(false);
    const [showLanguageDialog, setShowLanguageDialog] = useState(false);
    const [showProviderDialog, setShowProviderDialog] = useState(false);
    const [showStorageDialog, setShowStorageDialog] = useState(false);
    const [showOptimalValuesDialog, setShowOptimalValuesDialog] = useState(false);
    const [showFrequencyDialog, setShowFrequencyDialog] = useState(false);
    const [showPasswordDialog, setShowPasswordDialog] = useState(false);
    const [showPauseDialog, setShowPauseDialog] = useState(false);
    const [showPreferencesDialog, setShowPreferencesDialog] = useState(false);
    const ref = useRef();

    /**
     * Finishes what a setup-token sign-in started.
     *
     * The token opens the instance without giving it a password, and the next
     * restart issues a different one - so being let in is only half of it. The
     * sign-in leaves a note across its reload and this opens the dialog that
     * ends the cycle. Guarded on passwordSet as well as the note, so it stays
     * shut if a password arrived some other way in between.
     */
    useEffect(() => {
        if (config.passwordSet === false && takePasswordUnsetMark()) setShowPasswordDialog(true);
    }, [config.passwordSet]);

    // The gear that opened the dropdown must not count as outside, or its own
    // click would close-and-reopen. closest() rather than walking
    // composedPath() by fixed depth, which broke as soon as a wrapper element
    // appeared between the icon and the id.
    useClickOutside(isOpen, [ref], switchDropdown,
        {ignore: (target) => target.closest?.("#open-header")});

    useEffect(() => {
        const onPress = event => {
            if (event.code === "Escape" && isOpen) {
                switchDropdown();
            }
        }

        document.addEventListener("keyup", onPress);
        return () => document.removeEventListener("keyup", onPress);
        // The prop is listed rather than narrowed away: this only swaps one
        // document listener for another, which costs nothing, and a handler
        // holding the parent's previous closure is a real way for Escape to
        // close nothing.
    }, [isOpen, switchDropdown]);
    
    const togglePause = async () => {
        if (!status.paused) return setShowPauseDialog(true);

        // Checked, not assumed - the same reason PauseDialog gives for its own
        // half of this pair. postRequest hands back the raw Response, so a
        // refusal (a 403 on a demo, a 401 on an expired session, a 500) was
        // discarded and the menu re-rendered still offering "Resume tests",
        // with nothing on screen to say the request had failed.
        try {
            assertOk(await postRequest("/speedtests/continue"), "continue");
        } catch (e) {
            updateToast(e.message || t("dropdown.changes_unsaved"), "red", faExclamationTriangle);
            return;
        }

        updateStatus();
    };

    const showProviderDetails = () => alert.openAlert(
        t("dropdown.provider"),
        config.previewMessage,
        { buttonText: t("dialog.close") }
    );

    /**
     * Why a setting is not open on a demo, rather than a red toast saying the
     * save failed.
     *
     * The server refuses every one of these with a 403 in preview mode, so the
     * dialogs behind them could be filled in and then never saved - the demo
     * presented a working-looking form that always errored. Explaining beats
     * hiding here: seeing which settings exist is half of what a demo is for,
     * and it matches what the node page and the integration dialog already do.
     */
    const explainPreview = () => alert.openAlert(
        t("preview.title"),
        // Through Trans, not t(): this string carries a <Link> placeholder for
        // the install page, and openAlert renders its description as a React
        // child - so `t()` put the literal angle brackets on screen in all
        // sixteen locales. The header's demo dialog does the same thing with
        // the same string.
        <Trans components={{ Link: <a href={INSTALL_URL} target="_blank" rel="noreferrer" /> }}>
            preview.description
        </Trans>,
        { buttonText: t("dialog.close") }
    );

    const options = [
        {run: () => setShowOptimalValuesDialog(true), icon: faGauge, text: t("dropdown.optimal_values"), previewDisabled: true},
        {hr: true, key: 1},
        {run: () => setShowProviderDialog(true), icon: faSliders, text: t("dropdown.change_provider"), previewDisabled: true},
        // Not disabled: the exports underneath are GETs and still work on a
        // demo. Only its import and clear buttons are refused, and the dialog
        // reports those itself.
        {run: () => setShowStorageDialog(true), icon: faHardDrive, text: t("dropdown.storage")},
        {run: () => setShowPasswordDialog(true), icon: faKey, text: t("dropdown.password"), previewHidden: true},
        {run: () => setShowFrequencyDialog(true), icon: faClock, text: t("dropdown.cron"), previewDisabled: true},
        {run: togglePause, icon: status.paused ? faPlay : faPause, text: t("dropdown." + (status.paused ? "resume_tests" : "pause_tests")), previewDisabled: true},
        {run: () => setShowIntegrationDialog(true), icon: faCircleNodes, text: t("dropdown.integrations")},
        {hr: true, key: 2},
        {run: () => setShowLanguageDialog(true), icon: faGlobeEurope, text: t("dropdown.language"), allowView: true},
        {run: () => setShowPreferencesDialog(true), icon: faUserGear, text: t("dropdown.preferences"), allowView: true},
        {run: showProviderDetails, icon: faInfo, text: t("dropdown.provider"), previewShown: true}
    ];

    return (
        <>
            <IntegrationDialog open={showIntegrationDialog} onClose={() => setShowIntegrationDialog(false)}/>
            <LanguageDialog open={showLanguageDialog} onClose={() => setShowLanguageDialog(false)}/>
            <ProviderDialog open={showProviderDialog} onClose={() => setShowProviderDialog(false)}/>
            <StorageDialog open={showStorageDialog} onClose={() => setShowStorageDialog(false)}/>
            <OptimalValuesDialog open={showOptimalValuesDialog} onClose={() => setShowOptimalValuesDialog(false)}/>
            <FrequencyDialog open={showFrequencyDialog} onClose={() => setShowFrequencyDialog(false)}/>
            <PasswordDialog open={showPasswordDialog} onClose={() => setShowPasswordDialog(false)}/>
            <PauseDialog open={showPauseDialog} onClose={() => setShowPauseDialog(false)} onPause={updateStatus}/>
            <PreferencesDialog open={showPreferencesDialog} onClose={() => setShowPreferencesDialog(false)}/>
            <div className={`dropdown ${isOpen ? '' : 'dropdown-invisible'}`} ref={ref}>
                <div className="dropdown-content">
                    <h2>{t("dropdown.settings")}</h2>
                    <div className="dropdown-entries">
                        {options.map(entry => {
                            if (entry.previewHidden && config.previewMode) return;
                            if (entry.previewShown && !config.previewMode) return;
                            if (!config.viewMode || (config.viewMode && entry.allowView)) {
                                if (!entry.hr) {
                                    const blocked = entry.previewDisabled && config.previewMode;

                                    return (<div className={"dropdown-item" + (blocked ? " dropdown-item-disabled" : "")}
                                                 onClick={() => {
                                        switchDropdown();
                                        // The explanation instead of the dialog:
                                        // the save behind it would be refused.
                                        (blocked ? explainPreview : entry.run)();
                                    }} key={entry.run}>
                                        <FontAwesomeIcon icon={entry.icon}/>
                                        <h3>{entry.text}</h3>
                                    </div>);
                                } else return (<div className="center" key={entry.key}>
                                    <hr className="dropdown-hr"/>
                                </div>);
                            }
                        })}
                    </div>
                </div>
            </div>
        </>
    );
}

export default DropdownComponent;