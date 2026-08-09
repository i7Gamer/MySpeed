import React, {createContext, useEffect, useState} from "react";
import {useAlert} from "../Alert";
import {login, request} from "@/common/utils/RequestUtil";
import {promptUntilAccepted} from "@/common/utils/PasswordPrompt";
import {apiErrorDialog, passwordRequiredDialog} from "@/common/contexts/Config/dialog";
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
            if (res.status === 401) throw 1;
            if (!res.ok) throw 2;

            try {
                return JSON.parse(await res.text());
            } catch (e) {
                throw 2;
            }
        }).then(result => {
            if (config !== result)
                result.viewMode && localStorage.getItem("currentNode") !== null && localStorage.getItem("currentNode") !== "0"
                    ? navigate("/nodes") : setConfig(result);
        }).catch((code) => {
            localStorage.getItem("currentNode") !== null && localStorage.getItem("currentNode") !== "0"
                ? navigate("/nodes") : showErrorDialog(code);
        });
    }

    /**
     * Asks until the password is accepted, rather than once.
     *
     * A rejected password used to end here silently: login() answered false,
     * nothing read it, and the prompt had already closed - so a typo left the
     * dashboard blank with nothing said and no way back but a manual reload.
     * This is the prompt an unauthenticated visitor meets first.
     */
    const askForPassword = async () => {
        const accepted = await promptUntilAccepted(
            (failed) => {
                const dialogConfig = passwordRequiredDialog(failed);

                return alert.openInput(dialogConfig.title, {
                    placeholder: dialogConfig.placeholder,
                    description: dialogConfig.description,
                    inputType: dialogConfig.type,
                    buttonText: dialogConfig.buttonText,
                    disableClose: dialogConfig.disableCloseButton
                });
            },
            // Exchanged for a session cookie and then dropped; the password is
            // never written anywhere this script can read it back.
            login
        );

        if (accepted) window.location.reload();
    };

    const showErrorDialog = async (code) => {
        if (code === 1) return askForPassword();

        const dialogConfig = apiErrorDialog();

        await alert.openAlert(dialogConfig.title, dialogConfig.description, {
            buttonText: dialogConfig.buttonText,
            disableClose: dialogConfig.disableCloseButton
        });
        dialogConfig.onSuccess();
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