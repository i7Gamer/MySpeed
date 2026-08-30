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
import {hasOpenOverlay} from "@/common/contexts/Dialog";
import {takePasswordUnsetMark} from "@/common/utils/PasswordSetup";
import {useClickOutside} from "@/common/hooks/useClickOutside";
import {clickable} from "@/common/utils/Clickable";
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
import TargetsDialog from "@/common/components/TargetsDialog";
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
    const [showTargetsDialog, setShowTargetsDialog] = useState(false);
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

    /**
     * Escape, on the same event every overlay answers.
     *
     * This listened on keyup, and it was the only overlay in the app that did:
     * the Dialog, the alert, the chart modal and the date picker all close on
     * keydown. The press a dialog had answered - and preventDefault()ed -
     * therefore still closed this menu on its release, the release being a
     * fresh event with nothing prevented on it.
     *
     * event.key rather than event.code, which names the physical key: a
     * keyboard with Escape remapped onto another key says "CapsLock" there,
     * and the menu would not close at all.
     *
     * hasOpenOverlay as well as defaultPrevented, and both are needed:
     * document listeners run in registration order, and this one is registered
     * on mount while a dialog's arrives only once it opens - so on a shared
     * press this handler runs first, before the dialog has had its turn to
     * prevent anything. The password dialog the effect above opens over an
     * open menu is exactly that shape.
     */
    useEffect(() => {
        const onPress = event => {
            if (!isOpen) return;
            if (event.key !== "Escape" || event.defaultPrevented || hasOpenOverlay()) return;

            event.preventDefault();
            switchDropdown();
        }

        document.addEventListener("keydown", onPress);
        return () => document.removeEventListener("keydown", onPress);
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
        // Both awaited. assertOk is async, and without the outer await its
        // rejection was never handed to this catch - it escaped unhandled, no
        // toast appeared, and updateStatus() below ran regardless, redrawing
        // the menu still offering "Resume tests" with nothing to say why.
        try {
            await assertOk(await postRequest("/speedtests/continue"), "continue");
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

    /*
     * Every entry carries a `key` of its own, separators included.
     *
     * React was given `entry.run` - a function, which it stringifies to that
     * function's source text. Stable across renders by accident, but it makes
     * every key hundreds of bytes of code and comments, and two entries whose
     * handlers ever became textually identical would collide in silence.
     *
     * `entry.text` is the tempting swap and the wrong one: each is a t() call
     * evaluated at render, so a language change rewrites all ten keys at once
     * and remounts the menu, and the pause entry's flips on every toggle. These
     * are stable by construction instead, and the two branches below now read
     * the same.
     */
    const options = [
        {key: "optimal_values", run: () => setShowOptimalValuesDialog(true), icon: faGauge, text: t("dropdown.optimal_values"), previewDisabled: true},
        {hr: true, key: "hr-1"},
        {key: "targets", run: () => setShowTargetsDialog(true), icon: faSliders, text: t("dropdown.targets"), previewDisabled: true},
        // Not disabled: the exports underneath are GETs and still work on a
        // demo. Only its import and clear buttons are refused, and the dialog
        // reports those itself.
        {key: "storage", run: () => setShowStorageDialog(true), icon: faHardDrive, text: t("dropdown.storage")},
        {key: "password", run: () => setShowPasswordDialog(true), icon: faKey, text: t("dropdown.password"), previewHidden: true},
        {key: "cron", run: () => setShowFrequencyDialog(true), icon: faClock, text: t("dropdown.cron"), previewDisabled: true},
        {key: "pause", run: togglePause, icon: status.paused ? faPlay : faPause, text: t("dropdown." + (status.paused ? "resume_tests" : "pause_tests")), previewDisabled: true},
        {key: "integrations", run: () => setShowIntegrationDialog(true), icon: faCircleNodes, text: t("dropdown.integrations")},
        {hr: true, key: "hr-2"},
        {key: "language", run: () => setShowLanguageDialog(true), icon: faGlobeEurope, text: t("dropdown.language"), allowView: true},
        {key: "preferences", run: () => setShowPreferencesDialog(true), icon: faUserGear, text: t("dropdown.preferences"), allowView: true},
        {key: "provider", run: showProviderDetails, icon: faInfo, text: t("dropdown.provider"), previewShown: true}
    ];

    return (
        <>
            <IntegrationDialog open={showIntegrationDialog} onClose={() => setShowIntegrationDialog(false)}/>
            <LanguageDialog open={showLanguageDialog} onClose={() => setShowLanguageDialog(false)}/>
            <TargetsDialog open={showTargetsDialog} onClose={() => setShowTargetsDialog(false)}/>
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

                                    /*
                                     * A control, not a div that happens to
                                     * answer a click. This menu is the only
                                     * route to nine of the app's dialogs -
                                     * optimal values, the targets, storage,
                                     * the password, the schedule, pause,
                                     * integrations, the language and the
                                     * preferences - and every entry was a bare
                                     * onClick, so Tab walked past all of them
                                     * and a keyboard-only operator could not
                                     * open a single one.
                                     *
                                     * `clickable` rather than a <button>, for
                                     * the reason it documents: the entry holds
                                     * an <h3>, which a button may not contain.
                                     */
                                    return (<div className={"dropdown-item" + (blocked ? " dropdown-item-disabled" : "")}
                                                 {...clickable(() => {
                                        switchDropdown();
                                        // The explanation instead of the dialog:
                                        // the save behind it would be refused.
                                        (blocked ? explainPreview : entry.run)();
                                    })} key={entry.key}>
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