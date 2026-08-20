import React, {createContext, useEffect, useState} from "react";
import {useAlert} from "../Alert";
import {login, request} from "@/common/utils/RequestUtil";
import {promptUntilAccepted} from "@/common/utils/PasswordPrompt";
import {
    NODE_REFUSAL_HEADER, promptFor, PROMPT_BUSY, PROMPT_SETUP_TOKEN, PROMPT_THROTTLED, SERVER_BUSY
} from "@/common/utils/AuthOutcome";
import {markPasswordUnset} from "@/common/utils/PasswordSetup";
import {
    apiErrorDialog, busyDialog, passwordRequiredDialog, setupTokenDialog, throttledDialog
} from "@/common/contexts/Config/dialog";
import WelcomeDialog from "@/common/components/WelcomeDialog";
import LockedNotice from "@/common/components/LockedNotice";
import {useNavigate} from "react-router-dom";
import {configOutcome, failureOutcome} from "@/common/contexts/Config/configOutcome";
import {readStored} from "@/common/utils/Storage";

export const ConfigContext = createContext({});

export const ConfigProvider = (props) => {
    const [config, setConfig] = useState({});
    const alert = useAlert();
    // The refusal a dismissed prompt left behind, or null while there is
    // nothing to explain. Held as an object because the type itself may be
    // undefined - an older node answers 401 with no type at all.
    const [locked, setLocked] = useState(null);
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
                // And who refused, which the body cannot say: the proxy relays a
                // node's answer verbatim, so a child rejecting its stored
                // password is byte for byte this instance's own session
                // expiring. Only one of the two is answered by the password box
                // in front of the visitor - see failureOutcome.
                throw {credential: true, type: body?.type,
                    node: res.headers.get(NODE_REFUSAL_HEADER) !== null};
            }

            // A 503 only counts when the body says it is ours. A reverse proxy
            // in front of a stopped container answers 503 too, and treating
            // that as a refusal put a password box in front of a server that
            // was down - then called the password wrong when the retry failed
            // the same way. This is the check node.js makes for the same
            // reason; "could not reach the API" is the truthful answer there.
            if (res.status === 503) {
                const body = await res.json().catch(() => ({}));
                if (body?.type === SERVER_BUSY) throw {credential: true, type: body.type};

                throw {credential: false};
            }
            if (!res.ok) throw {credential: false};

            try {
                return JSON.parse(await res.text());
            } catch {
                throw {credential: false};
            }
        }).then(result => {
            // Stored unconditionally. This was a ternary - navigate *or* store -
            // and the redirect took the config with it, leaving every consumer
            // reading {} for the rest of the session. Where to be and what to
            // hold are two separate answers.
            const {config: loaded, redirectToNodes} = configOutcome(result, readStored("currentNode"));

            setConfig(loaded);
            if (redirectToNodes) navigate("/nodes");
        }).catch((reason) => {
            // The reason travels with it: a refusal that wants a credential is
            // not a node that has gone away, and only one of the two is
            // answered by moving the visitor - see failureOutcome.
            if (failureOutcome(readStored("currentNode"), reason).redirectToNodes) return navigate("/nodes");

            showErrorDialog(reason);
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
        // The refusal the loop ended on, which is not always the one it started
        // with - a wrong password often enough becomes a lockout, and the
        // notice has to describe where the operator actually is.
        let lastType = initialType;

        // Dismissing the lockout notice returns nothing, which ends the loop -
        // there is no credential that would be accepted until it expires.
        const ask = async (type, failed) => {
            lastType = type;
            const kind = promptFor(type);

            if (kind === PROMPT_THROTTLED) return openAlertDialog(throttledDialog());
            // Its own dialog, not the password box with a red line above it:
            // this refusal is about the server being busy, and the primary
            // prompt is where an operator meets it first.
            if (kind === PROMPT_BUSY) return openAlertDialog(busyDialog());

            const dialogConfig = kind === PROMPT_SETUP_TOKEN
                ? setupTokenDialog(failed)
                : passwordRequiredDialog(failed);

            return alert.openInput(dialogConfig.title, {
                placeholder: dialogConfig.placeholder,
                description: dialogConfig.description,
                inputType: dialogConfig.type,
                buttonText: dialogConfig.buttonText,
                disableClose: dialogConfig.disableCloseButton,
                // Enter on the autofocused empty box resolves with "", which
                // the loop below reads as a dismissal - so without this, one
                // keypress dismissed a prompt nobody meant to dismiss. The X,
                // Escape and the backdrop are deliberate ways out; an empty
                // submit is not one of them.
                required: true
            });
        };

        // Down while the prompt is up, so reopening from the notice does not
        // leave the two stacked.
        setLocked(null);

        const accepted = await promptUntilAccepted(
            (previous) => ask(previous ? previous.type : initialType, previous !== null),
            // Exchanged for a session cookie and then dropped; the credential is
            // never written anywhere this script can read it back.
            login
        );

        // Giving up used to return to nothing: the config stayed {} and the
        // dashboard behind the prompt rendered an empty shell, which is what
        // made closing the prompt unthinkable in the first place. The notice is
        // what makes it thinkable - it carries the same explanation and opens
        // the prompt again on demand.
        if (!accepted) return setLocked({type: lastType});

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

    // Once, at mount. reloadConfig reaches `navigate` and `showErrorDialog`,
    // both rebuilt on every render - listing them would refetch the config on
    // each one, and each fetch sets the state that causes the next render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(reloadConfig, []);

    useEffect(() => {
        if (config.previewMode && !readStored("welcomeShown")) setWelcomeShown(true);
        if (!config.previewMode && config.provider === "none") setWelcomeShown(true);
    }, [config]);

    return (
        <ConfigContext.Provider value={[config, reloadConfig, checkConfig]}>
            <WelcomeDialog open={welcomeShown} onClose={() => setWelcomeShown(false)}/>
            {locked && <LockedNotice type={locked.type} onRetry={() => askForCredential(locked.type)}/>}
            {props.children}
        </ConfigContext.Provider>
    )
}