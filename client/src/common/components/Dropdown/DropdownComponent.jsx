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
    faUserGear
} from "@fortawesome/free-solid-svg-icons";
import {ConfigContext} from "@/common/contexts/Config";
import {takePasswordUnsetMark} from "@/common/utils/PasswordSetup";
import {useClickOutside} from "@/common/hooks/useClickOutside";
import {StatusContext} from "@/common/contexts/Status";
import {useAlert} from "@/common/contexts/Alert";
import {postRequest} from "@/common/utils/RequestUtil";
import {t} from "i18next";
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
        if (!status.paused) {
            setShowPauseDialog(true);
        } else {
            await postRequest("/speedtests/continue");
            updateStatus();
        }
    };

    const showProviderDetails = () => alert.openAlert(
        t("dropdown.provider"),
        config.previewMessage,
        { buttonText: t("dialog.close") }
    );

    const options = [
        {run: () => setShowOptimalValuesDialog(true), icon: faGauge, text: t("dropdown.optimal_values")},
        {hr: true, key: 1},
        {run: () => setShowProviderDialog(true), icon: faSliders, text: t("dropdown.change_provider")},
        {run: () => setShowStorageDialog(true), icon: faHardDrive, text: t("dropdown.storage")},
        {run: () => setShowPasswordDialog(true), icon: faKey, text: t("dropdown.password"), previewHidden: true},
        {run: () => setShowFrequencyDialog(true), icon: faClock, text: t("dropdown.cron")},
        {run: togglePause, icon: status.paused ? faPlay : faPause, text: t("dropdown." + (status.paused ? "resume_tests" : "pause_tests"))},
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
                                    return (<div className="dropdown-item" onClick={() => {
                                        switchDropdown();
                                        entry.run();
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