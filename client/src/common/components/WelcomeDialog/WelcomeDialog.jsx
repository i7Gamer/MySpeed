import {Dialog} from "@/common/contexts/Dialog";
import "./styles.sass";
import {useContext, useState} from "react";
import {useSyncOnOpen} from "@/common/hooks/useSyncOnOpen";
import Greetings from "./steps/Greetings";
import ProviderChooser from "./steps/ProviderChooser";
import DataHelper from "./steps/DataHelper";
import OoklaLicense from "./steps/OoklaLicense";
import {assertOk, patchRequest, RequestError} from "@/common/utils/RequestUtil";
import {ConfigContext} from "@/common/contexts/Config";
import {ToastNotificationContext} from "@/common/contexts/ToastNotification";
import {faExclamationTriangle} from "@fortawesome/free-solid-svg-icons";
import {t} from "i18next";
import {writeStored} from "@/common/utils/Storage";

export const WelcomeDialog = ({open, onClose}) => {
    const [config, reloadConfig] = useContext(ConfigContext);
    const updateToast = useContext(ToastNotificationContext);
    const [step, setStep] = useState(1);
    const [provider, setProvider] = useState("ookla");
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
        setPing(parseInt(config.ping) || 0);
        setDownload(parseInt(config.download) || 0);
        setUpload(parseInt(config.upload) || 0);
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
                await patch("/config/provider", provider);
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
        close();
    };

    const continueStep = (close) => {
        if (step === (provider === "ookla" ? 4 : 3)) {
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
                        {step === 2 && <ProviderChooser provider={provider} setProvider={setProvider}/>}
                        {step === 3 && <DataHelper ping={ping} setPing={setPing} download={download}
                                                   setDownload={setDownload} upload={upload} setUpload={setUpload}/>}
                        {step === 4 && provider === "ookla" && <OoklaLicense/>}
                    </div>
                    <div className="welcome-actions">
                        <h3>{t("welcome.step")} {step}/{provider === "ookla" ? 4 : 3}</h3>
                        <button className="dialog-btn" onClick={() => continueStep(forceClose)}>
                            {step === (provider === "ookla" ? 4 : 3) ? t("dialog.done") : t("dialog.continue")}
                        </button>
                    </div>
                </div>
            )}
        </Dialog>
    );
}
