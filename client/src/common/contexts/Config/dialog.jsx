import {t} from "i18next";
import {login} from "@/common/utils/RequestUtil";

export const passwordRequiredDialog = (failed = false) => ({
    title: t("dialog.password.title"),
    placeholder: t("dialog.password.placeholder"),
    description: failed ? <span className="icon-red">{t("dialog.password.wrong")}</span> : "",
    type: "password",
    buttonText: t("dialog.login"),
    disableCloseButton: true,
    // The password is exchanged for a session cookie and then dropped; it is
    // never written anywhere this script can read it back.
    onSuccess: async (value) => {
        if (await login(value)) window.location.reload();
    }
});

export const apiErrorDialog = () => ({
    title: t("dialog.api.title"),
    description: <span className="icon-red">{t("dialog.api.description")}</span>,
    buttonText: t("dialog.retry"),
    disableCloseButton: true,
    onSuccess: () => window.location.reload()
});
