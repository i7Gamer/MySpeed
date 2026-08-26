import {Dialog} from "@/common/contexts/Dialog";
import "./styles.sass";
import {useContext, useState} from "react";
import {useSyncOnOpen} from "@/common/hooks/useSyncOnOpen";
import Greetings from "./steps/Greetings";
import ProviderChooser from "./steps/ProviderChooser";
import DataHelper from "./steps/DataHelper";
import OoklaLicense from "./steps/OoklaLicense";
import {assertOk, patchRequest, putRequest, RequestError} from "@/common/utils/RequestUtil";
import {ConfigContext} from "@/common/contexts/Config";
import {TargetsContext} from "@/common/contexts/Targets";
import {providerById, requiresEndpoint} from "@/common/components/TargetsDialog/providers";
import {ToastNotificationContext} from "@/common/contexts/ToastNotification";
import {faExclamationTriangle} from "@fortawesome/free-solid-svg-icons";
import {t} from "i18next";
import {writeStored} from "@/common/utils/Storage";
import {PROVIDER_STEP, canAdvance, lastStep} from "./welcomeStep";

export const WelcomeDialog = ({open, onClose}) => {
    const [config, reloadConfig] = useContext(ConfigContext);
    const {reloadTargets} = useContext(TargetsContext);
    const updateToast = useContext(ToastNotificationContext);
    const [step, setStep] = useState(1);
    const [provider, setProvider] = useState("ookla");
    // Where a provider that has no server pool of its own measures. Held here
    // rather than in the chooser, because finish() is what has to send it.
    const [endpoint, setEndpoint] = useState("");
    const [ping, setPing] = useState(0);
    const [download, setDownload] = useState(0);
    const [upload, setUpload] = useState(0);
    const [animating, setAnimating] = useState(false);

    /**
     * Seeded when the wizard opens, not when it mounts.
     *
     * ConfigProvider renders this itself, so it mounts on the provider's very
     * first render - before the config has been fetched - and an initialiser
     * never runs again. All three targets stayed at 0, and finish() PATCHes
     * them unconditionally: clicking through a fresh install without touching
     * that step replaced the shipped defaults with zeroes, which leaves every
     * metric rendering blue forever and no target bar anywhere.
     */
    useSyncOnOpen(open, () => {
        // parseFloat, because finish() writes all three back unconditionally:
        // an integer parse rewrote any fractional threshold the wizard was
        // merely clicked past - "25.9" went back as 25, and "0.4", the
        // recommended ping on a fast line, went back as 0, a threshold no
        // latency is ever under. The wizard opens by itself while the provider
        // is unset, which is exactly when thresholds are being set first.
        setPing(parseFloat(config.ping) || 0);
        setDownload(parseFloat(config.download) || 0);
        setUpload(parseFloat(config.upload) || 0);
    });

    const finish = async (close) => {
        // Checked, not assumed: patchRequest hands back the raw Response, so a
        // refused write used to close the wizard as if the setup had stuck.
        const patch = async (path, value) => assertOk(await patchRequest(path, {value}), path);

        try {
            // The branch has to come first, not after the provider write. A
            // demo refuses every PATCH - previewReadOnly sits on
            // /api/config/:key whoever is asking - so the provider call threw,
            // toasted and returned before reaching the line below that records
            // the wizard as shown. ConfigContext reopens it whenever previewMode
            // is set and welcomeShown is absent, and nothing else writes that
            // key, so the box was unclosable for every visitor on every load.
            //
            // Nothing to save on a demo in any case: its configuration is fixed
            // by the operator who published it.
            if (config.previewMode) {
                writeStored("welcomeShown", "true");
            } else {
                // The wizard's provider choice becomes the instance's first
                // target, named after its provider - the manager dialog is
                // where it earns a better name. PUT rather than a config
                // PATCH: the provider stopped being a config key.
                await assertOk(await putRequest("/targets", {
                    name: providerById(provider)?.name ?? provider,
                    provider,
                    // Only where the provider cannot do without one. A
                    // LibreSpeed target measures against the public backend
                    // list until the manager gives it an address of its own,
                    // and the server refuses an endpoint on a provider that
                    // takes none - so a value left behind by switching cards
                    // must not travel with the row.
                    ...(requiresEndpoint(provider) ? {endpoint: endpoint.trim()} : {})
                }), "targets");
                await patch("/config/ping", ping);
                await patch("/config/download", download);
                await patch("/config/upload", upload);
            }
        } catch (e) {
            updateToast(e instanceof RequestError ? e.message : t("dropdown.changes_unsaved"),
                "red", faExclamationTriangle);
            return;
        }

        reloadConfig();
        // What closes the wizard for good: the list this dialog opened on the
        // emptiness of now has a row in it.
        reloadTargets();
        close();
    };

    // Whether the step showing may be left at all - see welcomeStep.js. The
    // button below is dead while this is false, and the handler asks again, so
    // a step the server would refuse cannot be left however it is pressed.
    const mayAdvance = canAdvance({step, provider, endpoint});

    const continueStep = (close) => {
        if (!canAdvance({step, provider, endpoint})) return;

        if (step === lastStep(provider)) {
            finish(close);
        } else {
            setAnimating(true);
            setStep(step + 1);
            setTimeout(() => setAnimating(false), 500);
        }
    };

    /*
     * Named outright rather than by id: this is the one dialog that draws a
     * banner instead of a DialogHeader, so there is no heading for the usual
     * aria-labelledby to point at - and it is also the one nobody can dismiss,
     * so an unnamed modal is the worst place to leave one.
     */
    return (
        <Dialog open={open} onClose={onClose} className="welcome-dialog" disableClose
                label={t("welcome.title")}>
            {({forceClose}) => (
                <div className="welcome-banner">
                    <div className={`welcome-inner ${animating ? 'slide-in' : ''}`}>
                        {step === 1 && <Greetings/>}
                        {step === PROVIDER_STEP && <ProviderChooser provider={provider} setProvider={setProvider}
                                                                    endpoint={endpoint} setEndpoint={setEndpoint}/>}
                        {step === 3 && <DataHelper ping={ping} setPing={setPing} download={download}
                                                   setDownload={setDownload} upload={upload} setUpload={setUpload}/>}
                        {step === 4 && provider === "ookla" && <OoklaLicense/>}
                    </div>
                    <div className="welcome-actions">
                        <h3>{t("welcome.step")} {step}/{lastStep(provider)}</h3>
                        <button type="button" className="dialog-btn" disabled={!mayAdvance}
                                onClick={() => continueStep(forceClose)}>
                            {step === lastStep(provider) ? t("dialog.done") : t("dialog.continue")}
                        </button>
                    </div>
                </div>
            )}
        </Dialog>
    );
}
