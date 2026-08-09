import React, {createContext, useEffect, useState} from "react";
import {useAlert} from "../Alert";
import {login, request} from "@/common/utils/RequestUtil";
import {promptUntilAccepted} from "@/common/utils/PasswordPrompt";
import {promptFor, PROMPT_SETUP_TOKEN, PROMPT_THROTTLED} from "@/common/utils/AuthOutcome";
import {markPasswordUnset} from "@/common/utils/PasswordSetup";
import {
    apiErrorDialog, passwordRequiredDialog, setupTokenDialog, throttledDialog
} from "@/common/contexts/Config/dialog";
import WelcomeDialog from "@/common/components/WelcomeDialog";
import {useNavigate} from "react-router-dom";

export const ConfigContext = createContext({});

export const ConfigProvider = (props) => {
    const [config, setConfig] = useState({});
    const alert = useAlert();
    const [welcomeShown, setWelcomeShown] = useState(false);
    const navigate = useNavigate();


    const reloadConfig = () => {
        request("/config").then(async res => {
            // The refusal says which credential it wants, and that is the whole
            // reason the right question can be asked. Throwing a bare 1 here
            // discarded it one line before it was needed, so every refusal -
            // including one from an instance with no password at all - asked
            // for "your password".
            if (res.status === 401 || res.status === 429) {
                const body = await res.json().catch(() => ({}));
                throw {credential: true, type: body?.type};
            }
            if (!res.ok) throw {credential: false};

            try {
                return JSON.parse(await res.text());
            } catch (e) {
                throw {credential: false};
            }
        }).then(result => {
            if (config !== result)
                result.viewMode && localStorage.getItem("currentNode") !== null && localStorage.getItem("currentNode") !== "0"
                    ? navigate("/nodes") : setConfig(result);
        }).catch((reason) => {
            localStorage.getItem("currentNode") !== null && localStorage.getItem("currentNode") !== "0"
                ? navigate("/nodes") : showErrorDialog(reason);
        });
    }

    const openAlertDialog = async (dialogConfig) => {
        await alert.openAlert(dialogConfig.title, dialogConfig.description, {
            buttonText: dialogConfig.buttonText,
            disableClose: dialogConfig.disableCloseButton
        });
        dialogConfig.onSuccess?.();
    };

    /**
     * Asks for whichever credential the server says it wants, until it is
     * accepted - rather than asking for a password once and giving up.
     *
     * A refusal used to end here silently: login() answered false, nothing read
     * it, and the prompt had already closed, so a typo left the dashboard blank
     * with nothing said. It also only ever asked for a password, which an
     * instance that has none cannot be opened with. This is the prompt an
     * unauthenticated visitor meets first, and for a locked-out operator it is
     * the only instruction they get.
     */
    const askForCredential = async (initialType) => {
        // Dismissing the lockout notice returns nothing, which ends the loop -
        // there is no credential that would be accepted until it expires.
        const ask = async (type, failed) => {
            const kind = promptFor(type);

            if (kind === PROMPT_THROTTLED) return openAlertDialog(throttledDialog());

            const dialogConfig = kind === PROMPT_SETUP_TOKEN
                ? setupTokenDialog(failed)
                : passwordRequiredDialog(failed);

            return alert.openInput(dialogConfig.title, {
                placeholder: dialogConfig.placeholder,
                description: dialogConfig.description,
                inputType: dialogConfig.type,
                buttonText: dialogConfig.buttonText,
                disableClose: dialogConfig.disableCloseButton
            });
        };

        const accepted = await promptUntilAccepted(
            (previous) => ask(previous ? previous.type : initialType, previous !== null),
            // Exchanged for a session cookie and then dropped; the credential is
            // never written anywhere this script can read it back.
            login
        );

        if (!accepted) return;

        // Getting in with a setup token leaves the instance exactly as it was -
        // without a password, and issuing a different token at the next
        // restart. Reloading alone would drop the operator back on the
        // dashboard with the job half done, so the settings dialog is asked to
        // open itself once the page comes back.
        if (promptFor(initialType) === PROMPT_SETUP_TOKEN) markPasswordUnset();

        window.location.reload();
    };

    const showErrorDialog = async (reason) => {
        if (reason?.credential) return askForCredential(reason.type);

        return openAlertDialog(apiErrorDialog());
    };

    const checkConfig = async () => (await request("/config")).json();

    useEffect(reloadConfig, []);

    useEffect(() => {
        if (config.previewMode && !localStorage.getItem("welcomeShown")) setWelcomeShown(true);
        if (!config.previewMode && config.provider === "none") setWelcomeShown(true);
    }, [config]);

    return (
        <ConfigContext.Provider value={[config, reloadConfig, checkConfig]}>
            <WelcomeDialog open={welcomeShown} onClose={() => setWelcomeShown(false)}/>
            {props.children}
        </ConfigContext.Provider>
    )
}