import {t} from "i18next";

// Presentation only. Signing in belongs to the caller, which is what lets both
// prompts share one retry loop - see PasswordPrompt. Holding login() here meant
// the caller had no way to learn a password had been rejected, so it did
// nothing about it.
// Closable, unlike every other prompt here. It used to refuse the X, Escape and
// the backdrop, because dismissing it left the page gutted - but a prompt that
// cannot be left is only reasonable while its question can be answered, and
// LockedNotice now catches the dismissal, so neither half of that trade is
// needed. Submitting an empty box is still refused; see askForCredential.
export const passwordRequiredDialog = (failed = false) => ({
    title: t("dialog.password.title"),
    placeholder: t("dialog.password.placeholder"),
    description: failed ? <span className="icon-red">{t("dialog.password.wrong")}</span> : "",
    type: "password",
    buttonText: t("dialog.login"),
    disableCloseButton: false
});

/**
 * What to ask on an instance that has no password at all.
 *
 * It refuses every caller that is not on its own loopback until they present
 * the token it prints to its log, so "your password" was the one question the
 * operator could not answer - there was no password, and nothing on the page
 * said a token existed. The description carries that, since a log line is not
 * somewhere anyone looks unless told to.
 *
 * This is the prompt that most needs a way out: the answer lives on the server,
 * not in the operator's head, so being unable to answer it right now is the
 * normal case rather than the exceptional one.
 */
export const setupTokenDialog = (failed = false) => ({
    title: t("dialog.setup_token.title"),
    placeholder: t("dialog.setup_token.placeholder"),
    description: failed
        ? <span className="icon-red">{t("dialog.setup_token.wrong")}</span>
        : t("dialog.setup_token.description"),
    type: "password",
    buttonText: t("dialog.password.unlock"),
    disableCloseButton: false
});

// Not an input: nothing typed here can be accepted until the window expires,
// and offering the box invites the operator to keep feeding a throttle that is
// answering nothing.
export const throttledDialog = () => ({
    title: t("dialog.throttled.title"),
    description: <span className="icon-red">{t("dialog.throttled.description")}</span>,
    buttonText: t("dialog.retry"),
    disableCloseButton: true,
    onSuccess: () => window.location.reload()
});

export const apiErrorDialog = () => ({
    title: t("dialog.api.title"),
    description: <span className="icon-red">{t("dialog.api.description")}</span>,
    buttonText: t("dialog.retry"),
    disableCloseButton: true,
    onSuccess: () => window.location.reload()
});
