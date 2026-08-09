import {t} from "i18next";

// Presentation only. Signing in belongs to the caller, which is what lets both
// prompts share one retry loop - see PasswordPrompt. Holding login() here meant
// the caller had no way to learn a password had been rejected, so it did
// nothing about it.
export const passwordRequiredDialog = (failed = false) => ({
    title: t("dialog.password.title"),
    placeholder: t("dialog.password.placeholder"),
    description: failed ? <span className="icon-red">{t("dialog.password.wrong")}</span> : "",
    type: "password",
    buttonText: t("dialog.login"),
    disableCloseButton: true
});

export const apiErrorDialog = () => ({
    title: t("dialog.api.title"),
    description: <span className="icon-red">{t("dialog.api.description")}</span>,
    buttonText: t("dialog.retry"),
    disableCloseButton: true,
    onSuccess: () => window.location.reload()
});
