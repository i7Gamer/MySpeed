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
import {
    DEFAULT_PROVIDER, FIRST_STEP, PROVIDER_STEP, canAdvance, lastStep, welcomeSeed
} from "./welcomeStep";

export const WelcomeDialog = ({open, onClose}) => {
    const [config, reloadConfig] = useContext(ConfigContext);
    const {reloadTargets} = useContext(TargetsContext);
    const updateToast = useContext(ToastNotificationContext);
    // Named rather than written as 1 and "ookla" here as well: welcomeSeed says
    // where an opening wizard starts, and a second spelling of that beside it is
    // the copy that gets left behind.
    const [step, setStep] = useState(FIRST_STEP);
    const [provider, setProvider] = useState(DEFAULT_PROVIDER);
    // Where a provider that has no server pool of its own measures. Held here
    // rather than in the chooser, because finish() is what has to send it.
    const [endpoint, setEndpoint] = useState("");
    const [ping, setPing] = useState(0);
    const [download, setDownload] = useState(0);
    const [upload, setUpload] = useState(0);
    const [animating, setAnimating] = useState(false);
    // One run at a time - a second click on a slow link must not save twice.
    // finish() makes four round trips before it closes anything, so Done sits
    // there looking ignored for as long as the slowest of them takes, and PUT
    // /targets inserts a row per call: the second press created a second
    // identical target on an instance that had not drawn a dashboard yet, and
    // every scheduled round measured that provider twice from then on.
    const [saving, setSaving] = useState(false);

    /**
     * Seeded when the wizard opens, not when it mounts - all of it, not just
     * the thresholds.
     *
     * TargetsContext renders this itself, so it mounts on the provider's very
     * first render - before the config has been fetched - and an initialiser
     * never runs again. All three thresholds stayed at 0, and finish() PATCHes
     * them unconditionally: clicking through a fresh install without touching
     * that step replaced the shipped defaults with zeroes, which leaves every
     * metric rendering blue forever and no target bar anywhere.
     *
     * The step, the provider and the endpoint were left out of that sync, and
     * they live above the boundary DialogContext unmounts - `if (!visible)
     * return null` takes the dialog's children, not the component holding the
     * hooks. So a second freshly installed node, switched to without a page
     * load, reopened this wizard on its *last* step carrying the first node's
     * provider and its iperf3 host: no chooser, no way back, and one button
     * reading Done that wrote node A's answers onto node B.
     *
     * Applied from welcomeSeed rather than written out here, so there is one
     * statement of what an opening wizard shows instead of a list that can be
     * half updated - which is exactly how the three above came to be missing.
     */
    useSyncOnOpen(open, () => {
        const seed = welcomeSeed(config);

        setStep(seed.step);
        setProvider(seed.provider);
        setEndpoint(seed.endpoint);
        setPing(seed.ping);
        setDownload(seed.download);
        setUpload(seed.upload);
        // Not an answer, so not part of the seed - but it is state this
        // component owns, and the rule is worth keeping exceptionless: the
        // slide-in class stays on for 500ms after a step change, and a close
        // inside that window left the reopened wizard replaying the animation
        // over its first step.
        setAnimating(false);
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
                // The thresholds first and the target last, because the two
                // writes are not equally repeatable and nothing here can undo
                // the other half. A threshold PATCH says what the value *is*,
                // so running it twice is running it once; PUT /targets inserts
                // a row every time it is called - `targets.create(fields)`,
                // with no existence check and no unique index on the name.
                //
                // Written the other way round, the refusal an operator can
                // actually cause landed second: an empty number field (the
                // three inputs carry no min and are not gated by canAdvance) is
                // a 400 from the config controller, so the target was already
                // created, the wizard stayed open - it is mounted disableClose
                // and close() was never reached - and the only way on was to
                // press the same Done again, which created a second identical
                // target. Every scheduled round then measured that provider
                // twice, on an instance that had not drawn a dashboard yet.
                //
                // The reverse failure is harmless: a refused PUT leaves three
                // thresholds stored, which are the values the operator just
                // typed, and the wizard stays open because what it is keyed on
                // is the target list still being empty.
                await patch("/config/ping", ping);
                await patch("/config/download", download);
                await patch("/config/upload", upload);

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

    const continueStep = async (close) => {
        // The lock sits here rather than inside finish(), for the same reason
        // the canAdvance re-check does: this is what a click actually reaches,
        // and TargetEditor's save() - the dialog this shape is borrowed from -
        // is likewise the button's own handler. It also keeps finish() free of
        // hooks, which matters more here than it looks: welcomeFinish.test.js
        // lifts that function out of this file by text and runs it, and a
        // component variable named inside it is a free identifier that takes
        // every one of those cases down with a ReferenceError. It is the only
        // thing in this .jsx anything can execute.
        if (saving) return;
        if (!canAdvance({step, provider, endpoint})) return;

        if (step === lastStep(provider)) {
            setSaving(true);

            try {
                await finish(close);
            } finally {
                // However the run ended - a refused write must not leave the
                // one dialog nobody can dismiss locked shut. Clearing it after
                // close() is safe rather than a stray setState: TargetsContext
                // renders this component whether it is open or not.
                setSaving(false);
            }
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
                        <button type="button" className="dialog-btn"
                                disabled={!mayAdvance || saving}
                                onClick={() => continueStep(forceClose)}>
                            {step === lastStep(provider) ? t("dialog.done") : t("dialog.continue")}
                        </button>
                    </div>
                </div>
            )}
        </Dialog>
    );
}
